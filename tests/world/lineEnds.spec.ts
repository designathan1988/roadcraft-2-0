import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { PoleId } from '@world/ids';
import { joinLineEnds } from '@world/lineEnds';
import { m } from '@world/units';

/** A line of poles through `points`, each strung to the next; its poles' ids. */
function line(doc: RoadDoc, points: readonly (readonly [number, number])[]): PoleId[] {
  const ids = points.map(([x, y]) => doc.addPole({ x: m(x), y: m(y) }, false).id);
  for (let i = 1; i < ids.length; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
  return ids;
}
const joined = (doc: RoadDoc, a: PoleId, b: PoleId): boolean => doc.spansAt(a).some((s) => s.a === b || s.b === b);

describe('power lines carried across the junctions', () => {
  it('strings the ends of two lines facing each other across a street, once', () => {
    const doc = new RoadDoc();
    const west = line(doc, [[-90, 0], [-55, 0], [-20, 0]]);
    const east = line(doc, [[20, 0], [55, 0], [90, 0]]);
    expect(joinLineEnds(doc)).toBe(1);
    expect(joined(doc, west[2]!, east[0]!)).toBe(true);
    // The ends joined are ends no more: nothing more to string.
    expect(joinLineEnds(doc)).toBe(0);
  });

  it("leaves a T's stem, a bend and two ends too far apart or too close as they are", () => {
    const doc = new RoadDoc();
    // A stem ending at a street that runs across it: no line beyond it.
    line(doc, [[0, -90], [0, -55], [0, -20]]);
    line(doc, [[-60, 10], [-25, 10], [25, 10], [60, 10]]);
    // A line turning a corner: its ends at right angles.
    line(doc, [[200, 0], [235, 0]]);
    line(doc, [[255, 20], [255, 55]]);
    // Farther apart than a span's longest.
    line(doc, [[400, 0], [435, 0]]);
    line(doc, [[600, 0], [635, 0]]);
    // A broken line: its ends a few metres apart.
    line(doc, [[800, 0], [835, 0]]);
    line(doc, [[840, 0], [875, 0]]);
    expect(joinLineEnds(doc)).toBe(0);
  });
});
