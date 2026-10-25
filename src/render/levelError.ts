/** WHETHER A LEVEL OF DETAIL STAYS WITHIN ITS ERROR OF THE PART IT WAS MADE FROM: the two-sided Hausdorff distance between the two surfaces,
 *  tested against a bound (every point of each within `limit` of the other), the measure a level is accepted on once projected to pixels
 *  ([KAIST, multi-resolution techniques](https://sgvr.kaist.ac.kr/~sungeui/SGA07/Slides/Lec4-LOD.pdf)). meshoptimizer's own error is a quadric
 *  estimate, not this distance: a component it prunes (`Prune`) or a sliver it folds away can lie farther than the error asked
 *  ([meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md), "Simplification"), so each level is measured.
 *  Both surfaces index the same vertices (a simplified index over its part's welded positions). */

/** The squared distance from (px, py, pz) to triangle (a, b, c) of `p` (vertex numbers): the closest point by its Voronoi region (Ericson,
 *  Real-Time Collision Detection, 5.1.5, as three's `Triangle.closestPointToPoint`), in plain numbers. */
function distanceSquared(p: Float32Array, a: number, b: number, c: number, px: number, py: number, pz: number): number {
  const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
  const abx = p[b * 3]! - ax, aby = p[b * 3 + 1]! - ay, abz = p[b * 3 + 2]! - az;
  const acx = p[c * 3]! - ax, acy = p[c * 3 + 1]! - ay, acz = p[c * 3 + 2]! - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { qx = ax + abx; qy = ay + aby; qz = az + abz; }
    else if (d6 >= 0 && d5 <= d6) { qx = ax + acx; qy = ay + acy; qz = az + acz; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      qx = ax + abx + (acx - abx) * w; qy = ay + aby + (acy - aby) * w; qz = az + abz + (acz - abz) * w;
    } else {
      const sum = va + vb + vc;
      // No area (its corners in a line): the nearest of its corners stands for it, as three's falls back to.
      if (sum === 0) return Math.min((px - ax) ** 2 + (py - ay) ** 2 + (pz - az) ** 2, (px - ax - abx) ** 2 + (py - ay - aby) ** 2 + (pz - az - abz) ** 2,
        (px - ax - acx) ** 2 + (py - ay - acy) ** 2 + (pz - az - acz) ** 2);
      const v = vb / sum, w = vc / sum;
      qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
    }
  }
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

/** A surface's triangles in a uniform grid of cells: each cell lists the triangles whose bounds reach into it. */
export class SurfaceGrid {
  private readonly lo: readonly [number, number, number];
  private readonly cell: number;
  private readonly n: readonly [number, number, number];
  /** Compressed rows: the triangles of cell c are `items[starts[c] .. starts[c + 1])`. */
  private readonly starts: Int32Array;
  private readonly items: Int32Array;
  /** The query each triangle was last listed for, so a triangle met in several cells is listed once a query. */
  private readonly seen: Int32Array;
  private query = 0;
  /** Each triangle's bounds: lo x y z, hi x y z. */
  private readonly bounds: Float32Array;

