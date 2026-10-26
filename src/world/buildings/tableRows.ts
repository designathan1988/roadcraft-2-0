import { RecordTable, type TableReader, type TableRow, readRow } from './recordTable';
import type { Building, BuildingId } from './types';

/** THE RECORDS OF A TABLE AS A READ-ONLY MAP BY ID, EACH RECORD DECODED WHEN READ (report "Arquitetura para cidades grandes", "A conta de memória"): the table is the source of truth, a record is a JS object only while someone reads it. The buildings', the lots' and the landscaping's alike (`TableRow`). */

/** The records read by id kept alive, newest last: the selection, the inspector and the tools read the same few again and again. */
const RECENT = 2048;

/** DO NOT keep every record decoded (`tableRecords` did: ~8 KB of heap a building, the table ~1.3 KB outside it). A record read is the same object while anyone holds it (a `WeakRef` by row while it lives), so a reader that compares a held record with the one it gets again compares the same object. */
export class TableRows<K extends number = BuildingId, T extends TableRow = Building> implements ReadonlyMap<K, T> {
  readonly table: RecordTable;
  private readonly reader: TableReader<T>;
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

  constructor(buffer: ArrayBufferLike) {
    this.table = new RecordTable(buffer);
    // Its shared members held weakly: the table lives as long as the map, and a walk of the map would leave every one decoded.
    this.reader = this.table.reader<T>(true);
    const n = this.table.rows, ids = this.table.ids;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => ids[a]! - ids[b]!);
    this.sortedRows = order;
    this.sortedIds = new Float64Array(n);
    for (let i = 0; i < n; i++) this.sortedIds[i] = ids[order[i]!]!;
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  get buffer(): ArrayBufferLike {
    return this.table.buffer;
  }

  get size(): number {
    return this.table.rows;
  }

  /** The row of an id; -1 when the table has none. */
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
    return this.table.ids[row]! as K;
  }

  /** Where a row's record stands, from the table's columns: nothing decoded (NaN where the record has no place). */
  placeAt(row: number): { readonly x: number; readonly y: number } {
    return { x: this.table.xs[row]!, y: this.table.ys[row]! };
  }

  /** The box a row's record covers on the ground, from the table's columns (a building's `buildingBounds`), nothing decoded; null when the table has no box columns (written before them) or the row none. */
  boxAt(row: number): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | null {
    const boxes = this.table.boxes;
    if (!boxes) return null;
    const minX = boxes.minX[row]!;
    return Number.isFinite(minX) ? { minX, minY: boxes.minY[row]!, maxX: boxes.maxX[row]!, maxY: boxes.maxY[row]! } : null;
  }

  /** A row's record: the one held somewhere if any, else decoded now. */
  record(row: number): T {
    const held = this.alive.get(row)?.deref();
    if (held) return held;
    const b = readRow(this.reader, row);
    this.alive.set(row, new WeakRef(b as T & object));
    this.collected.register(b as T & object, row);
    this.onRead?.(b);
    return b;
  }

  /** One field of a row's record, the rest passed over, nothing decoded (`TableReader.field`): undefined where the record has none. */
  field(row: number, name: string): unknown {
    return this.reader.field(row, name);
  }

  /** How many rows' records are decoded and held somewhere now (the LRU of `get` among them): what the table saves is what is not. */
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
    const ids = this.table.ids;
    for (let row = 0; row < ids.length; row++) yield ids[row]! as K;
  }

  *values(): MapIterator<T> {
    for (let row = 0; row < this.table.rows; row++) yield this.record(row);
  }

  *entries(): MapIterator<[K, T]> {
    for (let row = 0; row < this.table.rows; row++) yield [this.idAt(row), this.record(row)];
  }

  [Symbol.iterator](): MapIterator<[K, T]> {
    return this.entries();
  }

  forEach(visit: (value: T, key: K, map: ReadonlyMap<K, T>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }
}
