import { hypot2 } from '@core/hypot';

/**
 * # A ROAD'S BANDS SWEPT ALONG IT
 *
 * A band of a road between two of its levels' edges (the kerb's face between the carriageway's edge and the kerb's, the footway between the kerb's
 * and the footway's...) is a strip: a ladder of stations across it, one quad between two stations, cut to two triangles. Shipped road tools build a
 * segment so, a cross-section swept along its centreline (Cities: Skylines' segment meshes, Unreal's spline meshes, EasyRoads3D, StreetGen:
 * `reports/Vias e mobiliário urbano otimizados.md`), never by uniting the roads' outlines and triangulating the union, which loses the road's frame
 * and fans slivers off every curve (Persson, humus.name 2009: the fan is the worst triangulation there is).
 *
 * The stations are the edges' own points and, where the surface leaves the chord between two stations by more than its tolerance (a vertical curve,
 * a tint's change), a station put at the middle, read at the quarters too (at an inflection the middle sits on the chord and the quarters do not):
 * a ruled surface is exact across, its only error is along it. Every band of a road takes the stations any of them asked (`roads/pieceMesh.ts`), so
 * two bands that share an edge have the same vertices on it: no crack between them.
 */

/** What a surface varies in, read at a point (`tileMesh.ts` surfaceSampler): each quantity, how far it may stand off its triangles' blend
 *  (`tolerance`) and the least stretch it is resolved to (`floor`). */
export interface Sampler {
  readonly size: number;
  readonly tolerance: readonly number[];
  readonly floor: readonly number[];
  /** The quantities read on the outline's edges only (a skirt's foot: under the surface it is never seen). */
  readonly outline?: readonly boolean[];
  sample(x: number, y: number, out: number[]): void;
}

/** One chain of a strip: its points (x, y pairs) and each point's arc length along its road's centreline. */
export interface Chain {
  readonly xy: Float64Array;
  readonly s: Float64Array;
}

/** A strip between two chains over the same stretch of their road, `a` the inner one. */
export interface Ladder {
  readonly a: Chain;
  readonly b: Chain;
}

/** The point of a chain at arc length `s` (on the edge between the two points either side of it, so it lies on the chain's own line). */
export function chainAt(c: Chain, s: number, out: [number, number] = [0, 0]): [number, number] {
  const n = c.s.length;
  if (s <= c.s[0]!) { out[0] = c.xy[0]!; out[1] = c.xy[1]!; return out; }
  if (s >= c.s[n - 1]!) { out[0] = c.xy[(n - 1) * 2]!; out[1] = c.xy[(n - 1) * 2 + 1]!; return out; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c.s[mid]! <= s) lo = mid; else hi = mid; }
  const span = c.s[hi]! - c.s[lo]!;
  const t = span > 0 ? (s - c.s[lo]!) / span : 0;
  out[0] = c.xy[lo * 2]! + (c.xy[hi * 2]! - c.xy[lo * 2]!) * t;
  out[1] = c.xy[lo * 2 + 1]! + (c.xy[hi * 2 + 1]! - c.xy[lo * 2 + 1]!) * t;
  return out;
}

/** A chain cut to [s0, s1]: its points inside, and a point on its line at each end. */
export function cutChain(c: Chain, s0: number, s1: number): Chain {
  const xy: number[] = [], s: number[] = [];
  const at: [number, number] = [0, 0];
  chainAt(c, s0, at); xy.push(at[0], at[1]); s.push(s0);
  for (let i = 0; i < c.s.length; i++) {
    const si = c.s[i]!;
    if (si <= s0 + 1e-9 || si >= s1 - 1e-9) continue;
    xy.push(c.xy[i * 2]!, c.xy[i * 2 + 1]!); s.push(si);
  }
  chainAt(c, s1, at); xy.push(at[0], at[1]); s.push(s1);
  return { xy: Float64Array.from(xy), s: Float64Array.from(s) };
}

