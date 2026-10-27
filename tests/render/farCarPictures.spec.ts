import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { TRAFFIC } from '@sim/vehicles/archetypes';
import { buildCarModel, carStylesFor } from '@render/carBody';
import { buildTruckModel } from '@render/vehicleModels';
import { type FarCarBody, createFarCarPictures, seedDraw } from '@render/farCarPictures';

/** THE FAR TRAFFIC DRAWN AS THE NEAR TRAFFIC'S OWN MODELS (`farCarPictures.ts`): its mix, its bodies' styles and its classes' paints */

/** The bodies the near traffic draws (`agents.ts` bodies), the traffic's classes only. */
function trafficBodies(): FarCarBody[] {
  const out: FarCarBody[] = [];
  for (const [a] of TRAFFIC) {
    if (a.shape === 'car') for (const style of carStylesFor(a)) out.push({ key: `${a.id}:${style}`, archetype: a, far: buildCarModel(a, style).far });
    else if (a.shape === 'truck') out.push({ key: `${a.id}:truck`, archetype: a, far: buildTruckModel(a).far });
  }
  return out;
}

describe('the far cars pictured', () => {
  it('draw each kind of the traffic in its share, every body style of a class, no two-wheeler as a car', () => {
    const bodies = trafficBodies();
    const pictures = createFarCarPictures(bodies)!;
    expect(pictures.spheres.length).toBe(bodies.length);
    const counts = new Map<number, number>();
    const n = 60_000;
    for (let seed = 0; seed < n; seed++) {
      const model = pictures.modelOf(seed);
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
    const total = TRAFFIC.reduce((sum, [, w]) => sum + w, 0);
    const twoWheeled = TRAFFIC.filter(([a]) => a.shape === 'motorcycle' || a.shape === 'bicycle').reduce((sum, [, w]) => sum + w, 0);
    // The two-wheelers' share is not drawn as any car's picture.
    expect((counts.get(-1) ?? 0) / n).toBeCloseTo(twoWheeled / total, 2);
    // Every body is drawn; a sedan an estate one time in three.
    for (let k = 0; k < bodies.length; k++) expect(counts.get(k) ?? 0, bodies[k]!.key).toBeGreaterThan(0);
    const sedan = bodies.findIndex((b) => b.key === 'sedan:sedan'), wagon = bodies.findIndex((b) => b.key === 'sedan:wagon');
    expect((counts.get(wagon) ?? 0) / ((counts.get(sedan) ?? 0) + (counts.get(wagon) ?? 0))).toBeCloseTo(1 / 3, 1);
    pictures.dispose();
  });

  it('paint a car one of its own class palette, the same for the same seed', () => {
    const bodies = trafficBodies();
    const pictures = createFarCarPictures(bodies)!;
    const out = new Color(), again = new Color();
    for (let seed = 0; seed < 500; seed++) {
      const model = pictures.modelOf(seed);
      if (model < 0) continue;
      const palette = bodies[model]!.archetype.palette.map((hex) => new Color(hex));
      pictures.paintOf(seed, model, out);
      expect(palette.some((c) => c.equals(out)), `seed ${seed}`).toBe(true);
      expect(pictures.paintOf(seed, model, again).equals(out)).toBe(true);
    }
    pictures.dispose();
  });

  it('take no pictures without bodies, and draw from a seed the same on every machine', () => {
    expect(createFarCarPictures([])).toBeNull();
    expect(seedDraw(12345, 7)).toBe(seedDraw(12345, 7));
    for (let seed = 0; seed < 1000; seed++) { const d = seedDraw(seed, 3); expect(d >= 0 && d < 1).toBe(true); }
  });
});
