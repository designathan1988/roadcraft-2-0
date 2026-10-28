import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { m } from '@world/units';

/** AN EDIT'S REBUILD DOES NOT WALK THE ROADS HELD (MISSION 1f): with the same scope as at the last rebuild, only the roads the edit reached are
 *  looked at; a new scope (the window moved) is compared whole, and the network built either way is the whole network's there. */

function grid(n: number, side: number): { doc: RoadDoc; ids: NodeId[][] } {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: i * side, y: j * side }).id);
  }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, 1);
    if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
  }
  return { doc, ids };
}

afterEach(() => vi.restoreAllMocks());

describe('a scoped network\'s rebuild', () => {
  it('looks at the roads an edit reached, not every road held, and builds what the whole network builds', () => {
    // 840 roads held; the edit reaches a handful round one node.
    const { doc, ids } = grid(20, m(140));
    const scoped = new Network(doc);
    scoped.scope = new Set(doc.segments.keys() as Iterable<SegmentId>);
    scoped.rebuild();
    const whole = new Network(doc);
    whole.rebuild();

    // One node moved: the scope stands.
    doc.moveNode(ids[10]![10]!, { x: 10 * m(140) + m(8), y: 10 * m(140) + m(5) });
    const scope = scoped.scope;
    let asked = 0;
    const has = Set.prototype.has;
    vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value: unknown) {
      if (this === scope) asked++;
      return has.call(this, value);
    });
    scoped.rebuild();
    vi.restoreAllMocks();
    // The roads the edit reached asked whether they are held (`holds`, `complete`, a few hundred times), not every road of the scope again.
    expect(asked).toBeLessThan(scope.size / 2);
    whole.rebuild();
    for (const [id, ribbon] of whole.ribbons) {
      expect(scoped.trims.get(id), `road ${id}`).toEqual(whole.trims.get(id));
      expect(scoped.ribbons.get(id)?.full.length, `road ${id}`).toBe(ribbon.full.length);
    }
    expect([...scoped.junctions.keys()].sort()).toEqual([...whole.junctions.keys()].sort());
  });
});
