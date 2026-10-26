import type { Vec2 } from '@core/vec2';
import type { Ring } from '@core/ring';
import { normalizeAngle } from '@core/scalar';
import type { NodeId } from '@world/ids';
import type { Network } from '@world/network';
import { FOOTWAY_RISE, Level, type SurfaceLevel } from '@world/roadTypes';
import type { Junction, Leg } from '@world/junction/types';
import { mouthLeft, mouthRight } from '@world/junction/legs';
import { m } from '@world/units';
import type { Chain } from '../mesh/stripShape';
import { COARSEST, FIXED, type Geom, type PieceLevel, WALL_B, atLevel } from './pieceGeom';
import { FAR_OUTER, FAR_OUTER_DECK, type FarShape, type Shape } from './segmentPiece';

/**
 * # A JUNCTION'S SURFACES, AS THE OWNER'S ROAD TOOL BUILDS THEM
 *
 * A junction is solved at each surface level (`world/junction/levels.ts`): its legs' mouths, cut across each road at its trim, joined by its corners.
 * Its surfaces are made from those outlines and nothing else, piece by piece as the owner's road tool makes a junction (`ferramenta-vias-objetos.html`,
 * its `au`, `ou`, `ru` and `pu`):
 * - the plate: the carriageway's outline alone, each leg's two mouth corners and the inner stations of the corner to the next leg, cut by ear clipping
 *   and refined by edge flips (`pieceMesh.ts`): no point inside it;
 * - each corner's kerb return: equal-angle stations round its arc, as many as `returnSteps` gives its sweep at each level, the arc's ends its tangent
 *   points exactly; a corner past a straight angle (the outside of a bend) curved too, an arc tangent to its two kerb lines (`reflexArc`: a bend's
 *   concentric with its inside's), cut alike; a straight one no point at all;
 * - each corner's kerb face: one quad a step of the return, lit round it, none at the network's far level;
 * - each corner's footway: one polygon of the return's stations and its outer run back, the footway's back kept at the footway's width round the
 *   corner (`outerRun`: each station moved off the kerb's line by the width, an arc concentric with the return), the kerb stone's top drawn on it by
 *   the footway's shader from each vertex's distance to the kerb's line. Where the owner's road tool squares the footway's back and mitres a bend's
 *   outside, the owner ordered both curved (2026-10-25);
 * - on a deck, the deck's edge round each corner (`deckEdge`), walled on its outer side.
 * Every point carries the coarsest level that keeps it (`pieceGeom.ts` PieceLevel): a return's stations at a level are some of the finer level's, and
 * its mouths are the same at every level, where the roads' own strips end (`segmentPiece.ts`): no crack between a junction and its roads at any level.
 * No outline is ever united with another's or cut by it.
 */

/** How far a ring's point may stand from a mouth's and be it. */
const MOUTH_MATCH = m(0.02);
/** Two points nearer than this are one (the owner's tool's own `tu`). */
const SAME_POINT = 1e-6;
/** A return's end this near its leg's mouth corner is the mouth corner (a leg trimmed a hair past the tangent by its other corner): one point, never an
 *  edge a hair long and the slivers it would make. */
const NEAR_POINT = m(0.01);
/** A corner this near a straight angle is straight (`au`). */
const STRAIGHT = 0.02;
/** A corner this near a full turn is straight too: two legs leaving almost the same way have no meeting point to stand on (`au`). */
const HAIRPIN = 0.35;
/** No kerb face where the kerb is narrower than this: a footway laid flush with the carriageway (`roadTypes.ts` flushOn). */
const LEAST_KERB = m(0.004);

/**
 * Steps a kerb's return of `sweep` radians is cut into at `level` (the owner's tool's `ru`): eight a right angle at the detail, rounded up to a power of
 * two, halved at each coarser level, never under one; equal angles, so a coarser level's stations are every other one of the finer level's.
 */
function returnSteps(sweep: number, level: PieceLevel): number {
  const steps = Math.max(0, Math.ceil(Math.log2(Math.max(1, (8 * Math.abs(sweep)) / (Math.PI / 2)) - 1e-9)));
  return Math.max(1, 2 ** Math.max(0, steps - level));
}

/** The coarsest level that keeps station `k` of a return cut into `steps` at the detail (`returnSteps`). */
function stationLevel(k: number, sweep: number): PieceLevel {
  let level: PieceLevel = 0;
  for (const l of [1, 2] as const) if (k % (returnSteps(sweep, 0) / returnSteps(sweep, l)) === 0) level = l;
  return level;
}

