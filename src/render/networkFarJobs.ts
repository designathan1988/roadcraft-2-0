import type { RoadDoc } from '@world/doc';
import { METERS_PER_UNIT } from '@world/units';
import { canQueueJobs, submitJob } from '../jobs/jobPool';
import type { FarLevel } from './networkFarInput';
import type { FarTileSource } from './networkFarRoads';
import { farTileAsk } from './networkFarTile';
import type { FarTileMessage, FarTileReply } from './networkFarTile.worker';

/** THE MAP'S FAR LEVEL ASKED OF THE JOB THREADS, A TILE A JOB (`networkFarTile.ts`): the source of `NetworkFarRoads.requestWhole`. The queue matches each answer to its job (`submitJob` seq): an ask's own id is not read. */
const UNNUMBERED = 0;

/** A tile's far level made off the page, nearest the view first (`at`); null without a job queue (the level is then made on the page from its network). */
export function farTileSource(): FarTileSource | null {
  if (!canQueueJobs()) return null;
  return (doc: RoadDoc, tile: number, cell: number, at: readonly [number, number]) => new Promise<FarLevel | null>((done) => {
    submitJob({
      service: 'roadFarTile', key: null, priority: 0, at, crosses: true,
      // Its records read when a thread takes it (the tiles of a map asked at once, read one by one as the threads free): a tile of the map's
      // roads has its own (`RoadDoc.roadTileKeys`); one emptied since is asked of nothing, its cells left out.
      write: () => {
        const ask = farTileAsk(doc, tile, cell) ?? { tile, cell, data: { version: 1, unit: METERS_PER_UNIT, nodes: [], segments: [], terrain: [], poles: [], poleSpans: [] }, scope: [] };
        return { data: { id: UNNUMBERED, ...ask } satisfies FarTileMessage, transfer: [] };
      },
      done: (answer) => {
        const reply = answer as FarTileReply;
        if (!reply.level) console.error(`[roads] the far roads of tile ${tile} were not made off the page`, reply.error);
        done(reply.level ?? null);
      },
      failed: (message) => { console.error(`[roads] the far roads of tile ${tile} were not made off the page`, message); done(null); },
    });
  });
}
