import { BufferAttribute, BufferGeometry, Float32BufferAttribute, type InterleavedBufferAttribute, type TypedArray } from 'three';
import { weldGeometry } from './mesh/weld';
import { MeshoptSimplifier } from 'meshoptimizer';
import { SurfaceGrid, keysOf, withinError } from './levelError';
import { seenTriangles } from './vehicleSeen';

/** One welded mesh simplified once per error: its positions, its other attributes interleaved (`weights` a float each), its index. */
interface Ladder { readonly positions: Float32Array; readonly attributes: Float32Array; readonly weights: readonly number[]; readonly index: Uint32Array; readonly errors: readonly number[] }

/** meshoptimizer's target error is its own quadric estimate, not the distance a level lies from its part (meshoptimizer README,
 *  "Simplification": "an approximate measure of the deviation"), so the target each level is made with is searched: of TRIES targets one
 *  ratio apart over [the finer level's target, HIGHEST x the error], the one whose level has the fewest triangles and stays within its error of
 *  the part both ways (`levelError.ts` withinError). A fixed target lands a level well inside its error (0.15-0.36 px measured at its switch,
 *  2026-10-25) or outside it. DO NOT bisect for the largest target that passes: the simplifier's triangles do not fall steadily with its
 *  target, and a bisection stopped where they rose again (a tyre kept 64 triangles at 0.2 and 0.4 where targets between gave 28 and 12 within
 *  them). */
const HIGHEST = 8;
const TRIES = 16;

/** The triangles of `index` by connected component (triangles sharing a vertex), each its own index. */
function componentsOf(index: Uint32Array, vertices: number): Uint32Array[] {
  const parent = new Int32Array(vertices);
  for (let v = 0; v < vertices; v++) parent[v] = v;
  const find = (v: number): number => { while (parent[v] !== v) { parent[v] = parent[parent[v]!]!; v = parent[v]!; } return v; };
  for (let t = 0; t < index.length; t += 3) { parent[find(index[t]!)] = find(index[t + 1]!); parent[find(index[t + 1]!)] = find(index[t + 2]!); }
  const by = new Map<number, number[]>();
  for (let t = 0; t < index.length; t += 3) {
    const root = find(index[t]!);
    let list = by.get(root);
    if (!list) { list = []; by.set(root, list); }
    list.push(index[t]!, index[t + 1]!, index[t + 2]!);
  }
  return [...by.values()].map((list) => new Uint32Array(list));
}

/** `index` simplified to the fewest triangles each error allows (meshoptimizer README: `ErrorAbsolute`), finest first. Each connected
 *  component is simplified on its own, over its own vertices only (the simplifier copies the vertex arrays it is given at every call), to the
 *  coarsest of its searched targets (`HIGHEST`) that the two-sided distance to that component accepts: one target for a whole part is held
 *  back by its finest feature (a car's cabin with its body as one mesh kept 1,738 triangles at 5 cm, 650 without it, 2026-10-25). A fold
 *  farther than the error from the component fails the measure (a truck's box post the simplifier folded away lay 2.5 m from the level drawn
 *  at 10 cm), and a component is never left out (an empty level is near nothing), so no piece drawn is lost: HEAD's levels dropped trims and
 *  steering wheels 2-30 px across. None accepted: the component itself. */