/** A point of a corner's run: where it is, the coarsest level that keeps it, and the way a kerb's face faces there on the plan (NaN: the face's own). */
interface RunPoint {
  readonly x: number;
  readonly y: number;
  readonly level: PieceLevel;
  readonly nx: number;
  readonly ny: number;
}

const point = (p: Vec2, level: PieceLevel = COARSEST): RunPoint => ({ x: p.x, y: p.y, level, nx: NaN, ny: NaN });

/** A level's outline, counter-clockwise. */
const positive = (ring: Ring): Ring => ring.ensurePositive();

/**
 * The run of a level's outline from `from` to `to`, both its vertices, counter-clockwise: its lines' ends, and each arc's equal-angle stations
 * (`returnSteps`, its ends exact), each facing away from its centre where that is the outline's inside; null where the outline has no vertex at
 * either point.
 */
function ringRun(ring: Ring, from: Vec2, to: Vec2): RunPoint[] | null {
  const r = positive(ring);
  const edges = r.edges;
  const count = edges.length;
  if (count < 2) return null;
  const vertex = (k: number): Vec2 => (k === 0 ? r.start : edges[k - 1]!.to);
  let start = -1, best = MOUTH_MATCH;
  for (let k = 0; k < count; k++) { const v = vertex(k), d = Math.hypot(v.x - from.x, v.y - from.y); if (d <= best) { best = d; start = k; } }
  if (start < 0) return null;
  const out: RunPoint[] = [point(from)];
  for (let n = 0, k = start; n < count; n++, k = (k + 1) % count) {
    const e = edges[k]!, a = vertex(k);
    const end = Math.hypot(e.to.x - to.x, e.to.y - to.y) <= MOUTH_MATCH;
    if (e.kind === 'arc') {
      let delta = normalizeAngle(e.a1 - e.a0);
      if (e.ccw && delta < 0) delta += Math.PI * 2;
      if (!e.ccw && delta > 0) delta -= Math.PI * 2;
      const steps = returnSteps(delta, 0);
      // The outline's inside lies left of its way round (counter-clockwise): the face looks that way, from the centre or towards it.
      const sign = (e.ccw ? -1 : 1);
      for (let i = 1; i <= steps; i++) {
        const angle = e.a0 + (delta * i) / steps;
        const at = i === steps ? (end ? to : e.to) : { x: e.c.x + Math.cos(angle) * e.r, y: e.c.y + Math.sin(angle) * e.r };
        out.push({ x: at.x, y: at.y, level: stationLevel(i, delta), nx: Math.cos(angle) * sign, ny: Math.sin(angle) * sign });
      }
      // The arc's first point faces round too.
      const first = out.length - steps - 1;
      if (Math.hypot(out[first]!.x - a.x, out[first]!.y - a.y) <= MOUTH_MATCH) {
        out[first] = { ...out[first]!, nx: Math.cos(e.a0) * sign, ny: Math.sin(e.a0) * sign };
      }
    } else out.push(end ? point(to) : point(e.to));
    if (end) return out;
  }
  return null;
}

/** A run without repeated points (the owner's tool's `tu`) and without points standing on the straight line between their neighbours (a straight
 *  corner's: `au` gives it none). */
function cleanRun(run: readonly RunPoint[]): RunPoint[] {
  const out: RunPoint[] = [];
  for (const p of run) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) <= NEAR_POINT) {
      // One point: where the coarser of the two stands (a mouth corner, kept at every level), facing as whichever faces round.
      const keep = p.level > last.level ? p : last, other = keep === p ? last : p;
      out[out.length - 1] = Number.isNaN(keep.nx) ? { ...keep, nx: other.nx, ny: other.ny } : keep;
      continue;
    }
    out.push(p);
  }
  // The run's two ends are its mouths: never moved off them.
  if (out.length >= 2) { out[0] = { ...out[0]!, x: run[0]!.x, y: run[0]!.y, level: COARSEST }; const e = run[run.length - 1]!; out[out.length - 1] = { ...out[out.length - 1]!, x: e.x, y: e.y, level: COARSEST }; }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1]!, p = out[i]!, b = out[i + 1]!;
    if (!Number.isNaN(p.nx)) continue;
    const ex = b.x - a.x, ey = b.y - a.y, length = Math.hypot(ex, ey);
    if (length > 0 && Math.abs(ex * (p.y - a.y) - ey * (p.x - a.x)) / length <= SAME_POINT && (p.x - a.x) * ex + (p.y - a.y) * ey > 0 && (p.x - b.x) * ex + (p.y - b.y) * ey < 0) out.splice(i, 1);
  }
  return out;
}

