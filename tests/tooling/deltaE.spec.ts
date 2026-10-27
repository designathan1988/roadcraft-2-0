import { describe, expect, it } from 'vitest';
import { deltaE2000, deltaE2000Lab, labOf } from '../../scripts/lib/deltaE.mjs';

/** THE FAR SHEET'S COLOUR DIFFERENCE (`scripts/lib/deltaE.mjs`): CIEDE2000 against Sharma, Wu and Dalal's test pairs (2005, Table 1). */
describe('Delta E 2000', () => {
  it("matches Sharma, Wu and Dalal's test data", () => {
    const pairs: [[number, number, number], [number, number, number], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
      [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
      [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
    ];
    for (const [p, q, want] of pairs) expect(deltaE2000Lab(p, q)).toBeCloseTo(want, 4);
  });

  it('takes sRGB through CIELAB (D65): white is L 100, a colour against itself 0', () => {
    const [L, a, b] = labOf([255, 255, 255]);
    expect(L).toBeCloseTo(100, 2);
    expect(Math.abs(a)).toBeLessThan(0.01);
    expect(Math.abs(b)).toBeLessThan(0.01);
    expect(deltaE2000([119, 105, 88], [119, 105, 88])).toBe(0);
  });
});
