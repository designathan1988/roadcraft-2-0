import { Box3, BufferAttribute, type BufferGeometry, Vector3 } from 'three';

/** THE FACES OF A MODEL'S PARTS NO ONE CAN SEE, TAKEN OUT BEFORE THE PARTS ARE MERGED */

/** How far out of a face it is looked at to tell whether another part covers it: deeper than float noise, thinner than any gap drawn (6 mm between books). */
const COVER_PROBE = 0.002;

/** Whether `g` is a box standing square to the axes (three's BoxGeometry: six faces of four corners, each facing an axis), and so a solid a face can lie in. */
function axisBox(g: BufferGeometry): boolean {
  if (g.groups.length !== 6 || g.getAttribute('position').count !== 24) return false;
  const normal = g.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) {
    const a = Math.abs(normal.getX(i)), b = Math.abs(normal.getY(i)), c = Math.abs(normal.getZ(i));
    if (Math.max(a, b, c) < 0.9999) return false;
  }
  return true;
}

/** The faces of the parts no one can see taken out: one lying on the floor facing down (`floor`: the model stands on y = 0), or one whose every point, `COVER_PROBE` out of it, is inside
 *  another part's box (a book's bottom on its shelf, a tread inside the next, a leg's ends in the floor and in the top). A face only partly
 *  covered is kept whole. DO NOT keep them: they are drawn and cast for every instance of the model. */
export function dropHiddenFaces(parts: readonly BufferGeometry[], floor = true): void {
  const solids: { part: BufferGeometry; box: Box3 }[] = [];
  for (const part of parts) {
    if (!axisBox(part)) continue;
    part.computeBoundingBox();
    solids.push({ part, box: part.boundingBox!.clone() });
  }
  const at = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3(), centre = new Vector3();
  const covered = (self: BufferGeometry, p: Vector3): boolean => {
    for (const s of solids) if (s.part !== self && s.box.containsPoint(p)) return true;
    return false;
  };
  for (const part of parts) {
    const index = part.index;
    if (!index || !part.groups.length) continue;
    const position = part.getAttribute('position');
    const kept: number[] = [];
    let dropped = false;
    for (const group of part.groups) {
      const end = group.start + group.count;
      // A flat face: every triangle facing the first's way (a cylinder's side is not one, and is kept).
      a.fromBufferAttribute(position, index.getX(group.start));
      b.fromBufferAttribute(position, index.getX(group.start + 1));
      c.fromBufferAttribute(position, index.getX(group.start + 2));
      n.subVectors(c, b).cross(at.subVectors(a, b)).normalize();
      let flat = n.lengthSq() > 0.5;
      let lowest = Infinity;
      for (let i = group.start; flat && i < end; i += 3) {
        a.fromBufferAttribute(position, index.getX(i));
        b.fromBufferAttribute(position, index.getX(i + 1));
        c.fromBufferAttribute(position, index.getX(i + 2));
        flat = at.subVectors(c, b).cross(centre.subVectors(a, b)).normalize().dot(n) > 0.9999;
        lowest = Math.min(lowest, a.y, b.y, c.y);
      }
      let hidden = false;
      if (flat) {
        const onFloor = floor && n.y < -0.9999 && lowest <= 1e-4;
        hidden = onFloor;
        if (!hidden) {
          // Each triangle's corners drawn in a little towards its middle, its middle, its edges' middles: all must be inside another part.
          hidden = true;
          for (let i = group.start; hidden && i < end; i += 3) {
            a.fromBufferAttribute(position, index.getX(i));
            b.fromBufferAttribute(position, index.getX(i + 1));
            c.fromBufferAttribute(position, index.getX(i + 2));
            centre.copy(a).add(b).add(c).divideScalar(3);
            for (const [p, q, w] of [[a, a, 0.98], [b, b, 0.98], [c, c, 0.98], [a, b, 0.98], [b, c, 0.98], [c, a, 0.98], [centre, centre, 0]] as const) {
              at.copy(p).add(q).multiplyScalar(0.5).lerp(centre, 1 - w).addScaledVector(n, COVER_PROBE);
              if (!covered(part, at)) { hidden = false; break; }
            }
          }
        }
      }
      if (hidden) { dropped = true; continue; }
      for (let i = group.start; i < end; i++) kept.push(index.getX(i));
    }
    if (!dropped) continue;
    // Only the corners the kept faces use, renumbered in their order.
    const remap = new Int32Array(position.count).fill(-1);
    let used = 0;
    for (const v of kept) if (remap[v] === -1) remap[v] = used++;
    for (const [name, attribute] of Object.entries(part.attributes)) {
      const size = attribute.itemSize;
      const array = new Float32Array(used * size);
      for (let v = 0; v < remap.length; v++) {
        const to = remap[v]!;
        if (to >= 0) for (let k = 0; k < size; k++) array[to * size + k] = attribute.array[v * size + k]!;
      }
      part.setAttribute(name, new BufferAttribute(array, size, attribute.normalized));
    }
    part.setIndex(kept.map((v) => remap[v]!));
    part.clearGroups();
  }
}

