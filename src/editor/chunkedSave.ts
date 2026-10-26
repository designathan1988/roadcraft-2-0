import type { Building } from '@world/buildings/types';
import { RecordTable, type TableReader, TableWriter, type RowBox, type RowPlace, type TableRow, tableRecords } from '@world/buildings/recordTable';
import { type Change, type ChangeRect, DOC_CHANGE_KINDS } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { DocTable } from '@world/docBinary';
import { GLOBAL_PARTS, type GlobalPart, type RoadDoc, type SavedGlobals, type SerializedDoc } from '@world/doc';
import { type PartStore, type SaveEntry, type SaveWriter, gunzip, storeWriter } from './saveStore';
import { GLOBAL_MAGIC, MANIFEST_MAGIC, REGION_CODEC, type SquareSections, readValueFrame, squareFrame, valueFrame, wearFrame } from './regionFrames';
import { JSON_CODEC, type SquareBlob, type SquareCodec, readWears, withWear } from './tileCodec';
import {
  GLOBAL_KINDS, KEYED, KEYED_NAMES, type KeyedName, LAYER_NAMES, LISTS, LIST_NAMES, type LayerName, type ListName,
  SAVE_TILE, freshKeyed, freshLists, meets, placeInOrder, squareAt, squareRect,
} from './saveLayers';

/** How many saved squares are decompressed at once when a map is read (`readTiles`). */
const GUNZIP_BATCH = 32;

/** THE MAP SAVED BY TILES: each record in the square of the map it stands in, and a save writes only the squares the diary says changed. The layers themselves (each kind of record, where it stands, its square's table): `saveLayers.ts`. */
export { SAVE_TILE };

/** THE SQUARES AS BINARY REGIONS (manifest 6, 2026-10-21): each square one frame (`saveBinary.ts`) - the buildings their record table (`encodeRecords`), the other layers their records' JSON, the order as doubles - compressed by the save worker; the saves by tiles in JSON (manifest 5) and before them (manifest 3) still open, and are written as regions by the next save */

/** THE SQUARES ON THE UNIVERSAL GRID (manifest 7, 2026-10-24): the same frames, the squares the tiles of 1,000 m and the cells of 250 m (`world/grid.ts`
 *  GRID_CELL their measure), under keys of their own. A map saved as regions of the tiles of 1,024 m (manifest 6) opens whole as it was (each
 *  record carries its own place) and its next save files every record again in the squares of now; the manifest 6 and its blobs stay for an older build. */

/**
 * THE SQUARES CUT FROM THE MAP'S TABLES (manifest 8, 2026-10-26): every kind the document keeps in a table (`DOC_TABLES`: the buildings, the
 * landscaping, the lots, the poles and the wires) has its squares as record tables, each row copied from the map's table without decoding
 * (`TableWriter.copyRows`), and a map opened joins its squares' tables into the map's the same way - no record of those kinds is ever an
 * object on the page for the save. The lots stand in the square of their centre (their table's place columns), as their store files them.
 * The page keeps no record's square either: a square's records are found from the tables' place columns when it is written. A map saved as
 * regions before (manifests 6 and 7) opens as it was and is written whole as manifest 8 by its next save; its own blobs stay for an older build.
 */

/** DO NOT walk the map to find what changed, nor write what did not: an edit in one tile writes that tile, whatever the map's size */

/** DO NOT decode a kind kept in a table to save it (every record of the map an object, `tableRecords`), nor keep each record's square on the page (one map entry a record of the map, 600,000 of a 10 km city): a square to write finds its records from the place columns (`membersOf`), and copies their rows (`copyRows`). */