  constructor(private readonly positions: Float32Array, private readonly index: Uint32Array, cellSize: number) {
    const triangles = index.length / 3;
    const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < index.length; i++) {
      const v = index[i]! * 3;
      for (let d = 0; d < 3; d++) { const x = positions[v + d]!; if (x < lo[d]!) lo[d] = x; if (x > hi[d]!) hi[d] = x; }
    }
    if (triangles === 0) for (let d = 0; d < 3; d++) { lo[d] = 0; hi[d] = 0; }
    const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    // No finer than a 64th of the surface's extent (the cells a large triangle spans stay few), nor than about four cells a triangle (a grid
    // is made for every level tried of every piece of a part: a seat's 12 triangles in 64,000 cells cost the bus's cabin seconds), no coarser
    // than a quarter.
    const volume = Math.max(hi[0] - lo[0], extent / 64) * Math.max(hi[1] - lo[1], extent / 64) * Math.max(hi[2] - lo[2], extent / 64);
    this.cell = Math.min(extent / 4, Math.max(cellSize, extent / 64, Math.cbrt(volume / Math.max(1, triangles * 4))));
    this.lo = lo;
    this.n = [0, 1, 2].map((d) => Math.max(1, Math.floor((hi[d]! - lo[d]!) / this.cell) + 1)) as unknown as [number, number, number];
    const cells = this.n[0] * this.n[1] * this.n[2];
    const counts = new Int32Array(cells + 1);
    const span = (t: number, visit: (c: number) => void): void => {
      const a = [0, 0, 0], b = [0, 0, 0];
      for (let d = 0; d < 3; d++) {
        const p = positions[index[t * 3]! * 3 + d]!, q = positions[index[t * 3 + 1]! * 3 + d]!, r = positions[index[t * 3 + 2]! * 3 + d]!;
        a[d] = this.at(d, Math.min(p, q, r)); b[d] = this.at(d, Math.max(p, q, r));
      }
      for (let x = a[0]!; x <= b[0]!; x++) for (let y = a[1]!; y <= b[1]!; y++) for (let z = a[2]!; z <= b[2]!; z++) visit((x * this.n[1] + y) * this.n[2] + z);
    };
    for (let t = 0; t < triangles; t++) span(t, (c) => { counts[c + 1]!++; });
    for (let c = 0; c < cells; c++) counts[c + 1] = counts[c + 1]! + counts[c]!;
    this.starts = counts;
    this.items = new Int32Array(counts[cells]!);
    const fill = counts.slice(0, cells);
    for (let t = 0; t < triangles; t++) span(t, (c) => { this.items[fill[c]!++] = t; });
    this.seen = new Int32Array(triangles).fill(-1);
    this.bounds = new Float32Array(triangles * 6);
    for (let t = 0; t < triangles; t++) for (let d = 0; d < 3; d++) {
      const p = positions[index[t * 3]! * 3 + d]!, q = positions[index[t * 3 + 1]! * 3 + d]!, r = positions[index[t * 3 + 2]! * 3 + d]!;
      this.bounds[t * 6 + d] = Math.min(p, q, r); this.bounds[t * 6 + 3 + d] = Math.max(p, q, r);
    }
  }

  /** Whether triangle t's bounds reach into the box [lo, hi]. */
  meets(t: number, lo: ArrayLike<number>, hi: ArrayLike<number>): boolean {
    const b = this.bounds, o = t * 6;
    return b[o]! <= hi[0]! && b[o + 3]! >= lo[0]! && b[o + 1]! <= hi[1]! && b[o + 4]! >= lo[1]! && b[o + 2]! <= hi[2]! && b[o + 5]! >= lo[2]!;
  }

  private at(d: number, v: number): number {
    return Math.min(this.n[d]! - 1, Math.max(0, Math.floor((v - this.lo[d]!) / this.cell)));
  }

  /** Every triangle whose cells reach into the box [lo, hi], into `out` (each once). */
  candidates(lo: ArrayLike<number>, hi: ArrayLike<number>, out: number[]): void {
    const q = ++this.query;
    const x0 = this.at(0, lo[0]!), x1 = this.at(0, hi[0]!), y0 = this.at(1, lo[1]!), y1 = this.at(1, hi[1]!), z0 = this.at(2, lo[2]!), z1 = this.at(2, hi[2]!);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const c = (x * this.n[1] + y) * this.n[2] + z;
      for (let k = this.starts[c]!, end = this.starts[c + 1]!; k < end; k++) {
        const t = this.items[k]!;
        if (this.seen[t] === q) continue;
        this.seen[t] = q;
        out.push(t);
      }
    }
  }

  /** The squared distance from (x, y, z) to triangle t. */
  distanceSquared(t: number, x: number, y: number, z: number): number {
    const ix = this.index;
    return distanceSquared(this.positions, ix[t * 3]!, ix[t * 3 + 1]!, ix[t * 3 + 2]!, x, y, z);
  }
}

/** How many times a triangle is cut in four, at most, before a piece neither proved near nor proved far counts as far: a piece is then
 *  1/4096 of the triangle's side. */
const DEPTH = 12;
/** A level's triangle against the part (`withinError`): sampled on a lattice of up to LEVEL_STEPS steps a side (every half `limit` along its
 *  longest side, at most), each sample held to HELD of `limit` (a point between two samples lies farther than both by at most half a step).
 *  A level's triangle spans many of the part's on a curved body, so `covered` would cut it into pieces as small as the part's own; its corners
 *  are the part's vertices and its distance to the part grows smoothly across it where it bridges a hollow, which the lattice reads. */
