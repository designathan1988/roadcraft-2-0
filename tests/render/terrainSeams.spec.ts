import { describe, expect, it } from 'vitest';
import { cellDiagonal, cellHeight } from '@world/groundPatch';
import { type JoinedSeams, type SeamGrid, type SeamOutline, joinSeams, plateSeams, seamHeightAt } from '@render/terrainSeams';

/** THE TERRAIN CUT ALONG THE SURFACES LAID ON IT (`render/terrainSeams.ts`): a small plate of 10 m cells, patches of 8 */
const seg = 32, n = seg + 1, cell = 10, half = (seg * cell) / 2, patch = 8;

/** A plate's grid over a field of world points. */
function gridOf(field: (x: number, y: number) => number): SeamGrid & { heights: Float64Array; flip: Uint8Array } {
  const heights = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[i + j * n] = field(-half + i * cell, half - j * cell);
  const flip = new Uint8Array(seg * seg);
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    flip[i + j * seg] = cellDiagonal(heights[i + j * n]!, heights[i + (j + 1) * n]!, heights[i + 1 + (j + 1) * n]!, heights[i + 1 + j * n]!);
  }
  return { n, cell, half, heights, flip, corner: (i) => heights[i]!, diagonal: (c) => flip[c]! };
}

/** The grid's own surface at a point. */
function gridAt(g: ReturnType<typeof gridOf>, x: number, y: number): number {
  const fx = (x + half) / cell, fy = (half - y) / cell;
  const i = Math.min(seg - 1, Math.floor(fx)), j = Math.min(seg - 1, Math.floor(fy));
  return cellHeight(g.heights[i + j * n]!, g.heights[i + (j + 1) * n]!, g.heights[i + 1 + (j + 1) * n]!, g.heights[i + 1 + j * n]!, fx - i, fy - j, g.flip[i + j * seg]!);
}

/** A strip between two chains as hard triangles (x, y, h each corner), its height `top`. */
function stripSoup(a: readonly [number, number][], b: readonly [number, number][], top: (x: number, y: number) => number): Float64Array {
  const out: number[] = [];
  const p = (q: readonly [number, number]): number[] => [q[0], q[1], top(q[0], q[1])];
  for (let k = 0; k + 1 < a.length; k++) out.push(...p(a[k]!), ...p(b[k]!), ...p(b[k + 1]!), ...p(a[k]!), ...p(b[k + 1]!), ...p(a[k + 1]!));
  return Float64Array.from(out);
}

/** A straight road from p to q, `w` wide, as two chains of `count` points. */
function road(p: readonly [number, number], q: readonly [number, number], w: number, count = 2): { a: [number, number][]; b: [number, number][] } {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]), nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
  const a: [number, number][] = [], b: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const t = k / (count - 1), x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
    a.push([x + nx * w / 2, y + ny * w / 2]);
    b.push([x - nx * w / 2, y - ny * w / 2]);
  }
  return { a, b };
}

const area2 = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** A convex polygon cut to an axis-aligned box (Sutherland-Hodgman). */
function clipToBox(poly: [number, number][], x0: number, y0: number, x1: number, y1: number): [number, number][] {
  let out = poly;
  const edges: [(p: [number, number]) => number][] = [[(p) => p[0] - x0], [(p) => x1 - p[0]], [(p) => p[1] - y0], [(p) => y1 - p[1]]];
  for (const [side] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!, prev = input[(i + input.length - 1) % input.length]!;
      const dc = side(cur), dp = side(prev);
      if (dc >= 0) {
        if (dp < 0) { const t = dp / (dp - dc); out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]); }
        out.push(cur);
      } else if (dp >= 0) { const t = dp / (dp - dc); out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]); }
    }
  }
  return out;
}
const polyArea = (poly: readonly [number, number][]): number => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
};

/** Each kept triangle of the joined mesh on the plan (x, y). */
function trianglesOf(j: JoinedSeams): [number, number][][] {
  const out: [number, number][][] = [];
  for (let t = 0; t < j.index.length / 3; t++) {
    out.push([0, 1, 2].map((k) => { const v = j.index[t * 3 + k]!; return [j.positions[v * 3]!, -j.positions[v * 3 + 2]!] as [number, number]; }));
  }
  return out;
}

/** The checks every cut must pass: the cut cells covered once (the terrain's triangles and the hard surfaces' share of them add up to the cells),
 *  no terrain under a hard surface, front faces up, a corner at its grid height and an edge's point at the surface's. */
