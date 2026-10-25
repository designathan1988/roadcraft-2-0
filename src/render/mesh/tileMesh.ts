import { type Stream, doubles, indices as indexStream } from './stream';
import type { Sampler } from './stripShape';
import { hypot2 } from '@core/hypot';
import { m } from '@world/units';

/** How far a surface may stand off its triangles: a pixel at the nearest street view (`cameraProfile.ts`). */
export const HEIGHT_TOL = m(0.01);
/** How far a tint may stand off its triangle's blend before a vertex is put where it changes (a class's colour against another at a junction). */
const TINT_TOL = 0.04;
/** The least edge a tint's or a mark's change is resolved to: the grid of half a terrain cell it was drawn on before (`roadSurfacePass.ts`). */
const MARK_EDGE = m(3.2);

/** A ROAD PIECE'S SURFACE MESHED FROM ITS SHAPE (`roads/pieceMesh.ts`) */

/** An axis-aligned rectangle, [minX, minY, maxX, maxY]: a piece's box, a block's square (`roadSurfaceEntries.ts` CELL). */
export type TileRect = readonly [number, number, number, number];

/** One run of triangles: its vertices, its triangles, and whether they run clockwise. */
export interface PieceShape {
  readonly xy: Float64Array;
  readonly tris: Uint32Array;
  readonly flip: boolean;
  /** A junction's plate: off every road's section (`TileMeshOptions.plateOffRoad`). */
  readonly plate?: boolean;
  /** Each vertex's place across its road written in place of the section's first number (`TileMeshOptions.section`): a junction's footway corner's
   *  distance from its kerb's line, which no road's frame reads (`roads/pieceMesh.ts`). */
  readonly across?: Float64Array;
}
/** One ring of an outline's walls: its edges [ax, ay, bx, by, ...], with its polygon's winding (the outside on an edge's right when not `flip`). */
export interface SkirtRing {
  readonly flip: boolean;
  readonly edges: Float64Array;
  /** The way each edge's two ends face on the plan (nx, ny at a, then at b: four numbers an edge; NaN: the edge's own): a kerb's return lit round,
   *  each of its quads' ends facing out from the return's centre as the owner's road tool lights it (`normalAt`). None: each edge its own. */
  readonly normals?: Float64Array;
}
/** A surface's shape: its runs of triangles and, for a surface with a bottom, its walls. */
export interface SurfaceShape {
  readonly pieces: readonly PieceShape[];
  readonly skirts: readonly SkirtRing[] | null;
}

export type HeightFn = (x: number, y: number) => number;
/** `u` runs across the surface and `v` along it, both in world units. */
export type UvFn = (x: number, y: number, out: [number, number]) => void;
/** The UV of (x, y), in the frame of whichever road is nearest to (pickX, pickY) rather than to the point itself. */
export type UvFrameFn = (x: number, y: number, pickX: number, pickY: number, out: [number, number]) => void;
/** Writes a linear RGB tint for one vertex. */
export type TintFn = (x: number, y: number, out: [number, number, number]) => void;

/** What a tile's mesh reads per vertex (`SurfaceMeshOptions` without its polygons and material). */
export interface TileMeshOptions {
  /** Height of the visible top face. */
  readonly top: HeightFn;
  /** Height of the bottom face of the skirt drawn down from the boundary. */
  readonly bottom?: HeightFn;
  readonly uv: UvFn;
  /** Keeps every triangle inside ONE texture frame: the frame of the road nearest its middle (`meshPiece`). */
  readonly uvFrame?: UvFrameFn;
  /** Per-vertex tint, multiplied into the material's colour. */
  readonly tint?: TintFn;
  /** Per-vertex place in the road's cross-section, for the material's marks along its edges; its third number -1 off any road. */
  readonly section?: TintFn;
  /** `section` in the frame of the road nearest (pickX, pickY): a triangle whose corners read different roads is read all of it on one. */
  readonly sectionFrame?: (x: number, y: number, pickX: number, pickY: number, out: [number, number, number]) => void;
  /** Extra UV scale for the skirt, so its texture is not stretched. */
  readonly skirtUvScale?: number;
  /** The shortest stretch a rise of the surface is resolved to (`stripShape.ts` stationsOf). */
  readonly leastEdge: number;
  /** A junction's plate is off every road's section (the carriageway: its marks stop at the mouth line): written so, not read. */
  readonly plateOffRoad?: boolean;
  /** What a plate's vertices are written with instead of off every road (`plateOffRoad`): its node's place in the paint's table, for the marks
   *  painted on it (`roadSurfaceReads.ts` asphaltPlate, `roadMarks.ts`). */
  readonly plateSection?: TintFn;
  /** Drawn as a raised deck: its shapes' deck walls stand (`roads/pieceGeom.ts` deckWalls), and a ground road's outer edge is a deck's side. */
  readonly deck?: boolean;
  /** Chains a strip of it is cut into across (`roads/pieceMesh.ts`): a surface whose height is not a plane between its two edges;
   *  the same count for every piece, so a road's band and the junction's meet with the same vertices across their mouth. None: one. */
  readonly across?: number;
}