/** A format by squares: version 5 (the tiles in JSON), 6 (binary regions of the tiles of 1,024 m), 7 (binary regions of the tiles of 1,000 m and the cells of 250 m), 8 (the same squares, every kind kept in a table as tables cut from the map's), each layer's squares by key, the parts kept outside the tiles. */
interface TiledManifest {
  readonly version: 5 | 6 | 7 | 8;
  readonly savedAt: number;
  readonly settings: unknown;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
}
/** The binary regions cut from the map's tables: the same index as the tiles', its blobs binary frames under keys of their own. */
interface RegionManifest {
  readonly version: 8;
  readonly savedAt: number;
  readonly settings: unknown;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
}
/** The format before the tiles (2026-10): the head in one text and the buildings in parts of 512 ids. */
interface OldManifest {
  readonly version: 3;
  readonly savedAt: number;
  readonly parts: readonly number[];
  readonly settings: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isTiledManifest(value: unknown, version: 5 | 6 | 7 | 8 = 5): value is TiledManifest {
  if (!isObject(value) || value['version'] !== version || typeof value['savedAt'] !== 'number') return false;
  const squares = value['squares'], globals = value['globals'];
  if (!isObject(squares) || !Array.isArray(globals)) return false;
  return Object.entries(squares).every(([name, list]) => (LAYER_NAMES as readonly string[]).includes(name)
    && Array.isArray(list) && list.every((s) => typeof s === 'string'))
    && globals.every((part) => (GLOBAL_PARTS as readonly unknown[]).includes(part));
}

function isOldManifest(value: unknown): value is OldManifest {
  return isObject(value) && value['version'] === 3 && typeof value['savedAt'] === 'number' && Array.isArray(value['parts'])
    && (value['parts'] as unknown[]).every((p) => Number.isInteger(p));
}

/** How the map just read was stored: what `adopt` needs so the next save writes only what changes. */
export interface SavedLayout {
  /** The keys of a map saved in a format before this one (kept for an older build; the next save writes the map whole in this one); null: saved in this format. */
  readonly old: readonly string[] | null;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
  /** Each list's places in the order and squares, in the order read. */
  readonly lists: Partial<Record<ListName, { readonly ords: readonly number[]; readonly squares: readonly string[] }>>;
}

/** The tables a map read back from its squares holds its records in (the kinds kept in tables), each joined from its squares without decoding; a kind absent has its records in the document (a save before manifest 8). */
export type SavedTables = Partial<Record<DocTable, ArrayBufferLike>>;

/** What a tiled save reads back. */
interface TiledSession {
  readonly document: SerializedDoc;
  readonly tables: SavedTables;
  readonly settings: unknown;
  readonly savedAt: number;
  readonly layout: SavedLayout;
}

function idOf(record: unknown): number {
  const id = isObject(record) ? record['id'] : undefined;
  return typeof id === 'number' ? id : Number.NaN;
}

export class TiledSaves {
  /** The diary read up to the last save (every kind of the document). */
  private readonly cursor = new JournalCursor(DOC_CHANGE_KINDS);
  /** The document the stored squares are of; another one is compared whole. */
  private doc: RoadDoc | null = null;
  private keyed = freshKeyed();
  private lists = freshLists();
  /** The parts kept outside the tiles to write again, and those stored. */
  private globals = new Set<GlobalPart>(GLOBAL_PARTS);
  private storedGlobals = new Set<GlobalPart>();
  /** The keys of a map stored before this format: removed in the transaction that writes it by tiles. */
  private oldKeys: readonly string[] = [];
  /** Saves one after another: a save under way finishes before the next reads the map. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly writer: SaveWriter;

  constructor(private readonly store: PartStore, private readonly key: string) {
    this.writer = store.writer ?? storeWriter(store);
  }

  private blobKey(layer: LayerName, square: string): string { return `${this.key}:R8:${layer}:${square}`; }
  private wearKey(square: string): string { return `${this.key}:RW8:${square}`; }
  private globalKey(part: GlobalPart): string { return `${this.key}:RG8:${part}`; }
  /** The regions' manifest (version 8). The manifests before it (`:regions7`, version 7; `:regions`, version 6; `:tiles`, version 5 in JSON; `:manifest`, version 3) are never written here: an older build still opens the map they hold. */
  private get manifestKey(): string { return `${this.key}:regions8`; }
  private get regions7ManifestKey(): string { return `${this.key}:regions7`; }
  private get regions6ManifestKey(): string { return `${this.key}:regions`; }
  private get tilesManifestKey(): string { return `${this.key}:tiles`; }
  private get oldManifestKey(): string { return `${this.key}:manifest`; }
  /** The keys of the tiles in JSON (manifest 5). */
  private readonly tileKeys: SquareKeys = {
    blob: (layer, square) => `${this.key}:L:${layer}:${square}`,
    wear: (square) => `${this.key}:W:${square}`,
    global: (part) => `${this.key}:G:${part}`,
  };
  private readonly regionKeys: SquareKeys = {
    blob: (layer, square) => this.blobKey(layer, square),
    wear: (square) => this.wearKey(square),
    global: (part) => this.globalKey(part),
  };
  /** The keys of the regions on the universal grid before the tables (manifest 7). */
  private readonly regions7Keys: SquareKeys = {
    blob: (layer, square) => `${this.key}:R7:${layer}:${square}`,
    wear: (square) => `${this.key}:RW7:${square}`,
    global: (part) => `${this.key}:RG7:${part}`,
  };
  /** The keys of the regions of the tiles of 1,024 m (manifest 6). */
  private readonly regions6Keys: SquareKeys = {
    blob: (layer, square) => `${this.key}:R:${layer}:${square}`,
    wear: (square) => `${this.key}:RW:${square}`,
    global: (part) => `${this.key}:RG:${part}`,
  };

  save(doc: RoadDoc, settings: unknown, savedAt = Date.now()): Promise<boolean> {
    return this.queued(() => this.write(doc, settings, savedAt));
  }

