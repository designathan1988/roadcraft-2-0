import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, PointLight, Quaternion, Vector3 } from 'three';
import { createBlast } from '@render/blast';
import type { Exhaust } from '@render/exhaust';

/** CRATERS WRITTEN ONLY WHILE THEY GROW OR THE SET CHANGES (MISSION 2d): a grown crater never moves, so its matrix is not composed and
 *  sent again every frame; it still ends at its full size, and a new crater or a clear writes them again. */

let saved: unknown;

beforeAll(() => {
  saved = (globalThis as { document?: unknown }).document;
  // The craters' and soot's canvases (node has none): a 2D context that draws nothing.
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
    set fillStyle(_: unknown) {}, set strokeStyle(_: unknown) {}, set lineWidth(_: unknown) {},
  };
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
});

afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
});

describe('blast craters', () => {
  it('are written while they grow and when one comes or all go, not at every frame once grown', () => {
    const blast = createBlast({ burst: () => {} } as unknown as Exhaust, new PointLight());
    const world = { groundAt: () => 0 };
    const road = blast.group.children.find((c) => c.name === 'blast-craters') as InstancedMesh;
    blast.crater(0, 0, 0, 8, 'road');
    for (let frame = 0; frame < 30; frame++) blast.update(1 / 60, world);
    // Grown to its full size: 2 r across.
    const matrix = new Matrix4(), scale = new Vector3();
    road.getMatrixAt(0, matrix);
    matrix.decompose(new Vector3(), new Quaternion(), scale);
    expect(road.count).toBe(1);
    expect(scale.x).toBeCloseTo(16, 6);
    // A second of a still street: nothing written or sent again.
    const grown = road.instanceMatrix.version;
    for (let frame = 0; frame < 60; frame++) blast.update(1 / 60, world);
    expect(road.instanceMatrix.version).toBe(grown);
    // Another crater: written again, both drawn.
    blast.crater(50, 0, 0, 4, 'road');
    blast.update(1 / 60, world);
    expect(road.instanceMatrix.version).toBeGreaterThan(grown);
    expect(road.count).toBe(2);
    // All let go: none drawn.
    blast.clear();
    blast.update(1 / 60, world);
    expect(road.count).toBe(0);
    blast.dispose();
  });
});
