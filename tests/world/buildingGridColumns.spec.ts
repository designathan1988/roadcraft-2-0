import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareCity } from '@editor/preparedCity';
import { buildingBounds } from '@world/buildings/geometry';
import { RecordTable } from '@world/buildings/recordTable';
import { RoadDoc, type SerializedDoc } from '@world/doc';

/** THE BUILDINGS BY PLACE FILED FROM THEIR TABLE'S COLUMNS (`BuildingStore` grid, `recordTable.ts` format 2): the first question by place decodes no record of the map. */

/** The parking town in this build's world unit (the fixture is in the unit before 2026-10-10: `fromJSON` rescales it, a prepared city is written as it is). */
const town = (): SerializedDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')) as SerializedDoc).toJSON();

describe('a store filed by place from its table', () => {
  it('writes each building\'s box in its table\'s columns, as the store works it out of the record', () => {
    const made = prepareCity(town());
    const table = new RecordTable(made.buildings);
    expect(table.boxes).not.toBeNull();
    const plain = RoadDoc.fromJSON(town());
    for (let row = 0; row < table.rows; row++) {
      const b = plain.buildings.get(table.ids[row]! as never)!;
      const box = buildingBounds(b);
      expect([table.boxes!.minX[row], table.boxes!.minY[row], table.boxes!.maxX[row], table.boxes!.maxY[row]]).toEqual([box.minX, box.minY, box.maxX, box.maxY]);
    }
  });

  it('answers by place as the store of records does, decoding only the buildings it answers with', () => {
    const plain = RoadDoc.fromJSON(town());
    const made = prepareCity(town());
    const tabled = new RoadDoc();
    tabled.replaceFromJSON(made.data, { repair: false, buildingTable: made.buildings, whole: true });
    const rows = tabled.buildings.table!;
    expect(rows.held()).toBe(0);
    // Far from every building: the grid filed from the columns, nothing decoded for it.
    expect(tabled.buildings.near(1e6, 1e6, 1e6 + 10, 1e6 + 10)).toEqual([]);
    expect(rows.held()).toBe(0);
    const some = [...plain.buildings.all()].slice(0, 5);
    for (const b of some) {
      const rect = [b.x - 30, b.y - 30, b.x + 30, b.y + 30] as const;
      const ids = (doc: RoadDoc): number[] => doc.buildings.near(...rect).map((c) => c.id);
      expect(ids(tabled)).toEqual(ids(plain));
      expect(ids(tabled)).toContain(b.id);
    }
    // Only what was answered is held decoded: far fewer than the town's buildings.
    expect(rows.held()).toBeLessThan(plain.buildings.size / 2);
  });
});
