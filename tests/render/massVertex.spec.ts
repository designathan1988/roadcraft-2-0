import { describe, expect, it } from 'vitest';

import { FACADE_BYTES, FACADE_FLOATS, FACADE_GRID, NORMAL_SHORTS, PAINT_ATTRIBUTE, SHELL_NORMAL, SHELL_SHORTS, cellMass, massPlaces, octDecode } from '@render/buildings/cellArrays';
import { FINISHES } from '@world/buildings/materials';
import { createBuildingKit } from '@render/buildings/kit';
import { cellMesh } from '@render/buildings/massCells';
import { massCorners, massesOf } from './support/masses';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import type { RunChunk, ShellChunk } from '@render/buildings/chunk';

/** A MASS VERTEX IS THE FACADE LEVEL'S OWN (`cellArrays.ts` CellMass, `buildingMesh.ts` massShells): its place, its octahedral normal, its paint
 *  with its finish and wear, and its run's window grid, copied as the facade level lays them; drawn by the shells' and the facade level's materials. */

const building = (n: number): Building => ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[n % BLUEPRINTS.length]!.body)), id: n + 1, x: n * 60, y: 30, rotation: n * 0.3 }) as Building;

/** A level's fragments in the order a mass merges them: its shells by finish, then its runs by finish. */
const fragmentsOf = (m: NonNullable<ReturnType<typeof massesOf>>): { shells: ShellChunk[]; runs: RunChunk[] } => ({
  shells: FINISHES.flatMap((f) => (m.shells[f] ? [m.shells[f]] : [])), runs: FINISHES.flatMap((f) => (m.runs?.[f] ? [m.runs[f]] : [])),
});

describe('a mass vertex', () => {
  it("holds in 48 bytes the facade level's own numbers (its runs' cover of what stands out of their walls among them), each copied as its shell and its runs laid it", () => {
    const chunks = [0, 3, 4, 6, 8].map((n) => massesOf(building(n), (x, y) => x * 0.01 + y * 0.02)!);
    const mass = cellMass(chunks)!;
    const vertices = mass.position.length / 3;
    const bytes = mass.position.byteLength + mass.normal.byteLength + mass.paint.byteLength + mass.facade.byteLength + mass.grid.byteLength + mass.opening.byteLength;
    expect(bytes / vertices).toBe(48);
    let v = 0, runs = 0;
    for (const c of chunks) {
      const { shells, runs: list } = fragmentsOf(c);
      for (const f of [...shells, ...list]) {
        const n = f.position.length / 3;
        expect([...mass.position.subarray(v * 3, (v + n) * 3)]).toEqual([...f.position]);
        expect([...mass.normal.subarray(v * NORMAL_SHORTS, (v + n) * NORMAL_SHORTS)]).toEqual([...f.normal]);
        expect([...mass.paint.subarray(v * SHELL_SHORTS, (v + n) * SHELL_SHORTS)]).toEqual([...f.paint]);
        if ('grid' in f) {
          const r = f as RunChunk;
          runs += n;
          expect([...mass.facade.subarray(v * FACADE_FLOATS, (v + n) * FACADE_FLOATS)]).toEqual([...r.facade]);
          expect([...mass.grid.subarray(v * FACADE_GRID, (v + n) * FACADE_GRID)]).toEqual([...r.grid]);
          expect([...mass.opening.subarray(v * FACADE_BYTES, (v + n) * FACADE_BYTES)]).toEqual([...r.opening]);
        } else expect(mass.grid.subarray(v * FACADE_GRID, (v + n) * FACADE_GRID).every((x) => x === 0)).toBe(true);
        v += n;
      }
    }
    // Its walls the facade level's runs of bays, and every triangle drawn once.
    expect(runs).toBeGreaterThan(0);
    expect(mass.index.length).toBe(chunks.reduce((s, c) => s + massCorners(c), 0));
  });

  it("is drawn with the facade level's attributes, its shells by the shells' material and its runs by the facade's", () => {
    const kit = createBuildingKit();
    const mass = cellMass([massesOf(building(3), () => 0)!])!;
    const mesh = cellMesh(mass, kit);
    const g = mesh.geometry;
    expect((g.getAttribute('facadeSize') as { isFloat16BufferAttribute?: boolean }).isFloat16BufferAttribute).toBe(true);
    expect(g.getAttribute(SHELL_NORMAL).itemSize).toBe(NORMAL_SHORTS);
    expect(g.getAttribute(PAINT_ATTRIBUTE).itemSize).toBe(4);
    expect(g.getAttribute('facadeCell').itemSize).toBe(FACADE_GRID);
    expect(mesh.material).toEqual([kit.shellMaterial, kit.facade]);
    expect(g.groups.map((q) => q.materialIndex)).toEqual([0, 1]);
    expect(g.groups[0]!.count + g.groups[1]!.count).toBe(mass.index.length);
    kit.dispose();
  });
});

