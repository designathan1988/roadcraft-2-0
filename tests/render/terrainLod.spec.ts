import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { cellDiagonal, cellHeight } from '@world/groundPatch';
import { LOD_LEVELS, LOD_NODE, LOD_PATCH, LandLevels } from '@render/terrainLevels';
import { LandLod, lodFragmentGlsl, lodVertexGlsl } from '@render/terrainLod';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_SEGMENTS } from '@render/terrainGrid';

/** A TERRAIN PLATE DRAWN BY ITS DISTANCE (`render/terrainLod.ts`, Strugar's CDLOD): the game's plate, 200 cells of 10 m under a root of 256 that reaches past it */
const seg = TERRAIN_SEGMENTS, n = seg + 1, cell = TERRAIN_CELL, half = TERRAIN_HALF;
/** The root's side, cells: past the plate's far edges. */
const ROOT = LOD_NODE << (LOD_LEVELS - 1);

/** A plate's corners from a field of its corner indices, and their diagonals (`cellDiagonal`). */
function plate(field: (i: number, j: number) => number): { heights: Float64Array; flip: Uint8Array; diagonals(): void } {
  const heights = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[i + j * n] = field(i, j);
  const flip = new Uint8Array(seg * seg);
  const diagonals = (): void => {
    for (let cy = 0; cy < seg; cy++) for (let cx = 0; cx < seg; cx++) {
      flip[cx + cy * seg] = cellDiagonal(heights[cx + cy * n]!, heights[cx + (cy + 1) * n]!, heights[cx + 1 + (cy + 1) * n]!, heights[cx + 1 + cy * n]!);
    }
  };
  diagonals();
  return { heights, flip, diagonals };
}

describe('a plate\'s levels', () => {
  // Rough land: hills, bumps a few cells wide and a wall.
  const { heights, flip, diagonals } = plate((i, j) => 30 * Math.sin(i * 0.031) * Math.cos(j * 0.027) + 4 * Math.sin(i * 0.4 + j * 0.3) + (i > 150 && i < 154 ? 3 : 0));
  /** The full ground at a point (corner units), as the shader's `landSurface` reads it. */
  const fine = (x: number, y: number): number => {
    const ix = Math.min(seg - 1, Math.floor(x)), iy = Math.min(seg - 1, Math.floor(y));
    return cellHeight(heights[ix + iy * n]!, heights[ix + (iy + 1) * n]!, heights[ix + 1 + (iy + 1) * n]!, heights[ix + 1 + iy * n]!, x - ix, y - iy, flip[ix + iy * seg]!);
  };
  const levels = new LandLevels(seg);
  levels.markAll();
  levels.measure(heights, flip);

  it('bound how far each level stands off the full ground, whichever diagonal it is drawn with', () => {
    for (let level = 1; level < LOD_LEVELS; level++) {
      const step = 1 << level;
      let most = 0;
      // A dense sample of the plate: every quarter cell.
      for (let y = 0; y <= seg; y += 0.25) {
        for (let x = 0; x <= seg; x += 0.25) {
          // The level's cell under the point; one across the plate's far edge drawn from its corners held on the edge (`landCorner`).
          const last = Math.ceil(seg / step) - 1;
          const cx = Math.min(last, Math.floor(x / step)), cy = Math.min(last, Math.floor(y / step));
          const x0 = cx * step, y0 = cy * step, x1 = Math.min(seg, x0 + step), y1 = Math.min(seg, y0 + step);
          const a = heights[x0 + y0 * n]!, b = heights[x0 + y1 * n]!, c = heights[x1 + y1 * n]!, d = heights[x1 + y0 * n]!;
          const u = (x - x0) / (x1 - x0), v = (y - y0) / (y1 - y0);
          const h = fine(x, y);
          most = Math.max(most, Math.abs(cellHeight(a, b, c, d, u, v, 0) - h), Math.abs(cellHeight(a, b, c, d, u, v, 1) - h));
        }
      }
      expect(levels.worst[level]).toBeGreaterThanOrEqual(most - 1e-4);
      // A bound, not a guess: within a few times the true error.
      expect(levels.worst[level]).toBeLessThan(most * 4 + 0.01);
    }
    expect(levels.worst[0]).toBe(0);
  });

  it('measure again only where the ground moved, to the same numbers as a whole measure', () => {
    const local = new LandLevels(seg);
    local.markAll();
    local.measure(heights, flip);
    for (let j = 40; j <= 52; j++) for (let i = 70; i <= 90; i++) heights[i + j * n] = heights[i + j * n]! + 5;
    diagonals();
    local.markBox(70, 90, 40, 52);
    local.measure(heights, flip);
    const whole = new LandLevels(seg);
    whole.markAll();
    whole.measure(heights, flip);
    expect(Array.from(local.data)).toEqual(Array.from(whole.data));
    expect(Array.from(local.worst)).toEqual(Array.from(whole.worst));
  });
});

