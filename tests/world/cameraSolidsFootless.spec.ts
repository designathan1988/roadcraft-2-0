import { describe, expect, it } from 'vitest';

import { BLUEPRINTS, instantiate } from '../../src/world/buildings/blueprints';
import { type SolidRows, cameraSolidsKeeper, solidRowsOf } from '../../src/world/buildings/cameraSolids';
import { BuildingStore } from '../../src/world/buildings/store';
import type { Building, BuildingId } from '../../src/world/buildings/types';
import { m } from '../../src/world/units';

/** THE WAITING BUILDINGS ASKED THEIR FLOOR ONLY WHEN ONE MAY HAVE BECOME KNOWN (MISSION 1f): a building a job answered for with no floor known
 *  waits; its floor is asked again when the floors kept or learned moved (`footsVersion`), not at every frame; once known it is filed on it. */

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

describe('the camera solids\' waiting buildings', () => {
  it('ask their floor again only when a floor was kept or learned, and are filed on it then', async () => {
    const store = spreadTown();
    const ground = { version: 0, rectsSince: () => [] };
    const floorOf = (b: Building): number => b.x * 0.001;
    const box = (b: Building): readonly [number, number, number, number] => [b.x - 30, b.y - 30, b.x + 30, b.y + 30];
    // No floor known at first: the cells' jobs have measured none yet.
    const feet = new Map<BuildingId, number>();
    let footsVersion = 0, asked = 0;
    const pending: (() => void)[] = [];
    const keeper = cameraSolidsKeeper(floorOf, box, 0, {
      ask: (ids, buildings) => {
        const answers: SolidRows[] = ids.map((id) => ({ id, ...solidRowsOf(buildings.get(id)!) }));
        return new Promise<readonly SolidRows[]>((done) => pending.push(() => done(answers)));
      },
      footOf: (id) => { asked++; return feet.get(id); },
      footsVersion: () => footsVersion,
    });
    keeper.follow(store, ground);
    keeper.solids();
    keeper.prefetch([[m(-100), m(-100), m(700), m(700)]]);
    for (const land of pending.splice(0)) land();
    await Promise.resolve();
    await Promise.resolve();
    // The answers asked each building's floor once: those whose blocks are their volumes wait for it.
    keeper.solids();
    asked = 0;
    for (let frame = 0; frame < 5; frame++) keeper.solids();
    expect(asked).toBe(0);

    // The jobs measured every floor: the next frame asks them, and files each on it.
    for (const b of store.all()) feet.set(b.id, floorOf(b));
    footsVersion++;
    keeper.solids();
    expect(asked).toBeGreaterThan(0);
    asked = 0;
    keeper.solids();
    expect(asked).toBe(0);

    // Filed as the whole town filed here on the same floors.
    const whole = cameraSolidsKeeper(floorOf, box, 0);
    whole.follow(store, ground);
    whole.solids().forEachIn(m(-100), m(-100), m(700), m(700), () => {});
    let seedPoint = 5;
    const rand = (): number => ((seedPoint = (seedPoint * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const solids = keeper.solids();
    for (let i = 0; i < 500; i++) {
      const x = rand() * m(640) - m(20), y = rand() * m(640) - m(20);
      expect(solids.roofAt(x, y)).toBe(whole.solids().roofAt(x, y));
    }
  });
});
