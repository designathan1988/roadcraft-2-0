import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, OrthographicCamera, type BufferGeometry, type InstancedMesh, type InterleavedBufferAttribute } from 'three';
import { createGardens, type GardenPlant } from '@render/gardens';
import { createSceneryKit } from '@render/scenery';
import { castCastersInto } from '@render/shadowCasters';
import { shadowLadderOf } from '@render/shadowLevels';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { surfaceOff } from '@render/propLevels';
import { m } from '@world/units';
import { townChanges } from '../support/gardenChange';

/** A CASTER'S SHAPES FOR THE SUN'S CASCADES (`shadowLevels.ts`), drawn by the cascade's texel (`cellInstances.ts` shadowShape) */

const triangles = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe("a caster's shapes for the cascades", () => {
  it('are the model, then lighter shapes each within its measured error of it, fewer triangles each', async () => {
    const kit = createSceneryKit();
    for (const model of [...Object.values(kit.trees), ...Object.values(kit.bushes)]) {
      const ladder = shadowLadderOf(model);
      await ladder.ready;
      expect(ladder.shapes[0]!.geometry).toBe(model);
      expect(ladder.shapes[0]!.error).toBe(0);
      for (let i = 1; i < ladder.shapes.length; i++) {
        const shape = ladder.shapes[i]!;
        expect(triangles(shape.geometry)).toBeLessThan(triangles(ladder.shapes[i - 1]!.geometry));
        // Its error is what it measures against the model, both ways (the model indexed: the measure reads triangles by their index).
        const indexed = mergeVertices(model.clone());
        const off = Math.max(surfaceOff(indexed, shape.geometry), surfaceOff(shape.geometry, indexed));
        indexed.dispose();
        expect(off).toBeLessThanOrEqual(shape.error + 1e-9);
        expect(shape.error).toBeGreaterThanOrEqual(ladder.shapes[i - 1]!.error);
      }
      // One ladder a model, whoever asks.
      expect(shadowLadderOf(model)).toBe(ladder);
    }
    // The bodies worth it (over 24 triangles) have a lighter shape.
    expect(shadowLadderOf(kit.trees.broadleaf).shapes.length).toBeGreaterThan(1);
    expect(shadowLadderOf(kit.bushes.bush).shapes.length).toBeGreaterThan(1);
  });

  it('are let go with their model', async () => {
    const kit = createSceneryKit();
    const ladder = shadowLadderOf(kit.bushes.hedge);
    await ladder.ready;
    const lighter = ladder.shapes.slice(1).map((s) => s.geometry);
    expect(lighter.length).toBeGreaterThan(0);
    let disposed = 0;
    for (const g of lighter) g.addEventListener('dispose', () => { disposed++; });
    kit.bushes.hedge.dispose();
    expect(disposed).toBe(lighter.length);
    expect(ladder.shapes.length).toBe(1);
  });

  it("draw a garden's body into a cascade at the lightest shape under its texel, and the colour pass at its model, the same instances", async () => {
    const kit = createSceneryKit();
    await shadowLadderOf(kit.trees.broadleaf).ready;
    // 20 m across the screen's 1,080 lines: the 6 m tree some 300 px tall, drawn at its model.
    const half = m(10);
    const camera = new OrthographicCamera(-half, half, half, -half, 1, m(2000));
    camera.position.set(0, m(1000), 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const tree: GardenPlant = { kind: 'tree', x: 0, y: 0, z: 0, w: m(2), d: m(2), h: m(6), yaw: 0, seed: 0.3, species: 'broadleaf' };
    const gardens = createGardens(kit);
    gardens.update(townChanges()([[tree]]));
    gardens.cull(new Frustum().setFromProjectionMatrix(view), view);
    const body = (gardens.meshes as InstancedMesh[]).find((mesh) => mesh.name === 'garden-trees-broadleaf' && mesh.count > 0)!;
    expect(body).toBeDefined();
    const colour = body.geometry;
    const poses = colour.getAttribute('instancePoseA') as InterleavedBufferAttribute;
    expect(triangles(colour)).toBe(triangles(kit.trees.broadleaf));
    // A texel of a millimetre: no shape is that close; the model.
    castCastersInto(m(0.001));
    expect(body.geometry).toBe(colour);
    // A texel of 50 m: the lightest shape, on the same poses.
    castCastersInto(m(50));
    const shapes = shadowLadderOf(kit.trees.broadleaf).shapes;
    expect(triangles(body.geometry)).toBe(triangles(shapes[shapes.length - 1]!.geometry));
    expect(triangles(body.geometry)).toBeLessThan(triangles(colour));
    expect((body.geometry.getAttribute('instancePoseA') as InterleavedBufferAttribute).data).toBe(poses.data);
    // Between the passes: the colour's model again.
    castCastersInto(null);
    expect(body.geometry).toBe(colour);
    gardens.dispose();
  });
});
