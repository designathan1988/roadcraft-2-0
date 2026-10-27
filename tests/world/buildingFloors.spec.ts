import { describe, expect, it } from 'vitest';

import { layCity } from '@editor/cityGenerator';
import { growOnLot } from '@world/growth/zoning';
import type { GroundSince, Rect } from '@world/buildings/cameraSolids';
import { buildingFloors } from '@world/buildings/floors';
import { FLOOR_READ_REACH, floorHeight } from '@world/buildings/foundation';
import { storedBounds } from '@world/buildings/geometry';
import { padOf } from '@world/buildings/pads';
import type { Building } from '@world/buildings/types';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { buildRoadElevation } from '@world/elevation';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';
import { RoadDoc } from '@world/doc';
import { type RowBox, type RowPlace, type RowSummary, type TableRow, encodeRecords } from '@world/buildings/recordTable';
import { KEYED } from '@editor/saveLayers';

/** EACH BUILDING'S FLOOR WORKED OUT ONCE (`floors.ts`) */
const base = (x: number, y: number): number => m(6) * Math.sin(x / m(170)) + m(4) * Math.cos(y / m(130)) + x * 0.01;

describe('the floors kept for every reader', () => {
  const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' }));
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < 1500; k++) if (growOnLot({ doc, net, groundAt: base }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  net.rebuild();
  const elevation = buildRoadElevation(net, base);
  const pavedAt = (x: number, y: number): number => {
    const road = elevation.roadAt(x, y);
    return road.type >= 0 && Math.abs(road.across) <= road.half ? elevation.at(x, y) : NaN;
  };
  /** The ground the floors read, swapped below; every read counted. */
  let land = base;
  let reads = 0;
  const groundAt = (x: number, y: number): number => { reads++; return land(x, y); };
  const box = (b: Building): Rect => {
    const r = storedBounds(b, FLOOR_READ_REACH);
    return [r.minX, r.minY, r.maxX, r.maxY];
  };
  const town = [...doc.buildings.all()];
  const floors = buildingFloors(groundAt, pavedAt, box, FLOOR_READ_REACH);
  const same = (): void => {
    for (const b of town) {
      const fresh = floorHeight(b, land, pavedAt);
      if (!Object.is(floors.floorOf(b), fresh)) expect.fail(`building ${b.id}: ${floors.floorOf(b)} against ${fresh}`);
    }
  };

  it('gives every reader the floor worked out, each once', () => {
    expect(town.length).toBeGreaterThan(150);
    const diary: GroundSince = { version: 0, rectsSince: () => [] };
    floors.follow(doc.buildings, diary);
    same();
    reads = 0;
    for (const b of town) floors.floorOf(b);
    expect(reads).toBe(0);
    // A platform made with the kept floor is the platform made without it.
    for (const b of town.slice(0, 60)) {
      expect(padOf(b, land, pavedAt, m(9.6), (r) => floors.floorOf(r))).toEqual(padOf(b, land, pavedAt, m(9.6)));
    }
  });

  it('works out again only the floors a change of the ground reaches, to the same numbers', () => {
    const b0 = town[Math.floor(town.length / 2)]!;
    const r0 = storedBounds(b0, 0);
    const rect: Rect = [r0.minX - m(10), r0.minY - m(10), r0.maxX + m(10), r0.maxY + m(10)];
    land = (x, y) => base(x, y) + (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3] ? m(1.5) : 0);
    floors.follow(doc.buildings, { version: 1, rectsSince: (since) => (since === 0 ? [rect] : []) });
    reads = 0;
    same();
    const again = reads;
    reads = 0;
    for (const b of town) floorHeight(b, groundAt, pavedAt);
    // `same` read the fresh floors itself (on `land`, uncounted) and the kept ones: only those the change reached.
    expect(again).toBeGreaterThan(0);
    expect(again * 10).toBeLessThan(reads);
  });

  it('where the diary cannot say, works out again only the floors the regions just shaped reach, not the town\'s', () => {
    const b1 = town[Math.floor(town.length / 3)]!;
    const r1 = storedBounds(b1, 0);
    const rect: Rect = [r1.minX - m(10), r1.minY - m(10), r1.maxX + m(10), r1.maxY + m(10)];
    const before = land;
    land = (x, y) => before(x, y) + (x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3] ? m(0.8) : 0);
    // The diary has lost where (its entries let go): the caller's regions say it.
    floors.follow(doc.buildings, { version: 2, rectsSince: () => null }, [rect]);
    reads = 0;
    same();
    const again = reads;
    reads = 0;
    for (const b of town) floorHeight(b, groundAt, pavedAt);
    expect(again).toBeGreaterThan(0);
    expect(again * 10).toBeLessThan(reads);
    // No regions either: every floor again, as before.
    floors.follow(doc.buildings, { version: 3, rectsSince: () => null });
    reads = 0;
    for (const b of town) floors.floorOf(b);
    expect(reads).toBeGreaterThan(0);
  });
});

