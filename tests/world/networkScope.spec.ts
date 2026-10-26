import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { m } from '@world/units';

/** THE NETWORK HOLDING SOME ROADS ALONE (`Network.scope`, the simulation's twin for the micro window): their ribbons and trims, junctions only where every road is held, and a move of the roads held (`rescope`) said in its changes like an edit's. */

function grid(n: number, side: number): { doc: RoadDoc; ids: NodeId[][] } {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: i * side, y: j * side }).id);
  }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, (i + j) % 3 === 0 ? 3 : 1);
    if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
  }
  return { doc, ids };
}

/** The roads whose both ends lie within `x1` along x. */
function roadsUpTo(doc: RoadDoc, x1: number): Set<SegmentId> {
  const out = new Set<SegmentId>();
  for (const seg of doc.segments.values()) {
    const a = doc.node(seg.a)!, b = doc.node(seg.b)!;
    if (a.x <= x1 && b.x <= x1) out.add(seg.id);
  }
  return out;
}

describe('a network holding some roads alone', () => {
  it('builds those roads and the junctions whose roads are all held, as the whole network builds them', () => {
    const { doc } = grid(4, m(140));
    const whole = new Network(doc);
    whole.rebuild();
    const net = new Network(doc);
    net.scope = roadsUpTo(doc, m(280));
    net.rebuild();
    expect(net.ribbons.size).toBe(net.scope.size);
    expect(net.ribbons.size).toBeLessThan(whole.ribbons.size);
    for (const id of net.ribbons.keys()) expect(net.holds(id)).toBe(true);
    for (const node of net.junctions.keys()) expect(net.complete(node), `junction ${node}`).toBe(true);
    // A node with a road outside the roads held has no junction, nor marks.
    for (const node of doc.nodes.values()) if (!net.complete(node.id)) { expect(net.junctions.has(node.id)).toBe(false); expect(net.squeezed.has(node.id)).toBe(false); }
    // Inside (both ends with their junctions): the same trims and junctions as the whole network's.
    for (const id of net.ribbons.keys()) {
      const seg = doc.segment(id)!;
      if (!net.complete(seg.a) || !net.complete(seg.b)) continue;
      expect(net.trims.get(id)).toEqual(whole.trims.get(id));
    }
    expect(net.exportBake(net.junctions.keys(), [])).toEqual(whole.exportBake(net.junctions.keys(), []));
  });

  it('moves the roads held: what left goes, what came is built, both named in its changes', () => {
    const { doc } = grid(4, m(140));
    const net = new Network(doc);
    net.scope = roadsUpTo(doc, m(280));
    net.rebuild();
    const before = net.state;
    const was = new Set(net.ribbons.keys());
    const next = new Set<SegmentId>();
    for (const seg of doc.segments.values()) { const a = doc.node(seg.a)!, b = doc.node(seg.b)!; if (a.x >= m(280) && b.x >= m(280)) next.add(seg.id); }
    net.rescope(next);
    expect(new Set(net.ribbons.keys())).toEqual(next);
    for (const node of net.junctions.keys()) expect(net.complete(node)).toBe(true);
    const delta = net.changesSince(before)!;
    expect(delta).not.toBeNull();
    for (const id of was) if (!next.has(id)) expect(delta.segments.has(id), `road ${id} left`).toBe(true);
    for (const id of next) if (!was.has(id)) expect(delta.segments.has(id), `road ${id} came`).toBe(true);
    // Moved back: the roads come back as the whole network has them.
    net.rescope(roadsUpTo(doc, m(280)));
    expect(new Set(net.ribbons.keys())).toEqual(was);
  });
});
