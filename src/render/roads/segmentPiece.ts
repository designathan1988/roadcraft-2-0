import { offsetPolyline } from '@core/offset';
import type { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network, SegmentRibbon } from '@world/network';
import { Level, SURFACE_LEVELS, type SurfaceLevel, sideHalfWidth } from '@world/roadTypes';
import { CURB_BAND } from '@world/roadTypes';
import { medianNose } from '@world/landscape';
import { mouthLeft, mouthRight } from '@world/junction/legs';
import { rampsOfNode } from '@world/curbRamps';
import { footwayRiseShare } from '@world/roads/footwayRise';
import { m } from '@world/units';
import { isRaised } from '@world/structures';
import { type Chain, type Diagonal, chainAt, chainBetween, cutChain } from '../mesh/stripShape';
import { FIXED, type Geom, OWN, WALL_A, WALL_B, WALL_END, WALL_START } from './pieceGeom';

/**
 * # A ROAD'S SURFACES, FROM ITS CENTRELINE AND ITS CROSS-SECTION
 *
 * Each level of the road (the carriageway's edge, the kerb's, the footway's, a deck's edge) is its centreline trimmed at its junctions' mouths and
 * offset to that level's half width on each side (`ribbons.ts` levelEdges does the same); each band is the strip between two of them
 * (`pieceGeom.ts`): its cross-section swept along it, one row of vertices across them all at every station, as the owner's road tool lays a road
 * (`pu`: one quad a band from mouth to mouth on the flat): the carriageway between its two edges; each side the footway from the carriageway's edge
 * to its own, the kerb stone's top drawn on it by its shader (`mesh/roadEdges.ts`), and the kerb's face, a wall along the carriageway's edge. On the
 * ground the footway's outer edge is the road's outline, which the terrain meets (`terrainSeams.ts`); on a deck a band of the deck's edge runs past
 * it. The road's ends are where its surfaces meet the next piece:
 * - at a junction, the mouth: the strips end on the junction's own mouth points at that level (`junction/legs.ts` mouthLeft, mouthRight), the very
 *   numbers its plate and its corners start from (`junctionPiece.ts`), so the two meet edge on edge;
 * - where two roads carry on through a node with no junction (a gentle bend), the mitre: both end on the line halving the angle between them, so
 *   neither overlaps nor leaves a wedge;
 * - else a free end, walled.
 * A dropped kerb (`world/curbRamps.ts`) takes its stretch of the kerb and the footway on its side, and is a strip of its own between the carriageway's
 * edge and a chain as far into the footway as its slope runs; the kerb's face and the footway beside it end on its ends, the carriageway runs on past
 * it whole (the ramp's front lies on its edge at its height).
 */

/** The road's strips share one group of stations (`pieceGeom.ts`). */
const ROAD_GROUP = 0;
/** No band of two edges nearer than this (a side with no footway). */
const LEAST_WIDTH = m(0.004);
/** No strip shorter than this. */
const LEAST_STRIP = m(0.05);
/** How far a junction's mouth point may lie from the road's own end and still be its mouth. */
const MOUTH_SNAP = m(0.5);

/** One shape of a piece, filed under its surface (`roadSurfaceReads.ts` slotOf) at its place in the walk (`roadSurfaceEntries.ts` PHASE). */
export interface Shape {
  readonly slot: string;
  readonly geom: Geom;
}

/** How a road's level ends at a node: on a junction's mouth, on the mitre with the road carrying on, or free. */
type End =
  | { readonly kind: 'mouth'; readonly left: Vec2; readonly right: Vec2 }
  | { readonly kind: 'join'; readonly px: number; readonly py: number; readonly dx: number; readonly dy: number }
  | { readonly kind: 'free' };

/** A level's two edges with each point's arc length along the road (`Chain`), and how its two ends meet the next pieces. */
interface LevelEdges {
  readonly left: Chain;
  readonly right: Chain;
  readonly freeA: boolean;
  readonly freeB: boolean;
}

