import type { RecordRef, TableRow } from './recordTable';
import type { TableRows } from './tableRows';
import type { Building, BuildingId } from './types';

/**
 * A STORE'S RECORDS: A RECORD TABLE (`TableRows`, decoded when read) WITH THE RECORDS WRITTEN SINCE OVER IT. A `Map` to its readers, in a
 * `Map`'s order (a key set again keeps its place, one deleted and set again goes last); its writes told before they happen while an edit
 * is recorded (`before`, as `core/recordMap.ts`). The buildings' (`BuildingItems`), the lots' and the landscaping's alike: DO NOT hold a
 * map's records as objects - 228,000 items of landscaping and 111,000 lots of a 10 km city stood as objects on the page (2026-10-26).
 */
export class TableItems<K extends number = BuildingId, V extends TableRow = Building> implements Map<K, V> {
  /** Ids of the table given another record; still at their row's place. */
  private replaced = new Map<K, V>();
  /** Ids after the table's: new ones, and the table's deleted and set again. */
  private added = new Map<K, V>();
  /** Ids of the table deleted (those set again are in `added` too). */
  private gone = new Set<K>();
  /** Told a key's value before it is written (undefined: the key was not there); null: nobody listens. */
  before: ((key: K, was: V | undefined) => void) | null = null;

  constructor(private base: TableRows<K, V> | null = null) {}

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  /** The table under the records written (null: none, every record written here). */
  get table(): TableRows<K, V> | null {
    return this.base;
  }

  /** A copy that reads the same table and holds the same records written (`BuildingStore.shareFrom`): its cost the records written, never the table. */
  copy(): TableItems<K, V> {
    const out = new TableItems<K, V>(this.base);
    out.replaced = new Map(this.replaced);
    out.added = new Map(this.added);
    out.gone = new Set(this.gone);
    return out;
  }

  /** What was written over the table, in the order `TableItems.over` puts it back (the save's sections, the simulation's map). */
  writes(): { readonly gone: ReadonlySet<K>; readonly replaced: ReadonlyMap<K, V>; readonly added: ReadonlyMap<K, V> } {
    return { gone: this.gone, replaced: this.replaced, added: this.added };
  }

  /** The items of a table and what was written over it (`writes`), as they were. */
  static over<K extends number, V extends TableRow>(base: TableRows<K, V> | null, gone: Iterable<K>, replaced: Iterable<V>, added: Iterable<V>): TableItems<K, V> {
    const out = new TableItems<K, V>(base);
    for (const id of gone) out.gone.add(id);
    for (const b of replaced) out.replaced.set(b.id as K, b);
    for (const b of added) out.added.set(b.id as K, b);
    return out;
  }

  /** Whether the record of `key` was written here (not the table's own). */
  owns(key: K): boolean {
    return this.added.has(key) || this.replaced.has(key);
  }

  /** Whether `key` reads the very same record here and in `other`, known without decoding it: both over one table, neither wrote it. */
  sameUnwritten(other: TableItems<K, V>, key: K): boolean {
    return this.base !== null && this.base === other.base && !this.owns(key) && !other.owns(key)
      && !this.gone.has(key) && !other.gone.has(key) && this.base.has(key);
  }

  /** Where a worker reads the record of `key` when it is the table's own (not written here): the table's buffer and its row, nothing decoded; null otherwise. */
  tableRef(key: K): RecordRef | null {
    const base = this.base;
    if (!base || this.owns(key) || this.gone.has(key)) return null;
    const row = base.rowOf(key);
    return row < 0 ? null : { buffer: base.buffer, row };
  }

  /** The row of a record of the table standing as the table's own or replaced in place (its place in the order): -1 for one added, gone or not here. */
  rowOrder(key: K): number {
    const base = this.base;
    if (!base || this.added.has(key) || this.gone.has(key)) return -1;
    return base.rowOf(key);
  }

  /** Where the record of `key` stands: the table's columns for one of the table (nothing decoded), the record's own x and y else; undefined when it is not here or has no place. */
  placeOf(key: K): { readonly x: number; readonly y: number } | undefined {
    const written = this.added.get(key) ?? this.replaced.get(key);
    if (written) return written.x !== undefined && written.y !== undefined ? { x: written.x, y: written.y } : undefined;
    if (this.gone.has(key) || !this.base) return undefined;
    const row = this.base.rowOf(key);
    return row < 0 ? undefined : this.base.placeAt(row);
  }

