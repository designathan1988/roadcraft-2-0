import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { RoadTop } from '@editor/roadTop';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';
import { tileIdBase, tileKey } from '@world/tiles';

/** The highest road over a rectangle of the map (`editor/roadTop.ts`) */
function town(streets = 12): { doc: RoadDoc; net: Network; top: RoadTop; ids: number[] } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  // Short streets spread over a few kilometres: many cells apart.
  const ids: number[] = [];
  for (let k = 0; k < streets; k++) {
    const x = m(-3000 + (k % 12) * 500), y = m(((k % 3) - 1) * 1500 + Math.floor(k / 12) * 4000);
    const a = doc.addNode({ x, y }, m(k % 12));
    const b = doc.addNode({ x: x + m(80), y }, m(k % 12));
    doc.addSegment(a.id, b.id, 1);
    ids.push(a.id, b.id);
  }
  net.rebuild();
  // The solved height: the node's own authored height at that point.
  const heightAt = (x: number, y: number): number => {
    for (const node of doc.nodes.values()) if (node.x === x && node.y === y) return node.heightOffset;
    return 0;
  };
  return { doc, net, top: new RoadTop(doc, net, heightAt), ids };
}

/** A rectangle over every street of `town`. */
const ALL: ChangeRect = [m(-3100), m(-1600), m(3100), m(1600)];

/** The highest node on a road (a node left without roads is not drawn) of those standing in `rect`. */
const highest = (doc: RoadDoc, rect: ChangeRect = ALL): number => Math.ceil(Math.max(...[...doc.nodes.values()]
  .filter((n) => n.incident.length > 0 && n.x >= rect[0] && n.x <= rect[2] && n.y >= rect[1] && n.y <= rect[3]).map((n) => n.heightOffset)));

describe('the highest road', () => {
  it('is the highest node of the rectangle at first, and after each edit only the cells it reached are read', () => {
    const { doc, net, top, ids } = town();
    expect(top.heightIn(ALL)).toBe(highest(doc));
    const cellsAtFirst = top.lastComputes;
    expect(cellsAtFirst).toBeGreaterThan(6);

    // A far, low node raised over everything.
    doc.setNodeHeightOffset(ids[0] as never, m(40));
    net.rebuild();
    expect(top.heightIn(ALL)).toBe(highest(doc));
    expect(top.lastComputes).toBeLessThanOrEqual(4);

    // The highest street taken away: the top falls to the next.
    const highestSegment = doc.requireNode(ids[0] as never).incident[0]!;
    // (`pruneOrphanNodes` writes the whole map in the diary: not used here.)
    doc.removeSegment(highestSegment);
    net.rebuild();
    expect(top.heightIn(ALL)).toBe(highest(doc));
    expect(top.lastComputes).toBeLessThanOrEqual(4);

    // Nothing changed: nothing read.
    expect(top.heightIn(ALL)).toBe(highest(doc));
    expect(top.lastComputes).toBe(0);
  });

  it('reads only the cells the rectangle reaches, however large the map (MISSION.md item 5)', () => {
    // One street's rectangle, in a town of 12 streets and in one of 1,200.
    const one: ChangeRect = [m(-3000), m(-1500), m(-2900), m(-1490)];
    const read = (streets: number): { top: number; cells: number } => {
      const { top } = town(streets);
      return { top: top.heightIn(one), cells: top.lastComputes };
    };
    const small = read(12), large = read(1200);
    expect(small.top).toBe(0);
    expect(large).toEqual(small);
    expect(small.cells).toBeLessThanOrEqual(2);
  });

  it('starts again from nothing when the document is replaced', () => {
    const { doc, net, top } = town();
    top.heightIn(ALL);
    const fresh = new RoadDoc();
    const a = fresh.addNode({ x: 0, y: 0 }, m(3));
    const b = fresh.addNode({ x: m(50), y: 0 }, m(3));
    fresh.addSegment(a.id, b.id, 1);
    doc.replaceWith(fresh);
    net.rebuild();
    expect(top.heightIn(ALL)).toBe(highest(doc));
  });
});

describe('the highest road in a loaded tile', () => {
  it('follows roads that take the tile\'s ids', () => {
    const key = tileKey(0, 0), base = tileIdBase(key);
    const doc = new RoadDoc();
    doc.loadTile({
      key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [],
      lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
      next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
    });
    const net = new Network(doc);
    const heightAt = (x: number, y: number): number => {
      for (const node of doc.nodes.values()) if (node.x === x && node.y === y) return node.heightOffset;
      return 0;
    };
    const top = new RoadTop(doc, net, heightAt);
    const a = doc.addNode({ x: m(200), y: m(500) }, m(3));
    const b = doc.addNode({ x: m(300), y: m(500) }, m(3));
    const seg = doc.addSegment(a.id, b.id, 1)!;
    expect(seg.id).toBeGreaterThanOrEqual(base);
    net.rebuild();
    expect(top.heightIn(ALL)).toBe(highest(doc));
    doc.setNodeHeightOffset(a.id, m(30));
    net.rebuild();
    expect(top.heightIn(ALL)).toBe(highest(doc));
  });
});