/** What a surface varies in (`stripShape.ts` stationsOf): its height; whether its section is on a road (where its edge marks start); its tint; on its outline
 *  the foot of its skirt (the side of a deck is seen from below and beside: its foot follows the soffit as its top follows the surface). */
export function surfaceSampler(options: TileMeshOptions): Sampler {
  const { top, section, tint, bottom } = options;
  const size = 1 + (section ? 1 : 0) + (tint ? 3 : 0) + (bottom ? 1 : 0);
  const tolerance = [HEIGHT_TOL, ...(section ? [0.25] : []), ...(tint ? [TINT_TOL, TINT_TOL, TINT_TOL] : []), ...(bottom ? [HEIGHT_TOL] : [])];
  const floor = [options.leastEdge, ...(section ? [MARK_EDGE] : []), ...(tint ? [MARK_EDGE, MARK_EDGE, MARK_EDGE] : []), ...(bottom ? [options.leastEdge] : [])];
  const outline = [false, ...(section ? [false] : []), ...(tint ? [false, false, false] : []), ...(bottom ? [true] : [])];
  const cut: [number, number, number] = [0, -1, -1], rgb: [number, number, number] = [1, 1, 1];
  return {
    size, tolerance, floor, outline,
    sample(x, y, out) {
      out[0] = top(x, y);
      let k = 1;
      if (section) { section(x, y, cut); out[k++] = cut[2] >= 0 ? 1 : 0; }
      if (tint) { tint(x, y, rgb); out[k++] = rgb[0]; out[k++] = rgb[1]; out[k++] = rgb[2]; }
      if (bottom) out[k] = bottom(x, y);
    },
  };
}

/** Vertex and index streams of a mesh under construction: the attributes as the doubles they are computed in (the float32 the mesh stores is taken when it is welded, `weldVertices`). */
interface Streams {
  readonly positions: Stream<Float64Array>;
  readonly normals: Stream<Float64Array>;
  readonly uvs: Stream<Float64Array>;
  readonly colors: Stream<Float64Array>;
  readonly sections: Stream<Float64Array>;
  readonly indices: Stream<Uint32Array>;
}

const streams = (): Streams => ({ positions: doubles(), normals: doubles(), uvs: doubles(), colors: doubles(), sections: doubles(), indices: indexStream() });

/** The streams' arrays as written (`Stream.view`). */
function streamArrays(out: Streams): { positions: Float64Array; normals: Float64Array; uvs: Float64Array; colors: Float64Array; sections: Float64Array; indices: Uint32Array } {
  return { positions: out.positions.view(), normals: out.normals.view(), uvs: out.uvs.view(), colors: out.colors.view(), sections: out.sections.view(), indices: out.indices.view() };
}

/** One build's options and the scratch its callbacks write into. */
interface Context {
  /** Its polygons are not read here: their shape is (`roads/pieceMesh.ts`). */
  readonly options: TileMeshOptions;
  readonly uv: [number, number];
  /** White until a tint writes it, so an untinted surface is written white. */
  readonly rgb: [number, number, number];
  /** The cross-section's three numbers (`section`), none until written. */
  readonly cut: [number, number, number];
}

