import { type SharedMembers, internMembers } from './intern';
import { IdAllocator } from '../ids';
import { ChangeJournal, type ChangeRect, rectsAround } from '../changes';
import { JournalCursor } from '../derived';
import { samePlain } from '@core/plain';
import { ForkMap } from '@core/forkMap';
import { inheritStoredBounds, storedBounds } from './geometry';
import { BuildingGrid } from './grid';
import { BuildingItems } from './items';
import type { RecordRef, RecordTable } from './recordTable';
import { SUMMARY_BUILT_AT, SUMMARY_WIDTH } from './summary';
import type { TableRows } from './tableRows';
import { type BuildingSections, itemsOfSections, sectionsOf } from './sections';
import { SpilledItems } from './spilledItems';
import { migrateBuilding, type SerializedBuilding } from './serialize';
import { type Building, type BuildingId, asBuildingId, settleBuilding } from './types';

/** Two records the same in every field but their wear (`decay`), compared field by field, no copy and no text. */
function sameButWear(a: Building, b: Building): boolean {
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;
  for (const k in x) if (k !== 'decay' && !samePlain(x[k], y[k])) return false;
  for (const k in y) if (k !== 'decay' && x[k] === undefined && y[k] !== undefined) return false;
  return true;
}

/** The field a building's wear is written as over its table's row (`BuildingStore.wear`, `TableItems.writeField`). */
const WEAR = 'decay';

/** DO NOT answer null for it: one such record made the whole entry (every building of an edit) the whole map. */
function rectOf(b: Building): ChangeRect {
  const box = storedBounds(b);
  return Number.isFinite(box.minX) ? [box.minX, box.minY, box.maxX, box.maxY] : [b.x, b.y, b.x, b.y];
}

/** DO NOT copy a record on the way in again "to be safe": the deep copy of every record added or replaced */
export class BuildingStore {
  /** @mapWide Every building of the map: the table the map was opened from, read when asked, and the records written over it (`BuildingItems`). A working copy's lies over the original's (`forkFrom`). */
  private items: Map<BuildingId, Building> = new BuildingItems();
  /** The store a working copy lies over (`forkFrom`) while it has written nothing: its questions by place are that store's. */
  private below: BuildingStore | null = null;
  private ids = new IdAllocator(1);
  /** The records made plain JSON data when they were adopted (`settleBuilding`, OWNERSHIP above): one handed back */
  private settled = new WeakSet<object>();
  /** The buildings by place (`near`), kept by the writers below; null after a whole-store change, made again when asked. */
  private grid: BuildingGrid<Building> | null = null;

  /** Whether a record's members alike with other buildings' are shared with them (`intern.ts`): DO NOT for a store thrown away once written out (the tile generator's, whose tile is read and interned again where it is used: 0.28 s of a dense tile's 1.64 s for nothing). */
  internShared = true;

  /** The buildings kept from now on as a table that their older records are spilled into (`SpilledItems.spill`), read back when asked: a city grown off the page (`editor/smallCityMap.ts` buildCityTable). Only on a store with no building yet. */
  spillToTable(shared?: SharedMembers): SpilledItems {
    if (this.items.size > 0 || this.below) throw new Error('[buildings] only an empty store spills its records to a table');
    const items = new SpilledItems(shared);
    this.items = items;
    this.grid = null;
    return items;
  }

  /** `journal`: the document's diary; a store on its own keeps one of its own. */
  constructor(private readonly journal: ChangeJournal = new ChangeJournal()) {}

  /** Told each building's record before it is written (an edit being recorded, `RoadDoc.beginEdit`); null: nobody listens. */
  watch(before: ((id: BuildingId, was: Building | undefined) => void) | null): void {
    if (this.items instanceof BuildingItems) this.items.before = before;
  }

  /** The serial of the latest change of the buildings in the diary (their shape, place or use; not their wear). */
  get revision(): number {
    return this.journal.serialOf('buildings');
  }

  /** The serial of the latest change of a building's wear (`wear`): what draws or saves a building reads it too. */
  get wearRevision(): number {
    return this.journal.serialOf('buildingWear');
  }