/** A shape of a piece at the network's far level (`networkFarRoadsBuild.ts`): its layer (0 the casing, 1 the carriageway) and its strip or fan. */
export interface FarShape {
  readonly layer: 0 | 1;
  readonly geom: Geom;
}

/** The levels a piece's far level is drawn out to, the outermost it has first: on the ground the kerb and the footway as one band out to the footway's
 *  edge (the terrain meets it there, `terrainSeams.ts`); on a deck out to the deck's edge. */
export const FAR_OUTER: readonly SurfaceLevel[] = [Level.Sidewalk as SurfaceLevel, Level.Curb as SurfaceLevel];
export const FAR_OUTER_DECK: readonly SurfaceLevel[] = [Level.Casing as SurfaceLevel, ...FAR_OUTER];

/** Whether pieces of these roads are drawn as a deck at the far level: every one of them a raised structure (a bridge, a viaduct). */
export function deckOf(net: Network, roads: readonly SegmentId[]): boolean {
  return roads.length > 0 && roads.every((id) => { const s = net.doc.segment(id); return !!s && isRaised(s.structure); });
}

/** A road's levels' edges (`levelEdges`), of `which` levels. */
function roadLevels(net: Network, ribbon: SegmentRibbon, which: readonly SurfaceLevel[]): Map<SurfaceLevel, LevelEdges> {
  const levels = new Map<SurfaceLevel, LevelEdges>();
  const segment = net.doc.segment(ribbon.id);
  if (!segment) return levels;
  for (const level of which) {
    const edges = levelEdges(net, ribbon, segment.a, segment.b, level);
    if (edges) levels.set(level, edges);
  }
  return levels;
}

/** A road at the network's far level: its carriageway's strip, and each side the strip from the carriageway's edge to its outermost level's edge
 *  (`FAR_OUTER`, a deck's `FAR_OUTER_DECK`), on the same edges and ends as its detail (`levelEdges`): no union of outlines, no layer cut out of another. */
export function segmentFarShapes(net: Network, ribbon: SegmentRibbon, deck: boolean): FarShape[] {
  const outerLevels = deck ? FAR_OUTER_DECK : FAR_OUTER;
  const levels = roadLevels(net, ribbon, [Level.Asphalt as SurfaceLevel, ...outerLevels]);
  const asphalt = levels.get(Level.Asphalt as SurfaceLevel);
  if (!asphalt || !wide(asphalt.left, asphalt.right)) return [];
  const out: FarShape[] = [{ layer: 1, geom: { kind: 'strip', a: asphalt.left, b: asphalt.right, group: ROAD_GROUP, walls: 0 } }];
  const outer = outerLevels.map((level) => levels.get(level)).find((edges) => edges !== undefined);
  if (outer) {
    for (const side of ['left', 'right'] as const) {
      if (wide(asphalt[side], outer[side])) out.push({ layer: 0, geom: { kind: 'strip', a: asphalt[side], b: outer[side], group: ROAD_GROUP, walls: 0 } });
    }
  }
  return out;
}

