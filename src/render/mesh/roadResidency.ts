import { Box3, type BufferGeometry, type Frustum, type Mesh } from 'three';
import { geometryCost } from '../gpuLedger';
import { fillArrays } from './gpuOnly';
import { type BlockLevels, levelsOf, makeFar } from './roadLod';

/** DO NOT keep a far block's full mesh: no pixel of it is resolved from there. */

// Here for the residency's callers; it lives with the levels (`roadLod.ts`), which the tiles use too, never importing back.
export { makeFar };

/** A block goes far when it is this much farther than `reach`, so one near the line is not asked twice. */
export const FAR_MARGIN = 1.25;
/** Blocks brought near in one look: each is made again from its tiles, a few milliseconds. */
const BRING_PER_LOOK = 3;

/** The block's distance to the camera in the ground plane, scene units (x, z = -y). */
const distance = (levels: BlockLevels, focusX: number, focusY: number): number => {
  let d = Math.hypot(levels.x - focusX, levels.z + focusY);
  for (const [x, z] of levels.also ?? []) d = Math.min(d, Math.hypot(x - focusX, z + focusY));
  return d;
};

/** The block's full mesh shown, the coarse one hidden. */
function showFull(mesh: Mesh, levels: BlockLevels): void {
  levels.full = true;
  mesh.visible = true;
  levels.coarse!.visible = false;
}

/** The block's full mesh made again on the page from its tiles' rings (`refillArrays`) and shown. */
function refillNow(mesh: Mesh, levels: BlockLevels): void {
  const refill = mesh.userData.refillArrays as (() => void) | undefined;
  if (!refill) return;
  refill();
  showFull(mesh, levels);
}

/** The block's full mesh brought back and shown; the coarse one is hidden. */
export function makeNear(mesh: Mesh): void {
  const levels = levelsOf(mesh);
  if (!levels?.coarse || levels.full || levels.bringing) return;
  const bring = levels.bring;
  if (!bring) { refillNow(mesh, levels); return; }
  // DO NOT cut and triangulate the block's tiles on the page again (3 blocks every 6 frames while the camera moves): its arrays come from the kept tiles, shown when they land.
  levels.bringing = true;
  void bring().then((arrays) => {
    levels.bringing = false;
    // Made near by hand or let go meanwhile (`disposeMesh` drops the far level): nothing to show.
    if (levels.full || !levels.coarse) return;
    if (arrays && fillArrays(mesh, arrays)) showFull(mesh, levels);
    else refillNow(mesh, levels);
  }, () => { levels.bringing = false; });
}

/**
 * THE ROADS' CELLS CHOSEN BY THE VIEW, REFINED BY REPLACEMENT (3D Tiles `REPLACE`), UNDER BUDGETS (`quality.ts` GEOMETRY_BUDGETS
 * roadsNearMB, roadsFarMB):
 *
 * - The root: the network's far level (`networkFarRoads.ts`, made from the network for the whole map, a few MB) stands for every road
 *   cell for good. Its cells (`roadCells`) are the cells of the map with roads: what the view chooses from.
 * - A cell's detailed blocks are BUILT ONLY WHEN THE VIEW WANTS THE CELL (`RoadLook.build`, taken by the owner's next build): the cells
 *   within `reach` of the eye (the full level's reach, a turn of the camera has them), and the cells in the view's frustum within
 *   `wantReach`, nearest first (Cesium's traversal visits the tiles in the frustum, nearest first) - never the map. A cell is wanted
 *   past the far budget only within `reach`; past it the root draws it (Cesium's `maximumCacheOverflowBytes`: what the view needs is
 *   never left out for the budget, what it does not need is never built for it).
 * - Once built, a block's far level (`attachFarLevel`, 0.12 m off the full one) replaces the root in its cell, and its full level
 *   replaces the far one where it is wanted and the near budget holds it: within the reach and meeting the frustum; past the budget, the
 *   near blocks out of the view go first, the least recently seen first (3DTilesRendererJS `lruCache`), then the farthest in it - never a
 *   hole, the far level stands.
 * - A cell no longer wanted is LET GO when the far levels are over their budget (`RoadLook.release`): the ones out of the view first,
 *   the least recently seen first, then the farthest. Its blocks are hidden and the root shown at once; the owner's next build retires
 *   them (their tiles are kept in the store, `derivedCache.ts`: a cell wanted again is built from them). A cell the root does not cover
 *   (none made, or made before the roads changed) is kept, and the root asked for (`wantsNetwork`).
 * - The map's view (`networkFrom`): every cell past it is drawn by the root, its blocks kept but hidden (`parked`), none wanted.
 *
 * DO NOT build the whole map's cells and then let the far ones go: that is what the memory of a 10 km city was, and what the page died of
 * (2026-10-26). The cells built are the view's, bounded by the budgets, however large the map.
 */
