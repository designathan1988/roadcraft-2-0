import { type RepairStep, repairNearConnections } from '@editor/repair';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { Network } from '@world/network';
import type { JobScope } from './jobs/jobScope';

/**
 * A LEGACY MAP'S REPAIRS FOUND OFF THE PAGE (`editor/offPageNetwork.ts` mapRepairsOffPage, `editor/repair.ts`: a dead end that visibly ends
 * inside another road): the document's roads opened here as the page opens them (`editor/history.ts` restoreInto), its network built whole
 * here, the repairs made as steps the page plays again (`replayRepairs`). The page's network holds the tiles near the view alone
 * (`world/networkWindow.ts`), the map's far level is made tile by tile (`render/networkFarTile.ts`): nothing else of the whole network is
 * asked of this job, and no opening waits for it. DO NOT solve a map's whole network for its far level or its opening tiles here again: a
 * 10 km city's opening waited on this one job and drew no road past its view (2026-10-26).
 */

export interface MapRepairAsk {
  readonly id: number;
  /** The document's roads as the page restores it. */
  readonly data: SerializedDoc;
}

export type MapRepairReply = { readonly id: number; readonly repairs?: readonly RepairStep[]; readonly error?: string };

/** The repairs `data`'s roads need, as steps. */
export function repairsOf(data: SerializedDoc): RepairStep[] {
  const doc = new RoadDoc();
  doc.replaceFromJSON(data, { repair: true, whole: true });
  const net = new Network(doc);
  net.rebuild({ full: true });
  const repairs: RepairStep[] = [];
  repairNearConnections(doc, net, repairs);
  return repairs;
}

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<MapRepairAsk>) => {
    const ask = event.data;
    try {
      scope.postMessage({ id: ask.id, repairs: repairsOf(ask.data) } satisfies MapRepairReply);
    } catch (error) {
      // Said on the worker's console; the map opens unrepaired (`main.ts` repairOffPage).
      console.error('[networkBake] the map\'s repairs could not be found off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies MapRepairReply);
    }
  };
}
