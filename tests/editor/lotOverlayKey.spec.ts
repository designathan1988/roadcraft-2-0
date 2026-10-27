import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, lotCentre, planLots, zoneLots } from '@world/lots';
import { LotTool } from '@editor/lotTool';

/** A town of one street with its lots (`half`: its half length), and the Zoning tool over it. */
function street(half = m(120)): { doc: RoadDoc; tool: LotTool } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -half, y: 0 }).id, b = doc.addNode({ x: half, y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  const tool = new LotTool({
    doc, net, zoom: () => 1,
    settings: () => ({ mode: 'brush', use: 'residential', density: 'low', eraser: false, splitKind: 'grid', splitParts: 2 } as never),
    mutate: (fn) => { fn(); },
    hint: () => {},
    redraw: () => {},
    plan: async () => planLots(doc, net),
  });
  return { doc, tool };
}

const lotGroups = (names: Iterable<string>): string[] => [...names].filter((name) => name.startsWith('l'));

/** THE LOTS OVERLAY IS NOT MADE AGAIN ON EVERY FRAME, NOR WHOLE WHEN ONE LOT CHANGES. */
describe('the lots overlay', () => {
  it('with the other tools, keeps its groups while the lots stand, and makes again only the lot that changed', () => {
    const { doc, tool } = street();
    expect(doc.lots.length).toBeGreaterThan(3);
    expect(tool.anyZoned()).toBe(false);
    const reader = {};

    zoneLots(doc, [doc.lots[0]!.id, doc.lots[1]!.id], { use: 'residential', density: 'low' });
    expect(tool.anyZoned()).toBe(true);
    const book = tool.overlay(false);
    expect(lotGroups(book.groups.keys())).toHaveLength(2);
    // A new reader is told everything once.
    expect(book.changedFor(reader)).toBeNull();
    // Frames go by: nothing made again.
    expect(tool.overlay(false)).toBe(book);
    expect([...book.changedFor(reader)!]).toEqual([]);

    zoneLots(doc, [doc.lots[2]!.id], { use: 'commercial', density: 'low' });
    tool.overlay(false);
    expect(lotGroups(book.changedFor(reader)!)).toEqual([`l${doc.lots[2]!.id}`]);
    expect(lotGroups(book.groups.keys())).toHaveLength(3);
  });

  it('in the Zoning tool, makes again only the lots the pointer and the edits reach', async () => {
    const { doc, tool } = street();
    // The proposal of the street land is worked out first.
    await tool.advanceProposal();
    const reader = {};
    const book = tool.overlay(true);
    // Every lot is drawn in the tool.
    expect(lotGroups(book.groups.keys())).toHaveLength(doc.lots.length);
    expect(book.changedFor(reader)).toBeNull();
    tool.overlay(true);
    expect([...book.changedFor(reader)!]).toEqual([]);

    // The pointer over a lot: that lot alone (lit under the brush).
    const lot = doc.lots[0]!;
    tool.hover = lotCentre(lot);
    tool.overlay(true);
    expect(lotGroups(book.changedFor(reader)!)).toEqual([`l${lot.id}`]);
    tool.overlay(true);
    expect([...book.changedFor(reader)!]).toEqual([]);

    // One lot zoned: its group, not every lot's.
    zoneLots(doc, [doc.lots[1]!.id], { use: 'residential', density: 'low' });
    tool.overlay(true);
    const changed = lotGroups(book.changedFor(reader)!);
    expect(changed).toContain(`l${doc.lots[1]!.id}`);
    expect(changed.length).toBeLessThan(doc.lots.length);
  });
});

/** Two streets 3 km apart, their lots zoned, and the Zoning tool over them. */
function twoStreets(): { doc: RoadDoc; tool: () => LotTool } {
  const doc = new RoadDoc();
  for (const x0 of [0, 3000]) {
    const a = doc.addNode({ x: m(x0 - 120), y: 0 }).id, b = doc.addNode({ x: m(x0 + 120), y: 0 }).id;
    doc.addSegment(a, b, 1);
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use: 'residential', density: 'low' });
  const tool = (): LotTool => new LotTool({
    doc, net, zoom: () => 1,
    settings: () => ({ mode: 'brush', use: 'residential', density: 'low', eraser: false, splitKind: 'grid', splitParts: 2 } as never),
    mutate: (fn) => { fn(); },
    hint: () => {},
    redraw: () => {},
    plan: async () => planLots(doc, net),
  });
  return { doc, tool };
}

