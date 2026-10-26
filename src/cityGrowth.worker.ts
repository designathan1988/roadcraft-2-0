import { type TileGrowth, type TileGrown, assembleCity, growTile } from './editor/cityTiles';
import type { JobScope } from './jobs/jobScope';

/** A CITY'S TILES GROWN ON THE JOB WORKERS, MANY AT ONCE (`editor/cityTiles.ts`, asked by `editor/cityInTiles.ts`): one tile's lots grown, or the tiles' tables joined into the city's. */

export type CityGrowthAsk =
  | { readonly id: number; readonly op: 'grow'; readonly tile: TileGrowth; readonly neighbours: readonly ArrayBufferLike[] }
  | { readonly id: number; readonly op: 'assemble'; readonly lots: ArrayBufferLike | null; readonly grown: readonly TileGrown[] };

export type CityGrowthReply =
  | { readonly id: number; readonly grown: TileGrown }
  | { readonly id: number; readonly buildings: ArrayBufferLike; readonly lots: ArrayBufferLike | null }
  | { readonly id: number; readonly error: string };

/** The plain buffers of a reply, moved, not copied (a table in shared memory is posted as a handle). */
const moved = (...buffers: (ArrayBufferLike | null)[]): ArrayBuffer[] => buffers.filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CityGrowthAsk>) => {
    const ask = event.data;
    try {
      if (ask.op === 'grow') {
        const grown = growTile(ask.tile, ask.neighbours);
        scope.postMessage({ id: ask.id, grown } satisfies CityGrowthReply, moved(grown.buildings, grown.lotBuildings.buffer, grown.edge));
      } else {
        const city = assembleCity(ask.lots, ask.grown);
        scope.postMessage({ id: ask.id, buildings: city.buildings, lots: city.lots } satisfies CityGrowthReply, moved(city.buildings, city.lots));
      }
    } catch (error) {
      console.error('[city] a tile of the city could not be grown', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CityGrowthReply);
    }
  };
}