  /**
   * The document just opened from this store (`Persistence.adoptLoaded`): what it holds is what is stored. `since`: the diary's serial once
   * the map stood replaced (`restoreInto` replacedAt): what was written after it (its roads repaired at the opening) is written by the
   * next save; the default, the diary as it stands now, nothing.
   */
  adopt(doc: RoadDoc, layout: SavedLayout, since: number = doc.changes.version): void {
    this.doc = doc;
    this.cursor.read(doc.changes);
    this.keyed = freshKeyed();
    this.lists = freshLists();
    this.globals = new Set();
    this.storedGlobals = new Set(layout.globals);
    this.oldKeys = layout.old ?? [];
    // A map stored in a format before this one: written whole, in this one, at the next save.
    if (layout.old) { this.everything(doc); return; }
    for (const name of KEYED_NAMES) this.keyed[name].stored = new Set(layout.squares[name] ?? []);
    for (const name of LIST_NAMES) {
      const st = this.lists[name], spec = LISTS[name];
      st.stored = new Set(layout.squares[name] ?? []);
      const read = layout.lists[name] ?? { ords: [], squares: [] };
      const list = spec.list(doc);
      // The loader dropped or capped items: the list placed again and every square of it written.
      if (read.ords.length !== list.length) { st.changed = true; st.rects = null; continue; }
      list.forEach((item, i) => {
        const square = read.squares[i]!;
        st.ords.set(item, read.ords[i]!);
        st.square.set(item, square);
        st.counts.set(square, (st.counts.get(square) ?? 0) + 1);
        if (squareAt(spec.at(item), spec.side) !== square) st.changed = true;
      });
    }
    // What the loader wrote after the map stood replaced (a repair of its roads): those squares again. Too far back for the diary: everything.
    const entries = doc.changes.since(since, DOC_CHANGE_KINDS);
    if (entries === null) { this.everything(doc); return; }
    for (const entry of entries) this.note(doc, entry);
  }

  /** Nothing is known to be stored the way the map stands: the next save compares and writes every square. */
  private everything(doc: RoadDoc): void {
    for (const name of KEYED_NAMES) this.wholeLayer(doc, name);
    for (const name of LIST_NAMES) { this.lists[name].changed = true; this.lists[name].rects = null; }
    for (const part of GLOBAL_PARTS) this.globals.add(part);
  }

  /** What the diary says changed since the last look, added to what waits to be written. */
  private take(doc: RoadDoc): void {
    const same = this.doc === doc;
    const entries = this.cursor.read(doc.changes);
    this.doc = doc;
    if (!same || entries === null) { this.everything(doc); return; }
    for (const entry of entries) this.note(doc, entry);
  }

  private note(doc: RoadDoc, entry: Change): void {
    const kind = entry.kind;
    for (const part of GLOBAL_PARTS) if (GLOBAL_KINDS[part].includes(kind)) this.globals.add(part);
    if (kind === 'buildingWear') { this.worn(doc, entry); return; }
    for (const name of KEYED_NAMES) {
      if (!KEYED[name].kinds.includes(kind)) continue;
      if (entry.rects === null) { this.wholeLayer(doc, name); continue; }
      const spec = KEYED[name], st = this.keyed[name];
      // Where the records were: the stored squares the change reaches (the diary's rectangles cover a record's old place as its new one, or the renderer would show it stale).
      st.dirtyStored(entry.rects, spec.side);
      // Where they are now: the ids named looked up (either layer of the kind: a road's entry names nodes and segments, each looked up in both), else every record the rectangles reach.
      if (entry.ids) { for (const id of entry.ids) this.touch(doc, name, id); } else this.squaresMeeting(doc, name, entry.rects);
    }
    for (const name of LIST_NAMES) {
      if (!LISTS[name].kinds.includes(kind)) continue;
      const st = this.lists[name];
      st.changed = true;
      if (entry.rects === null) st.rects = null;
      else st.rects?.push(...entry.rects);
    }
  }

  /** Buildings whose wear alone changed: their squares' wears, never their records. */
  private worn(doc: RoadDoc, entry: Change): void {
    const spec = KEYED.buildings, st = this.keyed.buildings;
    if (!entry.ids) { for (const square of this.occupied(doc, 'buildings')) st.wear.add(square); return; }
    for (const id of entry.ids) {
      const at = spec.placeOf(doc, id);
      if (at) st.wear.add(squareAt(at, spec.side));
    }
  }

  /** One record of a layer looked up by id: the square it stands in now written again (the one it left is reached by the entry's rectangles). */
  private touch(doc: RoadDoc, name: KeyedName, id: number): void {
    const spec = KEYED[name];
    if (!spec.items(doc).has(id)) return;
    this.keyed[name].dirty.add(squareAt(spec.placeOf(doc, id), spec.side));
  }

  /** @rebuild The squares a layer's records stand in, each once: one pass of the ids and places (a table's columns, no record decoded). */
  private occupied(doc: RoadDoc, name: KeyedName): Set<string> {
    const spec = KEYED[name];
    const out = new Set<string>();
    for (const id of spec.items(doc).keys()) out.add(squareAt(spec.placeOf(doc, id), spec.side));
    return out;
  }

  /** A change of a whole layer (an entry without a place): every square that holds records or a blob written again. */
  private wholeLayer(doc: RoadDoc, name: KeyedName): void {
    const st = this.keyed[name];
    st.dirtyStored(null, KEYED[name].side);
    for (const square of this.occupied(doc, name)) st.dirty.add(square);
  }

