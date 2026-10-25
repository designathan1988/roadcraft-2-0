import { Line3, Matrix4, Triangle, Vector3, type BufferAttribute, type BufferGeometry, type InstancedMesh, type InterleavedBufferAttribute, type Object3D } from 'three';
import { drawnTriangles } from '../catalog/measure';

/** HOW FAR AN OPTIMISED MODEL'S SURFACE LIES FROM THE ORIGINAL'S: the two-sided Hausdorff distance between two triangle soups, the error a level of
 *  detail is accepted on once it is projected to pixels ([KAIST, multi-resolution techniques](https://sgvr.kaist.ac.kr/~sungeui/SGA07/Slides/Lec4-LOD.pdf);
 *  [Lavoué and Corsini, assessing the visual quality of 3D models](https://perso.liris.cnrs.fr/guillaume.lavoue/revue/SPMag2011.pdf)). */

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

/** Every triangle a geometry draws (its draw range), nine floats a triangle, through `matrix`. Positions as the GPU reads them: `getX` decodes
 *  normalised integers and half floats. */
function pushTriangles(g: BufferGeometry, matrix: Matrix4, out: number[]): void {
  const position = g.getAttribute('position') as AnyAttribute | undefined;
  const array = position && ((position as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (position as InterleavedBufferAttribute).data.array : (position as BufferAttribute).array);
  if (!position || !array || (g.index && !g.index.array)) return;
  const { first, triangles } = drawnTriangles(g);
  const v = new Vector3();
  for (let t = first; t < first + triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const i = g.index ? g.index.getX(t * 3 + k) : t * 3 + k;
      v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrix);
      out.push(v.x, v.y, v.z);
    }
  }
}

/** Every triangle an object draws, every copy of an instanced mesh, in the object's own frame. Lines and points draw none. */
export function triangleSoup(root: Object3D): Float32Array {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const out: number[] = [];
  const local = new Matrix4(), copy = new Matrix4();
  root.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; isMesh?: boolean; isInstancedMesh?: boolean };
    if (!holder.isMesh || !holder.geometry) return;
    local.multiplyMatrices(inverse, o.matrixWorld);
    if (holder.isInstancedMesh) {
      const mesh = o as InstancedMesh;
      if (!mesh.instanceMatrix.array) return;
      for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, copy); pushTriangles(holder.geometry, copy.premultiply(local), out); }
    } else pushTriangles(holder.geometry, local, out);
  });
  return new Float32Array(out);
}

/** One geometry's triangles in its own frame. */
export function geometrySoup(g: BufferGeometry): Float32Array {
  const out: number[] = [];
  pushTriangles(g, new Matrix4(), out);
  return new Float32Array(out);
}

interface OneSided {
  /** The farthest a point of the first surface lies from the second, metres. */
  readonly max: number;
  readonly mean: number;
  readonly samples: number;
  /** Where that farthest point lies (x, y, z, metres). */
  readonly at: readonly [number, number, number];
}

export interface SurfaceError {
  /** max(first→second, second→first): the two-sided Hausdorff distance, metres. */
  readonly max: number;
  readonly mean: number;
  readonly forward: OneSided;
  readonly backward: OneSided;
  /** Where the farthest point of either side lies (x, y, z, metres). */
  readonly at: readonly [number, number, number];
}

/** A grid of a soup's triangles over `lo`–`hi` (cubic cells): each cell lists the triangles whose bounds reach into it. */
class TriangleGrid {
  readonly cell: number;
  readonly n: readonly [number, number, number];
  private readonly cells: Map<number, number[]> = new Map();

