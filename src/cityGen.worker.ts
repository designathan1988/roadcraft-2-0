import type { SerializedDoc } from '@world/doc';
import { buildCityTableOf } from './editor/smallCityMap';
import type { JobScope } from './jobs/jobScope';

/** THE CITY MADE OFF THE PAGE (`main.ts` `cityData`): the game's own generator (`buildCityTable`) building a whole finite city in a job worker, so the page is not frozen for its seconds. */

export interface CityGenAsk {
  readonly id: number;
  /** The small city, or the same city made larger (`largeCity.ts`). */
  readonly kind: 'small' | 'large';
  readonly seed?: number;
  /** The large city over another radius, world units (the scale steps); absent, the large city's own. */
  readonly radius?: number;
}

/** `buildings`, `landscape`, `lots`: the city's buildings, landscaping and lots each as one table (`buildCityTable`, as `prepareCity` makes them), its `data` holding none: the page reads them from the tables (`preparedCity`). */
export type CityGenReply = { readonly id: number; readonly data?: SerializedDoc; readonly buildings?: ArrayBufferLike; readonly landscape?: ArrayBufferLike | null; readonly lots?: ArrayBufferLike | null; readonly error?: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CityGenAsk>) => {
    const ask = event.data;
    try {
      // DO NOT grow the whole city as objects and prepare it after (`prepareCity`): `buildCityTable` spills its buildings into tables as they grow.
      const { data, buildings, landscape, lots } = buildCityTableOf(ask.kind, ask.seed ?? 7, ask.radius);
      // The tables moved, not copied, where they are plain buffers (in shared memory they are posted as handles, MDN "SharedArrayBuffer").
      const transfer = [buildings, landscape, lots].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
      scope.postMessage({ id: ask.id, data, buildings, landscape, lots } satisfies CityGenReply, transfer);
    } catch (error) {
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CityGenReply);
    }
  };
}