/** A leg of a level by its road and its end (`Leg.plusSide`: which way round it leaves the node). */
function legLike(j: Junction, leg: Leg): number {
  return j.legs.findIndex((l) => l.seg === leg.seg && l.plusSide === leg.plusSide);
}

/** One corner of a junction, from leg `from`'s mouth to the next leg's: its kerb's line (the carriageway's run), its kerb's width, its footway's outer
 *  run and its deck edge's (each null where that level has no such corner). */
interface Corner {
  readonly from: Leg;
  readonly to: Leg;
  readonly kerb: RunPoint[];
  readonly kerbWidth: number;
  readonly sidewalk: RunPoint[] | null;
  readonly casing: RunPoint[] | null;
}

/** The counter-clockwise angle from leg `a`'s way out to leg `b`'s, in (0, 2 pi]. */
function wedge(a: Leg, b: Leg): number {
  let phi = Math.atan2(b.dir.y, b.dir.x) - Math.atan2(a.dir.y, a.dir.x);
  while (phi <= 1e-9) phi += Math.PI * 2;
  while (phi > Math.PI * 2 + 1e-9) phi -= Math.PI * 2;
  return phi;
}

/** A level's run of the corner from `from` to `to` (legs of the carriageway, `lead`): its own points (`ringRun`), cleaned. */
function levelRun(j: Junction | undefined, from: Leg, to: Leg): RunPoint[] | null {
  if (!j || j.ring.isEmpty) return null;
  const i = legLike(j, from), k = legLike(j, to);
  if (i < 0 || k < 0) return null;
  const run = ringRun(j.ring, mouthLeft(j.legs[i]!, j.trims[i]!), mouthRight(j.legs[k]!, j.trims[k]!));
  return run ? cleanRun(run) : null;
}

/**
 * An outer level's run of a corner squared (the owner's tool's `pu`, its point Y), where no arc can keep the footway's width round it (`outerRun`: a
 * return tighter than the footway is wide, whose offset closes on that point, or a corner with no return): the leg's outer mouth
 * corner, where the two legs' edges at that level meet, and the next leg's; a straight corner (`STRAIGHT`) the two mouth corners alone. The level's
 * own run where the corner has no meeting point, or where it lies past either mouth (a footway wider than the kerb's return, which the tool's legs
 * are trimmed back for and the game's are not: the square would cross the road's own footway), and on a turning circle (one leg).
 */
function squareRun(j: Junction | undefined, from: Leg, to: Leg, phi: number): RunPoint[] | null {
  if (!j || j.ring.isEmpty) return null;
  const i = legLike(j, from), k = legLike(j, to);
  if (i < 0 || k < 0 || j.legs.length < 2) return levelRun(j, from, to);
  const li = j.legs[i]!, lk = j.legs[k]!;
  const a = mouthLeft(li, j.trims[i]!), b = mouthRight(lk, j.trims[k]!);
  if (Math.abs(phi - Math.PI) < STRAIGHT || phi >= Math.PI * 2 - HAIRPIN) return cleanRun([point(a), point(b)]);
  const x = j.corners.find((c) => c.i === i)?.x ?? null;
  if (!x) return levelRun(j, from, to);
  const along = (leg: Leg, trim: number): boolean => (x.x - leg.origin.x) * leg.dir.x + (x.y - leg.origin.y) * leg.dir.y <= trim + SAME_POINT;
  if (!along(li, j.trims[i]!) || !along(lk, j.trims[k]!)) return levelRun(j, from, to);
  return cleanRun([point(a), point(x), point(b)]);
}

/**
 * The outside of a corner past a straight angle (a bend's outside, a leg's back), curved: the arc tangent to its two kerb lines, its tangent points
 * as far from the lines' meeting point `x` as the nearer mouth corner (a straight run to the farther), its centre on the carriageway's side, cut into
 * the steps a return of its turn takes (`returnSteps`), each station's face looking to the centre. A bend's two sides trimmed alike make it concentric
 * with the bend's inside, its radius the inside's and the carriageway's width.
 */
