import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlateFollow } from '@render/plateFollow';

/** THE PLATES SHOWN FOLLOWED WITHOUT REBUILDING WHAT STANDS (MISSION 2e): asked at every frame with the same array of parts, the follow reads
 *  each plate's revision and nothing else; another array (a plate came or left) is looked through for those gone, as before. */

afterEach(() => vi.restoreAllMocks());

describe('the plates followed at every frame', () => {
  it('rebuild nothing for the same parts, and still take a change and a plate gone', () => {
    const a = { revision: 1 }, b = { revision: 1 };
    const follow = new PlateFollow((s: { revision: number }) => s.revision);
    const took: unknown[] = [], left: unknown[] = [];
    const parts = [{ surface: a, cx: 0, cy: 0 }, { surface: b, cx: 1, cy: 0 }];
    const run = (list: typeof parts): number => follow.follow(list, (part) => { took.push(part.surface); }, (part) => { left.push(part.surface); });
    const first = run(parts);
    expect(took).toEqual([a, b]);
    const clears = vi.spyOn(Set.prototype, 'clear');
    for (let frame = 0; frame < 30; frame++) expect(run(parts)).toBe(first);
    expect(clears).not.toHaveBeenCalled();
    expect(took).toHaveLength(2);
    // A plate's own revision moved: taken again, the version moved.
    b.revision = 2;
    expect(run(parts)).toBe(first + 1);
    expect(took).toEqual([a, b, b]);
    // Another array without a plate: the one gone let go.
    expect(run([parts[0]!])).toBe(first + 2);
    expect(left).toEqual([b]);
  });
});