/** Every shape of a road's surfaces (the paint aside, `roadSurfaceInputs.ts`). */
export function segmentShapes(net: Network, ribbon: SegmentRibbon): Shape[] {
  const out: Shape[] = [];
  const segment = net.doc.segment(ribbon.id);
  if (!segment) return out;
  const levels = roadLevels(net, ribbon, SURFACE_LEVELS);
  const asphalt = levels.get(Level.Asphalt as SurfaceLevel);
  const curb = levels.get(Level.Curb as SurfaceLevel);
  const sidewalk = levels.get(Level.Sidewalk as SurfaceLevel);
  const casing = levels.get(Level.Casing as SurfaceLevel);
  if (!asphalt) return out;
  const ends = (e: LevelEdges): number => (e.freeA ? WALL_START : 0) | (e.freeB ? WALL_END : 0);
  const strip = (slot: string, a: Chain, b: Chain, walls: number, deckWalls: number, outer = false): void => {
    if (!wide(a, b)) return;
    out.push({ slot, geom: { kind: 'strip', a, b, group: ROAD_GROUP, walls, ...(deckWalls ? { deckWalls } : {}), ...(outer ? { outer: true as const } : {}) } });
  };
  // The carriageway: on a deck its free ends are the deck's end faces; its sides meet the kerbs' faces.
  strip('asphalt', asphalt.left, asphalt.right, 0, ends(asphalt));
  // The dropped kerbs on each side, as stretches of the road.
  const ramps = rampStretches(net, ribbon, segment.a, segment.b);
  for (const side of ['left', 'right'] as const) {
    const carriageway = asphalt[side];
    // The side's outline on the ground: its footway's outer edge, else its kerb's back (a side with no footway).
    const footed = !!sidewalk && !!curb && wide(curb[side], sidewalk[side]);
    if (curb) {
      const kerbEdge = curb[side];
      // Each ramp's stretch, in the ramps' order (null: none left of it on this road).
      const stretches = ramps[side].map(({ from, to }) => clampTo(from, to, carriageway, kerbEdge));
      const cuts = stretches.filter((r): r is [number, number] => r !== null);
      if (!footed) {
        // A kerb with no footway behind it: the kerb's own band, its top and its face, its outer side the outline.
        for (const [a, b, keepA, keepB] of without(carriageway, kerbEdge, cuts)) {
          const free = (keepA ? ends(curb) & WALL_START : 0) | (keepB ? ends(curb) & WALL_END : 0);
          strip('kerb', a, b, WALL_A | free, WALL_B, true);
        }
      }
      if (sidewalk && footed) {
        const footEdge = sidewalk[side];
        // The footway from the carriageway's edge, the kerb's top on it; no wall of its own on the ground (the kerb's face and the terrain meet its
        // edges); on a deck its outer side and free ends. The kerb's face along the carriageway's edge beside it, facing the carriageway, and its
        // free ends (a kerb's end stands over the carriageway's level beside it); none at a ramp's ends, which rise to the kerb's top over their
        // flares (`world/rampRise.ts` rampRiseIn).
        for (const [a, b, keepA, keepB] of without(carriageway, footEdge, cuts)) {
          strip('footway', a, b, 0, WALL_B | (keepA ? ends(sidewalk) & WALL_START : 0) | (keepB ? ends(sidewalk) & WALL_END : 0), true);
          if (!wide(carriageway, kerbEdge)) continue;
          out.push({ slot: 'kerb', geom: { kind: 'face', run: a, group: ROAD_GROUP, ...(side === 'right' ? { left: true as const } : {}) } });
          const free = (keepA ? ends(curb) & WALL_START : 0) | (keepB ? ends(curb) & WALL_END : 0);
          const kerbAt = (start: boolean): number[] => {
            const k = cutTo(kerbEdge, a.s[0]!, a.s[a.s.length - 1]!);
            const i = start ? 0 : a.s.length - 1, j = start ? 0 : k.s.length - 1;
            const px = a.xy[i * 2]!, py = a.xy[i * 2 + 1]!, qx = k.xy[j * 2]!, qy = k.xy[j * 2 + 1]!;
            // Facing out of the road's end: back along the road at its start, on along it at its end (`walls`: the outside on an edge's right).
            const inner = start ? 1 : i - 1;
            const ox = px - a.xy[inner * 2]!, oy = py - a.xy[inner * 2 + 1]!;
            return (qy - py) * ox - (qx - px) * oy >= 0 ? [px, py, qx, qy] : [qx, qy, px, py];
          };
          const edges = [...(free & WALL_START ? kerbAt(true) : []), ...(free & WALL_END ? kerbAt(false) : [])];
          if (edges.length) out.push({ slot: 'kerb', geom: { kind: 'walls', edges: Float64Array.from(edges) } });
        }
        // Each ramp: from the carriageway's edge to as far into the footway as it runs, the footway beyond it.
        const footway = sideHalfWidth(ribbon.road, Level.Sidewalk as SurfaceLevel, side) - sideHalfWidth(ribbon.road, Level.Curb as SurfaceLevel, side);
        const kerbWidth = sideHalfWidth(ribbon.road, Level.Curb as SurfaceLevel, side) - sideHalfWidth(ribbon.road, Level.Asphalt as SurfaceLevel, side);
        ramps[side].forEach(({ run, mid, half, low, high }, k) => {
          const cut = stretches[k];
          if (!cut) return;
          const [from, to] = cut;
          const inner = cutChain(carriageway, from, to);
          const kerbCut = cutChain(kerbEdge, from, to), footCut = cutChain(footEdge, from, to);
          const share = footway > LEAST_WIDTH ? Math.min(1, Math.max(0, (run - kerbWidth) / footway)) : 0;
          const back = share >= 1 ? footCut : share <= 0 ? kerbCut : chainBetween(kerbCut, footCut, share);
          // Its surface is planes (`world/rampRise.ts` rampRiseIn: the slope v / run, each flare (u - half) / flare where that is higher): a quad a
          // part, cut at the flares' creases, each flare along its crease (from the slope's corner at the kerb to the flare's corner at the back).
          // Its front over the carriageway a face where its flares rise; none where it is level with the carriageway.
          const parts: [number, number, number, Diagonal | undefined][] = [
            [mid - half - low, mid - half, WALL_A, 2], [mid - half, mid + half, 0, undefined], [mid + half, mid + half + high, WALL_A, 1],
          ];
          for (const [p0, p1, front, diagonal] of parts) {
            const s0 = Math.max(from, p0), s1 = Math.min(to, p1);
            if (s1 - s0 < LEAST_STRIP) continue;
            // A flare cut by the road's free end (a ramp at a road's end; at a junction its flare ends on the mouth, `world/curbRamps.ts`) keeps
            // its quad and its crease's diagonal: from the slope's corner at the kerb to the back's corner at the cut, its slope's half exact, its
            // flare's half a plane over the two (a stationed cut flare was a fan of needles); its cut edge the stretch's two ends alone.
            const whole = s0 === p0 && s1 === p1;
            out.push({ slot: 'curbRamp', geom: {
              kind: 'strip', a: cutChain(inner, s0, s1), b: cutChain(back, s0, s1), group: diagonal || whole ? FIXED : OWN, walls: front,
              ...(share >= 1 ? { deckWalls: WALL_B, outer: true as const } : {}), ...(diagonal ? { diagonal } : {}),
            } });
          }
          if (share < 1) strip('footway', back, footCut, 0, WALL_B, true);
        });
      }
    }
    // A deck's edge past its footway (drawn by a raised pass alone, `roadSurfaceReads.ts` deckEdge): its outer side the deck's face.
    if (sidewalk && casing) strip('deckEdge', sidewalk[side], casing[side], 0, WALL_B | ends(casing));
  }
  out.push(...medianShapes(net, ribbon));
  return out;
}

