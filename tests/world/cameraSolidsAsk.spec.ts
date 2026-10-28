import { afterEach, describe, expect, it, vi } from 'vitest';

import { BLUEPRINTS, instantiate } from '../../src/world/buildings/blueprints';
import { type SolidRows, cameraSolidsKeeper, solidRowsOf } from '../../src/world/buildings/cameraSolids';
import { BuildingStore } from '../../src/world/buildings/store';
import type { Building } from '../../src/world/buildings/types';
import { m } from '../../src/world/units';

/** THE SAME WINDOW ASKS NOTHING AGAIN (MISSION 1f): the canyon light's and the occluders' windows, asked at every frame, look up their cells
 *  only when a cell may have become askable again (a job failed, an answer came stale, the filing let go whole). */

function spreadTown(): BuildingStore {
  const store = new BuildingStore();
  let seed = 5;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 120; i++) {
    const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
    store.add(instantiate(bp.body, { x: rand() * m(600), y: rand() * m(600) }, rand() * 6.3));
  }
  return store;
}

afterEach(() => vi.restoreAllMocks());

describe('the camera solids\' windows asked', () => {
  it('look up their cells once while nothing makes one askable again, and again after a failed job', async () => {
    const store = spreadTown();
    const ground = { version: 0, rectsSince: () => [] };
    const floorOf = (b: Building): number => b.x * 0.001;
    const box = (b: Building): readonly [number, number, number, number] => [b.x - 30, b.y - 30, b.x + 30, b.y + 30];
    const jobs: { ids: readonly number[]; land: () => void; fail: () => void }[] = [];
    const keeper = cameraSolidsKeeper(floorOf, box, 0, {
      ask: (ids, buildings) => new Promise<readonly SolidRows[]>((done, failed) => jobs.push({
        ids, land: () => done(ids.map((id) => ({ id, ...solidRowsOf(buildings.get(id)!) }))), fail: () => failed(new Error('a job lost')),
      })),
      footOf: (id) => floorOf(store.get(id)!),
    });
    keeper.follow(store, ground);
    const window = [m(0), m(0), m(600), m(600)] as const;
    const occluders = (): void => keeper.solids().forEachOccluder(window[0], window[1], window[2], window[3], () => {});
    occluders();
    expect(jobs.length).toBeGreaterThan(1);
    const asked = jobs.length;

    // Asked every frame with the jobs out: no cell looked up, none asked again.
    const lookups = vi.spyOn(Set.prototype, 'has');
    occluders();
    occluders();
    expect(lookups).not.toHaveBeenCalled();
    expect(jobs.length).toBe(asked);
    lookups.mockRestore();

    // A job fails: its cells asked again by the same window; the others land and are filed.
    const [lost, ...rest] = jobs.splice(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    lost!.fail();
    for (const job of rest) job.land();
    await Promise.resolve();
    await Promise.resolve();
    occluders();
    // Its buildings not filed by the other jobs' answers (a building near two blocks is asked by both).
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.ids.length).toBeGreaterThan(0);
    for (const id of jobs[0]!.ids) expect(lost!.ids).toContain(id);
  });
});
