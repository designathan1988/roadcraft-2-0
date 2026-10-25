import { describe, expect, it } from 'vitest';
import { PLATE_SIZE, plateOf } from '@world/bounds';
import { TILE } from '@world/tiles';
import { FAR_ERROR_PX, FAR_STRIDES, farNodesFor, strideErrorsInto, strideFor } from '@render/farGround';
import { WOODS_MOST, createFlatFar, farIndexInto, writeFarPatch } from '@render/flatAtlas';

/** THE FAR GROUND CHOSEN BY THE VIEW'S DISTANCE (`farGround.ts`, CDLOD): what is resident does not grow with the map */

const QUADS = 32;
/** The map's half side for a map `km` wide (as `wholeMap.ts` MAP_HALF from MAP_TILES of 1 km: a multiple of 4, its edge on the 2 km plates' edges). */
const halfOf = (km: number): number => (km / 2) * TILE;
/** The nodes asked from a grid of places over the whole map. */
function over(km: number, each: (nodes: ReturnType<typeof farNodesFor>, x: number, y: number) => void): void {
  const e = halfOf(km);
  for (let x = -e; x <= e; x += e / 8) for (let y = -e; y <= e; y += e / 8) each(farNodesFor(x, y, e, QUADS), x, y);
}

describe('the far ground by distance', () => {
  it('keeps a 12 km map\'s every plate a plate\'s patch, wherever the view stands (the ground seen as before)', () => {
    over(12, (nodes) => {
      const plates = nodes.filter((n) => n.k === 0).map((n) => n.plate).sort((a, b) => a! - b!);
      expect(plates.length).toBe(36);
      expect(new Set(plates).size).toBe(36);
    });
    // The plates by their own keys, those of the 6 x 6 round the origin (from -3 to 2 plates each way: the map's edge on their edges).
    const keys = new Set(farNodesFor(0, 0, halfOf(12), QUADS).map((n) => n.plate));
    for (let i = -3; i <= 2; i++) for (let j = -3; j <= 2; j++) expect(keys.has(plateOf((i + 0.5) * PLATE_SIZE, (j + 0.5) * PLATE_SIZE))).toBe(true);
  });

  it('holds what the view asks, not the map: the nodes grow with the map\'s levels, never its area', () => {
    const most = (km: number): { nodes: number; plates: number } => {
      let nodes = 0, plates = 0;
      over(km, (n) => { nodes = Math.max(nodes, n.length); plates = Math.max(plates, n.filter((x) => x.k === 0).length); });
      return { nodes, plates };
    };
    const small = most(20), large = most(52), huge = most(200);
    // Every plate resident would be 100, 676 and 10,000.
    expect(large.nodes).toBeLessThan(260);
    expect(huge.nodes).toBeLessThan(400);
    // A level more each time the map doubles: some sixty nodes, not four times as many (52 -> 200 km: two levels).
    expect(huge.nodes - large.nodes).toBeLessThan(2 * 70);
    // The plates' patches (and their woods) the same whatever the map past 20 km, under the woods' room: at two maps whose root's nodes meet the views
    // asked alike, and under the room on every map (the most of them moves with where the nodes' lines fall under the views asked, 144 or 180).
    expect(large.plates).toBe(huge.plates);
    for (const km of [24, 32, 48, 64, 96, 128, 192, 256]) expect(most(km).plates, `${km} km`).toBeLessThanOrEqual(WOODS_MOST);
    expect(small.nodes).toBeLessThanOrEqual(100);
  });

  it('covers the map once, nothing past its edge, coarser away from the view', () => {
    const e = halfOf(48);
    const nodes = farNodesFor(1000, -3000, e, QUADS);
    let area = 0;
    for (const n of nodes) {
      area += n.quadsX * n.quadsY * n.step * n.step;
      expect(n.x0 + n.quadsX * n.step).toBeLessThanOrEqual(e + 1e-6);
      expect(n.y0 + n.quadsY * n.step).toBeLessThanOrEqual(e + 1e-6);
      const cx = n.x0 + (n.quadsX * n.step) / 2, cy = n.y0 + (n.quadsY * n.step) / 2;
      // Far from the view, never a plate's patch: the levels go up with the distance.
      if (Math.hypot(cx - 1000, cy + 3000) > 30_000) expect(n.k).toBeGreaterThan(1);
      // A plate's patch is a plate: its edges on the plates' edges.
      if (n.k === 0) expect([n.x0 % PLATE_SIZE === 0, n.y0 % PLATE_SIZE === 0]).toEqual([true, true]);
    }
    expect(area).toBeCloseTo((2 * e) ** 2, -3);
    // The rims: on the map's edge only.
    for (const n of nodes) if (n.rim[2]) expect(n.x0).toBeCloseTo(-e, 6);
  });

  it('refuses a map whose edge is not on the plates\' edges', () => {
    expect(() => farNodesFor(0, 0, halfOf(18), QUADS)).toThrow();
    expect(() => farNodesFor(0, 0, halfOf(20), QUADS)).not.toThrow();
  });
});