function ladderIndices(req: Ladder): Uint32Array[] {
  const stride = req.weights.length;
  const parts = componentsOf(req.index, req.positions.length / 3).map((global) => {
    // The component's own vertices, in the order its triangles first name them.
    const local = new Map<number, number>(), vertices: number[] = [];
    const index = new Uint32Array(global.length);
    for (let i = 0; i < global.length; i++) {
      let v = local.get(global[i]!);
      if (v === undefined) { v = vertices.length; local.set(global[i]!, v); vertices.push(global[i]!); }
      index[i] = v;
    }
    const positions = new Float32Array(vertices.length * 3), attributes = new Float32Array(vertices.length * stride);
    vertices.forEach((g, v) => {
      for (let d = 0; d < 3; d++) positions[v * 3 + d] = req.positions[g * 3 + d]!;
      for (let d = 0; d < stride; d++) attributes[v * stride + d] = req.attributes[g * stride + d]!;
    });
    return { global, vertices: Uint32Array.from(vertices), index, positions, attributes, grid: new SurfaceGrid(positions, index, req.errors[0]! * 2),
      keys: keysOf(index),
      // A coarser level's error is larger: its target is searched from the finer one's up.
      floor: 0 };
  });
  return req.errors.map((error) => {
    const kept: Uint32Array[] = [];
    for (const part of parts) {
      const simplified = (target: number): Uint32Array => MeshoptSimplifier.simplifyWithAttributes(part.index, part.positions, 3,
        part.attributes, stride, [...req.weights], null, 3, target, ['ErrorAbsolute'])[0];
      // Swept on a log scale from HIGHEST x the error down to a 64th of it (or the finer level's target), TRIES targets one ratio apart, each try
      // with fewer triangles than the fewest kept so far read at its points (a level within the error always passes, `partNearLevel`), then the
      // one kept proved; one the proof fails is searched again, every try proved.
      const search = (proved: boolean): { level: Uint32Array; target: number } | null => {
        const lo = Math.max(part.floor, error / 64), hi = error * HIGHEST, ratio = (hi / lo) ** (1 / (TRIES - 1));
        let best: { level: Uint32Array; target: number } | null = null;
        for (let k = TRIES - 1; k >= 0; k--) {
          const target = lo * ratio ** k;
          const level = simplified(target);
          if (level.length >= (best?.level ?? part.index).length) continue;
          if (withinError(part.positions, part.index, part.grid, level, error, part.keys, proved)) best = { level, target };
        }
        return best;
      };
      let found = search(false);
      if (found && !withinError(part.positions, part.index, part.grid, found.level, error, part.keys)) found = search(true);
      if (!found) { kept.push(part.global); continue; }
      part.floor = found.target;
      const best = found.level;
      const out = new Uint32Array(best.length);
      for (let i = 0; i < best.length; i++) out[i] = part.vertices[best[i]!]!;
      kept.push(out);
    }
    const out = new Uint32Array(kept.reduce((s, k) => s + k.length, 0));
    let at = 0;
    for (const k of kept) { out.set(k, at); at += k.length; }
    return out;
  });
}

/** A VEHICLE PART'S LEVELS AS ARRAYS (`vehicleLevels.ts`): welded, simplified once per error, each level measured against the part, and for
 *  box assemblies their normals given back from the part's own; all of it in the levels' worker (`people/lodWorker.ts` 'part') */
/** DO NOT weld a part's vertices on the page (`mergeVertices`: every vertex of every part of every vehicle while the map opens). */

/** Errors of a vehicle part's coarser levels, in the part's own units (metres; a wheel's diameters), finest first. The finest is half a pixel
 *  at 80 px/m: the whole part is drawn only where a car is over 300 px long (at 40 px/m, a car 180 px long, the whole body covered 1.2-1.9 px^2
 *  a triangle facing the camera; the 6.25 mm level keeps 4,860 of a hatch body's 8,751, 2026-10-24). */
export const LEVEL_ERRORS = [0.00625, 0.0125, 0.025, 0.05, 0.1, 0.2, 0.4] as const;
/** A coarser level that keeps more than this share of the finer one's triangles is the finer one again (no draw for nothing). */
const WORTH = 0.9;
/** Two normals the same to this in every component: a triangle whose three corners carry one normal is drawn flat. The models' own weld
 *  (`vehicleModels.ts` merge, `weldGeometry` at 1e-4) already takes normals this close for one: a flat face's corners differ by no more. */
const SAME_NORMAL = 1e-4;
/** The weight of the colour in the simplifier's error (meshoptimizer README, `simplifyWithAttributes`: "a weight around 1.0 is usually
 *  appropriate" for normalised attributes; half of it, as the bodies always had). The normals are not weighed: where a colour or a crease
 *  changes the vertices are split (a seam the simplifier keeps), and what a level may move is held by the measured distance (`ladderIndices`). */
