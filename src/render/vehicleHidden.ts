import { BufferAttribute, BufferGeometry } from 'three';

/** A VEHICLE PART WITHOUT THE TRIANGLES NO ONE CAN SEE, proven one by one within the part itself (the same mesh, the same instance, the same
 *  opaque front-sided material): its vertices kept as they are (the cabin's solids name vertex ranges, `interiorSolids.ts`), only its index
 *  shorter. A triangle goes when it is
 *  - without area (its corners in a line): it covers no pixel and writes no depth, on the screen or in the shadow map;
 *  - inside a closed convex solid of the same part (every edge of it shared by two of its triangles, every face wound outwards), all its
 *    corners at least MARGIN inside every face: any ray from outside reaches it through a front face of that solid, which is drawn in the
 *    same draw, so no pixel of it passes the depth test; in the shadow map (three r186 draws a front-sided material's back faces there,
 *    `WebGLShadowMap` shadowSide) it only stood in front of the solid's own back face on rays through the solid, which no receiver outside it
 *    reads, and a vehicle part receives no shadow (`agents.ts` instanced);
 *  - lying on a face of such a solid and facing into it: seen from outside it is always a back face, culled; through the face it is the solid
 *    itself in front of it.
 *  Glass is see-through: of a glazing only the triangles without area go (`opaque` false). */

/** How far inside every face of the solid a buried triangle's corners must lie: no depth fight with the solid's faces at any distance a
 *  vehicle is drawn whole (a millimetre is more than a 24-bit depth step at 100 m with the game's 0.4 m near plane). */
const MARGIN = 1e-3;
/** Two places the same to this, metres: the parts' own weld (`vehicleModels.ts` merge, 1e-4). */
const SAME_PLACE = 1e-4;
/** A face's plane holds a corner to this, metres. */
const ON_PLANE = 1e-5;

/** What `withoutHidden` took out of a part, by reason. */
export interface Hidden { readonly flat: number; readonly buried: number; readonly pressed: number }

/** The welded place of every corner of `g`'s triangles (corners the same to SAME_PLACE share one). */
function placesOf(g: BufferGeometry): { readonly place: Int32Array; readonly points: Float64Array; readonly corners: Uint32Array } {
  const position = g.getAttribute('position') as BufferAttribute;
  const index = g.getIndex();
  const count = index ? index.count : position.count;
  const corners = new Uint32Array(count);
  for (let i = 0; i < count; i++) corners[i] = index ? index.getX(i) : i;
  const ids = new Map<string, number>();
  const place = new Int32Array(position.count).fill(-1);
  const points: number[] = [];
  const key = (v: number): string => `${Math.round(position.getX(v) / SAME_PLACE)},${Math.round(position.getY(v) / SAME_PLACE)},${Math.round(position.getZ(v) / SAME_PLACE)}`;
  for (let v = 0; v < position.count; v++) {
    const k = key(v);
    let id = ids.get(k);
    if (id === undefined) { id = points.length / 3; ids.set(k, id); points.push(position.getX(v), position.getY(v), position.getZ(v)); }
    place[v] = id;
  }
  return { place, points: new Float64Array(points), corners };
}