export interface RoadResidency {
  /** The view's frustum (three's axes); null: every block is in view. */
  view?: Frustum | null;
  /** The most the full levels may hold, bytes. */
  budget?: number;
  /** The most the blocks' far levels may hold, bytes; none: every far level kept. */
  farBudget?: number;
  /** What draws a cell whose blocks are not built or were let go (the network's far level); none: none is let go. */
  network?: CellCover | null;
  /** The looks so far (`updateRoadLevels`): when each block last met the view (`BlockLevels.seenAt`). */
  looks?: number;
  /** Set by a look that found cells to be drawn by the root the root cannot stand for (none, or made before the roads changed): the owner makes it again. */
  wantsNetwork?: boolean;
  /** From this distance (scene units) the root draws a cell in place of its blocks, whatever the budget: the map's view (`renderer.ts`),
   *  where a block's paint and kerbs are under a pixel; none: the budget alone decides. */
  networkFrom?: number | undefined;
  /** The cells drawn by the root for the view (`networkFrom`): their blocks kept, only hidden, so coming back costs nothing. */
  parked?: Set<string>;
  /** How far round the eye the cells in the view are wanted in detail, scene units; none: `reach` alone. */
  wantReach?: number;
  /** The cells taken: built, or being built (`awaiting`). The owner's builds visit the tiles of these cells and no other (`roadSurfaces.ts` SurfaceReuse.within). */
  taken?: Set<string>;
  /** The cells taken whose blocks have not landed yet: the root draws them meanwhile. */
  awaiting?: Set<string>;
  /** The cells let go at a look (their blocks hidden, the root shown) until the owner's next build retires them (`RoadLook.release`). */
  releasing?: Set<string>;
  /** Bytes a cell's far levels take per triangle of the root in it, as the cells built so far measure: what a cell not built yet is reckoned at. */
  farPerRootTriangle?: number;
}

/** The network's far level as the residency sees it (`networkFarRoads.ts`). */
export interface CellCover {
  /** Whether it draws the cell's roads as they are now (made, of the roads standing). */
  covers(key: string): boolean;
  show(key: string): void;
  hide(key: string): void;
}

/** What one look leaves the owner to do (`updateRoadLevels`). */
export interface RoadLook {
  /** The cells the view wants built, not taken yet: nearest first, the ones in the view first. The owner takes them a few at a time. */
  readonly build: readonly string[];
  /** The cells let go (`RoadResidency.releasing`): the owner's next build retires their blocks. */
  readonly release: readonly string[];
  /** How many cells the view wants that are not built yet (`build`, and the ones taken and awaited). */
  readonly wanted: number;
  /** Blocks and cells changed by the look. */
  readonly changed: number;
}

/** Bytes a block's full level holds for its far level's, before it was ever near. */
const NEAR_PER_FAR = 5;
/** How far round a block's box the view meets it, m: a block just past the edge is near before the eye pans onto it. */
const VIEW_MARGIN = 64;
/** Bytes a cell's far levels take per triangle of the root in it, before any cell measured it (the city of 25,000 buildings: 264 MB of far levels over a root of some 400,000 triangles, 2026-10-25). */
const FAR_PER_ROOT_TRIANGLE = 640;
/** How high a cell's box reaches for the frustum (three's axes): from under the ground to over any deck. */
const CELL_BELOW = -50, CELL_ABOVE = 100;
/** The bytes a block's full level holds on the GPU (its arrays, or what they were once uploaded, `gpuOnly.ts`), kept as its last measure. */
function fullBytes(mesh: Mesh, levels: BlockLevels): number {
  const bytes = geometryCost(mesh.geometry as BufferGeometry).bytes;
  if (bytes > 0) levels.nearBytes = bytes;
  return bytes;
}

/** A road cell as one look sees it: its blocks (none for a cell not built), where it is to the eye. */
interface Cell {
  readonly key: string;
  readonly blocks: Mesh[];
  /** Its distance to the eye, scene units: the nearest of its blocks', else its square's. */
  d: number;
  seen: boolean;
  /** The last look a block of it met the view. */
  at: number;
  /** Its blocks' far levels' bytes now. */
  bytes: number;
  /** A block near, coming near or whose far level is being made: its levels stay. */
  held: boolean;
  /** Blocks whose far level stands. */
  live: number;
}

