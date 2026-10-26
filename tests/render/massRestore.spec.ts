import { describe, expect, it } from 'vitest';
import { createBuildingKit } from '@render/buildings/kit';
import { cellMass } from '@render/buildings/cellArrays';
import { createMassCells } from '@render/buildings/massCells';
import { massesOf } from './support/masses';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { CELL } from '@world/cells';

/** THE CELLS MADE AGAIN AFTER A LOST CONTEXT (`massCells.ts` dispose, `layer.ts` refill): at the levels the eye had chosen for them, not near and
 *  fine as a cell made before the eye is known - the hysteresis held those in detail. */

/** Five cells in a row east of the origin, each with a building's masses (`frameBudget.spec.ts` row). */
function landRow(cells: ReturnType<typeof createMassCells>): void {
  for (let i = 0; i < 5; i++) {
    const b = { ...JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)), id: i + 1, x: (i + 0.5) * CELL, y: CELL / 2, rotation: 0 } as Building;
    cells.land(`${i},0`, cellMass([massesOf(b, () => 0)!]));
  }
}

const levels = (cells: ReturnType<typeof createMassCells>): [boolean, boolean][] =>
  Array.from({ length: 5 }, (_, i) => [cells.near(`${i},0`), cells.fine(`${i},0`)]);

describe('the cells made again after a lost context', () => {
  // Seen from above at 10 px a metre: 0.3 m spans 3 px. At 6.5 the detail asks 3.25 px of a cell at its facade level, 2.76 of one in detail
  // (`HYSTERESIS`): a cell inside that margin keeps the level it had.
  const look = (cells: ReturnType<typeof createMassCells>): void => cells.choose(CELL / 2, CELL / 2, m(300), 1000, 10, false, Infinity);

  it('keep their facade level where the eye had left them at it', () => {
    const cells = createMassCells(createBuildingKit(), CELL);
    landRow(cells);
    cells.setErrorScale(7.4);
    look(cells);
    cells.setErrorScale(6.5);
    look(cells);
    const before = levels(cells);
    expect(before.every(([near, fine]) => near && !fine)).toBe(true);
    cells.dispose();
    landRow(cells);
    look(cells);
    expect(levels(cells)).toEqual(before);
    cells.dispose();
  });

  it('keep their detail where the eye had them in it', () => {
    const cells = createMassCells(createBuildingKit(), CELL);
    landRow(cells);
    look(cells);
    cells.setErrorScale(6.5);
    look(cells);
    const before = levels(cells);
    expect(before.every(([near, fine]) => near && fine)).toBe(true);
    cells.dispose();
    landRow(cells);
    look(cells);
    expect(levels(cells)).toEqual(before);
    cells.dispose();
  });
});