/** A part's planes when it is a closed convex solid (a box turned any way, a closed cylinder, a ball): each edge shared by two of its
 *  triangles, every corner on the inner side of every triangle's plane; null for any other part. */
function convexPlanes(part: BufferGeometry): Float64Array | null {
  const position = part.getAttribute('position');
  const index = part.index;
  const corners = index ? index.count : position.count;
  if (corners < 12) return null;
  const at = (k: number): number => (index ? index.getX(k) : k);
  // Corners welded by place (three's ball and cylinder repeat a corner at the seam), each edge counted.
  const ids = new Map<string, number>();
  const idOf = (v: number): number => {
    const key = `${Math.round(position.getX(v) * 1e5)},${Math.round(position.getY(v) * 1e5)},${Math.round(position.getZ(v) * 1e5)}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, id = ids.size);
    return id;
  };
  const edges = new Map<string, number>();
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3(), e = new Vector3();
  const planes: number[] = [];
  for (let k = 0; k < corners; k += 3) {
    const i = [idOf(at(k)), idOf(at(k + 1)), idOf(at(k + 2))];
    if (i[0] === i[1] || i[1] === i[2] || i[2] === i[0]) continue;
    for (let s = 0; s < 3; s++) {
      const p = i[s]!, q = i[(s + 1) % 3]!, key = p < q ? `${p},${q}` : `${q},${p}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    a.fromBufferAttribute(position, at(k)); b.fromBufferAttribute(position, at(k + 1)); c.fromBufferAttribute(position, at(k + 2));
    n.subVectors(b, a).cross(e.subVectors(c, a));
    if (n.lengthSq() < 1e-20) continue;
    n.normalize();
    planes.push(n.x, n.y, n.z, -n.dot(a));
  }
  for (const count of edges.values()) if (count !== 2) return null;
  for (let v = 0; v < position.count; v++) {
    a.fromBufferAttribute(position, v);
    for (let p = 0; p < planes.length; p += 4) if (planes[p]! * a.x + planes[p + 1]! * a.y + planes[p + 2]! * a.z + planes[p + 3]! > 1e-5) return null;
  }
  return Float64Array.from(planes);
}

/** The triangles of each part wholly inside another part that is a closed convex solid taken out, the corners they alone used with them: a
 *  leg's end in a seat turned off the axes, a bulb inside its shade, the inner half of one ball of leaves inside the next. A triangle is
 *  inside when its three corners are in the same solid or on its faces (the solid is convex: then the whole triangle is) and its middle,
 *  `COVER_PROBE` out of it, is inside that solid: so one lying on that solid's face, facing into it, is taken out too, one facing out of it
 *  kept. DO NOT draw the corners in towards the middle: a corner a little out of the solid was taken for in, and the sliver of the triangle
 *  out of it went with it. DO NOT test a part against the union of the others: two solids each covering half a triangle cover no more than
 *  its halves, and the rule stays exact for each solid alone. */
