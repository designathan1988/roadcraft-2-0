import { readFileSync } from 'node:fs';
import { Box3, Frustum, MeshBasicMaterial, Plane, Vector3, type BufferAttribute, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import { coarseArrays, levelsOf } from '@render/mesh/roadLod';
import { marksRoadSection } from '@render/mesh/roadEdges';
import { type BlockLock, COARSE_ERROR } from '@render/mesh/roadLodPure';
import { type CellCover, FAR_MARGIN, type RoadResidency, makeFar, makeNear, updateRoadLevels } from '@render/mesh/roadResidency';
import { TABLE_SLOTS, attachFarLevel, blockArraysOf, cloneBlock, joinBlocks, memberSizes, mergeTiles, splitBlock } from '@render/mesh/surfaceTiles';
import { refillArrays } from '@render/mesh/gpuOnly';
import type { Tile } from '@render/mesh/tileMesh';
import { geometryCost } from '@render/gpuLedger';

/** THE FAR LEVEL OF A BLOCK OF ROAD (`mesh/roadLod.ts`, `mesh/roadResidency.ts`) */
const W = 200, H = 12, STEP = 3.2;

/** A flat road strip W x H (world x, y; the mesh's z = -y) as a lattice a surface's refinement would give. */
function strip(): Tile {
  const nx = Math.floor(W / STEP) + 2, ny = 5;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.min(W, i * STEP), y = (H * j) / (ny - 1);
    positions.push(x, 0.002 * Math.sin(x / 40), -y);
    uvs.push(x / 4, y / 4);
  }
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) { const a = j * nx + i; indices.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1); }
  const n = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(n * 3).map((_, k) => (k % 3 === 1 ? 1 : 0)),
    uvs: new Float32Array(uvs), colors: new Float32Array(n * 3).fill(1), sections: new Float32Array(n * 3),
    indices: new Uint32Array(indices),
  };
}

const options = { name: 'asphalt', material: new MeshBasicMaterial(), receiveShadow: true } as const;
// A road crossing its block from one side to the other: only its two ends lie on the block's edge. No seam inside it.
const box = [0, -60, W, H + 60] as const;
const lock: BlockLock = { box, seams: new Float64Array() };
/** The block with its far level made as a worker makes it (`roadTile.worker.ts`): the arrays copied, simplified, handed back. */
const make = (near: boolean): Mesh => mergeTiles([strip()], options, () => [strip()], TABLE_SLOTS, {
  lock, near,
  start: (block, arrays) => { const made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(block, made, options, [{ source: () => [strip()], slots: TABLE_SLOTS, lock }], near); },
})!;
const levels = (mesh: Mesh): { coarse: Mesh; full: boolean } => mesh.userData.lod as { coarse: Mesh; full: boolean };
const trianglesOf = (mesh: Mesh): number => (mesh.geometry.index?.count ?? 0) / 3;

