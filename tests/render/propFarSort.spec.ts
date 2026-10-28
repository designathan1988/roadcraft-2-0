import { describe, expect, it } from 'vitest';
import { Box3, Matrix4, PerspectiveCamera, Vector3, Vector4, type InstancedMesh } from 'three';

import { sortLadder, unsorted, type FarLadder, type LadderSort, type SortedRung } from '@render/farLadders';

/** A FAR BLOCK'S STREET PROPS SORTED INTO THEIR RUNGS ON THE CPU (`farLadders.ts` sortLadder, MISSION.md 3b): each rung draws the things whose
 *  size on the screen may be in its band, not every thing of the block with those out of it dropped in the vertex shader. */

const STRIDE = 8;
const REACH = 1;
const HALF = 540;

/** Things in a row going away from the eye (three's -z), a metre apart sideways, every 5 m from 10 m to 400 m. */
function things(): { poses: Float32Array; scales: Float32Array; feet: Box3 } {
  const n = 79;
  const poses = new Float32Array(n * STRIDE), scales = new Float32Array(n).fill(1);
  const feet = new Box3();
  for (let i = 0; i < n; i++) {
    poses.set([(i % 2) - 0.5, 0, -(10 + i * 5)], i * STRIDE);
    feet.expandByPoint(new Vector3(poses[i * STRIDE]!, 0, poses[i * STRIDE + 2]!));
  }
  return { poses, scales, feet };
}

/** A rung of band [lo, hi), its one mesh a stand-in counting what it is given. */
function rung(lo: number, hi: number, sent: number[]): SortedRung {
  const mesh = { count: 0, visible: true } as unknown as InstancedMesh;
  const r: SortedRung = { band: new Vector4(lo, hi, REACH, 0), meshes: [mesh], shadowAlone: false, count: 0, send: () => { sent.push(r.count); } };
  return r;
}

function camera(z: number, fov = 50): { view: Matrix4; per: number } {
  const c = new PerspectiveCamera(fov, 16 / 9, 0.1, 5000);
  c.position.set(0, 2, z);
  c.lookAt(0, 0, z - 100);
  c.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
  const e = view.elements;
  return { view, per: Math.hypot(e[1]!, e[5]!, e[9]!) * HALF };
}

/** A thing's size on the screen as the band measures it (`BAND_GLSL`): clip w at its foot. */
const across = (view: Matrix4, poses: Float32Array, i: number, per: number): number => {
  const e = view.elements;
  const w = e[3]! * poses[i * STRIDE]! + e[7]! * poses[i * STRIDE + 1]! + e[11]! * poses[i * STRIDE + 2]! + e[15]!;
  return (2 * REACH * per) / Math.max(w, 1e-4);
};

describe('a far ladder\'s things sorted into their rungs', () => {
  const { poses, scales, feet } = things();
  const make = (sent: number[][]): FarLadder => {
    const rungs = [rung(48, Number.MAX_VALUE, sent[0]!), rung(16, 48, sent[1]!), rung(1.5, 16, sent[2]!)];
    const sort: LadderSort = { poses, tints: null, scales, stride: STRIDE, reach: REACH, rungs, at: unsorted() };
    return { levels: { reach: REACH }, feet, largest: 2, smallest: 2, rungs: [], pictures: null, sort };
  };

  it('each rung holds the things in its band, widened by the slack alone, never every thing', () => {
    const sent: number[][] = [[], [], []];
    const ladder = make(sent);
    const { view, per } = camera(0);
    sortLadder(ladder, view, per);
    const sizes = Array.from({ length: scales.length }, (_, i) => across(view, poses, i, per));
    // The view spans the three bands: each rung holds some, and far fewer than all.
    for (const r of ladder.sort.rungs) {
      const inBand = sizes.filter((s) => s >= r.band.x / 1.25 && s < r.band.y * 1.25).length;
      expect(r.count).toBe(inBand);
      expect(r.count).toBeGreaterThan(0);
      expect(r.count).toBeLessThan(sizes.length);
    }
    // Every thing held by the rung its size calls for.
    for (const s of sizes) {
      const r = ladder.sort.rungs.find((x) => s >= x.band.x && s < x.band.y)!;
      expect(r.count).toBeGreaterThan(0);
    }
    // Each thing in at most two rungs (the slack round a bar), most in one.
    const held = ladder.sort.rungs.reduce((n, r) => n + r.count, 0);
    expect(held).toBeLessThan(sizes.length * 1.5);
  });

  it('sorts again only when a size may have moved past the slack', () => {
    const sent: number[][] = [[], [], []];
    const ladder = make(sent);
    const a = camera(0);
    sortLadder(ladder, a.view, a.per);
    expect(sent.map((s) => s.length)).toEqual([1, 1, 1]);
    // The same view, and a step of a metre towards them: no size moved past the slack.
    sortLadder(ladder, a.view, a.per);
    const b = camera(-1);
    sortLadder(ladder, b.view, b.per);
    expect(sent.map((s) => s.length)).toEqual([1, 1, 1]);
    // Zoomed in (a narrower view): every size grown past the slack.
    const c = camera(-1, 20);
    sortLadder(ladder, c.view, c.per);
    expect(sent.map((s) => s.length)).toEqual([2, 2, 2]);
  });
});