  /** Writes a change of these buildings (their rectangles, or the whole map when any has none); `oneRect`: a tile's buildings, one rectangle round them all (with their ids), not one each. */
  private changed(buildings: readonly Building[] | null, detail?: string, oneRect = false): void {
    const each = buildings?.map(rectOf) ?? null;
    const rects = each && oneRect && each.length > 1 ? [rectsAround(each)] : each;
    const ids = buildings?.map((b) => b.id as number);
    this.journal.record('buildings', rects, { ...(ids ? { ids } : {}), ...(detail ? { detail } : {}) });
  }

  /** The ids of the buildings changed after `serial` (a `revision` read before), from the diary */
  changedSince(serial: number): BuildingId[] | null {
    const entries = this.journal.since(serial, ['buildings']);
    if (!entries || entries.some((e) => !e.ids)) return null;
    return entries.flatMap((e) => e.ids!) as BuildingId[];
  }

  /** A reader's place in the buildings' diary, for `changedFor`. */
  static cursor(): JournalCursor {
    return new JournalCursor(['buildings'], true);
  }

  /** The ids of the buildings changed since `cursor` last read this store (`BuildingStore.cursor()`); null: read them all */
  changedFor(cursor: JournalCursor): BuildingId[] | null {
    const entries = cursor.read(this.journal);
    return entries === null ? null : entries.flatMap((e) => e.ids!) as BuildingId[];
  }

  get size(): number {
    return this.items.size;
  }

  /** Where a worker reads a building's record without decoding it on the page (`recordTable.ts` `RecordRef`): its table's buffer and row while the record is the table's own; null for one written since (read it and take `refOf`). */
  tableRef(id: BuildingId): RecordRef | null {
    if (this.items instanceof BuildingItems) return this.items.tableRef(id);
    return null;
  }

  /** The record table the map was opened from (null: none, every record written here): its columns are read without decoding a record. */
  get table(): TableRows | null {
    if (this.items instanceof BuildingItems) return this.items.table;
    return this.below?.table ?? null;
  }

  get(id: BuildingId): Building | undefined {
    return this.items.get(id);
  }

  has(id: BuildingId): boolean {
    return this.items.has(id);
  }

  all(): IterableIterator<Building> {
    return this.items.values();
  }

  /** Every building's id, in the order of `all()`, no record decoded (the table's id column, then the ids written after it). */
  idList(): IterableIterator<BuildingId> {
    return this.items.keys();
  }

  /** The buildings by id as a read-only map (the save walks their ids, `editor/chunkedSave.ts`): a working copy's the original's while it wrote nothing. */
  itemsOf(): ReadonlyMap<BuildingId, Building> {
    return this.items;
  }

  /** Where a building stands: the table's columns for one of the table (nothing decoded), its record's x and y else; undefined when it is not here. */
  placeOf(id: BuildingId): { readonly x: number; readonly y: number } | undefined {
    if (this.items instanceof BuildingItems) return this.items.placeOf(id);
    const b = this.items.get(id);
    return b ? { x: b.x, y: b.y } : undefined;
  }

  /**
   * Each building for a reader that keeps its numbers (`render/buildings/townColumns.ts`, `decayWatch.ts`): a row of the table with its summary
   * columns as `row` (`buildings/summary.ts`: its id, place, box and summary read there, and the wear written over it, NaN: none - nothing
   * decoded), any other as its record (`record`: one written on the page, or a row of a table written before these summary columns).
   */
  eachSummarised(row: (id: BuildingId, table: RecordTable, at: number, wear: number) => void, record: (b: Building) => void): void {
    if (this.below) { this.below.eachSummarised(row, record); return; }
    const items = this.items;
    if (!(items instanceof BuildingItems)) { for (const b of items.values()) record(b); return; }
    items.eachRow((rows, r, wear) => {
      // Its columns in its own table (a square's, `TableRows.tableOf`), at its row there.
      const table = rows.tableOf(r), at = rows.localRow(r);
      if (table.summaryWidth === SUMMARY_WIDTH && table.boxes) row(table.ids[at]! as BuildingId, table, at, wear);
      else record(items.get(table.ids[at]! as BuildingId)!);
    }, record);
  }