/** The key of a cell on the road blocks' grid, and its square's box in three's axes (x, y up, z = -y). */
const cellKey = (i: number, j: number): string => `${i},${j}`;
const cellBox = (key: string, side: number, into: Box3): Box3 => {
  const [i, j] = key.split(',').map(Number) as [number, number];
  into.min.set(i * side, CELL_BELOW, -(j + 1) * side);
  into.max.set((i + 1) * side, CELL_ABOVE, -j * side);
  return into;
};
/** A cell's distance to the eye: the gap from the eye to its square, scene units (x, z). */
const cellGap = (key: string, side: number, focusX: number, focusZ: number): number => {
  const [i, j] = key.split(',').map(Number) as [number, number];
  const x0 = i * side, x1 = (i + 1) * side, z0 = -(j + 1) * side, z1 = -j * side;
  return Math.hypot(Math.max(x0 - focusX, 0, focusX - x1), Math.max(z0 - focusZ, 0, focusZ - z1));
};

/** The view's cells drawn by the root (`networkFrom`) and the others given back to their blocks; returns the cells changed.
 *  DO NOT draw a cell's blocks at the map's view: one mesh a block for each surface (asphalt, footway, kerb, planting, each paint colour; the
 *  verge too when this was measured), ~320 draw calls of the 448 of a city of 8,102 buildings, against the root's two (`npm run diagnose`, 2026-10-22). */
function parkCells(cells: ReadonlyMap<string, Cell>, residency: RoadResidency, network: CellCover): number {
  const parked = residency.parked!, releasing = residency.releasing!;
  const from = residency.networkFrom;
  let changed = 0;
  for (const cell of cells.values()) {
    if (releasing.has(cell.key) || cell.blocks.length === 0) continue;
    const moving = cell.blocks.some((mesh) => { const levels = levelsOf(mesh)!; return levels.pending || levels.bringing; });
    const want = from !== undefined && cell.d >= from && !moving;
    if (want && !network.covers(cell.key)) { residency.wantsNetwork = true; }
    if (want && network.covers(cell.key)) {
      // Hidden again at every look: a level a build or a bring showed meanwhile goes back under the root.
      hideBlocks(cell);
      if (!parked.has(cell.key)) { parked.add(cell.key); network.show(cell.key); changed++; }
    } else if (parked.has(cell.key)) {
      showBlocks(cell);
      parked.delete(cell.key);
      network.hide(cell.key);
      changed++;
    }
  }
  return changed;
}

/** A cell's blocks hidden at both levels (the root draws the cell). */
function hideBlocks(cell: Cell): void {
  for (const mesh of cell.blocks) { mesh.visible = false; const coarse = levelsOf(mesh)!.coarse; if (coarse) coarse.visible = false; }
}

/** A cell's blocks shown as their levels stand. */
function showBlocks(cell: Cell): void {
  for (const mesh of cell.blocks) {
    const levels = levelsOf(mesh)!;
    if (!levels.coarse) { mesh.visible = true; continue; }
    mesh.visible = levels.full;
    levels.coarse.visible = !levels.full;
  }
}

/**
 * The cells the view wants, and the far levels under `residency.farBudget` (see `RoadResidency`): the cells wanted and not taken, for
 * the owner to build; the cells let go, their blocks hidden and the root shown, for the owner to retire.
 */
