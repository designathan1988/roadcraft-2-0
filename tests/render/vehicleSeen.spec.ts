import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';

import { joinSoups, seenTriangles, soupOf, type Soup } from '@render/vehicleSeen';
import { withoutHidden } from '@render/vehicleHidden';
import { buildBusModel } from '@render/vehicleModels';
import { archetypeById } from '@sim/vehicles/archetypes';

/** A box's triangles, wound outwards (or inwards). */
const box = (sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, inward = false): Soup => {
  const soup = soupOf(new BoxGeometry(sx, sy, sz).translate(x, y, z));
  if (inward) for (let t = 0; t < soup.length; t += 9) for (let d = 0; d < 3; d++) [soup[t + 3 + d], soup[t + 6 + d]] = [soup[t + 6 + d]!, soup[t + 3 + d]!];
  return soup;
};
/** A rectangle in the plane z = `z`, x0..x1 by y0..y1, facing +z (or -z), as two triangles. */
const quad = (x0: number, x1: number, y0: number, y1: number, z: number, back = false): Soup => {
  const t = [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
  if (back) for (let k = 0; k < t.length; k += 9) for (let d = 0; d < 3; d++) [t[k + 3 + d], t[k + 6 + d]] = [t[k + 6 + d]!, t[k + 3 + d]!];
  return new Float64Array(t);
};
/** A box from x -3 to 3, y 0 to 1, z -1 to 1, wound outwards, with a window in its +z face (x -0.1 to 0.1, y 0.3 to 0.7). */
const pierced = (): Soup => {
  const g = new BoxGeometry(6, 1, 2).translate(0, 0.5, 0);
  // Every face but +z (the fifth of BoxGeometry's six: +x, -x, +y, -y, +z, -z, two triangles each).
  const all = soupOf(g);
  const kept = all.filter((_, i) => Math.floor(i / 18) !== 4);
  return joinSoups([new Float64Array(kept), quad(-3, -0.1, 0, 1, 1), quad(0.1, 3, 0, 1, 1), quad(-0.1, 0.1, 0, 0.3, 1), quad(-0.1, 0.1, 0.7, 1, 1)]);
};

/** WHAT ANYONE CAN SEE OF A VEHICLE'S PART FROM OUTSIDE (`vehicleSeen.ts`). */
describe('the triangles of a vehicle part anyone sees', () => {
  it('sees a strip through a window that hides its corners and middle', () => {
    // A strip along the far wall inside, facing the window: each of its triangles' centre lies a metre to the side of the window.
    const strip = quad(-2.9, 2.9, 0.45, 0.55, -0.9);
    const seen = seenTriangles(strip, joinSoups([pierced(), strip]));
    expect([...seen]).toEqual([1, 1]);
  });

  it('sees nothing of a box wholly inside a closed body', () => {
    const inner = box(0.4, 0.4, 0.4, 0, 0.5, 0);
    const shell = box(6, 1, 2, 0, 0.5, 0);
    expect(seenTriangles(inner, joinSoups([shell, inner])).every((s) => s === 0)).toBe(true);
    // Through the window, the faces of the box facing it.
    const seen = seenTriangles(inner, joinSoups([pierced(), inner]));
    expect(seen.some((s) => s === 1)).toBe(true);
  });

  it('a face turned away hides nothing: the parts are drawn front-sided', () => {
    const inner = box(0.4, 0.4, 0.4, 0, 0.5, 0);
    const inside = box(6, 1, 2, 0, 0.5, 0, true);
    // Seen past the body wound inwards: its near walls face away from the viewer and are not drawn.
    expect(seenTriangles(inner, joinSoups([inside, inner])).every((s) => s === 1)).toBe(true);
  });

  it('sees every piece of a surface cut finer than its samples', () => {
    // A 2 cm square on top of a block, cut into 2 mm triangles: most cover no sample of any view.
    const pieces: number[] = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) pieces.push(...quad(i * 0.002, (i + 1) * 0.002, j * 0.002, (j + 1) * 0.002, 0.5));
    const surface = new Float64Array(pieces);
    const block = box(1, 1, 1, 0, 0, 0);
    expect(seenTriangles(surface, joinSoups([block, surface])).every((s) => s === 1)).toBe(true);
    // The same square in the middle of the block: none.
    const buried = new Float64Array(pieces.map((v, k) => (k % 3 === 2 ? 0 : v)));
    expect(seenTriangles(buried, joinSoups([block, buried])).every((s) => s === 0)).toBe(true);
  });

  it('refuses a part triangle that is not among the occluders', () => {
    const strip = quad(-2.9, 2.9, 0.45, 0.55, -0.9);
    expect(() => seenTriangles(strip, pierced())).toThrow();
  });

  it('on the bus: the floor\'s sides seen through the wheel arches are seen', () => {
    // The floor's long sides (|z| over 1.2 m, under 0.4 m) lie behind the body's skirt but for the arches: the test of four points a triangle
    // cut them, and the arch showed daylight under the wheel housing (2026-10-25).
    const model = buildBusModel(archetypeById('bus'));
    const interior = soupOf(withoutHidden(model.interior, true).geometry);
    const occluders = joinSoups([model.shell, model.roof, model.accent, model.trim, model.interior].flatMap((g) => (g ? [soupOf(withoutHidden(g, true).geometry)] : [])));
    const seen = seenTriangles(interior, occluders);
    const sides: number[] = [];
    for (let t = 0; t < interior.length / 9; t++) {
      const [a, b, c] = [0, 3, 6].map((k) => [interior[t * 9 + k]!, interior[t * 9 + k + 1]!, interior[t * 9 + k + 2]!]) as [number[], number[], number[]];
      // Facing out: its normal along z, away from the middle.
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const out = Math.abs(n[2]!) > 0.99 * Math.hypot(n[0]!, n[1]!, n[2]!) && n[2]! * a[2]! > 0;
      if (out && [a, b, c].every((p) => Math.abs(p[2]!) > 1.2 && p[1]! < 0.4)) sides.push(t);
    }
    expect(sides.length).toBeGreaterThan(0);
    expect(sides.filter((t) => seen[t] === 0)).toEqual([]);
  });
});
