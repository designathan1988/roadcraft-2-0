import { Color, Group, type Material, type Mesh } from 'three';

import { measureHitch } from '@core/hitch';
import { Digest } from '@core/digest';
import type { Network } from '@world/network';
import { ROAD_TYPES } from '@world/roadTypes';
import type { CarriagewayMaterial } from '@world/roadSection';
import { packFlush } from '@world/roads/footwayRise';
import { rampsMeeting } from '@world/curbRamps';
import { type CurbRamp, rampData } from '@world/rampRise';
import { TUNNEL_BORE, TUNNEL_ROOF, isSunken, roadStructure } from '@world/structures';
import { type RoadElevation, SURFACE_READ_REACH } from '@world/elevation';
import { type PartKey, SurfaceInputs, TILE_REACH, byPart, cellOfPart, cellRectOfPart } from './roadSurfaceInputs';
import { pieceOfPart } from './roadSurfaceEntries';
import type { SceneMaterials } from './materials';
import { roadPaint } from './roadPaint';
import { roadMarks } from './roadMarks';
import { type PassLook, geomsOf, passDesc, passRaised, passReads, tileBundle } from './roadSurfacePass';
import {
  type DrawGroup, type KeptTile, type PassState, type PassTile, type SurfaceSpec, type TileBundle, coded, concatSeams, drawGroups, ringsReader, sameTiles,
  farSurfaceSource, surfaceSource, tileSignature,
} from './roadSurfaceBlocks';
import { ROAD_CODE, type RoadCode } from './mesh/roadEdges';
import { attachFarLevel, blockArraysOf, blockBox, cloneBlock, joinBlocks, memberSizes, mergeTiles, splitBlock, tilesOnGpu } from './mesh/surfaceTiles';
import { cancelWarm, warmLooseAhead } from './uploads';
import type { FarBlockBatches } from './mesh/farBlockBatches';
import { type BlockArrays, type BlockLock, levelsOf } from './mesh/roadLod';
import { FOOTPRINT, farLocksOf, farTileName, seamsOf } from './roads/pieceMesh';
import type { RoadFootprints } from './roadFootprints';
import { ASPHALT_REFERENCE, CARRIAGEWAY_COLOUR } from './roadTones';
import type { RoadTiler, TileJob } from './roadTilePool';
import type { SurfaceData } from './roadTileMesh';
import {
  passSurfaces,
  type PassDesc,
  type RoadLook,
  type SurfaceRead,
  type TileSource,
} from './roadSurfaceReads';
import type { SegmentId } from '@world/ids';
import {
  disposeMesh,
  type Tile,
  type TileRect,
} from './mesh/surfaceMesh';

export type { TileBundle } from './roadSurfaceBlocks';

/** The road network's surface bands */

/** What one build of the surfaces keeps for the next, so an edit rebuilds only the tiles it reaches. */
export interface SurfaceReuse {
  /** DO NOT keep a tile's arrays here */
  readonly tiles: Map<string, Map<number, KeptTile>>;
  /** What each tile's ground and heights digested to at the last build (`dependsOn`), by pass and tile key: a tile no changed block reaches keeps it (DO NOT digest every tile of the region at every build: ~6,600 digests, 700 ms on the page at each tile a streamed world put in, 2026-10-16). */
  readonly depends?: Map<string, Map<PartKey, number>>;
  /** A digest of everything the height field and the texture frames read in a rectangle */
  readonly dependsOn: (minX: number, minY: number, maxX: number, maxY: number) => number;
  /** The meshes of each block of tiles */
  readonly chunks: Map<string, { readonly parts: readonly number[]; readonly mesh: Mesh }>;
  /** Block meshes replaced but maybe still drawn: freed by the owner once the new roads are in. */
  readonly retired?: Mesh[];
  /** Whether a block at (x, y), world units, is near the camera: made at full detail, its far level hidden */
  readonly near?: (x: number, y: number) => boolean;
  /** Whether a tile of the roads is built here at all (the opening's view, `renderer.ts` openingWithin): a tile left out is built by a later build. None: every tile. */
  within?: (rect: TileRect) => boolean;
  /** Where `within`'s answer changed since the last build finished; null: it cannot say (every tile visited). */
  withinMoved?: (readonly [number, number, number, number])[] | null;
  /** Each pass as the last build left it (`PassState`): a build visits only what changed. None: every tile at every build. */
  readonly passes?: Map<string, PassState>;
  /** Tiles kept from earlier builds and sessions (`derivedCache.ts`), by `storedKey`: what is kept is known, a tile read only when a build uses it */
  readonly stored?: StoredTiles;
  /** The passes' inputs, kept road by road and node by node between builds (`roadSurfaceInputs.ts`) */
  readonly inputs?: SurfaceInputs;
  /** Where the eye is when a build ends: the inputs held round the view (`InputResidency`) are brought back to it. None: they stay as the build left them. */
  readonly inputsEye?: () => { readonly x: number; readonly y: number } | null;
  /** Each tile built afresh, to be kept for a later session */
  readonly keep?: (key: string, bundle: TileBundle) => void;
  /** The store's prefix the road tile workers keep the tiles they make under (none: the page keeps them, `keep`); `kept` tells the page a key is kept. */
  readonly workersKeep?: string | null;
  readonly kept?: (key: string) => void;
  /** The batches the blocks' far levels are drawn in, one a look (`farBlockBatches.ts`). None: each far level a mesh of its own. */
  readonly farBatches?: FarBlockBatches;
  /** Each part's footprint on the ground, staged as a build makes it and put in place with it (`adopt`): what the terrain is cut along
   *  (`roadFootprints.ts`, `terrainSeams.ts`). None: none kept. */
  readonly footprints?: RoadFootprints;
}

/** A block into the group with its far level, which waits hidden beside it (`mesh/roadLod.ts`). */
function addBlock(group: Group, mesh: Mesh): void {
  group.add(mesh);
  const coarse = levelsOf(mesh)?.coarse;
  if (coarse) group.add(coarse);
}

/** The name a tile is kept under between sessions: its pass, its place and its digest (a new digest at the same place replaces the old). */
const storedKey = (pass: string, tile: PartKey, digest: number): string => `${pass}|${tile}|${digest}`;

