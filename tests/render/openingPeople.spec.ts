import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/** THE OPENING WAITS FOR THE PEOPLE'S BODIES (MISSION.md item 6): every body of the cast is asked at the start (`keepPeople`), and the curtain
 *  falls once they are in, so no body is put together on the page (its cook read, its materials, impostor and clips made) once the town shows. */
let saved: unknown;
beforeAll(() => {
  // `createRiggedCitizens` hangs its development hooks on `window`.
  saved = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = globalThis;
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved;
});

describe('the opening and the people', () => {
  it('holds the curtain while a body kept is loading', () => {
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    expect(source).toMatch(/const whole = [^;]*!agents\.peopleLoading\(\)/);
    // Every body asked once the page has a scene to draw, before the town is in.
    expect(source).toMatch(/agents\.keepPeople\(\);/);
  });

  it('counts the bodies kept whose load is under way, none once each came or failed', async () => {
    const { createRiggedCitizens } = await import('@render/riggedCitizens');
    const { CROWD_IDS } = await import('@render/citizenCasting');
    const citizens = createRiggedCitizens(CROWD_IDS.slice(0, 2));
    expect(citizens.keptLoading).toBe(0);
    citizens.keepAll();
    expect(citizens.keptLoading).toBe(2);
    // Here the cooks cannot be read: each load fails, is said, and is not waited for.
    for (let i = 0; i < 200 && citizens.keptLoading > 0; i++) await new Promise((done) => setTimeout(done, 10));
    expect(citizens.keptLoading).toBe(0);
    citizens.dispose();
  });
});
