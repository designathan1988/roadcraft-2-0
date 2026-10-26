import { submitJob } from '../jobs/jobPool';
import type { JobService } from '../jobs/jobScope';
import type { CityGenAsk, CityGenReply } from '../cityGen.worker';
import type { CityGrowthAsk, CityGrowthReply } from '../cityGrowth.worker';
import { type TileGrown, tilesTouch } from './cityTiles';

/**
 * A NEW CITY MADE ON MANY JOB WORKERS AT ONCE (`editor/cityTiles.ts`): laid out by one (`cityGen.worker.ts` asked `layout`: streets, lots,
 * green, zones), its tiles' lots grown by as many as the pool has (`cityGrowth.worker.ts`), the four phases of the tiles' checkerboard one
 * after the other, each tile handed the edge buildings of the tiles round it grown before it, then the tiles' tables joined by one. The
 * answer is the city as the one-job generator answered it (`CityGenReply`: its data and every kind's table). DO NOT grow a city's every
 * building on one thread: a 10 km city's 249,000 grew one by one for some four minutes in one worker (2026-10-26).
 */

/** One job of the pool, its answer or its failure. */
function job<A, R>(service: JobService, ask: A, priority: number, key: string | null, at?: readonly [number, number]): Promise<R> {
  return new Promise((done, fail) => {
    submitJob({
      service, key, priority, crosses: true, ...(at ? { at } : {}),
      write: () => ({ data: ask, transfer: [] }),
      done: (answer) => done(answer as R),
      failed: (message) => fail(new Error(message)),
    });
  });
}

/** The pool matches each answer to its job (`submitJob`'s own number): an ask's id is not read. */
const UNNUMBERED = 0;

/** The city of `ask` made on many workers (see the file's comment); `phase`: told as each step ends, with what it did. */
export async function growCityInTiles(ask: CityGenAsk, priority: number, key: string | null, phase?: (step: string, detail: string) => void): Promise<CityGenReply> {
  const layout = await job<CityGenAsk, CityGenReply>('cityGen', { ...ask, stage: 'layout' }, priority, key ? `${key}:layout` : 'cityGen');
  if (!layout.data || !layout.tiles) throw new Error(layout.error ?? 'the city was not laid out');
  phase?.('layout', `${layout.tiles.length} tiles to grow`);
  const grown: TileGrown[] = [];
  for (let p = 0; p < 4; p++) {
    const tiles = layout.tiles.filter((tile) => tile.phase === p);
    const before = [...grown];
    const answers = await Promise.all(tiles.map((tile) => {
      const neighbours = before.filter((other) => tilesTouch(tile.key, other.key)).map((other) => other.edge);
      return job<CityGrowthAsk, CityGrowthReply>('cityGrowth', { id: UNNUMBERED, op: 'grow', tile, neighbours }, priority, null);
    }));
    for (const answer of answers) {
      if ('error' in answer) throw new Error(answer.error);
      if (!('grown' in answer)) throw new Error('a tile came back with no growth');
      grown.push(answer.grown);
    }
    phase?.(`phase ${p + 1}`, `${tiles.length} tiles`);
  }
  const city = await job<CityGrowthAsk, CityGrowthReply>('cityGrowth', { id: UNNUMBERED, op: 'assemble', lots: layout.lots ?? null, grown }, priority, null);
  if ('error' in city) throw new Error(city.error);
  if (!('buildings' in city)) throw new Error('the city came back with no buildings');
  phase?.('assembled', '');
  return { id: ask.id, data: layout.data, buildings: city.buildings, landscape: layout.landscape ?? null, lots: city.lots, poles: layout.poles ?? null, spans: layout.spans ?? null };
}