/** The top face of one run of triangles (`roads/pieceMesh.ts`) */
function meshPiece(piece: PieceShape, context: Context, out: Streams): void {
  const { options, uv: scratch, rgb, cut } = context;
  const { top, uv, tint, section } = options;
  const { positions, normals, uvs, colors, sections, indices } = out;
  const { xy, tris, flip } = piece;
  const base = positions.length / 3;
  for (let i = 0; i < xy.length / 2; i++) {
    const x = xy[i * 2] as number;
    const y = xy[i * 2 + 1] as number;
    positions.push3(x, top(x, y), -y);
    uv(x, y, scratch);
    uvs.push2(scratch[0], scratch[1]);
    normals.push3(0, 1, 0);
    // A surface with no tint nor section carries neither: one value everywhere, filled where a material reads it (`surfaceTiles.ts` tileArrays).
    if (tint) { tint(x, y, rgb); colors.push3(rgb[0], rgb[1], rgb[2]); }
    if (section) {
      if (piece.plate && options.plateOffRoad) {
        if (options.plateSection) { options.plateSection(x, y, cut); sections.push3(cut[0], cut[1], cut[2]); } else sections.push3(0, -1, -1);
      }
      else { section(x, y, cut); sections.push3(piece.across ? piece.across[i]! : cut[0], cut[1], cut[2]); }
    }
  }
  // World Y is mirrored into three's Z.
  for (let i = 0; i < tris.length; i += 3) {
    let a = base + (tris[i] as number);
    let b = base + (tris[i + 1] as number);
    let c = base + (tris[i + 2] as number);
    const uvApart = !!options.uvFrame && !inOneFrame(positions.data, uvs.data, a, b, c, options.uvFrame, context.uv);
    // Corners on different roads (their third section numbers, the road's place in the paint's table, differ).
    const q = sections.data;
    const ra = q[a * 3 + 2]!, rb = q[b * 3 + 2]!, rc = q[c * 3 + 2]!;
    const roadsApart = !!options.sectionFrame && ((ra >= 0 && rb >= 0 && ra !== rb) || (rb >= 0 && rc >= 0 && rb !== rc) || (ra >= 0 && rc >= 0 && ra !== rc));
    if (uvApart || roadsApart) {
      const p = positions.data;
      const cx = (p[a * 3]! + p[b * 3]! + p[c * 3]!) / 3;
      const cy = -(p[a * 3 + 2]! + p[b * 3 + 2]! + p[c * 3 + 2]!) / 3;
      // Each corner copied in the frame of the road nearest the triangle's middle (no array a triangle: `copyCorner`).
      a = copyCorner(a, cx, cy, context, out);
      b = copyCorner(b, cx, cy, context, out);
      c = copyCorner(c, cx, cy, context, out);
    }
    if (flip) indices.push3(a, c, b);
    else indices.push3(a, b, c);
  }
}

/** A corner `v` copied with its UV in the frame of the road nearest (cx, cy) (`TileMeshOptions.uvFrame`): the copy's index. */
function copyCorner(v: number, cx: number, cy: number, context: Context, out: Streams): number {
  const { options, uv: scratch } = context;
  const { positions, normals, uvs, colors, sections } = out;
  // Read again for each corner: a push may have grown the arrays.
  const x = positions.data[v * 3]!;
  const y = -positions.data[v * 3 + 2]!;
  positions.push3(x, positions.data[v * 3 + 1]!, -y);
  if (options.uvFrame) { options.uvFrame(x, y, cx, cy, scratch); uvs.push2(scratch[0], scratch[1]); }
  else uvs.push2(uvs.data[v * 2]!, uvs.data[v * 2 + 1]!);
  normals.push3(0, 1, 0);
  if (options.tint) colors.push3(colors.data[v * 3]!, colors.data[v * 3 + 1]!, colors.data[v * 3 + 2]!);
  if (options.sectionFrame && sections.data[v * 3 + 2]! >= 0) { options.sectionFrame(x, y, cx, cy, context.cut); sections.push3(context.cut[0], context.cut[1], context.cut[2]); }
  else if (options.section) sections.push3(sections.data[v * 3]!, sections.data[v * 3 + 1]!, sections.data[v * 3 + 2]!);
  return positions.length / 3 - 1;
}

