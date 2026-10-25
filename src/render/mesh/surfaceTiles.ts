import { Box3, BufferGeometry, Sphere, type Material, type Mesh } from 'three';
import { type GeometryArrays, gpuOnly } from './gpuOnly';
import { type BlockArrays, type BlockLevels, type BlockLock, LOD_KEY, coarseArrays, coarseGeometry, makeFar } from './roadLod';
import { readsRoadSection } from './roadEdges';
import { finish, type SurfaceMeshOptions, type Tile, type TileRect } from './surfaceMesh';

/** A road's or a node's slot in its document as the paint's table holds it (`roadPaint.ts` resolverOf): a tile carries its document's own. */
export type SlotsOf = (slot: number) => number;
/** Tiles made with no document (a test's by hand): the slots they carry are the table's. */
export const TABLE_SLOTS: SlotsOf = (slot) => slot;

/** The attributes a surface's material reads besides position, normal and uv: no other is sent to the GPU. */
interface SurfaceReads {
  readonly color: boolean;
  readonly section: boolean;
}

/** What `material` reads: the vertex colour only with `vertexColors` (three defines USE_COLOR from it), the section only with the road edges. */
function readsOf(material: Material | Material[]): SurfaceReads {
  const one = Array.isArray(material) ? material : [material];
  return { color: one.some((m) => m.vertexColors), section: one.some(readsRoadSection) };
}

/** A section's third number as the GPU reads it: a road's slot (0 and up) and a plate's (`-2 - slot`) in the table (`slots`), -1 none. */
function tableSlot(z: number, slots: SlotsOf): number {
  return z >= 0 ? slots(z) : z <= -2 ? -2 - slots(-2 - z) : z;
}

/** Numbers a vertex's section takes in a block: the three a tile carries (`tileMesh.ts` meshPiece) and its surface's code (`Tile.code`). */
export const SECTION_SIZE = 4;

/** A surface's tiles, in order, as one mesh's arrays (the indices shifted), with only what its material reads; null for none. Each vertex's slot
 *  given as the table holds it (`slots`): the tiles carry their document's own (`roadPaint.ts`); its section's fourth number its tile's surface's
 *  code in the road material (`Tile.code`, 0 where none is given: `mesh/roadEdges.ts` ROAD_CODE). */
function tileArrays(parts: readonly Tile[], reads: SurfaceReads, slots: SlotsOf): BlockArrays | null {
  let vertices = 0;
  let count = 0;
  for (const tile of parts) {
    vertices += tile.positions.length / 3;
    count += tile.indices.length;
  }
  if (count === 0) return null;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const uv = new Float32Array(vertices * 2);
  const color = reads.color ? new Float32Array(vertices * 3) : undefined;
  const roadSection = reads.section ? new Float32Array(vertices * SECTION_SIZE) : undefined;
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0;
  let k = 0;
  for (const tile of parts) {
    position.set(tile.positions, v * 3);
    normal.set(tile.normals, v * 3);
    uv.set(tile.uvs, v * 2);
    const n = tile.positions.length / 3;
    // A tile with no tint is white, one with no section has none (`tileMesh.ts` meshPiece): what it would have carried.
    if (color) { if (tile.colors.length) color.set(tile.colors, v * 3); else color.fill(1, v * 3, (v + n) * 3); }
    if (roadSection) {
      const code = tile.code ?? 0;
      for (let i = 0; i < n; i++) {
        const at = (v + i) * SECTION_SIZE;
        if (tile.sections.length) {
          roadSection[at] = tile.sections[i * 3]!; roadSection[at + 1] = tile.sections[i * 3 + 1]!; roadSection[at + 2] = tableSlot(tile.sections[i * 3 + 2]!, slots);
        } else { roadSection[at] = 0; roadSection[at + 1] = -1; roadSection[at + 2] = -1; }
        roadSection[at + 3] = code;
      }
    }
    const local = tile.indices;
    for (let i = 0; i < local.length; i++) index[k++] = (local[i] as number) + v;
    v += tile.positions.length / 3;
  }
  return { position, normal, uv, ...(color ? { color } : {}), ...(roadSection ? { roadSection } : {}), index };
}