  /** A change over rectangles naming no ids: the squares of the records standing in them written again. */
  private squaresMeeting(doc: RoadDoc, name: KeyedName, rects: readonly ChangeRect[]): void {
    const spec = KEYED[name], st = this.keyed[name];
    for (const square of this.occupied(doc, name)) {
      if (st.dirty.has(square)) continue;
      const rect = squareRect(square, spec.side);
      if (rects.some((r) => meets(r, rect))) st.dirty.add(square);
    }
  }

  /** An ordered list whose kind changed: each item's place in the order kept (new ones between their neighbours) and its square checked. */
  private walk(doc: RoadDoc, name: ListName): void {
    const spec = LISTS[name], st = this.lists[name];
    const list = spec.list(doc);
    const rects = st.rects;
    const visit = (square: string): void => {
      if (rects === null || rects.some((r) => meets(r, squareRect(square, spec.side)))) st.dirty.add(square);
    };
    for (const square of st.counts.keys()) visit(square);
    for (const square of st.stored) visit(square);
    const placed = placeInOrder(list, st.ords);
    const counts = new Map<string, number>();
    for (const item of list) {
      const square = squareAt(spec.at(item), spec.side);
      counts.set(square, (counts.get(square) ?? 0) + 1);
      const was = st.square.get(item);
      if (was !== square) {
        if (was !== undefined) st.dirty.add(was);
        st.dirty.add(square);
        st.square.set(item, square);
      } else if (placed === 'all' || placed.has(item)) st.dirty.add(square);
    }
    // An item gone leaves its square one short.
    for (const [square, n] of st.counts) if (counts.get(square) !== n) st.dirty.add(square);
    for (const [square, n] of counts) if (st.counts.get(square) !== n) st.dirty.add(square);
    st.counts = counts;
    st.changed = false;
    st.rects = [];
  }

  /** The records standing in each of `squares`, by id in increasing order: one pass of the layer's ids and places (a table's columns, no record decoded), never a walk a square. */
  private membersOf(doc: RoadDoc, name: KeyedName, squares: ReadonlySet<string>): Map<string, number[]> {
    const spec = KEYED[name];
    const out = new Map<string, number[]>();
    for (const square of squares) out.set(square, []);
    for (const id of spec.items(doc).keys()) {
      const list = out.get(squareAt(spec.placeOf(doc, id), spec.side));
      if (list) list.push(id);
    }
    for (const list of out.values()) list.sort((a, b) => a - b);
    return out;
  }

