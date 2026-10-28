import { describe, expect, it } from 'vitest';
import { MeshoptSimplifier } from 'meshoptimizer';

import { unifiedWaterGeometry } from '@render/terrain';
import { waterLevelFor, waterLevels } from '@render/waterLevels';
import { m } from '@world/units';

/** A PLATE'S WATER BY ITS SIZE ON THE SCREEN (`waterLevels.ts`, MISSION.md 3b): coarser levels of its own mesh, each within its error, the
 *  coarsest whose error spans under a pixel drawn. */

/** A round lake of 40 m in a bowl: the ground 3 m under its level in the middle, rising past it at the rim. */
function lake(): ReturnType<typeof unifiedWaterGeometry> {
  const ground = (x: number, y: number): number => -m(3) + (Math.hypot(x, y) / m(20)) ** 2 * m(3.4);
  return unifiedWaterGeometry([{ x: 0, y: 0, radius: m(20), level: 0 }], ground);
}

const trianglesOf = (g: { index: { count: number } | null; getAttribute(name: string): { count: number } }): number =>
  (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('a plate\'s water by its size on the screen', () => {
  it('has coarser levels of its own mesh, each drawing fewer triangles and standing within its error', async () => {
    await MeshoptSimplifier.ready;
    const source = lake();
    const whole = trianglesOf(source);
    expect(whole).toBeGreaterThan(1000);
    const levels = waterLevels(source);
    // The finest is the water as made, welded: the same triangles.
    expect(trianglesOf(levels.geometries[0]!)).toBe(whole);
    expect(levels.geometries.length).toBeGreaterThan(2);
    for (let k = 1; k < levels.geometries.length; k++) {
      expect(levels.errors[k]!).toBeGreaterThan(levels.errors[k - 1]!);
      expect(trianglesOf(levels.geometries[k]!)).toBeLessThan(trianglesOf(levels.geometries[k - 1]!) * 0.75);
      // The same corners as the finest: a level is an index over them.
      expect(levels.geometries[k]!.getAttribute('position')).toBe(levels.geometries[0]!.getAttribute('position'));
    }
    // Far off its coarsest is a small share of the whole.
    expect(trianglesOf(levels.geometries.at(-1)!)).toBeLessThan(whole / 10);
  });

  it('draws the coarsest whose error spans under a pixel, the finest up close', async () => {
    await MeshoptSimplifier.ready;
    const levels = waterLevels(lake());
    // Up close (a pixel a centimetre): the finest.
    expect(waterLevelFor(levels, m(0.01))).toBe(0);
    // A pixel wider than every error: the coarsest.
    expect(waterLevelFor(levels, m(100))).toBe(levels.errors.length - 1);
    // In between: never one whose error passes the pixel.
    for (const px of [m(0.6), m(1.5), m(3), m(5)]) {
      const level = waterLevelFor(levels, px);
      expect(levels.errors[level]!).toBeLessThanOrEqual(px);
      if (level + 1 < levels.errors.length) expect(levels.errors[level + 1]!).toBeGreaterThan(px);
    }
  });
});
