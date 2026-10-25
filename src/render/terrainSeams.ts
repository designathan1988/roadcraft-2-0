import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { cellHeight } from '@world/groundPatch';

/**
 * # THE TERRAIN MET BY THE SURFACES LAID ON IT, ON THEIR OWN VERTICES
 *
 * The terrain is a grid of 10 m cells (`terrainGrid.ts`), its corners on the universal grid's lines (`world/grid.ts`). A road's footway, a lot's
 * paving, lie on it with edges anywhere: across a cell, on a slant, round a curve. The cells such an edge touches are cut along it, as a TIN takes a
 * breakline (ESRI, "Breaklines in surface models": https://pro.arcgis.com/en/pro-app/latest/help/data/tin/breaklines-in-surface-models.htm): a
 * Delaunay triangulation of the cells' corners and the edge's own points, constrained to keep every edge and every side a cut cell shares with a
 * cell left whole (Delaunator 5.1, https://github.com/mapbox/delaunator, and Constrainautor 4.1, https://github.com/kninnug/Constrainautor, both
 * ISC). The terrain's own patches leave the cut cells out (`terrainLod.ts` hole mask) and this mesh draws them: never two surfaces in one place.
 *
 * - A HARD surface (a road at grade) is given as the triangles it draws: the terrain under them is cut away, and it meets their union's outline,
 *   vertex for vertex and height for height, with no band of grass laid over it (the verge that was) and no wall hung from it.
 * - A SOFT surface (a lot's paving) is given as its outline at the height of the ground graded under it (`world/buildings/pads.ts` padLevelAt):
 *   the terrain meets its edges and stays under it, so its plate stands its own thickness over the ground all round, on a slope as on the flat.
 * - Each patch of the terrain's nearest level (`terrainLevels.ts` LOD_PATCH cells a side) is cut apart, its sides kept: a triangle lies in one
 *   patch, drawn when its patch is drawn at that level. A point where an edge crosses a patch's side is worked out alike from either side
 *   (`clip`), so the two patches meet on it.
 * - A corner of the grid keeps the height the terrain gives it, read by the shader from the terrain's own texels (`terrainLod.ts` seamVertex);
 *   a point of an edge, and a corner an edge runs through, the surface's height there (where two edges meet with two heights, the lower: the
 *   terrain is never left over a surface's edge).
 * Pure: no three, no DOM: made on the page or in a worker alike.
 */

/** A plate's grid of corners in its own frame (centred on 0, 0; x east, y north): `n` a side, corner `i` at `ix + iy * n`, rows from +y down
 *  (`terrain.ts`). */
export interface SeamGrid {
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  /** A corner's height as the terrain draws it. */
  corner(i: number): number;
  /** A cell's diagonal as the terrain draws it (`groundPatch.ts` cellDiagonal: 1 the a-c one). */
  diagonal(cell: number): number;
}

/** The surfaces laid on the ground round a plate, in the plate's frame. */
export interface SeamOutline {
  /** Hard surfaces as the triangles they draw: x, y, h of three corners each (9 numbers a triangle). The terrain is cut away under them. */
  readonly hard: readonly Float64Array[];
  /** Soft surfaces as closed outlines, x, y, h a point (no point repeated at the end): the terrain meets their edges and stays under them. */
  readonly soft: readonly Float64Array[];
}

/** Where the surfaces laid on the ground are read for a world box ([x0, y0, x1, y1]), in world coordinates (`flatAtlas.ts` asks each plate's own). */
export type SeamSource = (rect: readonly [number, number, number, number]) => SeamOutline;

/** The terrain of one patch's cut cells. */
interface PatchSeam {
  /** Its cut cells (`ix + iy * (n - 1)`), ascending. */
  readonly cells: Uint32Array;
  /** Each cut cell's farthest point off the grid's own surface there, metres: what a coarser level, which draws the grid, is off by. */
  readonly errors: Float32Array;
  /** Each vertex: x, height, -y in the plate's frame (three's axes, as `terrain.ts` lays its corners). */
  readonly positions: Float32Array;
  /** Each vertex's normal as built (an edge's point keeps it; a corner's is read from the terrain's texels as the grid moves). */
  readonly normals: Float32Array;
  /** Each vertex's corner of the grid (`ix + iy * n`), or -1 for an edge's point: a corner moves as the terrain's levels move it. */
  readonly corners: Int32Array;
  readonly index: Uint32Array;
}

