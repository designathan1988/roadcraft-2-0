import { describe, expect, it } from 'vitest';
import { KEEP_CELL, keepCellKey } from '@render/candidateKeep';
import { CellKeeps } from '@render/cellKeeps';

/** THE WAITING CELLS RANKED ONCE A FOCUS (MISSION 1f): `settle` tests the blocks nearest the focus first, and ranks them again only when the focus
 *  moved or a block came, never at every frame of a still view. */

type Place = { readonly x: number; readonly y: number };
const placeIn = (i: number, j: number): Place => ({ x: (i + 0.5) * KEEP_CELL, y: (j + 0.5) * KEEP_CELL });

describe('cell keeps ranking', () => {
  it('ranks the waiting blocks once while the focus stands, nearest first, and again only when it moves or a block comes', () => {
    const keeps = new CellKeeps<Place>(() => 0);
    // Three cells, one a block (ten keep cells a side), far apart along x.
    for (const i of [0, 25, 55]) keeps.fill(keepCellKey(i, 0), [placeIn(i, 0)]);
    const near55 = { x: 55.5 * KEEP_CELL, y: 0 };
    const tested: number[] = [];
    // A deadline already past: one cell a call, as a frame with no time left tests one.
    for (let frame = 0; frame < 3; frame++) {
      keeps.settle(near55.x, near55.y, 0);
      tested.push(...[...keeps.cellKeys()].filter((k) => !tested.includes(k)));
    }
    expect(tested).toEqual([keepCellKey(55, 0), keepCellKey(25, 0), keepCellKey(0, 0)]);
    expect(keeps.rankings).toBe(1);

    // Still: nothing waits, nothing ranked.
    keeps.settle(near55.x, near55.y, 0);
    expect(keeps.rankings).toBe(1);

    // Two blocks come: ranked again once for them, then the still focus ranks nothing more.
    keeps.fill(keepCellKey(3, 0), [placeIn(3, 0)]);
    keeps.fill(keepCellKey(40, 0), [placeIn(40, 0)]);
    keeps.settle(near55.x, near55.y, 0);
    expect(keeps.rankings).toBe(2);
    expect(keeps.waits).toBe(true);
    keeps.settle(near55.x, near55.y, 0);
    expect(keeps.rankings).toBe(2);
    expect(keeps.waits).toBe(false);
    expect([...keeps.cellKeys()].slice(-2)).toEqual([keepCellKey(40, 0), keepCellKey(3, 0)]);

    // The focus moved to the other end: what waits there tested first.
    keeps.fill(keepCellKey(1, 0), [placeIn(1, 0)]);
    keeps.fill(keepCellKey(50, 0), [placeIn(50, 0)]);
    keeps.settle(0, 0, 0);
    expect(keeps.rankings).toBe(3);
    expect(keeps.standingIn(keepCellKey(1, 0))).toHaveLength(1);
    expect(keeps.standingIn(keepCellKey(50, 0))).toHaveLength(0);
  });
});
