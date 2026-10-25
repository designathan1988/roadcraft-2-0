import { describe, expect, it } from 'vitest';

import { RoadDoc, type SegmentDirection } from '@world/doc';
import { Network } from '@world/network';
import { segmentAlongPaint } from '@world/markings';
import { LANE_LINE, laneWidth, roadType } from '@world/roadTypes';

/** YELLOW MEANS ONCOMING TRAFFIC. The lines along a road as the carriageway's shader draws them (`segmentAlongPaint`, `render/roadPaint.ts`). */

function paint(type: number, direction: SegmentDirection) {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -300, y: 0 });
  const b = doc.addNode({ x: 300, y: 0 });
  const segment = doc.addSegment(a.id, b.id, type, null, 0, direction)!;
  const net = new Network(doc);
  net.rebuild();
  const ribbon = net.ribbons.get(segment.id)!;
  const along = segmentAlongPaint(ribbon, 0);
  expect(along, 'the road paints lines along it').not.toBeNull();
  // Painted along the whole road: a free road has no stop line to start from.
  expect(along!.to - along!.from).toBeCloseTo(ribbon.full.length, 6);
  return along!.lines;
}

/** The offsets across the road, sorted. */
const offsets = (lines: readonly { offset: number }[]): number[] => lines.map((l) => l.offset).sort((p, q) => p - q);

describe('lane lines', () => {
  it('paints a one-way street white, with no centre line', () => {
    const yellow = roadType(1).line;
    const lines = paint(1, 'aToB');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((s) => s.color === LANE_LINE)).toBe(true);
    expect(lines.some((s) => s.color === yellow)).toBe(false);
    // Between its lanes: one line a lane past the first, from its right edge.
    const rt = roadType(1);
    const lw = laneWidth(rt);
    const between = Array.from({ length: rt.lanes - 1 }, (_, i) => -rt.width / 2 + rt.parkingRight + lw * (i + 1));
    expect(offsets(lines)).toEqual(between.sort((p, q) => p - q));
  });

  it('keeps the yellow centre line of a two-way street', () => {
    const lines = paint(1, 'both');
    expect(lines.map((s) => s.color)).toEqual([roadType(1).line]);
    // On the road's middle, broken: a lane change into the oncoming lane allowed.
    expect(lines[0]!.offset).toBeCloseTo(0, 9);
    expect(lines[0]!.dashed).toBe(true);
  });

  it('separates an avenue\'s directions in its class colour and its lanes in white', () => {
    const lines = paint(2, 'both');
    const centre = lines.filter((s) => !s.dashed);
    const dividers = lines.filter((s) => s.dashed);
    expect(centre.map((s) => s.color)).toEqual([roadType(2).line]);
    expect(centre[0]!.offset).toBeCloseTo(0, 9);
    expect(dividers.length).toBe(2);
    expect(dividers.every((s) => s.color === LANE_LINE)).toBe(true);
    // One each way, a lane out from the middle.
    const lw = laneWidth(roadType(2));
    const [left, right] = offsets(dividers);
    expect(left).toBeCloseTo(-lw, 9);
    expect(right).toBeCloseTo(lw, 9);
  });
});