/** A plate's cut cells, patch by patch (`px + py * patches`). */
export type PlateSeams = Map<number, PatchSeam>;

/** Points nearer than this are one, metres (a float's millimetre at 10 km is 1e-3: a hundred times finer). */
const MERGE = 1e-5;
/** A point this near a constraint's line, inside it, splits it (Constrainautor: no constraint may pass through a point). */
const ON_LINE = 1e-6;
/** How far past an edge of a hard triangle its outside is looked at for another triangle (`outlineEdges`): over the floats' millimetre a world's
 *  coordinates carry (`Float32Array` at 8 km), under any band a road is drawn with. */
const OUTSIDE = 5e-3;
/** Least twice-area of a hard triangle read, square metres: a road's wall (a kerb's face) has none on the plan. */
const LEAST_AREA = 1e-8;

/** Hard triangles filed by the cells their boxes reach, for `inside`. */
export class TriangleIndex {
  private readonly cells = new Map<number, number[]>();
  /** Every triangle read: x, y of its three corners (6 a triangle), counter-clockwise. */
  readonly xy: Float64Array;
  /** Their heights, three a triangle. */
  readonly h: Float64Array;
  readonly count: number;

  constructor(hard: readonly Float64Array[], private readonly cell: number) {
    let total = 0;
    for (const soup of hard) total += Math.floor(soup.length / 9);
    const xy = new Float64Array(total * 6), h = new Float64Array(total * 3);
    let count = 0;
    for (const soup of hard) {
      for (let t = 0; t + 8 < soup.length; t += 9) {
        const ax = soup[t]!, ay = soup[t + 1]!, bx = soup[t + 3]!, by = soup[t + 4]!, cx = soup[t + 6]!, cy = soup[t + 7]!;
        const twice = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (!(Math.abs(twice) > LEAST_AREA)) continue;
        // Counter-clockwise: b and c swapped where the triangle runs the other way.
        const [p, q] = twice > 0 ? [3, 6] : [6, 3];
        xy[count * 6] = ax; xy[count * 6 + 1] = ay; h[count * 3] = soup[t + 2]!;
        xy[count * 6 + 2] = soup[t + p]!; xy[count * 6 + 3] = soup[t + p + 1]!; h[count * 3 + 1] = soup[t + p + 2]!;
        xy[count * 6 + 4] = soup[t + q]!; xy[count * 6 + 5] = soup[t + q + 1]!; h[count * 3 + 2] = soup[t + q + 2]!;
        const i0 = Math.floor(Math.min(ax, bx, cx) / cell), i1 = Math.floor(Math.max(ax, bx, cx) / cell);
        const j0 = Math.floor(Math.min(ay, by, cy) / cell), j1 = Math.floor(Math.max(ay, by, cy) / cell);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const key = keyOf(i, j);
            const list = this.cells.get(key);
            if (list) list.push(count); else this.cells.set(key, [count]);
          }
        }
        count++;
      }
    }
    this.xy = xy;
    this.h = h;
    this.count = count;
  }

  /** Whether a point lies inside some triangle or on its edges (a terrain triangle's middle on a road's own diagonal is under the road; one is never
   *  on the outline, which every terrain triangle lies wholly beside). */
  inside(x: number, y: number): boolean {
    const list = this.cells.get(keyOf(Math.floor(x / this.cell), Math.floor(y / this.cell)));
    if (!list) return false;
    const xy = this.xy;
    for (const t of list) {
      const o = t * 6;
      const ax = xy[o]!, ay = xy[o + 1]!, bx = xy[o + 2]!, by = xy[o + 3]!, cx = xy[o + 4]!, cy = xy[o + 5]!;
      if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0 && (cx - bx) * (y - by) - (cy - by) * (x - bx) >= 0 && (ax - cx) * (y - cy) - (ay - cy) * (x - cx) >= 0) return true;
    }
    return false;
  }
}

