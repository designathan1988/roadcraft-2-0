import type { ChangeRect } from '@world/changes';
import type { TableReader } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import type { JobScope } from '../jobs/jobScope';
import { type BuildingRows, rowBuildings } from './buildings/rowRefs';
import { gardenPacksOf } from './gardenPlace';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';

/** THE GARDENS ABOUT A RECTANGLE PLACED OFF THE PAGE (`gardens.ts` gardenJobAsk): the buildings standing about it read where the map's table holds
 *  them (`rowRefs.ts`), the ground read off the shared plates as the page reads it (`sharedGround.ts`), their plants placed (`gardenPlace.ts`) and
 *  handed back by kind. */

export interface GardenCellAsk extends BuildingRows {
  readonly id: number;
  readonly rect: ChangeRect;
  readonly ground: SharedGroundData;
}
/** A kind's plants: its poses (`YAW_POSE`), tints (null: none) and largest scales. */
export interface PackedPlants { readonly kind: number; readonly data: Float32Array; readonly colours: Float32Array | null; readonly scales: Float32Array; readonly count: number }
export type GardenCellReply = { readonly id: number; readonly packs: readonly PackedPlants[] } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  /** The map's tables read by this thread, by their buffer (the same memory as the page's). */
  const readers = new WeakMap<ArrayBufferLike, TableReader<Building>>();
  scope.onmessage = (event: MessageEvent<GardenCellAsk>) => {
    const ask = event.data;
    try {
      const { groundAt } = sharedGroundReaders(ask.ground);
      const packs: PackedPlants[] = [];
      const transfer: ArrayBuffer[] = [];
      for (const [kind, pack] of gardenPacksOf(rowBuildings(ask, readers), groundAt)) {
        packs.push({ kind, ...pack });
        transfer.push(pack.data.buffer as ArrayBuffer, pack.scales.buffer as ArrayBuffer);
        if (pack.colours) transfer.push(pack.colours.buffer as ArrayBuffer);
      }
      scope.postMessage({ id: ask.id, packs } satisfies GardenCellReply, transfer);
    } catch (error) {
      console.error('[gardens] a rectangle\'s gardens could not be placed off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies GardenCellReply);
    }
  };
}
