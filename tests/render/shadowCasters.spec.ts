import { describe, expect, it } from 'vitest';
import { BoxGeometry, Frustum, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, type Camera } from 'three';
import { setShadowSun } from '@render/cellInstances';
import { createGardens, type GardenPlant } from '@render/gardens';
import { SHADOW_REACH, createSceneryKit } from '@render/scenery';
import { castBySize, castCastersInto } from '@render/shadowCasters';
import { m } from '@world/units';
import { townChanges } from '../support/gardenChange';

/** CASTERS BY SIZE AND BY CASCADE (`shadowCasters.ts`), and the layers' shadow margin away from the sun (`cellInstances.ts`) */

const viewOf = (camera: Camera): { frustum: Frustum; view: Matrix4 } => {
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { frustum: new Frustum().setFromProjectionMatrix(view), view };
};

describe('casters by size and by cascade', () => {
  it('casts a mesh only with instances and where its widest thing reaches the texel, and gives back what its maker set', () => {
    const geometry = new BoxGeometry(), material = new MeshBasicMaterial();
    const empty = new InstancedMesh(geometry, material, 4);
    empty.count = 0;
    const small = new InstancedMesh(geometry, material, 4);
    const plain = new Mesh(geometry, material);
    const offs = [
      castBySize({ mesh: empty, casts: true, radius: () => m(5) }),
      castBySize({ mesh: small, casts: true, radius: () => m(0.1) }),
      castBySize({ mesh: plain, casts: false, radius: () => m(5) }),
    ];
    castCastersInto(m(0.05));
    expect([empty.castShadow, small.castShadow, plain.castShadow]).toEqual([false, true, false]);
    castCastersInto(m(0.5));
    expect(small.castShadow).toBe(false);
    castCastersInto(null);
    expect([empty.castShadow, small.castShadow, plain.castShadow]).toEqual([true, true, false]);
    for (const off of offs) off();
    small.castShadow = false;
    castCastersInto(null);
    expect(small.castShadow).toBe(false);
  });

  it('hides a caster drawn into the cascades alone between the passes, shown for a cascade where it holds instances and casts', () => {
    const geometry = new BoxGeometry(), material = new MeshBasicMaterial();
    const held = new InstancedMesh(geometry, material, 4);
    const none = new InstancedMesh(geometry, material, 4);
    let count = 3;
    // As the poles' stores make them (`poleStores.ts`): hidden, `userData.shadowOnly` saying whether they hold any piece.
    for (const mesh of [held, none]) { mesh.visible = false; mesh.count = 0; }
    held.userData['shadowOnly'] = true;
    none.userData['shadowOnly'] = false;
    const offs = [
      castBySize({ mesh: held, casts: true, radius: () => m(1), shadowOnly: true, counts: { colour: () => 0, shadow: () => count } }),
      castBySize({ mesh: none, casts: true, radius: () => m(1), shadowOnly: true, counts: { colour: () => 0, shadow: () => 0 } }),
    ];
    castCastersInto(m(0.1));
    expect([held.visible, held.count, held.castShadow]).toEqual([true, 3, true]);
    expect([none.visible, none.castShadow]).toEqual([false, false]);
    // A cascade whose texel the pieces are under: not drawn into it.
    castCastersInto(m(5));
    expect([held.visible, held.castShadow]).toEqual([false, false]);
    // Between the passes: in no colour pass, its casting as its maker set it (what the casters' signature reads).
    castCastersInto(null);
    expect([held.visible, held.count, held.castShadow]).toEqual([false, 0, true]);
    count = 0;
    castCastersInto(m(0.1));
    expect(held.visible).toBe(false);
    for (const off of offs) off();
  });

  it('keeps a plant off the view only where its shadow can fall into it, away from the sun', () => {
    const kit = createSceneryKit();
    const half = m(100);
    const camera = new OrthographicCamera(-half, half, half, -half, 1, m(2000));
    camera.position.set(0, m(1000), 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const { frustum, view } = viewOf(camera);
    // Two trees past the view's east and west edges by most of the margin (world x is three's x).
    const plant = (x: number): GardenPlant => ({ kind: 'tree', x, y: 0, z: 0, w: m(2), d: m(2), h: m(6), yaw: 0, seed: 0.3 });
    const east = half + SHADOW_REACH * 0.8 + m(6), west = -east;
    const gardens = createGardens(kit);
    gardens.update(townChanges()([[plant(east)], [plant(west)]]));
    const drawnXs = (): number[] => {
      gardens.cull(frustum, view);
      const xs: number[] = [];
      for (const mesh of gardens.meshes as InstancedMesh[]) for (let i = 0; i < mesh.count; i++) xs.push(Math.sign((mesh.geometry.getAttribute('instancePoseA').getX(i))));
      return [...new Set(xs)].sort();
    };
    // No sun known: the margin round every way, both kept.
    expect(drawnXs()).toEqual([-1, 1]);
    // The sun low in the east: the east tree's shadow falls west, into the view; the west one's falls away from it.
    setShadowSun(1, 0.3, 0);
    expect(drawnXs()).toEqual([1]);
    setShadowSun(0, 0, 0);
  });
});