function chooseCells(cells: Map<string, Cell>, roadCells: ReadonlyMap<string, number> | null, side: number, focusX: number, focusZ: number,
  reach: number, residency: RoadResidency): RoadLook & { changed: number } {
  const network = residency.network ?? null;
  const taken = residency.taken ??= new Set();
  const awaiting = residency.awaiting ??= new Set();
  const releasing = residency.releasing ??= new Set();
  const parked = residency.parked ??= new Set();
  const farBudget = residency.farBudget ?? Infinity;
  const wantReach = Math.max(reach, residency.wantReach ?? reach);
  const from = residency.networkFrom;
  const view = residency.view ?? null;
  const box = new Box3();
  let changed = 0;
  // What a cell's far levels take, per triangle of the root in it, from the cells built so far.
  if (roadCells) {
    let bytes = 0, triangles = 0;
    for (const cell of cells.values()) {
      const root = roadCells.get(cell.key) ?? 0;
      if (cell.live === 0 || root === 0 || releasing.has(cell.key)) continue;
      bytes += cell.bytes;
      triangles += root;
    }
    if (triangles > 0) residency.farPerRootTriangle = bytes / triangles;
  }
  const perTriangle = residency.farPerRootTriangle ?? FAR_PER_ROOT_TRIANGLE;
  const estimate = (key: string): number => (roadCells?.get(key) ?? 0) * perTriangle;
  // Every cell of the map with roads, as the look sees it: the built ones with their blocks, the rest by their squares.
  const all = new Map<string, Cell>(cells);
  const place = (key: string): Cell => {
    let cell = all.get(key);
    if (!cell) {
      const d = cellGap(key, side, focusX, focusZ);
      const seen = !view || view.intersectsBox(cellBox(key, side, box).expandByScalar(VIEW_MARGIN));
      all.set(key, cell = { key, blocks: [], d, seen, at: 0, bytes: 0, held: false, live: 0 });
    }
    return cell;
  };
  if (roadCells) for (const key of roadCells.keys()) place(key);
  for (const key of taken) place(key);
  /** Whether the view wants a cell in detail: within the reach, or in the frustum within `wantReach`; none past the map's view's line. */
  const wanted = (cell: Cell): boolean => (from === undefined || cell.d < from) && (cell.d < reach || (cell.seen && cell.d < wantReach));
  // The far levels held now: the built cells', and what the cells awaited will take.
  let used = 0;
  for (const cell of all.values()) {
    if (releasing.has(cell.key)) continue;
    if (cell.live > 0) used += cell.bytes;
    else if (awaiting.has(cell.key)) used += estimate(cell.key);
  }
  // A cell being let go that the view wants again: given back to its blocks before the owner retires them.
  for (const key of [...releasing]) {
    const cell = all.get(key);
    if (!cell || !wanted(cell)) continue;
    releasing.delete(key);
    showBlocks(cell);
    network?.hide(key);
    used += cell.bytes;
    changed++;
  }
  // The cells wanted and not taken, in the order they are asked: the ones in the view first, the nearest first.
  const toBuild: Cell[] = [];
  let wantedLeft = 0;
  for (const cell of all.values()) {
    if (!wanted(cell) || parked.has(cell.key)) continue;
    if (taken.has(cell.key)) { if (awaiting.has(cell.key)) wantedLeft++; continue; }
    // No root to stand for it while it is built, or no roads there: nothing to build.
    if (roadCells && !roadCells.has(cell.key)) continue;
    toBuild.push(cell);
  }
  toBuild.sort((a, b) => Number(b.seen) - Number(a.seen) || a.d - b.d);
  const build: string[] = [];
  for (const cell of toBuild) {
    const bytes = estimate(cell.key);
    // Past the far budget only within the reach: the root draws the rest of the view.
    if (cell.d >= reach && used + bytes > farBudget) continue;
    used += bytes;
    build.push(cell.key);
  }
  wantedLeft += build.length;
  // Over the budget: the built cells the view does not want let go, out of the view first, the least recently seen first, then the farthest.
  if (used > farBudget && network) {
    const free = [...all.values()].filter((cell) => cell.live > 0 && !cell.held && !wanted(cell) && !releasing.has(cell.key) && !awaiting.has(cell.key));
    free.sort((a, b) => Number(a.seen) - Number(b.seen) || a.at - b.at || b.d - a.d);
    for (const cell of free) {
      if (used <= farBudget) break;
      // Not covered by the root: kept, and the root asked for.
      if (!network.covers(cell.key)) { residency.wantsNetwork = true; continue; }
      hideBlocks(cell);
      network.show(cell.key);
      parked.delete(cell.key);
      releasing.add(cell.key);
      used -= cell.bytes;
      changed++;
    }
  }
  return { build, release: [...releasing], wanted: wantedLeft, changed };
}

/**
 * The levels brought up to the camera at (`focusX`, `focusY`) in world units, under `residency`'s budgets; `roadCells`, the cells of the
 * map with roads and the root's triangles in each (`networkFarRoads.ts` cells; null before the root landed: only the blocks' cells are
 * known), on cells of `side` world units. Returns what the owner is to build and to retire (`RoadLook`).
 */