/** DO NOT pass a source that returns `parts`: the closure would hold every tile's arrays for as long as the mesh lives. */
export function mergeTiles(parts: readonly Tile[], options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>, source: () => readonly Tile[], slots: SlotsOf,
  far?: { readonly lock: BlockLock; readonly near: boolean; readonly start?: (mesh: Mesh, arrays: BlockArrays) => void;
    /** The other surfaces' blocks' boxes, for a block of several (`BlockLevels.also`). */
    readonly also?: readonly (readonly [number, number, number, number])[];
    /** The road block's cell (`BlockLevels.cell`). */
    readonly cell?: string }): Mesh | null {
  const arrays = tileArrays(parts, readsOf(options.material), slots);
  if (!arrays) return null;
  const geometry = coarseGeometry(arrays);
  // Bounded by its tiles' boxes, made with them in the worker (`tileMesh.ts`)
  if (parts.every((tile) => tile.box)) {
    const box = new Box3();
    for (const tile of parts) {
      const b = tile.box!;
      if (b[0]! > b[3]!) continue;
      box.min.set(Math.min(box.min.x, b[0]!), Math.min(box.min.y, b[1]!), Math.min(box.min.z, b[2]!));
      box.max.set(Math.max(box.max.x, b[3]!), Math.max(box.max.y, b[4]!), Math.max(box.max.z, b[5]!));
    }
    geometry.boundingBox = box;
    geometry.boundingSphere = box.getBoundingSphere(new Sphere());
  }
  const mesh = finish(geometry, options);
  tilesOnGpu(mesh, source, slots);
  if (far) {
    // DO NOT simplify it here, a block after the other on the page.
    mesh.userData[LOD_KEY] = {
      coarse: null, x: (far.lock.box[0] + far.lock.box[2]) / 2, z: -(far.lock.box[1] + far.lock.box[3]) / 2, full: true,
      ...(far.also?.length ? { also: far.also.map((b): [number, number] => [(b[0] + b[2]) / 2, -(b[1] + b[3]) / 2]) } : {}),
      ...(far.cell !== undefined ? { cell: far.cell } : {}),
    } satisfies BlockLevels;
    far.start?.(mesh, arrays);
  }
  return mesh;
}

/** Numbers a vertex's section takes in a block's arrays: `SECTION_SIZE` as merged here, three in arrays made by hand (a test's). */
function sectionSize(arrays: BlockArrays): number {
  const vertices = arrays.position.length / 3;
  return arrays.roadSection && vertices > 0 ? arrays.roadSection.length / vertices : SECTION_SIZE;
}

/** A block's arrays copied: what a worker is handed to simplify while the block keeps its own. */
export function cloneBlock(arrays: BlockArrays): BlockArrays {
  return {
    position: arrays.position.slice(), normal: arrays.normal.slice(), uv: arrays.uv.slice(),
    ...(arrays.color ? { color: arrays.color.slice() } : {}), ...(arrays.roadSection ? { roadSection: arrays.roadSection.slice() } : {}),
    index: arrays.index.slice(),
  };
}

/** A surface's share of a block: its tiles' vertices and indices (`memberSizes`). */
export interface MemberSize { readonly vertices: number; readonly count: number }

/** Each surface's share of a block, from its tiles (in the order they were merged): what `splitBlock` cuts by, without the tiles. */
export function memberSizes(members: readonly (readonly Tile[])[]): MemberSize[] {
  return members.map((tiles) => {
    let vertices = 0, count = 0;
    for (const tile of tiles) { vertices += tile.positions.length / 3; count += tile.indices.length; }
    return { vertices, count };
  });
}

/** A block's arrays cut back into its surfaces' (`members`: each surface's share, in the order they were merged), each a copy: what a block
 *  of several surfaces drawn alike hands its workers to simplify, a surface at a time, as each was simplified when it was a block of its own. */