function reflexArc(kerb: readonly RunPoint[], x: Vec2, phi: number): RunPoint[] {
  const first = kerb[0]!, last = kerb[kerb.length - 1]!;
  const ta = Math.hypot(x.x - first.x, x.y - first.y), tb = Math.hypot(x.x - last.x, x.y - last.y);
  const t = Math.min(ta, tb), turn = phi - Math.PI;
  if (t <= SAME_POINT || turn <= 0) return cleanRun([first, point(x), last]);
  const radius = t / Math.tan(turn / 2);
  // Along the first kerb line towards the meeting point; the carriageway on its left (the outline runs counter-clockwise).
  const ux = (x.x - first.x) / ta, uy = (x.y - first.y) / ta;
  const p0 = { x: x.x - ux * t, y: x.y - uy * t };
  const c = { x: p0.x - uy * radius, y: p0.y + ux * radius };
  const p1 = { x: x.x + ((last.x - x.x) / tb) * t, y: x.y + ((last.y - x.y) / tb) * t };
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x), steps = returnSteps(turn, 0);
  const out: RunPoint[] = [first, { x: p0.x, y: p0.y, level: COARSEST, nx: -Math.cos(a0), ny: -Math.sin(a0) }];
  for (let i = 1; i <= steps; i++) {
    const angle = a0 + (turn * i) / steps;
    const at = i === steps ? p1 : { x: c.x + Math.cos(angle) * radius, y: c.y + Math.sin(angle) * radius };
    out.push({ x: at.x, y: at.y, level: stationLevel(i, turn), nx: -Math.cos(angle), ny: -Math.sin(angle) });
  }
  out.push(last);
  return cleanRun(out);
}

/** The shortest step an outer run keeps at a level: the kerb's rise, the narrowest band a road draws. A return's offset on the inside of a corner
 *  is shorter than the return by the footway's width: steps shorter than this would make triangles narrower than a kerb's face. */
const LEAST_STEP = FOOTWAY_RISE;

/** How far a point lies from the segment from `a` to `b`. */
function segmentDistance(p: RunPoint, a: RunPoint, b: RunPoint): number {
  const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
  return Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y);
}

/**
 * How far the curve a run stands for lies at most from the chords of its points kept at `level` (`levels[i] >= level`; its two ends always kept): the
 * chord error that level draws it with. A chord between two stations of an arc (both facing round, `RunPoint` nx, ny) stands off the arc by its
 * sagitta, half the chord times the tangent of a quarter of the angle the two faces turn through (https://en.wikipedia.org/wiki/Sagitta_(geometry));
 * any chord off the run's own points it leaves out by their distance.
 */
function chordError(run: readonly RunPoint[], levels: readonly number[], level: number): number {
  let worst = 0, from = 0;
  for (let i = 1; i < run.length; i++) {
    if (levels[i]! < level && i !== run.length - 1) continue;
    const a = run[from]!, b = run[i]!;
    for (let k = from + 1; k < i; k++) worst = Math.max(worst, segmentDistance(run[k]!, a, b));
    if (!Number.isNaN(a.nx) && !Number.isNaN(b.nx)) {
      const turn = Math.acos(Math.max(-1, Math.min(1, a.nx * b.nx + a.ny * b.ny)));
      worst = Math.max(worst, (Math.hypot(b.x - a.x, b.y - a.y) / 2) * Math.tan(turn / 4));
    }
    from = i;
  }
  return worst;
}

/**
 * The stations a back arc of `radius` keeps at each level, round a kerb's return of `kerbRadius` turning through `sweep` (the return's own grid:
 * `returnSteps` at the detail), by the equal-error rule of curve levels of detail: at each level the arc is cut into the fewest equal steps of that grid
 * (a power of two, never more than the return's own at that level) whose chords stand off it no farther than the return's own stand off the return
 * (the sagitta r (1 - cos(step / 2)), https://en.wikipedia.org/wiki/Sagitta_(geometry)). A footway's back on the inside of a corner is tighter than its
 * return by the footway's width, and the return's own steps on it would be that much shorter: a 0.5 m back round a 3.5 m return cut as the return is
 * 0.1 m steps across a 3 m footway, slivers. Each station's level (-1: none, not even the detail); a coarser level's stations are some of the finer
 * one's (its return's error is larger: fewer steps).
 */
function backLevels(sweep: number, kerbRadius: number, radius: number): number[] {
  const steps = returnSteps(sweep, 0);
  const sagitta = (r: number, cuts: number): number => r * (1 - Math.cos(sweep / (2 * cuts)));
  const strides = ([0, 1, 2] as const).map((level) => {
    const own = returnSteps(sweep, level), allowed = sagitta(kerbRadius, own) + SAME_POINT;
    let cuts = 1;
    while (cuts < own && sagitta(radius, cuts) > allowed) cuts *= 2;
    return steps / cuts;
  });
  return Array.from({ length: steps + 1 }, (_, k) => { let level = -1; strides.forEach((stride, l) => { if (k % stride === 0) level = l; }); return level; });
}

/**
 * A run with no step under `LEAST_STEP` at any level: from the coarsest level down, of two points that level keeps nearer than that, the one whose
 * leaving costs the smaller chord error (`chordError`) is left to the finer levels (none at the detail); the run's ends never. Each level's points
 * stay some of the finer level's.
 */
