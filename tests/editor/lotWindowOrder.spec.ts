import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { LotTool } from '@editor/lotTool';

/** THE LOTS' WINDOW FILLED NEAREST FIRST WITHOUT SORTING ITS QUEUE AT EVERY FRAME (MISSION 1f): while the view stands and cells wait, the
 *  order made once is followed frame after frame; the lots drawn at the end are those a window filled at once draws. */

function zonedStreet(): { doc: RoadDoc; tool: () => LotTool } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-2400), y: 0 }).id, b = doc.addNode({ x: m(2400), y: 0 }).id;
  doc.addSegment(a, b, 1);
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

const drawn = (tool: LotTool, view: [number, number, number, number] | null): string[] =>
  [...tool.overlay(false, view).groups.keys()].filter((name) => name.startsWith('l')).sort();

afterEach(() => vi.restoreAllMocks());

describe('the lots\' window', () => {
  it('orders its waiting cells once while the view stands, and ends with the lots a window filled at once draws', () => {
    const { tool } = zonedStreet();
    // The view takes in the whole street: its window holds every lot, as the overlay with no window draws them.
    const view: [number, number, number, number] = [m(-2400), m(-300), m(2400), m(300)];
    const whole = drawn(tool(), null);
    expect(whole.length).toBeGreaterThan(20);

    // A page clock that runs out after a few cells a frame: the window filled over many frames.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 0.4));
    const sort = Array.prototype.sort;
    let orderings = 0;
    vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare?: (a: never, b: never) => number) {
      if (compare && /a\[0\] - b\[0\]/.test(compare.toString())) orderings++;
      return sort.call(this, compare as never);
    });
    const slow = tool();
    let frames = 0;
    let last: string[] = [];
    for (; frames < 200; frames++) {
      const now = drawn(slow, view);
      if (frames > 0 && now.length === last.length && now.length === whole.length) break;
      last = now;
    }
    expect(frames).toBeGreaterThan(3);
    expect(orderings).toBe(1);
    expect(last).toEqual(whole);
  });
});
