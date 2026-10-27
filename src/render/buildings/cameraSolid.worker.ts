import type { TableReader } from '@world/buildings/recordTable';
import { solidRowsOf } from '@world/buildings/cameraSolids';
import { floorHeight } from '@world/buildings/foundation';
import type { Building } from '@world/buildings/types';
import { type PavingData, pavingReader } from '@world/paving';
import type { JobScope } from '../../jobs/jobScope';
import { type SharedGroundData, sharedGroundReaders } from '../sharedGround';
import { type BuildingRows, rowBuildings } from './rowRefs';

/** THE CAMERA'S SOLIDS OF SOME BUILDINGS WORKED OUT OFF THE PAGE (`solidJobs.ts`): each read where the map's table holds it (`rowRefs.ts`), its
 *  solid volumes handed back as numbers on no floor (`solidRowsOf`) and, with the ground and paving the cells' jobs read handed over
 *  (`floors`), its floor measured here as the page measures it (`floors.ts`, `floorHeight` on the natural ground and the paving); a building
 *  whose floor read past what was handed comes back with none, the page standing it on the floor it knows. */

export interface CameraSolidAsk extends BuildingRows {
  readonly id: number;
  /** The ground and paving to measure the floors on (`BuildingLayer.jobGround`); absent: none measured here. */
  readonly floors?: { readonly ground: SharedGroundData; readonly naturalIsGround: boolean; readonly paving?: PavingData };
}
/** A building's solid volumes on no floor, whether its blocks are its volumes (the floor the cells' jobs measure is its floor), and its floor measured here. */
export interface SolidAnswer { readonly id: number; readonly rows: Float64Array; readonly blocksAreVolumes: boolean; readonly floor?: number }
export type CameraSolidReply = { readonly id: number; readonly buildings: readonly SolidAnswer[] } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  /** The map's tables read by this thread, by their buffer (the same memory as the page's). */
  const readers = new WeakMap<ArrayBufferLike, TableReader<Building>>();
  scope.onmessage = (event: MessageEvent<CameraSolidAsk>) => {
    const ask = event.data;
    try {
      // A read past the ground's plates or the paving handed over: that building's floor is not measured here.
      let missed = false;
      const reads = ask.floors ? sharedGroundReaders(ask.floors.ground, () => { missed = true; }) : null;
      const naturalAt = reads && ask.floors ? (ask.floors.naturalIsGround ? reads.groundAt : reads.naturalAt) : null;
      const pavedHere = ask.floors?.paving && naturalAt ? pavingReader(ask.floors.paving, naturalAt) : null;
      const pavedAt = pavedHere ? (x: number, y: number): number => { const v = pavedHere(x, y); if (v === undefined) { missed = true; return NaN; } return v; } : undefined;
      const buildings: SolidAnswer[] = [];
      const transfer: ArrayBuffer[] = [];
      for (const b of rowBuildings(ask, readers)) {
        const { rows, blocksAreVolumes } = solidRowsOf(b);
        let floor: number | undefined;
        if (naturalAt) {
          missed = false;
          const measured = floorHeight(b, naturalAt, pavedAt);
          if (!missed && Number.isFinite(measured)) floor = measured;
        }
        buildings.push({ id: b.id, rows, blocksAreVolumes, ...(floor !== undefined ? { floor } : {}) });
        transfer.push(rows.buffer as ArrayBuffer);
      }
      scope.postMessage({ id: ask.id, buildings } satisfies CameraSolidReply, transfer);
    } catch (error) {
      console.error('[buildings] the camera\'s solids could not be worked out off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CameraSolidReply);
    }
  };
}
