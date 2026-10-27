import { type BoxColumns, RecordTable, type TableReader, type TableRow, readRow } from './recordTable';
import type { Building, BuildingId } from './types';

/** THE RECORDS OF A STORE'S TABLES AS A READ-ONLY MAP BY ID, EACH RECORD DECODED WHEN READ (report "Arquitetura para cidades grandes", "A conta de memória"): the tables are the source of truth, a record is a JS object only while someone reads it. The buildings', the lots' and the landscaping's alike (`TableRow`). */

/**
 * Where a store's records stand: one table, or several (a map read back from its saved squares, a table a square, `editor/squaresDecode.ts`)
 * with the order its records are in (the rows of the tables one after the other numbered, `order` the rows in the store's order; null: theirs).
 * DO NOT join a map's squares into one table to read it: the 10 km city's buildings were 687 MB copied row by row at every opening, ~7 s,
 * the squares' tables and the copy held at once (2026-10-27).
 */
export type TableBase = ArrayBufferLike | { readonly tables: readonly ArrayBufferLike[]; readonly order: Uint32Array | null };

/** A base's tables' buffers, in their rows' order. */
export const baseBuffers = (base: TableBase): readonly ArrayBufferLike[] => ('tables' in base ? base.tables : [base]);
/** A base's order of its rows (null: theirs). */
export const baseOrder = (base: TableBase): Uint32Array | null => ('tables' in base ? base.order : null);

/** The records read by id kept alive, newest last: the selection, the inspector and the tools read the same few again and again. */
const RECENT = 2048;

/** DO NOT keep every record decoded (`tableRecords` did: ~8 KB of heap a building, the table ~1.3 KB outside it). A record read is the same object while anyone holds it (a `WeakRef` by row while it lives), so a reader that compares a held record with the one it gets again compares the same object. */
export class TableRows<K extends number = BuildingId, T extends TableRow = Building> implements ReadonlyMap<K, T> {
  /** The tables, their rows numbered one after the other (a row of the store: its table's first row's number and its row there). */
  readonly tables: readonly RecordTable[];
  /** Each row's id, place, turn and box (NaN where none), the tables' columns one after the other: read without a record. One table's are its own columns. */
  readonly ids: Float64Array;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly rotations: Float64Array;
  /** The rows' boxes on the ground; null where a table has none (written before them). */
  readonly boxes: BoxColumns | null;
  /** The rows in the store's order (null: theirs, `rowAt`). */
  readonly order: Uint32Array | null;
  private readonly readers: TableReader<T>[];
  /** Each table's first row's number, and the table of each row (several tables only). */
  private readonly starts: Uint32Array;
  private readonly tableOfRow: Uint16Array | Uint32Array | null;
  /** The ids sorted, and each one's row: a row found by binary search, 12 bytes a record, no `Map` entry each. */
  private readonly sortedIds: Float64Array;
  private readonly sortedRows: Uint32Array;
  /** Each row's record while it is held somewhere (WeakRef: MDN "WeakRef"), by row: an entry while the record lives, let go by `collected` once the collector takes it. DO NOT keep a slot a row nor a dead `WeakRef` in it: a walk of the city would leave one each. */
  private readonly alive = new Map<number, WeakRef<T & object>>();
  /** A record collected: its row's entry let go, unless the row was decoded again since (MDN "FinalizationRegistry"). */
  private readonly collected = new FinalizationRegistry<number>((row) => {
    if (this.alive.get(row)?.deref() === undefined) this.alive.delete(row);
  });
  /** The rows last read by id (`get`), held: the working set near the player, never the whole walk of `values`. */
  private readonly recent = new Map<number, T>();
  /** Told each record decoded (the buildings' store marks it settled: `BuildingStore.settled`). */
  onRead: ((b: T) => void) | null = null;

