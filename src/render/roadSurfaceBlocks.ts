import type { SurfaceInputs } from './roadSurfaceInputs';
import type { PartKey, Reach } from './roadSurfaceEntries';
import type { TileSource } from './roadSurfaceReads';
import { tileBundle } from './roadSurfacePass';
import { farTileName } from './roads/pieceMesh';
import type { SurfaceMeshOptions, Tile, TileRect } from './mesh/surfaceMesh';

/** THE ROAD SURFACES' BLOCKS AS A BUILD KEEPS THEM (`roadSurfaces.ts`): a pass's parts and blocks between builds, how its surfaces are grouped into
 *  one mesh a look, and how a block's surface is made again from its pieces' shapes - plain data and pure functions. */

/** Every surface of one tile, by mesh name. */
export type TileBundle = ReadonlyMap<string, Tile>;
/** A tile kept between builds: the names of the surfaces it has. Its digest is its key. */
export type KeptTile = readonly string[];

/** One tile of a pass in a build: its digest and block, its surfaces and arrays once known. DO NOT keep its rings with it: read from the
 *  inputs when it is built (`SurfaceInputs.reachOf`, held round the view), a tile kept in the pass's state held them for good, and the
 *  fill after a large city's opening every tile of the map's until it was over. */
export interface PassTile {
  /** Its key among the pass's parts (`roadSurfaceEntries.ts` partKey): its piece and its block. */
  readonly key: PartKey;
  readonly value: number;
  /** Its name in the store (`storedKey`). */
  readonly stored: string;
  readonly chunk: string;
  /** Its piece's box: where what it reads lies (`SurfaceInputs.rectOf`). */
  readonly rect: TileRect;
  /** Its owner block's square (`roads/pieceOwner.ts`): what the active region and the far level's cells are told by. Nothing is cut to it. */
  readonly cell: TileRect;
  surfaces: KeptTile | null;
  bundle: TileBundle | null;
}

/** A pass of the surfaces as the last build left it (`roadSurfaceSteps`): the constants it was built with, its inputs' birth, its tiles by key (no arrays), the tiles of each block and, for each surface, its blocks by the first tile holding it (the order a fresh build draws them in). */
export interface PassState {
  readonly salt: number;
  readonly born: number;
  readonly tiles: Map<PartKey, PassTile>;
  readonly chunkTiles: Map<string, Set<PartKey>>;
  readonly blocks: Map<string, Map<string, PartKey>>;
  /** Blocks whose tiles changed and that a build replaced halfway did not merge yet: merged by the next. */
  readonly pending: Set<string>;
}

/** A block's tiles by digest, surface by surface of its group (a surface after the first marked by minus its place: digests are never negative). */
export function tileSignature(lists: readonly (readonly PassTile[])[]): number[] {
  return lists.flatMap((list, i) => [...(i ? [-i] : []), ...list.map((tile) => tile.value)]);
}

/** Whether a block's tiles are the ones its mesh was merged from, by digest. */
export function sameTiles(parts: readonly number[], lists: readonly (readonly PassTile[])[]): boolean {
  const now = tileSignature(lists);
  return parts.length === now.length && now.every((value, i) => value === parts[i]);
}

/** Surfaces drawn alike - one material, order and shadows - drawn as one mesh a block (`drawGroups`): its name, theirs joined by `+`. */
export interface DrawGroup {
  readonly name: string;
  readonly specs: readonly SurfaceSpec[];
  readonly options: SurfaceSpec['options'];
  readonly renderOrder?: number;
}

/** DO NOT draw a mesh a surface where surfaces are drawn alike (the footway and its ramps, a kerb and a median's kerb: one material each): a
 *  draw call a surface a block. The pass's surfaces grouped by how they are drawn, in the order each group's first surface comes; each
 *  surface keeps its own tiles, and its own far level (`attachFarLevel`). */