/** The walls hung from a surface's outline down to `bottom`, along the edges of its shape (`roads/pieceMesh.ts`). */
function meshSkirts(skirts: readonly SkirtRing[], context: Context, out: Streams): void {
  const { options, rgb } = context;
  const { top, tint, section } = options;
  const bottom = options.bottom;
  if (!bottom) return;
  const { positions, normals, uvs, colors, sections, indices } = out;
  const scale = options.skirtUvScale ?? 1;
  for (const { flip, edges, normals: facing } of skirts) {
    let run = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const ax = edges[e] as number;
      const ay = edges[e + 1] as number;
      const bx = edges[e + 2] as number;
      const by = edges[e + 3] as number;
      const span = hypot2(bx - ax, by - ay);
      const sign = flip ? -1 : 1;
      const nx = (sign * (by - ay)) / span;
      const nz = (sign * (bx - ax)) / span;
      const topA = top(ax, ay);
      const topB = top(bx, by);
      // A tolerance lower than its foot: the surface it stands on may be refined at other points of the edge and lie that much under this chord.
      const lowA = bottom(ax, ay) - HEIGHT_TOL;
      const lowB = bottom(bx, by) - HEIGHT_TOL;
      const side = positions.length / 3;
      positions.push3(ax, topA, -ay); positions.push3(bx, topB, -by); positions.push3(bx, lowB, -by); positions.push3(ax, lowA, -ay);
      if (tint) { tint((ax + bx) / 2, (ay + by) / 2, rgb); for (let n = 0; n < 4; n++) colors.push3(rgb[0], rgb[1], rgb[2]); }
      // A skirt has no place in the section: none (written only for a surface whose top carries one).
      if (section) for (let n = 0; n < 4; n++) sections.push3(0, -1, -1);
      // Written rather than averaged, so a kerb keeps its hard edge instead of smearing into the surface above it; a return's ends as it gives them
      // (`SkirtRing.normals`, on the plan: three's z is -y), its top and its foot alike.
      const fa = facing && !Number.isNaN(facing[e]!) ? [facing[e]!, -facing[e + 1]!] : [nx, nz];
      const fb = facing && !Number.isNaN(facing[e + 2]!) ? [facing[e + 2]!, -facing[e + 3]!] : [nx, nz];
      normals.push3(fa[0]!, 0, fa[1]!); normals.push3(fb[0]!, 0, fb[1]!); normals.push3(fb[0]!, 0, fb[1]!); normals.push3(fa[0]!, 0, fa[1]!);
      const u0 = run / scale;
      const u1 = (run + span) / scale;
      uvs.push2(u0, topA / scale); uvs.push2(u1, topB / scale); uvs.push2(u1, lowB / scale); uvs.push2(u0, lowA / scale);
      run += span;
      // Wound so the face looks the same way as the normal written above.
      if (flip) { indices.push3(side, side + 1, side + 2); indices.push3(side, side + 2, side + 3); }
      else { indices.push3(side, side + 2, side + 1); indices.push3(side, side + 3, side + 2); }
    }
  }
}

// ------------------------------------------------------------------ tiles

/** One tile's worth of a surface: its top faces and the skirts along its part of the outline */
export interface Tile {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  /** Empty for a surface with no tint (one colour, white) or no section (none: 0, -1, -1): filled where a material reads it (`surfaceTiles.ts` tileArrays). */
  readonly colors: Float32Array;
  readonly sections: Float32Array;
  /** Local to the tile. */
  readonly indices: Uint32Array;
  /** The tile's box, [minX, minY, minZ, maxX, maxY, maxZ] of its positions, made with it (in the worker) */
  readonly box?: Float32Array;
  /** The surface's code in the road material (`mesh/roadEdges.ts` ROAD_CODE), written in its vertices' section as a block is merged
   *  (`surfaceTiles.ts`): given by the block that merges it, never by its piece (a tile is meshed, kept and handed over without it). */
  readonly code?: number;
}

/** One part of a surface from its shape (`roads/pieceMesh.ts`, made here or by a worker, `roadTile.worker.ts`): its top faces, then its walls. */
export function meshShape(shape: SurfaceShape, options: TileMeshOptions): Tile {
  const context: Context = { options, uv: [0, 0], rgb: [1, 1, 1], cut: [0, -1, -1] };
  const out = streams();
  for (const piece of shape.pieces) meshPiece(piece, context, out);
  // No vertex is shared with another part, so the smoothing is the one the whole mesh would get.
  smoothTopNormals(out.positions.view(), out.normals.view(), out.indices.view());
  if (shape.skirts) meshSkirts(shape.skirts, context, out);
  const welded = weldVertices(streamArrays(out));
  return { ...welded, box: boxOf(welded.positions) };
}

