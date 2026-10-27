import { describe, expect, it } from 'vitest';

import { BLUEPRINTS, instantiate } from '../../src/world/buildings/blueprints';
import { type SolidRows, cameraSolidsKeeper, solidRowsOf } from '../../src/world/buildings/cameraSolids';
import { BuildingStore } from '../../src/world/buildings/store';
import { buildingHeight, footprintCentre } from '../../src/world/buildings/geometry';
import type { Building } from '../../src/world/buildings/types';
import { m } from '../../src/world/units';

const town = new BuildingStore();
const block = (): Building => town.add(instantiate(BLUEPRINTS.find((b) => b.key === 'block')!.body, { x: 100, y: 50 }, 0.4));

// The camera is lifted out of a building smoothly and never kept inside it (`render/isoViewport.ts` `setSolids`).
describe('camera solids', () => {
  const b = block();
  // Filed as the renderer files them (`render/renderer.ts`): the keeper, the ground never moved.
  const keeper = cameraSolidsKeeper(() => 10, () => [0, 0, 0, 0], 0);
  keeper.follow(town, { version: 0, rectsSince: () => [] });
  const solids = keeper.solids();
  const c = footprintCentre(b);

  it('keeps the eye over the roof inside the footprint', () => {
    expect(solids.floorAt(c.x, c.y)).toBeGreaterThan(10 + buildingHeight(b) - 1e-6);
  });

  it('visits each volume once, though it is filed in every cell it touches', () => {
    const seen: number[] = [];
    solids.forEachIn(c.x - m(200), c.y - m(200), c.x + m(200), c.y + m(200), (_bx, _by, _cos, _sin, lx0, ly0) => { seen.push(lx0 * 1e3 + ly0); });
    expect(seen.length).toBe(b.volumes.filter((v) => !v.open).length);
    const both: number[] = [];
    solids.forEachInAny([[c.x - m(5), c.y - m(5), c.x, c.y], [c.x, c.y, c.x + m(5), c.y + m(5)]], () => { both.push(1); });
    expect(both.length).toBeLessThanOrEqual(seen.length);
  });

  it('asks nothing far from every building', () => {
    expect(solids.floorAt(c.x + m(300), c.y)).toBe(-Infinity);
  });

  it('is continuous: no jump between two points 1 mm apart, on a walk away from the building', () => {
    let last = solids.floorAt(c.x, c.y);
    let biggest = 0;
    for (let d = m(0.001); d < m(60); d += m(0.001)) {
      const now = solids.floorAt(c.x + d, c.y);
      if (Number.isFinite(now) && Number.isFinite(last)) biggest = Math.max(biggest, Math.abs(now - last));
      last = now;
    }
    expect(biggest).toBeLessThan(0.5);
  });

  it('gives the roof over a point inside the footprint only, with no margin round it', () => {
    const roof = solids.roofAt(c.x, c.y);
    expect(roof).toBeGreaterThan(10 + buildingHeight(b) - m(0.01));
    expect(roof).toBeLessThan(solids.floorAt(c.x, c.y));
    // Walking out: the roof stops at the wall, where the eye's floor still eases down.
    let d = 0;
    while (Number.isFinite(solids.roofAt(c.x + d, c.y))) d += m(0.05);
    expect(solids.roofAt(c.x + d + m(0.5), c.y)).toBe(-Infinity);
    expect(Number.isFinite(solids.floorAt(c.x + d + m(0.5), c.y))).toBe(true);
  });
});

/** A town of blocks over 600 m, as a store opened from a table answers it: each record read when asked. */
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

