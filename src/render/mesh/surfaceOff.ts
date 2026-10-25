import { type BufferGeometry, Vector3 } from 'three';

/** HOW FAR ONE SURFACE STRAYS FROM ANOTHER (the levels' measure: `propLevels.ts`, `buildings/partSimplify.ts`, `shadowLevels.ts`): a module of its own, imported by every one of them without a cycle. */

/** The point of triangle abc nearest p, into `out` (Ericson, "Real-Time Collision Detection", 2005, 5.1.5). */
function closestOnTriangle(p: Vector3, a: Vector3, b: Vector3, c: Vector3, out: Vector3): Vector3 {
  ab.subVectors(b, a); ac.subVectors(c, a); ap.subVectors(p, a);
  const d1 = ab.dot(ap), d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  bp.subVectors(p, b);
  const d3 = ab.dot(bp), d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3));
  cp.subVectors(p, c);
  const d5 = ab.dot(cp), d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return out.copy(b).addScaledVector(bc.subVectors(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denom = 1 / (va + vb + vc);
  return out.copy(a).addScaledVector(ab, vb * denom).addScaledVector(ac, vc * denom);
}
const ab = new Vector3(), ac = new Vector3(), ap = new Vector3(), bp = new Vector3(), cp = new Vector3(), bc = new Vector3();

/** How far the surface of `from` strays from the surface of `to`, at most, model units: each of its triangles' corners, edge middles and
 *  centre measured to the nearest point of `to` (one side of the Hausdorff distance, sampled). */
export function surfaceOff(from: BufferGeometry, to: BufferGeometry): number {
  const p = from.getAttribute('position'), q = to.getAttribute('position');
  const fi = from.index!, ti = to.index!;
  const corners = [new Vector3(), new Vector3(), new Vector3()], tri = [new Vector3(), new Vector3(), new Vector3()];
  const sample = new Vector3(), near = new Vector3();
  // Each triangle of `to` and its box: a triangle whose box lies farther than the nearest found is not looked at.
  const triangles = ti.count / 3;
  const corner = new Float32Array(triangles * 9), box = new Float32Array(triangles * 6);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const v = ti.getX(t * 3 + k);
      corner[t * 9 + k * 3] = q.getX(v); corner[t * 9 + k * 3 + 1] = q.getY(v); corner[t * 9 + k * 3 + 2] = q.getZ(v);
    }
    for (let axis = 0; axis < 3; axis++) {
      const a = corner[t * 9 + axis]!, b = corner[t * 9 + 3 + axis]!, c = corner[t * 9 + 6 + axis]!;
      box[t * 6 + axis] = Math.min(a, b, c); box[t * 6 + 3 + axis] = Math.max(a, b, c);
    }
  }
  let worst = 0, last = 0;
  const distanceTo = (x: Vector3, t: number): number => {
    for (let k = 0; k < 3; k++) tri[k]!.set(corner[t * 9 + k * 3]!, corner[t * 9 + k * 3 + 1]!, corner[t * 9 + k * 3 + 2]!);
    return closestOnTriangle(x, tri[0]!, tri[1]!, tri[2]!, near).distanceTo(x);
  };
  const measure = (x: Vector3): void => {
    // The triangle nearest the last sample first: the samples go along the surface.
    let best = distanceTo(x, last), at = last;
    for (let t = 0; t < triangles && best > worst; t++) {
      const dx = Math.max(box[t * 6]! - x.x, 0, x.x - box[t * 6 + 3]!);
      const dy = Math.max(box[t * 6 + 1]! - x.y, 0, x.y - box[t * 6 + 4]!);
      const dz = Math.max(box[t * 6 + 2]! - x.z, 0, x.z - box[t * 6 + 5]!);
      if (dx * dx + dy * dy + dz * dz >= best * best) continue;
      const d = distanceTo(x, t);
      if (d < best) { best = d; at = t; }
    }
    last = at;
    worst = Math.max(worst, best);
  };
  for (let t = 0; t < fi.count; t += 3) {
    for (let k = 0; k < 3; k++) corners[k]!.fromBufferAttribute(p, fi.getX(t + k));
    for (const c of corners) measure(c);
    for (let k = 0; k < 3; k++) measure(sample.addVectors(corners[k]!, corners[(k + 1) % 3]!).multiplyScalar(0.5));
    measure(sample.copy(corners[0]!).add(corners[1]!).add(corners[2]!).divideScalar(3));
  }
  return worst;
}
