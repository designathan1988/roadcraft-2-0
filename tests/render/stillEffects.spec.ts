import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Matrix4, PointLight, Scene, Vector3 } from 'three';
import { createBlast } from '@render/blast';
import { createCasualties } from '@render/casualties';
import { createGore } from '@render/gore';
import { createTracers } from '@render/playEffects';
import type { Exhaust } from '@render/exhaust';

/** THE PLAY'S EFFECTS COMPOSE NO MATRIX FOR WHAT DOES NOT MOVE (MISSION 2d): their groups, instanced meshes and lines are placed by their
 *  instances or vertices, so a frame's world update composes nothing for them; gore lying still is not composed again either. */

let saved: unknown;

beforeAll(() => {
  saved = (globalThis as { document?: unknown }).document;
  // The decals' canvases (node has none): a 2D context that draws nothing.
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    set fillStyle(_: unknown) {}, set strokeStyle(_: unknown) {}, set lineWidth(_: unknown) {},
  };
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
});

afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
});

afterEach(() => vi.restoreAllMocks());

describe('the play effects that never move as objects', () => {
  it('compose no matrix in a frame\'s world update (the blast\'s ring alone moves itself)', () => {
    const scene = new Scene();
    const blast = createBlast({ burst: () => {} } as unknown as Exhaust, new PointLight());
    scene.add(blast.group, createGore().group, createCasualties().group);
    createTracers(scene);
    const composed = vi.spyOn(Matrix4.prototype, 'compose');
    // As the renderer's frame does (`updateMoving`): each child of the scene.
    for (const child of scene.children) child.updateMatrixWorld();
    expect(composed).toHaveBeenCalledTimes(1);
  });

  it('compose no gore that lies still, and still draw it where it lies', () => {
    const gore = createGore();
    const world = (): number => 0;
    gore.scatter(new Vector3(0, 1, 0), 6, new Vector3(1, 0, 0));
    gore.spill(() => null, new Vector3(0, 0, 0));
    gore.spill(() => new Vector3(2, 1, 0), new Vector3(0, 0, 0));
    // Ten seconds: the organs land and rest, the guts torn loose come to lie still.
    for (let frame = 0; frame < 600; frame++) gore.update(1 / 60, world);
    const organs = gore.group.children.find((c) => c.name === 'gore-organs')!;
    const guts = gore.group.children.find((c) => c.name === 'gore-guts')!;
    expect((organs as { count?: number }).count).toBe(6);
    expect((guts as { count?: number }).count).toBeGreaterThan(0);
    const composed = vi.spyOn(Matrix4.prototype, 'compose');
    for (let frame = 0; frame < 60; frame++) gore.update(1 / 60, world);
    expect(composed).not.toHaveBeenCalled();
    // Thrown again: written again.
    gore.scatter(new Vector3(0, 1, 0), 1, new Vector3(1, 0, 0));
    gore.update(1 / 60, world);
    expect((organs as { count?: number }).count).toBe(7);
    expect(composed).toHaveBeenCalled();
  });
});