  constructor(readonly soup: Float32Array, readonly lo: readonly [number, number, number], hi: readonly [number, number, number]) {
    const triangles = soup.length / 9;
    const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    // About two triangles a cell along the largest side.
    this.cell = Math.max(extent / Math.min(256, Math.max(1, Math.ceil(Math.cbrt(triangles) * 2))), 1e-6);
    this.n = [0, 1, 2].map((d) => Math.max(1, Math.ceil((hi[d]! - lo[d]!) / this.cell) + 1)) as unknown as [number, number, number];
    for (let t = 0; t < triangles; t++) {
      const a = [0, 1, 2].map((d) => this.index(d, Math.min(soup[t * 9 + d]!, soup[t * 9 + 3 + d]!, soup[t * 9 + 6 + d]!)));
      const b = [0, 1, 2].map((d) => this.index(d, Math.max(soup[t * 9 + d]!, soup[t * 9 + 3 + d]!, soup[t * 9 + 6 + d]!)));
      for (let x = a[0]!; x <= b[0]!; x++) for (let y = a[1]!; y <= b[1]!; y++) for (let z = a[2]!; z <= b[2]!; z++) {
        const key = this.key(x, y, z);
        const list = this.cells.get(key);
        if (list) list.push(t); else this.cells.set(key, [t]);
      }
    }
  }

  index(d: number, v: number): number { return Math.min(this.n[d]! - 1, Math.max(0, Math.floor((v - this.lo[d]!) / this.cell))); }
  key(x: number, y: number, z: number): number { return (x * this.n[1] + y) * this.n[2] + z; }

  private readonly triangle = new Triangle();
  private readonly closest = new Vector3();

  /** The distance from `p` to the nearest triangle: the cells walked in shells round `p`'s own until no farther shell can hold a nearer one. */
  distance(p: Vector3): number {
    const cx = this.index(0, p.x), cy = this.index(1, p.y), cz = this.index(2, p.z);
    const seen = new Set<number>();
    let best = Infinity;
    const most = Math.max(...this.n);
    for (let r = 0; r <= most; r++) {
      // The shell's cells inside the grid only: a flat soup (a road) has one or two cells across its height.
      const x0 = Math.max(0, cx - r), x1 = Math.min(this.n[0] - 1, cx + r), y0 = Math.max(0, cy - r), y1 = Math.min(this.n[1] - 1, cy + r);
      const z0 = Math.max(0, cz - r), z1 = Math.min(this.n[2] - 1, cz + r);
      // Only the shell, the cells r steps away along some axis: a whole face where x or y is r away, else the two ends along z.
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const face = Math.abs(x - cx) === r || Math.abs(y - cy) === r;
        for (let z = face ? z0 : cz - r; z <= (face ? z1 : cz + r); z += face || r === 0 ? 1 : 2 * r) {
          if (z < z0 || z > z1) continue;
          best = Math.min(best, this.nearestInCell(x, y, z, p, seen));
        }
      }
      // `p` lies in its own cell: a triangle not met yet lies wholly in cells r + 1 or more steps away, at least r cells from `p`.
      if (best <= r * this.cell) break;
    }
    return best;
  }

  /** The nearest of a cell's triangles not measured yet for this point. */
  private nearestInCell(x: number, y: number, z: number, p: Vector3, seen: Set<number>): number {
    let best = Infinity;
    const s = this.soup;
    for (const t of this.cells.get(this.key(x, y, z)) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      const o = t * 9;
      this.triangle.a.set(s[o]!, s[o + 1]!, s[o + 2]!); this.triangle.b.set(s[o + 3]!, s[o + 4]!, s[o + 5]!); this.triangle.c.set(s[o + 6]!, s[o + 7]!, s[o + 8]!);
      let d = this.triangle.closestPointToPoint(p, this.closest).distanceTo(p);
      // A triangle without area (its corners in a line) has no plane to project on: the nearest of its edges.
      if (!Number.isFinite(d)) d = Math.min(...this.edges().map((e) => e.closestPointToPoint(p, true, this.closest).distanceTo(p)));
      best = Math.min(best, d);
    }
    return best;
  }

  private readonly lines = [new Line3(), new Line3(), new Line3()] as const;
  private edges(): readonly Line3[] {
    const { a, b, c } = this.triangle;
    this.lines[0].set(a, b); this.lines[1].set(b, c); this.lines[2].set(c, a);
    return this.lines;
  }
}