  private async write(doc: RoadDoc, settings: unknown, savedAt: number): Promise<boolean> {
    this.take(doc);
    for (const name of LIST_NAMES) if (this.lists[name].changed) this.walk(doc, name);
    const put: SaveEntry[] = [];
    // DO NOT remove the map saved before the tiles: it is the player's, and an older build reads only it.
    const remove: string[] = [];
    // Taken now; put back if the write fails (with whatever came meanwhile).
    const takenKeyed = new Map<KeyedName, { readonly dirty: Set<string>; readonly wear: Set<string> }>();
    const takenLists = new Map<ListName, Set<string>>();
    const nextStored = new Map<LayerName, Set<string>>();
    // The map's tables the rows are copied from, and their readers (a building's wear read from its row alone), one each for this save.
    const tables = new Map<ArrayBufferLike, RecordTable>();
    const readers = new Map<ArrayBufferLike, TableReader>();
    const tableOf = (buffer: ArrayBufferLike): RecordTable => { let t = tables.get(buffer); if (!t) tables.set(buffer, t = new RecordTable(buffer)); return t; };
    const readerOf = (buffer: ArrayBufferLike): TableReader => { let r = readers.get(buffer); if (!r) readers.set(buffer, r = tableOf(buffer).reader()); return r; };
    for (const name of KEYED_NAMES) {
      const spec = KEYED[name], st = this.keyed[name];
      const { dirty, wear } = st;
      st.dirty = new Set();
      st.wear = new Set();
      takenKeyed.set(name, { dirty, wear });
      const stored = new Set(st.stored);
      const asked = new Set<string>(dirty);
      for (const square of wear) if (!dirty.has(square) && st.stored.has(square)) asked.add(square);
      const members = asked.size ? this.membersOf(doc, name, asked) : new Map<string, number[]>();
      const items = spec.items(doc);
      /** A square's wears: each building's id and decay, the decay of a row of the table read from the row alone (`TableReader.field`). */
      const wears = (ids: readonly number[]): ArrayBuffer => {
        const pairs: number[] = [];
        for (const id of ids) {
          const ref = spec.ref?.(doc, id);
          const decay = ref ? readerOf(ref.buffer).field(ref.row, 'decay') : (items.get(id) as Building | undefined)?.decay;
          pairs.push(id, typeof decay === 'number' ? decay : 0);
        }
        return wearFrame(pairs);
      };
      for (const square of dirty) {
        const ids = members.get(square) ?? [];
        if (ids.length === 0) {
          if (st.stored.has(square)) { remove.push(this.blobKey(name, square)); if (name === 'buildings') remove.push(this.wearKey(square)); }
          stored.delete(square);
          continue;
        }
        const orders = spec.order ? ids.map((id) => spec.order!(doc, id)) : null;
        let records: ArrayBufferLike | unknown[];
        if (spec.table) {
          // A kind kept in a table: the square's rows copied from the map's table, nothing decoded; a record written on the page encoded as the file holds it.
          const writer = new TableWriter<TableRow>(false, spec.columns as RowPlace<TableRow> | undefined ?? null, spec.box as RowBox<TableRow> | undefined ?? null);
          for (const id of ids) {
            const ref = spec.ref!(doc, id);
            if (ref) writer.copyRows(tableOf(ref.buffer), [ref.row]);
            else writer.add([spec.saved(items.get(id)!) as TableRow]);
          }
          records = writer.finish().buffer;
        } else records = ids.map((id) => spec.saved(items.get(id)!));
        put.push({ key: this.blobKey(name, square), bytes: squareFrame(records, orders), packed: true });
        if (name === 'buildings') put.push({ key: this.wearKey(square), bytes: wears(ids), packed: false });
        stored.add(square);
      }
      // The stored squares whose wears alone are written: their records stand as stored.
      for (const square of wear) {
        if (dirty.has(square) || !st.stored.has(square)) continue;
        const ids = members.get(square) ?? [];
        if (ids.length) put.push({ key: this.wearKey(square), bytes: wears(ids), packed: false });
      }
      nextStored.set(name, stored);
    }
    for (const name of LIST_NAMES) {
      const st = this.lists[name];
      const dirty = st.dirty;
      st.dirty = new Set();
      takenLists.set(name, dirty);
      const stored = new Set(st.stored);
      if (dirty.size) {
        // The items of the squares to write, in the list's order (one pass of references; only these are handed on).
        const out = new Map<string, { r: object[]; o: number[] }>();
        for (const square of dirty) out.set(square, { r: [], o: [] });
        for (const item of LISTS[name].list(doc)) {
          const blob = out.get(st.square.get(item) ?? '');
          if (blob) { blob.r.push(item); blob.o.push(st.ords.get(item) ?? 0); }
        }
        for (const [square, blob] of out) {
          if (blob.r.length === 0) {
            if (st.stored.has(square)) remove.push(this.blobKey(name, square));
            stored.delete(square);
            continue;
          }
          put.push({ key: this.blobKey(name, square), bytes: squareFrame(blob.r, blob.o), packed: true });
          stored.add(square);
        }
      }
      nextStored.set(name, stored);
    }
    const globals = this.globals;
    this.globals = new Set();
    for (const part of globals) put.push({ key: this.globalKey(part), bytes: valueFrame(GLOBAL_MAGIC, doc.savedGlobals(part)), packed: true });
    const storedGlobals = new Set([...this.storedGlobals, ...globals]);
    const squares: Partial<Record<LayerName, string[]>> = {};
    for (const [name, set] of nextStored) if (set.size) squares[name] = [...set].sort();
    const manifest: RegionManifest = { version: 8, savedAt, settings, squares, globals: GLOBAL_PARTS.filter((p) => storedGlobals.has(p)) };
    put.push({ key: this.manifestKey, bytes: valueFrame(MANIFEST_MAGIC, manifest), packed: false });
    const oldKeys = this.oldKeys;
    this.oldKeys = [];
    if (!(await this.writer.write({ put, remove }))) {
      for (const [name, taken] of takenKeyed) {
        const st = this.keyed[name];
        for (const square of taken.dirty) st.dirty.add(square);
        for (const square of taken.wear) st.wear.add(square);
      }
      for (const [name, taken] of takenLists) for (const square of taken) this.lists[name].dirty.add(square);
      for (const part of globals) this.globals.add(part);
      this.oldKeys = oldKeys;
      return false;
    }
    for (const name of KEYED_NAMES) this.keyed[name].stored = nextStored.get(name)!;
    for (const name of LIST_NAMES) this.lists[name].stored = nextStored.get(name)!;
    this.storedGlobals = storedGlobals;
    return true;
  }

  /** The map saved here (as regions cut from its tables, as regions on the universal grid or of the tiles of 1,024 m, by tiles in JSON, or in the format before them), or null when there is none or it cannot be read. Each format is known by its manifest, the regions' by its magic word. */
  async read(): Promise<TiledSession | null> {
    const [regionBlob, regions7Blob, regions6Blob, tilesBlob, oldBlob] = await this.store.get([this.manifestKey, this.regions7ManifestKey, this.regions6ManifestKey, this.tilesManifestKey, this.oldManifestKey]);
    const regions = regionBlob ? readValueFrame(await regionBlob.arrayBuffer(), MANIFEST_MAGIC) : null;
    if (isTiledManifest(regions, 8)) return this.readSquares(regions, this.regionKeys, REGION_CODEC, null);
    // The regions before the tables (manifest 7), and of the tiles of 1,024 m (6): read as they were, every record filed again in the squares of now by the next save (`adopt`, layout `old`).
    const regions7 = regions7Blob ? readValueFrame(await regions7Blob.arrayBuffer(), MANIFEST_MAGIC) : null;
    if (isTiledManifest(regions7, 7)) return this.readSquares(regions7, this.regions7Keys, REGION_CODEC, [...this.keysOf(regions7, this.regions7Keys), this.regions7ManifestKey]);
    const regions6 = regions6Blob ? readValueFrame(await regions6Blob.arrayBuffer(), MANIFEST_MAGIC) : null;
    if (isTiledManifest(regions6, 6)) return this.readSquares(regions6, this.regions6Keys, REGION_CODEC, [...this.keysOf(regions6, this.regions6Keys), this.regions6ManifestKey]);
    const tiles: unknown = tilesBlob ? JSON.parse(await tilesBlob.text()) : null;
    if (isTiledManifest(tiles)) return this.readSquares(tiles, this.tileKeys, JSON_CODEC, [...this.keysOf(tiles, this.tileKeys), this.tilesManifestKey]);
    const old: unknown = oldBlob ? JSON.parse(await oldBlob.text()) : null;
    if (isOldManifest(old)) return this.readOld(old);
    return null;
  }