/** A chain with a point at each of `added` inside its stretch (on its own line), its own points kept. */
export function withStations(c: Chain, added: readonly number[]): Chain {
  const first = c.s[0]!, last = c.s[c.s.length - 1]!;
  const extra = added.filter((s) => s > first + 1e-9 && s < last - 1e-9 && !c.s.includes(s));
  if (extra.length === 0) return c;
  const all = [...c.s, ...extra].sort((p, q) => p - q);
  const xy = new Float64Array(all.length * 2), at: [number, number] = [0, 0];
  let own = 0;
  all.forEach((s, i) => {
    if (own < c.s.length && c.s[own] === s) { xy[i * 2] = c.xy[own * 2]!; xy[i * 2 + 1] = c.xy[own * 2 + 1]!; own++; } else { chainAt(c, s, at); xy[i * 2] = at[0]; xy[i * 2 + 1] = at[1]; }
  });
  return { xy, s: Float64Array.from(all) };
}

/** The chain `u` of the way from `a` to `b` across, at every station either has over the stretch both share or reach (`chainAt` holds an end). */
export function chainBetween(a: Chain, b: Chain, u: number): Chain {
  const all = [...new Set([...a.s, ...b.s])].sort((p, q) => p - q);
  const xy = new Float64Array(all.length * 2), pa: [number, number] = [0, 0], pb: [number, number] = [0, 0];
  all.forEach((s, i) => {
    chainAt(a, s, pa); chainAt(b, s, pb);
    xy[i * 2] = pa[0] + (pb[0] - pa[0]) * u; xy[i * 2 + 1] = pa[1] + (pb[1] - pa[1]) * u;
  });
  return { xy, s: Float64Array.from(all) };
}

/**
 * Where a strip's surface leaves its chords (the module's head): between each two stations its readings at the quarters and the middle, on both
 * chains and across the middle, weighed against the blend of the stations either side, each quantity over its own tolerance and only over a stretch
 * longer than its floor (`Sampler`); a stretch off by more is cut at its middle, both halves read again. The stations it would add.
 */
