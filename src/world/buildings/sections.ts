import { TableItems } from './items';
import { type RecordRef, RecordTable, type RowPlace, type TableRow, encodeRecords, tableRecords } from './recordTable';
import { TableRows } from './tableRows';
import type { Building, BuildingId } from './types';

/** A STORE'S RECORDS AS BUFFERS, NEVER AS OBJECTS (the save's sections, the simulation's map, the undo of a whole map): the table they were opened from, as it is (shared, never copied), and what was written over it - the ids deleted, the records replaced and the records added, each as a table of their own. The buildings', the lots' and the landscaping's alike. */
export interface TableSections {
  readonly base: ArrayBufferLike | null;
  /** The ids of the table deleted (set again: in `added`). */
  readonly gone: Float64Array;
  readonly replaced: ArrayBufferLike | null;
  readonly added: ArrayBufferLike | null;
}
/** The buildings' sections (`BuildingStore.sections`). */
export type BuildingSections = TableSections;

/** Sections of nothing: a map with no records of the kind. */
export const EMPTY_SECTIONS: TableSections = Object.freeze({ base: null, gone: new Float64Array(0), replaced: null, added: null });

const tableOf = <V extends TableRow>(records: Iterable<V>, place: RowPlace<V> | null): ArrayBufferLike | null => {
  const list = [...records];
  return list.length ? encodeRecords(list, place).buffer : null;
};

/** The sections of a store's records: the table shared as it is, only the records written encoded (`encodeRecords`). A map that is no table (a working copy's `ForkMap`): every record, added. `place`: a record's place for its columns (a lot's centre). */
export function sectionsOf<K extends number, V extends TableRow>(items: ReadonlyMap<K, V>, place: RowPlace<V> | null = null): TableSections {
  if (items instanceof TableItems) {
    const { gone, replaced, added } = (items as TableItems<K, V>).writes();
    return { base: items.table?.buffer ?? null, gone: Float64Array.from(gone), replaced: tableOf(replaced.values(), place), added: tableOf(added.values(), place) };
  }
  return { base: null, gone: new Float64Array(0), replaced: null, added: tableOf(items.values(), place) };
}

/** The store's items read back from their sections: the table read when asked (`TableRows`), the records written decoded now (few). */
export function itemsOfSections<K extends number = BuildingId, V extends TableRow = Building>(s: TableSections, onRead: ((v: V) => void) | null): TableItems<K, V> {
  const base = s.base ? new TableRows<K, V>(s.base) : null;
  if (base) base.onRead = onRead;
  const written = (buffer: ArrayBufferLike | null): V[] => {
    const list = buffer ? tableRecords<V>(buffer) : [];
    if (onRead) for (const b of list) onRead(b);
    return list;
  };
  return TableItems.over<K, V>(base, s.gone as unknown as Iterable<K>, written(s.replaced), written(s.added));
}

/** How many records the sections hold. */
export function sectionsSize(s: TableSections): number {
  const rows = (buffer: ArrayBufferLike | null): number => (buffer ? new RecordTable(buffer).rows : 0);
  return rows(s.base) - s.gone.length + rows(s.added);
}

/** The bytes the sections hold. */
export function sectionsBytes(s: TableSections): number {
  return (s.base?.byteLength ?? 0) + s.gone.byteLength + (s.replaced?.byteLength ?? 0) + (s.added?.byteLength ?? 0);
}

/** Where each record of the sections is read, in the store's order (`eachSectionRecord`'s order): a row of the table, of the records replaced or of those added - nothing decoded (the worker's columns, `sim/agents/trafficBuildings.ts`). */
export function* eachSectionRef(s: TableSections): Generator<RecordRef, void, void> {
  const replaced = new Map<number, number>();
  if (s.replaced) {
    const table = new RecordTable(s.replaced);
    for (let row = 0; row < table.rows; row++) replaced.set(table.ids[row]!, row);
  }
  const gone = new Set<number>(s.gone);
  if (s.base) {
    const table = new RecordTable(s.base);
    for (let row = 0; row < table.rows; row++) {
      const id = table.ids[row]!;
      if (gone.has(id)) continue;
      const over = replaced.get(id);
      yield over === undefined ? { buffer: s.base, row } : { buffer: s.replaced!, row: over };
    }
  }
  if (s.added) {
    const rows = new RecordTable(s.added).rows;
    for (let row = 0; row < rows; row++) yield { buffer: s.added, row };
  }
}