/** Whether two chains stand apart across (a band, not a side with no footway). */
function wide(a: Chain, b: Chain): boolean {
  const s0 = Math.max(a.s[0]!, b.s[0]!), s1 = Math.min(a.s[a.s.length - 1]!, b.s[b.s.length - 1]!);
  if (s1 - s0 < LEAST_STRIP) return false;
  const p = chainAt(a, (s0 + s1) / 2), q = chainAt(b, (s0 + s1) / 2);
  return Math.hypot(p[0] - q[0], p[1] - q[1]) >= LEAST_WIDTH;
}

/** A stretch [from, to] kept inside what two chains share; null where nothing is left. */
function clampTo(from: number, to: number, a: Chain, b: Chain): [number, number] | null {
  const lo = Math.max(from, a.s[0]!, b.s[0]!), hi = Math.min(to, a.s[a.s.length - 1]!, b.s[b.s.length - 1]!);
  return hi - lo >= LEAST_STRIP ? [lo, hi] : null;
}

/** A band less the stretches `cuts` (sorted, apart): each piece left, and whether its start and its end are the band's own (not a cut's). */
function without(a: Chain, b: Chain, cuts: readonly (readonly [number, number])[]): [Chain, Chain, boolean, boolean][] {
  if (cuts.length === 0) return [[a, b, true, true]];
  const out: [Chain, Chain, boolean, boolean][] = [];
  const first = Math.min(a.s[0]!, b.s[0]!), last = Math.max(a.s[a.s.length - 1]!, b.s[b.s.length - 1]!);
  let from = first, fromCut = false;
  for (const [lo, hi] of [...cuts].sort((p, q) => p[0] - q[0])) {
    if (lo - from >= LEAST_STRIP) {
      out.push([from === first ? cutTo(a, -Infinity, lo) : cutChain(a, from, lo), from === first ? cutTo(b, -Infinity, lo) : cutChain(b, from, lo), !fromCut, false]);
    }
    from = hi;
    fromCut = true;
  }
  if (last - from >= LEAST_STRIP) out.push([cutTo(a, from, Infinity), cutTo(b, from, Infinity), false, true]);
  return out;
}