  constructor(base: TableBase) {
    const tables = baseBuffers(base).map((buffer) => new RecordTable(buffer));
    this.tables = tables;
    // Its shared members held weakly: the tables live as long as the map, and a walk of the map would leave every one decoded.
    this.readers = tables.map((table) => table.reader<T>(true));
    this.starts = new Uint32Array(tables.length + 1);
    for (let t = 0; t < tables.length; t++) this.starts[t + 1] = this.starts[t]! + tables[t]!.rows;
    const n = this.starts[tables.length]!;
    const order = baseOrder(base);
    if (order && order.length !== n) throw new Error(`[buildings] an order of ${order.length} rows for tables of ${n}`);
    this.order = order;
    if (tables.length === 1) {
      const t = tables[0]!;
      this.ids = t.ids; this.xs = t.xs; this.ys = t.ys; this.rotations = t.rotations; this.boxes = t.boxes;
      this.tableOfRow = null;
    } else {
      // The columns one after the other (a copy of each table's: 8 bytes a row a column, no record read).
      const column = (of: (t: RecordTable) => Float64Array): Float64Array => {
        const out = new Float64Array(n);
        tables.forEach((t, k) => out.set(of(t), this.starts[k]!));
        return out;
      };
      this.ids = column((t) => t.ids); this.xs = column((t) => t.xs); this.ys = column((t) => t.ys); this.rotations = column((t) => t.rotations);
      this.boxes = tables.every((t) => t.boxes)
        ? { minX: column((t) => t.boxes!.minX), minY: column((t) => t.boxes!.minY), maxX: column((t) => t.boxes!.maxX), maxY: column((t) => t.boxes!.maxY) }
        : null;
      const of = tables.length < 0x10000 ? new Uint16Array(n) : new Uint32Array(n);
      tables.forEach((_, k) => of.fill(k, this.starts[k]!, this.starts[k + 1]!));
      this.tableOfRow = of;
    }
    const ids = this.ids;
    const sorted = new Uint32Array(n);
    for (let i = 0; i < n; i++) sorted[i] = i;
    sorted.sort((a, b) => ids[a]! - ids[b]!);
    this.sortedRows = sorted;
    this.sortedIds = new Float64Array(n);
    for (let i = 0; i < n; i++) this.sortedIds[i] = ids[sorted[i]!]!;
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  /** The tables' buffers, and the order of their rows: what the store's sections hand on (`sections.ts`). */
  get base(): TableBase {
    return this.tables.length === 1 && !this.order ? this.tables[0]!.buffer : { tables: this.tables.map((t) => t.buffer), order: this.order };
  }

  get size(): number {
    return this.ids.length;
  }

  /** The row in the store's order at `rank` (0 to `size`): what a walk of the store reads in turn. */
  rowAt(rank: number): number {
    return this.order ? this.order[rank]! : rank;
  }

  /** Where a row stands in the store's order (`rowAt`'s inverse, made when first asked). */
  rankOf(row: number): number {
    const order = this.order;
    if (!order) return row;
    let ranks = this.ranks;
    if (!ranks) {
      ranks = this.ranks = new Uint32Array(order.length);
      for (let rank = 0; rank < order.length; rank++) ranks[order[rank]!] = rank;
    }
    return ranks[row]!;
  }
  private ranks: Uint32Array | null = null;

  /** The index in `tables` of a row's table. */
  tableIndexOf(row: number): number {
    return this.tableOfRow ? this.tableOfRow[row]! : 0;
  }

  /** A row's table, and its row there: where its columns stand (its summary, `store.ts`) and where a worker reads it (`RecordRef`). */
  tableOf(row: number): RecordTable {
    return this.tables[this.tableIndexOf(row)]!;
  }

  localRow(row: number): number {
    return row - this.starts[this.tableIndexOf(row)]!;
  }

  /** The row of an id; -1 when the tables have none. */
  rowOf(id: number): number {
    const ids = this.sortedIds;
    let lo = 0, hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, v = ids[mid]!;
      if (v === id) return this.sortedRows[mid]!;
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /** The id of a row. */
  idAt(row: number): K {
    return this.ids[row]! as K;
  }

  /** Where a row's record stands, from the columns: nothing decoded (NaN where the record has no place). */
  placeAt(row: number): { readonly x: number; readonly y: number } {
    return { x: this.xs[row]!, y: this.ys[row]! };
  }

  /** The box a row's record covers on the ground, from the columns (a building's `buildingBounds`), nothing decoded; null when a table has no box columns (written before them) or the row none. */
  boxAt(row: number): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | null {
    const boxes = this.boxes;
    if (!boxes) return null;
    const minX = boxes.minX[row]!;
    return Number.isFinite(minX) ? { minX, minY: boxes.minY[row]!, maxX: boxes.maxX[row]!, maxY: boxes.maxY[row]! } : null;
  }

  /** A row's record: the one held somewhere if any, else decoded now. */
  record(row: number): T {
    const held = this.alive.get(row)?.deref();
    if (held) return held;
    const t = this.tableIndexOf(row);
    const b = readRow(this.readers[t]!, row - this.starts[t]!);
    this.alive.set(row, new WeakRef(b as T & object));
    this.collected.register(b as T & object, row);
    this.onRead?.(b);
    return b;
  }

  /** Whether `record` is this row's record as decoded and held now (the very object `record(row)` gives while it lives): nothing decoded. */
  holds(row: number, record: T): boolean {
    return this.alive.get(row)?.deref() === record;
  }

  /** One field of a row's record, the rest passed over, nothing decoded (`TableReader.field`): undefined where the record has none. */
  field(row: number, name: string): unknown {
    const t = this.tableIndexOf(row);
    return this.readers[t]!.field(row - this.starts[t]!, name);
  }

  /** How many rows' records are decoded and held somewhere now (the LRU of `get` among them): what the tables save is what is not. */
  held(): number {
    let n = 0;
    for (const ref of this.alive.values()) if (ref.deref() !== undefined) n++;
    return n;
  }

  get(id: K): T | undefined {
    const row = this.rowOf(id);
    if (row < 0) return undefined;
    const b = this.record(row);
    const recent = this.recent;
    recent.delete(row);
    recent.set(row, b);
    if (recent.size > RECENT) recent.delete(recent.keys().next().value!);
    return b;
  }

  has(id: K): boolean {
    return this.rowOf(id) >= 0;
  }

  *keys(): MapIterator<K> {
    const ids = this.ids;
    for (let rank = 0; rank < ids.length; rank++) yield ids[this.rowAt(rank)]! as K;
  }

  *values(): MapIterator<T> {
    for (let rank = 0; rank < this.ids.length; rank++) yield this.record(this.rowAt(rank));
  }

  *entries(): MapIterator<[K, T]> {
    for (let rank = 0; rank < this.ids.length; rank++) {
      const row = this.rowAt(rank);
      yield [this.idAt(row), this.record(row)];
    }
  }

  [Symbol.iterator](): MapIterator<[K, T]> {
    return this.entries();
  }

  forEach(visit: (value: T, key: K, map: ReadonlyMap<K, T>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }
}