describe('camera solids filed as the questions reach them', () => {
  const ground = { version: 0, rectsSince: () => [] };
  const floorOf = (b: Building): number => b.x * 0.001;
  const box = (b: Building): readonly [number, number, number, number] => [b.x - 30, b.y - 30, b.x + 30, b.y + 30];

  it('answer as the whole town filed at once, and file only round the first question', () => {
    const store = spreadTown();
    const lazy = cameraSolidsKeeper(floorOf, box, 0);
    const whole = cameraSolidsKeeper(floorOf, box, 0);
    lazy.follow(store, ground);
    whole.follow(store, ground);
    let read = 0;
    const get = store.get.bind(store);
    store.get = ((id) => { read++; return get(id); }) as typeof store.get;
    lazy.solids().floorAt(m(300), m(300));
    expect(read).toBeLessThan(store.size / 4);
    store.get = get;
    // The other filled over the whole town first: the filing every question read before.
    whole.solids().forEachIn(m(-100), m(-100), m(700), m(700), () => {});
    let seedPoint = 11;
    const rand = (): number => ((seedPoint = (seedPoint * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 2000; i++) {
      const x = rand() * m(640) - m(20), y = rand() * m(640) - m(20);
      expect(lazy.solids().floorAt(x, y)).toBe(whole.solids().floorAt(x, y));
      expect(lazy.solids().roofAt(x, y)).toBe(whole.solids().roofAt(x, y));
    }
    const listed = (k: typeof lazy, r: readonly [number, number, number, number]): string[] => {
      const out: string[] = [];
      k.solids().forEachOccluder(r[0], r[1], r[2], r[3], (...a) => { out.push(a.join(',')); });
      return out.sort();
    };
    expect(listed(lazy, [m(100), m(100), m(400), m(350)])).toEqual(listed(whole, [m(100), m(100), m(400), m(350)]));
  });

  it('files a building changed again where its cells were filled', () => {
    const store = spreadTown();
    const lazy = cameraSolidsKeeper(floorOf, box, 0);
    lazy.follow(store, ground);
    const b = [...store.all()][7]!;
    lazy.solids().floorAt(b.x, b.y);
    const before = lazy.solids().roofAt(b.x, b.y);
    expect(before).toBeGreaterThan(-Infinity);
    store.remove(b.id);
    lazy.follow(store, ground);
    expect(lazy.solids().roofAt(b.x, b.y) < before || lazy.solids().roofAt(b.x, b.y) === -Infinity).toBe(true);
  });

  it('filed off the page ahead of the questions, answer as the town filed here, a building changed since it was asked from its record', async () => {
    const store = spreadTown();
    const pending: (() => void)[] = [];
    let read = 0;
    // The floors known without a record (the renderer's: kept by row, or measured by the cells' jobs).
    const feet = new Map([...store.all()].map((b) => [b.id, floorOf(b)] as const));
    const off = cameraSolidsKeeper(floorOf, box, 0, {
      // A job's answer: each building's rows on no floor, read when asked and given later.
      ask: (ids, buildings) => {
        const answers: SolidRows[] = ids.map((id) => ({ id, ...solidRowsOf(buildings.get(id)!) }));
        return new Promise<readonly SolidRows[]>((done) => pending.push(() => done(answers)));
      },
      footOf: (id) => feet.get(id),
    });
    const whole = cameraSolidsKeeper(floorOf, box, 0);
    off.follow(store, ground);
    whole.follow(store, ground);
    off.solids();
    off.prefetch([[m(-100), m(-100), m(700), m(700)]]);
    expect(pending.length).toBeGreaterThan(10);
    // One building moved while its cell was asked: filed as it stands now.
    const moved = [...store.all()][5]!;
    store.put({ ...moved, x: moved.x + m(6) });
    off.follow(store, ground);
    whole.follow(store, ground);
    off.solids();
    const get = store.get.bind(store);
    store.get = ((id) => { read++; return get(id); }) as typeof store.get;
    for (const land of pending.splice(0)) land();
    await Promise.resolve();
    await Promise.resolve();
    store.get = get;
    // Only the changed building's record read to file it: the others came from the answers.
    expect(read).toBeLessThan(5);
    whole.solids().forEachIn(m(-100), m(-100), m(700), m(700), () => {});
    let seedPoint = 5;
    const rand = (): number => ((seedPoint = (seedPoint * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 2000; i++) {
      const x = rand() * m(640) - m(20), y = rand() * m(640) - m(20);
      expect(off.solids().floorAt(x, y)).toBe(whole.solids().floorAt(x, y));
      expect(off.solids().roofAt(x, y)).toBe(whole.solids().roofAt(x, y));
    }
  });
});
