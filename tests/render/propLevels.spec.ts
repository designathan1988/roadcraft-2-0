import { describe, expect, it } from 'vitest';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { BufferGeometry } from 'three';
import { benchGeometry, binGeometry, drainGeometry, hydrantGeometry, lampGeometry, phoneGeometry, postboxGeometry, treePitGeometry, trianglesOf } from '@render/propGeometry';
import { PROP_NEAR_PX, ERROR_PIXELS, propLevelError, propMeasure, propMidLevel, propWithin, surfaceOff } from '@render/propLevels';
import { HYSTERESIS } from '@render/cellInstances';

/** THE STREET PROPS' SIMPLIFIED MODELS (`propLevels.ts`): every one within its error at the largest size it is drawn simplified, never more triangles. */

const PROPS: Record<string, () => BufferGeometry> = {
  lamp: lampGeometry, bin: binGeometry, bench: benchGeometry, hydrant: hydrantGeometry, postbox: postboxGeometry,
  phone: phoneGeometry, drain: drainGeometry, treePit: treePitGeometry,
};

describe('the street props\' simplified models', () => {
  it('keep every prop within its error at the largest size it is drawn simplified, with fewer triangles, or draw the model', async () => {
    await MeshoptSimplifier.ready;
    const rows: string[] = [];
    for (const [name, make] of Object.entries(PROPS)) {
      const model = make();
      // Its measure: its largest extent (the owner's tool's size, as the layer measures it).
      const across = propMeasure(model);
      const bound = propLevelError(across);
      // The bound is half a pixel at the largest size the simplified model is drawn at (the near bar and its band).
      expect((bound * (PROP_NEAR_PX * (1 + HYSTERESIS))) / across).toBeCloseTo(ERROR_PIXELS, 9);
      const simplified = propWithin(model, bound);
      const l0 = trianglesOf(model);
      const mid = propMidLevel(model, across);
      mid.make();
      if (simplified) {
        // Measured both ways on the surfaces, sampled at corners, edge middles and centres.
        const off = Math.max(surfaceOff(model, simplified), surfaceOff(simplified, model));
        expect(off).toBeLessThanOrEqual(bound);
        expect(trianglesOf(simplified)).toBeLessThanOrEqual(l0);
        rows.push(`${name}: L0 ${l0}, L1 ${trianglesOf(simplified)}, bound ${(bound * 1000).toFixed(1)} mm, measured ${(off * 1000).toFixed(1)} mm, mid level ${mid.ready() ? 'drawn' : 'not worth its draw (L0 drawn)'}`);
        expect(mid.ready()).toBe(trianglesOf(simplified) <= l0 * 0.9);
      } else {
        rows.push(`${name}: L0 ${l0}, no simplification within ${(bound * 1000).toFixed(1)} mm (L0 drawn)`);
        expect(mid.ready()).toBe(false);
      }
      expect(trianglesOf(mid.geometry)).toBe(mid.ready() ? trianglesOf(simplified!) : l0);
    }
    console.log(rows.join('\n'));
  });
});
