import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';

import { cellMass } from '@render/buildings/cellArrays';
import { createBuildingKit } from '@render/buildings/kit';
import { createMassCells } from '@render/buildings/massCells';
import { type BaseMass, baseCellOf, joinBase } from '@render/buildings/massBase';
import { massesOf } from './support/masses';
import { baseOf, levelCells } from '@render/buildings/levelKeys';
import { PLATE_DETAIL } from '@render/buildings/massing';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { CELL } from '@world/cells';

/** THE BASES DRAWN AGAIN ONLY WHERE A PLATE CHANGED (MISSION 1f): a cell landing in one plate rebuilds that plate's base's groups alone, and a
 *  `syncBases` with nothing changed rebuilds none. */
const flat = (): number => 0;

function building(index: number, x: number, y: number): Building {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x, y, rotation: 0 } as Building;
}

/** Two cells' buildings at column `i` and `i + 1`, row 0, and the base of their plate. */
function town(i: number, firstId: number): { buildings: Building[]; base: BaseMass; cells: string[] } {
  const buildings = [0, 1, 2].flatMap((k) => [
    building(firstId + k, i * CELL + m(10) + k * m(40), m(20)),
    building(firstId + k + 3, (i + 1) * CELL + m(10) + k * m(40), m(20)),
  ]);
  const cells = [`${i},0`, `${i + 1},0`];
  const masses = cells.map((cell) => cellMass(buildings.filter((b) => baseCellOf(b) === cell).map((b) => massesOf(b, flat, undefined, flat, undefined, PLATE_DETAIL, { floor: 0 })!)));
  const base = joinBase(cells.map((cell, k) => ({ cell, mass: masses[k]! })), levelCells(baseOf(i, 0)))!;
  return { buildings, base, cells };
}

describe('the bases synced', () => {
  it('rebuilds only the base of the plate that changed, and none when nothing did', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL, () => {});
    const side = levelCells(baseOf(0, 0)).n;
    const a = town(0, 0), b = town(side, 100);
    expect(baseOf(side, 0)).not.toBe(baseOf(0, 0));
    for (const t of [a, b]) for (const cell of t.cells) far.plan(cell);
    far.landBase(baseOf(0, 0), a.base);
    far.landBase(baseOf(side, 0), b.base);
    far.syncBases();
    expect(far.basesSynced).toBe(2);

    // The two bases' meshes, in the order they landed (A, then B).
    const meshes: Mesh[] = [];
    far.group.traverse((o) => { if (o.name === 'building-massing-base') meshes.push(o as Mesh); });
    expect(meshes).toHaveLength(2);
    const meshOf = (key: 'a' | 'b'): Mesh => meshes[key === 'a' ? 0 : 1]!;
    const bGroups = meshOf('b').geometry.groups;
    const bBefore = bGroups.map((g) => ({ ...g }));

    // Still: nothing rebuilt.
    far.syncBases();
    expect(far.basesSynced).toBe(2);

    // A cell of plate A gets its own masses: A's base rebuilt, B's left as it was.
    far.land(a.cells[0]!, cellMass(a.buildings.filter((x) => baseCellOf(x) === a.cells[0]).map((x) => massesOf(x, flat)!))!);
    // A mark on B's groups that a rebuild would wipe.
    bGroups.push({ start: 0, count: 3, materialIndex: 0 });
    far.syncBases();
    expect(far.basesSynced).toBe(3);
    expect(meshOf('b').geometry.groups).toEqual([...bBefore, { start: 0, count: 3, materialIndex: 0 }]);
    bGroups.pop();
    expect(Object.fromEntries(far.census())).toEqual({ [a.cells[0]!]: 'mass', [a.cells[1]!]: 'base', [b.cells[0]!]: 'base', [b.cells[1]!]: 'base' });

    // A cell of plate B shown in detail: B's base alone rebuilt, the cell left out of it.
    far.setDetailed(b.cells[1]!, true);
    far.syncBases();
    expect(far.basesSynced).toBe(4);
    expect(far.census().get(b.cells[1]!)).toBe('detail');
    far.dispose();
  });
});