describe('the lots overlay for the ground the view sees', () => {
  it('makes the groups of the lots in view alone, as the whole overlay makes them, and follows the view', () => {
    const { doc, tool } = twoStreets();
    const whole = tool().overlay(false);
    const windowed = tool();
    const near = (x0: number): number[] => doc.lots.filter((l) => Math.abs(lotCentre(l).x - m(x0)) < m(400)).map((l) => l.id);
    const first = near(0), second = near(3000);
    expect(first.length).toBeGreaterThan(3);
    expect(second.length).toBeGreaterThan(3);
    const at = (x0: number): [number, number, number, number] => [m(x0 - 200), m(-200), m(x0 + 200), m(200)];
    let book = windowed.overlay(false, at(0));
    expect(lotGroups(book.groups.keys()).sort()).toEqual(first.map((id) => `l${id}`).sort());
    for (const id of first) expect(JSON.stringify(book.groups.get(`l${id}`))).toBe(JSON.stringify(whole.groups.get(`l${id}`)));
    // The view moved to the other street: its lots drawn, the first street's let go.
    book = windowed.overlay(false, at(3000));
    expect(lotGroups(book.groups.keys()).sort()).toEqual(second.map((id) => `l${id}`).sort());
    for (const id of second) expect(JSON.stringify(book.groups.get(`l${id}`))).toBe(JSON.stringify(whole.groups.get(`l${id}`)));
    // A view of both: every lot, as the whole overlay.
    book = windowed.overlay(false, [m(-300), m(-300), m(3300), m(300)]);
    expect(lotGroups(book.groups.keys()).sort()).toEqual(lotGroups(whole.groups.keys()).sort());
  });

  it('drawn over a window the view moves, holds the lots a window opened where the view stopped holds', () => {
    const { doc, tool } = street(m(2400));
    zoneLots(doc, doc.lots.map((l) => l.id), { use: 'residential', density: 'low' });
    const view = (x: number): [number, number, number, number] => [x - m(300), m(-300), x + m(300), m(300)];
    // The view walked along the street a step at a time, back a little, and still for a frame.
    let book = tool.overlay(false, view(m(-2000)));
    for (const x of [-1700, -1200, -1250, -600, 0, 0, 700, 1300]) book = tool.overlay(false, view(m(x)));
    const moved = lotGroups(book.groups.keys()).filter((name) => book.groups.get(name)).sort();
    const fresh = street(m(2400));
    zoneLots(fresh.doc, fresh.doc.lots.map((l) => l.id), { use: 'residential', density: 'low' });
    const opened = fresh.tool.overlay(false, view(m(1300)));
    const there = lotGroups(opened.groups.keys()).filter((name) => opened.groups.get(name)).sort();
    expect(there.length).toBeGreaterThan(10);
    // Every lot the window opened there draws, and those of the cells it came over still kept (within 500 m of the view, `WINDOW_KEEP`): no more.
    for (const name of there) expect(moved).toContain(name);
    const kept: [number, number, number, number] = [m(1300) - m(800), m(-800), m(1300) + m(800), m(800)];
    const cell = m(250);
    for (const name of moved) {
      const lot = doc.lots.find((l) => `l${l.id}` === name)!;
      const xs = lot.corners.map((c) => c.x);
      // Its box meets a cell of the range kept.
      expect(Math.floor(Math.max(...xs) / cell)).toBeGreaterThanOrEqual(Math.floor(kept[0] / cell));
      expect(Math.floor(Math.min(...xs) / cell)).toBeLessThanOrEqual(Math.floor(kept[2] / cell));
    }
    expect(moved.length).toBeGreaterThan(there.length);
  });
});
