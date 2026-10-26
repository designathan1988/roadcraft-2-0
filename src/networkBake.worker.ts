import { type RepairStep, repairNearConnections } from '@editor/repair';
import { type FarLevel, farLevelOf } from '@render/networkFarInput';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { Network, type NetworkBake } from '@world/network';
import { roadsOfTiles } from '@world/networkWindow';
import type { JobScope } from './jobs/jobScope';

/**
 * A MAP'S WHOLE NETWORK SOLVED OFF THE PAGE (`main.ts` openCityNow, `render/networkFarRoads.ts` requestWhole): the document's roads opened
 * here as the page opens them (`editor/history.ts` restoreInto), the network built whole, and from it what the page needs of the whole map
 * and never holds itself (`world/networkWindow.ts`: the page's network holds the tiles near the view alone):
 * - the far level of every road and junction (`networkFarInput.ts` farLevelOf: the roads' root level, drawn where no cell is built in detail);
 * - the junctions and ribbons of the tiles a map opens with (`Network.exportBake`, taken by the page's build where the inputs are the same);
 * - a legacy map's repairs (`editor/repair.ts`: a dead end that visibly ends inside another road), as steps the page plays again.
 * DO NOT solve a large city's every junction on the page: 1.6 s of its opening blocked in `Network.rebuild` for the city of 70,000 buildings
 * (2026-10-22); and DO NOT send a whole map's junctions to the page: it held them for good.
 */

export interface NetworkSolveAsk {
  readonly id: number;
  /** The document as the page restores it (its roads, the land, the paint's standard; the buildings apart). */
  readonly data: SerializedDoc;
  /** Whether the page restores it repaired (`restoreInto`: not a generated city). */
  readonly repair: boolean;
  /** The far level's cells' side (`renderer.ts` FAR_ROAD_CELL). */
  readonly cell: number;
  /** The tiles the map opens with (`world/tiles.ts` keys): their junctions and ribbons go back solved; none, no bake. */
  readonly openingTiles: readonly number[];
}

export interface NetworkSolved {
  readonly far: FarLevel;
  readonly bake: NetworkBake | null;
  readonly repairs: readonly RepairStep[];
}

export type NetworkSolveReply = { readonly id: number; readonly solved?: NetworkSolved; readonly error?: string };

/** The network of `ask`'s document solved whole: its far level, the opening tiles' bake, the repairs made. */
export function solveMap(ask: Omit<NetworkSolveAsk, 'id'>): { solved: NetworkSolved; transfer: ArrayBuffer[] } {
  const doc = new RoadDoc();
  doc.replaceFromJSON(ask.data, { repair: ask.repair, whole: true });
  const net = new Network(doc);
  net.rebuild({ full: true });
  const repairs: RepairStep[] = [];
  if (ask.repair) repairNearConnections(doc, net, repairs);
  const { level, transfer } = farLevelOf(net, ask.cell);
  let bake: NetworkBake | null = null;
  if (ask.openingTiles.length) {
    const roads = roadsOfTiles(doc, ask.openingTiles);
    const nodes = new Set<NodeId>();
    for (const id of roads) { const seg = doc.segment(id)!; nodes.add(seg.a); nodes.add(seg.b); }
    bake = net.exportBake([...nodes].filter((id) => net.complete(id)).sort((p, q) => p - q), [...roads].sort((p, q) => p - q));
  }
  return { solved: { far: level, bake, repairs }, transfer };
}

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<NetworkSolveAsk>) => {
    const ask = event.data;
    try {
      const { solved, transfer } = solveMap(ask);
      scope.postMessage({ id: ask.id, solved } satisfies NetworkSolveReply, transfer);
    } catch (error) {
      // Said on the worker's console; the page makes what it can itself (`main.ts` mapSolvedOffPage).
      console.error('[networkBake] the network could not be solved off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies NetworkSolveReply);
    }
  };
}