/** The tiles kept off the page (`derivedCache.ts`) */
interface StoredTiles {
  /** Whether a tile is kept. */
  has(key: string): boolean;
  /** The kept tiles of these keys, read from the store: never the whole of it. */
  fetch(keys: readonly string[]): Promise<ReadonlyMap<string, TileBundle>>;
}

/** Frees what a `SurfaceReuse` holds on the GPU. */
export function disposeSurfaceReuse(reuse: SurfaceReuse): void {
  dropSurfaceBlocks(reuse);
}

/** The blocks a `SurfaceReuse` holds freed. */
function dropSurfaceBlocks(reuse: SurfaceReuse): void {
  for (const { mesh } of reuse.chunks?.values() ?? []) disposeMesh(mesh);
  reuse.chunks?.clear();
  // What the passes and tiles stood at goes with the blocks: a later build visits every tile again.
  reuse.passes?.clear();
  reuse.tiles.clear();
  reuse.depends?.clear();
  if (reuse.withinMoved !== undefined) reuse.withinMoved = null;
  for (const mesh of reuse.retired?.splice(0) ?? []) disposeMesh(mesh);
  // No road drawn: no ground cut for one.
  reuse.footprints?.clear();
}

export interface RoadSurfaces {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  readonly triangles: number;
  /** Tiles the build made afresh, and copied from the build before. */
  readonly built: number;
  readonly reused: number;
  /** Tiles kept from before built again to merge a block that changed (their arrays are not kept). */
  readonly remade: number;
  /** Where the tiles made afresh lie (`world/changes.ts`). */
  readonly rebuilt: readonly TileRect[];
  /** The time the tiles and their blocks took, ms, without the frames between slices. */
  readonly workMs: number;
  /** Puts the blocks kept from the build before into `group`, at the swap. */
  adopt(): void;
  dispose(): void;
}

/** The version of how a piece is made (`roads/`): a part's digest holds it, so the parts kept by an older base (the store, `derivedCache.ts`)
 *  are never read for this one. 3: a part's bundle carries its footprint (`roads/pieceMesh.ts` FOOTPRINT). 4: a corner's footway closed on one back
 *  point (`junctionPiece.ts` footwayOf), a road's strip carrying its slot past its mouths (`roadSurfaceReads.ts` asphaltSection). */
const SURFACE_BASE = 4;
/** How far over a tunnel's road the ground may stand for its footprint to cut it (the middle of the band where the shaping lets the hill close
 *  over it, `world/elevation.ts` roadShapeAt): past it the road bores under the hill and the terrain is left whole over it. */
const TUNNEL_OPEN = (TUNNEL_ROOF + TUNNEL_BORE) / 2;
/** Tiles a batch asked of the workers at once (`roadTilePool.ts`) */
const SHAPE_BATCH = 64;
/** Batches of tiles asked of the workers ahead of the one being taken (`buildAll`): each worker's next share waits in its queue. */
const IN_FLIGHT = 3;

/** Linear-space tints per road class, so the asphalt mesh can vary by class. */
const CLASS_TINT: readonly Color[] = ROAD_TYPES.map((type) =>
  new Color(type.color),
);
/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(ASPHALT_REFERENCE);
/** A carriageway's tone by what it is paved with; asphalt keeps its class's. */
const CARRIAGEWAY_TINT: Readonly<Record<Exclude<CarriagewayMaterial, 'asphalt'>, Color>> = {
  concrete: new Color(CARRIAGEWAY_COLOUR.concrete),
  cobble: new Color(CARRIAGEWAY_COLOUR.cobble),
};
/** A colour against the reference, channel by channel: the multiplier a vertex is tinted with. */
const againstReference = (tint: Color): [number, number, number] =>
  [tint.r / TINT_REFERENCE.r, tint.g / TINT_REFERENCE.g, tint.b / TINT_REFERENCE.b];
/** The carriageway's tints as a pass reads them (`PassDesc`): numbers, made once here with three's colour management. */
const CLASS_TINTS: readonly number[] = CLASS_TINT.flatMap(againstReference);
const REFERENCE_TINT = againstReference(TINT_REFERENCE);
const PAVING_TINTS: Readonly<Record<string, readonly [number, number, number]>> = Object.fromEntries(
  Object.entries(CARRIAGEWAY_TINT).map(([name, tint]) => [name, againstReference(tint)]));

/** The page's constants the roads are drawn with (`PassLook`): what a road bake in a worker is handed to draw them alike (`nearRoadTiles.ts`). */
function passLook(materials: SceneMaterials): PassLook {
  return {
    scale: { asphalt: materials.scale.asphalt, footway: materials.scale.footway, kerb: materials.scale.kerb, verge: materials.scale.verge, deck: materials.scale.deck },
    classTint: CLASS_TINTS,
    referenceTint: REFERENCE_TINT,
    pavingTint: PAVING_TINTS,
  };
}
export function buildRoadSurfaces(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
): RoadSurfaces {
  const steps = roadSurfaceSteps(net, elevation, materials, terrainAt, reuse);
  let step = steps.next();
  while (!step.done) step = steps.next();
  step.value.adopt();
  return step.value;
}