/** Which triangles of `g` no one can see (`withoutHidden`'s reasons), as a mark a triangle (0 kept, 1 without area, 2 buried, 3 pressed). */
export function hiddenTriangles(g: BufferGeometry, opaque: boolean): Uint8Array {
  const { place, points, corners } = placesOf(g);
  const triangles = corners.length / 3;
  const marks = new Uint8Array(triangles);
  const p = (t: number, k: number): number => place[corners[t * 3 + k]!]!;
  // Each triangle's plane (unit normal by its winding, offset), from its own corners as drawn; none for one without area.
  const position = g.getAttribute('position') as BufferAttribute;
  const planes = new Float64Array(triangles * 4);
  for (let t = 0; t < triangles; t++) {
    const a = corners[t * 3]!, b = corners[t * 3 + 1]!, c = corners[t * 3 + 2]!;
    const ax = position.getX(a), ay = position.getY(a), az = position.getZ(a);
    const ux = position.getX(b) - ax, uy = position.getY(b) - ay, uz = position.getZ(b) - az;
    const vx = position.getX(c) - ax, vy = position.getY(c) - ay, vz = position.getZ(c) - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const twice = Math.hypot(nx, ny, nz);
    if (twice === 0) { marks[t] = 1; continue; }
    planes[t * 4] = nx / twice; planes[t * 4 + 1] = ny / twice; planes[t * 4 + 2] = nz / twice;
    planes[t * 4 + 3] = -(planes[t * 4]! * ax + planes[t * 4 + 1]! * ay + planes[t * 4 + 2]! * az);
  }
  if (!opaque) return marks;
  // The solids: triangles connected through shared places.
  const parent = new Int32Array(points.length / 3).map((_, i) => i);
  const find = (v: number): number => { while (parent[v] !== v) { parent[v] = parent[parent[v]!]!; v = parent[v]!; } return v; };
  for (let t = 0; t < triangles; t++) { parent[find(p(t, 0))] = find(p(t, 1)); parent[find(p(t, 1))] = find(p(t, 2)); }
  const members = new Map<number, number[]>();
  for (let t = 0; t < triangles; t++) {
    if (marks[t] === 1) continue;
    const r = find(p(t, 0));
    const list = members.get(r);
    if (list) list.push(t); else members.set(r, [t]);
  }
  // The closed convex solids, wound outwards: their faces' planes (outside positive) and bounds.
  const solids: { root: number; faces: number[]; lo: number[]; hi: number[] }[] = [];
  for (const [root, faces] of members) {
    if (faces.length < 4) continue;
    const edges = new Map<string, number>();
    for (const t of faces) for (let k = 0; k < 3; k++) {
      const a = p(t, k), b = p(t, (k + 1) % 3);
      const e = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
    let closed = true;
    for (const n of edges.values()) if (n !== 2) { closed = false; break; }
    if (!closed) continue;
    const verts = new Set<number>();
    for (const t of faces) for (let k = 0; k < 3; k++) verts.add(p(t, k));
    // Convex and wound outwards: every corner of the solid on the inner side of every face's plane, as its winding faces.
    let convex = true;
    for (const t of faces) {
      for (const v of verts) {
        if (planes[t * 4]! * points[v * 3]! + planes[t * 4 + 1]! * points[v * 3 + 1]! + planes[t * 4 + 2]! * points[v * 3 + 2]! + planes[t * 4 + 3]! > ON_PLANE) { convex = false; break; }
      }
      if (!convex) break;
    }
    if (!convex) continue;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d]!, points[v * 3 + d]!); hi[d] = Math.max(hi[d]!, points[v * 3 + d]!); }
    solids.push({ root, faces, lo, hi });
  }
  if (solids.length === 0) return marks;
  const side = (t: number, x: number, y: number, z: number): number => planes[t * 4]! * x + planes[t * 4 + 1]! * y + planes[t * 4 + 2]! * z + planes[t * 4 + 3]!;
  for (let t = 0; t < triangles; t++) {
    if (marks[t] !== 0) continue;
    const own = find(p(t, 0));
    const cs = [p(t, 0), p(t, 1), p(t, 2)];
    for (const s of solids) {
      if (s.root === own) continue;
      // Outside the solid's bounds: not in it.
      if (cs.some((v) => [0, 1, 2].some((d) => points[v * 3 + d]! < s.lo[d]! - ON_PLANE || points[v * 3 + d]! > s.hi[d]! + ON_PLANE))) continue;
      let buried = true, inside = true, pressedOn = -1;
      for (const f of s.faces) {
        let most = -Infinity, least = Infinity;
        for (const v of cs) { const d = side(f, points[v * 3]!, points[v * 3 + 1]!, points[v * 3 + 2]!); most = Math.max(most, d); least = Math.min(least, d); }
        if (most > ON_PLANE) { inside = false; break; }
        if (most > -MARGIN) buried = false;
        // On this face's plane, facing into the solid.
        if (most >= -ON_PLANE && least >= -ON_PLANE
          && planes[t * 4]! * planes[f * 4]! + planes[t * 4 + 1]! * planes[f * 4 + 1]! + planes[t * 4 + 2]! * planes[f * 4 + 2]! < -0.999999) pressedOn = f;
      }
      if (!inside) continue;
      if (buried) { marks[t] = 2; break; }
      if (pressedOn >= 0) { marks[t] = 3; break; }
    }
  }
  return marks;
}

/** `g` without its hidden triangles (`hiddenTriangles`): the same vertices, a shorter index; `g` itself when none is hidden. */
export function withoutHidden(g: BufferGeometry, opaque: boolean): { readonly geometry: BufferGeometry; readonly hidden: Hidden } {
  const marks = hiddenTriangles(g, opaque);
  let flat = 0, buried = 0, pressed = 0;
  for (const m of marks) { if (m === 1) flat++; else if (m === 2) buried++; else if (m === 3) pressed++; }
  if (flat + buried + pressed === 0) return { geometry: g, hidden: { flat, buried, pressed } };
  const index = g.getIndex();
  const kept: number[] = [];
  for (let t = 0; t < marks.length; t++) {
    if (marks[t] !== 0) continue;
    for (let k = 0; k < 3; k++) kept.push(index ? index.getX(t * 3 + k) : t * 3 + k);
  }
  const out = new BufferGeometry();
  for (const name of Object.keys(g.attributes)) out.setAttribute(name, g.getAttribute(name));
  const vertices = g.getAttribute('position').count;
  out.setIndex(new BufferAttribute(vertices > 65535 ? new Uint32Array(kept) : new Uint16Array(kept), 1));
  out.name = g.name;
  return { geometry: out, hidden: { flat, buried, pressed } };
}
