import { RoadDoc } from '@world/doc';
import { Network, type NetworkBake } from '@world/network';
import type { RoadBakeAsk } from '@world/networkWindow';
import { METERS_PER_UNIT } from '@world/units';
import type { JobScope } from './jobs/jobScope';

/**
 * A TILE'S JUNCTIONS AND RIBBONS SOLVED OFF THE PAGE AS THE VIEW COMES TO IT (`world/networkWindow.ts`): a document of the tile's roads and
 * those at their ends alone (`RoadBakeAsk`), its network holding them (`Network.scope`), the junctions of the tile's nodes and the ribbons
 * exported as solved (`Network.exportBake`); the page's build takes each whose inputs are the same (`NetworkBuild.takeBakes`). A node's
 * junction is solved from its record, its roads' and where their far ends stand (`nodeBakeKey`), all of which are here: the tile's junctions
 * are the whole network's (`tests/world/roadBake.spec.ts`). Nothing kept between asks.
 */

export interface RoadBakeMessage extends RoadBakeAsk { readonly id: number }
export type RoadBakeReply = { readonly id: number; readonly bake?: NetworkBake; readonly error?: string };

/** The junctions and ribbons asked, solved from the records given. */
export function bakeRoads(ask: RoadBakeAsk): NetworkBake {
  const doc = RoadDoc.fromJSON({ version: 1, unit: METERS_PER_UNIT, nodes: ask.nodes, segments: ask.segments, terrain: [], poles: [], poleSpans: [], markingStyle: ask.markingStyle }, { repair: false });
  const net = new Network(doc);
  net.scope = new Set(ask.scope);
  net.rebuild({ full: true });
  return net.exportBake(ask.bakeNodes, ask.bakeSegments);
}

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<RoadBakeMessage>) => {
    const ask = event.data;
    try {
      scope.postMessage({ id: ask.id, bake: bakeRoads(ask) } satisfies RoadBakeReply);
    } catch (error) {
      // Said on the worker's console; the page solves the tile itself (`world/networkWindow.ts`).
      console.error('[roadBake] a tile could not be solved off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies RoadBakeReply);
    }
  };
}