  /** Each building's place: a row of the table from its place columns (`TableItems.eachPlace`), nothing decoded. */
  eachPlace(visit: (x: number, y: number) => void): void {
    if (this.below) { this.below.eachPlace(visit); return; }
    if (this.items instanceof BuildingItems) { this.items.eachPlace(visit); return; }
    for (const b of this.items.values()) visit(b.x, b.y);
  }

  /** The buildings whose box (or anchor) may reach the rectangle, in the order of `all()` */
  near(minX: number, minY: number, maxX: number, maxY: number): Building[] {
    if (this.below) return this.below.near(minX, minY, maxX, maxY);
    this.grid ??= this.gridOf();
    return this.grid.near(minX, minY, maxX, maxY).map((id) => this.items.get(id)!);
  }

  /** The ids of the buildings whose box (or anchor) may reach the rectangle, in the order of `all()`, no record decoded (the grid files the table's rows from their box columns). */
  nearIds(minX: number, minY: number, maxX: number, maxY: number): BuildingId[] {
    if (this.below) return this.below.nearIds(minX, minY, maxX, maxY);
    this.grid ??= this.gridOf();
    return this.grid.near(minX, minY, maxX, maxY);
  }

  /** Each building's box as the store files it (`storedBounds`): a row of the table from its box columns (`TableItems.eachBox`), nothing decoded. */
  eachBox(visit: (minX: number, minY: number, maxX: number, maxY: number) => void): void {
    if (this.below) { this.below.eachBox(visit); return; }
    const items = this.items;
    if (items instanceof BuildingItems) { items.eachBox((b) => storedBounds(b), visit); return; }
    for (const b of items.values()) { const box = storedBounds(b); visit(box.minX, box.minY, box.maxX, box.maxY); }
  }

  /** Each building as it stands: a row of the table as its table and row (`row`, nothing decoded), a record written on the page as itself (`record`). */
  eachStanding(row: (id: BuildingId, table: TableRows, at: number) => void, record: (b: Building) => void): void {
    if (this.below) { this.below.eachStanding(row, record); return; }
    const items = this.items;
    if (!(items instanceof BuildingItems)) { for (const b of items.values()) record(b); return; }
    items.eachRow((rows, at) => row(rows.idAt(at), rows, at), record);
  }

  /** The table's row a building reads as its own (its record not written on the page), nothing decoded; null otherwise. */
  standing(id: BuildingId): { readonly table: TableRows; readonly row: number } | null {
    if (this.below) return this.below.standing(id);
    const items = this.items;
    if (!(items instanceof BuildingItems) || !items.table) return null;
    const row = items.standing(id);
    return row ? { table: items.table, row: row.row } : null;
  }

  /** The table's row `b` stands as, only when `b` is the very record this store reads for it (`TableItems.holdsRow`): what is kept of a building by
   *  its row is kept while the row stands (`floors.ts`). Null for a record written on the page, a copy of one (a preview), or not here. */
  recordRow(b: Building): { readonly table: TableRows; readonly row: number } | null {
    if (this.below) return this.below.recordRow(b);
    const items = this.items;
    if (!(items instanceof BuildingItems) || !items.table) return null;
    const row = items.standing(b.id);
    return row && items.holdsRow(row.row, b) ? { table: items.table, row: row.row } : null;
  }

  /** The table's row a building stands as (its record the table's own, not written on the page), nothing decoded; null otherwise. */
  standingRow(id: BuildingId): { readonly table: TableRows; readonly row: number } | null {
    if (this.below) return this.below.standingRow(id);
    const items = this.items;
    if (!(items instanceof BuildingItems) || !items.table) return null;
    const row = items.standing(id);
    return row ? { table: items.table, row: row.row } : null;
  }

  /** The buildings `meets` keeps for one of `rects`, asked of those within `pad` of it, each once, in the store's order */
  nearAny(rects: readonly (readonly [number, number, number, number])[], pad: number,
    meets: (b: Building, rect: readonly [number, number, number, number]) => boolean): Building[] {
    if (this.below) return this.below.nearAny(rects, pad, meets);
    this.grid ??= this.gridOf();
    return this.grid.nearAny(rects, pad, (id, rect) => meets(this.items.get(id)!, rect)).map((id) => this.items.get(id)!);
  }