export function splitBlock(arrays: BlockArrays, members: readonly MemberSize[]): BlockArrays[] {
  const out: BlockArrays[] = [];
  let v = 0, k = 0;
  for (const { vertices, count } of members) {
    const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) index[i] = arrays.index[k + i]! - v;
    const cut = (a: Float32Array, size: number): Float32Array => a.slice(v * size, (v + vertices) * size);
    out.push({
      position: cut(arrays.position, 3), normal: cut(arrays.normal, 3), uv: cut(arrays.uv, 2),
      ...(arrays.color ? { color: cut(arrays.color, 3) } : {}), ...(arrays.roadSection ? { roadSection: cut(arrays.roadSection, sectionSize(arrays)) } : {}), index,
    });
    v += vertices;
    k += count;
  }
  return out;
}

/** Blocks' arrays end to end, as one mesh's (the indices shifted). */
export function joinBlocks(parts: readonly BlockArrays[]): BlockArrays {
  if (parts.length === 1) return parts[0]!;
  let vertices = 0, count = 0;
  for (const part of parts) { vertices += part.position.length / 3; count += part.index.length; }
  const join = (pick: (part: BlockArrays) => Float32Array | undefined, size: number): Float32Array | undefined => {
    if (!pick(parts[0]!)) return undefined;
    const out = new Float32Array(vertices * size);
    let at = 0;
    for (const part of parts) { out.set(pick(part)!, at); at += (part.position.length / 3) * size; }
    return out;
  };
  const index = vertices > 0xffff ? new Uint32Array(count) : new Uint16Array(count);
  let v = 0, k = 0;
  for (const part of parts) {
    for (let i = 0; i < part.index.length; i++) index[k++] = part.index[i]! + v;
    v += part.position.length / 3;
  }
  const color = join((p) => p.color, 3), roadSection = join((p) => p.roadSection, sectionSize(parts[0]!));
  return {
    position: join((p) => p.position, 3)!, normal: join((p) => p.normal, 3)!, uv: join((p) => p.uv, 2)!,
    ...(color ? { color } : {}), ...(roadSection ? { roadSection } : {}), index,
  };
}

/** One surface of a block: its pieces, and what of it is kept where it is when it is simplified (`coarseArrays`: its box's edge, its seams). */
export interface BlockMember {
  readonly source: () => readonly Tile[];
  /** Where its tiles' slots are in the paint's table (`tileArrays`). */
  readonly slots: SlotsOf;
  readonly lock: BlockLock;
  /** Its tiles at the far level where some of its pieces are drawn coarser there (a junction's, `roads/pieceMesh.ts` farTileName): what the far
   *  level is made from, not the full level's. */
  readonly far?: () => readonly Tile[];
}

/** The block's far level (`roadLod.ts`) as it arrives from its worker; `members`, each surface it draws (one, or several drawn alike), each simplified on its own. */
export function attachFarLevel(mesh: Mesh, coarse: BlockArrays, options: Pick<SurfaceMeshOptions,
  'name' | 'material' | 'castShadow' | 'receiveShadow'>, members: readonly BlockMember[], near: boolean): Mesh {
  const level = finish(coarseGeometry(coarse), { ...options, name: `${options.name}-far` });
  // Made again from the block's tiles when a lost context asks, like the block's own. DO NOT fall back on `coarse`: the closure held the worker's arrays on the page for the block's life, after they were on the GPU.
  const reads = readsOf(options.material);
  /** Tiles that do not simplify: the far level's own arrays where it was made of them whole (a block too small to gain, `roadSurfaces.ts` start),
   *  of its sizes else. DO NOT give such a block zeros: its far level drew nothing after a lost context. */
  const unsimplified = (full: BlockArrays): GeometryArrays => {
    const g = level.geometry;
    return full.index.length === g.index?.count && full.position.length === g.getAttribute('position').count * 3 ? full : emptyLike(level);
  };
  const again: () => GeometryArrays = members.length === 1
    ? () => { const m = members[0]!, full = tileArrays((m.far ?? m.source)(), reads, m.slots)!; return coarseArrays(full, m.lock) ?? unsimplified(full); }
    // A surface too small to simplify is drawn whole in the far level, as its own block was.
    : () => joinBlocks(members.flatMap(({ source, slots, far, lock }) => { const full = tileArrays((far ?? source)(), reads, slots); return full ? [coarseArrays(full, lock) ?? full] : []; }));
  level.userData[FAR_AGAIN] = again;
  gpuOnly(level, again);
  const levels = mesh.userData[LOD_KEY] as BlockLevels;
  (levels as { coarse: Mesh | null }).coarse = level;
  level.renderOrder = mesh.renderOrder;
  level.visible = !near;
  mesh.parent?.add(level);
  if (!near) makeFar(mesh);
  return level;
}

