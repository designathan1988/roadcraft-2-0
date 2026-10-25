import { describe, expect, it } from 'vitest';
import { BoxGeometry, Frustum, Matrix4, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, type Camera } from 'three';
import { m } from '@world/units';
import { createCellInstances, type KindSpec, type Pack } from '@render/cellInstances';
import { NEVER_NEAR, YAW_POSE } from '@render/instanceRuns';

/** A THING ITS MATERIAL FADES OUT PAST A DISTANCE (`cellInstances.ts` KindLevels.fadesAt: a lamp's cone, `scenery.ts` BEAM_FADE): not drawn where
 *  all of it stands farther, in a perspective view; a view from above fades nothing. */

const FADES = m(140);

function cones(): ReturnType<typeof createCellInstances> {
  const model = new BoxGeometry(m(4), m(8), m(4));
  model.computeBoundingSphere();
  const spec: KindSpec = {
    tinted: false,
    levels: { reach: model.boundingSphere!.radius, fadesAt: FADES },
    meshes: [{ name: 'cone', geometry: model, material: new MeshStandardMaterial(), castShadow: false, receiveShadow: false, cards: false, far: false }],
  };
  const cells = createCellInstances([spec], YAW_POSE, 0);
  // One at the origin, one 500 m on along x (three's axes).
  const data = new Float32Array(2 * 8);
  data.set([0, 0, 0, 0, 1, 1, 1, NEVER_NEAR], 0);
  data.set([m(500), 0, 0, 0, 1, 1, 1, NEVER_NEAR], 8);
  const pack: Pack = { data, colours: null, scales: new Float32Array(2).fill(1), count: 2 };
  cells.update({ removed: [], added: [{ key: {}, packs: new Map([[0, pack]]) }] });
  return cells;
}

const culled = (cells: ReturnType<typeof createCellInstances>, camera: Camera): number => {
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  cells.cull(new Frustum().setFromProjectionMatrix(view), view);
  return cells.meshes.find((x) => x.name === 'cone')!.count;
};

describe('a thing its material fades out past a distance', () => {
  it('is drawn within it and not past it in perspective, both drawn from above', () => {
    const cells = cones();
    // 100 m behind the origin, looking along +x: the near one 100 m off, the far one 600 m.
    const persp = new PerspectiveCamera(35, 16 / 9, m(1), m(5000));
    persp.position.set(-m(100), m(20), 0);
    persp.lookAt(m(500), 0, 0);
    expect(culled(cells, persp)).toBe(1);
    // 100 m short of the far one, looking on: the far one drawn, the one at the origin 400 m behind the eye, out of the frame.
    persp.position.set(m(400), m(20), 0);
    persp.lookAt(m(600), 0, 0);
    expect(culled(cells, persp)).toBe(1);
    // From above (orthographic): the material fades nothing, both drawn.
    const ortho = new OrthographicCamera(-m(800), m(800), m(400), -m(400), m(1), m(5000));
    ortho.position.set(m(250), m(1000), 0);
    ortho.lookAt(m(250), 0, 0);
    expect(culled(cells, ortho)).toBe(2);
  });
});
