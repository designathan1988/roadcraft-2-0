import { describe, expect, it } from 'vitest';
import { type RepairStep, repairNearConnections, replayRepairs } from '@editor/repair';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';

/** THE REPAIRS OF A LEGACY MAP MADE OFF THE PAGE AND PLAYED AGAIN HERE (`editor/repair.ts`): the same map, the same steps, the same roads. */

/** A map with two dead ends that visibly end inside other roads: a street across, two stubs reaching it from either side. */
function legacy(): RoadDoc {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: m(300), y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const c = doc.addNode({ x: m(100), y: m(80) }), d = doc.addNode({ x: m(100), y: m(0.4) });
  doc.addSegment(c.id, d.id, 1);
  const e = doc.addNode({ x: m(200), y: -m(80) }), f = doc.addNode({ x: m(200), y: -m(0.3) });
  doc.addSegment(e.id, f.id, 1);
  return doc;
}

describe('the repairs played again', () => {
  it('make the map the direct repair makes, step for step', () => {
    const direct = legacy();
    const directNet = new Network(direct);
    directNet.rebuild();
    const steps: RepairStep[] = [];
    const made = repairNearConnections(direct, directNet, steps);
    expect(made).toBe(2);
    expect(steps.length).toBe(2);
    const again = legacy();
    const againNet = new Network(again);
    againNet.rebuild();
    expect(replayRepairs(again, againNet, structuredClone(steps))).toBe(2);
    expect(again.toJSON()).toEqual(direct.toJSON());
    // A step whose dead end is not as it was (the map edited meanwhile) is left out; the steps before it stand.
    const edited = legacy();
    const editedNet = new Network(edited);
    editedNet.rebuild();
    edited.removeSegment(edited.node(steps[1]!.node)!.incident[0]!);
    expect(replayRepairs(edited, editedNet, steps)).toBe(1);
  });
});
