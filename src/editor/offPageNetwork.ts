import type { Vec2 } from '@core/vec2';
import type { SerializedDoc } from '@world/doc';
import { type RoadBakeAsk, type RoadBakeSource, tilesMeeting } from '@world/networkWindow';
import { m } from '@world/units';
import { canQueueJobs, submitJob } from '../jobs/jobPool';
import type { NetworkSolveAsk, NetworkSolveReply, NetworkSolved } from '../networkBake.worker';
import type { RoadBakeMessage, RoadBakeReply } from '../roadBake.worker';

/** THE NETWORK'S WORK OFF THE PAGE, AS THE PAGE ASKS IT (`jobs/jobPool.ts`): a map's whole network solved once (`networkBake.worker.ts`), a tile's junctions as the view comes to it (`roadBake.worker.ts`). The queue matches each answer to its job (`submitJob` seq): an ask's own id is not read. */
const UNNUMBERED = 0;

/** A map's whole network solved off the page: its far level, the opening tiles' bake, a legacy map's repairs; null without a job queue (a test) or when the worker failed (the page then makes what it can itself). */
export function mapSolvedOffPage(data: SerializedDoc, repair: boolean, cell: number, openingTiles: readonly number[]): Promise<NetworkSolved | null> {
  if (!canQueueJobs()) return Promise.resolve(null);
  return new Promise((done) => {
    submitJob({
      service: 'networkBake', key: 'networkBake', priority: 0,
      // The document's roads are all it reads: fit for a desktop job process.
      crosses: true,
      write: () => ({ data: { id: UNNUMBERED, data, repair, cell, openingTiles } satisfies NetworkSolveAsk, transfer: [] }),
      done: (answer) => {
        const reply = answer as NetworkSolveReply;
        if (!reply.solved) console.warn('[city] the network was not solved off the page', reply.error);
        done(reply.solved ?? null);
      },
      failed: (message) => { console.warn('[city] the network was not solved off the page', message); done(null); },
    });
  });
}

/** A tile's junctions and ribbons solved off the page as the view comes to it (`world/networkWindow.ts`); null without a job queue: the page solves them itself. */
export function roadBakeSource(): RoadBakeSource | null {
  if (!canQueueJobs()) return null;
  return (ask: RoadBakeAsk) => new Promise((done) => {
    submitJob({
      service: 'roadBake', key: null, priority: 0, at: ask.at, crosses: true,
      write: () => ({ data: { id: UNNUMBERED, ...ask } satisfies RoadBakeMessage, transfer: [] }),
      done: (answer) => done((answer as RoadBakeReply).bake ?? null),
      failed: (message) => { console.warn('[roads] a tile was not solved off the page; solved here', message); done(null); },
    });
  });
}

/** How far round the view's centre a large map's opening holds its roads: the opening's square (`renderer.ts` openingHalf) and the margin its solve takes (`OPENING_SOLVE_MARGIN`). */
const LARGE_OPENING_REACH = m(700) + m(320);
/** And any other map's: the view's want reach of road cells (`renderer.ts` ROAD_WANT_REACH). */
const OPENING_REACH = m(2_500);

/** The tiles a map opens with (`NetworkWindow.open`): those within the opening's reach of its centre (`centre`, or the middle of its roads: where its view is fitted), within the roads' extent. */
export function openingTilesOf(nodes: readonly { readonly x: number; readonly y: number }[], large: boolean, centre?: Vec2): Set<number> {
  if (!nodes.length) return new Set();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  const c = centre ?? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const half = large ? LARGE_OPENING_REACH : OPENING_REACH;
  return tilesMeeting([Math.max(minX, c.x - half), Math.max(minY, c.y - half), Math.min(maxX, c.x + half), Math.min(maxY, c.y + half)]);
}