/** A surface's options without its section (`TileMeshOptions.plateOffRoad`: what its junctions' plates are fitted to). */
export function withoutSection(options: TileMeshOptions): TileMeshOptions {
  const { section: _section, sectionFrame: _frame, ...rest } = options;
  return rest;
}

/** DO NOT leave the vertices a triangle at a time: a copy per corner is what an unindexed mesh is. */
export function weldVertices(out: { readonly [K in 'positions' | 'normals' | 'uvs' | 'colors' | 'sections' | 'indices']: ArrayLike<number> }):
  { positions: Float32Array; normals: Float32Array; uvs: Float32Array; colors: Float32Array; sections: Float32Array; indices: Uint32Array } {
  const count = out.positions.length / 3;
  // Every attribute as the float32 the mesh stores, so equal means equal as drawn.
  const p = new Float32Array(out.positions), n = new Float32Array(out.normals), u = new Float32Array(out.uvs);
  const c = new Float32Array(out.colors), q = new Float32Array(out.sections);
  // A surface with no tint or no section carries none of it (`meshPiece`): welded by what it has.
  const hasC = c.length > 0, hasQ = q.length > 0;
  const bits = (a: Float32Array): Uint32Array => new Uint32Array(a.buffer, a.byteOffset, a.length);
  const pb = bits(p), nb = bits(n), ub = bits(u), cb = bits(c), qb = bits(q);
  // Open addressing over the vertices' hash: the table holds the index of the first vertex of each tuple.
  let size = 16;
  while (size < count * 2) size *= 2;
  const table = new Int32Array(size).fill(-1);
  const mask = size - 1;
  const remap = new Uint32Array(count);
  let kept = 0;
  const same = (i: number, j: number): boolean =>
    pb[i * 3] === pb[j * 3] && pb[i * 3 + 1] === pb[j * 3 + 1] && pb[i * 3 + 2] === pb[j * 3 + 2]
    && nb[i * 3] === nb[j * 3] && nb[i * 3 + 1] === nb[j * 3 + 1] && nb[i * 3 + 2] === nb[j * 3 + 2]
    && ub[i * 2] === ub[j * 2] && ub[i * 2 + 1] === ub[j * 2 + 1]
    && (!hasC || (cb[i * 3] === cb[j * 3] && cb[i * 3 + 1] === cb[j * 3 + 1] && cb[i * 3 + 2] === cb[j * 3 + 2]))
    && (!hasQ || (qb[i * 3] === qb[j * 3] && qb[i * 3 + 1] === qb[j * 3 + 1] && qb[i * 3 + 2] === qb[j * 3 + 2]));
  const first = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    let h = 0x811c9dc5;
    for (let k = 0; k < 3; k++) { h = Math.imul(h ^ pb[i * 3 + k]!, 0x01000193); h = Math.imul(h ^ nb[i * 3 + k]!, 0x01000193); }
    h = Math.imul(h ^ ub[i * 2]!, 0x01000193); h = Math.imul(h ^ ub[i * 2 + 1]!, 0x01000193);
    if (hasC) for (let k = 0; k < 3; k++) h = Math.imul(h ^ cb[i * 3 + k]!, 0x01000193);
    if (hasQ) for (let k = 0; k < 3; k++) h = Math.imul(h ^ qb[i * 3 + k]!, 0x01000193);
    let slot = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const at = table[slot]!;
      if (at < 0) { table[slot] = i; first[kept] = i; remap[i] = kept++; break; }
      if (same(at, i)) { remap[i] = remap[at]!; break; }
      slot = (slot + 1) & mask;
    }
  }
  const take = (src: Float32Array, size: number): Float32Array => {
    const dst = new Float32Array(kept * size);
    for (let k = 0; k < kept; k++) { const i = first[k]!; for (let a = 0; a < size; a++) dst[k * size + a] = src[i * size + a]!; }
    return dst;
  };
  const indices = new Uint32Array(out.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[out.indices[i]!]!;
  return { positions: take(p, 3), normals: take(n, 3), uvs: take(u, 2), colors: hasC ? take(c, 3) : new Float32Array(0), sections: hasQ ? take(q, 3) : new Float32Array(0), indices };
}