  /** The keys a manifest's squares, wears and parts are held under. */
  private keysOf(manifest: TiledManifest, keys: SquareKeys): string[] {
    const out: string[] = [];
    for (const name of LAYER_NAMES) for (const square of manifest.squares[name] ?? []) out.push(keys.blob(name, square));
    for (const square of manifest.squares.buildings ?? []) out.push(keys.wear(square));
    for (const part of manifest.globals) out.push(keys.global(part));
    return out;
  }

  /**
   * A map by squares read back, its blobs decoded by `codec`; `old`: the keys of a format before this one (the next save writes the map
   * whole). A kind kept in a table whose every square is a table (manifest 8; the buildings' since 6) is joined into one table of the
   * map, row by row without decoding (`copyRows`), in id order (the lots in their order), a building whose stored wear differs from its
   * row's alone decoded and written with it; a kind with a square in JSON (a save before) goes to the document as records, as before.
   */
  private async readSquares(manifest: TiledManifest, keys: SquareKeys, codec: SquareCodec, old: readonly string[] | null): Promise<TiledSession | null> {
    const blobs: { layer: LayerName; square: string }[] = [];
    for (const name of LAYER_NAMES) for (const square of manifest.squares[name] ?? []) blobs.push({ layer: name, square });
    const wearSquares = manifest.squares.buildings ?? [];
    const got = await this.store.get([
      ...blobs.map((b) => keys.blob(b.layer, b.square)), ...wearSquares.map((s) => keys.wear(s)), ...manifest.globals.map((p) => keys.global(p)),
    ]);
    performance.mark('save:files-read');
    const globals: Record<string, unknown> = {};
    for (let i = 0; i < manifest.globals.length; i++) {
      const blob = got[blobs.length + wearSquares.length + i];
      if (!blob) return null;
      const part = await codec.global(blob);
      if (!isObject(part)) return null;
      Object.assign(globals, part);
    }
    if (globals['version'] !== 1) return null;
    // Each square's wears, where kept: laid over the records stored before them.
    const wears = new Map<number, number>();
    for (let i = 0; i < wearSquares.length; i++) {
      const blob = got[blobs.length + i];
      const read = blob ? await codec.wears(blob) : null;
      if (read) for (const [id, decay] of read) wears.set(id, decay);
    }
    const keyedRead = new Map<KeyedName, { record: unknown; id: number; order: number; square: string }[]>();
    /** A kind kept in a table: each square's table and the order of its rows, joined once every square is read (`joined`). */
    const tableRead = new Map<KeyedName, { table: RecordTable; orders: Float64Array | null }[]>();
    const listRead = new Map<ListName, { item: unknown; ord: number; square: string }[]>();
    // DO NOT wait for each square's decompression before starting the next (EDT-03: hundreds, one after the other, at the opening): a batch at a time in flight, read in the same order.
    for (let i = 0; i < blobs.length; i += GUNZIP_BATCH) {
      const batch: Promise<SquareBlob | SquareSections | null>[] = [];
      for (let k = i; k < Math.min(blobs.length, i + GUNZIP_BATCH); k++) {
        const blob = got[k];
        if (!blob) return null;
        batch.push(codec.square(blob));
      }
      const values = await Promise.all(batch);
      for (let k = 0; k < values.length; k++) {
        const value = values[k];
        if (!value) return null;
        const { layer, square } = blobs[i + k]!;
        if ((KEYED_NAMES as readonly LayerName[]).includes(layer)) {
          const name = layer as KeyedName;
          if ('table' in value && value.table) {
            if (KEYED[name].table) {
              // The table in a buffer of its own: its columns are read from offset 0 (`RecordTable`).
              const list = tableRead.get(name) ?? [];
              tableRead.set(name, list);
              list.push({ table: new RecordTable(value.table.slice().buffer), orders: value.orders });
              continue;
            }
          }
          const records = squareRecords(value);
          if (!records) return null;
          const out = keyedRead.get(name) ?? [];
          keyedRead.set(name, out);
          records.r.forEach((record, j) => out.push({
            record: name === 'buildings' ? withWear(record, wears) : record, id: idOf(record), order: records.o?.[j] ?? 0, square,
          }));
        } else {
          const name = layer as ListName;
          const records = squareRecords(value);
          if (!records?.o) return null;
          const out = listRead.get(name) ?? [];
          listRead.set(name, out);
          records.r.forEach((item, j) => out.push({ item, ord: records.o![j]!, square }));
        }
      }
    }
    performance.mark('save:parsed');
    // A kind with a square in JSON beside its tables (a save of two formats): every record of it as an object, the tables decoded too.
    const tables: Partial<Record<DocTable, ArrayBufferLike>> = {};
    for (const [name, squares] of tableRead) {
      const spec = KEYED[name];
      if (keyedRead.has(name)) {
        const out = keyedRead.get(name)!;
        for (const { table, orders } of squares) {
          const records = tableRecords(table.buffer);
          records.forEach((record, j) => out.push({ record: name === 'buildings' ? withWear(record, wears) : record, id: table.ids[j]!, order: orders?.[j] ?? 0, square: '' }));
        }
        continue;
      }
      tables[spec.table!] = this.joined(name, squares, wears);
    }
    for (const [name, out] of keyedRead) out.sort(name === 'lots' ? (a, b) => a.order - b.order || a.id - b.id : (a, b) => a.id - b.id);
    for (const out of listRead.values()) out.sort((a, b) => a.ord - b.ord);
    const records = (name: KeyedName): unknown[] => (keyedRead.get(name) ?? []).map((e) => e.record);
    const items = (name: ListName): unknown[] => (listRead.get(name) ?? []).map((e) => e.item);
    const { fogSettings, gullyAuto, ...rest } = globals as SavedGlobals & Record<string, unknown>;
    const document = {
      ...rest,
      nodes: records('nodes'), segments: records('segments'), terrain: items('stamps'), paint: items('paint'),
      fog: { dabs: items('fog'), ...(fogSettings !== undefined ? { settings: fogSettings } : {}) },
      gullies: { dabs: items('gullies'), ...(gullyAuto !== undefined ? { auto: gullyAuto } : {}) },
      clouds: items('clouds'), elements: items('elements'), trees: items('trees'), treeClearings: items('clearings'),
      poles: records('poles'), poleSpans: records('spans'), landscape: records('landscape'), barriers: records('barriers'),
      buildings: records('buildings'), zones: items('zones'), zoneMarks: items('zoneMarks'), lots: records('lots'), lotKeys: rest.lotKeys ?? [],
    } as unknown as SerializedDoc;
    // A format before this one: nothing of it is this format's layout, the next save writes every square.
    if (old) return { document, tables, settings: manifest.settings, savedAt: manifest.savedAt, layout: { old, squares: {}, globals: [], lists: {} } };
    const lists: Partial<Record<ListName, { ords: number[]; squares: string[] }>> = {};
    for (const [name, out] of listRead) lists[name] = { ords: out.map((e) => e.ord), squares: out.map((e) => e.square) };
    return {
      document, tables, settings: manifest.settings, savedAt: manifest.savedAt,
      layout: { old: null, squares: manifest.squares, globals: manifest.globals, lists },
    };
  }

