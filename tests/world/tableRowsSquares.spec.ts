import { describe, expect, it } from 'vitest';

import { blueprintByKey } from '@world/buildings/blueprints';
import { TableItems } from '@world/buildings/items';
import { encodeRecords, RecordTable } from '@world/buildings/recordTable';
import { eachSectionRef, itemsOfSections, sectionsOf, sectionsSize } from '@world/buildings/sections';
import { TableRows } from '@world/buildings/tableRows';
import { type Building, type BuildingId, asBuildingId, cloneBuilding } from '@world/buildings/types';
import { docTables, packImage, unpackImage } from '@world/docBinary';

/** A STORE READ OVER A MAP'S SQUARES' TABLES, NOTHING JOINED (`tableRows.ts` TableBase): the records by id and in the store's order, each read where its own table holds it */

function building(id: number, x: number): Building {
  return { ...cloneBuilding(blueprintByKey('house')!.body as unknown as Building), id: asBuildingId(id), x, y: -x / 3, rotation: 0.1 * id };
}

/** Three squares, their ids interleaved as a map's squares' are; the order of the store's rows over them: by id. */
function squares(): { tables: ArrayBufferLike[]; order: Uint32Array; ids: number[]; byId: Map<number, Building> } {
  const lists = [[5, 1, 9], [2, 8], [7, 3, 6, 4]].map((ids) => ids.map((id) => building(id, id * 10)));
  const tables = lists.map((list) => encodeRecords(list).buffer);
  const all = lists.flat();
  const order = Uint32Array.from(all.map((_, i) => i).sort((a, b) => all[a]!.id - all[b]!.id));
  return { tables, order, ids: all.map((b) => b.id).sort((a, b) => a - b), byId: new Map(all.map((b) => [b.id, b])) };
}

describe('a store over its squares\' tables', () => {
  it('reads each record where its own table holds it, in the store\'s order, its columns one after the other', () => {
    const s = squares();
    const rows = new TableRows({ tables: s.tables, order: s.order });
    expect(rows.size).toBe(9);
    expect([...rows.keys()]).toEqual(s.ids);
    for (const id of s.ids) {
      const row = rows.rowOf(id);
      expect(JSON.stringify(rows.get(asBuildingId(id)))).toBe(JSON.stringify(s.byId.get(id)));
      // Its columns, and its table and row there.
      expect(rows.xs[row]).toBe(id * 10);
      const table = rows.tableOf(row), at = rows.localRow(row);
      expect(table.ids[at]).toBe(id);
      expect(rows.rowAt(rows.rankOf(row))).toBe(row);
    }
    expect(rows.boxes).not.toBeNull();
    expect(rows.base).toEqual({ tables: s.tables, order: s.order });
  });

  it('hands a worker the row of the table it stands in, and the items over the tables walk in the store\'s order', () => {
    const s = squares();
    const items = new TableItems(new TableRows({ tables: s.tables, order: s.order }));
    expect([...items.keys()]).toEqual(s.ids);
    expect([...items.values()].map((b) => b.id)).toEqual(s.ids);
    const ref = items.tableRef(asBuildingId(8))!;
    expect(ref.buffer).toBe(s.tables[1]);
    expect(new RecordTable(ref.buffer).ids[ref.row]).toBe(8);
    expect(items.rowOrder(asBuildingId(8))).toBe(s.ids.indexOf(8));
    const ranks: number[] = [];
    items.eachInOrder((_rows, _row, _field, rank) => ranks.push(rank), () => {});
    expect(ranks).toEqual(s.ids.map((_, i) => i));
  });

  it('keeps its tables and their order through its sections and the map\'s image, the records written over them with them', () => {
    const s = squares();
    const items = new TableItems(new TableRows({ tables: s.tables, order: s.order }));
    items.delete(asBuildingId(3));
    items.set(asBuildingId(7), { ...building(7, 70), x: 71 });
    items.writeField('decay', asBuildingId(6), 0.5);
    const sections = sectionsOf(items);
    expect(sectionsSize(sections)).toBe(8);
    const refs = [...eachSectionRef(sections)].map((ref) => new RecordTable(ref.buffer).ids[ref.row]);
    expect(refs).toEqual(s.ids.filter((id) => id !== 3));
    const image = unpackImage(packImage({ parts: [], tables: docTables({ buildings: sections }) }));
    const back = itemsOfSections<BuildingId, Building>(image.tables.buildings, null);
    expect([...back.keys()]).toEqual(s.ids.filter((id) => id !== 3));
    expect(back.get(asBuildingId(7))!.x).toBe(71);
    expect(back.get(asBuildingId(6))!.decay).toBe(0.5);
  });
});