const LEVEL_STEPS = 8;
const HELD = 0.75;

/** Whether every sample of a lattice over triangle (a, b, c) of `positions` lies within HELD x `limit` of the surface of `grid`. */
function sampled(positions: Float32Array, a: number, b: number, c: number, longest: number, grid: SurfaceGrid, limit: number, near: number[], memo: Int32Array): boolean {
  const held = limit * HELD, held2 = held * held;
  const lo = [0, 0, 0], hi = [0, 0, 0];
  const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
  const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!;
  const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!;
  const n = Math.min(LEVEL_STEPS, Math.max(2, Math.ceil((2 * longest) / limit)));
  // The triangle that held the last sample, of this triangle or the one before: a neighbour's sample is most often held by it too.
  let last = memo[0]!;
  for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
    // Its corners are the part's own vertices.
    if ((i === 0 && j === 0) || i === n || j === n) continue;
    const u = i / n, v = j / n, w = 1 - u - v;
    const x = ax * w + bx * u + cx * v, y = ay * w + by * u + cy * v, z = az * w + bz * u + cz * v;
    if (last >= 0 && grid.distanceSquared(last, x, y, z) <= held2) continue;
    last = -1;
    // The triangles that can hold the sample: those reaching into its box grown by `held`.
    lo[0] = x - held; lo[1] = y - held; lo[2] = z - held; hi[0] = x + held; hi[1] = y + held; hi[2] = z + held;
    near.length = 0;
    grid.candidates(lo, hi, near);
    for (const t of near) if (grid.meets(t, lo, hi) && grid.distanceSquared(t, x, y, z) <= held2) { last = t; break; }
    if (last < 0) return false;
    memo[0] = last;
  }
  return true;
}

/** Whether every point of triangle (a, b, c) of `positions` lies within `limit` of the surface of `grid`, proved, not sampled: the distance to
 *  one triangle of the surface is a convex function of the point (the distance to a convex set), so a piece whose three corners all lie within
 *  `limit` of one triangle lies wholly within it ([Boyd and Vandenberghe, Convex Optimization](https://web.stanford.edu/~boyd/cvxbook/), 3.2.5:
 *  "dist(x, S)" of a convex S is convex; a convex function's maximum over a triangle is at a corner). A piece no one triangle holds is held by
 *  its corners when they lie near enough the surface for its size (the distance changes no faster than the point moves: no point of a piece
 *  lies farther than its longest side / sqrt(3) from its nearest corner), else it is cut in four, down to DEPTH. A corner farther than `limit`
 *  from every triangle near it is a point of the triangle that strays: false. The sampled bound this replaces held a 74 cm sliver of a bus's
 *  lip by its corners and middle, and a level 14 mm from it passed at 6 mm (2026-10-25). */