  /**
   * @rebuild The buildings by place, filed once after a whole-store change (`grid` null): every record of the store in its order - a row of
   * the table from its columns (its anchor and the box its table keeps, `TableRows.boxAt`), no record decoded; a record written on the page
   * from itself (`storedBounds`). DO NOT decode the table to file it: the whole city as objects at the first question by place. A row of a
   * table written before the box columns (format 1) is decoded for its box alone.
   */
  private gridOf(): BuildingGrid<Building> {
    const grid = new BuildingGrid<Building>([], (b) => storedBounds(b));
    const items = this.items;
    const table = items instanceof BuildingItems ? items.table : null;
    if (!(items instanceof BuildingItems) || !table) {
      for (const b of items.values()) grid.insert(b);
      return grid;
    }
    const { gone, replaced, added } = items.writes();
    for (let row = 0; row < table.size; row++) {
      const id = table.idAt(row);
      if (gone.has(id)) continue;
      const over = replaced.get(id);
      if (over) { grid.insert(over); continue; }
      const box = table.boxAt(row);
      if (box) { const at = table.placeAt(row); grid.insertBox(id, at.x, at.y, box.minX, box.minY, box.maxX, box.maxY); } else grid.insert(table.record(row));
    }
    for (const b of added.values()) grid.insert(b);
    return grid;
  }

  /** The id the next `add` will hand out. */
  get nextId(): BuildingId {
    return asBuildingId(this.ids.peek);
  }

  /** The id a building made at a place takes from its loaded tile's range (`RoadDoc.tileIdAt`); null: this store's allocator. */
  idAt: ((at: { readonly x: number; readonly y: number }) => number | null) | null = null;

  /** @perItem Stores a new building under a fresh id. */
  add(value: Omit<Building, 'id'>): Building {
    const id = asBuildingId(this.idAt?.(value) ?? this.ids.take());
    const building = settleBuilding({ ...value, id } as Building, this.settled, undefined, this.internShared);
    this.leaveBelow();
    this.items.set(id, building);
    this.grid?.insert(building);
    this.changed([building], 'added');
    return building;
  }

  /** @perItem Replaces an existing building's record (same id). */
  put(building: Building): void {
    const was = this.items.get(building.id);
    if (!was) return;
    const now = settleBuilding(building, this.settled, was, this.internShared);
    this.leaveBelow();
    this.items.set(building.id, now);
    this.grid?.update(now);
    // Where it stood and where it stands: a moved building changes both.
    this.changed([was, now], 'replaced');
  }

  /** @perItem DO NOT write a wear change with `put`. A row of the table worn as its field (`TableItems.writeField`), its record left in the table; a record written on the page written again with its wear. */
  wear(id: BuildingId, decay: number): void {
    if (!this.items.has(id) || this.decayOf(id) === decay) return;
    this.leaveBelow();
    const items = this.items;
    const row = items instanceof BuildingItems ? items.standing(id) : null;
    // The row's box from the table's columns (the wear moves nothing), nothing decoded.
    const box = row && items instanceof BuildingItems ? items.table?.boxAt(row.row) ?? null : null;
    if (box && items instanceof BuildingItems && items.writeField(WEAR, id, decay)) {
      this.journal.record('buildingWear', [[box.minX, box.minY, box.maxX, box.maxY]], { ids: [id as number] });
      return;
    }
    const was = items.get(id)!;
    const now = settleBuilding({ ...was, decay }, this.settled, was, this.internShared);
    items.set(id, now);
    // DO NOT file it again in the grid: the grid holds ids and the wear moves nothing; its box the record's before it (PRD-02).
    inheritStoredBounds(was, now);
    this.journal.record('buildingWear', [rectOf(now)], { ids: [id as number] });
  }

