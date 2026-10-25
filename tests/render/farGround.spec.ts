import { describe, expect, it } from 'vitest';
import { PLATE_SIZE, plateOf } from '@world/bounds';
import { TILE } from '@world/tiles';
import { farNodesFor } from '@render/farGround';
import { WOODS_MOST } from '@render/flatAtlas';

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
