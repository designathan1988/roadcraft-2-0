import { describe, expect, it } from 'vitest';

import { BLUEPRINTS } from '@world/buildings/blueprints';
import { storedBounds } from '@world/buildings/geometry';
import { buildingPads } from '@world/buildings/pads';
import { TableWriter } from '@world/buildings/recordTable';
import { buildingSummaryColumns } from '@world/buildings/summary';
import { siteGrading } from '@world/buildings/siteGrading';
import type { BuildingStore } from '@world/buildings/store';
import type { Building, BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** The sites and the town's platforms taken in a change at a time, by the ids the diary gives */
const slope = (x: number, y: number): number => x * 0.05 + y * 0.02;
/** How far a site's bank reaches past its building's bounds. */
const BANK = m(30);

function body(i: number, x: number, y: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
}

/** The store as a reader that cannot tell which buildings changed sees it: it reads them all. */
const blind = (store: BuildingStore): BuildingStore => Object.create(store, { changedSince: { value: () => null } }) as BuildingStore;

describe('the sites graded, a change at a time', () => {
  it('say what a grading that reads the whole store says', () => {
    let seed = 9;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const doc = new RoadDoc();
    for (let i = 0; i < 25; i++) doc.buildings.add(body(i, (i % 5) * m(70), Math.floor(i / 5) * m(70)));
    const live = siteGrading(slope, undefined, m(9.6), BANK);
    const whole = siteGrading(slope, undefined, m(9.6), BANK);
    const store = doc.buildings, all = blind(store);
    live.changedSites(store); live.rebuild(store);
    whole.changedSites(all); whole.rebuild(all);
    for (let round = 0; round < 30; round++) {
      const ids = [...store.all()].map((b) => b.id);
      const pick = ids[Math.floor(rand() * ids.length)]! as BuildingId;
      const roll = rand();
      if (roll < 0.3) store.add(body(round, rand() * m(350), rand() * m(350)));
      else if (roll < 0.5) store.remove(pick);
      else if (roll < 0.8) { const b = store.get(pick)!; store.put({ ...b, x: b.x + (rand() - 0.5) * m(60) }); }
      else { const b = store.get(pick)!; store.put({ ...b, palette: (b.palette + 1) % 8 }); }
      const sorted = (list: readonly (readonly number[])[] | null): string[] => (list ?? []).map((q) => q.join(',')).sort();
      expect(sorted(live.changedSites(store))).toEqual(sorted(whole.changedSites(all)));
      live.rebuild(store);
      whole.rebuild(all);
      const a = live.pads!, b = whole.pads!;
      expect(a.count).toBe(b.count);
      const boxes = (p: typeof a): string[] => p.shapeBounds().map((q) => JSON.stringify(q)).sort();
      expect(boxes(a)).toEqual(boxes(b));
      for (let i = 0; i < 300; i++) {
        const x = rand() * m(400) - m(30), y = rand() * m(400) - m(30);
        expect(a.shapeAt(x, y, slope(x, y))).toEqual(b.shapeAt(x, y, slope(x, y)));
      }
    }
  });
});

/** A store opened from a table, as a map is (`BuildingStore.loadSections`): its records decoded only when read. */
function tableStore(list: readonly Omit<Building, 'id'>[]): BuildingStore {
  const built = new RoadDoc();
  for (const b of list) built.buildings.add(b);
  const records = [...built.buildings.all()];
  const writer = new TableWriter<Building>(false, null, (b) => storedBounds(b), buildingSummaryColumns());
  writer.add(records);
  const doc = new RoadDoc();
  doc.buildings.loadSections({ base: writer.finish().buffer, gone: new Float64Array(0), replaced: null, added: null });
  return doc.buildings;
}

describe('the town\'s platforms filed as the shapings read them', () => {
  it('grade the ground as every platform filed at once did, before and after edits', () => {
    let seed = 21;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const store = tableStore(Array.from({ length: 40 }, (_, i) => body(i, (i % 8) * m(55), Math.floor(i / 8) * m(55))));
    const sites = siteGrading(slope, undefined, m(9.6), BANK);
    sites.changedSites(store);
    sites.rebuild(store);
    const compare = (): void => {
      const all = buildingPads([...store.all()], slope, undefined, m(9.6));
      for (let i = 0; i < 400; i++) {
        const x = rand() * m(500) - m(40), y = rand() * m(330) - m(40);
        expect(sites.pads!.shapeAt(x, y, slope(x, y))).toEqual(all.shapeAt(x, y, slope(x, y)));
      }
      const box: [number, number, number, number] = [m(30), m(20), m(260), m(190)];
      const cut = sites.pads!.cut([box]), whole = all.cut([box]);
      const listed = (c: typeof cut): string[] => [...c.cells].map(([key, ids]) => `${key}:${Array.from(ids, (k) => JSON.stringify(c.pads[k]!.box)).join('|')}`).sort();
      expect(listed(cut)).toEqual(listed(whole));
    };
    compare();
    for (let round = 0; round < 12; round++) {
      const ids = [...store.idList()];
      const pick = ids[Math.floor(rand() * ids.length)]! as BuildingId;
      const roll = rand();
      if (roll < 0.3) store.add(body(round, rand() * m(400), rand() * m(260)));
      else if (roll < 0.5) store.remove(pick);
      else { const b = store.get(pick)!; store.put({ ...b, x: b.x + (rand() - 0.5) * m(50) }); }
      sites.changedSites(store);
      sites.rebuild(store);
      compare();
    }
  });

  it('decode no building to grade a town opened, nor to file it', () => {
    const store = tableStore(Array.from({ length: 30 }, (_, i) => body(i, (i % 6) * m(60), Math.floor(i / 6) * m(60))));
    let read = 0;
    const get = store.get.bind(store);
    store.get = ((id: BuildingId) => { read++; return get(id); }) as typeof store.get;
    const sites = siteGrading(slope, undefined, m(9.6), BANK);
    const boxes = sites.changedSites(store)!;
    sites.rebuild(store);
    expect(boxes).toHaveLength(30);
    expect(read).toBe(0);
    // Each site's box holds its bank (`storedBounds(b, BANK)`).
    for (const b of [...store.all()]) {
      const r = storedBounds(b, BANK);
      expect(boxes.some((q) => q[0] <= r.minX && q[1] <= r.minY && q[2] >= r.maxX && q[3] >= r.maxY)).toBe(true);
    }
    // A shaping reads the platforms round it alone.
    sites.pads!.shapeAt(m(10), m(10), 0);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(30);
  });
});
