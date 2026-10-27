import type { RoadDoc } from './doc';
import type { PoleId, SpanId } from './ids';
import { m } from './units';
import { MAX_POLE_SPACING } from './utilities';

/**
 * THE POWER LINES CARRIED ACROSS THE STREETS THEY MEET: a line's last pole before a junction and the first pole of the line that goes on
 * straight beyond it, strung over the cross street as a street's overhead lines run through its crossings. A street's run stops short of
 * each junction (`powerLine.ts`, its mouths and a setback): at every crossing the wires stopped on both sides of the street, nothing between
 * them (the player, 2026-10-27).
 *
 * Asked of one line end at a time, in the poles round it alone (`RoadDoc.polesIn`): what the pole blocks draw (`poleCells.ts`), nothing
 * written to the map. DO NOT look for them over the whole map: walking every pole of the 10 km city on the page at each opening was work
 * as large as the map, for wires seen where the view is.
 *
 * Two line ends face each other when each is the end of its line (a pole of one span), the gap between them runs on along the line each
 * one ends, within a span's longest, and each is the other's nearest such end. A T's stem, a bend, a dead end face none.
 */

/** How straight the gap must carry on each line: within 12 degrees. */
const STRAIGHT = Math.cos((12 * Math.PI) / 180);
/** No span shorter than this: two ends this close are one line broken, not a crossing. */
const SHORTEST = m(8);

/** A line's end: where it stands, the way its line runs out to it (from its one neighbour), its one span. */
interface LineEnd { readonly id: PoleId; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number; readonly span: SpanId }

/** The pole `id` as the end of its line, or null when it is not one. */
export function lineEnd(doc: RoadDoc, id: PoleId): LineEnd | null {
  const spans = doc.spanIdsAt(id);
  if (spans.length !== 1) return null;
  const span = doc.poleSpans.get(spans[0]!);
  const pole = doc.poles.get(id);
  if (!span || !pole) return null;
  const other = doc.poles.get(span.a === id ? span.b : span.a);
  if (!other) return null;
  const len = Math.hypot(pole.x - other.x, pole.y - other.y);
  return len > 0 ? { id, x: pole.x, y: pole.y, dx: (pole.x - other.x) / len, dy: (pole.y - other.y) / len, span: span.id } : null;
}

/** The nearest line end facing `a` across the gap its line runs on into, or null. */
function nearestFacing(doc: RoadDoc, a: LineEnd): LineEnd | null {
  let best: LineEnd | null = null, bestGap = Infinity;
  for (const pole of doc.polesIn([a.x - MAX_POLE_SPACING, a.y - MAX_POLE_SPACING, a.x + MAX_POLE_SPACING, a.y + MAX_POLE_SPACING])) {
    if (pole.id === a.id) continue;
    const vx = pole.x - a.x, vy = pole.y - a.y, gap = Math.hypot(vx, vy);
    if (gap < SHORTEST || gap > MAX_POLE_SPACING || gap > bestGap) continue;
    const ux = vx / gap, uy = vy / gap;
    if (ux * a.dx + uy * a.dy < STRAIGHT) continue;
    const b = lineEnd(doc, pole.id);
    // On b's own line ahead of it, toward a.
    if (!b || -(ux * b.dx + uy * b.dy) < STRAIGHT) continue;
    if (gap === bestGap && best && b.id > best.id) continue;
    best = b;
    bestGap = gap;
  }
  return best;
}

/** The line end the pole `id` is strung to across the junction its line stops at (each the other's nearest facing end), or null. */
export function acrossJunction(doc: RoadDoc, id: PoleId): LineEnd | null {
  const a = lineEnd(doc, id);
  if (!a) return null;
  const b = nearestFacing(doc, a);
  return b && nearestFacing(doc, b)?.id === a.id ? b : null;
}
