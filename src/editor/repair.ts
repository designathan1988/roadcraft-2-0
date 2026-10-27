import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { casingHalf } from '@world/roadTypes';
import { roadStructure } from '@world/structures';
import { splitSegment } from './commit';
import { ribbonsNear } from './snap';
import { m } from '@world/units';

interface Candidate {
  readonly node: NodeId;
  readonly segment: SegmentId;
  readonly s: number;
  readonly at: { readonly x: number; readonly y: number };
  readonly distance: number;
}

/** One repair as made (`repairNearConnections`): the dead end, the road it was joined into at `s` along it, where; played again on another copy of the same map (`replayRepairs`). */
export interface RepairStep {
  readonly node: NodeId;
  readonly segment: SegmentId;
  readonly s: number;
  readonly at: Vec2;
}

/** Repairs a legacy endpoint that visibly ends inside another road but was saved as a disconnected node; `steps`, given, takes each repair made. */
export function repairNearConnections(doc: RoadDoc, net: Network, steps?: RepairStep[]): number {
  let repaired = 0;
  const rejected = new Set<string>();

  // Every split changes segment ids and cached polylines.
  for (let attempt = 0; attempt < 64; attempt++) {
    net.rebuild();
    const candidate = nearestCandidate(doc, net, rejected);
    if (!candidate) break;
    const junction = splitSegment(doc, net, candidate.segment, candidate.s, candidate.at);
    if (junction === null || !doc.mergeNodes(junction, candidate.node)) {
      rejected.add(`${candidate.node}:${candidate.segment}`);
      continue;
    }
    repaired++;
    steps?.push({ node: candidate.node, segment: candidate.segment, s: candidate.s, at: { x: candidate.at.x, y: candidate.at.y } });
  }
  if (repaired) net.rebuild();
  return repaired;
}

/** How far a step's place may lie off the road it names and still be that road's (the ids of a map edited meanwhile may name another). */
const REPLAY_EPS = m(0.05);

/**
 * THE REPAIRS MADE OFF THE PAGE PLAYED AGAIN HERE (`networkBake.worker.ts`: the whole map's network solved there finds every dead end; the
 * page's network holds the tiles near the view alone, `world/networkWindow.ts`): each step on the same map allocates the same ids, so a
 * later step's road is the one the worker split; a step whose dead end or road is not as it was (an edit meanwhile) is left out. How many were made.
 */
export function replayRepairs(doc: RoadDoc, net: Network, steps: readonly RepairStep[]): number {
  let repaired = 0;
  for (const step of steps) {
    net.rebuild();
    const node = doc.node(step.node);
    const segment = doc.segment(step.segment);
    if (!node || node.incident.length !== 1 || !segment || segment.a === step.node || segment.b === step.node) continue;
    const hit = net.polylines.get(doc, step.segment).closestPoint(step.at);
    if (hit.distance > REPLAY_EPS || Math.abs(hit.s - step.s) > REPLAY_EPS) continue;
    const junction = splitSegment(doc, net, step.segment, step.s, step.at);
    if (junction === null || !doc.mergeNodes(junction, step.node)) continue;
    repaired++;
  }
  if (repaired) net.rebuild();
  return repaired;
}

function nearestCandidate(doc: RoadDoc, net: Network, rejected: ReadonlySet<string>): Candidate | null {
  let best: Candidate | null = null;
  // @rebuild Walks the whole map: a legacy map's repair, worked out once off the page.
  for (const node of doc.nodes.values()) {
    if (node.incident.length !== 1) continue;
    const sourceId = node.incident[0];
    if (sourceId === undefined) continue;
    const source = doc.segment(sourceId);
    if (!source) continue;

    // DO NOT walk `doc.segments` for every dead end (dead ends × roads, at every load).
    for (const ribbon of ribbonsNear(net, [node.x, node.y, node.x, node.y])) {
      const targetId = ribbon.id;
      const target = doc.segment(targetId);
      if (!target) continue;
      if (targetId === sourceId || target.a === node.id || target.b === node.id) continue;
      if (target.structure !== source.structure) continue;
      if (rejected.has(`${node.id}:${targetId}`)) continue;
      const line = net.polylines.get(doc, targetId);
      const hit = line.closestPoint({ x: node.x, y: node.y });
      const t = hit.s / Math.max(1e-6, line.length);
      const targetOffset = (doc.node(target.a)?.heightOffset ?? 0) * (1 - t) +
        (doc.node(target.b)?.heightOffset ?? 0) * t +
        roadStructure(target.structure).clearance;
      const sourceOffset = node.heightOffset + roadStructure(source.structure).clearance;
      if (Math.abs(sourceOffset - targetOffset) > m(0.3)) continue;
      // The ribbon's own profile, made from this segment (`makeRibbon`).
      const reach = casingHalf(ribbon.road);
      if (hit.distance > reach || (best && hit.distance >= best.distance)) continue;
      best = { node: node.id, segment: targetId, s: hit.s, at: hit.point, distance: hit.distance };
    }
  }
  return best;
}
