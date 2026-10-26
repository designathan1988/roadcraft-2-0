import type { JobScope } from '../jobs/jobScope';
import type { FarLevel } from './networkFarInput';
import { type FarTileAsk, farTileOf } from './networkFarTile';

/** A TILE'S ROADS AT THE FAR LEVEL MADE OFF THE PAGE (`networkFarTile.ts`): stateless, nothing kept between asks. */

export interface FarTileMessage extends FarTileAsk { readonly id: number }
export type FarTileReply = { readonly id: number; readonly level?: FarLevel; readonly error?: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<FarTileMessage>) => {
    const ask = event.data;
    try {
      const { level, transfer } = farTileOf(ask);
      scope.postMessage({ id: ask.id, level } satisfies FarTileReply, transfer);
    } catch (error) {
      // Said on the worker's console; the page makes the tile's cells from its own network when it holds them (`NetworkFarRoads.refresh`).
      console.error('[roads] a tile of the far roads could not be made off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies FarTileReply);
    }
  };
}