const ATTRIBUTE_WEIGHT = 0.5;
/** Corners of a box assembly's level the same to this are one vertex: the same welded vertex and the same source normal, bit for bit. */
const SAME_CORNER = 1e-6;

/** What a part is: a smooth body (`smooth`: a shell, glass) or a box assembly (`boxes`: trim, a cabin, a tyre). Its levels are made the same way
 *  for both (`partLevelArrays`); the levels' worker's requests carry it (`people/lodWorker.ts`). */
export type Weld = 'smooth' | 'boxes';

/** One attribute's numbers, as a geometry holds them. */
export interface ArrayOf { readonly array: TypedArray; readonly itemSize: number; readonly normalized: boolean }

/** A part as the page sends it: its position, colour and normal (where it has them) and its index. */
export interface PartArrays {
  readonly position: ArrayOf;
  readonly color: ArrayOf | null;
  readonly normal: ArrayOf | null;
  readonly index: Uint32Array | Uint16Array | null;
  /** The vehicle's opaque triangles in the part's frame, nine numbers a triangle (`vehicleSeen.ts` soupOf), the part's own among them: given,
   *  the levels are made of the part's triangles seen past them (`vehicleSeen.ts`), for a part that casts no shadow (a caster's unseen back
   *  faces still write the shadow map); none: of all of them. */
  readonly occluders?: Float64Array | null;
}

/** A level: the finer one again (`same`), or its own attributes, index and bounding sphere. */
export type LevelArrays = 'same' | {
  readonly position: ArrayOf; readonly color: ArrayOf; readonly normal: ArrayOf;
  readonly index: Uint32Array; readonly sphere: readonly number[];
};

/** Levels 1.. of a part. */
export interface PartLevels { readonly levels: LevelArrays[] }

/** An attribute's numbers as sent. */
const arrayOf = (a: BufferAttribute | InterleavedBufferAttribute): ArrayOf => ({ array: (a as BufferAttribute).array, itemSize: a.itemSize, normalized: a.normalized });
const attributeOf = (a: ArrayOf): BufferAttribute => new BufferAttribute(a.array, a.itemSize, a.normalized);

/** The vertex of corner `i` of the part (its index's, or `i` drawn unindexed). */
const cornerVertex = (part: PartArrays, i: number): number => (part.index ? part.index[i]! : i);

/** The part's triangles in its own order, nine numbers each. */
function partSoup(part: PartArrays): Float64Array {
  const p = part.position.array, corners = part.index ? part.index.length : p.length / 3;
  const out = new Float64Array(corners * 3);
  for (let i = 0; i < corners; i++) {
    const v = cornerVertex(part, i);
    out[i * 3] = p[v * 3]!; out[i * 3 + 1] = p[v * 3 + 1]!; out[i * 3 + 2] = p[v * 3 + 2]!;
  }
  return out;
}

/** Whether the triangle of corners i, i + 1, i + 2 carries one normal at all three. */
function flatAt(part: PartArrays, normal: ArrayLike<number>, i: number): boolean {
  const a = cornerVertex(part, i) * 3, b = cornerVertex(part, i + 1) * 3, c = cornerVertex(part, i + 2) * 3;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(normal[a + k]! - normal[b + k]!) > SAME_NORMAL || Math.abs(normal[a + k]! - normal[c + k]!) > SAME_NORMAL) return false;
  }
  return true;
}