  get size(): number {
    return (this.base?.size ?? 0) - this.gone.size + this.added.size;
  }

  get(key: K): V | undefined {
    const added = this.added.get(key);
    if (added !== undefined) return added;
    if (this.gone.has(key)) return undefined;
    return this.replaced.get(key) ?? this.base?.get(key);
  }

  has(key: K): boolean {
    return this.added.has(key) || (!this.gone.has(key) && (this.replaced.has(key) || (this.base?.has(key) ?? false)));
  }

  private inBase(key: K): boolean {
    return this.base?.has(key) ?? false;
  }

  set(key: K, value: V): this {
    this.before?.(key, this.get(key));
    if (this.added.has(key) || this.gone.has(key) || !this.inBase(key)) this.added.set(key, value);
    else this.replaced.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    if (!this.has(key)) return false;
    this.before?.(key, this.get(key));
    if (this.added.delete(key)) return true;
    this.replaced.delete(key);
    this.gone.add(key);
    return true;
  }

  /** Every record let go, the table with them. */
  clear(): void {
    if (this.before) for (const [key, value] of this.entries()) this.before(key, value);
    this.base = null;
    this.replaced.clear();
    this.added.clear();
    this.gone.clear();
  }

  /** DO NOT decode a record to list ids: the table's id column, then the ids written after it. */
  *keys(): MapIterator<K> {
    if (this.base) for (const key of this.base.keys()) if (!this.gone.has(key)) yield key;
    yield* this.added.keys();
  }

  *entries(): MapIterator<[K, V]> {
    const base = this.base;
    if (base) {
      for (let row = 0; row < base.size; row++) {
        const key = base.idAt(row);
        if (this.gone.has(key)) continue;
        yield [key, this.replaced.get(key) ?? base.record(row)];
      }
    }
    yield* this.added.entries();
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  /** Each record's place: the table's own read from its place columns (nothing decoded), a record written here from its x and y; a record with no place passed over. DO NOT walk `values` for the places: every record of the table decoded. */
  eachPlace(visit: (x: number, y: number) => void): void {
    const base = this.base;
    if (base) {
      const { ids, xs, ys } = base.table;
      for (let row = 0; row < ids.length; row++) {
        const key = ids[row]! as K;
        if (this.gone.has(key) || this.replaced.has(key)) continue;
        const x = xs[row]!, y = ys[row]!;
        if (Number.isFinite(x) && Number.isFinite(y)) visit(x, y);
      }
    }
    for (const value of this.replaced.values()) if (value.x !== undefined && value.y !== undefined) visit(value.x, value.y);
    for (const value of this.added.values()) if (value.x !== undefined && value.y !== undefined) visit(value.x, value.y);
  }

  /** Each record's box on the ground: the table's own read from its box columns (nothing decoded; a row of a table written before them, or with none, decoded for `boxOf` alone), a record written here from `boxOf`. */
  eachBox(boxOf: (value: V) => { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | null,
    visit: (minX: number, minY: number, maxX: number, maxY: number) => void): void {
    const base = this.base;
    const take = (value: V): void => { const b = boxOf(value); if (b) visit(b.minX, b.minY, b.maxX, b.maxY); };
    if (base) {
      const { ids, boxes } = base.table;
      for (let row = 0; row < ids.length; row++) {
        const key = ids[row]! as K;
        if (this.gone.has(key) || this.replaced.has(key)) continue;
        const minX = boxes ? boxes.minX[row]! : Number.NaN;
        if (Number.isFinite(minX)) visit(minX, boxes!.minY[row]!, boxes!.maxX[row]!, boxes!.maxY[row]!);
        else take(base.record(row));
      }
    }
    for (const value of this.replaced.values()) take(value);
    for (const value of this.added.values()) take(value);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(visit: (value: V, key: K, map: Map<K, V>) => void, self?: unknown): void {
    for (const [key, value] of this.entries()) visit.call(self, value, key, this);
  }
}

/** THE STORE'S BUILDINGS: their table and the records written since (`TableItems`). */
export const BuildingItems = TableItems;
export type BuildingItems = TableItems<BuildingId, Building>;