function checkCut(g: ReturnType<typeof gridOf>, outline: SeamOutline, hardPolys: [number, number][][]): JoinedSeams {
  const seams = plateSeams(g, outline, patch);
  const joined = joinSeams(seams, g);
  const tris = trianglesOf(joined);
  expect(tris.length).toBeGreaterThan(0);
  // Front faces up (counter-clockwise with y north), none flat.
  for (const t of tris) expect(area2(t[0]![0], t[0]![1], t[1]![0], t[1]![1], t[2]![0], t[2]![1])).toBeGreaterThan(0);
  // Every cut cell: its terrain's triangles and the hard surfaces' share of it make it whole (the surfaces given here never overlap).
  let terrain = 0;
  for (const t of tris) terrain += area2(t[0]![0], t[0]![1], t[1]![0], t[1]![1], t[2]![0], t[2]![1]) / 2;
  let hardInCut = 0;
  for (const c of joined.cells) {
    const i = c % seg, jy = (c - i) / seg;
    const x0 = -half + i * cell, x1 = x0 + cell, y1 = half - jy * cell, y0 = y1 - cell;
    for (const poly of hardPolys) hardInCut += polyArea(clipToBox(poly, x0, y0, x1, y1));
  }
  // Within the floats' rounding of the mesh's positions (a millimetre's square over a plate's cells).
  expect(Math.abs(terrain + hardInCut - joined.cells.length * cell * cell)).toBeLessThan(1e-3);
  // No triangle of terrain has its middle under a hard surface.
  const insidePoly = (poly: readonly [number, number][], x: number, y: number): boolean => {
    let odd = false;
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const a = poly[i]!, b = poly[k]!;
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) odd = !odd;
    }
    return odd;
  };
  for (const t of tris) {
    const mx = (t[0]![0] + t[1]![0] + t[2]![0]) / 3, my = (t[0]![1] + t[1]![1] + t[2]![1]) / 3;
    for (const poly of hardPolys) expect(insidePoly(poly, mx, my)).toBe(false);
  }
  // A corner at its own height; every triangle in one patch.
  for (let v = 0; v < joined.seam.length / 3; v++) {
    const ix = joined.seam[v * 3]!, iy = joined.seam[v * 3 + 1]!;
    if (ix >= 0) expect(joined.positions[v * 3 + 1]!).toBeCloseTo(g.heights[ix + iy * n]!, 4);
  }
  for (let t = 0; t < joined.index.length / 3; t++) {
    const p0 = joined.seam[joined.index[t * 3]! * 3 + 2]!;
    expect(joined.seam[joined.index[t * 3 + 1]! * 3 + 2]).toBe(p0);
    expect(joined.seam[joined.index[t * 3 + 2]! * 3 + 2]).toBe(p0);
  }
  return joined;
}

