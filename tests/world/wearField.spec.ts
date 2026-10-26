import { describe, expect, it } from 'vitest';

import { blueprintByKey } from '@world/buildings/blueprints';
import { createDecayWatch } from '@world/buildings/decayWatch';
import { internMembers } from '@world/buildings/intern';
import { type RecordTable, TableWriter, readRecords } from '@world/buildings/recordTable';
import { eachSectionRef } from '@world/buildings/sections';
import { storedBounds } from '@world/buildings/geometry';
import { BuildingStore } from '@world/buildings/store';
import { buildingSummaryColumns } from '@world/buildings/summary';
import { type Building, DECAY_GRACE, DECAY_SPAN, asBuildingId, cloneBuilding } from '@world/buildings/types';
import { packImage, unpackImage, imageOf } from '@world/docBinary';
import { RoadDoc } from '@world/doc';
import { TownColumns } from '@render/buildings/townColumns';

/** A building's wear written over its table's row as a field (`TableItems.writeField`), never a record of its own on the page. */

function building(id: number, x: number, builtAt: number): Building {
  const b = { ...cloneBuilding(blueprintByKey('house')!.body as unknown as Building), id: asBuildingId(id), x, y: x / 2, rotation: 0.1 * id, builtAt, decay: 0 } as Building;
  internMembers(b as unknown as Record<string, unknown>);
  return b;
}

const records = [building(1, 0, 0), building(2, 40, 100), building(3, 80, 5000)];

function tableOf(list: readonly Building[]): ArrayBufferLike {
  const writer = new TableWriter<Building>(false, null, (b) => storedBounds(b), buildingSummaryColumns());
  writer.add(list);
  return writer.finish().buffer;
}

function storeOf(list: readonly Building[]): BuildingStore {
  const store = new BuildingStore();
  store.loadSections({ base: tableOf(list), gone: new Float64Array(0), replaced: null, added: null });
  return store;
}

describe('a building worn as a field over its table row', () => {
  it('reads back worn, its record left the table\'s, and is no record written on the page', () => {
    const store = storeOf(records);
    store.wear(asBuildingId(2), 0.3);
    expect(store.get(asBuildingId(2))!.decay).toBe(0.3);
    expect(store.decayOf(asBuildingId(2))).toBe(0.3);
    expect(store.decayOf(asBuildingId(1))).toBe(0);
    expect(store.sections().replaced).toBeNull();
    expect(store.sections().added).toBeNull();
    // The same object while it is held, as a row of the table is.
    expect(store.get(asBuildingId(2))).toBe(store.get(asBuildingId(2)));
    // Every field but the wear is the table's record.
    const { decay: _a, ...worn } = store.get(asBuildingId(2))!;
    const { decay: _b, ...own } = records[1]!;
    expect(JSON.stringify(worn)).toBe(JSON.stringify(own));
  });

  it('hands a worker the row and the wear over it, read back worn (`RecordRef.field`)', () => {
    const store = storeOf(records);
    store.wear(asBuildingId(3), 0.7);
    const ref = store.tableRef(asBuildingId(3))!;
    expect(ref.field).toEqual({ name: 'decay', value: 0.7 });
    expect(readRecords([ref])[0]!.decay).toBe(0.7);
    expect(store.tableRef(asBuildingId(1))!.field).toBeUndefined();
  });

  it('goes with the store\'s sections and the binary map, and comes back worn', () => {
    const store = storeOf(records);
    store.wear(asBuildingId(1), 0.5);
    const sections = store.sections();
    expect(Array.from(sections.field!.pairs)).toEqual([1, 0.5]);
    const back = new BuildingStore();
    back.loadSections(sections);
    expect(back.get(asBuildingId(1))!.decay).toBe(0.5);
    const refs = [...eachSectionRef(sections)];
    expect(readRecords(refs).map((b) => b.decay)).toEqual([0.5, 0, 0]);
    const image = unpackImage(packImage(imageOf({}, { buildings: sections })));
    expect(Array.from(image.tables.buildings.field!.pairs)).toEqual([1, 0.5]);
    expect(image.tables.buildings.field!.name).toBe('decay');
  });

  it('a copy keeps its own wear: written after the copy, the other is not worn', () => {
    const store = storeOf(records);
    store.wear(asBuildingId(1), 0.2);
    const copy = new BuildingStore();
    copy.shareFrom(store);
    store.wear(asBuildingId(1), 0.4);
    expect(copy.get(asBuildingId(1))!.decay).toBe(0.2);
    expect(store.get(asBuildingId(1))!.decay).toBe(0.4);
    // Put back by an undo (`replaceWith`): the wear alone written, still no record of its own.
    store.replaceWith(copy);
    expect(store.get(asBuildingId(1))!.decay).toBe(0.2);
    expect(store.sections().replaced).toBeNull();
  });

  it('files the worn row from its columns as its record filed (`TownColumns.fileRow` with the wear)', () => {
    const store = storeOf(records);
    store.wear(asBuildingId(2), 0.6);
    const byRecord = new TownColumns(), byRow = new TownColumns();
    byRecord.file(store.get(asBuildingId(2))!);
    const row = store.summaryOf(asBuildingId(2))!;
    const table: RecordTable = row.table, boxes = table.boxes!;
    byRow.fileRow(2, table.xs[row.at]!, table.ys[row.at]!, { minX: boxes.minX[row.at]!, minY: boxes.minY[row.at]!, maxX: boxes.maxX[row.at]!, maxY: boxes.maxY[row.at]! },
      table.summary!, table.rows, row.at, row.wear);
    expect(byRow.sig[byRow.slotOf(2)]).toBe(byRecord.sig[byRecord.slotOf(2)]);
    expect(byRow.massSig[byRow.slotOf(2)]).toBe(byRecord.massSig[byRecord.slotOf(2)]);
  });

  it('runs a town down from its built minutes without decoding it, as its records would', () => {
    const doc = new RoadDoc();
    doc.buildings.loadSections({ base: tableOf(records), gone: new Float64Array(0), replaced: null, added: null });
    const worn: [number, number][] = [];
    const look = createDecayWatch(doc, (id, decay) => { worn.push([id, decay]); doc.buildings.wear(id, decay); });
    const now = DECAY_GRACE + DECAY_SPAN * 0.5 + 100;
    look(0);
    expect(look(now)).toBe(true);
    expect(doc.buildings.get(asBuildingId(1))!.decay).toBe(0.5);
    expect(doc.buildings.get(asBuildingId(2))!.decay).toBe(0.5);
    expect(doc.buildings.get(asBuildingId(3))!.decay).toBe(Math.round(((now - 5000 - DECAY_GRACE) / DECAY_SPAN) * 10) / 10);
    expect(doc.buildings.sections().replaced).toBeNull();
  });
});