  /**
   * A kind's squares joined into one table of the map, row by row without decoding (`TableWriter.copyRows`), in id order (the lots in
   * their stored order, then by id) as the map read as records always held them; a building whose stored wear differs from its row's
   * decoded, given its wear and written with the rest - that one record an object, let go at once.
   */
  private joined(name: KeyedName, squares: readonly { table: RecordTable; orders: Float64Array | null }[], wears: ReadonlyMap<number, number>): ArrayBufferLike {
    const rows: { t: number; row: number; id: number; order: number }[] = [];
    squares.forEach(({ table, orders }, t) => { for (let row = 0; row < table.rows; row++) rows.push({ t, row, id: table.ids[row]!, order: orders?.[row] ?? 0 }); });
    rows.sort(name === 'lots' ? (a, b) => a.order - b.order || a.id - b.id : (a, b) => a.id - b.id);
    const writer = new TableWriter<TableRow>(false, KEYED[name].columns as RowPlace<TableRow> | undefined ?? null, KEYED[name].box as RowBox<TableRow> | undefined ?? null);
    const readers = new Map<number, TableReader>();
    for (const { t, row, id } of rows) {
      const table = squares[t]!.table;
      if (name === 'buildings' && wears.has(id)) {
        let reader = readers.get(t);
        if (!reader) readers.set(t, reader = table.reader());
        const decay = reader.field(row, 'decay');
        if ((typeof decay === 'number' ? decay : 0) !== wears.get(id)) { writer.add([withWear(reader.record(row), wears) as TableRow]); continue; }
      }
      writer.copyRows(table, [row]);
    }
    return writer.finish().buffer;
  }

  /** The keys of a map stored in the format before the tiles. */
  private oldKeysOf(manifest: OldManifest): string[] {
    return [`${this.key}:head`, ...manifest.parts.flatMap((part) => [`${this.key}:part:${part}`, `${this.key}:wear:${part}`])];
  }