function covered(positions: Float32Array, a: number, b: number, c: number, grid: SurfaceGrid, limit: number, near: number[], pieces: number[], memo: Int32Array): boolean {
  const limit2 = limit * limit;
  // The triangle that held the last piece of the triangle before (`memo`): a neighbour is most often held by it too.
  const m = memo[0]!;
  if (m >= 0 && grid.distanceSquared(m, positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!) <= limit2
    && grid.distanceSquared(m, positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!) <= limit2
    && grid.distanceSquared(m, positions[c * 3]!, positions[c * 3 + 1]!, positions[c * 3 + 2]!) <= limit2) return true;
  // The surface's triangles that can lie within `limit` of the triangle: those reaching into its box grown by `limit`.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of [a, b, c]) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d]!, positions[v * 3 + d]! - limit); hi[d] = Math.max(hi[d]!, positions[v * 3 + d]! + limit); }
  near.length = 0;
  grid.candidates(lo, hi, near);
  if (near.length === 0) return false;
  pieces.length = 0;
  for (const v of [a, b, c]) pieces.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
  pieces.push(0);
  const d = new Float64Array(3), plo = new Float64Array(3), phi = new Float64Array(3);
  // The triangle that held the last piece: its neighbour piece is most often held by it too.
  let last = -1;
  const hold = (t: number): void => { last = t; memo[0] = t; };
  while (pieces.length > 0) {
    const depth = pieces.pop()!;
    const at = pieces.length - 9;
    const p = pieces.slice(at);
    pieces.length = at;
    for (let k = 0; k < 3; k++) {
      plo[k] = Math.min(p[k]!, p[3 + k]!, p[6 + k]!) - limit;
      phi[k] = Math.max(p[k]!, p[3 + k]!, p[6 + k]!) + limit;
    }
    // One triangle holding all three corners holds the piece.
    const holds = (t: number): boolean => grid.distanceSquared(t, p[0]!, p[1]!, p[2]!) <= limit2 && grid.distanceSquared(t, p[3]!, p[4]!, p[5]!) <= limit2
      && grid.distanceSquared(t, p[6]!, p[7]!, p[8]!) <= limit2;
    if (last >= 0 && holds(last)) continue;
    let held = false;
    d[0] = Infinity; d[1] = Infinity; d[2] = Infinity;
    for (const t of near) {
      // Only a triangle reaching within `limit` of the piece can hold any of it.
      if (!grid.meets(t, plo, phi)) continue;
      const d0 = grid.distanceSquared(t, p[0]!, p[1]!, p[2]!), d1 = grid.distanceSquared(t, p[3]!, p[4]!, p[5]!), d2 = grid.distanceSquared(t, p[6]!, p[7]!, p[8]!);
      if (d0 <= limit2 && d1 <= limit2 && d2 <= limit2) { held = true; hold(t); break; }
      if (d0 < d[0]!) d[0] = d0;
      if (d1 < d[1]!) d[1] = d1;
      if (d2 < d[2]!) d[2] = d2;
    }
    if (held) continue;
    const far = Math.sqrt(Math.max(d[0]!, d[1]!, d[2]!));
    if (far > limit) return false;
    const longest = Math.sqrt(Math.max((p[3]! - p[0]!) ** 2 + (p[4]! - p[1]!) ** 2 + (p[5]! - p[2]!) ** 2,
      (p[6]! - p[0]!) ** 2 + (p[7]! - p[1]!) ** 2 + (p[8]! - p[2]!) ** 2, (p[6]! - p[3]!) ** 2 + (p[7]! - p[4]!) ** 2 + (p[8]! - p[5]!) ** 2));
    if (far + longest / Math.sqrt(3) <= limit) continue;
    if (depth >= DEPTH) return false;
    // Cut in four at its sides' middles.
    const m = [(p[0]! + p[3]!) / 2, (p[1]! + p[4]!) / 2, (p[2]! + p[5]!) / 2, (p[3]! + p[6]!) / 2, (p[4]! + p[7]!) / 2, (p[5]! + p[8]!) / 2,
      (p[6]! + p[0]!) / 2, (p[7]! + p[1]!) / 2, (p[8]! + p[2]!) / 2];
    pieces.push(p[0]!, p[1]!, p[2]!, m[0]!, m[1]!, m[2]!, m[6]!, m[7]!, m[8]!, depth + 1);
    pieces.push(m[0]!, m[1]!, m[2]!, p[3]!, p[4]!, p[5]!, m[3]!, m[4]!, m[5]!, depth + 1);
    pieces.push(m[6]!, m[7]!, m[8]!, m[3]!, m[4]!, m[5]!, p[6]!, p[7]!, p[8]!, depth + 1);
    pieces.push(m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7]!, m[8]!, depth + 1);
  }
  return true;
}

/** Twice the area and the longest side of triangle (a, b, c). */
function shapeOf(positions: Float32Array, a: number, b: number, c: number, out: Float64Array): void {
  const ux = positions[b * 3]! - positions[a * 3]!, uy = positions[b * 3 + 1]! - positions[a * 3 + 1]!, uz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
  const vx = positions[c * 3]! - positions[a * 3]!, vy = positions[c * 3 + 1]! - positions[a * 3 + 1]!, vz = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
  const wx = vx - ux, wy = vy - uy, wz = vz - uz;
  out[0] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  out[1] = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz));
}

/** One number for a triangle's three vertices whichever their order (exact while vertices number under 2^17). */
function triangleKey(a: number, b: number, c: number): number {
  const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
  return (lo * 131072 + mid) * 131072 + hi;
}