describe('the floors of the rows of a table', () => {
  it('are kept by the row while it stands, whatever record object reads it; a preview of a building keeps its own', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' }));
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: 'medium' }));
    const refused = new Set<number>();
    for (let k = 0; k < 300; k++) if (growOnLot({ doc, net, groundAt: base }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    const records = [...doc.buildings.all()];
    expect(records.length).toBeGreaterThan(5);
    // The same map with its buildings in one table, its columns as the save writes them (`saveLayers.ts` KEYED), as a saved city opens.
    const spec = KEYED.buildings;
    const table = encodeRecords(records as unknown as TableRow[], (spec.columns ?? null) as RowPlace<TableRow> | null, (spec.box ?? null) as RowBox<TableRow> | null,
      (spec.summary?.() ?? null) as RowSummary<TableRow> | null);
    const opened = RoadDoc.fromJSON({ ...doc.toJSON(), buildings: [] }, { tables: { buildings: table.buffer } });
    const store = opened.buildings;
    let reads = 0;
    const groundAt = (x: number, y: number): number => { reads++; return base(x, y); };
    const floors = buildingFloors(groundAt, undefined, (b) => { const r = storedBounds(b, FLOOR_READ_REACH); return [r.minX, r.minY, r.maxX, r.maxY]; }, FLOOR_READ_REACH,
      (b) => store.recordRow(b));
    const one = store.get(records[0]!.id)!;
    expect(store.recordRow(one)).not.toBeNull();
    const floor = floors.floorOf(one);
    expect(floor).toBeCloseTo(floorHeight(one, base), 9);
    const after = reads;
    // Its wear written over its row: another record object reads the row now, its floor the row's, not worked out again.
    store.wear(one.id, 0.5);
    const worn = store.get(one.id)!;
    expect(worn).not.toBe(one);
    expect(floors.floorOf(worn)).toBe(floor);
    expect(reads).toBe(after);
    // A preview of it (a copy moved by a tool) is no record of the store: its own floor, on its own ground.
    const preview = { ...worn, x: worn.x + m(40) };
    expect(store.recordRow(preview)).toBeNull();
    expect(floors.floorOf(preview)).toBeCloseTo(floorHeight(preview, base), 9);
    expect(reads).toBeGreaterThan(after);
  });
});

describe('the floors measured elsewhere', () => {
  it('are taken for a building whose blocks are its volumes, and worked out here for one with a void', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' }));
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: 'medium' }));
    const refused = new Set<number>();
    for (let k = 0; k < 100; k++) if (growOnLot({ doc, net, groundAt: base }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    const plain = [...doc.buildings.all()].find((b) => !b.volumes.some((v) => v.mode))!;
    expect(plain).toBeDefined();
    let reads = 0;
    const groundAt = (x: number, y: number): number => { reads++; return base(x, y); };
    const measured = new Map<number, number>([[plain.id, floorHeight(plain, base)]]);
    const floors = buildingFloors(groundAt, undefined, (b) => { const r = storedBounds(b, FLOOR_READ_REACH); return [r.minX, r.minY, r.maxX, r.maxY]; }, FLOOR_READ_REACH,
      null, (b) => measured.get(b.id));
    // Measured: taken, its ground never read here.
    expect(floors.floorOf(plain)).toBe(measured.get(plain.id));
    expect(reads).toBe(0);
    // A void among its volumes: the jobs measure its blocks resolved, another building - worked out here on its own.
    const carved = { ...plain, volumes: [...plain.volumes, { ...plain.volumes[0]!, id: 999, mode: 'void' as const, w: m(1), d: m(1) }] };
    measured.set(carved.id, -12345);
    expect(floors.floorOf(carved)).toBeCloseTo(floorHeight(carved, base), 9);
    expect(reads).toBeGreaterThan(0);
  });
});
