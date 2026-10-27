import { RecordTable, type TableReader, TableWriter, readRow, tableBytes, tableRecords } from '@world/buildings/recordTable';
import type { BuildingStore } from '@world/buildings/store';
import type { Building, BuildingId } from '@world/buildings/types';

/**
 * BUILDINGS HANDED TO A JOB WITHOUT DECODING THEM ON THE PAGE (`coverJobs.ts`, `gardenJobs.ts`): those the map's table holds by their row
 * (`RecordRef`, a thread sharing the page's memory reads them where they stand), those written on the page encoded in a table of their own; for a
 * thread of a job process, every one's row copied into a table of their own (`TableWriter.copyRows`: never the map's table copied there).
 */

/** The buildings a job reads. */
export interface BuildingRows {
  /** The buildings written on the page, or every one for a thread of a job process: a table of their own (null: none). */
  readonly table: ArrayBuffer | null;
  /** The buildings the map's table holds, by row (a thread of the page: the same memory). */
  readonly refs?: readonly { readonly buffer: ArrayBufferLike; readonly row: number }[];
}

/** The buildings of `ids` where the map's table holds them, as (buffer, row) pairs, and those written on the page encoded in a table of their own.
 *  For a thread that shares the page's memory; null where a table is not in shared memory (a page not cross-origin isolated): DO NOT post a plain
 *  buffer's row, the whole table would be copied with it. */
export function rowRefs(ids: Iterable<BuildingId>, buildings: BuildingStore): BuildingRows | null {
  const refs: { buffer: ArrayBufferLike; row: number }[] = [];
  let writer: TableWriter | null = null;
  for (const id of ids) {
    // The table's row as it is: a wear written over it (`RecordRef.field`) left there, none of these jobs reads it.
    const ref = buildings.tableRef(id);
    if (ref) {
      if (typeof SharedArrayBuffer === 'undefined' || !(ref.buffer instanceof SharedArrayBuffer)) return null;
      refs.push({ buffer: ref.buffer, row: ref.row });
      continue;
    }
    const b = buildings.get(id);
    if (b) (writer ??= new TableWriter(false)).add([b]);
  }
  return { refs, table: writer ? tableBytes(writer.finish().buffer) as ArrayBuffer : null };
}

/** The buildings of `ids` as a table of their own (null: none), rows copied undecoded, a record written on the page encoded: for a thread of a
 *  job process. Each of the map's tables read once (`RecordTable` held by its bytes). */
export function rowCopier(): (ids: readonly BuildingId[], buildings: BuildingStore) => ArrayBuffer | null {
  const tables = new WeakMap<ArrayBufferLike, RecordTable>();
  const tableOf = (buffer: ArrayBufferLike): RecordTable => {
    let table = tables.get(buffer);
    if (!table) tables.set(buffer, table = new RecordTable(buffer));
    return table;
  };
  return (ids, buildings) => {
    if (!ids.length) return null;
    const writer = new TableWriter(false);
    for (const id of ids) {
      // The row as the table holds it.
      const ref = buildings.tableRef(id);
      if (ref) { writer.copyRows(tableOf(ref.buffer), [ref.row]); continue; }
      const b = buildings.get(id);
      if (b) writer.add([b]);
    }
    return tableBytes(writer.finish().buffer) as ArrayBuffer;
  };
}

/** The buildings a job was handed, in a worker: its refs' rows read where they stand (each table's reader made once, kept in `readers` while its buffer lives), then its own table's. */
export function* rowBuildings(rows: BuildingRows, readers: WeakMap<ArrayBufferLike, TableReader<Building>>): Generator<Building> {
  for (const { buffer, row } of rows.refs ?? []) {
    let reader = readers.get(buffer);
    if (!reader) readers.set(buffer, reader = new RecordTable(buffer).reader<Building>(true));
    yield readRow(reader, row);
  }
  if (rows.table) yield* tableRecords<Building>(rows.table);
}
