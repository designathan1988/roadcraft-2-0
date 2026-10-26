import type { SerializedDoc } from '@world/doc';
import type { CityTables } from './editor/preparedCity';
import { type TileGrowth, tilePackagesOf } from './editor/cityTiles';
import { buildCityTableOf, layoutCityOf } from './editor/smallCityMap';
import type { JobScope } from './jobs/jobScope';

/** THE CITY MADE OFF THE PAGE (`main.ts` `cityData`): the game's own generator (`buildCityTable`) building a whole finite city in a job worker, so the page is not frozen for its seconds; or, asked `layout`, the city laid out and nothing grown (`layoutCityOf`), with what each tile's growth reads (`editor/cityTiles.ts`): its buildings are grown tile by tile on many workers at once (`editor/cityInTiles.ts`). */

export interface CityGenAsk {
  readonly id: number;
  /** The small city, or the same city made larger (`largeCity.ts`). */
  readonly kind: 'small' | 'large';
  readonly seed?: number;
  /** The large city over another radius, world units (the scale steps); absent, the large city's own. */
  readonly radius?: number;
  /** `layout`: the city laid out, its buildings left to the tiles' growth; absent: the whole city grown here. */
  readonly stage?: 'layout';
}

/** `buildings` and the other kinds' (`CityTables`): the city's buildings, landscaping, lots, poles and wires each as one table (`buildCityTable`, as `prepareCity` makes them), its `data` holding none: the page reads them from the tables (`preparedCity`). `tiles`: asked `layout`, what each tile's growth reads (no `buildings` then). */
export type CityGenReply = { readonly id: number; readonly data?: SerializedDoc; readonly buildings?: ArrayBufferLike; readonly tiles?: readonly TileGrowth[]; readonly error?: string } & Partial<CityTables>;

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CityGenAsk>) => {
    const ask = event.data;
    try {
      if (ask.stage === 'layout') {
        const doc = layoutCityOf(ask.kind, ask.seed ?? 7, ask.radius);
        const data = doc.toJSONTablesApart();
        const beside = { landscape: doc.tableOf('landscape'), lots: doc.tableOf('lots'), poles: doc.tableOf('poles'), spans: doc.tableOf('spans') };
        const tiles = tilePackagesOf(doc);
        const transfer = Object.values(beside).filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
        scope.postMessage({ id: ask.id, data, tiles, ...beside } satisfies CityGenReply, transfer);
        return;
      }
      // DO NOT grow the whole city as objects and prepare it after (`prepareCity`): `buildCityTable` spills its buildings into tables as they grow.
      const { data, buildings, ...beside } = buildCityTableOf(ask.kind, ask.seed ?? 7, ask.radius);
      // The tables moved, not copied, where they are plain buffers (in shared memory they are posted as handles, MDN "SharedArrayBuffer").
      const transfer = [buildings, ...Object.values(beside)].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
      scope.postMessage({ id: ask.id, data, buildings, ...beside } satisfies CityGenReply, transfer);
    } catch (error) {
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CityGenReply);
    }
  };
}
