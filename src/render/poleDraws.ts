import { wireTemplate, wireTemplateOf } from './utilities';

/** What the pole stores (`poleStores.ts`) draw their colour pass with: the draws a store's pieces and wires are split into, and the box their
 *  view bounds every piece's pixels by. */

/** A box holding nothing (three's axes: x0, y0, z0, x1, y1, z1), grown by `holdSphere`. */
export const noBox = (): Float64Array => Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
/** `box` grown to hold the sphere at (`x`, `y`, `z`) of `r`. */
export function holdSphere(box: Float64Array, x: number, y: number, z: number, r: number): void {
  box[0] = Math.min(box[0]!, x - r); box[1] = Math.min(box[1]!, y - r); box[2] = Math.min(box[2]!, z - r);
  box[3] = Math.max(box[3]!, x + r); box[4] = Math.max(box[4]!, y + r); box[5] = Math.max(box[5]!, z + r);
}

/** The triangles a shape's own draw must spare to be drawn apart: a draw call costs the CPU more than a few hundred triangles cost the GPU,
 *  so a shape that spares fewer has its pieces drawn with the finest shape drawn anyway (more detail, never less, one draw fewer). */
const DRAW_WORTH = 2048;

/** Which shape each shape's pieces are drawn with (`counts`: the pieces each would hold, finest first; `triangles`: each one's a piece): at
 *  most two draws - the near pieces at the finest shape any needs, the far ones at the finest shape they need - split where it spares the
 *  most, and only when it spares a draw's worth (`DRAW_WORTH`); else every piece at the finest shape any needs (more detail, never less). */
export function drawnShapes(counts: readonly number[], triangles: readonly number[]): number[] {
  const into = counts.map((_, k) => k);
  const finest = counts.findIndex((n) => n > 0);
  if (finest < 0) return into;
  let best = 0, split = counts.length;
  for (let s = finest + 1; s < counts.length; s++) {
    const host = counts.findIndex((n, k) => k >= s && n > 0);
    if (host < 0) break;
    let spared = 0;
    for (let k = s; k < counts.length; k++) spared += counts[k]! * (triangles[finest]! - triangles[host]!);
    if (spared > best) { best = spared; split = s; }
  }
  const farHost = best >= DRAW_WORTH ? counts.findIndex((n, k) => k >= split && n > 0) : finest;
  for (let k = finest; k < counts.length; k++) into[k] = k < split || best < DRAW_WORTH ? finest : farHost;
  return into;
}

/** The template that draws every wire of a set of templates within a pixel: as many chords as any, creased if any is. */
function hostOf(templates: readonly number[]): number {
  let chords = 0, creased = false;
  for (const t of templates) { const a = wireTemplate(t); chords = Math.max(chords, a.chords); creased ||= a.creased; }
  return wireTemplateOf(chords, creased);
}

/** Which template each template's wires are drawn with (`wanted`: the wires each would hold): at most two draws - the near wires with the
 *  template that serves them all, the far ones with the one that serves them - split where it spares the most triangles, and only when it
 *  spares a draw's worth (`DRAW_WORTH`); never a template with fewer chords or no crease where a wire needs them. */
export function drawnTemplates(wanted: readonly number[]): number[] {
  const into = wanted.map((_, t) => t);
  const used = wanted.map((n, t) => (n > 0 ? t : -1)).filter((t) => t >= 0).sort((a, b) => wireTemplate(b).triangles - wireTemplate(a).triangles);
  if (used.length === 0) return into;
  const all = hostOf(used), allTriangles = wireTemplate(all).triangles;
  let best = 0, split = used.length, farHost = all;
  for (let s = 1; s < used.length; s++) {
    const far = used.slice(s), host = hostOf(far);
    const spared = far.reduce((sum, t) => sum + wanted[t]! * (allTriangles - wireTemplate(host).triangles), 0);
    if (spared > best) { best = spared; split = s; farHost = host; }
  }
  used.forEach((t, k) => { into[t] = best >= DRAW_WORTH && k >= split ? farHost : all; });
  return into;
}
