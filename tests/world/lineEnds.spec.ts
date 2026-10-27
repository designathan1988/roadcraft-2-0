import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { PoleId } from '@world/ids';
import { acrossJunction } from '@world/lineEnds';
import { m } from '@world/units';

/** A line of poles through `points`, each strung to the next; its poles' ids. */
function line(doc: RoadDoc, points: readonly (readonly [number, number])[]): PoleId[] {
  const ids = points.map(([x, y]) => doc.addPole({ x: m(x), y: m(y) }, false).id);
  for (let i = 1; i < ids.length; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
  return ids;
}

describe('power lines carried across the junctions', () => {
  it('pairs the ends of two lines facing each other across a street, each the other one', () => {
    const doc = new RoadDoc();
    const west = line(doc, [[-90, 0], [-55, 0], [-20, 0]]);
    const east = line(doc, [[20, 0], [55, 0], [90, 0]]);
    expect(acrossJunction(doc, west[2]!)?.id).toBe(east[0]);
    expect(acrossJunction(doc, east[0]!)?.id).toBe(west[2]);
    // A pole inside a line, or the far end of a line facing nothing: none.
    expect(acrossJunction(doc, west[1]!)).toBeNull();
    expect(acrossJunction(doc, west[0]!)).toBeNull();
    // Nothing written to the map.
    expect(doc.spansAt(west[2]!).length).toBe(1);
  });

  it("pairs none for a T's stem, a bend, ends too far apart or too close", () => {
    const doc = new RoadDoc();
    const stem = line(doc, [[0, -90], [0, -55], [0, -20]]);
    line(doc, [[-60, 10], [-25, 10], [25, 10], [60, 10]]);
    const bend = line(doc, [[200, 0], [235, 0]]);
    line(doc, [[255, 20], [255, 55]]);
    const far = line(doc, [[400, 0], [435, 0]]);
    line(doc, [[600, 0], [635, 0]]);
    const broken = line(doc, [[800, 0], [835, 0]]);
    line(doc, [[840, 0], [875, 0]]);
    for (const id of [stem[2]!, bend[1]!, far[1]!, broken[1]!]) expect(acrossJunction(doc, id)).toBeNull();
  });
});