/** Whether a point lies within `limit` of the surface of `grid` (`near`, `memo`: as `sampled`'s). */
function pointNear(grid: SurfaceGrid, x: number, y: number, z: number, limit: number, near: number[], memo: Int32Array): boolean {
  const limit2 = limit * limit;
  if (memo[0]! >= 0 && grid.distanceSquared(memo[0]!, x, y, z) <= limit2) return true;
  const lo = [x - limit, y - limit, z - limit], hi = [x + limit, y + limit, z + limit];
  near.length = 0;
  grid.candidates(lo, hi, near);
  for (const t of near) if (grid.meets(t, lo, hi) && grid.distanceSquared(t, x, y, z) <= limit2) { memo[0] = t; return true; }
  return false;
}

/** Whether every point of the part (`whole`) lies within `limit` of the level (`level`, `levelGrid` its grid; null: the level draws nothing,
 *  which is within no limit of a part that draws something), proved triangle by triangle (`covered`): triangles without area draw nothing and
 *  are left out, and a triangle the level keeps as it is lies on it. Not `proved`: only each triangle's corners, sides' middles and centre are
 *  read, a test a level within `limit` always passes (a level that fails it is farther), for the search before the proof (`ladderIndices`). */
function partNearLevel(positions: Float32Array, whole: Uint32Array, level: Uint32Array, levelGrid: SurfaceGrid | null, limit: number,
  proved = true): boolean {
  const shape = new Float64Array(2);
  const kept = keysOf(level);
  const near: number[] = [], pieces: number[] = [], memo = new Int32Array(1).fill(-1);
  for (let t = 0; t < whole.length; t += 3) {
    const a = whole[t]!, b = whole[t + 1]!, c = whole[t + 2]!;
    if (kept.has(triangleKey(a, b, c))) continue;
    shapeOf(positions, a, b, c, shape);
    if (shape[0] === 0) continue;
    if (!levelGrid) return false;
    if (proved) { if (!covered(positions, a, b, c, levelGrid, limit, near, pieces, memo)) return false; continue; }
    const P = positions;
    for (const [u, v, w] of READ) {
      if (!pointNear(levelGrid, P[a * 3]! * u + P[b * 3]! * v + P[c * 3]! * w, P[a * 3 + 1]! * u + P[b * 3 + 1]! * v + P[c * 3 + 1]! * w,
        P[a * 3 + 2]! * u + P[b * 3 + 2]! * v + P[c * 3 + 2]! * w, limit, near, memo)) return false;
    }
  }
  return true;
}

/** The points of a triangle the unproved test reads (`partNearLevel`): its corners, its sides' middles, its centre. */
const READ: readonly (readonly [number, number, number])[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3]];

/** Whether the level (`level`) stays within `limit` of the part (`whole`, indices over the same `positions`, `wholeGrid` its grid made once a
 *  part) both ways: every point of the level near the part (`sampled`), every point of the part near the level (proved, `covered`). */
export function withinError(positions: Float32Array, whole: Uint32Array, wholeGrid: SurfaceGrid, level: Uint32Array, limit: number,
  wholeKeys: ReadonlySet<number> = keysOf(whole), proved = true): boolean {
  const shape = new Float64Array(2);
  const near: number[] = [], memo = new Int32Array(1).fill(-1);
  // A triangle of the part the level keeps lies on it.
  for (let t = 0; t < level.length; t += 3) {
    const a = level[t]!, b = level[t + 1]!, c = level[t + 2]!;
    if (wholeKeys.has(triangleKey(a, b, c))) continue;
    shapeOf(positions, a, b, c, shape);
    if (shape[0] === 0) continue;
    if (!sampled(positions, a, b, c, shape[1]!, wholeGrid, limit, near, memo)) return false;
  }
  return partNearLevel(positions, whole, level, level.length ? new SurfaceGrid(positions, level, limit * 2) : null, limit, proved);
}

/** Every triangle of `index` by its key (`triangleKey`): made once a part for its levels' tests. */
export function keysOf(index: Uint32Array): Set<number> {
  const keys = new Set<number>();
  for (let t = 0; t < index.length; t += 3) keys.add(triangleKey(index[t]!, index[t + 1]!, index[t + 2]!));
  return keys;
}
