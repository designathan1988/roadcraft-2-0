import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, type InstancedMesh, MeshBasicMaterial, PerspectiveCamera } from 'three';

import type { PoleId } from '@world/ids';
import { PartStore, ScreenScale } from '@render/poleStores';
import type { PolePartSpec } from '@render/utilities';

/** THE POLE STORES' VIEW, PROPORTIONAL TO WHAT CAN BE SEEN (MISSION 1f): a store none of whose pieces can reach a pixel is not measured piece
 *  by piece (its result the same: none drawn), and the colour meshes are not filled and sent again when no piece changed mesh. */

/** A box part with a fine shape (192 triangles) and a coarse one (12) off by 5 cm. */
function spec(): PolePartSpec {
  const fine = new BoxGeometry(1, 1, 1, 4, 4, 4), coarse = new BoxGeometry(1, 1, 1);
  for (const g of [fine, coarse]) { g.computeBoundingBox(); g.computeBoundingSphere(); }
  return {
    name: 'test-part', geometry: fine, material: new MeshBasicMaterial(), castShadow: false, receiveShadow: false, renderOrder: 0,
    glows: false, brightness: () => 1, levels: [{ geometry: fine, error: 0 }, { geometry: coarse, error: 0.05 }],
  };
}

/** A camera at (x, 1.7 m, 0) looking down +x (map x east, three's axes). */
function camera(x: number, fov = 35): PerspectiveCamera {
  const c = new PerspectiveCamera(fov, 16 / 9, 0.1, 20_000);
  c.position.set(x, 1.7, 0);
  c.lookAt(x + 1000, 1.7, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

const colourMeshes = (group: Group): InstancedMesh[] => group.children.filter((o) => o.name === 'test-part') as InstancedMesh[];
const drawn = (group: Group): number => colourMeshes(group).reduce((n, mesh) => n + (mesh.visible ? mesh.count : 0), 0);

afterEach(() => vi.restoreAllMocks());

describe('the pole stores\' view', () => {
  it('measures no piece of a store whose pieces are all under a pixel, and draws none of them', () => {
    const group = new Group();
    const store = new PartStore(spec(), group);
    // Four small pieces (10 cm) a kilometre down the view: each under a pixel.
    for (let k = 0; k < 4; k++) store.add(k as PoleId, { x: 1000 + k * 5, y: 0, z: 1.7, yaw: 0, sx: 0.1, sy: 0.1, sz: 0.1 });
    store.flush();
    const measured = vi.spyOn(ScreenScale.prototype, 'atPoint');
    const scale = new ScreenScale();
    scale.set(camera(0));
    store.view(scale);
    expect(measured).not.toHaveBeenCalled();
    expect(drawn(group)).toBe(0);

    // Close to them: each measured, each drawn.
    scale.set(camera(990));
    store.view(scale);
    expect(measured).toHaveBeenCalledTimes(4);
    expect(drawn(group)).toBe(4);

    // Back a kilometre off: none measured again, none drawn.
    measured.mockClear();
    scale.set(camera(0));
    store.view(scale);
    expect(measured).not.toHaveBeenCalled();
    expect(drawn(group)).toBe(0);
    store.dispose();
  });

  it('sends the colour mesh again only when a piece changed mesh, not when it changed shape inside one', () => {
    const group = new Group();
    const store = new PartStore(spec(), group);
    // One piece 40 m off (fine), one 300 m off (coarse at 35 degrees, fine at 10): two shapes drawing too few triangles apart to be two draws.
    store.add(1 as PoleId, { x: 40, y: 0, z: 1.7, yaw: 0, sx: 1, sy: 1, sz: 1 });
    store.add(2 as PoleId, { x: 300, y: 0, z: 1.7, yaw: 0, sx: 1, sy: 1, sz: 1 });
    store.flush();
    const scale = new ScreenScale();
    scale.set(camera(0));
    store.view(scale);
    const meshes = colourMeshes(group).filter((mesh) => mesh.visible);
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.count).toBe(2);
    const version = meshes[0]!.instanceMatrix.version;
    // Zoomed in: the far piece's shape is the fine one now, in the same mesh, the same matrices in the same order: nothing sent.
    scale.set(camera(0, 10));
    store.view(scale);
    expect(meshes[0]!.instanceMatrix.version).toBe(version);
    expect(drawn(group)).toBe(2);
    // The near piece left behind the eye (still zoomed: the other stays fine): its mesh changed (none), the mesh filled with the other alone
    // and sent again.
    scale.set(camera(100, 10));
    store.view(scale);
    expect(meshes[0]!.instanceMatrix.version).toBeGreaterThan(version);
    expect(drawn(group)).toBe(1);
    store.dispose();
  });
});