function uncrowded(run: readonly RunPoint[]): RunPoint[] {
  const last = run.length - 1;
  const levels = run.map((p, i) => (i === 0 || i === last ? COARSEST : p.level) as number);
  const without = (i: number, level: number): number => { levels[i] = level - 1; const e = chordError(run, levels, level); levels[i] = level; return e; };
  for (let level: number = COARSEST; level >= 0; level--) {
    for (let crowded = true; crowded;) {
      crowded = false;
      const kept = levels.flatMap((l, i) => (l >= level ? [i] : []));
      for (let n = 0; n + 1 < kept.length && !crowded; n++) {
        const p = kept[n]!, q = kept[n + 1]!;
        if (Math.hypot(run[q]!.x - run[p]!.x, run[q]!.y - run[p]!.y) >= LEAST_STEP) continue;
        const free = [p, q].filter((i) => i !== 0 && i !== last && levels[i] === level);
        if (free.length === 0) continue;
        levels[free.length === 1 ? free[0]! : without(p, level) < without(q, level) ? p : q] = level - 1;
        crowded = true;
      }
    }
  }
  return run.flatMap((p, i) => (levels[i]! >= 0 ? [{ ...p, level: levels[i]! as PieceLevel }] : []));
}

/** A kerb's return's radius and sweep, from its run's first and last points facing round it (`RunPoint` nx, ny); null for a run with no return. */
function returnOf(kerb: readonly RunPoint[]): { radius: number; sweep: number } | null {
  const arc = kerb.filter((p) => !Number.isNaN(p.nx));
  if (arc.length < 2) return null;
  const a = arc[0]!, b = arc[arc.length - 1]!;
  const sweep = Math.abs(Math.atan2(a.nx * b.ny - a.ny * b.nx, a.nx * b.nx + a.ny * b.ny));
  if (sweep < 1e-6) return null;
  return { radius: Math.hypot(b.x - a.x, b.y - a.y) / (2 * Math.sin(sweep / 2)), sweep };
}

/**
 * An outer level's run of a corner (the footway's back, a deck's edge) curved: the leg's outer mouth corner, the arc tangent to the two legs' outer
 * edges (each along its leg from its mouth corner), the next leg's outer mouth corner. Its radius the kerb return's less the outer level's width (the
 * wider leg's), on the outside of a bend the return's and the width: concentric with the return where the two legs are as wide, the outer level at
 * its width all round; made smaller where the legs are too short for its tangent points. Its stations equal steps of the return's own grid, as many
 * at each level as keep its chords as near the arc as the kerb's (`backLevels`), none crowded (`uncrowded`). Squared (`squareRun`) where the corner
 * has no return, or where no arc is left (a footway as wide as the return's radius: the back's corner is a point); the level's own run on a turning
 * circle (one leg) or where the legs' outer edges meet past a mouth (`squareRun`).
 */