const keyOf = (i: number, j: number): number => (i + 1_048_576) * 2_097_152 + (j + 1_048_576);

/**
 * The edges the terrain meets, x0, y0, h0, x1, y1, h1 each: every edge of a hard triangle whose outside, just past its middle, is under no hard
 * triangle (the outline of their union: an edge two triangles share, or a mouth two pieces share, is inside it), and every edge of a soft outline
 * whose middle is under no hard triangle (a lot's edge under a road's footway is the road's).
 */
export function outlineEdges(outline: SeamOutline, hard: TriangleIndex): Float64Array {
  const out: number[] = [];
  const xy = hard.xy, h = hard.h;
  for (let t = 0; t < hard.count; t++) {
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      const ax = xy[t * 6 + a * 2]!, ay = xy[t * 6 + a * 2 + 1]!, bx = xy[t * 6 + b * 2]!, by = xy[t * 6 + b * 2 + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < MERGE) continue;
      // Counter-clockwise: the outside is on the right of a -> b.
      const nx = (by - ay) / len, ny = -(bx - ax) / len;
      if (hard.inside((ax + bx) / 2 + nx * OUTSIDE, (ay + by) / 2 + ny * OUTSIDE)) continue;
      out.push(ax, ay, h[t * 3 + a]!, bx, by, h[t * 3 + b]!);
    }
  }
  for (const ring of outline.soft) {
    const count = Math.floor(ring.length / 3);
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const ax = ring[i * 3]!, ay = ring[i * 3 + 1]!, bx = ring[j * 3]!, by = ring[j * 3 + 1]!;
      if (Math.hypot(bx - ax, by - ay) < MERGE || hard.inside((ax + bx) / 2, (ay + by) / 2)) continue;
      out.push(ax, ay, ring[i * 3 + 2]!, bx, by, ring[j * 3 + 2]!);
    }
  }
  return Float64Array.from(out);
}

/** The cells a segment meets (its own cells and every cell it touches, sides and corners included), in a grid's cell frame (`seg` cells a side). */
function cellsOfSegment(ax: number, ay: number, bx: number, by: number, seg: number, out: (cell: number) => void): void {
  const eps = 1e-9;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - eps)), x1 = Math.min(seg - 1, Math.floor(Math.max(ax, bx) + eps));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - eps)), y1 = Math.min(seg - 1, Math.floor(Math.max(ay, by) + eps));
  const dx = bx - ax, dy = by - ay;
  const tol = eps * (Math.abs(dx) + Math.abs(dy) + 1);
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      // The segment's line meets the cell's square (sides included): the square's corners are not all on one side of it.
      const s0 = dx * (j - ay) - dy * (i - ax), s1 = dx * (j - ay) - dy * (i + 1 - ax);
      const s2 = dx * (j + 1 - ay) - dy * (i + 1 - ax), s3 = dx * (j + 1 - ay) - dy * (i - ax);
      if (Math.min(s0, s1, s2, s3) > tol || Math.max(s0, s1, s2, s3) < -tol) continue;
      out(i + j * seg);
    }
  }
}

/** A segment cut to a box, its ends in one order (by x, then y) whatever its own, so the two boxes either side of a line cut it at the same point. */
function clip(ax: number, ay: number, ah: number, bx: number, by: number, bh: number, x0: number, y0: number, x1: number, y1: number): number[] | null {
  if (ax > bx || (ax === bx && ay > by)) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; [ah, bh] = [bh, ah]; }
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as const) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  if (t1 - t0 <= 0) return null;
  const at = (t: number): [number, number, number] => t === 0 ? [ax, ay, ah] : t === 1 ? [bx, by, bh] : [ax + dx * t, ay + dy * t, ah + (bh - ah) * t];
  return [...at(t0), ...at(t1)];
}