/** `buildRoadSurfaces` in steps: it yields after each tile built and each block merged */
export function* roadSurfaceSteps(
  net: Network,
  elevation: RoadElevation,
  materials: SceneMaterials,
  terrainAt: (x: number, y: number) => number,
  reuse?: SurfaceReuse,
  /** Shapes the tiles off the page (`roadTilePool.ts`); then the steps yield 'wait' while it works. None: all here. */
  tiler?: RoadTiler | null,
  /** The blocks whose ground or heights changed since the last build (`renderer.ts` `compareSolves`), world units: only the tiles within the elevation's read reach of one are digested again; null, every tile (the land moved, or nothing is known). */
  changed: readonly (readonly [number, number, number, number])[] | null = null,
): Generator<'wait' | void, RoadSurfaces, void> {
  const started = performance.now();
  let tilesMs = 0;
  let mergeMs = 0;
  let chunksMerged = 0;
  let chunksKept = 0;
  let remade = 0;
  const chunks = reuse?.chunks;
  const usedChunks = new Set<string>();
  /** The blocks whose far level is being made by the workers (`mergeTiles`): the build waits for them before it ends. */
  let coarsening = 0;
  // A block let go before its upload came is taken out of the queue first (`uploads.ts` `cancelWarm`)
  const retire = (mesh: Mesh): void => { cancelWarm(levelsOf(mesh)?.coarse ? [mesh, levelsOf(mesh)!.coarse!] : [mesh]); if (reuse?.retired) reuse.retired.push(mesh); else disposeMesh(mesh); };
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.name = 'road-network';
  const meshes: Mesh[] = [];
  let triangles = 0;
  let built = 0;
  let reused = 0;
  const rebuilt: TileRect[] = [];

  const reading = <T>(work: () => T): T => elevation.remembering ? elevation.remembering(work) : work();
  // The inputs of every pass, kept road by road and node by node and brought up to the network by its change
  const inputs = reuse?.inputs ?? new SurfaceInputs();
  inputs.refresh(net);
  // Where the document's slots are in the paint's table: what a block's vertices are given, its tiles carrying the document's own (`roadPaint.ts`).
  const tableSlots = roadPaint.resolverOf(net.doc);
  // Roads at authored heights are drawn on their own, each from its own deck
  const passes = inputs.passList();
  if (reuse) {
    const current = new Set(passes.map((pass) => pass.id));
    for (const id of reuse.tiles.keys()) if (!current.has(id)) { reuse.tiles.delete(id); reuse.footprints?.dropPass(id); }
  }
  /** The tiles of the active region's edge that moved, as read now: taken off `withinMoved` only once this build is over (a build replaced halfway leaves them for the next). */
  const moved = reuse?.withinMoved === undefined ? [] : reuse.withinMoved === null ? null : reuse.withinMoved.slice();
  /** The dirty tiles each pass was visited with: settled once this build is over, for the same reason. */
  const settleLater: { pass: string; born: number; keys: PartKey[] }[] = [];
  for (const pass of passes) {
    yield;
    const structure = roadStructure(pass.structure);
    const present = pass.chain !== undefined || inputs.present(structure.id);
    if (!present) {
      reuse?.tiles.delete(pass.id);
      reuse?.passes?.delete(pass.id);
      reuse?.footprints?.dropPass(pass.id);
      continue;
    }

    const raised = passRaised(net, pass, elevation, terrainAt);

    /** What this pass's surfaces read on the page: the network and the solved field (in a worker, `SurfaceData`). */
    const pageReads = passReads(net, elevation, terrainAt);
    const look = (id: SegmentId): RoadLook | undefined => pageReads.look(id);
    net.crossingSurface();
    yield;
    /** The pass as its surfaces read it, plain data: the same on the page and in a worker (`roadSurfaceReads.ts`). */
    const desc: PassDesc = passDesc(net, pass, raised, passLook(materials));
    const specs = passSurfaces(desc, pageReads).map((read) => dress(read, raised, materials));
    const groups = drawGroups(specs);

    // Everything a tile's build reads besides its rings and its surroundings
    const specSalt = (spec: SurfaceSpec): number => new Digest().addText(spec.options.name).add(spec.options.leastEdge)
      .add(spec.options.skirtUvScale ?? 0).add(spec.options.bottom ? 1 : 0).add(spec.options.across ?? 1)
      .add(spec.options.tint ? 1 : 0).value();
    // The materials' texture scales (the UVs), and the base the pieces are made by: a part kept by a build of another is never taken.
    const salt = new Digest().addText(pass.id).add(SURFACE_BASE)
      .add(desc.scale.asphalt).add(desc.scale.footway).add(desc.scale.kerb).add(desc.scale.verge).add(desc.scale.deck);
    for (const spec of specs) salt.add(specSalt(spec));
    const saltValue = salt.value();
    // What the pass's blocks are kept under besides their tiles: each surface's name, material and order (`keyOf`). DO NOT keep a pass's state across a change of them: its standing blocks would be looked for under keys no longer made.
    const passSalt = new Digest().add(saltValue);
    for (const spec of specs) passSalt.addText(spec.options.name).addText(spec.options.material.uuid).add(spec.renderOrder ?? -1);
    const passSaltValue = passSalt.value();

    const previous = reuse?.tiles.get(pass.id);
    // THE PASS AS IT STOOD (`PassState`): DO NOT walk every road tile of the region at each build (a tile put in made every pass digest, sort and regroup every tile, a slice a frame). Only the tiles whose inputs changed (`SurfaceInputs.dirtyOf`), those a changed block reaches and those that came into or left the active region (`withinMoved`) are visited, and only their blocks merged again; the first build, a pass made again, new constants or a change that cannot say where visits them all.
    const dirtyNow = inputs.dirtyOf(pass.id);
    const before = reuse?.passes?.get(pass.id);
    const incremental = before !== undefined && dirtyNow !== null && before.salt === passSaltValue && before.born === dirtyNow.born
      && changed !== null && moved !== null;
    const state: PassState = incremental ? before : { salt: passSaltValue, born: dirtyNow?.born ?? -1, tiles: new Map(), chunkTiles: new Map(), blocks: new Map(), pending: new Set() };
    if (dirtyNow) settleLater.push({ pass: pass.id, born: dirtyNow.born, keys: [...dirtyNow.keys] });
    const kept = incremental && previous ? previous : new Map<number, KeptTile>();
    const knownDepends = reuse?.depends?.get(pass.id);
    const depends = incremental && knownDepends ? knownDepends : new Map<PartKey, number>();
    const reach = SURFACE_READ_REACH + 1;
    const reached = (rect: TileRect): boolean => changed === null
      || changed.some((b) => b[0] <= rect[2] + reach && b[2] >= rect[0] - reach && b[1] <= rect[3] + reach && b[3] >= rect[1] - reach);
    /** The tiles to look at, in tile order (a mesh is laid out the same however it was reached). */
    let visit: PartKey[];
    if (incremental) {
      // The parts whose inputs changed (one gone among them), those whose piece a changed block reaches, and those of the pieces in a block that
      // came into the active region or left it (a rounding round it: a piece is filed in a block its box comes within `TILE_REACH` of).
      const keys = new Set<PartKey>(dirtyNow!.keys);
      const grow = (r: readonly number[], by: number): number[] => [r[0]! - by, r[1]! - by, r[2]! + by, r[3]! + by];
      for (const key of inputs.partsMeeting(pass.id, changed!.map((b) => grow(b, reach)))) keys.add(key);
      for (const key of inputs.partsMeeting(pass.id, moved!.map((r) => grow(r, TILE_REACH)))) keys.add(key);
      visit = [...keys].sort(byPart);
    } else visit = inputs.tileKeys(pass.id);
    /** The blocks a visited tile came into, changed in or left: merged again; every other block stands as it is. */
    const affected = new Set<string>();
    /** The visited tiles that are new, changed (the tile) or gone (null): put in the pass's state only once built (DO NOT write them in as they are visited: a build replaced before building them left them as kept, never built). */
    const changes = new Map<PartKey, PassTile | null>();
    /** The tiles visited and new or changed: kept from before (its surfaces known, its arrays not), read from the store, or to build. */
    const tiles: PassTile[] = [];
    /** The tiles to read from the store, by their place in `tiles`. */
    const fromStore: number[] = [];
    for (const key of visit) {
      const cell: TileRect = cellRectOfPart(key);
      const old = state.tiles.get(key);
      // A tile gone, or of the kept ring: not built, not digested; the far roads draw it (its block loses it, or goes). One built here has its inputs derived first (`visits`, held round the view).
      if ((reuse?.within && !reuse.within(cell)) || !inputs.visits(pass.id, key)) {
        if (old) { changes.set(key, null); affected.add(old.chunk); reuse?.footprints?.drop(pass.id, key); }
        depends.delete(key);
        continue;
      }
      const rect: TileRect = inputs.rectOf(key);
      const { digest: read } = inputs.reachOf(pass.id, key);
      // The slots in the paint's table its vertices carry (`roadPaint.ts` partSlots): a part kept from another session is never drawn with its own.
      const digest = new Digest().add(saltValue).add(roadPaint.partSlots(net, pieceOfPart(key))).addText(key).add(read);
      if (reuse) {
        const known = knownDepends?.get(key);
        const depend = known !== undefined && !reached(rect) ? known : reuse.dependsOn(rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1);
        depends.set(key, depend);
        digest.add(depend);
      }
      const value = digest.value();
      if (old && old.value === value) continue;
      const surfaces = previous?.get(value);
      const stored = storedKey(pass.id, key, value);
      const [cx, cy] = cellOfPart(key);
      const chunk = `${cx},${cy}`;
      if (!surfaces && reuse?.stored?.has(stored)) fromStore.push(tiles.length);
      const tile: PassTile = { key, value, stored, chunk, rect, cell, surfaces: surfaces ?? null, bundle: null };
      tiles.push(tile);
      changes.set(key, tile);
      affected.add(chunk);
      if (surfaces) yield;
    }
    // The kept tiles this build uses, read off the store now (one transaction), never the whole store at the opening.
    if (fromStore.length && reuse?.stored) {
      let got: ReadonlyMap<string, TileBundle> | null = null;
      reuse.stored.fetch(fromStore.map((k) => tiles[k]!.stored)).then((map) => { got = map; }, (error: unknown) => { console.warn('[roads] the stored road tiles could not be read: they are made again', error); got = new Map(); });
      while (got === null) yield 'wait';
      const read: ReadonlyMap<string, TileBundle> = got;
      for (const k of fromStore) {
        const tile = tiles[k]!;
        const bundle = read.get(tile.stored);
        if (!bundle) continue;
        tile.bundle = bundle;
        tile.surfaces = [...bundle.keys()];
      }
    }
    /** The roads a share of the tiles reads, for a worker (`roadTileMesh.ts`) */
    const dataFor = (rects: readonly TileRect[]): { data: SurfaceData; transfer: ArrayBuffer[] } => {
      // A unit round each tile: its vertices lie on its edges, and the cut puts some a rounding past them.
      const around = rects.map((r): [number, number, number, number] => [r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1]);
      const packed = elevation.fieldFor!(around, pass.chain ?? []);
      const field = packed.data;
      const transfer = [...packed.transfer];
      const lookList: [SegmentId, RoadLook][] = [];
      const seen = new Set<SegmentId>();
      for (const id of [...field.ids as unknown as SegmentId[], ...(pass.chain ?? [])]) {
        if (seen.has(id)) continue;
        seen.add(id);
        const found = look(id);
        if (found) lookList.push([id, found]);
      }
      const ramps = new Set<CurbRamp>();
      for (const rect of around) for (const r of rampsMeeting(net, rect)) if (r.structure === structure.id) ramps.add(r);
      const flush = packFlush(net, around);
      transfer.push(...flush.transfer);
      return { data: { field, looks: lookList, flush: flush.data, ramps: [...ramps].map(rampData) }, transfer };
    };
    /** A tile's rings, read off the inputs as it is built (held round the view: its cells derived again if they were let go); null for a tile the pass no longer has. */
    const ringsOf = ringsReader(inputs, pass.id);
    /** DO NOT cut, triangulate or read the vertices of a city's tiles on the page: the whole of its roads' build (2026-10-15). */
    const offPage = tiler && elevation.fieldFor ? tiler : null;
    /** The tiles their worker kept in the store (`TileJob.keep`). */
    const keptByWorker = new Set<PassTile>();
    const buildAll = function* (list: readonly PassTile[], done: (tile: PassTile) => void): Generator<'wait' | void, void, void> {
      /** Asks the tiler for `SHAPE_BATCH` tiles from `from` on; the answer lands in the record it returns. */
      const ask = (from: number): { readonly from: number; readonly answer: { tiles?: Map<string, Tile>[]; failed?: boolean } } => {
        const answer: { tiles?: Map<string, Tile>[]; failed?: boolean } = {};
        const batch = list.slice(from, from + SHAPE_BATCH);
        const prefix = reuse?.workersKeep;
        const request: TileJob = {
          pass: desc,
          tiles: batch.map((t) => ({ rect: t.rect, into: geomsOf(ringsOf(t.key)!) })),
          dataFor,
          terrainAt,
          // Kept by the workers that make them, with a ceiling of their own on what is not committed: DO NOT post them back to be kept (past the page's ceiling a tile was dropped).
          ...(prefix ? { keep: { prefix, keys: batch.map((t) => (reuse?.stored?.has(t.stored) ? null : t.stored)) }, onKept: (k: number) => { keptByWorker.add(batch[k]!); } } : {}),
        };
        offPage!.tiles(request).then(
          (tiles) => { answer.tiles = tiles; },
          (error: unknown) => { console.warn('[roads] the road tile workers failed; the tiles are built on the page', error); answer.failed = true; },
        );
        return { from, answer };
      };
      // DO NOT ask for every tile at once: a whole city's tiles held together, before any was merged, took the page past 7 GB
      // DO NOT ask one batch at a time either: a batch is shared out to the workers and answered once its slowest share is, so the others stood idle at every batch's end (a downtown share costs many times an empty one) and the road surfaces were 6 s of a large city's opening (2026-10-21). `IN_FLIGHT` batches asked ahead keep each worker's next share waiting in its queue.
      const jobs: ReturnType<typeof ask>[] = [];
      let asked = 0;
      const askNext = (): void => {
        if (asked >= list.length) return;
        jobs.push(ask(asked));
        asked += SHAPE_BATCH;
      };
      if (offPage && list.length) for (let k = 0; k < IN_FLIGHT; k++) askNext();
      let failed = false;
      for (let from = 0; from < list.length; from += SHAPE_BATCH) {
        let made: Map<string, Tile>[] | null = null;
        const job = jobs[0]?.from === from ? jobs[0] : null;
        if (job && !failed) {
          while (!job.answer.tiles && !job.answer.failed) { offPage!.check(); yield 'wait'; }
          made = job.answer.tiles ?? null;
          jobs.shift();
          if (!made) failed = true;
          else askNext();
        }
        for (let k = from; k < Math.min(list.length, from + SHAPE_BATCH); k++) {
          const tile = list[k]!;
          const tileAt = performance.now();
          // Made off the page: taken as it is.
          const bundle = made ? made[k - from]! : reading(() => tileBundle(ringsOf(tile.key)!, specs));
          tile.bundle = bundle;
          tile.surfaces = [...bundle.keys()];
          tilesMs += performance.now() - tileAt;
          done(tile);
          // A tile made here is a step of its own; the tiles a worker made are taken a batch a step (taking one is filing its arrays: ~170 steps a 1 km tile, a step a frame once the town is shown, 2026-10-16).
          if (!made) yield;
        }
        if (made) yield;
      }
    };
    /** The tiles built afresh this pass: kept for a later session once merged (below), unless their worker kept them. */
    const fresh: PassTile[] = [];
    let builtHere = 0;
    yield* buildAll(tiles.filter((t) => t.surfaces === null), (tile) => {
      built++;
      builtHere++;
      rebuilt.push(tile.rect);
      fresh.push(tile);
    });
    // Each part made or read: its footprint staged, put in place with the build (`RoadFootprints.commit`). A part kept from the build before
    // whose footprint is not known (its surfaces kept, not its arrays) read off the store, or made again, for it.
    const footprints = reuse?.footprints;
    if (footprints) {
      // A tunnel's footprint where its cutting is open (the ground as drawn there, the hill's own where it bores: never cut by the road).
      const keep = isSunken(structure.id) ? (x: number, y: number, h: number): boolean => terrainAt(x, y) - h < TUNNEL_OPEN : undefined;
      const unprinted = tiles.filter((t) => !t.bundle && !footprints.has(pass.id, t.key, t.value));
      const stored = reuse.stored ? unprinted.filter((t) => reuse.stored!.has(t.stored)) : [];
      if (stored.length) {
        let got: ReadonlyMap<string, TileBundle> | null = null;
        reuse.stored!.fetch(stored.map((t) => t.stored)).then((map) => { got = map; }, (error: unknown) => { console.warn('[roads] the stored road tiles could not be read: they are made again', error); got = new Map(); });
        while (got === null) yield 'wait';
        const read: ReadonlyMap<string, TileBundle> = got;
        for (const tile of stored) { const bundle = read.get(tile.stored); if (bundle) tile.bundle = bundle; }
      }
      yield* buildAll(unprinted.filter((t) => !t.bundle), () => { remade++; });
      for (const tile of tiles) if (tile.bundle) footprints.stage(pass.id, tile.key, tile.value, tile.bundle.get(FOOTPRINT), keep);
    }
    // Built: the changes into the pass's state, their blocks to merge (with those a build replaced halfway left unmerged) until merged.
    for (const chunk of state.pending) affected.add(chunk);
    for (const [key, tile] of changes) {
      const old = state.tiles.get(key);
      if (old) { state.chunkTiles.get(old.chunk)?.delete(key); if (incremental) kept.delete(old.value); }
      if (!tile) { state.tiles.delete(key); continue; }
      state.tiles.set(key, tile);
      let inChunk = state.chunkTiles.get(tile.chunk);
      if (!inChunk) state.chunkTiles.set(tile.chunk, inChunk = new Set());
      inChunk.add(key);
      kept.set(tile.value, tile.surfaces!);
    }
    for (const chunk of affected) state.pending.add(chunk);
    if (reuse?.passes) reuse.passes.set(pass.id, state);
    reuse?.tiles.set(pass.id, kept);
    reuse?.depends?.set(pass.id, depends);
    reused += state.tiles.size - builtHere;

    // A block keeps its mesh while its tiles are the same (by digest).
    const keyOf = (group: DrawGroup, chunk: string): string =>
      `${pass.id}|${group.name}|${chunk}|${group.options.material.uuid}|${group.renderOrder ?? ''}`;
    /** Each group's tiles in each block a visited tile touched, surface by surface of the group, in tile order. */
    const parts = new Map<string, Map<string, PassTile[][]>>();
    for (const group of groups) parts.set(group.name, new Map());
    for (const chunk of affected) {
      const inChunk = [...(state.chunkTiles.get(chunk) ?? [])].sort(byPart).map((key) => state.tiles.get(key)!);
      if (inChunk.length === 0) state.chunkTiles.delete(chunk);
      for (const group of groups) {
        const lists = group.specs.map((spec) => inChunk.filter((tile) => tile.surfaces!.includes(spec.options.name)));
        if (lists.some((list) => list.length)) { parts.get(group.name)!.set(chunk, lists); continue; }
        // No tile of the block has a surface of the group any more: its mesh goes.
        state.blocks.get(group.name)?.delete(chunk);
        const gone = chunks?.get(keyOf(group, chunk));
        if (gone) { retire(gone.mesh); chunks!.delete(keyOf(group, chunk)); }
      }
    }
    const again = new Set<PassTile>();
    for (const group of groups) {
      for (const [chunk, lists] of parts.get(group.name) ?? []) {
        const known = chunks?.get(keyOf(group, chunk));
        if (known && sameTiles(known.parts, lists)) continue;
        for (const tile of lists.flat()) if (!tile.bundle) again.add(tile);
      }
    }
    /** The kept tiles given arrays for this merge (read or built): let go once merged. */
    const mergedKept = new Set(again);
    // DO NOT build again what the store holds of them (a block's 15 unchanged tiles cut, triangulated and sampled again for an edit in one, VIA-03): read in one transaction, as the new ones are; its key holds the tile's digest, so what it reads is what a build makes.
    if (again.size && reuse?.stored) {
      const stored = [...again].filter((t) => reuse.stored!.has(t.stored));
      if (stored.length) {
        let got: ReadonlyMap<string, TileBundle> | null = null;
        reuse.stored.fetch(stored.map((t) => t.stored)).then((map) => { got = map; }, (error: unknown) => { console.warn('[roads] the stored road tiles could not be read: they are made again', error); got = new Map(); });
        while (got === null) yield 'wait';
        const read: ReadonlyMap<string, TileBundle> = got;
        for (const tile of stored) {
          const bundle = read.get(tile.stored);
          if (!bundle) continue;
          tile.bundle = bundle;
          again.delete(tile);
        }
      }
    }
    yield* buildAll([...again], () => { remade++; });

    /** The blocks merged here without a cache to keep them (`buildRoadSurfaces` with no reuse). */
    const own = new Map<string, Mesh>();
    const mergeAt = performance.now();
    for (const group of groups) {
      for (const [chunk, lists] of parts.get(group.name) ?? []) {
        const key = keyOf(group, chunk);
        const known = chunks?.get(key);
        // The group's surfaces that have tiles in the block, each with its tiles: drawn one after the other in one mesh.
        const members = group.specs.flatMap((spec, i) => (lists[i]!.length ? [{ spec, list: lists[i]! }] : []));
        let mesh: Mesh | null;
        // DO NOT let the mesh hold its tiles for it: a second copy of every road on the GPU, kept on the CPU
        const sources = members.map(({ spec, list: tiles }) => surfaceSource(spec, specs, tiles.map((tile) => tile.key), reading, ringsOf));
        const source = sources.length === 1 ? sources[0]! : (): Tile[] => sources.flatMap((s) => s());
        if (known && sameTiles(known.parts, lists)) {
          mesh = known.mesh;
          // Bound to this build's rings: the build that made it lets go of its own.
          tilesOnGpu(mesh, source, tableSlots);
          chunksKept++;
        } else {
          if (known) retire(known.mesh);
          // The block's box and its pieces' seams (`roads/pieceMesh.ts` seamsOf: where they meet the pieces of the blocks round it), kept where
          // they are in the far level (`roadLodPure.ts` BlockLock); the box's centre tells near from far (`roadLod.ts`). Each surface's own: a
          // surface of a group keeps its own box (near by it) and its own seams.
          const coarsen = reuse?.near && tiler?.coarsen ? tiler.coarsen.bind(tiler) : null;
          // And every point of a junction's shapes drawn coarser at the far level (`farLocksOf`): that level is its own already.
          const locks: BlockLock[] | null = coarsen ? members.map(({ list: tiles }) => ({
            box: blockBox(tiles.map((tile) => tile.rect)),
            seams: concatSeams(tiles.flatMap((tile) => { const reach = geomsOf(ringsOf(tile.key) ?? new Map()); return [seamsOf(reach), farLocksOf(reach)]; })),
          })) : null;
          const lock = locks?.[0] ?? null;
          const near = locks ? locks.some(({ box: b }) => reuse!.near!((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) : true;
          const memberTiles = members.map(({ spec, list: tiles }) => coded(tiles.map((tile) => tile.bundle!.get(spec.options.name)!), spec));
          // DO NOT name `memberTiles` in a closure here: every closure of this block shares one context (V8), and `levels.bring`, kept as long as the block, held through it every tile's arrays (174 MB in a large city, a heap snapshot of 2026-10-20). The far level cuts by their sizes alone.
          const shares = memberSizes(memberTiles);
          // The far level made from the pieces' own far tiles where some are drawn coarser there (a junction's kerb returns at the owner's road tool's
          // L1, `roads/pieceMesh.ts` farTileName), each surface's arrays; let go once the far level is started (the closures of this block share them).
          const coarser = members.some(({ spec, list: tiles }) => tiles.some((tile) => tile.bundle!.has(farTileName(spec.options.name))));
          let farPieces: BlockArrays[] | null = coarser && lock
            ? members.map(({ spec, list: tiles }) => blockArraysOf(coded(tiles.map((tile) => tile.bundle!.get(farTileName(spec.options.name)) ?? tile.bundle!.get(spec.options.name)!), spec), group.options.material, tableSlots)!)
            : null;
          const farSources = coarser ? members.map(({ spec, list: tiles }) => farSurfaceSource(spec, specs, tiles.map((tile) => tile.key), reading, ringsOf)) : null;
          mesh = mergeTiles(memberTiles.flat(), group.options, source, tableSlots,
            lock ? {
              lock, near, also: locks!.slice(1).map((l) => l.box), cell: chunk,
              start: (block, arrays) => {
                coarsening++;
                levelsOf(block)!.pending = true;
                // Each surface simplified on its own, as when it was a block of its own; one too small to gain is drawn whole in the far level.
                const far = farPieces;
                farPieces = null;
                const pieces = far ? far.map(cloneBlock) : shares.length === 1 ? [cloneBlock(arrays)] : splitBlock(arrays, shares);
                const whole = far ?? (shares.length === 1 ? [cloneBlock(arrays)] : splitBlock(arrays, shares));
                Promise.all(pieces.map((piece, i) => coarsen!(piece, locks![i]!))).then((made) => {
                  // The block may have been built again meanwhile: its far level is of the one it was made for.
                  if (chunks?.get(key)?.mesh !== block) return;
                  // A far level even where nothing simplifies (a block too small to gain): its own arrays, so it is drawn in its look's far batch.
                  // DO NOT leave such a block without one: it was drawn loose, a draw call a block, and the roads refined where they leave their
                  // chords made many more of them (district 265 -> 288 draws, street 356 -> 381, measured 2026-10-24).
                  {
                    const coarse = made.length === 1 ? made[0] ?? whole[0]! : joinBlocks(made.map((m, i) => m ?? whole[i]!));
                    const level = attachFarLevel(block, coarse, group.options, sources.map((s, i) => ({ source: s, slots: tableSlots, lock: locks![i]!, ...(farSources ? { far: farSources[i]! } : {}) })), near);
                    // Drawn by its look's batch (`farBlockBatches.ts`): copied there, never uploaded on its own.
                    if (reuse?.farBatches) reuse.farBatches.adopt(level);
                    else if (!near) void warmLooseAhead([level]);
                  }
                }).catch((error: unknown) => {
                  // No far level for this block: it stays at full detail, sent to the GPU.
                  console.warn('[roads] the far level of a block could not be made', error);
                  if (chunks?.get(key)?.mesh === block) void warmLooseAhead([block]);
                }).finally(() => { coarsening--; const levels = levelsOf(block); if (levels) levels.pending = false; });
              },
            } : undefined);
          // Its full level, when it comes back near, copied from the kept tiles (`reuse.stored`): DO NOT cut and triangulate the block's tiles on the page again (`roadResidency.ts` makeNear).
          const levels = mesh && lock ? levelsOf(mesh) : undefined;
          if (mesh && levels && reuse?.stored) {
            const stored = reuse.stored, material = group.options.material;
            const wanted = members.map(({ spec, list: tiles }) => ({ name: spec.options.name, code: spec.code ?? 0, keys: tiles.map((tile) => tile.stored) }));
            levels.bring = async (): Promise<BlockArrays | null> => {
              const got = await stored.fetch(wanted.flatMap((w) => w.keys));
              const read: Tile[] = [];
              for (const { name, code, keys } of wanted) {
                for (const k of keys) {
                  const tile = got.get(k)?.get(name);
                  if (!tile) return null;
                  read.push({ ...tile, code });
                }
              }
              return blockArraysOf(read, material, tableSlots);
            };
          }
          // Its far level made again when its cell comes back from the network's far level (`roadResidency.ts`): the full level's arrays (kept tiles, else cut here) simplified by the workers, a surface at a time as `start` does.
          if (mesh && levels && coarsen && farSources) {
            // A block with pieces drawn coarser far away: its far level made again from their far tiles (kept, else cut here), a surface at a time.
            const material = group.options.material, stored = reuse?.stored;
            const wanted = members.map(({ spec, list: tiles }) => ({ name: spec.options.name, code: spec.code ?? 0, keys: tiles.map((tile) => tile.stored) }));
            const farArrays = async (): Promise<BlockArrays[] | null> => {
              const got = stored ? await stored.fetch(wanted.flatMap((w) => w.keys)) : null;
              const out: BlockArrays[] = [];
              for (const [i, { name, code, keys }] of wanted.entries()) {
                const read: Tile[] = [];
                for (const k of keys) { const tile = got?.get(k)?.get(farTileName(name)) ?? got?.get(k)?.get(name); if (tile) read.push({ ...tile, code }); }
                const arrays = blockArraysOf(read.length === keys.length ? read : [...farSources[i]!()], material, tableSlots);
                if (!arrays) return null;
                out.push(arrays);
              }
              return out;
            };
            levels.remake = async (): Promise<BlockArrays | null> => {
              const pieces = await farArrays();
              if (!pieces) return null;
              const made = await Promise.all(pieces.map((piece, i) => coarsen(cloneBlock(piece), locks![i]!)));
              return made.length === 1 ? made[0] ?? pieces[0]! : joinBlocks(made.map((m, i) => m ?? pieces[i]!));
            };
          } else if (mesh && levels && coarsen) {
            const material = group.options.material;
            levels.remake = async (): Promise<BlockArrays | null> => {
              const full = ((await levels.bring?.()) as BlockArrays | null | undefined) ?? blockArraysOf(sources.flatMap((s) => s()), material, tableSlots);
              if (!full) return null;
              const whole = shares.length === 1 ? [] : splitBlock(full, shares);
              const pieces = shares.length === 1 ? [full] : splitBlock(full, shares);
              const made = await Promise.all(pieces.map((piece, i) => coarsen(piece, locks![i]!)));
              if (made.every((m) => m === null)) return null;
              return made.length === 1 ? made[0]! : joinBlocks(made.map((m, i) => m ?? whole[i]!));
            };
          }
          if (mesh && group.renderOrder !== undefined) mesh.renderOrder = group.renderOrder;
          // DO NOT wait for the camera to frame it: a block out of view was never uploaded and kept its copy on the CPU
          if (mesh && !(lock && !near)) void warmLooseAhead([mesh]);
          if (mesh) chunks?.set(key, { parts: tileSignature(lists), mesh });
          else chunks?.delete(key);
          chunksMerged++;
          yield;
        }
        let order = state.blocks.get(group.name);
        if (!order) state.blocks.set(group.name, order = new Map());
        if (!mesh) { order.delete(chunk); continue; }
        // Where a fresh build draws it: by its first tile holding a surface of the group.
        order.set(chunk, members.map((member) => member.list[0]!.key).reduce((p, q) => (byPart(p, q) <= 0 ? p : q)));
        if (!chunks) own.set(key, mesh);
      }
    }
    // Every block of the pass, the ones merged now and the ones standing, in the order a fresh build draws them.
    for (const drawn of groups) {
      const order = state.blocks.get(drawn.name);
      if (!order) continue;
      for (const [chunk] of [...order].sort((p, q) => byPart(p[1], q[1]))) {
        const key = keyOf(drawn, chunk);
        const mesh = chunks?.get(key)?.mesh ?? own.get(key);
        if (!mesh) continue;
        usedChunks.add(key);
        // A kept block stays where it is drawn until the swap (`adopt`).
        if (mesh.parent === null) addBlock(group, mesh);
        meshes.push(mesh);
        triangles += (mesh.geometry.index?.count ?? 0) / 3;
      }
    }
    // Every block it touched merged: none left for the next build.
    for (const chunk of affected) state.pending.delete(chunk);
    // The tiles' arrays go with this build: copied into the blocks, which send them to the GPU (the pass's state keeps none).
    mergeMs += performance.now() - mergeAt;
    // Kept for a later session only now, every block merged
    for (const tile of fresh) {
      if (keptByWorker.has(tile)) reuse?.kept?.(tile.stored);
      else reuse?.keep?.(tile.stored, tile.bundle!);
    }
    for (const tile of tiles) tile.bundle = null;
    // And the kept tiles read or built again for a merge: their arrays are the blocks' now (VIA-02: held for good, 50-300 MB over an editing session).
    for (const tile of mergedKept) tile.bundle = null;
  }
  // Blocks no surface has any more.
  if (chunks) for (const [key, { mesh }] of chunks) if (!usedChunks.has(key)) { retire(mesh); chunks.delete(key); }
  // Over: what it was asked to visit is visited; the inputs held round the view brought back to the eye (`SurfaceInputs.keepNear`).
  for (const { pass, born, keys } of settleLater) inputs.settle(pass, born, keys);
  inputs.keepNear(reuse?.inputsEye?.() ?? null);
  if (reuse && reuse.withinMoved !== undefined) {
    if (moved === null) { if (reuse.withinMoved === null) reuse.withinMoved = []; }
    else reuse.withinMoved?.splice(0, moved.length);
  }
  // DO NOT wait without a deadline: `check` fails the pool when a worker is silent.
  while (coarsening > 0) { tiler?.check(); yield 'wait'; }
  // Where an edit's time went (`hitch:` entries).
  const end = performance.now();
  measureHitch(`hitch:road-edit/surfaces ${built} tiles built ${reused} kept ${remade} remade, ${chunksMerged} blocks merged ${chunksKept} kept: tiles ${tilesMs.toFixed(0)} ms, merge ${mergeMs.toFixed(0)} ms`, started, end);
  return {
    group,
    meshes,
    triangles,
    built,
    reused,
    remade,
    rebuilt,
    workMs: tilesMs + mergeMs,
    adopt() {
      // Every block, in the order it was built: the order a fresh build draws them in.
      for (const mesh of meshes) addBlock(group, mesh);
      // The ground cut along the roads put in place now (`terrainSeams.ts`), never along a build not drawn.
      reuse?.footprints?.commit();
      // The marks painted on the roads put in place with them (`roadMarks.ts`): the blocks drawn until now never show the next build's.
      roadMarks.commit(net.doc);
    },
    dispose() {
      // Meshes the cache keeps are freed by `disposeSurfaceReuse`.
      if (!chunks) for (const mesh of meshes) disposeMesh(mesh);
      group.clear();
    },
  };
}

/** A surface's code in the road material (`mesh/roadEdges.ts` ROAD_CODE): the look its own material had (the footway's for its ramps and a median's
 *  paving, the kerb's for a median's kerb, the planting's for a median's soil). */
export function roadCodeOf(source: TileSource, raised: boolean): RoadCode {
  if (source.kind === 'median') return source.part === 'kerb' ? ROAD_CODE.kerb : source.part === 'planting' ? ROAD_CODE.planting : ROAD_CODE.footway;
  switch (source.band) {
    case 'deckEdge': return ROAD_CODE.deck;
    case 'footway': case 'curbRamp': return ROAD_CODE.footway;
    case 'kerb': return ROAD_CODE.kerb;
    case 'asphalt': return raised ? ROAD_CODE.raised : ROAD_CODE.carriageway;
  }
}

/** How a surface is drawn: its material, whether it casts a shadow - the region's (`dress`) and the programs' stand-ins (`roadProgramStandIns.ts`) alike. */
export function surfaceLook(source: TileSource, raised: boolean, materials: SceneMaterials): { readonly material: Material; readonly castShadow?: boolean; readonly renderOrder?: number } {
  if (source.kind === 'median') return { material: source.part === 'kerb' ? materials.kerb : source.part === 'planting' ? materials.verge : materials.footway };
  switch (source.band) {
    case 'deckEdge':
      return { material: materials.deck, castShadow: true };
    case 'footway':
    case 'curbRamp':
      return { material: materials.footway, castShadow: raised };
    case 'kerb':
      return { material: materials.kerb };
    case 'asphalt':
      return { material: raised ? materials.asphaltRaised : materials.asphalt, castShadow: raised };
  }
}

/** A surface as the page draws it: what it reads (`passSurfaces`) with its material and shadows (`surfaceLook`). */
function dress(read: SurfaceRead, raised: boolean, materials: SceneMaterials): SurfaceSpec {
  const look = surfaceLook(read.source, raised, materials);
  return {
    source: read.source,
    code: roadCodeOf(read.source, raised),
    options: { ...read.options, material: look.material, ...(look.castShadow !== undefined ? { castShadow: look.castShadow } : {}), receiveShadow: true },
    ...(look.renderOrder !== undefined ? { renderOrder: look.renderOrder } : {}),
  };
}