function outerRun(j: Junction | undefined, lead: Junction, from: Leg, to: Leg, phi: number, kerb: readonly RunPoint[]): RunPoint[] | null {
  if (!j || j.ring.isEmpty) return null;
  const i = legLike(j, from), k = legLike(j, to);
  if (i < 0 || k < 0 || j.legs.length < 2) return levelRun(j, from, to);
  // Two roads carrying on through the node (a taper between two widths, a crossing mid-block): the outer level's own run, as the kerb's is the
  // carriageway's, so a taper's S curves the footway's back with its kerb at the footway's width; on a straight side its two mouth corners alone
  // (`cleanRun`). DO NOT join the mouth corners with one chord there: the footway's back went straight across the kerb's S, its width changing.
  if (Math.abs(phi - Math.PI) < STRAIGHT) return levelRun(j, from, to) ?? squareRun(j, from, to, phi);
  if (phi >= Math.PI * 2 - HAIRPIN) return squareRun(j, from, to, phi);
  const li = lead.legs[legLike(lead, from)], lk = lead.legs[legLike(lead, to)];
  const kerbReturn = returnOf(kerb);
  if (!li || !lk || !kerbReturn) return squareRun(j, from, to, phi);
  const legI = j.legs[i]!, legK = j.legs[k]!;
  const a = mouthLeft(legI, j.trims[i]!), b = mouthRight(legK, j.trims[k]!);
  const di = legI.dir, dk = legK.dir;
  // The two outer edges' meeting point: a + di s = b + dk t.
  const den = di.x * dk.y - di.y * dk.x;
  if (Math.abs(den) < 1e-9) return squareRun(j, from, to, phi);
  const s = ((b.x - a.x) * dk.y - (b.y - a.y) * dk.x) / den;
  const y = { x: a.x + di.x * s, y: a.y + di.y * s };
  // How far each mouth corner stands out along its leg from that point: room for the arc's tangent point.
  const roomI = (a.x - y.x) * di.x + (a.y - y.y) * di.y, roomK = (b.x - y.x) * dk.x + (b.y - y.y) * dk.y;
  if (roomI < -SAME_POINT || roomK < -SAME_POINT) return squareRun(j, from, to, phi);
  const psi = Math.acos(Math.max(-1, Math.min(1, di.x * dk.x + di.y * dk.y)));
  const width = Math.max(legI.hwLeft - li.hwLeft, legK.hwRight - lk.hwRight);
  const reflex = phi > Math.PI;
  let radius = reflex ? kerbReturn.radius + width : kerbReturn.radius - width;
  radius = Math.min(radius, Math.max(0, Math.min(roomI, roomK)) * Math.tan(psi / 2));
  if (radius < NEAR_POINT) return squareRun(j, from, to, phi);
  const tangent = radius / Math.tan(psi / 2);
  const ux = di.x + dk.x, uy = di.y + dk.y, ul = Math.hypot(ux, uy);
  const reach = radius / Math.sin(psi / 2);
  const c = { x: y.x + (ux / ul) * reach, y: y.y + (uy / ul) * reach };
  const ti = { x: y.x + di.x * tangent, y: y.y + di.y * tangent }, tk = { x: y.x + dk.x * tangent, y: y.y + dk.y * tangent };
  const a0 = Math.atan2(ti.y - c.y, ti.x - c.x), delta = normalizeAngle(Math.atan2(tk.y - c.y, tk.x - c.x) - a0);
  const levels = backLevels(Math.abs(delta), kerbReturn.radius, radius), steps = levels.length - 1;
  const stations: RunPoint[] = [];
  levels.forEach((level, n) => {
    if (level < 0) return;
    const angle = a0 + (delta * n) / steps;
    const at = n === 0 ? ti : n === steps ? tk : { x: c.x + Math.cos(angle) * radius, y: c.y + Math.sin(angle) * radius };
    // Facing round the arc (`chordError`).
    stations.push({ x: at.x, y: at.y, level: level as PieceLevel, nx: Math.cos(angle), ny: Math.sin(angle) });
  });
  return uncrowded(cleanRun([point(a), ...stations, point(b)]));
}

/** The kerb's width at a corner: the narrower of its two sides' (the carriageway's edge to the kerb's back, `roadTypes.ts` sideHalfWidth). */
function kerbWidthAt(byLevel: ReadonlyMap<SurfaceLevel, Junction>, lead: Junction, from: Leg, to: Leg): number {
  const curb = byLevel.get(Level.Curb as SurfaceLevel);
  if (!curb) return 0;
  const i = legLike(curb, from), k = legLike(curb, to);
  if (i < 0 || k < 0) return 0;
  const li = lead.legs[legLike(lead, from)]!, lk = lead.legs[legLike(lead, to)]!;
  return Math.max(0, Math.min(curb.legs[i]!.hwLeft - li.hwLeft, curb.legs[k]!.hwRight - lk.hwRight));
}

/** Every corner of a junction, from each leg to the next counter-clockwise round the carriageway (`lead`): the carriageway's run (a corner past a
 *  straight angle curved, `reflexArc`), the footway's back and the deck's edge at their widths round it (`outerRun`). */
function cornersOf(byLevel: ReadonlyMap<SurfaceLevel, Junction>, lead: Junction): Corner[] {
  const legs = lead.legs, n = legs.length;
  const out: Corner[] = [];
  for (let k = 0; k < n; k++) {
    const from = legs[k]!, to = legs[(k + 1) % n]!;
    let kerb = levelRun(lead, from, to);
    if (!kerb) continue;
    // Past a straight angle (the outside of a bend, a leg's back): curved round from one kerb line to the other (`reflexArc`).
    const phi = n >= 2 ? wedge(from, to) : 0;
    const x = lead.corners.find((c) => c.i === k)?.x ?? null;
    if (n >= 2 && phi > Math.PI + STRAIGHT && phi < Math.PI * 2 - HAIRPIN && x) kerb = reflexArc(kerb, x, phi);
    out.push({
      from, to, kerb, kerbWidth: kerbWidthAt(byLevel, lead, from, to),
      sidewalk: outerRun(byLevel.get(Level.Sidewalk as SurfaceLevel), lead, from, to, phi, kerb),
      casing: outerRun(byLevel.get(Level.Casing as SurfaceLevel), lead, from, to, phi, kerb),
    });
  }
  return out;
}