/** One patch's points and constraints as they are gathered (`patchSeam`). */
class Gather {
  readonly x: number[] = [];
  readonly y: number[] = [];
  /** An edge's point: the lowest height an edge through it gives it; a corner's: its own. */
  readonly h: number[] = [];
  /** The grid's corner a point is (`ix + iy * n`), or -1. */
  readonly corner: number[] = [];
  /** Whether an edge runs through the point: its height is the edge's, not the corner's. */
  readonly onEdge: boolean[] = [];
  private readonly keys = new Map<string, number>();
  /** Constraints: two point ids each, `edge` an outline's (else a cell's side). */
  readonly segs: [number, number, boolean][] = [];

  point(x: number, y: number, h: number, corner: number): number {
    const key = `${Math.round(x / MERGE)},${Math.round(y / MERGE)}`;
    const at = this.keys.get(key);
    if (at !== undefined) {
      if (corner >= 0) { this.corner[at] = corner; if (!this.onEdge[at]) this.h[at] = h; } else this.edgeHeight(at, h);
      return at;
    }
    const id = this.x.length;
    this.x.push(x); this.y.push(y); this.h.push(h); this.corner.push(corner); this.onEdge.push(corner < 0);
    this.keys.set(key, id);
    return id;
  }

  /** An edge through point `at` at height `h`: the point takes the edge's height, the lowest of every edge through it. */
  edgeHeight(at: number, h: number): void {
    this.h[at] = this.onEdge[at] ? Math.min(this.h[at]!, h) : h;
    this.onEdge[at] = true;
  }
}

/** The intersection of segments p0-p1 and q0-q1 strictly inside both, as a share along p; null where they do not cross there. */
function crossing(px0: number, py0: number, px1: number, py1: number, qx0: number, qy0: number, qx1: number, qy1: number): number | null {
  const rx = px1 - px0, ry = py1 - py0, sx = qx1 - qx0, sy = qy1 - qy0;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((qx0 - px0) * sy - (qy0 - py0) * sx) / den, u = ((qx0 - px0) * ry - (qy0 - py0) * rx) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? t : null;
}

/** What `plateSeams` reads once for every patch it cuts. */
interface SeamWork {
  readonly grid: SeamGrid;
  readonly patch: number;
  readonly patches: number;
  readonly hard: TriangleIndex;
  readonly edges: Float64Array;
  /** The outline's edges by the patches their boxes reach. */
  readonly edgesOf: Map<number, number[]>;
}

/**
 * The cut cells of a plate (`PlateSeams`): every cell an edge of `outline` touches, triangulated patch by patch with the outline's edges and the
 * cut cells' sides to whole cells kept, the triangles under a hard surface left out. `patch`: cells a side of a patch (`terrainLevels.ts`
 * LOD_PATCH); `only`: the patches to cut (null: every patch an edge touches).
 */
export function plateSeams(grid: SeamGrid, outline: SeamOutline, patch: number, only: ReadonlySet<number> | null = null): PlateSeams {
  const seg = grid.n - 1, cell = grid.cell, half = grid.half;
  const patches = Math.ceil(seg / patch);
  const hard = new TriangleIndex(outline.hard, cell);
  const edges = outlineEdges(outline, hard);
  const gx = (x: number): number => (x + half) / cell, gy = (y: number): number => (half - y) / cell;
  const cutOf = new Map<number, number[]>();
  const seen = new Set<number>();
  const take = (c: number): void => {
    if (seen.has(c)) return;
    seen.add(c);
    const i = c % seg, j = (c - i) / seg;
    const p = Math.floor(i / patch) + Math.floor(j / patch) * patches;
    if (only && !only.has(p)) return;
    const list = cutOf.get(p);
    if (list) list.push(c); else cutOf.set(p, [c]);
  };
  const edgesOf = new Map<number, number[]>();
  for (let e = 0; e + 5 < edges.length; e += 6) {
    const ax = gx(edges[e]!), ay = gy(edges[e + 1]!), bx = gx(edges[e + 3]!), by = gy(edges[e + 4]!);
    cellsOfSegment(ax, ay, bx, by, seg, take);
    // Its box's patches, a hair round (an edge on a patch's side is cut to both patches).
    const i0 = Math.floor((Math.min(ax, bx) - 1e-9) / patch), i1 = Math.floor((Math.max(ax, bx) + 1e-9) / patch);
    const j0 = Math.floor((Math.min(ay, by) - 1e-9) / patch), j1 = Math.floor((Math.max(ay, by) + 1e-9) / patch);
    for (let pi = Math.max(0, i0); pi <= Math.min(patches - 1, i1); pi++) {
      for (let pj = Math.max(0, j0); pj <= Math.min(patches - 1, j1); pj++) {
        const p = pi + pj * patches;
        const list = edgesOf.get(p);
        if (list) list.push(e); else edgesOf.set(p, [e]);
      }
    }
  }
  const work: SeamWork = { grid, patch, patches, hard, edges, edgesOf };
  const out: PlateSeams = new Map();
  for (const [p, cells] of cutOf) out.set(p, patchSeam(work, p, cells.sort((a, b) => a - b)));
  return out;
}

