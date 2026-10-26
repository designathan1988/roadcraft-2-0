import { Digest } from '@core/digest';
import { Polyline } from '@core/polyline';
import type { RoadDoc, RoadNode, RoadSegment } from './doc';
import type { NodeId, SegmentId } from './ids';
import { JUNCTION_KIT } from './junction/derive';
import { JunctionLevels, type JunctionLevelsData } from './junction/levels';
import { trimSummary } from './junction/trimSummary';
import type { ChangeRect } from './changes';
import { type SegmentRibbon, type SegmentTrims, leanRibbon } from './ribbons';

/** THE NETWORK'S PIECES AS DATA BETWEEN THREADS (`networkBuild.ts`): a node's solved passes and a road's ribbon with the keys of what they were solved from (`nodeBakeKey`, `segmentSourceKey`), taken by another thread's build where its inputs are the same; and the keys the build records its sources by. */

/**
 * A junction solved for one pass, with what the pass handed it (`junctionKey`), the plate it reaches, how many levels it has and what
 * the reconciling of its roads reads of it (`trimSummary`). A pass's junction a later pass solved again is let go once the rebuild
 * is over (`byLevel` null: DO NOT keep two or three whole junctions a pressured node, ~two thirds of the junctions' memory,
 * 2026-10-22): its summary and plate are all the next rebuilds read of it, and it is solved again should a node fall back to it (`levels3`).
 */
export interface MemoEntry {
  readonly key: number;
  readonly byLevel: JunctionLevels | null;
  readonly size: number;
  readonly plate: readonly (readonly [SegmentId, number])[];
  readonly summary: readonly number[];
}

export function memoEntry(key: number, byLevel: JunctionLevels, plate: MemoEntry['plate']): MemoEntry {
  return { key, byLevel, size: byLevel.size, plate, summary: trimSummary(byLevel) };
}

/** A TILE'S JUNCTIONS AND RIBBONS SOLVED OFF THE PAGE (`editor/tileStore.ts` prepareTile, the save worker or the generator's): each node's passes with the key of what they were solved from (`nodeBakeKey`), each road's ribbon with what it was made from; the page's build takes them where its inputs are the same (`takeBakes`) and solves only the nodes with a road of a tile not here. Plain data and typed arrays, cloned by the message. */
export interface NetworkBake {
  readonly nodes: BakedNode[];
  readonly segments: BakedSegment[];
}
interface BakedNode {
  readonly id: NodeId;
  readonly key: number;
  readonly j1: BakedMemo | null;
  readonly j2: BakedMemo | null;
  readonly j3: BakedMemo | null;
}
/** A pass's junctions as their data (`JunctionLevels.data`: the carriageway, the frames its outer levels are made from, what is kept whole; null: let go, `MemoEntry`). */
interface BakedMemo { readonly key: number; readonly levels: JunctionLevelsData | null; readonly size: number; readonly plate: MemoEntry['plate']; readonly summary: readonly number[] }
/** A ribbon as what it is made from (`ribbons.ts` LeanRibbon): its road, its whole centreline as its flat array (`Polyline.xy`) and its box; its levels made on the thread that reads them (`ribbonFromBake`). */
type BakedRibbon = Pick<SegmentRibbon, 'id' | 'typeIndex' | 'direction' | 'road' | 'dashOrigin'> & {
  readonly full: Float64Array; readonly bounds: ChangeRect;
};

export function memoData(entry: MemoEntry | undefined): BakedMemo | null {
  if (!entry) return null;
  return { key: entry.key, levels: entry.byLevel ? entry.byLevel.data() : null, size: entry.size, plate: entry.plate, summary: entry.summary };
}

export function memoOf(baked: BakedMemo): MemoEntry {
  return { key: baked.key, byLevel: baked.levels ? JunctionLevels.fromData(baked.levels, JUNCTION_KIT) : null, size: baked.size, plate: baked.plate, summary: baked.summary };
}
interface BakedSegment {
  readonly id: SegmentId;
  /** `segmentSourceKey` of the road the ribbon was made from. */
  readonly source: number;
  readonly trims: SegmentTrims;
  readonly bendA: number;
  readonly bendB: number;
  readonly ribbon: BakedRibbon;
}

export function ribbonFromBake(s: BakedSegment): SegmentRibbon {
  const r = s.ribbon;
  return leanRibbon(r.id, r.typeIndex, r.direction, r.road, r.dashOrigin, Polyline.fromFlat(r.full), s.trims, s.bendA, s.bendB, r.bounds);
}

/** What a node's junctions are solved from, whichever thread solves them: its record and its roads' (where their ends stand too), the roads in id order (a road of a tile not on that thread changes it: the page then solves the node itself). */
export function nodeBakeKey(doc: RoadDoc, n: RoadNode): number {
  const incident = n.incident.slice().sort((p, q) => p - q);
  const digest = nodeSourceDigest({ ...n, incident });
  for (const id of incident) {
    const s = doc.segment(id);
    digest.add(s ? segmentSourceKey(doc, s) : NaN);
  }
  return digest.value();
}

// DO NOT keep a road's or a node's inputs as JSON text: a number per record (`Digest`), not a string per record of the map.
/** Everything a segment's polyline, ribbon and junction legs are built from: its record and where its two ends stand. */
export function segmentSourceKey(doc: RoadDoc, s: RoadSegment): number {
  const a = doc.node(s.a), b = doc.node(s.b);
  return new Digest().add(s.a).add(s.b).add(s.type).addPlain(s.curve ? [s.curve.t, s.curve.h] : null).add(s.dashOrigin)
    .addText(s.direction).addPlain(s.lanes).addText(s.structure).addPlain(s.section ?? null).addPlain(s.parking ?? null)
    .addPlain(a ? [a.x, a.y] : null).addPlain(b ? [b.x, b.y] : null).add(s.cutWalls ? 1 : 0).value();
}

/** Everything of a node a junction there is built from: its place, height, roads by id, control, crossing and end. */
export function nodeSourceKey(n: RoadNode): number {
  return nodeSourceDigest(n).value();
}

function nodeSourceDigest(n: RoadNode): Digest {
  return new Digest().add(n.x).add(n.y).add(n.heightOffset).add(n.smooth ? 1 : 0).addAll(n.incident).addText(n.control)
    .addPlain(n.blockedMovements).addPlain(n.crossing ? [n.crossing.kind, n.crossing.segment] : null)
    .addPlain(n.end ?? null).addPlain(n.uturn ?? null);
}

/** The whole record of a node: what the traffic reads of it besides the geometry (lane links, signal settings, approach rules). */
export function nodeRecordKey(n: RoadNode): number {
  return nodeSourceDigest(n).addPlain(n.laneLinks ?? null).addPlain(n.signal ?? null).addPlain(n.approachRules ?? null).value();
}