/** Points spread over a soup by area (a low-discrepancy pattern, the same every run) and every corner: what the one-sided distance is read at. */
function samplePoints(soup: Float32Array, wanted: number, visit: (p: Vector3) => void): number {
  const triangles = soup.length / 9;
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), p = new Vector3(), e1 = new Vector3(), e2 = new Vector3();
  let area = 0;
  const areas = new Float64Array(triangles);
  const tri = new Triangle();
  for (let t = 0; t < triangles; t++) {
    tri.a.fromArray(soup, t * 9); tri.b.fromArray(soup, t * 9 + 3); tri.c.fromArray(soup, t * 9 + 6);
    areas[t] = tri.getArea();
    area += areas[t]!;
  }
  let count = 0, k = 0;
  // The R2 sequence's two constants (Roberts, "The unreasonable effectiveness of quasirandom sequences").
  const g1 = 0.7548776662466927, g2 = 0.5698402909980532;
  for (let t = 0; t < triangles; t++) {
    a.fromArray(soup, t * 9); b.fromArray(soup, t * 9 + 3); c.fromArray(soup, t * 9 + 6);
    for (const corner of [a, b, c]) { visit(corner); count++; }
    e1.subVectors(b, a); e2.subVectors(c, a);
    const n = area > 0 ? Math.round((areas[t]! / area) * wanted) : 0;
    for (let i = 0; i < n; i++, k++) {
      let u = (0.5 + g1 * k) % 1, v = (0.5 + g2 * k) % 1;
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      p.copy(a).addScaledVector(e1, u).addScaledVector(e2, v);
      visit(p);
      count++;
    }
  }
  return count;
}

function bounds(soups: readonly Float32Array[]): { lo: [number, number, number]; hi: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const s of soups) for (let i = 0; i < s.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d]!, s[i + d]!); hi[d] = Math.max(hi[d]!, s[i + d]!); }
  return { lo, hi };
}

function oneSided(from: Float32Array, to: TriangleGrid, wanted: number): OneSided {
  let max = 0, sum = 0;
  let at: [number, number, number] = [0, 0, 0];
  const samples = samplePoints(from, wanted, (p) => {
    const d = to.distance(p);
    if (d > max) { max = d; at = [p.x, p.y, p.z]; }
    sum += d;
  });
  return { max, mean: samples ? sum / samples : 0, samples, at };
}

/** The two-sided Hausdorff distance between two soups; null when either draws nothing. */
export function surfaceError(first: Float32Array, second: Float32Array): SurfaceError | null {
  if (first.length < 9 || second.length < 9) return null;
  // One grid box over both, so every point asked lies inside the grid the distance walks.
  const { lo, hi } = bounds([first, second]);
  const wanted = (s: Float32Array): number => Math.min(300_000, Math.max(20_000, (s.length / 9) * 4));
  const forward = oneSided(first, new TriangleGrid(second, lo, hi), wanted(first));
  const backward = oneSided(second, new TriangleGrid(first, lo, hi), wanted(second));
  return {
    max: Math.max(forward.max, backward.max),
    mean: (forward.mean * forward.samples + backward.mean * backward.samples) / (forward.samples + backward.samples),
    forward, backward,
    at: forward.max >= backward.max ? forward.at : backward.at,
  };
}

/** The game's vertical field of view (`isoViewport.ts` PERSPECTIVE_FOV) and a 1080-line screen: metres one pixel spans `distance` metres away. */
export function metresPerPixel(distance: number, fovDegrees = 35, lines = 1080): number {
  return (2 * distance * Math.tan((fovDegrees * Math.PI) / 360)) / lines;
}