/** The box of a tile's positions, [minX, minY, minZ, maxX, maxY, maxZ], as three's `Box3.setFromBufferAttribute` gives it. */
function boxOf(positions: Float32Array): Float32Array {
  const box = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!;
      if (v < box[k]!) box[k] = v;
      if (v > box[k + 3]!) box[k + 3] = v;
    }
  }
  return box;
}

/** How far a corner's UV may stand off its UV in the triangle's frame and be in it. */
const FRAME_EPS = 1e-6;

/**
 * Whether a triangle's corners all carry their UV in the frame of the road nearest its middle (`TileMeshOptions.uvFrame`). DO NOT tell it by how
 * stretched its UV edges are against its world edges: a road's piece is a few large triangles (a junction's plate a fan from its middle), and a
 * triangle across two roads' frames stretched its texture by a third yet passed a test of half to twice (`tests/render/pieceMesh.spec.ts`).
 */
function inOneFrame(positions: ArrayLike<number>, uvs: ArrayLike<number>, a: number, b: number, c: number, uvFrame: UvFrameFn, scratch: [number, number]): boolean {
  const cx = (positions[a * 3]! + positions[b * 3]! + positions[c * 3]!) / 3;
  const cy = -(positions[a * 3 + 2]! + positions[b * 3 + 2]! + positions[c * 3 + 2]!) / 3;
  return onFrame(positions, uvs, a, cx, cy, uvFrame, scratch) && onFrame(positions, uvs, b, cx, cy, uvFrame, scratch)
    && onFrame(positions, uvs, c, cx, cy, uvFrame, scratch);
}

/** One corner of `inOneFrame`: a function of its own, not a closure made per triangle. */
function onFrame(positions: ArrayLike<number>, uvs: ArrayLike<number>, v: number, cx: number, cy: number, uvFrame: UvFrameFn, scratch: [number, number]): boolean {
  uvFrame(positions[v * 3]!, -positions[v * 3 + 2]!, cx, cy, scratch);
  return Math.abs(scratch[0] - uvs[v * 2]!) <= FRAME_EPS && Math.abs(scratch[1] - uvs[v * 2 + 1]!) <= FRAME_EPS;
}

/** Recomputes normals for the up-facing vertices only, in place. */
function smoothTopNormals(
  positions: ArrayLike<number>,
  normals: { [index: number]: number; readonly length: number },
  indices: ArrayLike<number>,
): void {
  // By a flag per vertex, not a Set of them: asked three times per triangle of every road tile
  const count = normals.length / 3;
  const flat = new Uint8Array(count);
  let any = false;
  for (let i = 0; i < normals.length; i += 3) {
    if (normals[i] === 0 && normals[i + 1] === 1 && normals[i + 2] === 0) { flat[i / 3] = 1; any = true; }
  }
  if (!any) return;
  const acc = new Float64Array(normals.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] as number;
    const b = indices[t + 1] as number;
    const c = indices[t + 2] as number;
    if (!flat[a] || !flat[b] || !flat[c]) continue;
    const ax = positions[a * 3] as number;
    const ay = positions[a * 3 + 1] as number;
    const az = positions[a * 3 + 2] as number;
    const ux = (positions[b * 3] as number) - ax;
    const uy = (positions[b * 3 + 1] as number) - ay;
    const uz = (positions[b * 3 + 2] as number) - az;
    const vx = (positions[c * 3] as number) - ax;
    const vy = (positions[c * 3 + 1] as number) - ay;
    const vz = (positions[c * 3 + 2] as number) - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) {
      const index = k === 0 ? a : k === 1 ? b : c;
      acc[index * 3] = (acc[index * 3] as number) + nx;
      acc[index * 3 + 1] = (acc[index * 3 + 1] as number) + ny;
      acc[index * 3 + 2] = (acc[index * 3 + 2] as number) + nz;
    }
  }
  for (let index = 0; index < count; index++) {
    if (!flat[index]) continue;
    const x = acc[index * 3] as number;
    const y = acc[index * 3 + 1] as number;
    const z = acc[index * 3 + 2] as number;
    const length = Math.hypot(x, y, z);
    if (length < 1e-9) continue;
    normals[index * 3] = x / length;
    normals[index * 3 + 1] = y / length;
    normals[index * 3 + 2] = z / length;
  }
}