describe('the terrain cut along a road at grade', () => {
  const g = gridOf((x, y) => 20 + 0.03 * x + 0.05 * y + 0.4 * Math.sin(x * 0.07) * Math.cos(y * 0.05));
  const top = (x: number, y: number): number => 20.3 + 0.03 * x + 0.05 * y;

  it('cuts every cell the outline touches and meets it on its own vertices, at its own heights (a road on a slant)', () => {
    const { a, b } = road([-130, -40], [140, 75], 13.4, 5);
    const soup = stripSoup(a, b, top);
    const joined = checkCut(g, { hard: [soup], soft: [] }, [[...a, ...b.slice().reverse()]]);
    // Every point of the outline at the road's own height.
    for (let v = 0; v < joined.seam.length / 3; v++) {
      if (joined.seam[v * 3]! >= 0) continue;
      const x = joined.positions[v * 3]!, y = -joined.positions[v * 3 + 2]!;
      expect(joined.positions[v * 3 + 1]!).toBeCloseTo(top(x, y), 3);
    }
    // The drawn height at a point beside the road, in a cut cell: the terrain's own triangle, which meets the edge at the road's height.
    const [ex, ey] = a[2]!;
    const beside = seamHeightAt(joined, g, (i) => g.heights[i]!, ex, ey);
    expect(beside).toBeDefined();
    expect(beside!).toBeCloseTo(top(ex, ey), 3);
    // Off every cut cell: none (the grid draws it).
    expect(seamHeightAt(joined, g, (i) => g.heights[i]!, -150, 150)).toBeUndefined();
  });

  it('meets a road whose edges run along the grid\'s lines and through its corners', () => {
    // From x = -100 to 100, edges at y = -10 and y = 10: on grid lines, their ends on corners.
    const { a, b } = road([-100, 0], [100, 0], 20, 3);
    const soup = stripSoup(a, b, top);
    const joined = checkCut(g, { hard: [soup], soft: [] }, [[...a, ...b.slice().reverse()]]);
    // A corner the edge runs through takes the edge's height: the terrain meets the road there, not the grid's corner.
    let onEdge = 0;
    for (let v = 0; v < joined.seam.length / 3; v++) {
      const x = joined.positions[v * 3]!, y = -joined.positions[v * 3 + 2]!;
      if (Math.abs(Math.abs(y) - 10) < 1e-6 && Math.abs(x) <= 100) { expect(joined.seam[v * 3]!).toBe(-1); expect(joined.positions[v * 3 + 1]!).toBeCloseTo(top(x, y), 3); onEdge++; }
    }
    expect(onEdge).toBeGreaterThan(0);
  });

  it('meets a curve, crossing patches, the points on a patch\'s side the same from both patches', () => {
    // An arc of radius 90 round (0, -60), 9 m wide, 40 points: it crosses the patches' sides at x = 0 and y = 0 (cells 16).
    const a: [number, number][] = [], b: [number, number][] = [];
    for (let k = 0; k <= 40; k++) {
      const t = Math.PI * 0.15 + (Math.PI * 0.7 * k) / 40;
      a.push([Math.cos(t) * 94.5, -60 + Math.sin(t) * 94.5]);
      b.push([Math.cos(t) * 85.5, -60 + Math.sin(t) * 85.5]);
    }
    const soup = stripSoup(a, b, top);
    const polys: [number, number][][] = [];
    for (let k = 0; k < 40; k++) polys.push([a[k]!, b[k]!, b[k + 1]!, a[k + 1]!]);
    const joined = checkCut(g, { hard: [soup], soft: [] }, polys);
    // The vertices on the patches' sides x = 0 and y = 0: each one is in both patches, at one height.
    const onSide = new Map<string, number[]>();
    for (let v = 0; v < joined.seam.length / 3; v++) {
      const x = joined.positions[v * 3]!, y = -joined.positions[v * 3 + 2]!;
      if (Math.abs(x) > 1e-4 && Math.abs(y) > 1e-4) continue;
      const key = `${x.toFixed(3)},${y.toFixed(3)}`;
      const list = onSide.get(key) ?? [];
      list.push(joined.positions[v * 3 + 1]!);
      onSide.set(key, list);
    }
    let shared = 0;
    for (const heights of onSide.values()) {
      if (heights.length < 2) continue;
      shared++;
      for (const h of heights) expect(h).toBeCloseTo(heights[0]!, 5);
    }
    expect(shared).toBeGreaterThan(0);
  });

  it('cuts two crossing roads at their crossing, at the lower height there', () => {
    const one = road([-120, -30], [120, -30], 12);
    const two = road([-20, -140], [-20, 120], 12);
    // Overlapping in a square: the second laid a little lower, so the crossing's points take its height.
    const lower = (x: number, y: number): number => top(x, y) - 0.05;
    const joined = joinSeams(plateSeams(g, { hard: [stripSoup(one.a, one.b, top), stripSoup(two.a, two.b, lower)], soft: [] }, patch), g);
    expect(joined.index.length).toBeGreaterThan(0);
    // No terrain in the square both cover, nor under either.
    for (const t of trianglesOf(joined)) {
      const mx = (t[0]![0] + t[1]![0] + t[2]![0]) / 3, my = (t[0]![1] + t[1]![1] + t[2]![1]) / 3;
      expect(Math.abs(my + 30) < 6 && mx > -120 && mx < 120).toBe(false);
      expect(Math.abs(mx + 20) < 6 && my > -140 && my < 120).toBe(false);
    }
  });
});

describe('the terrain met by a lot\'s paving', () => {
  // A hillside: 12 % across x.
  const g = gridOf((x, y) => 50 + 0.12 * x + 0.02 * y);
  /** The lot graded level at 51 m, the ground under its plate. */
  const lot = Float64Array.from([-23, -17, 51, 31, -17, 51, 31, 19, 51, -23, 19, 51]);

  it('keeps the terrain under the paving, its edges at the paving\'s ground all round, on the slope', () => {
    const joined = joinSeams(plateSeams(g, { hard: [], soft: [lot] }, patch), g);
    expect(joined.index.length).toBeGreaterThan(0);
    // Every cut cell covered whole by the terrain (a soft surface leaves it under).
    let terrain = 0;
    for (const t of trianglesOf(joined)) terrain += area2(t[0]![0], t[0]![1], t[1]![0], t[1]![1], t[2]![0], t[2]![1]) / 2;
    expect(Math.abs(terrain - joined.cells.length * cell * cell)).toBeLessThan(1e-3);
    // Along the lot's edges the drawn terrain is at the graded level exactly: the grid's own surface is not (it steps over the slope).
    let worstGrid = 0;
    for (const [x0, y0, x1, y1] of [[-23, -17, 31, -17], [31, -17, 31, 19], [31, 19, -23, 19], [-23, 19, -23, -17]] as const) {
      for (let k = 1; k < 20; k++) {
        const x = x0 + ((x1 - x0) * k) / 20, y = y0 + ((y1 - y0) * k) / 20;
        const h = seamHeightAt(joined, g, (i) => g.heights[i]!, x, y);
        expect(h).toBeDefined();
        expect(h!).toBeCloseTo(51, 4);
        worstGrid = Math.max(worstGrid, Math.abs(gridAt(g, x, y) - 51));
      }
    }
    // The grid alone would have left the edge metres off the paving (the stepped yard): the cut is what meets it.
    expect(worstGrid).toBeGreaterThan(1);
    // What a coarser level (the grid) is off by, kept with the cells.
    expect(Math.max(...joined.errors)).toBeGreaterThan(1);
  });
});