  /** A map saved before the tiles (manifest 3: the head in one text, the buildings in parts of ids): read as it was, written by tiles next. */
  private async readOld(manifest: OldManifest): Promise<TiledSession | null> {
    const blobs = await this.store.get([`${this.key}:head`, ...manifest.parts.map((part) => `${this.key}:part:${part}`)]);
    const [headBlob, ...partBlobs] = blobs;
    if (!headBlob || partBlobs.some((blob) => !blob)) return null;
    // Each part's wears, where kept (a map saved before them has none: its records carry their wear).
    const wearBlobs = await this.store.get(manifest.parts.map((part) => `${this.key}:wear:${part}`));
    const head: unknown = JSON.parse(await gunzip(headBlob));
    if (!isObject(head)) return null;
    const buildings: unknown[] = [];
    for (let i = 0; i < partBlobs.length; i++) {
      const records: unknown = JSON.parse(await gunzip(partBlobs[i]!));
      if (!Array.isArray(records)) return null;
      const wearBlob = wearBlobs[i];
      const wears = wearBlob ? readWears(await wearBlob.text()) : null;
      for (const record of records) buildings.push(wears ? withWear(record, wears) : record);
    }
    return {
      document: { ...(head as unknown as SerializedDoc), buildings } as SerializedDoc, tables: {}, settings: manifest.settings, savedAt: manifest.savedAt,
      layout: { old: this.oldKeysOf(manifest), squares: {}, globals: [], lists: {} },
    };
  }

  /** Runs after the saves under way: never a removal in the middle of a write. */
  private queued(run: () => Promise<boolean>): Promise<boolean> {
    const done = this.queue.then(run);
    this.queue = done.catch((error: unknown) => { console.error('[save] the tiles of the map were not reached', error); return false; });
    return done;
  }

  /** The keys the saved map is held under, in every format by squares (8, 7, 6 and the tiles in JSON), each manifest after its blobs. */
  private async savedKeys(): Promise<string[]> {
    const [regionBlob, regions7Blob, regions6Blob, tilesBlob] = await this.store.get([this.manifestKey, this.regions7ManifestKey, this.regions6ManifestKey, this.tilesManifestKey]);
    const regions = regionBlob ? readValueFrame(await regionBlob.arrayBuffer(), MANIFEST_MAGIC) : null;
    const regions7 = regions7Blob ? readValueFrame(await regions7Blob.arrayBuffer(), MANIFEST_MAGIC) : null;
    const regions6 = regions6Blob ? readValueFrame(await regions6Blob.arrayBuffer(), MANIFEST_MAGIC) : null;
    const tiles: unknown = tilesBlob ? JSON.parse(await tilesBlob.text()) : null;
    return [
      ...(isTiledManifest(regions, 8) ? this.keysOf(regions, this.regionKeys) : []), this.manifestKey,
      ...(isTiledManifest(regions7, 7) ? [...this.keysOf(regions7, this.regions7Keys), this.regions7ManifestKey] : []),
      ...(isTiledManifest(regions6, 6) ? [...this.keysOf(regions6, this.regions6Keys), this.regions6ManifestKey] : []),
      ...(isTiledManifest(tiles) ? [...this.keysOf(tiles, this.tileKeys), this.tilesManifestKey] : []),
    ];
  }

  /** Nothing is known to be stored: the next save writes every square. */
  private forget(): void {
    this.doc = null;
    this.keyed = freshKeyed();
    this.lists = freshLists();
    this.globals = new Set(GLOBAL_PARTS);
    this.storedGlobals = new Set();
    this.oldKeys = [];
  }

  /** The map's tiles removed: the map is saved whole again (`Persistence.saveSession`). */
  clear(): Promise<boolean> {
    return this.queued(async () => {
      this.forget();
      return this.store.write([], await this.savedKeys());
    });
  }

  /** The map's tiles set aside under a key of their own, never deleted: it passed validation and the loader threw */
  setAside(at: number): Promise<boolean> {
    return this.queued(async () => {
      const keys = await this.savedKeys();
      const blobs = await this.store.get(keys);
      const aside = `${this.key}.unreadable.${at}`;
      const put = keys.flatMap((key, i) => {
        const blob = blobs[i];
        return blob ? [[`${aside}${key.slice(this.key.length)}`, blob] as const] : [];
      });
      if (put.length === 0) return false;
      this.forget();
      return this.store.write(put, keys);
    });
  }
}

/** A square's records from what its codec read: the records themselves, or a table's decoded (a square read as records). */
function squareRecords(value: SquareBlob | SquareSections): SquareBlob | null {
  if (!('table' in value)) return value;
  const r: unknown = value.table ? tableRecords(value.table.slice().buffer) : value.json ? JSON.parse(new TextDecoder().decode(value.json)) : null;
  if (!Array.isArray(r) || (value.orders && value.orders.length !== r.length)) return null;
  return value.orders ? { r, o: Array.from(value.orders) } : { r };
}

/** Where a format keeps a map by squares. */
interface SquareKeys {
  blob(layer: LayerName, square: string): string;
  wear(square: string): string;
  global(part: GlobalPart): string;
}