export function updateRoadLevels(blocks: Iterable<Mesh>, focusX: number, focusY: number, reach: number, residency: RoadResidency = {},
  roadCells: ReadonlyMap<string, number> | null = null, side = 0): RoadLook {
  let changed = 0;
  const look = residency.looks = (residency.looks ?? 0) + 1;
  const viewBox = new Box3();
  const view = residency.view ?? null;
  const budget = residency.budget ?? Infinity;
  const parked = residency.parked ??= new Set();
  const releasing = residency.releasing ??= new Set();
  residency.wantsNetwork = false;
  const wanted: { mesh: Mesh; d: number }[] = [];
  const full: { mesh: Mesh; d: number; seen: boolean; bytes: number; at: number }[] = [];
  const cells = new Map<string, Cell>();
  let total = 0;
  const farFrom = reach * FAR_MARGIN;
  for (const mesh of blocks) {
    const levels = levelsOf(mesh);
    if (!levels) continue;
    const d = distance(levels, focusX, focusY);
    const box = mesh.geometry.boundingBox ?? levels.coarse?.geometry.boundingBox ?? null;
    const seen = !view || !box || view.intersectsBox(viewBox.copy(box).expandByScalar(VIEW_MARGIN));
    if (seen) levels.seenAt = look;
    let cell: Cell | undefined;
    if (levels.cell !== undefined) {
      cell = cells.get(levels.cell);
      if (!cell) cells.set(levels.cell, cell = { key: levels.cell, blocks: [], d, seen, at: levels.seenAt ?? 0, bytes: 0, held: false, live: 0 });
      cell.blocks.push(mesh);
      cell.d = Math.min(cell.d, d);
      cell.seen ||= seen;
      cell.at = Math.max(cell.at, levels.seenAt ?? 0);
      if (levels.pending || levels.bringing) cell.held = true;
    }
    if (!levels.coarse) continue;
    if (cell) { cell.live++; cell.bytes += geometryCost(levels.coarse.geometry as BufferGeometry).bytes; }
    // A cell let go or parked: its blocks stay hidden at both levels, nothing brought near.
    if (levels.cell !== undefined && (releasing.has(levels.cell) || parked.has(levels.cell))) continue;
    if (levels.full) {
      if (cell) cell.held = true;
      if (d > farFrom) { makeFar(mesh); changed++; continue; }
      const bytes = fullBytes(mesh, levels);
      total += bytes;
      full.push({ mesh, d, seen, bytes, at: levels.seenAt ?? 0 });
    } else if (d < reach && seen && !levels.bringing) wanted.push({ mesh, d });
  }
  // Past the budget: out of the view first, the least recently seen first; then the farthest of the view.
  if (total > budget) {
    full.sort((a, b) => Number(a.seen) - Number(b.seen) || a.at - b.at || b.d - a.d);
    for (const block of full) {
      if (total <= budget) break;
      makeFar(block.mesh);
      total -= block.bytes;
      changed++;
    }
  }
  wanted.sort((a, b) => a.d - b.d);
  let brought = 0;
  for (const { mesh } of wanted) {
    if (brought >= BRING_PER_LOOK) break;
    const levels = levelsOf(mesh)!;
    const bytes = levels.nearBytes ?? geometryCost(levels.coarse!.geometry as BufferGeometry).bytes * NEAR_PER_FAR;
    // The nearest that does not fit holds the rest back: DO NOT bring a farther one in its place.
    if (total + bytes > budget) break;
    total += bytes;
    makeNear(mesh);
    const cell = levels.cell !== undefined ? cells.get(levels.cell) : undefined;
    if (cell) cell.held = true;
    brought++;
    changed++;
  }
  if (residency.network) changed += parkCells(cells, residency, residency.network);
  const chosen = chooseCells(cells, roadCells, side, focusX, -focusY, reach, residency);
  return { build: chosen.build, release: chosen.release, wanted: chosen.wanted, changed: changed + chosen.changed };
}

/** The residency's cells forgotten (another map opened: its blocks and the root went with the last one). */
export function forgetRoadCells(residency: RoadResidency): void {
  residency.taken?.clear();
  residency.awaiting?.clear();
  residency.releasing?.clear();
  residency.parked?.clear();
  residency.wantsNetwork = false;
  delete residency.farPerRootTriangle;
}

/** The key of the road cell (`side` world units a side, its lines from the origin) a point lies in. */
export const roadCellOf = (x: number, y: number, side: number): string => cellKey(Math.floor(x / side), Math.floor(y / side));

/** Whether a block at (`x`, `y`) in world units is within `reach` of the camera: the level a block is made at. */
export const isNear = (x: number, y: number, focusX: number, focusY: number, reach: number): boolean =>
  Math.hypot(x - focusX, y - focusY) < reach;
