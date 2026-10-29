import type { TableReader } from '@world/buildings/recordTable';
import { solidRowsOf } from '@world/buildings/cameraSolids';
import type { Building } from '@world/buildings/types';
import type { JobScope } from '../../jobs/jobScope';
import { type BuildingRows, rowBuildings } from './rowRefs';

/** THE CAMERA'S SOLIDS OF SOME BUILDINGS WORKED OUT OFF THE PAGE (`solidJobs.ts`): each read where the map's table holds it (`rowRefs.ts`), its
 *  solid volumes handed back as numbers on no floor (`solidRowsOf`), the page standing them on the floor it knows. */

export interface CameraSolidAsk extends BuildingRows {
  readonly id: number;
}
/** A building's solid volumes on no floor, and whether its blocks are its volumes (the floor the cells' jobs measure is its floor). */
export interface SolidAnswer { readonly id: number; readonly rows: Float64Array; readonly blocksAreVolumes: boolean }
export type CameraSolidReply = { readonly id: number; readonly buildings: readonly SolidAnswer[] } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  /** The map's tables read by this thread, by their buffer (the same memory as the page's). */
  const readers = new WeakMap<ArrayBufferLike, TableReader<Building>>();
  scope.onmessage = (event: MessageEvent<CameraSolidAsk>) => {
    const ask = event.data;
    try {
      const buildings: SolidAnswer[] = [];
      const transfer: ArrayBuffer[] = [];
      for (const b of rowBuildings(ask, readers)) {
        const { rows, blocksAreVolumes } = solidRowsOf(b);
        buildings.push({ id: b.id, rows, blocksAreVolumes });
        transfer.push(rows.buffer as ArrayBuffer);
      }
      scope.postMessage({ id: ask.id, buildings } satisfies CameraSolidReply, transfer);
    } catch (error) {
      console.error('[buildings] the camera\'s solids could not be worked out off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CameraSolidReply);
    }
  };
}