  /**
   * Where a building's summary is read without its record (`eachSummarised`'s `row`, for one building): its table, its row and the wear written
   * over it (NaN: none); null for a record written on the page, a table without these summary columns, or one not here.
   */
  summaryOf(id: BuildingId): { readonly table: RecordTable; readonly at: number; readonly wear: number } | null {
    if (this.below) return this.below.summaryOf(id);
    const items = this.items;
    if (!(items instanceof BuildingItems) || !items.table) return null;
    const row = items.standing(id);
    if (!row) return null;
    // Its own table (a square's, `TableRows.tableOf`), at its row there.
    const table = items.table.tableOf(row.row);
    if (table.summaryWidth !== SUMMARY_WIDTH || !table.boxes) return null;
    return { table, at: items.table.localRow(row.row), wear: row.field };
  }

  /** A building's wear, its record not decoded where it is a row of the table: the wear written over the row, else the row's own field (`TableRows.field`); 0 when it has none or is not here. */
  decayOf(id: BuildingId): number {
    if (this.below) return this.below.decayOf(id);
    const items = this.items;
    const row = items instanceof BuildingItems ? items.standing(id) : null;
    if (row && items instanceof BuildingItems && items.table) {
      if (!Number.isNaN(row.field)) return row.field;
      const decay = items.table.field(row.row, WEAR);
      return typeof decay === 'number' ? decay : 0;
    }
    return items.get(id)?.decay ?? 0;
  }

  /** The minute a building was built (its wear's clock), its record not decoded where it is a row of a table with its summary (`SUMMARY_BUILT_AT`); undefined when it has none or is not here. */
  builtAtOf(id: BuildingId): number | undefined {
    const row = this.summaryOf(id);
    if (!row) return this.items.get(id)?.builtAt;
    const builtAt = row.table.summary![SUMMARY_BUILT_AT * row.table.rows + row.at]!;
    return Number.isNaN(builtAt) ? undefined : builtAt;
  }

  /** Puts back a building as it was, or takes it away (`undefined`): undo and redo (`world/docImage.ts`). */
  restore(id: BuildingId, value: Building | undefined): void {
    const was = this.items.get(id);
    if (value === undefined) {
      if (!was) return;
      this.leaveBelow();
      this.items.delete(id);
      this.grid?.delete(id);
      this.changed([was], 'restored');
      return;
    }
    const now = settleBuilding(value, this.settled, was, this.internShared);
    this.leaveBelow();
    this.items.set(id, now);
    // A record put back where one stood keeps its place in the order; a new one goes last, as in `items`.
    if (was) this.grid?.update(now); else this.grid?.insert(now);
    this.ids.reserve(id);
    this.changed(was ? [was, now] : [now], 'restored');
  }

  /** A tile's buildings put in the page's document (`RoadDoc.loadTile`): one diary entry for all of them. */
  placeAll(list: readonly Building[]): void {
    const placed: Building[] = [];
    this.leaveBelow();
    for (const value of list) {
      if (this.items.has(value.id)) continue;
      const now = settleBuilding(value, this.settled, undefined, this.internShared);
      this.items.set(now.id, now);
      this.grid?.insert(now);
      placed.push(now);
    }
    if (placed.length) this.changed(placed, 'tile', true);
  }

  /** The buildings of a tile taken out of the page's document (`RoadDoc.unloadTile`): one diary entry. */
  dropAll(ids: readonly BuildingId[]): void {
    const gone: Building[] = [];
    this.leaveBelow();
    for (const id of ids) {
      const was = this.items.get(id);
      if (!was) continue;
      this.items.delete(id);
      this.grid?.delete(id);
      gone.push(was);
    }
    if (gone.length) this.changed(gone, 'tile', true);
  }

  /** The id the allocator hands out next, set back by undo. */
  restoreNextId(next: number): void {
    this.ids = new IdAllocator(next);
  }

  /** @perItem Runs once a building removed: nothing it reaches may walk the map. */
  remove(id: BuildingId): boolean {
    const was = this.items.get(id);
    if (!was) return false;
    this.leaveBelow();
    this.items.delete(id);
    this.grid?.delete(id);
    this.changed([was], 'removed');
    return true;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.leaveBelow();
    this.items.clear();
    this.grid = null;
    this.changed(null, 'cleared');
  }

