import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewCells } from '@world/viewCells';

/** A TRIM THAT CAN LET NOTHING GO IS NOT WALKED AGAIN (MISSION 1f): while the cells the view wants alone hold more than the budget, each
 *  frame's trim walked every held cell to let none go; now it walks again only once a cell, its bytes or the wanted cells changed. */

afterEach(() => vi.restoreAllMocks());

describe('view cells trim', () => {
  it('walks the held cells again only when what it may let go changed', () => {
    const cells = new ViewCells<number>({ name: 'test', version: 1, reach: 0, cpuBudget: 100, derive: (key) => ({ value: key, cpuBytes: 1000 }) });
    const [a, b, c] = [cells.cellAt(0, 0), cells.cellAt(300, 0), cells.cellAt(600, 0)];
    cells.want([a, b]);
    cells.pump();
    expect(cells.size).toBe(2);
    // Over the budget with wanted cells alone: a trim lets nothing go, and the next one does not walk them again.
    const walks = vi.spyOn(Map.prototype, 'keys');
    cells.trim(null);
    cells.want([a, b]);
    cells.trim(null);
    expect(walks).not.toHaveBeenCalled();
    expect(cells.size).toBe(2);

    // The view wants one of them alone: the other let go.
    cells.want([a]);
    cells.trim(null);
    expect(walks).toHaveBeenCalled();
    expect([...cells.keys()]).toEqual([a]);

    // A cell asked (held for the asking), then the trims to the budget: the asked one let go once, then nothing walked again.
    cells.ensure(c);
    walks.mockClear();
    cells.trim(null);
    expect(walks).toHaveBeenCalledTimes(1);
    expect([...cells.keys()]).toEqual([a]);
    walks.mockClear();
    cells.trim(null);
    expect(walks).not.toHaveBeenCalled();
    // A lower budget asked: walked again.
    cells.trim(null, 50);
    expect(walks).toHaveBeenCalledTimes(1);
  });
});