/** A chain cut at `from` and `to`, an open side keeping the chain's own end (its own arc length there, a mouth's skewed end kept). */
function cutTo(c: Chain, from: number, to: number): Chain {
  const lo = Math.max(from, c.s[0]!), hi = Math.min(to, c.s[c.s.length - 1]!);
  if (lo === c.s[0]! && hi === c.s[c.s.length - 1]!) return c;
  return cutChain(c, lo, hi);
}

/** A dropped kerb's stretch of its road (arc lengths): its middle, its half width, its flare before it (`low`, down the road) and after it (`high`). */
interface RampStretch { readonly from: number; readonly to: number; readonly run: number; readonly mid: number; readonly half: number; readonly low: number; readonly high: number }

/** The dropped kerbs on each side of a road (`world/curbRamps.ts`): the stretch of road each takes, and how far into the footway its slope runs
 *  from the carriageway's edge. None on a footway laid flush: there is no kerb to drop. */
function rampStretches(net: Network, ribbon: SegmentRibbon, a: NodeId, b: NodeId):
  Record<'left' | 'right', RampStretch[]> {
  const out: Record<'left' | 'right', RampStretch[]> = { left: [], right: [] };
  const near = { s: 0, distance: 0 };
  for (const node of new Set([a, b])) {
    for (const r of rampsOfNode(net, node)) {
      if (r.segment !== ribbon.id) continue;
      if (footwayRiseShare(net, r.x + r.nx * r.run, r.y + r.ny * r.run) <= 0) continue;
      ribbon.full.closestInto(r.x, r.y, near);
      const frame = ribbon.full.sampleAt(near.s);
      const side = r.nx * frame.n.x + r.ny * frame.n.y > 0 ? 'left' : 'right';
      // Its flare towards its node (`near`) on the side of the road its `t` points from.
      const ahead = r.tx * frame.t.x + r.ty * frame.t.y > 0;
      const low = ahead ? r.near : r.flare, high = ahead ? r.flare : r.near;
      out[side].push({ from: near.s - r.half - low, to: near.s + r.half + high, run: r.run, mid: near.s, half: r.half, low, high });
    }
  }
  for (const list of [out.left, out.right]) list.sort((p, q) => p.from - q.from);
  return out;
}

/** A road's level: its trimmed centreline offset to each side (`ribbons.ts` levelEdges), its ends on the next pieces (`End`). */
function levelEdges(net: Network, ribbon: SegmentRibbon, a: NodeId, b: NodeId, level: SurfaceLevel): LevelEdges | null {
  const full = ribbon.full, length = full.length;
  const trims = net.trims.get(ribbon.id);
  const s0 = trims?.a[level] ?? 0, s1 = length - (trims?.b[level] ?? 0);
  if (s1 - s0 < LEAST_STRIP) return null;
  const centre = full.sub(s0, s1).toPoints();
  if (centre.length < 2) return null;
  const left = offsetPolyline(centre, sideHalfWidth(ribbon.road, level, 'left'));
  const right = offsetPolyline(centre, -sideHalfWidth(ribbon.road, level, 'right'));
  if (left.length < 2 || right.length < 2) return null;
  const endA = endOf(net, ribbon, a, true, level), endB = endOf(net, ribbon, b, false, level);
  place(left, right, endA, true);
  place(left, right, endB, false);
  const l = chainAlong(left, full), r = chainAlong(right, full);
  if (!l || !r) return null;
  return { left: l, right: r, freeA: endA.kind === 'free', freeB: endB.kind === 'free' };
}

