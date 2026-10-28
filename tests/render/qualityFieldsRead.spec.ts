import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { QUALITY } from '@render/quality';
import { QUALITY_FIELD_OPTIONS } from '@render/optimizationsQuality';

/** EVERY GRAPHICS SETTING IS READ BY THE SYSTEM IT NAMES (MISSION.md item 9): none kept that changes nothing. The grass blades, the birds and
 *  the waterfalls' spray had no system; the vegetation's range would cut what its pixels draw; the plant impostors were on at every tier. */
describe('the graphics settings', () => {
  it('offer no field read by no code', () => {
    const unread = QUALITY_FIELD_OPTIONS.filter((spec) => spec.tradeoff.startsWith('A field defined but read by no code')).map((spec) => spec.id);
    expect(unread).toEqual([]);
    for (const gone of ['grassBlades', 'vegetationDistance', 'impostors', 'birds', 'waterfalls']) expect(QUALITY.high).not.toHaveProperty(gone);
  });

  it('draw the raindrops on the tiers that have them, the wet ground on every one', () => {
    expect(QUALITY.low.rain).toBe(false);
    expect(QUALITY.high.rain).toBe(true);
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    expect(source).toMatch(/rain\.update\(quality\.rain \? weather\.rain : 0,/);
    // The wet ground reads the weather, whatever the tier.
    expect(source).toMatch(/environment\.setWeather\(Math\.max\(weather\.rain \* 0\.85/);
  });
});