/** One patch's cut cells triangulated (`plateSeams`). */
function patchSeam(work: SeamWork, p: number, cells: readonly number[]): PatchSeam {
  const { grid, patch, patches, hard, edges } = work;
  const n = grid.n, seg = n - 1, cell = grid.cell, half = grid.half;
  const gx = (x: number): number => (x + half) / cell, gy = (y: number): number => (half - y) / cell;
  const wx = (i: number): number => -half + i * cell, wy = (j: number): number => half - j * cell;
  const pi = p % patches, pj = (p - pi) / patches;
  const own = new Set(cells);
  const g = new Gather();
  const cornerPoint = (i: number, j: number): number => g.point(wx(i), wy(j), grid.corner(i + j * n), i + j * n);
  // The cut cells' corners, and each side a cut cell shares with a whole cell or another patch: a constraint between two corners.
  const kept = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < seg && j < seg && own.has(i + j * seg);
  for (const c of cells) {
    const i = c % seg, j = (c - i) / seg;
    const a = cornerPoint(i, j), b = cornerPoint(i, j + 1), cc = cornerPoint(i + 1, j + 1), d = cornerPoint(i + 1, j);
    if (!kept(i - 1, j)) g.segs.push([a, b, false]);
    if (!kept(i, j + 1)) g.segs.push([b, cc, false]);
    if (!kept(i + 1, j)) g.segs.push([cc, d, false]);
    if (!kept(i, j - 1)) g.segs.push([d, a, false]);
  }
  // The outline's edges, cut to the patch's square.
  const bx0 = wx(pi * patch), bx1 = wx(Math.min(seg, (pi + 1) * patch)), by1 = wy(pj * patch), by0 = wy(Math.min(seg, (pj + 1) * patch));
  for (const e of work.edgesOf.get(p) ?? []) {
    const c = clip(edges[e]!, edges[e + 1]!, edges[e + 2]!, edges[e + 3]!, edges[e + 4]!, edges[e + 5]!, bx0, by0, bx1, by1);
    if (!c) continue;
    const a = g.point(c[0]!, c[1]!, c[2]!, -1), b = g.point(c[3]!, c[4]!, c[5]!, -1);
    if (a !== b) g.segs.push([a, b, true]);
  }
  // Two outlines crossing (a lot's edge under a road's, two roads' overlapping): both cut at the crossing, at the lower of their heights there.
  const outlineSegs = g.segs.filter((s) => s[2]);
  const along = (u: number, v: number, x: number, y: number): number => {
    const l2 = (g.x[v]! - g.x[u]!) ** 2 + (g.y[v]! - g.y[u]!) ** 2;
    const t = l2 > 0 ? ((x - g.x[u]!) * (g.x[v]! - g.x[u]!) + (y - g.y[u]!) * (g.y[v]! - g.y[u]!)) / l2 : 0;
    return g.h[u]! + (g.h[v]! - g.h[u]!) * t;
  };
  for (let s = 0; s < outlineSegs.length; s++) {
    for (let t = s + 1; t < outlineSegs.length; t++) {
      const [a, b] = outlineSegs[s]!, [c, d] = outlineSegs[t]!;
      const share = crossing(g.x[a]!, g.y[a]!, g.x[b]!, g.y[b]!, g.x[c]!, g.y[c]!, g.x[d]!, g.y[d]!);
      if (share === null) continue;
      const x = g.x[a]! + (g.x[b]! - g.x[a]!) * share, y = g.y[a]! + (g.y[b]! - g.y[a]!) * share;
      g.point(x, y, Math.min(along(a, b, x, y), along(c, d, x, y)), -1);
    }
  }
  // Every constraint cut at every point on its line inside it, the same piece of line once; a point on an outline's edge takes its height.
  const split: [number, number][] = [];
  const pieces = new Set<string>();
  for (const [a, b, isEdge] of g.segs) {
    const ax = g.x[a]!, ay = g.y[a]!, dx = g.x[b]! - ax, dy = g.y[b]! - ay, l2 = dx * dx + dy * dy;
    if (l2 <= 0) continue;
    const ha = g.h[a]!, hb = g.h[b]!;
    const on: [number, number][] = [];
    for (let k = 0; k < g.x.length; k++) {
      if (k === a || k === b) continue;
      const t = ((g.x[k]! - ax) * dx + (g.y[k]! - ay) * dy) / l2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      if (Math.hypot(ax + dx * t - g.x[k]!, ay + dy * t - g.y[k]!) > ON_LINE) continue;
      on.push([t, k]);
      if (isEdge) g.edgeHeight(k, ha + (hb - ha) * t);
    }
    on.sort((u, v) => u[0] - v[0]);
    const chain = [a, ...on.map((o) => o[1]), b];
    for (let k = 0; k + 1 < chain.length; k++) {
      const u = chain[k]!, v = chain[k + 1]!;
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (u === v || pieces.has(key)) continue;
      pieces.add(key);
      split.push([u, v]);
    }
  }
  const coords = new Float64Array(g.x.length * 2);
  for (let k = 0; k < g.x.length; k++) { coords[k * 2] = g.x[k]!; coords[k * 2 + 1] = g.y[k]!; }
  const del = new Delaunator(coords);
  new Constrainautor(del, split);
  // The triangles kept: in a cut cell of this patch, under no hard surface.
  const used = new Int32Array(g.x.length).fill(-1);
  const vertices: number[] = [];
  const index: number[] = [];
  const tris = del.triangles;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!;
    const mx = (g.x[a]! + g.x[b]! + g.x[c]!) / 3, my = (g.y[a]! + g.y[b]! + g.y[c]!) / 3;
    const ci = Math.floor(gx(mx)), cj = Math.floor(gy(my));
    if (!kept(ci, cj) || hard.inside(mx, my)) continue;
    // Delaunator's triangles turn clockwise with y north (its README's "counterclockwise" is with y down, a screen's: [0, 2, 1] for (0, 0),
    // (1, 0), (0, 1)); a face seen from above is three's front when it turns counter-clockwise with y north: a, c, b.
    for (const v of [a, c, b]) {
      if (used[v]! < 0) { used[v] = vertices.length; vertices.push(v); }
      index.push(used[v]!);
    }
  }
  const count = vertices.length;
  const positions = new Float32Array(count * 3), corners = new Int32Array(count), normals = new Float32Array(count * 3);
  const errors = new Float32Array(cells.length);
  const groundAt = (x: number, y: number): number => {
    const fx = gx(x), fy = gy(y);
    const i = Math.min(seg - 1, Math.max(0, Math.floor(fx))), j = Math.min(seg - 1, Math.max(0, Math.floor(fy)));
    return cellHeight(grid.corner(i + j * n), grid.corner(i + (j + 1) * n), grid.corner(i + 1 + (j + 1) * n), grid.corner(i + 1 + j * n), fx - i, fy - j, grid.diagonal(i + j * seg));
  };
  vertices.forEach((v, k) => {
    positions[k * 3] = g.x[v]!; positions[k * 3 + 1] = g.h[v]!; positions[k * 3 + 2] = -g.y[v]!;
    corners[k] = g.onEdge[v] ? -1 : g.corner[v]!;
    if (!g.onEdge[v]) return;
    // How far the terrain here stands off the grid's own surface: in every cut cell the point is a corner of.
    const off = Math.abs(g.h[v]! - groundAt(g.x[v]!, g.y[v]!));
    const fx = gx(g.x[v]!), fy = gy(g.y[v]!);
    for (const ci of [Math.floor(fx - 1e-9), Math.floor(fx + 1e-9)]) {
      for (const cj of [Math.floor(fy - 1e-9), Math.floor(fy + 1e-9)]) {
        if (!kept(ci, cj)) continue;
        const at = binarySearch(cells, ci + cj * seg);
        if (at >= 0 && off > errors[at]!) errors[at] = off;
      }
    }
  });
  // Each vertex's normal, its triangles' summed by their areas (three's computeVertexNormals: the cross product's length is twice the area).
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]! * 3, b = index[t + 1]! * 3, c = index[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { normals[o] = normals[o]! + nx; normals[o + 1] = normals[o + 1]! + ny; normals[o + 2] = normals[o + 2]! + nz; }
  }
  for (let k = 0; k < count; k++) {
    const len = Math.hypot(normals[k * 3]!, normals[k * 3 + 1]!, normals[k * 3 + 2]!);
    if (len > 0) { normals[k * 3] = normals[k * 3]! / len; normals[k * 3 + 1] = normals[k * 3 + 1]! / len; normals[k * 3 + 2] = normals[k * 3 + 2]! / len; }
    else normals[k * 3 + 1] = 1;
  }
  return { cells: Uint32Array.from(cells), errors, positions, normals, corners, index: Uint32Array.from(index) };
}