describe('the patches chosen for a camera', () => {
  // Rolling land: its levels' errors small enough for every level to be used in one view.
  const { heights: land, flip } = plate((i, j) => 20 * Math.sin(i * 0.011) * Math.cos(j * 0.009));
  const levels = new LandLevels(seg);
  levels.markAll();
  levels.measure(land, flip);
  const origin = { x: 0, y: 0 };
  const lod = new LandLod(levels, { seg, cell, half }, origin, { west: true, east: true, north: true, south: true });
  interface Patch { x: number; y: number; step: number; level: number }
  /** The patches a camera at `eye` looking at `at` is given. */
  const look = (eye: readonly [number, number, number], at: readonly [number, number, number], fov: number): { camera: PerspectiveCamera; patches: Patch[] } => {
    const camera = new PerspectiveCamera(fov, 16 / 9, 1, 100_000);
    camera.position.set(...eye);
    camera.lookAt(...at);
    camera.updateMatrixWorld();
    const count = lod.select(camera, 1080);
    const data = lod.geometry.getAttribute('aLodPatch').array as Float32Array;
    return { camera, patches: Array.from({ length: count }, (_, k) => ({ x: data[k * 4]!, y: data[k * 4 + 1]!, step: data[k * 4 + 2]!, level: data[k * 4 + 3]! })) };
  };
  /** The shader's morph of a corner (`landCorner`): its distance from the eye against its level's range. */
  const morphOf = (camera: PerspectiveCamera, level: number, i: number, j: number): number => {
    const p = { x: i * cell - half + origin.x, y: land[i + j * n]!, z: j * cell - half - origin.y };
    const d = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);
    return Math.min(1, Math.max(0, (d - lod.morph[level * 2]!) * lod.morph[level * 2 + 1]!));
  };
  /** Each cell's level, -1 where no patch was drawn (out of view); no cell drawn twice, no patch wholly past the plate (its cells past the far edge are held on it, none drawn). */
  const levelsOf = (patches: readonly Patch[]): Int8Array => {
    const at = new Int8Array(seg * seg).fill(-1);
    for (const p of patches) {
      const span = LOD_PATCH * p.step;
      expect(p.x < seg && p.y < seg, `patch at ${p.x},${p.y} past the plate`).toBe(true);
      for (let j = p.y; j < Math.min(seg, p.y + span); j++) {
        for (let i = p.x; i < Math.min(seg, p.x + span); i++) {
          expect(at[i + j * seg]).toBe(-1);
          at[i + j * seg] = p.level;
        }
      }
    }
    return at;
  };

  it('sends the patches only when the choice changed: the same camera twice sends none the second time', () => {
    const attribute = lod.geometry.getAttribute('aLodPatch') as import('three').InstancedBufferAttribute;
    look([-900, 40, 900], [600, 0, -700], 35);
    // As if three sent them.
    attribute.clearUpdateRanges();
    const version = attribute.version;
    const { patches } = look([-900, 40, 900], [600, 0, -700], 35);
    expect(patches.length).toBeGreaterThan(0);
    expect(attribute.version).toBe(version);
    expect(attribute.updateRanges.length).toBe(0);
    // Another view: sent again, from the first patch that differs.
    look([-700, 260, 500], [-700, 0, 500], 170);
    expect(attribute.version).toBeGreaterThan(version);
    expect(attribute.updateRanges.length).toBe(1);
  });

  it('cover the plate once, every level in use, from over it', () => {
    const { patches } = look([-700, 260, 500], [-700, 0, 500], 170);
    expect(levelsOf(patches).every((l) => l >= 0)).toBe(true);
    expect(new Set(patches.map((p) => p.level)).size).toBeGreaterThan(2);
  });

  const views: readonly (readonly [string, readonly [number, number, number], readonly [number, number, number], number])[] = [
    ['over the plate', [-700, 260, 500], [-700, 0, 500], 170],
    ['low over the ground, looking across', [-900, 40, 900], [600, 0, -700], 35],
    // Off the plate (it spans 1 km each way), near enough for two levels to meet (from 3 km off, 600 m up, the plate of 10 m cells is one level).
    ['far off the plate', [2400, 500, -1900], [0, 0, 0], 35],
  ];
  for (const [name, eye, at, fov] of views) {
    it(`meet without a crack, ${name}: one level apart, the finer morphed whole and the coarser not at all along their edge (Strugar)`, () => {
      const { camera, patches } = look(eye, at, fov);
      const levelAt = levelsOf(patches);
      let edges = 0;
      // Cell (i, j) against its east and its south neighbour; the shared edge's two corners.
      for (const [di, dj] of [[1, 0], [0, 1]] as const) {
        for (let j = 0; j + dj < seg; j++) {
          for (let i = 0; i + di < seg; i++) {
            const a = levelAt[i + j * seg]!, b = levelAt[i + di + (j + dj) * seg]!;
            if (a === b || a < 0 || b < 0) continue;
            expect(Math.abs(a - b)).toBe(1);
            const finer = Math.min(a, b), coarser = finer + 1;
            for (const [x, y] of [[i + di, j + dj], [i + 1, j + 1]] as const) {
              expect(morphOf(camera, finer, x, y)).toBe(1);
              expect(morphOf(camera, coarser, x, y)).toBe(0);
            }
            edges++;
          }
        }
      }
      expect(edges).toBeGreaterThan(0);
    });
  }

  it('read the ground in each pixel as the page reads it (`cellHeight`), split along the drawn diagonal', () => {
    const glsl = lodFragmentGlsl({ seg, cell, half });
    // The shader's weights of corners a, b, c, d, as written in it.
    const lines = [
      '? (u >= v ? vec4(1.0 - u, 0.0, v, u - v) : vec4(1.0 - v, v - u, u, 0.0))',
      ': (u + v <= 1.0 ? vec4(1.0 - u - v, v, 0.0, u) : vec4(0.0, 1.0 - u, u + v - 1.0, 1.0 - v));',
    ];
    for (const line of lines) expect(glsl).toContain(line);
    const weights = (u: number, v: number, flipped: boolean): number[] => flipped
      ? (u >= v ? [1 - u, 0, v, u - v] : [1 - v, v - u, u, 0])
      : (u + v <= 1 ? [1 - u - v, v, 0, u] : [0, 1 - u, u + v - 1, 1 - v]);
    let seed = 3;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 2000; k++) {
      const a = random() * 20, b = random() * 20, c = random() * 20, d = random() * 20, u = random(), v = random();
      for (const flipped of [0, 1]) {
        const w = weights(u, v, flipped === 1);
        expect(w[0]! * a + w[1]! * b + w[2]! * c + w[3]! * d).toBeCloseTo(cellHeight(a, b, c, d, u, v, flipped), 9);
      }
    }
    // And the vertex shader's diagonal is the page's rule (`cellDiagonal`).
    expect(lodVertexGlsl({ seg, cell, half })).toContain('abs(pa.y - pc.y) + 0.5 < abs(pb.y - pd.y)');
  });

  it('hang a rim only on the plate\'s own edges', () => {
    const { patches } = look([-700, 260, 500], [-700, 0, 500], 170);
    // One rim a side of the plate a patch lies on (a corner patch two); a patch reaching past the far edge lies on it.
    const onEdge = patches.reduce((n, p) => n + [p.x === 0, p.y === 0, p.x + LOD_PATCH * p.step >= seg, p.y + LOD_PATCH * p.step >= seg].filter(Boolean).length, 0);
    expect(lod.rimGeometry.instanceCount).toBe(onEdge);
  });
});

