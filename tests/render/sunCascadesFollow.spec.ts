import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectionalLight, PerspectiveCamera, Vector3 } from 'three';

import { createSunCascades } from '@render/sunCascades';
import { m } from '@world/units';

/** THE CASCADES FITTED ONLY WHEN WHAT THEY READ CHANGED (MISSION 2e): a still view with the clock stopped reads the same camera, sun, target,
 *  top and ground as a follow that changed nothing, and nothing is worked out again; the ground, the camera or the sun changed, it is. */

function rig() {
  const sun = new DirectionalLight();
  const cascades = createSunCascades(sun, [new DirectionalLight(), new DirectionalLight()], 2);
  cascades.setEnabled(true, 2048);
  const camera = new PerspectiveCamera(50, 16 / 9, m(0.4), m(2500));
  camera.position.set(0, m(28) * Math.sin((15 * Math.PI) / 180), m(28) * Math.cos((15 * Math.PI) / 180));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { cascades, camera, sunDirection: new Vector3(-0.5, 0.75, -0.3).normalize(), target: new Vector3(0, 0, 0) };
}

/** Each cascade's place and size, as its light holds it. */
const placesOf = (lights: readonly DirectionalLight[]): number[] =>
  lights.flatMap((l) => [...l.position.toArray(), l.shadow.camera.right, l.shadow.camera.far, l.shadow.bias]);

afterEach(() => vi.restoreAllMocks());

describe('the sun cascades in a still view', () => {
  it('work out nothing again for the same reads, and follow a change of the ground or the camera', () => {
    const { cascades, camera, sunDirection, target } = rig();
    let ground = 0;
    const groundAt = (): number => ground;
    // Fitted, then a follow that changes nothing settles them.
    cascades.follow(camera, sunDirection, groundAt, target, m(40));
    cascades.follow(camera, sunDirection, groundAt, target, m(40));
    const settled = placesOf(cascades.lights);
    const rays = vi.spyOn(Vector3.prototype, 'applyMatrix4');
    for (let frame = 0; frame < 30; frame++) expect(cascades.follow(camera, sunDirection, groundAt, target, m(40))).toBe(false);
    expect(rays).not.toHaveBeenCalled();
    expect(placesOf(cascades.lights)).toEqual(settled);
    // The ground raised under the view: worked out again, the depth ranges taking it.
    ground = m(30);
    cascades.follow(camera, sunDirection, groundAt, target, m(40));
    expect(rays).toHaveBeenCalled();
    rays.mockClear();
    // The camera moved: worked out again.
    camera.position.x += m(5);
    camera.updateMatrixWorld();
    cascades.follow(camera, sunDirection, groundAt, target, m(40));
    expect(rays).toHaveBeenCalled();
    // And the result is the one a fresh follow of those reads keeps: the same reads again change nothing.
    cascades.follow(camera, sunDirection, groundAt, target, m(40));
    const after = placesOf(cascades.lights);
    rays.mockClear();
    cascades.follow(camera, sunDirection, groundAt, target, m(40));
    expect(rays).not.toHaveBeenCalled();
    expect(placesOf(cascades.lights)).toEqual(after);
  });
});