/** Where a far level keeps how its arrays are made again from its tiles on the page (`attachFarLevel`, `restoreFarLevel`). */
const FAR_AGAIN = 'farAgain';

/**
 * A far level let go (`roadResidency.ts` dropCell) made again: its geometry replaced by one of `arrays` (made off the page, `BlockLevels.remake`),
 * or, none given, of its tiles cut again here. A new geometry, not the old one refilled: the arrays made again need not be as many as the
 * first (another simplification's count), and three draws an attribute by the count it was made with (`BufferAttribute.count`).
 */
export function restoreFarLevel(level: Mesh, arrays: BlockArrays | null): void {
  const again = level.userData[FAR_AGAIN] as (() => GeometryArrays) | undefined;
  const made = arrays ?? (again?.() as BlockArrays | undefined);
  if (!made) return;
  const old = level.geometry;
  const geometry = coarseGeometry(made);
  if (old.boundingBox) geometry.boundingBox = old.boundingBox.clone();
  if (old.boundingSphere) geometry.boundingSphere = old.boundingSphere.clone();
  old.dispose();
  level.geometry = geometry;
  if (again) gpuOnly(level, again);
}

/** A mesh's arrays at their sizes, all zero (every triangle of no area): what a far level the tiles no longer simplify to is given back, never the arrays it was made with. */
function emptyLike(mesh: Mesh): Record<string, ArrayLike<number>> {
  const g = mesh.geometry;
  const out: Record<string, ArrayLike<number>> = {};
  for (const [name, attribute] of Object.entries(g.attributes)) out[name] = new Float32Array(attribute.count * attribute.itemSize);
  // Of the type it was made with: by its vertices (`roadLodPure.ts` coarse index).
  if (g.index) out.index = (g.getAttribute('position')?.count ?? 0) > 0xffff ? new Uint32Array(g.index.count) : new Uint16Array(g.index.count);
  return out;
}

/** A block's arrays from its tiles as kept (the store's), for the attributes its material reads: a copy end to end, nothing cut (`roadResidency.ts` makeNear). */
export function blockArraysOf(tiles: readonly Tile[], material: Material, slots: SlotsOf): BlockArrays | null {
  return tileArrays(tiles, readsOf(material), slots);
}

/** A merged mesh's arrays let go once on the GPU, and made again from `source`'s tiles when asked (`gpuOnly`). */
export function tilesOnGpu(mesh: Mesh, source: () => readonly Tile[], slots: SlotsOf): void {
  const reads = readsOf(mesh.material);
  gpuOnly(mesh as Mesh & { geometry: BufferGeometry }, () => tileArrays(source(), reads, slots)!);
}

/** The box round a block's tiles' rectangles, [minX, minY, maxX, maxY]. */
export function blockBox(rects: readonly TileRect[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) { minX = Math.min(minX, r[0]); minY = Math.min(minY, r[1]); maxX = Math.max(maxX, r[2]); maxY = Math.max(maxY, r[3]); }
  return [minX, minY, maxX, maxY];
}
