import type { RoadDoc } from './doc';
import type { PoleId } from './ids';
import { m } from './units';
import { MAX_POLE_SPACING } from './utilities';

/**
 * THE POWER LINES CARRIED ACROSS THE STREETS THEY MEET: a line's last pole before a junction strung to the first pole of the line that
 * goes on straight beyond it, over the cross street, as a street's overhead lines run through its crossings. A street's run stops short of
 * each junction (`powerLine.ts`, its mouths and a setback) and was joined only where two streets meet end to end: at every crossing the
 * wires stopped on both sides of the street, nothing between them (the player, 2026-10-27).
 *
 * Only two line ends that face each other along one straight line are joined: each the end of its line (a pole of one span), the gap
 * between them on the line each one runs along, within a span's longest. A T's stem, a bend, a dead end stay as they are.
 */

/** How straight the gap must carry on each line: within 12 degrees. */
const STRAIGHT = Math.cos((12 * Math.PI) / 180);
/** No span shorter than this: two ends this close are one line broken, not a crossing. */
const SHORTEST = m(8);

/** A line's end: where it stands and the way its line runs out to it (from its one neighbour). */
interface LineEnd { readonly id: PoleId; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }

/** Every pair of facing line ends joined by a span; how many were strung. `ids`: the poles to look among (every pole of the map by default). */
export function joinLineEnds(doc: RoadDoc, ids: Iterable<PoleId> = doc.poles.keys()): number {
  // The ends, found by the index alone (no record read for a pole of two spans or more), filed in cells of a span's longest.
  const cell = MAX_POLE_SPACING;
  const ends: LineEnd[] = [];
  const byCell = new Map<string, LineEnd[]>();
  for (const id of ids) {
    const spans = doc.spanIdsAt(id);
    if (spans.length !== 1) continue;
    const span = doc.poleSpans.get(spans[0]!);
    const pole = doc.poles.get(id);
    if (!span || !pole) continue;
    const other = doc.poles.get(span.a === id ? span.b : span.a);
    if (!other) continue;
    const len = Math.hypot(pole.x - other.x, pole.y - other.y);
    if (len <= 0) continue;
    const end: LineEnd = { id, x: pole.x, y: pole.y, dx: (pole.x - other.x) / len, dy: (pole.y - other.y) / len };
    ends.push(end);
    const key = `${Math.floor(end.x / cell)},${Math.floor(end.y / cell)}`;
    const list = byCell.get(key);
    if (list) list.push(end); else byCell.set(key, [end]);
  }
  // Each end with every end facing it, shortest gaps first; each end joined once.
  const pairs: { readonly a: LineEnd; readonly b: LineEnd; readonly gap: number }[] = [];
  for (const a of ends) {
    const cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) {
      for (const b of byCell.get(`${i},${j}`) ?? []) {
        if (b.id <= a.id) continue;
        const vx = b.x - a.x, vy = b.y - a.y, gap = Math.hypot(vx, vy);
        if (gap < SHORTEST || gap > MAX_POLE_SPACING) continue;
        const ux = vx / gap, uy = vy / gap;
        // On a's line ahead of it, and on b's line ahead of b toward a.
        if (ux * a.dx + uy * a.dy < STRAIGHT || -(ux * b.dx + uy * b.dy) < STRAIGHT) continue;
        pairs.push({ a, b, gap });
      }
    }
  }
  pairs.sort((p, q) => p.gap - q.gap || p.a.id - q.a.id || p.b.id - q.b.id);
  const joined = new Set<PoleId>();
  let strung = 0;
  for (const { a, b } of pairs) {
    if (joined.has(a.id) || joined.has(b.id)) continue;
    joined.add(a.id);
    joined.add(b.id);
    if (doc.addPoleSpan(a.id, b.id)) strung++;
  }
  return strung;
}