  /** DO NOT copy the records out again: every record is plain JSON data already and never changed in place (OWNERSHIP above), and the undo's whole image (`RoadDoc.replaceWith`) copied every building of the map, 100-400 ms and tens of MB. The records themselves: read them, do not write them. */
  toJSON(): SerializedBuilding[] {
    return [...this.items.values()];
  }

  /** Written when asked (a whole-map undo image, an export), never kept: one pass over the records, not a text per record and a join of thousands (MDN JSON.stringify, an array of the values). DO NOT keep each record's text beside it */
  toText(): string {
    return JSON.stringify([...this.items.values()]);
  }

  /** Loads buildings a worker prepared (`editor/tileStore.ts` `prepareTile`: each migrated and interned there, the tile's shapes shared through the message's clone): filed as they are, nothing read again (DO NOT migrate and intern 900 records in the page's frame: 100-300 ms a dense tile, 2026-10-16). */
  loadPrepared(data: readonly Building[]): void {
    this.leaveBelow();
    this.items.clear();
    this.grid = null;
    for (const building of data) {
      if (this.items.has(building.id)) continue;
      // Settled where it was prepared (`prepareCity`), as a tile's read from its table (`placeAll`).
      this.settled.add(building);
      this.items.set(building.id, building);
      this.ids.reserve(building.id);
    }
    this.changed(null, 'loaded');
  }

  /** Loads a map's buildings from their table (`editor/preparedCity.ts`, the binary save `world/docBinary.ts`): DO NOT decode them - the table is the store's source of truth, a record decoded when it is read (`TableRows`). */
  loadSections(sections: BuildingSections): void {
    this.leaveBelow();
    const settled = this.settled;
    // Plain and interned where the table was made (`prepareCity`, `encodeRecords` of settled records): each read one settled already.
    this.items = this.withWatch(itemsOfSections(sections, (b) => { settled.add(b); }));
    this.grid = null;
    let top = 0;
    for (const id of this.items.keys()) if (id > top) top = id;
    if (top > 0) this.ids.reserve(top);
    this.changed(null, 'loaded');
  }

  /** The buildings as buffers (`BuildingSections`): the table shared, the records written encoded - the save's, the simulation's, a whole map's undo. */
  sections(): BuildingSections {
    return sectionsOf(this.items);
  }

  /** New items told of their writes as the ones they replace were (an edit being recorded, `watch`). */
  private withWatch(items: BuildingItems): BuildingItems {
    if (this.items instanceof BuildingItems) items.before = this.items.before;
    return items;
  }

  /** A map opened, or a whole map put back by undo (`RoadDoc.replaceWhole`): the other store's buildings taken as they are, one change of the whole map - DO NOT compare them record by record. */
  takeWhole(source: BuildingStore): void {
    this.below = null;
    if (source.items instanceof BuildingItems) {
      this.items = this.withWatch(source.items.copy());
    } else {
      const items = this.withWatch(new BuildingItems());
      for (const [id, b] of source.items) items.set(id, b);
      this.items = items;
    }
    this.settled = source.settled;
    this.grid = null;
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    this.changed(null, 'loaded');
  }

  /** Loads stored buildings, repairing or dropping what cannot be read. */
  load(data: readonly unknown[] | undefined): void {
    this.leaveBelow();
    this.items.clear();
    this.grid = null;
    for (const raw of data ?? []) {
      const building = migrateBuilding(raw);
      if (!building || this.items.has(building.id)) continue;
      internMembers(building as unknown as Record<string, unknown>);
      this.items.set(building.id, building);
      this.ids.reserve(building.id);
    }
    this.changed(null, 'loaded');
  }

  /** The same records as another store (they are never changed in place) */
  shareFrom(source: BuildingStore): void {
    this.leaveBelow();
    this.grid = null;
    // The same table and records written: a copy of what was written, never of the table (`BuildingItems.copy`).
    if (source.items instanceof BuildingItems) {
      this.items.clear();
      this.items = this.withWatch(source.items.copy());
    } else {
      this.items.clear();
      for (const [id, b] of source.items) this.items.set(id, b);
    }
    // The same records, known plain to both (`settleBuilding`).
    this.settled = source.settled;
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    this.changed(null, 'shared');
  }