/** Where `value` stands in an ascending list, or -1. */
function binarySearch(list: ArrayLike<number>, value: number): number {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, v = list[mid]!;
    if (v === value) return mid;
    if (v < value) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** A plate's cut cells as one mesh: every patch's vertices one after the other, each with its patch (`terrainLod.ts` seamVertex draws a triangle
 *  only when its patch is drawn at the nearest level), and the cells in one ascending list with their errors and their triangles (`seamHeightAt`). */
export interface JoinedSeams {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Each vertex: its corner's column and row (-1, -1 for an edge's point) and its patch: what the shader places it by. */
  readonly seam: Float32Array;
  readonly index: Uint32Array;
  /** Every cut cell, ascending, with its error. */
  readonly cells: Uint32Array;
  readonly errors: Float32Array;
  /** Each cut cell's triangles (every one whose box reaches it): `cellTris` from `cellStart[k]` to `cellStart[k + 1]`, triangles of `index`. */
  readonly cellStart: Uint32Array;
  readonly cellTris: Uint32Array;
}

/** The patches' seams as one mesh (`JoinedSeams`). */
export function joinSeams(seams: PlateSeams, grid: Pick<SeamGrid, 'n' | 'cell' | 'half'>): JoinedSeams {
  const n = grid.n, seg = n - 1;
  let vertices = 0, indices = 0, cellCount = 0;
  for (const s of seams.values()) { vertices += s.corners.length; indices += s.index.length; cellCount += s.cells.length; }
  const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3), seam = new Float32Array(vertices * 3);
  const index = new Uint32Array(indices);
  const cellList: [number, number][] = [];
  let v = 0, o = 0;
  for (const p of [...seams.keys()].sort((a, b) => a - b)) {
    const s = seams.get(p)!;
    positions.set(s.positions, v * 3);
    normals.set(s.normals, v * 3);
    for (let k = 0; k < s.corners.length; k++) {
      const c = s.corners[k]!;
      seam[(v + k) * 3] = c < 0 ? -1 : c % n;
      seam[(v + k) * 3 + 1] = c < 0 ? -1 : Math.floor(c / n);
      seam[(v + k) * 3 + 2] = p;
    }
    for (let k = 0; k < s.index.length; k++) index[o + k] = s.index[k]! + v;
    o += s.index.length;
    v += s.corners.length;
    s.cells.forEach((c, k) => cellList.push([c, s.errors[k]!]));
  }
  cellList.sort((a, b) => a[0] - b[0]);
  const cells = Uint32Array.from(cellList, (c) => c[0]), errors = Float32Array.from(cellList, (c) => c[1]);
  // Each triangle filed under every cut cell its box reaches: a cut region's triangles are not held to one cell (only its sides to whole cells, a
  // patch's sides and the outline are kept), so a point is looked for in each triangle that may hold it.
  const triangles = indices / 3;
  const reach = (t: number, take: (at: number) => void): void => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k]! * 3;
      x0 = Math.min(x0, positions[v]!); x1 = Math.max(x1, positions[v]!);
      z0 = Math.min(z0, positions[v + 2]!); z1 = Math.max(z1, positions[v + 2]!);
    }
    const i0 = Math.max(0, Math.floor((x0 + grid.half) / grid.cell - 1e-6)), i1 = Math.min(seg - 1, Math.floor((x1 + grid.half) / grid.cell + 1e-6));
    const j0 = Math.max(0, Math.floor((z0 + grid.half) / grid.cell - 1e-6)), j1 = Math.min(seg - 1, Math.floor((z1 + grid.half) / grid.cell + 1e-6));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const at = binarySearch(cells, i + j * seg); if (at >= 0) take(at); }
  };
  const counts = new Uint32Array(cellCount + 1);
  for (let t = 0; t < triangles; t++) reach(t, (at) => { counts[at + 1] = counts[at + 1]! + 1; });
  for (let k = 0; k < cellCount; k++) counts[k + 1] = counts[k + 1]! + counts[k]!;
  const cellStart = counts.slice();
  const fill = counts.slice(0, cellCount);
  const cellTris = new Uint32Array(cellStart[cellCount]!);
  for (let t = 0; t < triangles; t++) reach(t, (at) => { cellTris[fill[at]!] = t; fill[at] = fill[at]! + 1; });
  return { positions, normals, seam, index, cells, errors, cellStart, cellTris };
}