describe('a plate of 200 cells under a root of 256 (CDLOD past the raster, Strugar)', () => {
  /** A corner of a patch as the vertex shader places it (`landCorner`): its index on the plate, held on the far edge, moved by `k` onto the even corner
   *  before it when odd, that corner held on the plate too (CDLOD's clamp, `getBaseVertexPos`). */
  const placed = (origin: number, g: number, step: number, k: number): number => {
    const c = Math.min(origin + g * step, seg);
    const to = Math.min(origin + (g - (g & 1)) * step, seg);
    return c + (to - c) * k;
  };
  /** The corners along a side a level draws with its patches from the plate's low edge to its far one, at morph `k`, as indices on the plate (each once). */
  const sideCorners = (level: number, k: number): number[] => {
    const step = 1 << level, out = new Set<number>();
    for (let origin = 0; origin < seg; origin += LOD_PATCH * step) for (let g = 0; g <= LOD_PATCH; g++) out.add(placed(origin, g, step, k));
    return [...out].sort((a, b) => a - b);
  };

  it('holds a corner past the plate\'s far edge on it in the shader, and where it morphs to', () => {
    const glsl = lodVertexGlsl({ seg, cell, half });
    expect(glsl).toContain(`ivec2 landOnPlate(ivec2 c) { return min(c, ivec2(${seg})); }`);
    expect(glsl).toContain('ivec2 c = landOnPlate(origin + g * step);');
    expect(glsl).toContain('ivec2 to = landOnPlate(origin + (g - odd) * step);');
  });

  it('keeps every level\'s corners on the plate and in their order, its two edges drawn at any morph, and a level morphed whole the next one\'s corners', () => {
    for (let level = 0; level < LOD_LEVELS; level++) {
      const step = 1 << level;
      for (const k of [0, 0.25, 0.5, 1]) {
        const corners = sideCorners(level, k);
        expect(corners[0]).toBe(0);
        expect(corners.at(-1)).toBe(seg);
        for (const c of corners) expect(c >= 0 && c <= seg).toBe(true);
        // A patch's corners never cross: its triangles never fold over, the one across the far edge included.
        for (let origin = 0; origin < seg; origin += LOD_PATCH * step) {
          for (let g = 1; g <= LOD_PATCH; g++) expect(placed(origin, g, step, k)).toBeGreaterThanOrEqual(placed(origin, g - 1, step, k));
        }
      }
      // Morphed whole, a level is the next one (the edges included): no crack where a level meets the next, at the far edge too.
      if (level + 1 < LOD_LEVELS) expect(sideCorners(level, 1)).toEqual(sideCorners(level + 1, 0));
    }
  });

  it('meets the next plate on the same world points at the same level and morph: the corners on its east edge are the next plate\'s on its west edge', () => {
    // Plate (0, 0) and plate (1, 0), a plate apart (`world/bounds.ts`): one line of the world between them, x = half.
    const a = 0, b = 2 * half;
    for (let level = 0; level < LOD_LEVELS; level++) {
      const step = 1 << level, span = LOD_PATCH * step;
      for (const k of [0, 0.25, 0.5, 1]) {
        const east = new Set<string>(), west = new Set<string>();
        for (let oy = 0; oy < seg; oy += span) {
          for (let gy = 0; gy <= LOD_PATCH; gy++) {
            const y = (placed(oy, gy, step, k) * cell - half).toFixed(6);
            // Plate a: the corners of its last patch along x that lie on its far edge; plate b: its first patch's first corner, on its low edge.
            const ox = Math.floor((seg - 1) / span) * span;
            for (let gx = 0; gx <= LOD_PATCH; gx++) {
              const x = placed(ox, gx, step, k);
              if (x === seg) east.add(`${(a - half + x * cell).toFixed(6)},${y}`);
            }
            west.add(`${(b - half + placed(0, 0, step, k) * cell).toFixed(6)},${y}`);
          }
        }
        expect(east.size).toBeGreaterThan(0);
        expect([...east].sort(), `level ${level}, morph ${k}`).toEqual([...west].sort());
      }
    }
  });

  it('draws a far plate with as many patches as a plate of the root\'s own side: four at its coarsest level', () => {
    const flat = (side: number): { heights: Float64Array; flip: Uint8Array } => ({ heights: new Float64Array((side + 1) ** 2), flip: new Uint8Array(side * side) });
    const far = (side: number): number => {
      const { heights, flip } = flat(side);
      const levels = new LandLevels(side);
      levels.markAll();
      levels.measure(heights, flip);
      const lod = new LandLod(levels, { seg: side, cell, half: (side * cell) / 2 }, { x: 0, y: 0 }, { west: true, east: true, north: true, south: true });
      const camera = new PerspectiveCamera(35, 16 / 9, 1, 1_000_000);
      camera.position.set(40_000, 9_000, -30_000);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      const count = lod.select(camera, 1080);
      const data = lod.geometry.getAttribute('aLodPatch').array as Float32Array;
      for (let k = 0; k < count; k++) expect(data[k * 4 + 3]).toBe(LOD_LEVELS - 1);
      return count * LOD_PATCH * LOD_PATCH * 2;
    };
    // The plate of 256 cells (the root's side, the grid of 2,560 m plates of 10 m) and the plate of 200: the same triangles from afar.
    expect(far(ROOT)).toBe(4 * LOD_PATCH * LOD_PATCH * 2);
    expect(far(seg)).toBe(far(ROOT));
  });

  it('refuses a plate that is not whole level-0 patches under one root', () => {
    expect(() => new LandLevels(seg + 4)).toThrow();
    expect(() => new LandLevels(ROOT + LOD_PATCH)).toThrow();
    expect(() => new LandLevels(seg)).not.toThrow();
  });
});