export function dropBuried(parts: readonly BufferGeometry[]): void {
  const solids = parts.map((p) => convexPlanes(p));
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3(), centre = new Vector3(), probe = new Vector3();
  const inside = (planes: Float64Array, p: Vector3): boolean => {
    for (let k = 0; k < planes.length; k += 4) if (planes[k]! * p.x + planes[k + 1]! * p.y + planes[k + 2]! * p.z + planes[k + 3]! >= -1e-6) return false;
    return true;
  };
  /** In the solid or on its faces, within float noise. */
  const within = (planes: Float64Array, p: Vector3): boolean => {
    for (let k = 0; k < planes.length; k += 4) if (planes[k]! * p.x + planes[k + 1]! * p.y + planes[k + 2]! * p.z + planes[k + 3]! > 1e-6) return false;
    return true;
  };
  parts.forEach((part, self) => {
    const index = part.index;
    if (!index) return;
    const position = part.getAttribute('position');
    const kept: number[] = [];
    let dropped = false;
    for (let k = 0; k < index.count; k += 3) {
      a.fromBufferAttribute(position, index.getX(k)); b.fromBufferAttribute(position, index.getX(k + 1)); c.fromBufferAttribute(position, index.getX(k + 2));
      centre.copy(a).add(b).add(c).divideScalar(3);
      n.subVectors(b, a).cross(probe.subVectors(c, a));
      let buried = false;
      if (n.lengthSq() > 1e-20) {
        n.normalize();
        buried = solids.some((planes, other) => {
          if (other === self || !planes) return false;
          return within(planes, a) && within(planes, b) && within(planes, c) && inside(planes, probe.copy(centre).addScaledVector(n, COVER_PROBE));
        });
      }
      if (buried) { dropped = true; continue; }
      kept.push(index.getX(k), index.getX(k + 1), index.getX(k + 2));
    }
    if (!dropped) return;
    const remap = new Int32Array(position.count).fill(-1);
    let used = 0;
    for (const v of kept) if (remap[v] === -1) remap[v] = used++;
    for (const [name, attribute] of Object.entries(part.attributes)) {
      const size = attribute.itemSize;
      const array = new Float32Array(used * size);
      for (let v = 0; v < remap.length; v++) {
        const to = remap[v]!;
        if (to >= 0) for (let q = 0; q < size; q++) array[to * size + q] = attribute.array[v * size + q]!;
      }
      part.setAttribute(name, new BufferAttribute(array, size, attribute.normalized));
    }
    part.setIndex(kept.map((v) => remap[v]!));
    part.clearGroups();
  });
}

/** The triangles of `part` facing `towards` (unit; within `cos` of it) taken out, its unused corners with them: the side of a prop against a wall
 *  faces the wall, where no camera stands. */
export function dropFacing(part: BufferGeometry, towards: Vector3, cos = 0.99): BufferGeometry {
  const index = part.index;
  if (!index) return part;
  const position = part.getAttribute('position');
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), e = new Vector3(), f = new Vector3();
  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    const n = e.subVectors(b, a).cross(f.subVectors(c, a)).normalize();
    if (n.dot(towards) > cos) continue;
    kept.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  }
  if (kept.length === index.count) return part;
  const remap = new Int32Array(position.count).fill(-1);
  let used = 0;
  for (const v of kept) if (remap[v] === -1) remap[v] = used++;
  for (const [name, attribute] of Object.entries(part.attributes)) {
    const size = attribute.itemSize;
    const array = new Float32Array(used * size);
    for (let v = 0; v < remap.length; v++) {
      const to = remap[v]!;
      if (to >= 0) for (let k = 0; k < size; k++) array[to * size + k] = attribute.array[v * size + k]!;
    }
    part.setAttribute(name, new BufferAttribute(array, size, attribute.normalized));
  }
  part.setIndex(kept.map((v) => remap[v]!));
  part.clearGroups();
  return part;
}
