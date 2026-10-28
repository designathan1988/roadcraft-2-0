import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { PoleCells } from '@render/poleCells';
import { BLOCK } from '@render/poleLayer';
import { createSceneryKit } from '@render/scenery';

/** THE POLE BLOCKS MADE AHEAD OF THE VIEW (`poleCells.ts` look, MISSION.md 3b): a block the view turns into next is made with the frame's time
 *  left over, so its poles and wires are there when it comes in, never appearing block by block as the camera turns. */

const kit = createSceneryKit();

/** Poles every 250 m over four kilometres a side. */
function town(): Network {
  const doc = new RoadDoc();
  for (let x = m(125); x < m(4000); x += m(250)) for (let y = m(125); y < m(4000); y += m(250)) doc.addPole({ x, y }, true);
  return new Network(doc);
}

/** A view from (500, 500), 20 m up, looking east along the ground. */
function viewEast(): { x: number; y: number; reach: number; ground: number; frustum: Frustum } {
  const camera = new PerspectiveCamera(50, 16 / 9, 1, m(5000));
  camera.position.set(m(500), m(20), -m(500));
  camera.lookAt(m(5000), 0, -m(500));
  camera.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  return { x: m(500), y: m(500), reach: m(5000), ground: 0, frustum };
}

describe('the pole blocks round the view', () => {
  it('holds the block the view turns into next (beside the frame), made with the time left over', () => {
    const poles = new PoleCells(kit);
    poles.source(town(), () => 0);
    const view = viewEast();
    poles.look(view, Infinity);
    expect(poles.busy).toBe(false);
    // The block north of the eye's, beside the frame (45 degrees off the view's axis, its half width 40): out of the frustum, a block from it.
    const north = poles.cells.cellAt(BLOCK / 2, BLOCK * 1.5);
    expect(view.frustum.containsPoint(new Vector3(BLOCK / 2, m(1), -BLOCK * 1.5))).toBe(false);
    expect(poles.cells.has(north)).toBe(true);
    // Its poles placed: turned to, it draws them at once.
    expect(poles.triangles).toBeGreaterThan(0);
    // Behind the eye, past a block from the frame: not made.
    expect(poles.cells.has(poles.cells.cellAt(-BLOCK * 1.5, BLOCK / 2))).toBe(false);
    poles.dispose();
  });
});
