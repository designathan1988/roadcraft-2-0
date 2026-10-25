import { describe, expect, it } from 'vitest';

import { buildLargeCityMap } from '@editor/smallCityMap';

/** FNV-1a over a string: the map's text as one number. */
function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * THE LARGE CITY A SEED MAKES, BIT FOR BIT (`tests/world/cityGolden.spec.ts` holds the small one): 8,102 buildings made whole, ~20 s, so
 * run with the counting suites (`vitest.scale.config.ts`, `scripts/verify.mjs`), never in the suite of tests under 10 s.
 */
describe('city golden, the large city', () => {
  // What the speed work on the generator (an index, a sort, a number worked out once) must leave as it was, bit for bit. Its number taken on the generator before that work (e9dc867f).
  it('the large city of seed 7 is made exactly as before', () => {
    const doc = buildLargeCityMap(7);
    const text = JSON.stringify(doc);
    // 2026-10-25: 2774247772 and 60,395,033 before the world's cells became 250 m (`cells.ts`, 256 m before): the pole runs are routed over
    // regions of whole cells (`editor/poles.ts`), and the contours cut at other lines put 32 of the 4,590 poles at most 4.5e-13 m elsewhere
    // along x, nothing else of the city changed (the old number again with the regions at 256 m).
    expect({ hash: hashText(text), length: text.length }).toMatchInlineSnapshot(`
      {
        "hash": 3558793498,
        "length": 60394987,
      }
    `);
  }, 180_000);
});
