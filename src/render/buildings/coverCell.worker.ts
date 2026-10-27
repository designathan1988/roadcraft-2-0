import type { ChangeRect } from '@world/changes';
import { RecordTable, type TableReader, readRow, tableRecords } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import type { JobScope } from '../../jobs/jobScope';
import { type PackedCover, coverCellOf, packCover } from './layerCells';

/** A CELL OF THE BUILDINGS' COVER WORKED OUT OFF THE PAGE (`coverJobs.ts`): the buildings near it, read where the map's table holds them (`refs`, a
 *  thread sharing the page's memory) or as rows of a table of their own (`table`), their footprints filed by bucket (`coverCellOf`), the cell's
 *  numbers handed back. */

export interface CoverCellAsk {
  readonly id: number;
  readonly rect: ChangeRect;
  /** The buildings written on the page, or every one for a thread of a job process: a table of their own. */
  readonly table: ArrayBuffer | null;
  /** The buildings the map's table holds, by row (a thread of the page: the same memory). */
  readonly refs?: readonly { readonly buffer: ArrayBufferLike; readonly row: number }[];
}
export type CoverCellReply = { readonly id: number; readonly cover: PackedCover } | { readonly id: number; readonly error: string };

/** The buildings an ask names: its refs' rows read where they stand (each table's reader made once, kept while its buffer lives), then its own table's. */
function* buildingsOf(ask: CoverCellAsk, readers: WeakMap<ArrayBufferLike, TableReader<Building>>): Generator<Building> {
  for (const { buffer, row } of ask.refs ?? []) {
    let reader = readers.get(buffer);
    if (!reader) readers.set(buffer, reader = new RecordTable(buffer).reader<Building>(true));
    yield readRow(reader, row);
  }
  if (ask.table) yield* tableRecords<Building>(ask.table);
}

export function serve(scope: JobScope): void {
  /** The map's tables read by this thread, by their buffer (the same memory as the page's). */
  const readers = new WeakMap<ArrayBufferLike, TableReader<Building>>();
  scope.onmessage = (event: MessageEvent<CoverCellAsk>) => {
    const ask = event.data;
    try {
      const cover = packCover(coverCellOf(buildingsOf(ask, readers), ask.rect));
      scope.postMessage({ id: ask.id, cover } satisfies CoverCellReply, [cover.xy.buffer, cover.starts.buffer, cover.keys.buffer, cover.at.buffer, cover.polygons.buffer] as ArrayBuffer[]);
    } catch (error) {
      console.error('[buildings] a cover cell could not be worked out off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CoverCellReply);
    }
  };
}