/** The drawn terrain's height at a point of a plate (its own frame) in a cut cell, from the joined seams and the grid's corners as they stand now
 *  (a corner's vertex follows its corner); undefined outside every cut cell, or under a hard surface (no terrain is drawn there: the grid's is the
 *  ground under it). */
export function seamHeightAt(seams: JoinedSeams, grid: Pick<SeamGrid, 'n' | 'cell' | 'half'>, corner: (i: number) => number, x: number, y: number): number | undefined {
  const seg = grid.n - 1;
  const fx = (x + grid.half) / grid.cell, fy = (grid.half - y) / grid.cell;
  const ci = Math.min(seg - 1, Math.max(0, Math.floor(fx))), cj = Math.min(seg - 1, Math.max(0, Math.floor(fy)));
  const at = binarySearch(seams.cells, ci + cj * seg);
  if (at < 0) return undefined;
  const { positions: p, seam, index } = seams;
  const z = -y;
  const heightOf = (v: number): number => {
    const ix = seam[v * 3]!;
    return ix < 0 ? p[v * 3 + 1]! : corner(ix + seam[v * 3 + 1]! * grid.n);
  };
  for (let k = seams.cellStart[at]!; k < seams.cellStart[at + 1]!; k++) {
    const t = seams.cellTris[k]!;
    const a = index[t * 3]!, b = index[t * 3 + 1]!, c = index[t * 3 + 2]!;
    const ax = p[a * 3]!, az = p[a * 3 + 2]!, bx = p[b * 3]!, bz = p[b * 3 + 2]!, cx = p[c * 3]!, cz = p[c * 3 + 2]!;
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (den === 0) continue;
    const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
    const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
    const wc = 1 - wa - wb;
    if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
    return wa * heightOf(a) + wb * heightOf(b) + wc * heightOf(c);
  }
  return undefined;
}