export function stationsOf(l: Ladder, sampler: Sampler, budget = 4096): number[] {
  const size = sampler.size;
  const scratch: number[] = [];
  const pa: [number, number] = [0, 0], pb: [number, number] = [0, 0];
  /** The readings of a station: on chain a, on chain b, and across the middle. */
  const read = (s: number): Float64Array => {
    const out = new Float64Array(size * 3);
    chainAt(l.a, s, pa); chainAt(l.b, s, pb);
    sampler.sample(pa[0], pa[1], scratch); for (let k = 0; k < size; k++) out[k] = scratch[k]!;
    sampler.sample(pb[0], pb[1], scratch); for (let k = 0; k < size; k++) out[size + k] = scratch[k]!;
    sampler.sample((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, scratch); for (let k = 0; k < size; k++) out[size * 2 + k] = scratch[k]!;
    return out;
  };
  /** The longer of the two chains' chords over a stretch: what a quantity's floor is set against. */
  const spanOf = (s: number, t: number): number => {
    const a0 = chainAt(l.a, s, [0, 0]), a1 = chainAt(l.a, t, [0, 0]), b0 = chainAt(l.b, s, [0, 0]), b1 = chainAt(l.b, t, [0, 0]);
    return Math.max(hypot2(a1[0] - a0[0], a1[1] - a0[1]), hypot2(b1[0] - b0[0], b1[1] - b0[1]));
  };
  const leaves = (s: number, t: number, rs: Float64Array, rt: Float64Array): boolean => {
    const span = spanOf(s, t);
    for (const f of [0.25, 0.5, 0.75]) {
      const got = read(s + (t - s) * f);
      for (let column = 0; column < 3; column++) {
        for (let k = 0; k < size; k++) {
          if (span <= sampler.floor[k]!) continue;
          // A quantity read on the outline alone (a skirt's foot) is not read across the middle.
          if (column === 2 && sampler.outline?.[k]) continue;
          const at = column * size + k;
          const blend = rs[at]! + (rt[at]! - rs[at]!) * f;
          if (Math.abs(got[at]! - blend) > sampler.tolerance[k]!) return true;
        }
      }
    }
    return false;
  };
  // Every station of either chain, in order.
  const stations = [...new Set([...l.a.s, ...l.b.s])].sort((p, q) => p - q);
  const added: number[] = [];
  let left = budget;
  const visit = (s: number, t: number, rs: Float64Array, rt: Float64Array, depth: number): void => {
    if (left <= 0 || depth > 16 || !leaves(s, t, rs, rt)) return;
    const mid = (s + t) / 2, rm = read(mid);
    added.push(mid);
    left--;
    visit(s, mid, rs, rm, depth + 1);
    visit(mid, t, rm, rt, depth + 1);
  };
  let rs = read(stations[0]!);
  for (let i = 0; i + 1 < stations.length; i++) {
    const s = stations[i]!, t = stations[i + 1]!;
    if (t - s < 1e-6) continue;
    const rt = read(t);
    visit(s, t, rs, rt, 0);
    rs = rt;
  }
  return added;
}

/**
 * Where a chain's own height leaves its chords: between each two of its points, `top` read at the quarters and the middle against the chord, over a
 * stretch longer than `floor`; a stretch off by more than `tolerance` cut at its middle and both halves read again. The stations it would add. A
 * function of the chain and the heights alone, so whatever asks it gets the same numbers: the edge two meshes meet on takes the same vertices in
 * both (a ground road's outer edge and the terrain cut to it, `roads/pieceMesh.ts`, `terrainSeams.ts`).
 */
export function edgeStations(c: Chain, top: (x: number, y: number) => number, tolerance: number, floor: number): number[] {
  const p: [number, number] = [0, 0], q: [number, number] = [0, 0];
  const height = (s: number): number => { chainAt(c, s, p); return top(p[0], p[1]); };
  const added: number[] = [];
  const visit = (s: number, t: number, hs: number, ht: number, depth: number): void => {
    if (depth > 16) return;
    chainAt(c, s, p); chainAt(c, t, q);
    if (hypot2(q[0] - p[0], q[1] - p[1]) <= floor) return;
    let leaves = false;
    for (const f of [0.25, 0.5, 0.75]) if (Math.abs(height(s + (t - s) * f) - (hs + (ht - hs) * f)) > tolerance) { leaves = true; break; }
    if (!leaves) return;
    const mid = (s + t) / 2, hm = height(mid);
    added.push(mid);
    visit(s, mid, hs, hm, depth + 1);
    visit(mid, t, hm, ht, depth + 1);
  };
  for (let i = 0; i + 1 < c.s.length; i++) {
    const s = c.s[i]!, t = c.s[i + 1]!;
    if (t - s < 1e-6) continue;
    visit(s, t, height(s), height(t), 0);
  }
  return added;
}

/** Which diagonal a strip's quads are cut along (`ladderTriangles`): from a chain-a point to the next b point (1), or from the next a point to the
 *  b point (2); none, the shorter. A surface of two planes meeting along a known crease (a dropped kerb's flare, `roads/segmentPiece.ts`) is cut
 *  along it, exactly. */
export type Diagonal = 1 | 2;

/**
 * A strip's triangles: chain a's points, then chain b's, joined station by station, whichever chain's next station comes first advancing (the two
 * chains of a curve have their points at different stations: the outer edge's arc is longer). Where both advance together the quad is cut along its
 * shorter diagonal, or the one `diagonal` asks.
 */
export function ladderTriangles(l: Ladder, diagonal?: Diagonal): { xy: Float64Array; tris: Uint32Array } {
  const na = l.a.s.length, nb = l.b.s.length;
  const xy = new Float64Array((na + nb) * 2);
  xy.set(l.a.xy, 0); xy.set(l.b.xy, na * 2);
  const tris: number[] = [];
  const len = (p: number, q: number): number => hypot2(xy[p * 2]! - xy[q * 2]!, xy[p * 2 + 1]! - xy[q * 2 + 1]!);
  let i = 0, j = 0;
  while (i < na - 1 || j < nb - 1) {
    const ai = i, bj = na + j;
    const nextA = i < na - 1 ? l.a.s[i + 1]! : Infinity, nextB = j < nb - 1 ? l.b.s[j + 1]! : Infinity;
    if (Math.abs(nextA - nextB) <= 1e-9) {
      const a1 = ai + 1, b1 = bj + 1;
      if (diagonal === 1 || (diagonal === undefined && len(ai, b1) <= len(a1, bj))) tris.push(ai, a1, b1, ai, b1, bj); else tris.push(ai, a1, bj, a1, b1, bj);
      i++; j++;
    } else if (nextA < nextB) { tris.push(ai, ai + 1, bj); i++; } else { tris.push(ai, na + j + 1, bj); j++; }
  }
  return { xy, tris: Uint32Array.from(tris) };
}
