import type { ChangeRect } from '@world/changes';
import type { TableReader } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import type { JobScope } from '../../jobs/jobScope';
import { type PackedCover, coverCellOf, packCover } from './layerCells';
import { type BuildingRows, rowBuildings } from './rowRefs';

/** A CELL OF THE BUILDINGS' COVER WORKED OUT OFF THE PAGE (`coverJobs.ts`): the buildings near it, read where the map's table holds them (`refs`, a
 *  thread sharing the page's memory) or as rows of a table of their own (`table`), their footprints filed by bucket (`coverCellOf`), the cell's
 *  numbers handed back. */

export interface CoverCellAsk extends BuildingRows {
  readonly id: number;
  readonly rect: ChangeRect;
}
export type CoverCellReply = { readonly id: number; readonly cover: PackedCover } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  /** The map's tables read by this thread, by their buffer (the same memory as the page's). */
  const readers = new WeakMap<ArrayBufferLike, TableReader<Building>>();
  scope.onmessage = (event: MessageEvent<CoverCellAsk>) => {
    const ask = event.data;
    try {
      const cover = packCover(coverCellOf(rowBuildings(ask, readers), ask.rect));
      scope.postMessage({ id: ask.id, cover } satisfies CoverCellReply, [cover.xy.buffer, cover.starts.buffer, cover.keys.buffer, cover.at.buffer, cover.polygons.buffer] as ArrayBuffer[]);
    } catch (error) {
      console.error('[buildings] a cover cell could not be worked out off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CoverCellReply);
    }
  };
}