describe('a far patch drawn at the stride its relief allows', () => {
  /** A grid of 33 x 33 corners (no ring), heights from `at`. */
  const grid = (at: (i: number, j: number) => number): Float64Array => {
    const h = new Float64Array(33 * 33);
    for (let j = 0; j <= QUADS; j++) for (let i = 0; i <= QUADS; i++) h[j * 33 + i] = at(i, j);
    return h;
  };
  const errorsOf = (h: Float64Array): Float32Array => {
    const out = new Float32Array(FAR_STRIDES);
    strideErrorsInto(out, 0, h, 33, 0, QUADS);
    return out;
  };

  it('strays nothing at any stride on a plane, however tilted, and is drawn as one quad there', () => {
    const errors = errorsOf(grid((i, j) => 12 + 0.7 * i - 0.3 * j));
    for (let p = 0; p < FAR_STRIDES; p++) expect(errors[p]).toBeCloseTo(0, 4);
    expect(strideFor(errors, 0, 1e6, QUADS, QUADS, 1)).toBe(QUADS);
  });

  it('measures a bump by what each stride misses of it, and keeps the stride under which it spans half a pixel', () => {
    // One corner 4 m up in the middle of a flat patch: the full grid draws it, every stride from 2 on misses it whole.
    const errors = errorsOf(grid((i, j) => (i === 17 && j === 17 ? 4 : 0)));
    expect(errors[0]).toBe(0);
    for (let p = 1; p < FAR_STRIDES; p++) expect(errors[p]).toBeCloseTo(4, 4);
    // 4 m at 0.1 px a metre is 0.4 px (under half a pixel): the coarsest; at 1 px a metre, 4 px: the full grid.
    expect(strideFor(errors, 0, 0.1, QUADS, QUADS, 1)).toBe(QUADS);
    expect(strideFor(errors, 0, 1, QUADS, QUADS, 1)).toBe(1);
    // Taken only under the bound narrowed (0.8 of it), held up to it: at 0.12 px a metre (0.48 px) a coarse stride held stays, a fine one stays fine.
    expect(4 * 0.12).toBeLessThanOrEqual(FAR_ERROR_PX);
    expect(strideFor(errors, 0, 0.12, QUADS, QUADS, QUADS)).toBe(QUADS);
    expect(strideFor(errors, 0, 0.12, QUADS, QUADS, 1)).toBe(1);
  });

  it("never draws a stride that does not divide the quads the map leaves a patch (its edge on the map's)", () => {
    const errors = new Float32Array(FAR_STRIDES);
    expect(strideFor(errors, 0, 1, 16, QUADS, 1)).toBe(16);
    expect(strideFor(errors, 0, 1, 8, 24, 1)).toBe(8);
  });

  it("writes a plain patch at its coarsest as two triangles and a quad of skirt an edge, on the full grid's own corners", () => {
    const far = createFlatFar(1);
    writeFarPatch(far, 0, 0, 0, () => 5);
    for (let p = 0; p < FAR_STRIDES; p++) expect(far.errors[p]).toBeCloseTo(0, 4);
    const open = [false, false, false, false] as const;
    const full = farIndexInto(far, [{ slot: 0, rim: open }]);
    expect(full).toBe(QUADS * QUADS * 6 + 4 * QUADS * 12);
    const coarse = farIndexInto(far, [{ slot: 0, rim: open, stride: QUADS }]);
    expect(coarse).toBe(6 + 4 * 12);
    // Its corners are the full grid's corners (0, 32 a side): the same patch's outline, its skirts hung under its edges.
    const index = far.geometry.getIndex()!.array, position = far.geometry.getAttribute('position');
    const xs = new Set<number>();
    for (let k = 0; k < coarse; k++) xs.add(Math.round(position.getX(index[k]!)));
    expect([...xs].sort((a, b) => a - b)).toEqual([-PLATE_SIZE / 2, PLATE_SIZE / 2]);
    expect(far.heights[0]).toBeGreaterThan(-Infinity);
    expect(far.heights[1]).toBeGreaterThanOrEqual(far.heights[0]!);
  });
});