/** Points as x, y pairs. */
function flat(points: readonly RunPoint[]): Float64Array {
  const out = new Float64Array(points.length * 2);
  points.forEach((p, i) => { out[i * 2] = p.x; out[i * 2 + 1] = p.y; });
  return out;
}

const levelsOf = (points: readonly RunPoint[]): Uint8Array => Uint8Array.from(points.map((p) => p.level));

/**
 * The carriageway's plate: each leg's two mouth corners and the inner points of the corner to the next leg, counter-clockwise (the owner's tool's `pu`);
 * its mouths the edges across each leg, where the road's carriageway ends. No wall: its other edges meet the kerbs' faces.
 */
function plateOf(lead: Junction, corners: readonly Corner[]): Geom | null {
  // Every leg's corner, or the outline is not closed.
  if (corners.length !== lead.legs.length) return null;
  const ring: RunPoint[] = [];
  for (const corner of corners) {
    // The corner's run starts on its leg's left mouth corner: the leg's right one before it, the mouth between them.
    const i = legLike(lead, corner.from);
    ring.push(point(mouthRight(lead.legs[i]!, lead.trims[i]!)));
    for (let k = 0; k + 1 < corner.kerb.length; k++) ring.push(corner.kerb[k]!);
  }
  const clean = ring.filter((p, i) => { const q = ring[(i + 1) % ring.length]!; return Math.hypot(p.x - q.x, p.y - q.y) > SAME_POINT; });
  if (clean.length < 3) return null;
  // A mouth: the edge from a leg's right mouth corner to its left one.
  const mouths = new Uint8Array(clean.length);
  const near = (p: RunPoint, q: Vec2): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= SAME_POINT;
  clean.forEach((p, i) => {
    const q = clean[(i + 1) % clean.length]!;
    if (lead.legs.some((leg, k) => near(p, mouthRight(leg, lead.trims[k]!)) && near(q, mouthLeft(leg, lead.trims[k]!)))) mouths[i] = 1;
  });
  let area = 0;
  for (let i = 0; i < clean.length; i++) { const p = clean[i]!, q = clean[(i + 1) % clean.length]!; area += p.x * q.y - q.x * p.y; }
  if (area <= 0) return null;
  let cx = 0, cy = 0;
  for (const leg of lead.legs) { cx += leg.origin.x; cy += leg.origin.y; }
  return {
    kind: 'fan', cx: cx / lead.legs.length, cy: cy / lead.legs.length, ring: flat(clean), walls: new Uint8Array(clean.length), plate: true,
    mouths, levels: levelsOf(clean),
  };
}

/** A run as a chain whose arc lengths are each point's share of the way along it (a corner's runs, joined by those shares, `stripShape.ts`
 *  ladderTriangles). */
function chainOf(run: readonly RunPoint[]): Chain {
  const s = [0];
  for (let i = 1; i < run.length; i++) s.push(s[i - 1]! + Math.hypot(run[i]!.x - run[i - 1]!.x, run[i]!.y - run[i - 1]!.y));
  const total = Math.max(1e-9, s[s.length - 1]!);
  return { xy: flat(run), s: Float64Array.from(s.map((v, i) => (i === s.length - 1 ? 1 : v / total))) };
}

/** A corner's kerb face: a wall along its kerb's line, facing the carriageway (the line's left, counter-clockwise round the plate), lit round its return. */
function faceOf(corner: Corner): Geom | null {
  if (corner.kerbWidth < LEAST_KERB || corner.kerb.length < 2) return null;
  const normals = new Float64Array(corner.kerb.length * 2);
  corner.kerb.forEach((p, i) => { normals[i * 2] = p.nx; normals[i * 2 + 1] = p.ny; });
  return { kind: 'face', run: chainOf(corner.kerb), group: FIXED, left: true, levels: levelsOf(corner.kerb), normals };
}

/** A corner's footway: its kerb's line, then its outer run back (the next leg's outer mouth corner, the footway's back corner, this leg's), one polygon;
 *  its mouths the two edges across the legs; walled on its outer side on a deck alone. A return as tight as the footway is wide closes its back on one
 *  point, both mouth corners there (`squareRun` cleaned): the kerb's line and that point. DO NOT ask two points of the back: such a corner (a local
 *  street's 3 m return under a 3 m footway) had none, and the terrain's grass showed through it (the owner, 2026-10-26). */
