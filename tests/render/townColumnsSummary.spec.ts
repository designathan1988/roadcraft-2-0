import { describe, expect, it } from 'vitest';

import { blueprintByKey, BLUEPRINTS } from '@world/buildings/blueprints';
import { internMembers } from '@world/buildings/intern';
import { RecordTable, TableWriter } from '@world/buildings/recordTable';
import { storedBounds } from '@world/buildings/geometry';
import { buildingSummaryColumns, fliesFlag as worldFlies, isSignature, SUMMARY_WIDTH } from '@world/buildings/summary';
import { TOWER_KINDS } from '@world/buildings/towerKit';
import { type Building, asBuildingId, cloneBuilding } from '@world/buildings/types';
import { drawsSignature } from '@render/buildings/signature';
import { fliesFlag } from '@render/buildings/buildingMesh';
import { TownColumns } from '@render/buildings/townColumns';

/** The buildings' layer files the town from a table's summary columns (`TownColumns.fileRow`), the same numbers `file` reads out of each record. */

function building(id: number, key: string, x: number, extra: Partial<Building> = {}): Building {
  const b = { ...cloneBuilding(blueprintByKey(key)!.body as unknown as Building), id: asBuildingId(id), x, y: -x / 3, rotation: 0.37 * id, ...extra } as Building;
  internMembers(b as unknown as Record<string, unknown>);
  return b;
}

/** A building of `key` flying a flag from a spire on its first volume. */
function flying(id: number, key: string, x: number): Building {
  const b = building(id, key, x);
  const v = b.volumes[0]!;
  return { ...b, volumes: [{ ...v, roofDetails: [...(v.roofDetails ?? []), { id: 900, kind: 'spire', x: 0, y: 0, rotation: 0, w: 1, d: 1, flag: 'saoPaulo' }] }, ...b.volumes.slice(1)] } as Building;
}

const rows: Building[] = [
  ...BLUEPRINTS.map((bp, i) => building(10 + i, bp.key, 13.5 * i - 40)),
  building(40, 'house', 7, { decay: 0.45 } as Partial<Building>),
  flying(41, 'tower', 120),
  ...TOWER_KINDS.map((kind, i) => building(100 + i, 'tower', 31 * i, { blueprint: `signature:${kind}` } as Partial<Building>)),
  building(200, 'house', 3, { blueprint: 'signature:notADesign' } as Partial<Building>),
];

const FIELDS = ['x', 'y', 'minX', 'minY', 'maxX', 'maxY', 'height', 'groundMinX', 'groundMinY', 'groundMaxX', 'groundMaxY', 'sig', 'massSig'] as const;

function filed(columns: TownColumns, id: number): Record<string, number> {
  const slot = columns.slotOf(id);
  const out: Record<string, number> = { flags: columns.flags[slot]! };
  for (const f of FIELDS) out[f] = columns[f][slot]!;
  return out;
}

describe('the town filed from the table\'s summary columns', () => {
  const writer = new TableWriter<Building>(false, null, (b) => storedBounds(b), buildingSummaryColumns());
  writer.add(rows);
  const table = new RecordTable(writer.finish().buffer);

  it('holds the summary in its own columns', () => {
    expect(table.summaryWidth).toBe(SUMMARY_WIDTH);
    expect(table.summary!.length).toBe(SUMMARY_WIDTH * rows.length);
  });

  it('files each row as its record filed: the same place, box, height, ground, digests and marks', () => {
    const byRecord = new TownColumns(), byRow = new TownColumns();
    for (let row = 0; row < table.rows; row++) {
      const id = table.ids[row]!;
      byRecord.file(table.reader().record(row) as Building);
      byRow.fileRow(id, table.xs[row]!, table.ys[row]!,
        { minX: table.boxes!.minX[row]!, minY: table.boxes!.minY[row]!, maxX: table.boxes!.maxX[row]!, maxY: table.boxes!.maxY[row]! },
        table.summary!, table.rows, row);
    }
    for (const b of rows) expect(filed(byRow, b.id)).toEqual(filed(byRecord, b.id));
  });

  it('files the row copied into another table the same (`TableWriter.copyRows` keeps the summary)', () => {
    const copy = new TableWriter<Building>(false, null, (b) => storedBounds(b), buildingSummaryColumns());
    copy.copyRows(table, [3, 0, table.rows - 1]);
    const out = new RecordTable(copy.finish().buffer);
    const columns = Array.from({ length: SUMMARY_WIDTH }, (_, c) => c);
    expect(Array.from(out.summary!)).toEqual(columns.flatMap((c) => [3, 0, table.rows - 1].map((row) => table.summary![c * table.rows + row]!)));
  });

  it('marks a signature exactly where the layer draws one, and a flag where the mesh flies one', () => {
    for (const b of rows) {
      expect(isSignature(b)).toBe(drawsSignature(b));
      expect(worldFlies(b)).toBe(fliesFlag(b));
    }
    expect(rows.filter(isSignature)).toHaveLength(TOWER_KINDS.length);
    expect(rows.filter(worldFlies).map((b) => b.id)).toContain(41);
  });
});