describe('a block of road with a far level', () => {
  it('carries the colour and the section only where its material reads them, at both levels', () => {
    const plain = make(true);
    for (const level of [plain, levels(plain).coarse]) {
      expect(level.geometry.getAttribute('color')).toBeUndefined();
      expect(level.geometry.getAttribute('roadSection')).toBeUndefined();
    }
    const reading = new MeshBasicMaterial({ vertexColors: true });
    marksRoadSection(reading);
    const both = { ...options, material: reading };
    const mesh = mergeTiles([strip()], both, () => [strip()], TABLE_SLOTS, {
      lock, near: true,
      start: (block, arrays) => { const made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(block, made, both, [{ source: () => [strip()], slots: TABLE_SLOTS, lock }], true); },
    })!;
    for (const level of [mesh, levels(mesh).coarse]) {
      expect(level.geometry.getAttribute('color')).toBeDefined();
      expect(level.geometry.getAttribute('roadSection')).toBeDefined();
    }
  });

  it('has a far level a tenth of its size or less, that keeps the block\'s outer edge where it was', () => {
    const mesh = make(true);
    const coarse = levels(mesh).coarse;
    expect(trianglesOf(coarse)).toBeLessThan(trianglesOf(mesh) * 0.1);
    const keyOf = (p: BufferAttribute, i: number): string => `${p.getX(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    const far = new Set<string>();
    const farPosition = coarse.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < farPosition.count; i++) far.add(keyOf(farPosition, i));
    const position = mesh.geometry.getAttribute('position') as BufferAttribute;
    let onEdge = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = -position.getZ(i);
      if (Math.abs(x) < 1e-3 || Math.abs(x - W) < 1e-3 || y < box[1] + 1e-3 || y > box[3] - 1e-3) {
        onEdge++;
        expect(far.has(keyOf(position, i)), `edge vertex ${keyOf(position, i)}`).toBe(true);
      }
    }
    expect(onEdge).toBe(10);
  });

  it('keeps every vertex on a seam where it was: where its pieces meet the pieces of the next block, inside its box', () => {
    // A mouth across the road at x = 96 (a lattice column): the road's end on a junction drawn in another block.
    const seamed: BlockLock = { box, seams: Float64Array.of(96, -1, 96, H + 1) };
    const arrays = blockArraysOf([strip()], options.material, TABLE_SLOTS)!;
    const coarse = coarseArrays(cloneBlock(arrays), seamed)!;
    const plain = coarseArrays(cloneBlock(arrays), lock)!;
    const keyOf = (p: Float32Array, i: number): string => `${p[i * 3]!.toFixed(3)},${p[i * 3 + 2]!.toFixed(3)}`;
    const far = new Set(Array.from({ length: coarse.position.length / 3 }, (_, i) => keyOf(coarse.position, i)));
    const plainFar = new Set(Array.from({ length: plain.position.length / 3 }, (_, i) => keyOf(plain.position, i)));
    let onSeam = 0, keptWithout = 0;
    for (let i = 0; i < arrays.position.length / 3; i++) {
      if (Math.abs(arrays.position[i * 3]! - 96) > 1e-3) continue;
      onSeam++;
      expect(far.has(keyOf(arrays.position, i)), `seam vertex ${keyOf(arrays.position, i)}`).toBe(true);
      if (plainFar.has(keyOf(arrays.position, i))) keptWithout++;
    }
    expect(onSeam).toBe(5);
    // Without the seam the simplifier takes them away: the lock is what keeps them.
    expect(keptWithout).toBeLessThan(onSeam);
  });

  it('keeps the mouth two blocks share on the same vertices at both far levels: no crack between a road and its junction', () => {
    // A road's strips in one block, x 0 to 100, its junction's in another, x 100 to 200: the mouth at x = 100 is both pieces' seam.
    const part = (x0: number, x1: number): Tile => {
      const t = strip();
      const keep: number[] = [];
      const p = t.positions;
      for (let i = 0; i < t.indices.length; i += 3) {
        const v = [t.indices[i]!, t.indices[i + 1]!, t.indices[i + 2]!];
        // Positions are floats: 99.2 is stored as 99.1999969.
        if (v.every((k) => p[k * 3]! >= x0 - 1e-3 && p[k * 3]! <= x1 + 1e-3)) keep.push(...v);
      }
      return { ...t, indices: Uint32Array.from(keep) };
    };
    const mouth = Float64Array.of(99.2, -1, 99.2, H + 1);
    const road = coarseArrays(blockArraysOf([part(0, 99.2)], options.material, TABLE_SLOTS)!, { box: [0, 0, 99.2, H], seams: mouth })!;
    const junction = coarseArrays(blockArraysOf([part(99.2, W)], options.material, TABLE_SLOTS)!, { box: [99.2, 0, W, H], seams: mouth })!;
    const onMouth = (arrays: { position: Float32Array; index: ArrayLike<number> }): string[] => {
      const used = new Set(Array.from(arrays.index));
      return [...used].filter((v) => Math.abs(arrays.position[v * 3]! - 99.2) < 1e-3).map((v) => (-arrays.position[v * 3 + 2]!).toFixed(3)).sort();
    };
    const full = onMouth(blockArraysOf([part(0, 99.2)], options.material, TABLE_SLOTS)!);
    expect(full).toHaveLength(5);
    // Both simplified, both keep every vertex of the mouth: the two coarse edges are the same polyline.
    expect(onMouth(road)).toEqual(full);
    expect(onMouth(junction)).toEqual(full);
  });

  it('is within the error allowed of the block (a flat road: no vertex of the block is farther than that off the far level\'s plane)', () => {
    const mesh = make(true);
    const coarse = levels(mesh).coarse;
    const heights = (m: Mesh): number[] => { const p = m.geometry.getAttribute('position') as BufferAttribute; return Array.from({ length: p.count }, (_, i) => p.getY(i)); };
    const spread = (h: number[]): number => Math.max(...h) - Math.min(...h);
    expect(spread(heights(coarse))).toBeLessThanOrEqual(spread(heights(mesh)) + COARSE_ERROR);
  });

  it('made near shows its own mesh and hides the far one', () => {
    const mesh = make(true);
    expect(mesh.visible).toBe(true);
    expect(levels(mesh).coarse.visible).toBe(false);
    expect(levels(mesh).full).toBe(true);
  });

  it('made far shows the far level and has no arrays of its own, which are given back when it comes near', () => {
    const mesh = make(false);
    expect(mesh.visible).toBe(false);
    expect(levels(mesh).coarse.visible).toBe(true);
    expect((mesh.geometry.getAttribute('position') as { array: unknown }).array).toBeNull();
    expect((mesh.geometry.index as { array: unknown }).array).toBeNull();
    makeNear(mesh);
    expect(mesh.visible).toBe(true);
    expect(levels(mesh).coarse.visible).toBe(false);
    expect((mesh.geometry.getAttribute('position') as BufferAttribute).array.length).toBe(strip().positions.length);
    makeFar(mesh);
    expect(mesh.visible).toBe(false);
    expect(levels(mesh).coarse.visible).toBe(true);
    expect((mesh.geometry.getAttribute('position') as { array: unknown }).array).toBeNull();
  });
});

describe('a far level on the GPU', () => {
  it('lets go of the arrays its worker made once they are sent, and is made again from the block\'s tiles, never from them', () => {
    let tiles: Tile[] = [strip()];
    let made: ReturnType<typeof coarseArrays> = null;
    const block = mergeTiles([strip()], options, () => tiles, TABLE_SLOTS, {
      lock, near: false,
      start: (b, arrays) => { made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(b, made, options, [{ source: () => tiles, slots: TABLE_SLOTS, lock }], false); },
    })!;
    const level = levels(block).coarse;
    expect(made).not.toBeNull();
    const kept = made!;
    const position = level.geometry.getAttribute('position') as BufferAttribute;
    // Sent to the GPU: its arrays let go (`gpuOnly`).
    for (const a of [...Object.values(level.geometry.attributes), level.geometry.index!]) (a as unknown as { onUploadCallback: () => void }).onUploadCallback.call(a);
    expect((position as { array: unknown }).array).toBeNull();
    // A lost context: made again from the tiles, the same far level.
    refillArrays(level);
    expect(position.array).not.toBe(kept.position);
    expect(Array.from(position.array)).toEqual(Array.from(kept.position));
    // Tiles that no longer simplify (too small to gain): arrays of its sizes, never the worker's it was made with.
    for (const a of [...Object.values(level.geometry.attributes), level.geometry.index!]) (a as unknown as { onUploadCallback: () => void }).onUploadCallback.call(a);
    tiles = [{ positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 0, -1), normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0), uvs: new Float32Array(6), colors: new Float32Array(0), sections: new Float32Array(0), indices: Uint32Array.of(0, 2, 1) }];
    refillArrays(level);
    expect(position.array).not.toBe(kept.position);
    expect(level.geometry.index!.array).not.toBe(kept.index);
    expect(position.array.length).toBe(kept.position.length);
    expect(level.geometry.index!.array.length).toBe(kept.index.length);
  });

  it('is made again whole where its block was too small to simplify and was drawn whole far', () => {
    const small: Tile = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 0, -1), normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0), uvs: new Float32Array(6), colors: new Float32Array(0), sections: new Float32Array(0), indices: Uint32Array.of(0, 2, 1) };
    const block = mergeTiles([small], options, () => [small], TABLE_SLOTS, {
      lock, near: false,
      // As `roadSurfaces.ts` start: a block that does not simplify drawn far as it is.
      start: (b, arrays) => { expect(coarseArrays(cloneBlock(arrays), lock)).toBeNull(); attachFarLevel(b, cloneBlock(arrays), options, [{ source: () => [small], slots: TABLE_SLOTS, lock }], false); },
    })!;
    const level = levels(block).coarse;
    const position = level.geometry.getAttribute('position') as BufferAttribute;
    for (const a of [...Object.values(level.geometry.attributes), level.geometry.index!]) (a as unknown as { onUploadCallback: () => void }).onUploadCallback.call(a);
    expect((position as { array: unknown }).array).toBeNull();
    // A lost context: its own triangle again, not one of no area.
    refillArrays(level);
    expect(Array.from(position.array)).toEqual(Array.from(small.positions));
    expect(Array.from(level.geometry.index!.array)).toEqual(Array.from(small.indices));
  });
});

describe('a block brought near from the kept tiles', () => {
  it('asks its arrays off the page once and shows the full level when they land; cut on the page only when they are not kept', async () => {
    const mesh = make(false);
    const lv = levels(mesh) as unknown as { bring: (() => Promise<unknown>) | null };
    let asked = 0;
    lv.bring = () => { asked++; return new Promise((done) => setTimeout(() => done(blockArraysOf([strip()], options.material, TABLE_SLOTS)), 0)); };
    makeNear(mesh);
    expect(asked).toBe(1);
    expect(levels(mesh).full).toBe(false);
    expect(mesh.visible).toBe(false);
    // Asked again while it is under way: nothing more.
    makeNear(mesh);
    updateRoadLevels([mesh], (mesh.userData.lod as { x: number }).x, 0, 500);
    expect(asked).toBe(1);
    await new Promise((done) => setTimeout(done, 0));
    expect(levels(mesh).full).toBe(true);
    expect(mesh.visible).toBe(true);
    expect(levels(mesh).coarse.visible).toBe(false);
    expect((mesh.geometry.getAttribute('position') as BufferAttribute).array.length).toBe(strip().positions.length);
    // Not kept: cut again on the page.
    makeFar(mesh);
    lv.bring = () => Promise.resolve(null);
    makeNear(mesh);
    await new Promise((done) => setTimeout(done, 0));
    expect(levels(mesh).full).toBe(true);
    expect((mesh.geometry.getAttribute('position') as BufferAttribute).array.length).toBe(strip().positions.length);
  });
});

describe('the levels brought up to the camera', () => {
  const block = (x: number): Mesh => { const mesh = make(true); const lv = mesh.userData.lod as { x: number; z: number }; lv.x = x; lv.z = 0; return mesh; };

  it('sends a block far beyond the reach with its margin, and not before', () => {
    const near = block(0), edge = block(500 * FAR_MARGIN - 1), beyond = block(500 * FAR_MARGIN + 1);
    updateRoadLevels([near, edge, beyond], 0, 0, 500);
    expect([near, edge, beyond].map((m) => levels(m).full)).toEqual([true, true, false]);
  });

  it('brings a block near within the reach, the nearest first and a few at a look', () => {
    const blocks = [400, 100, 300, 200, 50].map(block);
    for (const b of blocks) makeFar(b);
    updateRoadLevels(blocks, 0, 0, 500);
    // Three of five: the nearest (50, 100, 200).
    expect(blocks.map((b) => levels(b).full)).toEqual([false, true, false, true, true]);
    updateRoadLevels(blocks, 0, 0, 500);
    expect(blocks.every((b) => levels(b).full)).toBe(true);
  });

  it('does not send a block back and forth on the line (the margin between going far and coming near)', () => {
    const b = block(520);
    updateRoadLevels([b], 0, 0, 500);
    expect(levels(b).full).toBe(true);
    makeFar(b);
    updateRoadLevels([b], 0, 0, 500);
    expect(levels(b).full).toBe(false);
  });
});

describe('the near level under the budget and the view (`RoadResidency`)', () => {
  /** A block whose centre is at `x` and whose box spans x to x + W (three's axes). */
  const placed = (x: number): Mesh => {
    const mesh = make(true);
    const lv = mesh.userData.lod as { x: number; z: number };
    lv.x = x + W / 2; lv.z = 0;
    mesh.geometry.boundingBox = new Box3(new Vector3(x, 0, -H), new Vector3(x + W, 1, 0));
    return mesh;
  };
  /** The view's frustum over x0..x1 alone (every other side open). */
  const over = (x0: number, x1: number): Frustum => new Frustum(
    new Plane(new Vector3(1, 0, 0), -x0), new Plane(new Vector3(-1, 0, 0), x1),
    new Plane(new Vector3(0, 1, 0), 1e6), new Plane(new Vector3(0, -1, 0), 1e6), new Plane(new Vector3(0, 0, 1), 1e6), new Plane(new Vector3(0, 0, -1), 1e6));
  const bytes = (mesh: Mesh): number => geometryCost(mesh.geometry).bytes;

  it('lets go the full level of the blocks out of the view first, the least recently seen first, past the budget; the far level stands', () => {
    const [a, b, c] = [placed(0), placed(1000), placed(2000)];
    const one = bytes(a);
    const residency: RoadResidency = { view: over(0, 200), budget: 3 * one };
    // All three fit: the view over a alone keeps every full level, a seen now.
    updateRoadLevels([a, b, c], 1100, 0, 5000, residency);
    expect([a, b, c].map((m) => levels(m).full)).toEqual([true, true, true]);
    // Room for two, the view over c: b was never seen, it goes first.
    Object.assign(residency, { view: over(2000, 2200), budget: 2 * one });
    updateRoadLevels([a, b, c], 1100, 0, 5000, residency);
    expect([a, b, c].map((m) => levels(m).full)).toEqual([true, false, true]);
    expect(levels(b).coarse.visible).toBe(true);
    // Room for one: a, out of the view, goes; c in it stays.
    residency.budget = one;
    updateRoadLevels([a, b, c], 1100, 0, 5000, residency);
    expect([a, b, c].map((m) => levels(m).full)).toEqual([false, false, true]);
    expect([a, b].every((m) => levels(m).coarse.visible && !m.visible)).toBe(true);
  });

  it('brings near only the blocks in the view, and none past the budget', () => {
    const [a, b, c] = [placed(0), placed(300), placed(3000)];
    const one = bytes(a);
    // Seen near once (their full level's bytes measured), then far.
    updateRoadLevels([a, b, c], 0, 0, 5000, { view: over(0, 4000), budget: Infinity });
    for (const m of [a, b, c]) makeFar(m);
    // c is out of the view; a and b in it, room for one: the nearest.
    updateRoadLevels([a, b, c], 0, 0, 5000, { view: over(0, 600), budget: one * 1.5 });
    expect([a, b, c].map((m) => levels(m).full)).toEqual([true, false, false]);
    expect([b, c].every((m) => levels(m).coarse.visible)).toBe(true);
    // Room for all: b comes in, c out of the view does not.
    updateRoadLevels([a, b, c], 0, 0, 5000, { view: over(0, 600), budget: 10 * one });
    expect([a, b, c].map((m) => levels(m).full)).toEqual([true, true, false]);
  });

  it('forgets a far block\'s full level\'s size with its arrays: nothing of it is counted as held', () => {
    const a = placed(0);
    const position = a.geometry.getAttribute('position') as BufferAttribute & { keptBytes?: number };
    position.keptBytes = position.array.byteLength;
    makeFar(a);
    expect(position.keptBytes).toBeUndefined();
    expect(bytes(a)).toBe(0);
  });
});

describe('the roads\' cells chosen by the view, their far levels under the far budget (`RoadResidency`)', () => {
  /** A far block alone in its cell, centred at `x` (box x to x + W). */
  const far = (x: number, cell: string): Mesh => {
    const mesh = make(false);
    const lv = levelsOf(mesh)!;
    Object.assign(lv, { x: x + W / 2, z: 0, cell });
    mesh.geometry.boundingBox = new Box3(new Vector3(x, 0, -H), new Vector3(x + W, 1, 0));
    lv.coarse!.geometry.boundingBox = mesh.geometry.boundingBox.clone();
    return mesh;
  };
  /** The network's far level as the residency sees it: the cells it covers, the ones shown. */
  const network = (covered: (key: string) => boolean = () => true): CellCover & { shown: Set<string> } => {
    const shown = new Set<string>();
    return { shown, covers: covered, show: (key) => { shown.add(key); }, hide: (key) => { shown.delete(key); } };
  };
  const over = (x0: number, x1: number): Frustum => new Frustum(
    new Plane(new Vector3(1, 0, 0), -x0), new Plane(new Vector3(-1, 0, 0), x1),
    new Plane(new Vector3(0, 1, 0), 1e6), new Plane(new Vector3(0, -1, 0), 1e6), new Plane(new Vector3(0, 0, 1), 1e6), new Plane(new Vector3(0, 0, -1), 1e6));
  const farBytes = (mesh: Mesh): number => geometryCost(levelsOf(mesh)!.coarse!.geometry).bytes;
  /** The map's road cells on a grid of `SIDE` units, the network's level's triangles in each. */
  const SIDE = 1000;
  const roads = (...keys: string[]): Map<string, number> => new Map(keys.map((key) => [key, 100]));
  /** A residency whose cells `keys` are taken (built). */
  const taken = (...keys: string[]): RoadResidency => ({ taken: new Set(keys), awaiting: new Set(), releasing: new Set(), parked: new Set() });

  it('asks the cells the view wants and no other: the ones in the frustum within the want reach, nearest first, then the ones within the reach', () => {
    const residency: RoadResidency = { ...taken(), view: over(100, 3100), budget: Infinity, farBudget: Infinity, network: network(), wantReach: 2500 };
    // The eye at x = 50: the cells 0 to 2 lie in the frustum within 2,500 units (gaps 0, 950, 1,950); the third is 2,950 away; the one behind the eye is out of the frustum, 50 away: within the reach.
    const look = updateRoadLevels([], 50, 0, 600, residency, roads('-1,0', '0,0', '1,0', '2,0', '3,0'), SIDE);
    expect(look.build).toEqual(['0,0', '1,0', '2,0', '-1,0']);
    expect(look.wanted).toBe(4);
    expect(look.release).toEqual([]);
  });

  it('builds past the far budget only within the reach: the rest of the view stays with the network\'s level', () => {
    // Each cell reckoned at its 100 triangles of the network's level times the bytes a triangle before any cell measured them: room for two.
    const residency: RoadResidency = { ...taken(), view: over(100, 3100), budget: Infinity, farBudget: 2 * 100 * 640, network: network(), wantReach: 2500 };
    const look = updateRoadLevels([], 50, 0, 600, residency, roads('-1,0', '0,0', '1,0', '2,0'), SIDE);
    // The third of the view is left to the network's level; the one within the reach is taken past the budget.
    expect(look.build).toEqual(['0,0', '1,0', '-1,0']);
  });

  it('lets the farthest built cells the view does not want go past the budget, the network\'s level shown there, and gives one back when the view wants it before it is retired', () => {
    const blocks = [far(0, '0,0'), far(1000, '1,0'), far(2000, '2,0')];
    const one = farBytes(blocks[0]!);
    const cover = network();
    const residency: RoadResidency = { ...taken('0,0', '1,0', '2,0'), view: over(-1e5, 1e5), budget: Infinity, farBudget: 2 * one, network: cover, wantReach: 150 };
    // The eye at the first cell: wanted within the reach, the other two not; over the budget by one cell, the farthest goes - its blocks hidden, the network's level shown there, its blocks still standing for the owner to retire.
    let look = updateRoadLevels(blocks, 0, 0, 150, residency, roads('0,0', '1,0', '2,0'), SIDE);
    expect(look.release).toEqual(['2,0']);
    expect([...cover.shown]).toEqual(['2,0']);
    expect(levelsOf(blocks[2]!)!.coarse!.visible).toBe(false);
    expect(levelsOf(blocks[1]!)!.coarse!.visible).toBe(true);
    expect(blocks[0]!.visible || levelsOf(blocks[0]!)!.coarse!.visible).toBe(true);
    // The eye over the third before it is retired: wanted again, it comes back as it was (taken, its blocks shown, the network's level hidden); over the budget, the second goes instead (the first is held while its full level goes far).
    look = updateRoadLevels(blocks, 2100, 0, 150, residency, roads('0,0', '1,0', '2,0'), SIDE);
    expect(look.release).toEqual(['1,0']);
    expect(cover.shown.has('2,0')).toBe(false);
    expect(cover.shown.has('1,0')).toBe(true);
    expect(levelsOf(blocks[2]!)!.coarse!.visible).toBe(true);
    expect(residency.taken!.has('2,0')).toBe(true);
    expect(look.build).toEqual([]);
  });

  it('keeps a cell the network\'s level does not cover, and asks for the level', () => {
    const blocks = [far(0, '0,0'), far(1000, '1,0')];
    const residency: RoadResidency = { ...taken('0,0', '1,0'), view: null, budget: Infinity, farBudget: 0, network: network((key) => key === '0,0') };
    const look = updateRoadLevels(blocks, 5000, 0, 10, residency, roads('0,0', '1,0'), SIDE);
    expect(look.release).toEqual(['0,0']);
    expect(levelsOf(blocks[1]!)!.coarse!.visible).toBe(true);
    expect(residency.wantsNetwork).toBe(true);
  });

  it('keeps every far level with no network\'s level to stand for them', () => {
    const blocks = [far(0, '0,0'), far(1000, '1,0')];
    const look = updateRoadLevels(blocks, 5000, 0, 10, { ...taken('0,0', '1,0'), view: null, budget: Infinity, farBudget: 0 }, roads('0,0', '1,0'), SIDE);
    expect(look.release).toEqual([]);
    expect(blocks.every((m) => levelsOf(m)!.coarse!.visible)).toBe(true);
  });
});

describe('the wiring', () => {
  it('has the renderer make the blocks near or far by the camera, and the roads free the far level with the block', () => {
    const renderer = readFileSync('src/render/renderer.ts', 'utf8');
    expect(renderer).toMatch(/near: \(x, y\) => isNear\(x, y, roadFocus\.x, roadFocus\.y, roadFocus\.reach\)/);
    // The cells the view wants are the network's far level's: the look chooses from them, never from the map's extent.
    expect(renderer).toMatch(/updateRoadLevels\(blocks, roadFocus\.x, roadFocus\.y, roadFocus\.reach, roadResidency, networkFar\.cells\.size \? networkFar\.cells : null, FAR_ROAD_CELL\)/);
    expect(renderer).not.toMatch(/networkExtent|fillStep|fillLeft/);
    expect(readFileSync('src/render/mesh/surfaceMesh.ts', 'utf8')).toMatch(/coarse\.geometry\.dispose\(\)/);
    // The far level is simplified by the workers: the page asks
    expect(readFileSync('src/render/roadSurfaces.ts', 'utf8')).not.toMatch(/coarseArrays\(/);
    expect(readFileSync('src/render/roadSurfaces.ts', 'utf8')).toMatch(/tiler\.coarsen\.bind\(tiler\)/);
    expect(readFileSync('src/render/roadTile.worker.ts', 'utf8')).toMatch(/coarseArrays\(data\.coarse\.arrays, data\.coarse\.lock\)/);
    // The masses of the far buildings are sent ahead too, so their arrays go (`gpuOnly`): 157 MB of a 2,560 m city.
    const masses = readFileSync('src/render/buildings/massCells.ts', 'utf8');
    expect(masses).toMatch(/void warmLooseAhead\(\[mesh\], priority\);/);
    expect(masses).toMatch(/cancelWarm\(\[cell\.mesh\]\);/);
  });
});

describe('the far levels made by the workers while the roads are built', () => {
  it('are waited for before the roads are put in place, and every block made far is drawn by its far level alone', async () => {
    const { planCity, DEFAULT_CITY } = await import('@world/cityGen/plan');
    const { layCity } = await import('@editor/cityGenerator');
    const { Network } = await import('@world/network');
    const { buildRoadElevation } = await import('@world/elevation');
    const { roadSurfaceSteps } = await import('@render/roadSurfaces');
    const { SurfaceInputs } = await import('@render/roadSurfaceInputs');
    const { levelsOf } = await import('@render/mesh/roadLod');
    const net = new Network(layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })));
    net.rebuild();
    const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);
    const materials = new Proxy({}, { get: (_t, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial() }) as never;
    let asked = 0;
    // The worker, in this process: no tiles off the page (built here), the far levels by a copy and a later answer.
    const tiler = {
      tiles: () => Promise.reject(new Error('the tiles are built here')),
      check: () => {},
      coarsen: (arrays: Parameters<typeof coarseArrays>[0], blockLock: BlockLock) => {
        asked++;
        return new Promise<ReturnType<typeof coarseArrays>>((done) => setTimeout(() => done(coarseArrays(structuredClone(arrays), blockLock)), 0));
      },
    };
    const reuse = { tiles: new Map(), dependsOn: () => 0, chunks: new Map(), inputs: new SurfaceInputs(), near: () => false } as never;
    const steps = roadSurfaceSteps(net, buildRoadElevation(net, ground), materials, ground, reuse, tiler as never);
    let waited = 0;
    for (;;) {
      const step = steps.next();
      if (step.done) { step.value.adopt(); break; }
      if (step.value === 'wait') { waited++; await new Promise((done) => setTimeout(done, 0)); }
    }
    // The city's blocks, each made far: four blocks of each of its surfaces (footway, dropped kerb, kerb, carriageway), 16. Its paint is no block
    // of its own any more (the carriageway's shader draws it, `roadMarks.ts`): the 20 this asked for counted the paint's blocks too.
    expect(asked).toBeGreaterThanOrEqual(16);
    expect(waited).toBeGreaterThan(0);
    const chunks = [...(reuse as { chunks: Map<string, { mesh: Mesh }> }).chunks.values()].map((c) => c.mesh);
    const withLevel = chunks.filter((m) => levelsOf(m)?.coarse);
    expect(withLevel.length).toBeGreaterThanOrEqual(16);
    for (const mesh of withLevel) {
      const level = levelsOf(mesh)!;
      expect(level.full).toBe(false);
      expect(mesh.visible).toBe(false);
      expect(level.coarse!.visible).toBe(true);
      expect(level.coarse!.parent).toBe(mesh.parent);
      expect((mesh.geometry.getAttribute('position') as { array: unknown }).array).toBeNull();
    }
    // A block too small for a far level stays what it was, drawn at full detail.
    for (const mesh of chunks.filter((m) => !levelsOf(m)?.coarse)) expect(mesh.visible).toBe(true);
  });
});

describe('a block of several surfaces drawn alike (`roadSurfaces.ts` drawGroups)', () => {
  it('cuts back into each surface as its own block was, and joins again to the block', () => {
    const a = strip(), b = strip();
    const block = blockArraysOf([a, b], options.material, TABLE_SLOTS)!;
    const [first, second] = splitBlock(block, memberSizes([[a], [b]]));
    // Each piece the arrays its surface alone would have made: what its worker simplified when it was a block of its own.
    for (const piece of [first!, second!]) {
      const own = blockArraysOf([strip()], options.material, TABLE_SLOTS)!;
      expect(Array.from(piece.position)).toEqual(Array.from(own.position));
      expect(Array.from(piece.index)).toEqual(Array.from(own.index));
      expect(piece.index.constructor).toBe(own.index.constructor);
    }
    const joined = joinBlocks([first!, second!]);
    for (const key of ['position', 'normal', 'uv', 'index'] as const) expect(Array.from(joined[key])).toEqual(Array.from(block[key]));
  });

  it('stays near while any of its surfaces would be near, and goes far once none is', () => {
    const block = mergeTiles([strip()], options, () => [strip()], TABLE_SLOTS, {
      lock, near: true, also: [[5000, 0, 5200, 10]],
      start: (b, arrays) => { const made = coarseArrays(cloneBlock(arrays), lock); if (made) attachFarLevel(b, made, options, [{ source: () => [strip()], slots: TABLE_SLOTS, lock }], true); },
    })!;
    // The eye over the other surface's block: the first surface's is far from it, the block stays whole.
    updateRoadLevels([block], 5100, 5, 300);
    expect(levelsOf(block)!.full).toBe(true);
    updateRoadLevels([block], -5000, 0, 300);
    expect(levelsOf(block)!.full).toBe(false);
  });
});
