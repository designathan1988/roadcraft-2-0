import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera } from 'three';
import { m } from '@world/units';
import { createPropLayer, lookProps, propView } from '@render/propCells';

/** THE FAR BLOCKS WALKED ONLY WHEN SOMETHING MAY BE MISSING (MISSION 1f): once every block the view wants is held, a still view does not ask
 *  each of them again at every frame; a block let go by the diary or the hour is found and placed again. */

describe('the far blocks walked', () => {
  it('asks each wanted block again only after the wanted blocks or the held ones changed', () => {
    const layer = createPropLayer({
      name: 'blocks', version: 1, kinds: [], margin: m(40), changes: ['landscape'], pad: 0, pictures: null, pictureOf: [],
      place: () => ({ packs: new Map(), growing: false }),
    });
    // The whole small city from above: a far plane of kilometres, a few hundred blocks.
    const camera = new PerspectiveCamera(35, 16 / 9, m(1), m(9000));
    camera.position.set(-m(1500), m(1800), m(1500));
    camera.lookAt(0, 0, 0);
    const look = (): void => {
      camera.updateMatrixWorld();
      const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      lookProps([layer], propView(camera, new Frustum().setFromProjectionMatrix(view), 540, 0));
    };
    const wide = layer.far[0]!;
    for (let i = 0; i < 100; i++) { look(); if (!layer.busy && wide.wantedKeys.every((key) => wide.has(key))) break; }
    const wanted = [...wide.wantedKeys];
    expect(wanted.length).toBeGreaterThan(10);
    expect(wanted.every((key) => wide.has(key))).toBe(true);

    // Every wanted block held: one frame finds none missing, the still view's frames after it ask none of them again.
    let asked = 0;
    const has = wide.has.bind(wide);
    wide.has = (key) => { asked++; return has(key); };
    look();
    expect(asked).toBeLessThanOrEqual(wanted.length);
    asked = 0;
    look();
    look();
    expect(asked).toBe(0);

    // A block let go by an edit: found and placed again at the next frame.
    wide.forget([wanted[0]!]);
    expect(has(wanted[0]!)).toBe(false);
    look();
    expect(asked).toBeGreaterThan(0);
    expect(has(wanted[0]!)).toBe(true);
    layer.dispose();
  });
});