/** A level's edges' end points put on the next piece's (`End`), in place. */
function place(left: Vec2[], right: Vec2[], end: End, atStart: boolean): void {
  if (end.kind === 'free') return;
  const li = atStart ? 0 : left.length - 1, ri = atStart ? 0 : right.length - 1;
  if (end.kind === 'mouth') {
    if (Math.hypot(end.left.x - left[li]!.x, end.left.y - left[li]!.y) > MOUTH_SNAP || Math.hypot(end.right.x - right[ri]!.x, end.right.y - right[ri]!.y) > MOUTH_SNAP) return;
    left[li] = end.left;
    right[ri] = end.right;
    return;
  }
  for (const edge of [left, right]) {
    const i = atStart ? 0 : edge.length - 1, j = atStart ? 1 : edge.length - 2;
    const p = edge[i]!, q = edge[j]!;
    // The edge's last stretch carried on to the mitre's line.
    const ex = p.x - q.x, ey = p.y - q.y;
    const den = ex * end.dy - ey * end.dx;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((end.px - q.x) * end.dy - (end.py - q.y) * end.dx) / den;
    edge[i] = { x: q.x + ex * t, y: q.y + ey * t };
  }
}

/** How a road's level ends at `node` (`End`): `atA`, the road's start. */
function endOf(net: Network, ribbon: SegmentRibbon, node: NodeId, atA: boolean, level: SurfaceLevel): End {
  const byLevel = net.junctions.get(node);
  const junction = byLevel?.get(level);
  if (junction && !junction.ring.isEmpty) {
    // The leg of this road at this end: it starts here when the road's left is its +nrm side.
    const k = junction.legs.findIndex((leg) => leg.seg === ribbon.id && (leg.plusSide === 'left') === atA);
    if (k >= 0) {
      const leg = junction.legs[k]!, trim = junction.trims[k]!;
      const plus = mouthLeft(leg, trim), minus = mouthRight(leg, trim);
      // From the road's start its left is the leg's +nrm side; from its end, its -nrm side.
      return atA ? { kind: 'mouth', left: plus, right: minus } : { kind: 'mouth', left: minus, right: plus };
    }
  }
  if (byLevel && byLevel.size > 0) return { kind: 'free' };
  const record = net.doc.node(node);
  if (!record || record.incident.length !== 2) return { kind: 'free' };
  const otherId = record.incident[0] === ribbon.id ? record.incident[1]! : record.incident[0]!;
  if (otherId === ribbon.id) return { kind: 'free' };
  const other = net.ribbons.get(otherId);
  const otherSeg = net.doc.segment(otherId);
  if (!other || !otherSeg) return { kind: 'free' };
  const u = awayFrom(ribbon.full, atA);
  const v = awayFrom(other.full, otherSeg.a === node);
  // The two roads' mean direction through the node, and the line square to it.
  const wx = u.x - v.x, wy = u.y - v.y, wl = Math.hypot(wx, wy);
  if (wl < 1e-6) return { kind: 'free' };
  return { kind: 'join', px: record.x, py: record.y, dx: -wy / wl, dy: wx / wl };
}

/** A centreline's direction away from its end at the start (`atStart`) or at the end. */
function awayFrom(line: Polyline, atStart: boolean): Vec2 {
  const t = line.tangentAt(atStart ? 0 : line.length);
  return atStart ? t : { x: -t.x, y: -t.y };
}

/** Points along `line` with each one's arc length on it: the nearest point's, or past an end the length along the end's tangent (a mitre's corner
 *  stands past the node); the lengths made to rise, a point that would step back left out. Null for fewer than two points left. */