function footwayOf(corner: Corner): Geom | null {
  const outer = corner.sidewalk;
  if (!outer || outer.length < 1) return null;
  const ring = [...corner.kerb, ...[...outer].reverse()];
  const k = corner.kerb.length, count = ring.length;
  if (count < 3) return null;
  const mouths = new Uint8Array(count), deckWalls = new Uint8Array(count);
  // Edge k - 1 runs from the kerb's last point to the outer run's last (the next leg's mouth); the closing edge from the outer run's first back to the kerb's first (this leg's).
  mouths[k - 1] = 1; mouths[count - 1] = 1;
  for (let i = k; i < count - 1; i++) deckWalls[i] = 1;
  return {
    kind: 'poly', ring: flat(ring), walls: new Uint8Array(count), mouths, levels: levelsOf(ring), deckWalls,
    kerb: k, kerbWidth: corner.kerbWidth,
  };
}

/** A corner's deck edge (on a deck: the band past the footway, `roadSurfaceReads.ts` deckEdge): the strip from the footway's outer run to the
 *  deck's, joined by each point's share of the way round, its outer side the deck's face. */
function deckEdgeOf(corner: Corner): Geom | null {
  if (!corner.sidewalk || !corner.casing || corner.sidewalk.length < 2 || corner.casing.length < 2) return null;
  return {
    kind: 'strip', a: chainOf(corner.sidewalk), b: chainOf(corner.casing), group: FIXED, walls: 0, deckWalls: WALL_B,
    aLevels: levelsOf(corner.sidewalk), bLevels: levelsOf(corner.casing),
  };
}

/** The carriageway's junction of a node and every corner of it; null where it has no carriageway to draw. */
function junctionOf(net: Network, node: NodeId): { byLevel: ReadonlyMap<SurfaceLevel, Junction>; lead: Junction; corners: Corner[] } | null {
  const byLevel = net.junctions.get(node);
  const lead = byLevel?.get(Level.Asphalt as SurfaceLevel);
  if (!byLevel || !lead || lead.ring.isEmpty || lead.legs.length === 0) return null;
  return { byLevel, lead, corners: cornersOf(byLevel, lead) };
}

/** Every shape of a junction's surfaces (its paint aside, `roadSurfaceInputs.ts`), every level's points in them (`pieceGeom.ts` atLevel). */
export function junctionShapes(net: Network, node: NodeId): Shape[] {
  const made = junctionOf(net, node);
  if (!made) return [];
  const out: Shape[] = [];
  const plate = plateOf(made.lead, made.corners);
  if (plate) out.push({ slot: 'asphalt', geom: plate });
  for (const corner of made.corners) {
    const face = faceOf(corner), footway = footwayOf(corner), deckEdge = deckEdgeOf(corner);
    if (face) out.push({ slot: 'kerb', geom: face });
    if (footway) out.push({ slot: 'footway', geom: footway });
    if (deckEdge) out.push({ slot: 'deckEdge', geom: deckEdge });
  }
  return out;
}

/** A junction at the network's far level (`networkFarRoadsBuild.ts`), its points at that level (`COARSEST`): its carriageway's plate, and at each corner
 *  the polygon from its kerb's line to its outermost level's run (`FAR_OUTER`, a deck's `FAR_OUTER_DECK`), from mouth to mouth, where the roads' far
 *  strips end: an outline the far level cuts as the plate (ear clipping refined by edge flips), as the owner's road tool cuts its footway corner.
 *  No kerb face: under a pixel there. */
export function junctionFarShapes(net: Network, node: NodeId, deck: boolean): FarShape[] {
  const made = junctionOf(net, node);
  if (!made) return [];
  const out: FarShape[] = [];
  const plate = plateOf(made.lead, made.corners);
  const far = plate ? atLevel(plate, COARSEST) : null;
  if (far) out.push({ layer: 1, geom: far });
  const outer = (deck ? FAR_OUTER_DECK : FAR_OUTER).find((level) => { const j = made.byLevel.get(level); return j !== undefined && !j.ring.isEmpty; });
  if (outer === undefined) return out;
  for (const corner of made.corners) {
    const run = outer === Level.Casing ? corner.casing : outer === Level.Sidewalk ? corner.sidewalk : levelRun(made.byLevel.get(outer), corner.from, corner.to);
    if (!run || run.length < 2) continue;
    const ring = [...corner.kerb, ...[...run].reverse()];
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p.x; cy += p.y; }
    const casing = atLevel({ kind: 'fan', cx: cx / ring.length, cy: cy / ring.length, ring: flat(ring), walls: new Uint8Array(ring.length), levels: levelsOf(ring) }, COARSEST);
    if (casing) out.push({ layer: 0, geom: casing });
  }
  return out;
}