export function drawGroups(specs: readonly SurfaceSpec[]): DrawGroup[] {
  const byLook = new Map<string, SurfaceSpec[]>();
  for (const spec of specs) {
    const o = spec.options;
    const look = `${o.material.uuid}|${spec.renderOrder ?? ''}|${o.castShadow ?? false}|${o.receiveShadow ?? true}`;
    const list = byLook.get(look);
    if (list) list.push(spec); else byLook.set(look, [spec]);
  }
  return [...byLook.values()].map((unordered) => {
    // In one mesh, the surfaces in the order their own materials were drawn in (three sorts opaque meshes by material, made in the codes' order,
    // `materials.ts`): where two surfaces meet on one edge at one depth (a kerb's face on the carriageway), the later wins the pixel as it did.
    const members = [...unordered].sort((p, q) => (p.code ?? 0) - (q.code ?? 0));
    const name = members.map((spec) => spec.options.name).join('+');
    const lead = members[0]!;
    return { name, specs: members, options: { ...lead.options, name }, ...(lead.renderOrder !== undefined ? { renderOrder: lead.renderOrder } : {}) };
  });
}

/** One surface's tiles in a block, built again from their rings (a lost WebGL context, `mesh/gpuOnly.ts`), read again off the inputs
 *  then (`ringsOf`): DO NOT hold every block's rings for it, the whole map's roads kept on the CPU. A tile its pass no longer has is gone
 *  from the network since, its block built again by the next build: left out. */
export function surfaceSource(spec: SurfaceSpec, specs: readonly SurfaceSpec[], keys: readonly PartKey[],
  reading: <T>(work: () => T) => T, ringsOf: (key: PartKey) => Reach | null): () => Tile[] {
  return () => keys.flatMap((key) => {
    const into = ringsOf(key);
    // Its stations asked of every surface of the pass, as when it was built: the strips of a road share theirs (`roads/pieceMesh.ts`).
    const made = into ? reading(() => tileBundle(into, specs, new Set([spec.options.name])).get(spec.options.name)) : undefined;
    return made ? coded([made], spec) : [];
  });
}

/** One surface's tiles in a block at the blocks' far level, built again from their rings as `surfaceSource` does: a junction's coarser tile
 *  (`roads/pieceMesh.ts` farTileName), every other piece's own tile. */
export function farSurfaceSource(spec: SurfaceSpec, specs: readonly SurfaceSpec[], keys: readonly PartKey[],
  reading: <T>(work: () => T) => T, ringsOf: (key: PartKey) => Reach | null): () => Tile[] {
  const name = spec.options.name, far = farTileName(name);
  return () => keys.flatMap((key) => {
    const into = ringsOf(key);
    if (!into) return [];
    const made = reading(() => tileBundle(into, specs, new Set([far])).get(far) ?? tileBundle(into, specs, new Set([name])).get(name));
    return made ? coded([made], spec) : [];
  });
}

/** Seam lists end to end. */
export function concatSeams(lists: readonly Float64Array[]): Float64Array {
  let n = 0;
  for (const list of lists) n += list.length;
  const out = new Float64Array(n);
  let at = 0;
  for (const list of lists) { out.set(list, at); at += list.length; }
  return out;
}

/** A pass's rings by tile key (`surfaceSource`, the build), made here: DO NOT make it in the build's pass loop, whose closures share one
 *  context (V8): kept by every block's source, it held the pass's every tile of the build with it. */
export function ringsReader(inputs: SurfaceInputs, pass: string): (key: PartKey) => Reach | null {
  return (key) => (inputs.visits(pass, key) ? inputs.reachOf(pass, key).reach : null);
}

/** What each surface of a part is made from (`roadSurfaceReads.ts` slotOf: the shapes its pieces file under it). */
type Source = TileSource;

/** One surface of a structural level: how it is meshed, and from what. */
export interface SurfaceSpec {
  readonly source: Source;
  readonly options: SurfaceMeshOptions;
  readonly renderOrder?: number;
  /** Its code in the road material (`mesh/roadEdges.ts` ROAD_CODE), given its tiles as a block merges them (`coded`); 0 where none is given. */
  readonly code?: number;
}

/** A surface's tiles given its code in the road material (`Tile.code`): what a block merging them writes in their vertices' sections. */
export function coded(tiles: readonly Tile[], spec: SurfaceSpec): Tile[] {
  const code = spec.code ?? 0;
  return tiles.map((tile) => ({ ...tile, code }));
}