describe('a mass\'s slabs', () => {
  it('share their corners between their triangles: a roof slab is its points once, not three a triangle', () => {
    for (const n of [0, 3, 4, 6, 8]) {
      const mass = cellMass([massesOf(building(n), () => 0)!])!;
      const up = (v: number): boolean => octDecode(mass.normal[v * 2]!, mass.normal[v * 2 + 1]!)[1] > 0.9999;
      // The flat faces' triangles and the points they are drawn from: shared, fewer points than three a triangle.
      const used = new Set<number>();
      let triangles = 0;
      for (let t = 0; t < mass.index.length; t += 3) {
        const corners = [mass.index[t]!, mass.index[t + 1]!, mass.index[t + 2]!];
        if (!corners.every(up)) continue;
        triangles++;
        for (const c of corners) used.add(c);
      }
      expect(triangles, `building ${n}`).toBeGreaterThan(0);
      expect(used.size, `building ${n}`).toBeLessThan(triangles * 3);
    }
  });
});

describe('a lot\'s plate in the masses', () => {
  it('is its corners once: a paved lot of four corners is four points and two triangles', () => {
    const b = building(0);
    // Its one block made a paved lot: the masses draw its plate alone (`emitLotPlates`).
    b.volumes = [{ ...b.volumes[0]!, open: 'paving' }];
    const mass = cellMass([massesOf(b, () => 0)!])!;
    expect(mass.index.length / 3).toBe(2);
    expect(mass.position.length / 3).toBe(4);
  });
});

describe('masses on their square\'s grid', () => {
  it('put every point within half a step of its float, a point laid twice the same point, in 8 bytes for 12', () => {
    // A row of blocks back to back: corners shared between buildings.
    const row = Array.from({ length: 12 }, (_, i) => ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[3]!.body)), id: i + 1, x: 10 + (i % 6) * 18, y: 20 + Math.floor(i / 6) * 12, rotation: 0 }) as Building);
    const chunks = row.map((b) => massesOf(b, (x, y) => x * 0.01 + y * 0.02)!);
    for (const square of [{ i0: 0, j0: 0, n: 1 }, { i0: 0, j0: 0, n: 4 }, { i0: -4, j0: -4, n: 8 }]) {
      const floats = cellMass(chunks)!, onGrid = cellMass(chunks, square)!;
      expect(onGrid.place, `square ${square.n}`).toBeDefined();
      expect(onGrid.position.byteLength / (floats.position.length / 3)).toBe(8);
      const f = floats.position as Float32Array, q = massPlaces(onGrid), step = onGrid.place!.step;
      const seen = new Map<string, string>();
      let shared = 0;
      for (let v = 0; v < f.length / 3; v++) {
        for (let c = 0; c < 3; c++) expect(Math.abs(q[v * 3 + c]! - f[v * 3 + c]!)).toBeLessThanOrEqual(step / 2 + 1e-4);
        const key = [f[v * 3], f[v * 3 + 1], f[v * 3 + 2]].join(), got = [q[v * 3], q[v * 3 + 1], q[v * 3 + 2]].join();
        const was = seen.get(key);
        if (was !== undefined) { expect(got).toBe(was); shared++; } else seen.set(key, got);
      }
      expect(shared).toBeGreaterThan(50);
      // A hundredth of the level's error: a cell's 2.9 mm, a tile's 8.8 mm, a plate's 16.6 mm (the squares of 1,000 and 2,000 m and their margins in 16 bits).
      expect(step / 2).toBeLessThan(square.n === 1 ? 0.003 : square.n === 4 ? 0.009 : 0.017);
    }
  });
});
