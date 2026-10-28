import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveTargetCount, liveTargets } from '@render/targetBytes';

/** THE LIVE RENDER TARGETS COUNTED WITH NO LIST MADE (MISSION 2f): the frame compares the count of the targets three made a framebuffer for;
 *  the count is the live list's length, and making it makes no array. */

afterEach(() => vi.restoreAllMocks());

describe('the live render targets counted each frame', () => {
  it('count as the live list does, with no array made', () => {
    const drawn = { name: 'drawn' }, never = { name: 'never' }, again = { name: 'again' };
    const made = new Map<object, { __webglFramebuffer?: unknown }>([[drawn, { __webglFramebuffer: {} }], [never, {}], [again, { __webglFramebuffer: {} }]]);
    const properties = { get: (o: object): unknown => made.get(o) ?? {} };
    const targets = [drawn, never, again];
    expect(liveTargets(targets, properties)).toEqual([drawn, again]);
    const filters = vi.spyOn(Array.prototype, 'filter');
    expect(liveTargetCount(targets, properties)).toBe(2);
    expect(filters).not.toHaveBeenCalled();
    // A target drawn into for the first time: counted.
    made.set(never, { __webglFramebuffer: {} });
    expect(liveTargetCount(targets, properties)).toBe(3);
  });
});