/** The unit normal of the triangle (a, b, c) of `positions` into `out` at `at` (zero for one without area), as three's `computeVertexNormals` winds it. */
function faceNormal(positions: ArrayLike<number>, a: number, b: number, c: number, out: Float32Array | Float64Array, at: number): void {
  const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
  const ux = positions[c * 3]! - positions[b * 3]!, uy = positions[c * 3 + 1]! - positions[b * 3 + 1]!, uz = positions[c * 3 + 2]! - positions[b * 3 + 2]!;
  const vx = ax - positions[b * 3]!, vy = ay - positions[b * 3 + 1]!, vz = az - positions[b * 3 + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  const s = length > 0 ? 1 / length : 0;
  out[at] = nx * s; out[at + 1] = ny * s; out[at + 2] = nz * s;
}

/** Each corner of the level `level` (over the part's welded vertices) its normal from the part's own, so a triangle the level kept is shaded as
 *  the part shades it: the part's triangle at that corner facing most like the level's triangle is found; drawn flat, the corner takes the
 *  level triangle's own face normal (a merged facet stays one facet), else that triangle's normal there (a smooth surface stays smooth).
 *  `welded[i]` is the welded vertex of the part's corner i. */
function normalsFrom(part: PartArrays, welded: ArrayLike<number>, positions: Float32Array, level: Uint32Array): Float32Array {
  const corners = welded.length, triangles = corners / 3, vertexCount = positions.length / 3;
  const normal = part.normal ? part.normal.array : null;
  const faces = new Float64Array(triangles * 3);
  const flat = new Uint8Array(triangles);
  for (let t = 0; t < triangles; t++) {
    faceNormal(positions, welded[t * 3]!, welded[t * 3 + 1]!, welded[t * 3 + 2]!, faces, t * 3);
    flat[t] = !normal || flatAt(part, normal, t * 3) ? 1 : 0;
  }
  // The part's corners at each welded vertex, in compressed rows.
  const starts = new Int32Array(vertexCount + 1);
  for (let i = 0; i < corners; i++) starts[welded[i]! + 1]!++;
  for (let v = 0; v < vertexCount; v++) starts[v + 1] = starts[v + 1]! + starts[v]!;
  const at = starts.slice(0, vertexCount), cornersAt = new Int32Array(corners);
  for (let i = 0; i < corners; i++) cornersAt[at[welded[i]!]!++] = i;
  const out = new Float32Array(level.length * 3);
  const own = new Float64Array(3);
  for (let t = 0; t < level.length; t += 3) {
    faceNormal(positions, level[t]!, level[t + 1]!, level[t + 2]!, own, 0);
    for (let k = 0; k < 3; k++) {
      const v = level[t + k]!;
      let best = -1, bestDot = -Infinity;
      for (let j = starts[v]!; j < starts[v + 1]!; j++) {
        const c = cornersAt[j]!, f = Math.floor(c / 3) * 3;
        const d = faces[f]! * own[0]! + faces[f + 1]! * own[1]! + faces[f + 2]! * own[2]!;
        if (d > bestDot) { bestDot = d; best = c; }
      }
      const o = (t + k) * 3;
      const f = Math.floor(best / 3);
      if (best < 0 || flat[f] || !normal) {
        // A flat corner takes its own triangle's face; one without area the face it was matched with.
        const source = own[0] !== 0 || own[1] !== 0 || own[2] !== 0 || best < 0 ? own : faces.subarray(f * 3, f * 3 + 3);
        out[o] = source[0]!; out[o + 1] = source[1]!; out[o + 2] = source[2]!;
      } else {
        const n = cornerVertex(part, best) * 3;
        out[o] = normal[n]!; out[o + 1] = normal[n + 1]!; out[o + 2] = normal[n + 2]!;
      }
    }
  }
  return out;
}

/** A part's coarser levels from its arrays: what `PartLevelMaker` made on the page, made here. Every part is welded by place and colour alone, and
 *  each level's corners take their normals from the part's own (`normalsFrom`), indexed again: welded with its normals a part is all seams
 *  where its faces are flat (meshoptimizer README: "faceted meshes" get "stuck"; the bus's and the truck's shells never simplified,
 *  2026-10-24), and a smooth body welded with its normals kept 696 triangles of a sedan's shell at 20 cm, 337 without (2026-10-25). `_weld`
 *  names what the part is (`Weld`); the levels are made the same way for both. */
export function partLevelArrays(part: PartArrays, _weld: Weld): PartLevels {
  const copy = new BufferGeometry();
  copy.setAttribute('position', attributeOf(part.position));
  if (part.color) copy.setAttribute('color', attributeOf(part.color));
  if (part.index) copy.setIndex(new BufferAttribute(part.index, 1));
  const count = copy.getAttribute('position').count;
  if (!copy.getAttribute('color')) copy.setAttribute('color', new Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  const welded = weldGeometry(copy, 1e-4);
  const position = welded.getAttribute('position') as BufferAttribute;
  const colour = welded.getAttribute('color') as BufferAttribute;
  const weldedIndex = welded.getIndex()!.array as ArrayLike<number>;
  const stride = 3;
  const attributes = new Float32Array(position.count * stride);
  for (let v = 0; v < position.count; v++) {
    attributes[v * stride] = colour.getX(v);
    attributes[v * stride + 1] = colour.getY(v);
    attributes[v * stride + 2] = colour.getZ(v);
  }
  const positions = new Float32Array(position.array as ArrayLike<number>);
  // What the levels are made of: the part's triangles anyone sees (`vehicleSeen.ts`; all of them when not told). A triangle no one sees need
  // not be drawn by a level, and every level drawn is measured against what is seen of the part.
  const seen = part.occluders ? seenTriangles(partSoup(part), part.occluders) : null;
  const drawnIndex = seen ? new Uint32Array(Array.from(weldedIndex).filter((_, i) => seen[Math.floor(i / 3)] === 1)) : new Uint32Array(weldedIndex);
  const indices = ladderIndices({ positions, attributes, weights: new Array<number>(stride).fill(ATTRIBUTE_WEIGHT), index: drawnIndex, errors: [...LEVEL_ERRORS] });
  const levels: LevelArrays[] = [];
  let finer = (part.index ? part.index.length : count) / 3;
  for (const index of indices) {
    const triangles = index.length / 3;
    if (triangles > finer * WORTH) { levels.push('same'); continue; }
    // Its own corners, each with its colour and the normal the part shades it with (`normalsFrom`), then indexed again: corners equal in
    // place, colour and normal are one vertex (a box's face keeps its four, not six).
    const p = new Float32Array(index.length * 3), c = new Float32Array(index.length * 3);
    for (let i = 0; i < index.length; i++) {
      const v = index[i]!;
      p[i * 3] = positions[v * 3]!; p[i * 3 + 1] = positions[v * 3 + 1]!; p[i * 3 + 2] = positions[v * 3 + 2]!;
      c[i * 3] = colour.getX(v); c[i * 3 + 1] = colour.getY(v); c[i * 3 + 2] = colour.getZ(v);
    }
    const corners = new BufferGeometry();
    corners.setAttribute('position', new BufferAttribute(p, 3));
    corners.setAttribute('color', new BufferAttribute(c, 3));
    corners.setAttribute('normal', new BufferAttribute(normalsFrom(part, weldedIndex, positions, index), 3));
    const drawn = weldGeometry(corners, SAME_CORNER);
    drawn.computeBoundingSphere();
    const s = drawn.boundingSphere!;
    levels.push({
      position: arrayOf(drawn.getAttribute('position')), color: arrayOf(drawn.getAttribute('color')), normal: arrayOf(drawn.getAttribute('normal')),
      index: new Uint32Array(drawn.getIndex()!.array as ArrayLike<number>), sphere: [s.center.x, s.center.y, s.center.z, s.radius],
    });
    finer = triangles;
  }
  return { levels };
}

/** The buffers a part's levels hold, to be moved to the page. */
export function levelBuffers(made: PartLevels): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const l of made.levels) {
    if (l === 'same') continue;
    for (const a of [l.position, l.color, l.normal]) out.add(a.array.buffer as ArrayBuffer);
    out.add(l.index.buffer as ArrayBuffer);
  }
  return [...out];
}