function chainAlong(points: readonly Vec2[], line: Polyline): Chain | null {
  const near = { s: 0, distance: 0 };
  const length = line.length;
  const first = line.point(0), last = line.point(line.n - 1);
  const t0 = line.tangentAt(0), t1 = line.tangentAt(length);
  const xs: number[] = [], ss: number[] = [];
  points.forEach((p, i) => {
    line.closestInto(p.x, p.y, near);
    const before = (p.x - first.x) * t0.x + (p.y - first.y) * t0.y;
    const after = (p.x - last.x) * t1.x + (p.y - last.y) * t1.y;
    const s = near.s <= 1e-9 && before < 0 ? before : near.s >= length - 1e-9 && after > 0 ? length + after : near.s;
    // The last point always stays: what steps back before it goes.
    if (i === points.length - 1) while (ss.length && ss[ss.length - 1]! >= s - 1e-6) { ss.pop(); xs.pop(); xs.pop(); }
    else if (ss.length && s <= ss[ss.length - 1]! + 1e-6) return;
    xs.push(p.x, p.y); ss.push(s);
  });
  if (ss.length < 2) return null;
  return { xy: Float64Array.from(xs), s: Float64Array.from(ss) };
}

/** A road's central reservation (`world/landscape.ts` medianNose stands its noses back of each crossing): its kerb stone each side, the planting
 *  or the paving between, and its ends walled. */
function medianShapes(net: Network, ribbon: SegmentRibbon): Shape[] {
  const median = ribbon.road.median;
  // A median painted on the carriageway has no kerb and no island.
  if (median <= 0 || ribbon.road.medianFlush) return [];
  const centre = ribbon.centre[Level.Asphalt];
  if (!centre || centre.n < 2) return [];
  const seg = net.doc.segment(ribbon.id);
  const back = (node: NodeId | undefined, from: Vec2): number => {
    const at = node === undefined ? null : net.doc.node(node);
    const nose = node === undefined || !at ? 0 : medianNose(net, ribbon.id as SegmentId, node);
    return nose > 0 && at ? Math.max(0, nose - Math.hypot(from.x - at.x, from.y - at.y)) : 0;
  };
  const s0 = back(seg?.a, centre.point(0)), s1 = centre.length - back(seg?.b, centre.point(centre.n - 1));
  if (s1 - s0 < m(1)) return [];
  const points = s0 > 0 || s1 < centre.length ? centre.sub(s0, s1).toPoints() : centre.toPoints();
  const chain = (half: number): Chain | null => chainAlong(offsetPolyline(points, half), ribbon.full);
  const kerbLeft = chain(median / 2 + CURB_BAND), innerLeft = chain(median / 2), innerRight = chain(-median / 2), kerbRight = chain(-(median / 2 + CURB_BAND));
  if (!kerbLeft || !innerLeft || !innerRight || !kerbRight) return [];
  const material = ribbon.road.materials?.median;
  const inner = material && material !== 'grass' ? 'median:paved' : 'median:planting';
  const out: Shape[] = [
    { slot: 'median:kerb', geom: { kind: 'strip', a: innerLeft, b: kerbLeft, group: ROAD_GROUP, walls: WALL_B | WALL_START | WALL_END } },
    { slot: 'median:kerb', geom: { kind: 'strip', a: innerRight, b: kerbRight, group: ROAD_GROUP, walls: WALL_B | WALL_START | WALL_END } },
    { slot: inner, geom: { kind: 'strip', a: innerLeft, b: innerRight, group: ROAD_GROUP, walls: WALL_A | WALL_B | WALL_START | WALL_END } },
  ];
  // The kerb stone's face across each nose, under the planting's: the outside on each wall's right (left to right at the start, back at the end).
  const end = (c: Chain, last: boolean): [number, number] => last ? [c.xy[c.xy.length - 2]!, c.xy[c.xy.length - 1]!] : [c.xy[0]!, c.xy[1]!];
  const [lx0, ly0] = end(innerLeft, false), [rx0, ry0] = end(innerRight, false), [lx1, ly1] = end(innerLeft, true), [rx1, ry1] = end(innerRight, true);
  out.push({ slot: 'median:kerb', geom: { kind: 'walls', edges: Float64Array.from([lx0, ly0, rx0, ry0, rx1, ry1, lx1, ly1]) } });
  return out;
}
