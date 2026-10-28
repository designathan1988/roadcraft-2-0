import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three';

import { cellMass, joinMass } from '@render/buildings/cellArrays';
import { createBuildingKit } from '@render/buildings/kit';
import { createMassCells } from '@render/buildings/massCells';
import { BASE_CELL_STRIDE, type BaseMass, baseCellOf, joinBase } from '@render/buildings/massBase';
import { massesOf } from './support/masses';
import { baseOf, levelCells } from '@render/buildings/levelKeys';
import { PLATE_DETAIL } from '@render/buildings/massing';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { CELL } from '@world/cells';

/** THE BUILDINGS' TOP LEVEL (`massBase.ts`): every building of a plate's square laid as the plate lays it, cell by cell, drawn under the cells nothing finer draws */
const flat = (): number => 0;

function building(index: number, x: number, y: number): Building {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x, y, rotation: 0 } as Building;
}

/** Two cells' buildings, three each, each cell's masses at the plate's detail (as the base's job lays them, `cellWork.ts`), and their base. */
function town(): { buildings: Building[]; cellMasses: ReturnType<typeof cellMass>[]; base: BaseMass } {
  const buildings = [0, 1, 2].flatMap((i) => [building(i, m(10) + i * m(40), m(20)), building(i + 3, CELL + m(10) + i * m(40), m(20))]);
  const cells = ['0,0', '1,0'];
  const cellMasses = cells.map((cell) => cellMass(buildings.filter((b) => baseCellOf(b) === cell).map((b) => massesOf(b, flat, undefined, flat, undefined, PLATE_DETAIL, { floor: 0 })!)));
  const base = joinBase(cells.map((cell, k) => ({ cell, mass: cellMasses[k]! })), levelCells(baseOf(0, 0)))!;
  return { buildings, cellMasses, base };
}

describe('the base', () => {
  it('is the plate\'s own level, its cells\' triangles in runs of their own: their shells\', then their runs of bays\'', () => {
    const { cellMasses, base } = town();
    // One form: the very bytes the plate's level makes of the same buildings (`joinMass`), no prism nor paint of its own.
    expect(base.mass).toEqual(joinMass(cellMasses.map((c) => c!), levelCells(baseOf(0, 0))));
    const cells = base.cells, mass = base.mass!;
    expect(cells.length).toBe(2 * BASE_CELL_STRIDE);
    const [a, b] = [cellMasses[0]!, cellMasses[1]!];
    // Cell 0,0 then 1,0: their shells one after the other, then their runs one after the other.
    expect([...cells.subarray(0, 6)]).toEqual([0, 0, 0, a.runs, mass.runs, a.index.length - a.runs]);
    expect([...cells.subarray(6, 12)]).toEqual([1, 0, a.runs, b.runs, mass.runs + a.index.length - a.runs, b.index.length - b.runs]);
    expect(a.runs > 0 && b.runs > 0 && a.index.length > a.runs && b.index.length > b.runs).toBe(true);
  });

  it('is drawn under exactly the cells nothing finer draws, by the plate\'s materials, and never let go for the budget', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL, () => {});
    const { buildings, base } = town();
    far.plan('0,0');
    far.plan('1,0');
    far.planLevel(baseOf(0, 0));
    expect(far.basesWaiting).toBe(1);
    far.landBase(baseOf(0, 0), base);
    expect(far.basesWaiting).toBe(0);
    far.syncBases();
    const mesh = (): Mesh => { let out: Mesh | null = null; far.group.traverse((o) => { if (o.name === 'building-massing-base') out = o as Mesh; }); return out!; };
    expect(mesh().material).toEqual([kit.shellMaterial, kit.facade]);
    // Nothing else drawn yet: the base under both cells, a draw for the shells and one for the runs.
    const mass = base.mass!;
    expect(mesh().visible).toBe(true);
    expect(mesh().geometry.groups).toEqual([{ start: 0, count: mass.runs, materialIndex: 0 }, { start: mass.runs, count: mass.index.length - mass.runs, materialIndex: 1 }]);
    expect([...far.census().values()]).toEqual(['base', 'base']);
    // Cell 0,0's own masses come: the base draws 1,0 alone.
    far.land('0,0', cellMass(buildings.filter((b) => b.x < CELL).map((b) => massesOf(b, flat)!))!);
    far.syncBases();
    const cells = base.cells;
    expect(mesh().geometry.groups).toEqual([{ start: cells[8], count: cells[9], materialIndex: 0 }, { start: cells[10], count: cells[11], materialIndex: 1 }]);
    expect(Object.fromEntries(far.census())).toEqual({ '0,0': 'mass', '1,0': 'base' });
    // Shown in detail: still not under the base.
    far.setDetailed('0,0', true);
    far.syncBases();
    expect(far.census().get('0,0')).toBe('detail');
    // The budget lets go every level out of the view, never the base.
    far.choose(0, 0, m(500), 1000, 0.1, false, Infinity, null);
    expect(far.evictLevels(0)).toBe(0);
    expect(mesh().parent).not.toBeNull();
    far.dispose();
  });
});
