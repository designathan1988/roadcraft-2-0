import { describe, expect, it } from 'vitest';
import { BoxGeometry, Frustum, Matrix4, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { m } from '@world/units';
import { ORDER_AZIMUTHS, createCellInstances, posesOf, type KindSpec, type Pack } from '@render/cellInstances';
import { NEVER_NEAR, YAW_POSE } from '@render/instanceRuns';

/** AN ORDERED FAR LEVEL (`cellInstances.ts` KindLevels.ordered, orderFar): the ground cover's pictures, blended with no depth written, laid back
 *  to front along the view's ground direction; laid again only when the view turns past a step of the pictures' azimuths, never for a pan. */

/** A field of 20 x 20 small things 5 m apart round the origin, all drawn as their far pictures from 300 m off. */
function field(): { cells: ReturnType<typeof createCellInstances>; far: () => import('three').InstancedMesh } {
  const model = new BoxGeometry(m(0.5), m(0.5), m(0.5));
  model.computeBoundingSphere();
  const spec: KindSpec = {
    tinted: false,
    levels: { reach: model.boundingSphere!.radius, far: 16, least: 1.5, ordered: true, ready: () => true },
    meshes: [
      { name: 'near', geometry: model, material: new MeshStandardMaterial(), castShadow: false, receiveShadow: false, cards: false, far: false },
      { name: 'far', geometry: model, material: new MeshStandardMaterial(), castShadow: false, receiveShadow: false, cards: false, far: true },
    ],
  };
  const cells = createCellInstances([spec], YAW_POSE, 0);
  const n = 400, data = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) data.set([((i % 20) - 9.5) * m(5), 0, (Math.floor(i / 20) - 9.5) * m(5), 0, 1, 1, 1, NEVER_NEAR], i * 8);
  const pack: Pack = { data, colours: null, scales: new Float32Array(n).fill(1), count: n };
  cells.update({ removed: [], added: [{ key: {}, packs: new Map([[0, pack]]) }] });
  return { cells, far: () => cells.meshes.find((x) => x.name === 'far')! };
}

/** The camera `distance` off the origin at `yaw` about the vertical, 50 m up, looking at `at` along x. */
function viewFrom(yaw: number, at = 0): { view: Matrix4; frustum: Frustum } {
  const camera = new PerspectiveCamera(35, 1, m(1), m(5000));
  camera.position.set(at + Math.sin(yaw) * m(300), m(50), Math.cos(yaw) * m(300));
  camera.lookAt(at, 0, 0);
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { view, frustum: new Frustum().setFromProjectionMatrix(view) };
}

describe('an ordered far level', () => {
  it('is laid back to front along the view\'s ground direction', () => {
    const { cells, far } = field();
    for (const yaw of [0.3, 1.9, 4.1]) {
      const { view, frustum } = viewFrom(yaw);
      cells.cull(frustum, view);
      const mesh = far();
      expect(mesh.count).toBe(400);
      // The view's ground direction to its step (`cellInstances.ts` cull: w grows away from the eye).
      const e = view.elements, step = (2 * Math.PI) / ORDER_AZIMUTHS;
      const azimuth = Math.round(Math.atan2(e[3]!, e[11]!) / step);
      const dx = Math.sin(azimuth * step), dz = Math.cos(azimuth * step);
      const poses = posesOf(mesh).buffer.array as Float32Array;
      let before = Infinity;
      for (let p = 0; p < mesh.count; p++) {
        const key = dx * poses[p * 8]! + dz * poses[p * 8 + 2]!;
        // Farthest first: each one nearer than or level with the one before.
        expect(key).toBeLessThanOrEqual(before + 1e-3);
        before = key;
      }
    }
    cells.dispose();
  });

  it('is not laid again for a pan, once for a turn past a step', () => {
    const { cells } = field();
    const first = viewFrom(0.3);
    cells.cull(first.frustum, first.view);
    const laid = cells.orderStats.lays;
    expect(laid).toBeGreaterThan(0);
    // Panned 2 m along x, the same direction: every thing still in view and far, nothing laid again.
    for (let k = 1; k <= 5; k++) {
      const panned = viewFrom(0.3, k * m(0.4));
      cells.cull(panned.frustum, panned.view);
    }
    expect(cells.orderStats.lays).toBe(laid);
    // Turned past a step of the pictures' azimuths: laid again once.
    const turned = viewFrom(0.3 + (2 * Math.PI) / ORDER_AZIMUTHS * 1.5);
    cells.cull(turned.frustum, turned.view);
    expect(cells.orderStats.lays).toBe(laid + 1);
    // What the lays cost, for the record: 400 things a lay.
    console.log(`ordered far level: ${cells.orderStats.lays} lays, ${cells.orderStats.rewritten} positions rewritten, worst ${cells.orderStats.worstMs.toFixed(2)} ms, ${cells.orderStats.worstBytes} bytes`);
    cells.dispose();
  });
});