  /** A working copy over another store (`RoadDoc.fork`): its records read through, each written here only */
  forkFrom(source: BuildingStore): void {
    this.items = new ForkMap(source.items);
    this.below = source;
    this.grid = null;
    this.settled = source.settled;
    this.ids = new IdAllocator(source.ids.peek);
  }

  /** Takes back a working copy over this store (`forkFrom`): the records it deleted, replaced */
  takeFork(copy: BuildingStore): void {
    const { gone, replaced, added } = (copy.items as ForkMap<BuildingId, Building>).changes();
    for (const id of gone) { this.items.delete(id); this.grid?.delete(id); }
    for (const [id, b] of replaced) { this.items.set(id, b); this.grid?.update(b); }
    for (const [id, b] of added) { this.items.set(id, b); this.grid?.insert(b); }
    this.ids = new IdAllocator(copy.ids.peek);
  }

  /** A working copy about to write: its questions by place its own from now on, on a grid over the original's (`BuildingGrid.over`: the original is not written while its copy is). */
  private leaveBelow(): void {
    let below = this.below;
    if (!below) return;
    this.below = null;
    // A copy of a copy that wrote nothing: the store that answers for both.
    while (below.below) below = below.below;
    below.grid ??= below.gridOf();
    this.grid = BuildingGrid.over(below.grid);
  }

  /** Keeps id allocation monotonic across a clone (see `RoadDoc.clone`). */
  copyAllocator(from: BuildingStore): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, from.ids.peek));
  }

  /** DO NOT go back to clearing the store and the grid and writing every record again */
  replaceWith(source: BuildingStore, changed: readonly BuildingId[] | null = null): void {
    this.ids = new IdAllocator(Math.max(this.ids.peek, source.ids.peek));
    const touched: Building[] = [];
    /** Records that differ in their wear alone (`wear`): written as `buildingWear`, never as a change of shape. */
    const worn: Building[] = [];
    const mine = this.items, theirs = source.items;
    const shared = mine instanceof BuildingItems && theirs instanceof BuildingItems && mine.table !== null && mine.table === theirs.table;
    const take = (id: BuildingId): void => {
      // One table under both, the record written by neither: the very same, known without decoding it.
      if (shared && mine.sameUnwritten(theirs, id)) return;
      // A row of that table in both, its wear alone differing: the wear written over it as the source has it, no record of its own.
      if (shared && mine.sameButField(theirs, id)) {
        this.leaveBelow();
        mine.writeField(WEAR, id, theirs.fieldOf(WEAR, id) ?? Number.NaN);
        worn.push(mine.get(id)!);
        return;
      }
      const was = this.items.get(id);
      const now = source.items.get(id);
      if (was === now) return;
      this.leaveBelow();
      if (!now) {
        this.items.delete(id);
        this.grid?.delete(id);
        touched.push(was!);
        return;
      }
      // The source's record itself, as `shareFrom` does: read-only once stored (OWNERSHIP above).
      // One the source settled already (a map opened, `fromJSON`) taken as it is: DO NOT walk and intern every building of the map a second time.
      const kept = source.settled.has(now) && (source.internShared || !this.internShared) ? (this.settled.add(now), now)
        : settleBuilding(now, this.settled, undefined, this.internShared);
      this.items.set(id, kept);
      if (!was) {
        this.grid?.insert(kept);
        touched.push(kept);
      } else if (!samePlain(kept, was)) {
        this.grid?.update(kept);
        if ((kept.decay ?? 0) !== (was.decay ?? 0) && sameButWear(kept, was)) worn.push(kept);
        else touched.push(was, kept);
      }
    };
    if (changed) {
      for (const id of new Set(changed)) take(id);
    } else {
      // Deleting the entry being visited is safe: a Map iteration skips only entries deleted before their visit (MDN, Map.prototype.forEach).
      for (const id of this.items.keys()) if (!source.items.has(id)) take(id);
      for (const id of source.items.keys()) take(id);
    }
    if (touched.length) this.changed(touched, 'replaced by an edit or an undo');
    if (worn.length) this.journal.record('buildingWear', worn.map(rectOf), { ids: worn.map((w) => w.id as number) });
  }
}
