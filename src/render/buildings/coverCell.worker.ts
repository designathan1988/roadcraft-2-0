import type { ChangeRect } from '@world/changes';
import { tableRecords } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import type { JobScope } from '../../jobs/jobScope';
import { type PackedCover, coverCellOf, packCover } from './layerCells';

/** A CELL OF THE BUILDINGS' COVER WORKED OUT OFF THE PAGE (`coverJobs.ts`): the buildings near it as rows of a table of their own, their footprints filed by bucket (`coverCellOf`), the cell's numbers handed back. */

export interface CoverCellAsk { readonly id: number; readonly rect: ChangeRect; readonly table: ArrayBuffer | null }
export type CoverCellReply = { readonly id: number; readonly cover: PackedCover } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CoverCellAsk>) => {
    const { id, rect, table } = event.data;
    try {
      const cover = packCover(coverCellOf(table ? tableRecords<Building>(table) : [], rect));
      scope.postMessage({ id, cover } satisfies CoverCellReply, [cover.xy.buffer, cover.starts.buffer, cover.keys.buffer, cover.at.buffer, cover.polygons.buffer] as ArrayBuffer[]);
    } catch (error) {
      console.error('[buildings] a cover cell could not be worked out off the page', error);
      scope.postMessage({ id, error: String((error as Error)?.stack ?? error) } satisfies CoverCellReply);
    }
  };
}
