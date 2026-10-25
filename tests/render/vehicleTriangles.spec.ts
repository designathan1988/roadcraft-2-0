import { describe, expect, it } from 'vitest';
import type { BufferAttribute, BufferGeometry } from 'three';

import { LEVEL_ERRORS, PartLevelMaker } from '@render/vehicleLevels';
import { buildCarModel } from '@render/carBody';
import { buildBusModel, buildTruckModel, tyreGeometry } from '@render/vehicleModels';
import { windowGlass } from '@render/vehicleWindows';
import { archetypeById } from '@sim/vehicles/archetypes';
import { withoutHidden } from '@render/vehicleHidden';
import { levelPixels, withinBounds } from './support/levelMeasure';

const triangles = (g: BufferGeometry | null): number => (g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0);

/** Every level of `model` (a model's part, drawn without its hidden triangles as `agents.ts` draws it) that draws something of its own,
 *  against the part where it is first drawn (`support/levelMeasure.ts`). */
async function expectLevelsWithin(model: BufferGeometry, weld: 'smooth' | 'boxes', copies = 1, from = 1, to: number = LEVEL_ERRORS.length,
  opaque = true): Promise<(BufferGeometry | null)[]> {
  const part = withoutHidden(model, opaque).geometry;
  const levels = await new PartLevelMaker().levels(part, weld, copies);
  for (let k = from; k <= to; k++) {
    const level = levels[k];
    if (!level || level === levels[k - 1]) continue;
    const m = levelPixels(part, level, LEVEL_ERRORS[k - 1]!);
    expect(withinBounds(m), `level ${k}: ${JSON.stringify(m)}`).toBe(true);
  }
  return levels;
}

/** Each corner of a geometry: its place (to a tenth of a millimetre) and its normal. */
function cornersOf(g: BufferGeometry): { place: string; normal: [number, number, number] }[][] {
  const position = g.getAttribute('position') as BufferAttribute, normal = g.getAttribute('normal') as BufferAttribute;
  const out: { place: string; normal: [number, number, number] }[][] = [];
  for (let t = 0; t < triangles(g); t++) {
    out.push([0, 1, 2].map((k) => {
      const i = g.index ? g.index.getX(t * 3 + k) : t * 3 + k;
      return { place: [position.getX(i), position.getY(i), position.getZ(i)].map((x) => Math.round(x * 1e4)).join(','), normal: [normal.getX(i), normal.getY(i), normal.getZ(i)] };
    }));
  }
  return out;
}

/** A VEHICLE PART'S LEVELS ARE THE SAME PICTURE WHERE THEY ARE DRAWN (`partLevelsWork.ts`, `levelError.ts`): each within half a pixel of its
 *  part both ways at the scale it is first drawn at, measured densely here (not by the guard that made it). */
describe('vehicle levels where they are drawn', () => {
  // One body for both halves (each makes its levels: the same numbers give the same levels).
  const hatch = buildCarModel(archetypeById('hatch'), 'hatch');
  it('a car body: its three finer levels within half a pixel of the body', async () => {
    const levels = await expectLevelsWithin(hatch.shell, 'smooth', 1, 1, 3);
    expect(new Set(levels.filter((l) => l)).size).toBeGreaterThan(4);
  });

  it('a car body: its three coarser levels within half a pixel of the body', async () => {
    await expectLevelsWithin(hatch.shell, 'smooth', 1, 4, LEVEL_ERRORS.length);
  });

  it('a car glazing, a door leaf and a door card: every level within half a pixel', async () => {
    const model = buildCarModel(archetypeById('sedan'), 'sedan');
    await expectLevelsWithin(windowGlass(model), 'smooth', 1, 1, LEVEL_ERRORS.length, false);
    await expectLevelsWithin(model.doors[0]!.panel, 'smooth');
    await expectLevelsWithin(model.doors[1]!.card!, 'smooth');
  });

  it('the bus and truck shells, drawn faceted, simplify (they never did) within half a pixel', async () => {
    for (const shell of [buildBusModel(archetypeById('bus')).shell, buildTruckModel(archetypeById('truck')).shell]) {
      const levels = await expectLevelsWithin(shell, 'smooth');
      expect(triangles(levels[levels.length - 1]!)).toBeLessThan(triangles(shell) * 0.5);
    }
  });

  it('a box assembly (the truck trim, a tyre): every level within half a pixel', async () => {
    await expectLevelsWithin(buildTruckModel(archetypeById('truck')).trim, 'boxes');
    await expectLevelsWithin(tyreGeometry(), 'boxes', 4);
  });

  it('a level shades the triangles it keeps as the part does: a faceted body faceted, a smooth tyre smooth', async () => {
    for (const [part, weld] of [[buildBusModel(archetypeById('bus')).shell, 'smooth'], [tyreGeometry(), 'boxes']] as const) {
      const levels = await new PartLevelMaker().levels(part, weld);
      // The part's corner normals at each place, by the triangle's three places.
      const own = new Map<string, Map<string, [number, number, number]>>();
      for (const corners of cornersOf(part)) {
        own.set(corners.map((c) => c.place).sort().join('|'), new Map(corners.map((c) => [c.place, c.normal] as const)));
      }
      let kept = 0;
      for (const level of new Set(levels.slice(1).filter((l): l is BufferGeometry => l !== null && l !== part))) {
        for (const corners of cornersOf(level)) {
          const same = own.get(corners.map((c) => c.place).sort().join('|'));
          if (!same) continue;
          kept++;
          for (const c of corners) {
            const n = same.get(c.place)!;
            // Within the float rounding of a face normal worked out again from the corners (`partLevelsWork.ts` normalsFrom).
            expect(Math.max(...[0, 1, 2].map((d) => Math.abs(n[d]! - c.normal[d]!)))).toBeLessThan(2e-5);
          }
        }
      }
      expect(kept).toBeGreaterThan(0);
    }
  });
});
