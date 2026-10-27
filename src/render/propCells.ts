import {
  BufferGeometry,
  Box3,
  Group,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  type InstancedMesh,
  type InterleavedBuffer,
  type BufferAttribute,
  Matrix4,
  Sphere,
  Vector3,
  Vector4,
  type Camera,
  type Frustum,
  type OrthographicCamera,
  type PerspectiveCamera,
} from 'three';

import type { ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import { CELL } from '@world/cells';
import { m } from '@world/units';
import { ViewCells, type CellKey } from '@world/viewCells';
import { HYSTERESIS, batchMesh, createCellInstances, releaseBatchMesh, screenHalf, warmMesh, type CellInstances, type KindMesh, type KindSpec, type Pack } from './cellInstances';
import { NEAR_SQUARE, YAW_POSE, nearCode } from './instanceRuns';
import { createFarBands, showLadder, type Banded, type FarLadder, type FarRung } from './farLadders';
import { gpuOnlyAttributes } from './mesh/gpuOnly';
import { PICTURE_PX, type PlantImpostors } from './plantImpostors';
import { castBySize } from './shadowCasters';
import { type PropPlacement, createPropAsks } from './propAsks';

/**
 * THE PROPS HELD ROUND THE VIEW, NOT FOR THE MAP: the gardens' plants, the street furniture and its plants (`gardens.ts`,
 * `streetFurnitureLayer.ts`), worked out cell by cell from the document as the view asks for them (`viewCells.ts`), never for the whole map.
 *
 * - NEAR, the square of world cells round the eye where a plant may be big enough on the screen to be drawn whole (`PICTURE_PX`):
 *   each cell's things placed on the CPU (`place`, a pure function of the cell and the document) and kept in the cells' instances
 *   (`cellInstances.ts`), culled and levelled thing by thing as before. Held under a CPU budget, least recently used out first.
 * - FAR, everything else the view reaches, to the horizon: blocks of 4 x 4 cells, each the same things placed the same way, written
 *   once into GPU buffers (a picture batch for the plants, `plantImpostors.ts`, and a batch per kind for the rest) whose CPU arrays go
 *   once they are on the GPU (`mesh/gpuOnly.ts`). The GPU thins and sizes the pictures itself (`impostorThin`), as it does the near
 *   cells' far pictures: the horizon shows the same trees at the same places. Held under a GPU budget.
 * - A far batch's thing standing in the near square is not drawn (its pose's cell against `NEAR_SQUARE`, `instanceRuns.ts`): the near
 *   cells draw it. The square only covers the cells whose near things are all in: nothing is drawn twice, nothing missing.
 *
 * DO NOT go back to placing every garden, bench and street tree of the map on the page: 102,600 garden plants of the 8,100-building city
 * held 29 MB and the furniture 46 MB (2026-10-21), ~2 GB at 200,000 buildings.
 */

/** The near cells' side: the world's grid (`cells.ts`). */
export const PROP_CELL = CELL;
/** Cells along a far block's side. */
const FAR_CELLS = 4;
const FAR_SIDE = PROP_CELL * FAR_CELLS;
/** The most cells the near square reaches each way from the eye's: a 4K screen, a tall tree. */
const MOST_NEAR = 8;
/** The size of the largest plant before any is placed: a street tree (`streetFurnitureLayer.ts`, up to 9.5 m tall) seen whole. */
const FIRST_LARGEST = m(14);
/** How far over and under the ground under the view's middle an orthographic view's footprint is measured. */
const GROUND_SPAN = m(60);
/** A far block's things in the shadow pass: how high they stand, how deep the ground may be. */
const BLOCK_LOW = m(-200), BLOCK_HIGH = m(600);
/** Time a frame may spend placing cells, ms: the near square's rings first, then the far blocks nearest first. At least one of each. */
const FRAME_MS = 6;
/** A product's own objects besides its arrays. */
const NEAR_OVERHEAD = 256;
const FAR_OVERHEAD = 1024;

/** What a view reaches, on the ground, in world units (x east, y north). */
export interface PropView {
  /** Projection times view. */
  readonly view: Matrix4;
  readonly frustum: Frustum;
  /** Pixels a world unit spans one unit before the eye (perspective) or anywhere (orthographic): half the screen's height in device pixels times the projection's scale. */
  readonly perUnitAtOne: number;
  readonly ortho: boolean;
  /** Where distances are measured from: the eye over the ground (perspective) or the footprint's middle (orthographic). */
  readonly x: number;
  readonly y: number;
  /** How far the view reaches on the ground from there: the far plane's farthest corner, or the footprint's radius. */
  readonly reach: number;
  /** Perspective: how much farther than its depth a point at the frustum's corner is (the cull measures a size by the depth, `cellInstances.ts`), and the eye's height over the ground. */
  readonly slant: number;
  readonly height: number;
  /** The ground's height under the view (three's y), for the far blocks' boxes. */
  readonly ground: number;
}

const corner = new Vector3(), far = new Vector3(), inverse = new Matrix4();

/** The view a camera has of the ground at `ground` (three's y), on a screen `half` device pixels half high. */
export function propView(camera: Camera, frustum: Frustum, half: number, ground: number): PropView {
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = view.elements;
  const perUnitAtOne = Math.hypot(e[1]!, e[5]!, e[9]!) * half;
  const ortho = (camera as OrthographicCamera).isOrthographicCamera === true;
  if (!ortho) {
    const p = camera.matrixWorld.elements, q = camera.projectionMatrix.elements;
    const slant = Math.sqrt(1 + 1 / (q[0]! * q[0]!) + 1 / (q[5]! * q[5]!));
    return { view, frustum, perUnitAtOne, ortho, x: p[12]!, y: -p[14]!, reach: ((camera as PerspectiveCamera).far ?? m(8000)) * slant, ground, slant, height: Math.max(0, p[13]! - ground) };
  }
  // The footprint: the frustum's corner rays met with the ground a little over and under where the view looks.
  inverse.copy(view).invert();
  const xs: number[] = [], ys: number[] = [];
  for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    corner.set(nx, ny, -1).applyMatrix4(inverse);
    far.set(nx, ny, 1).applyMatrix4(inverse);
    for (const level of [ground - GROUND_SPAN, ground + GROUND_SPAN]) {
      const dy = far.y - corner.y;
      const t = Math.abs(dy) < 1e-9 ? 1 : Math.min(1, Math.max(0, (level - corner.y) / dy));
      xs.push(corner.x + (far.x - corner.x) * t);
      ys.push(-(corner.z + (far.z - corner.z) * t));
    }
  }
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
  let reach = 0;
  for (let i = 0; i < xs.length; i++) reach = Math.max(reach, Math.hypot(xs[i]! - x, ys[i]! - y));
  return { view, frustum, perUnitAtOne, ortho, x, y, reach, ground, slant: 1, height: 0 };
}

/** How far from the view's point things of `size` across are at least `px` pixels: the view's reach, or -1 for none (orthographic, too small). */
function reachFor(v: PropView, size: number, px: number): number {
  if (v.ortho) return size * v.perUnitAtOne >= px ? v.reach : -1;
  // The depth it is that big to, as far as the frustum's corner takes it from the eye, over the ground from under the eye.
  const far = Math.min(v.reach, ((size * v.perUnitAtOne) / px) * v.slant);
  return Math.sqrt(Math.max(0, far * far - v.height * v.height));
}

/** The near square a view asks for: its middle cell and how many cells it reaches each way (-1: none). */
export interface PropSquare { readonly cx: number; readonly cy: number; readonly k: number }

/** The square round the view's point holding every plant `largest` across (world units) big enough to be drawn whole there (`PICTURE_PX`, less the band it keeps its level in). */
function nearSquareOf(v: PropView, largest: number): PropSquare {
  const reach = reachFor(v, largest, PICTURE_PX * (1 - HYSTERESIS));
  const cx = Math.floor(v.x / PROP_CELL), cy = Math.floor(v.y / PROP_CELL);
  return { cx, cy, k: reach < 0 ? -1 : Math.min(MOST_NEAR, Math.ceil(reach / PROP_CELL)) };
}

// What a layer stands about a rectangle (`propAsks.ts`, where its asks off the page are kept).
export type { PropPlacement } from './propAsks';

export interface PropLayerSpec {
  readonly name: string;
  /** The placing's version: a product made by another is made again. */
  readonly version: number;
  /** The kinds drawn, as the cells' instances draw them near. */
  readonly kinds: readonly KindSpec[];
  /** How far off the view a thing still throws its shadow into it. */
  readonly margin: number;
  /** The diary's kinds the placing reads, and how far past a change's rectangle a thing it moved may stand. */
  readonly changes: readonly ChangeKind[];
  readonly pad: number;
  /** The plants' pictures, and each kind's picture in them (null: a kind drawn far by its own meshes). */
  readonly pictures: PlantImpostors | null;
  readonly pictureOf: readonly (number | null)[];
  /** The still pictures its kinds' far meshes draw (`plantImpostors.ts` propPictures): their far batches sized by the view each cull is for. */
  readonly stills?: readonly PlantImpostors[];
  /** The things standing about a rectangle, from the document as it is: a pure function of the rectangle and the document. */
  place(rect: ChangeRect): PropPlacement;
  /** The same placing worked out off the page (a job, `gardens.ts`): its answer to come; null where it cannot be asked now (placed on the page then).
   *  None: placed on the page, within the frame's time. */
  ask?(rect: ChangeRect): Promise<PropPlacement> | null;
  /** A placement asked off the page came: what the view wants may be drawn now (a frame asked). */
  arrived?(): void;
  /** Budgets: the near cells' CPU bytes, the far blocks' CPU bytes before their upload and their GPU bytes. */
  readonly nearBytes?: number;
  readonly farBytes?: number;
  readonly gpuBytes?: number;
}

/** A near cell's things, kept to be put in the cells' instances while the cell is in the square. */
interface NearCell {
  readonly packs: ReadonlyMap<number, Pack>;
  readonly growing: boolean;
}

/** A far block's batches: their meshes, each one's shadow chooser, whether it grows with the hour, its arrays not yet on the GPU. */
interface FarBlock {
  /** Its meshes' parent: shown only while the view wants the block (a block held for later draws nothing). */
  readonly group: Group;
  /** Its plants' pictures' batch, under `group`: shown once the pictures are taken. */
  readonly pictured: Group;
  /** Its kinds drawn by their ladders: their levels chosen each frame (`show`). */
  readonly ladders: FarLadder[];
  /** Its batches of a kind faded out past `beyond` from the eye (`KindLevels.fadesAt`): hidden while all of the batch stands past it. */
  readonly fading: readonly { readonly mesh: InstancedMesh; readonly beyond: number }[];
  readonly meshes: InstancedMesh[];
  readonly uncast: (() => void)[];
  readonly growing: boolean;
  waiting: number;
  readonly gpu: number;
}

/** Whether all of `mesh` (its bounding sphere) stands past `beyond` world units from the eye of `view` (a view-projection): its sphere's
 *  nearest depth (clip w, never more than the distance) past it. A view from above (w 1) fades nothing. */
function fadedOut(mesh: InstancedMesh, beyond: number, view: Matrix4): boolean {
  const s = mesh.boundingSphere;
  if (!s) return false;
  const e = view.elements;
  const w = e[3]! * s.center.x + e[7]! * s.center.y + e[11]! * s.center.z + e[15]!;
  return w - s.radius * Math.hypot(e[3]!, e[7]!, e[11]!) > beyond;
}

/** The far classes: the plants' pictures and the things drawn at every size reach the horizon; the small things drawn down to a pixel (`KindLevels.least`) only where they are. */
const enum FarClass { wide = 0, small = 1 }

export interface PropLayer {
  /** The near cells' meshes and the far batches. */
  readonly group: Group;
  readonly meshes: readonly InstancedMesh[];
  /** Triangles of the near meshes, every live instance counted. */
  readonly triangles: number;
  /** Bytes held on the CPU: the near cells' things, the far blocks' arrays not yet on the GPU, the near instances' arrays. */
  readonly cpuBytes: number;
  readonly near: ViewCells<NearCell>;
  readonly far: readonly ViewCells<FarBlock>[];
  /** The largest plant it placed so far, world units across (its picture's sphere times its scale): what the near square reaches for. */
  readonly largestPicture: number;
  /** The cells and blocks the view wants that are not placed yet. */
  readonly busy: boolean;
  /** The diary's changes since the last look: the cells and blocks they reached dropped, placed again as the view asks. */
  follow(journal: ChangeJournal): void;
  /** The cells and blocks with a thing that grows with the hour dropped, and the placements come with one not yet taken (a new city hour). */
  forgetGrowing(): void;
  /** Every placement asked off the page let go, its answer never taken (the layer placed from another document). */
  forgetAsked(): void;
  /** The near cells of the square's rings placed (within the frame's time), up to `k`: the rings in. */
  ringsIn(square: PropSquare, deadline: number): number;
  /** The square drawn near: the cells within `k` of its middle put in the cells' instances, the rest taken out; then the far blocks the view wants placed (within the frame's time). */
  show(square: PropSquare, view: PropView, deadline: number): void;
  setMap(map: boolean): void;
  /** A mesh of each far ladder's rung as the far blocks draw it (its band's materials, `farLadders.ts`), one slot each: what compiles their
   *  programs ahead (`streetFurnitureLayer.ts` warm); the near cells' own are their stores'. */
  warm(): InstancedMesh[];
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

const keyOfCell = (cx: number, cy: number): CellKey => (cx + 32768) * 65536 + (cy + 32768);
const columnOf = (key: CellKey): number => Math.floor(key / 65536) - 32768;
const rowOf = (key: CellKey): number => (key % 65536) - 32768;

/** A rectangle's things kept to those whose pose stands in the cells `cx0..cx1`, `cy0..cy1`; `code` gives each one's eighth float (none: as placed). */
function within(packs: ReadonlyMap<number, Pack>, cx0: number, cy0: number, cx1: number, cy1: number,
  code?: (cx: number, cy: number) => number): Map<number, Pack> {
  const stride = YAW_POSE.stride, out = new Map<number, Pack>();
  for (const [kind, pack] of packs) {
    const keep: number[] = [];
    const codes: number[] = [];
    for (let i = 0; i < pack.count; i++) {
      // Its cell from the pose's own floats (float32): the near cells and the far blocks file a thing by the same numbers, and the GPU reads them.
      const cx = Math.floor(pack.data[i * stride]! / PROP_CELL), cy = Math.floor(-pack.data[i * stride + 2]! / PROP_CELL);
      if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
      keep.push(i);
      if (code) codes.push(code(cx, cy));
    }
    if (keep.length === 0) continue;
    if (keep.length === pack.count && !code) { out.set(kind, pack); continue; }
    const data = new Float32Array(keep.length * stride), scales = new Float32Array(keep.length);
    const colours = pack.colours ? new Float32Array(keep.length * 3) : null;
    keep.forEach((i, j) => {
      data.set(pack.data.subarray(i * stride, (i + 1) * stride), j * stride);
      if (code) data[j * stride + 7] = codes[j]!;
      scales[j] = pack.scales[i]!;
      if (colours) colours.set(pack.colours!.subarray(i * 3, i * 3 + 3), j * 3);
    });
    out.set(kind, { data, colours, scales, count: keep.length });
  }
  return out;
}

const packBytes = (packs: ReadonlyMap<number, Pack>): number => {
  let n = 0;
  for (const p of packs.values()) n += p.data.byteLength + p.scales.byteLength + (p.colours?.byteLength ?? 0) + 64;
  return n;
};

/** A layer of things held round the view. */
export function createPropLayer(spec: PropLayerSpec): PropLayer {
  /** What is asked off the page (`propAsks.ts`): a cell derived once its placement came. */
  const { ready, placementFor, prune, follow: followOff, forgetGrowing: forgetGrowingAsked, clear: clearAsked } = createPropAsks(spec);
  const group = new Group();
  group.name = spec.name;
  const cells: CellInstances = createCellInstances(spec.kinds, YAW_POSE, spec.margin);
  /** The far ladders' rungs' materials (`farLadders.ts`), sized by the view the cells are culled for. */
  const bands = createFarBands();
  const classOf = spec.kinds.map((k, i) => (spec.pictureOf[i] === null && k.levels?.least !== undefined ? FarClass.small : FarClass.wide));
  /** The largest plant placed so far (a street tree's before any). */
  let largestPicture = FIRST_LARGEST;
  /** The largest of the small kinds' things placed so far, world units across: from their models at their own size until some are placed. */
  let largestSmall = 0;
  spec.kinds.forEach((k, i) => { if (classOf[i] === FarClass.small) largestSmall = Math.max(largestSmall, 2 * k.levels!.reach); });
  /** The fewest pixels a small kind is drawn at (`KindLevels.least`): a block whose things are all under it holds nothing to draw. */
  const leastSmall = spec.kinds.reduce((least, k, i) => (classOf[i] === FarClass.small ? Math.min(least, k.levels!.least!) : least), Infinity);
  const note = (packs: ReadonlyMap<number, Pack>): void => {
    for (const [kind, pack] of packs) {
      const picture = spec.pictureOf[kind];
      const reach = picture !== null && picture !== undefined && spec.pictures ? spec.pictures.reach[picture]! : spec.kinds[kind]!.levels?.reach;
      if (reach === undefined) continue;
      let most = 0;
      for (let i = 0; i < pack.count; i++) most = Math.max(most, pack.scales[i]!);
      const size = 2 * reach * most;
      if (picture !== null && picture !== undefined) largestPicture = Math.max(largestPicture, size);
      else if (classOf[kind] === FarClass.small) largestSmall = Math.max(largestSmall, size);
    }
  };

  /** The near cells put in the instances now, by key. */
  const shown = new Map<CellKey, NearCell>();
  /** Taken out of the instances at the next `show`: a shown cell dropped by an edit or the hour. */
  const gone: NearCell[] = [];
  const growingNear = new Set<CellKey>();
  const near = new ViewCells<NearCell>({
    name: `${spec.name} near`, version: spec.version, side: PROP_CELL, reach: 0,
    cpuBudget: spec.nearBytes ?? 48 * 1048576, kinds: spec.changes, pad: spec.pad,
    derive(key, rect) {
      const placed = placementFor(near, key, rect);
      const cx = columnOf(key), cy = rowOf(key);
      const packs = within(placed.packs, cx, cy, cx, cy);
      note(packs);
      if (placed.growing) growingNear.add(key);
      return { value: { packs, growing: placed.growing }, cpuBytes: packBytes(packs) + NEAR_OVERHEAD };
    },
    release(key, value) {
      growingNear.delete(key);
      if (shown.get(key) === value) { shown.delete(key); gone.push(value); }
    },
  });

  let meshList: InstancedMesh[] | null = null;
  const farMeshes = new Set<InstancedMesh>();
  const farGroup = new Group();
  farGroup.name = `${spec.name}-far`;
  group.add(farGroup);
  const growingFar = [new Set<CellKey>(), new Set<CellKey>()];
  /** Each class's held blocks, by key. */
  const heldFar = [new Map<CellKey, FarBlock>(), new Map<CellKey, FarBlock>()];
  const pictureKinds = spec.kinds.map((_, i) => spec.pictureOf[i] !== null && spec.pictureOf[i] !== undefined);

  /** A laddered kind's geometric rungs in a far block (`farLadders.ts`): each one's bodies, drawn under their own name and the band's materials,
   *  the band (the near cells' bars, no hysteresis: a far thing's level is its size's, frame by frame), its lowest bar while the pictures are
   *  not taken (the cut: it draws their band too), and whether it is its model's shadow alone (`KindLevels.shadowNear`, a lamp: cast by its
   *  model at every level). `midMade`: its simplified models made when the block is (else its model draws their band). */
  const rungsOf = (kindSpec: KindSpec, midMade: boolean): {
    readonly bodies: readonly KindMesh[]; readonly band: Banded; readonly floor: number; readonly floorUnpictured: number; readonly shadowAlone: boolean;
    drawn(body: KindMesh): KindMesh; casts(body: KindMesh): boolean;
  }[] => {
    const levels = kindSpec.levels!;
    const least = levels.least ?? 0, far = levels.far!, top = Number.MAX_VALUE, mid = midMade ? levels.mid! : null;
    const castsNear = levels.shadowNear === true;
    const nears = kindSpec.meshes.filter((s) => !s.far && !s.mid && !s.cards);
    const rung = (bodies: readonly KindMesh[], role: string, lo: number, hi: number, floorUnpictured: number, shadowAlone: boolean) => {
      const band = bands.of(bodies[0]!.material, role, levels.reach, lo, hi);
      return {
        bodies, band, floor: lo, floorUnpictured, shadowAlone,
        // Named for its rung: its programs compiled ahead under that name (`warm`).
        drawn: (body: KindMesh): KindMesh => ({ ...body, name: `${body.name}-${role}` }),
        casts: (body: KindMesh): boolean => body.castShadow && (shadowAlone || !castsNear),
      };
    };
    const out = [rung(nears, mid !== null ? 'near' : 'near-unsimplified', mid ?? far, top, mid ?? least, false)];
    if (mid !== null) out.push(rung(kindSpec.meshes.filter((s) => s.mid), 'mid', far, mid, least, false));
    if (castsNear) out.push(rung(nears.filter((s) => s.castShadow), 'shadow', least, top, least, true));
    return out;
  };
  /** Whether a kind is drawn far by its ladder (a street prop: `KindLevels.far` and a picture of its own). */
  const laddered = (kindSpec: KindSpec): boolean => kindSpec.levels?.far !== undefined && kindSpec.meshes.some((s) => s.far);

  /** A far block's batches of one class: the meshes, from its things (codes set), with their arrays let go once uploaded. */
  const batches = (cls: FarClass, key: CellKey, rect: ChangeRect, first: PropPlacement, onUploaded: () => void): { block: FarBlock; arrays: number } => {
    const bx = columnOf(key), by = rowOf(key);
    const cx0 = bx * FAR_CELLS, cy0 = by * FAR_CELLS;
    const pick = (placed: PropPlacement): { packs: Map<number, Pack>; growing: boolean } => {
      const packs = within(placed.packs, cx0, cy0, cx0 + FAR_CELLS - 1, cy0 + FAR_CELLS - 1, nearCode);
      for (const kind of [...packs.keys()]) if (classOf[kind] !== cls) packs.delete(kind);
      return { packs, growing: placed.growing };
    };
    // Its arrays made again (a context restored, `gpuOnlyAttributes`): placed on the page from the document as it is.
    const make = (): { packs: Map<number, Pack>; growing: boolean } => pick(spec.place(rect));
    const { packs, growing } = pick(first);
    note(packs);
    const meshes: InstancedMesh[] = [], uncast: (() => void)[] = [];
    const fading: { mesh: InstancedMesh; beyond: number }[] = [];
    let arrays = 0, waiting = 0;
    const stride = YAW_POSE.stride;
    const own = (mesh: InstancedMesh, buffers: Record<string, BufferAttribute | InterleavedBuffer>, again: () => Record<string, Float32Array>): void => {
      gpuOnlyAttributes(mesh, buffers, again);
      for (const buffer of Object.values(buffers)) {
        arrays += (buffer.array as Float32Array).byteLength;
        waiting++;
        const letGo = buffer.onUploadCallback;
        let sent = false;
        buffer.onUpload(function (this: BufferAttribute | InterleavedBuffer) {
          letGo.call(this);
          if (sent) return;
          sent = true;
          onUploaded();
        });
      }
    };
    /** A batch's bounds: round its things' places, grown by the largest of them. */
    const boundsOf = (list: readonly { pack: Pack; radius: number; centre: number }[]): { sphere: Sphere; largest: number } => {
      const box = new Box3();
      let largest = 0;
      for (const { pack, radius, centre } of list) {
        for (let i = 0; i < pack.count; i++) {
          const at = i * stride;
          box.expandByPoint(corner.set(pack.data[at]!, pack.data[at + 1]!, pack.data[at + 2]!));
          largest = Math.max(largest, (radius + centre) * pack.scales[i]!);
        }
      }
      const sphere = box.getBoundingSphere(new Sphere());
      sphere.radius += largest;
      return { sphere, largest };
    };

    // The plants' pictures, every kind in one batch: each thing's picture (its sphere and its block on the atlas) an instance's attributes.
    const pictures = spec.pictures;
    const plantKinds = [...packs.keys()].filter((kind) => pictureKinds[kind]);
    if (pictures && plantKinds.length) {
      const fill = (from: ReadonlyMap<number, Pack>): Record<string, Float32Array> => {
        let n = 0;
        for (const kind of plantKinds) n += from.get(kind)?.count ?? 0;
        const poses = new Float32Array(n * stride), tints = new Float32Array(n * 3).fill(1), spheres = new Float32Array(n * 4), blocks = new Float32Array(n * 2);
        let at = 0;
        for (const kind of plantKinds) {
          const pack = from.get(kind);
          if (!pack) continue;
          const picture = spec.pictureOf[kind]!, s = pictures.spheres[picture]!;
          const bx2 = picture % pictures.blocks.x, by2 = Math.floor(picture / pictures.blocks.x);
          poses.set(pack.data.subarray(0, pack.count * stride), at * stride);
          if (pack.colours) tints.set(pack.colours.subarray(0, pack.count * 3), at * 3);
          for (let i = 0; i < pack.count; i++) {
            spheres.set([s.centre.x, s.centre.y, s.centre.z, s.radius], (at + i) * 4);
            blocks[(at + i) * 2] = bx2; blocks[(at + i) * 2 + 1] = by2;
          }
          at += pack.count;
        }
        return { poses, tints, aSphere: spheres, aBlock: blocks };
      };
      const filled = fill(packs);
      const count = filled.poses!.length / stride;
      const poses = new InstancedInterleavedBuffer(filled.poses!, stride);
      const tints = new InstancedBufferAttribute(filled.tints!, 3);
      const sphereAttribute = new InstancedBufferAttribute(filled.aSphere!, 4);
      const blockAttribute = new InstancedBufferAttribute(filled.aBlock!, 2);
      const model = new BufferGeometry();
      const quad = pictures.quads[0]!;
      model.setIndex(quad.index);
      model.setAttribute('position', quad.getAttribute('position'));
      model.setAttribute('normal', quad.getAttribute('normal'));
      model.setAttribute('aSphere', sphereAttribute);
      model.setAttribute('aBlock', blockAttribute);
      const { sphere, largest } = boundsOf(plantKinds.map((kind) => {
        const s = pictures.spheres[spec.pictureOf[kind]!]!;
        return { pack: packs.get(kind)!, radius: s.radius, centre: s.centre.length() };
      }));
      const meshSpec: KindMesh = {
        name: `${spec.name}-far-cells`, geometry: quad, material: pictures.material, depth: pictures.depth,
        castShadow: true, receiveShadow: true, cards: false, far: true, made: pictures.attach,
      };
      const mesh = batchMesh(meshSpec, model, poses, tints, count, sphere, YAW_POSE);
      own(mesh, { poses, tints, aSphere: sphereAttribute, aBlock: blockAttribute }, () => fill(make().packs));
      uncast.push(castBySize({ mesh, casts: true, radius: () => largest }));
      meshes.push(mesh);
    }
    // The rest, a batch a kind, drawn by the kind's own near meshes; a kind with a ladder (a street prop) by its meshes at each level, each
    // thing at the level its size calls for (`bandOf`). DO NOT draw a far block's bins and benches whole: 3,400 bins of 182 triangles and 3,600
    // benches of 164 a few pixels across were 1.2 M triangles of the district's view (`npm run diagnose`, 2026-10-24); DO NOT draw them as the
    // box round them either (837f1866): their pictures are the same model.
    const ladders: FarLadder[] = [];
    for (const [kind, pack] of packs) {
      if (pictureKinds[kind]) continue;
      const kindSpec = spec.kinds[kind]!;
      const fill = (from: ReadonlyMap<number, Pack>): Record<string, Float32Array> => {
        const p = from.get(kind)!;
        const tints = kindSpec.tinted ? (p.colours ? Float32Array.from(p.colours) : new Float32Array(p.count * 3).fill(1)) : null;
        return { poses: Float32Array.from(p.data.subarray(0, p.count * stride)), ...(tints ? { tints } : {}) };
      };
      const filled = fill(packs);
      const poses = new InstancedInterleavedBuffer(filled.poses!, stride);
      const tints = filled.tints ? new InstancedBufferAttribute(filled.tints, 3) : null;
      const levels = kindSpec.levels;
      // Its simplified models drawn only once made (a batch holds its model's attributes as they were, `cellInstances.ts` posedGeometry).
      const midMade = levels?.mid !== undefined && (levels.midReady?.() ?? true);
      const batch = (body: KindMesh, casts: boolean, shadowAlone = false, band: Banded | null = null): InstancedMesh => {
        if (!body.geometry.boundingSphere) body.geometry.computeBoundingSphere();
        const s = body.geometry.boundingSphere!;
        const { sphere, largest } = boundsOf([{ pack, radius: s.radius, centre: s.center.length() }]);
        // A rung's batch made casting as it casts between the passes (`castBySize`: its maker's `casts`), as its programs are compiled ahead
        // (`warm`); the others as their store's mesh (`streetFurnitureLayer.ts` warm).
        const drawn: KindMesh = band ? { ...body, castShadow: casts, material: band.material, depth: band.depth } : body;
        const mesh = batchMesh({ ...drawn, name: `${body.name}-far-cells` }, body.geometry, poses, tints, pack.count, sphere, YAW_POSE);
        const count = pack.count;
        // A shadow alone: none of it drawn in the colour pass (`castBySize` counts), every one in the cascades.
        uncast.push(castBySize({ mesh, casts, radius: () => largest, ...(shadowAlone ? { counts: { colour: () => 0, shadow: () => count } } : {}) }));
        meshes.push(mesh);
        return mesh;
      };
      const nears = kindSpec.meshes.filter((s) => !s.far && !s.mid && !s.cards);
      if (!levels || !laddered(kindSpec)) {
        const made = nears.map((body) => batch(body, body.castShadow));
        if (levels?.fadesAt !== undefined) for (const mesh of made) fading.push({ mesh, beyond: levels.fadesAt });
        if (made[0]) own(made[0], tints ? { poses, tints } : { poses }, () => fill(make().packs));
        continue;
      }
      const rungs: FarRung[] = [];
      for (const r of rungsOf(kindSpec, midMade)) {
        const made = r.bodies.map((body) => batch(r.drawn(body), r.casts(body), r.shadowAlone, r.band));
        if (!r.shadowAlone) rungs.push({ meshes: made, band: r.band.band, floor: r.floor, floorUnpictured: r.floorUnpictured });
      }
      const least = levels.least ?? 0, castsNear = levels.shadowNear === true;
      const farBodies = kindSpec.meshes.filter((s) => s.far);
      const pictureRung: FarRung | null = farBodies.length
        ? { meshes: farBodies.map((body) => batch(body, body.castShadow && !castsNear)), band: new Vector4(least, levels.far, 0, 0), floor: least, floorUnpictured: least }
        : null;
      const feet = new Box3();
      let most = 0, fewest = Infinity;
      for (let i = 0; i < pack.count; i++) {
        feet.expandByPoint(corner.set(pack.data[i * stride]!, pack.data[i * stride + 1]!, pack.data[i * stride + 2]!));
        most = Math.max(most, pack.scales[i]!);
        fewest = Math.min(fewest, pack.scales[i]!);
      }
      for (const r of [...rungs, ...(pictureRung ? [pictureRung] : [])]) for (const mesh of r.meshes) mesh.visible = false;
      ladders.push({ levels, feet, largest: 2 * levels.reach * most, smallest: 2 * levels.reach * fewest, rungs, pictures: pictureRung });
      own(rungs[0]!.meshes[0] ?? pictureRung!.meshes[0]!, tints ? { poses, tints } : { poses }, () => fill(make().packs));
    }
    const holder = new Group(), pictured = new Group();
    holder.name = `${spec.name}-far-block`;
    pictured.name = `${spec.name}-far-pictures`;
    holder.add(pictured);
    for (const mesh of meshes) (mesh.material === spec.pictures?.material ? pictured : holder).add(mesh);
    return { block: { group: holder, pictured, ladders, fading, meshes, uncast, growing, waiting, gpu: arrays }, arrays };
  };

  const far = [FarClass.wide, FarClass.small].map((cls) => {
    const cellsOf: ViewCells<FarBlock> = new ViewCells<FarBlock>({
      name: `${spec.name} far ${cls === FarClass.wide ? 'wide' : 'small'}`, version: spec.version, side: FAR_SIDE, reach: 0,
      cpuBudget: spec.farBytes ?? 24 * 1048576, gpuBudget: spec.gpuBytes ?? 192 * 1048576, kinds: spec.changes, pad: spec.pad,
      derive(key, rect) {
        let block: FarBlock | null = null;
        const made = batches(cls, key, rect, placementFor(cellsOf, key, rect), () => {
          // Every array of the block on the GPU: what it holds is the GPU's now.
          if (!block || --block.waiting > 0) return;
          cellsOf.account(key, FAR_OVERHEAD * block.meshes.length + FAR_OVERHEAD, block.gpu);
        });
        block = made.block;
        farGroup.add(block.group);
        heldFar[cls]!.set(key, block);
        for (const mesh of block.meshes) farMeshes.add(mesh);
        if (block.meshes.length) meshList = null;
        if (block.growing) growingFar[cls]!.add(key);
        return { value: block, cpuBytes: made.arrays + FAR_OVERHEAD * (block.meshes.length + 1) };
      },
      release(key, block) {
        growingFar[cls]!.delete(key);
        heldFar[cls]!.delete(key);
        farGroup.remove(block.group);
        for (const off of block.uncast) off();
        for (const mesh of block.meshes) {
          farMeshes.delete(mesh);
          releaseBatchMesh(mesh);
        }
        if (block.meshes.length) meshList = null;
      },
    });
    return cellsOf;
  });

  /** The far blocks of a class the view wants: in its reach and in the frustum (or the margin round it), nearest first. */
  const blocksBox = new Box3();
  const wantedBlocks = (v: PropView, reach: number): CellKey[] => {
    if (reach < 0) return [];
    const out: { key: CellKey; d: number }[] = [];
    const margin = spec.margin;
    const bx0 = Math.floor((v.x - reach) / FAR_SIDE), bx1 = Math.floor((v.x + reach) / FAR_SIDE);
    const by0 = Math.floor((v.y - reach) / FAR_SIDE), by1 = Math.floor((v.y + reach) / FAR_SIDE);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const x0 = bx * FAR_SIDE, y0 = by * FAR_SIDE, x1 = x0 + FAR_SIDE, y1 = y0 + FAR_SIDE;
        const d = Math.hypot(Math.max(x0 - v.x, 0, v.x - x1), Math.max(y0 - v.y, 0, v.y - y1));
        if (d > reach) continue;
        // Three's axes: x east, y up, z south.
        blocksBox.min.set(x0 - margin, v.ground + BLOCK_LOW, -(y1 + margin));
        blocksBox.max.set(x1 + margin, v.ground + BLOCK_HIGH, -(y0 - margin));
        if (!v.frustum.intersectsBox(blocksBox)) continue;
        out.push({ key: keyOfCell(bx, by), d });
      }
    }
    return out.sort((a, b) => a.d - b.d || a.key - b.key).map((w) => w.key);
  };

  /** Each class's last choice of blocks and the view it was made for: what `wantedBlocks` reads (the view's matrix, its frustum's planes,
   *  its point, its ground) and the reach. A view that stands asks the same blocks: DO NOT walk them again every frame - at the city's whole
   *  view a class's reach (the camera's far plane, ~18 km) spans ~2,300 blocks of 1 km, each measured and tested against the frustum, four
   *  times a frame with the gardens and the furniture (the Lab's Diagnosis, 2026-10-25: `wantedBlocks` a CPU cause at rest). */
  const SEEN = 16 + 24 + 4;
  const asked = far.map(() => ({ seen: new Float64Array(SEEN).fill(NaN), keys: [] as CellKey[], set: new Set<CellKey>() }));
  const scratch = new Float64Array(SEEN);
  /** The blocks class `cls` wants for view `v`: the last choice when the view and the reach are those it was made for (`fresh` false). */
  const blocksFor = (cls: number, v: PropView, reach: number): { keys: readonly CellKey[]; set: ReadonlySet<CellKey>; fresh: boolean } => {
    const last = asked[cls]!;
    scratch.set(v.view.elements, 0);
    for (let i = 0; i < 6; i++) {
      const plane = v.frustum.planes[i]!;
      scratch[16 + i * 4] = plane.normal.x; scratch[17 + i * 4] = plane.normal.y; scratch[18 + i * 4] = plane.normal.z; scratch[19 + i * 4] = plane.constant;
    }
    scratch[40] = v.x; scratch[41] = v.y; scratch[42] = v.ground; scratch[43] = reach;
    let same = true;
    for (let i = 0; i < SEEN && same; i++) same = scratch[i] === last.seen[i];
    if (same) return { keys: last.keys, set: last.set, fresh: false };
    last.seen.set(scratch);
    last.keys = wantedBlocks(v, reach);
    last.set = new Set(last.keys);
    return { keys: last.keys, set: last.set, fresh: true };
  };

  const inSquare =(key: CellKey, s: PropSquare): boolean => s.k >= 0 && Math.max(Math.abs(columnOf(key) - s.cx), Math.abs(rowOf(key) - s.cy)) <= s.k;
  let busy = false;
  /** Whether the last `ringsIn` left rings of the square it was asked for unplaced. */
  let ringsShort = false;

  return {
    group,
    get meshes() {
      return meshList ??= [...cells.meshes, ...farMeshes];
    },
    get triangles() { return cells.triangles; },
    get cpuBytes() { return near.cpuBytes + far.reduce((n, f) => n + f.cpuBytes, 0) + cells.cpuBytes; },
    near,
    far,
    get largestPicture() { return largestPicture; },
    get busy() { return busy; },
    follow(journal) {
      followOff(journal);
      near.follow(journal);
      for (const f of far) f.follow(journal);
    },
    forgetAsked() { clearAsked(); },
    forgetGrowing() {
      forgetGrowingAsked();
      near.forget([...growingNear]);
      far.forEach((f, cls) => f.forget([...growingFar[cls]!]));
    },
    ringsIn(square, deadline) {
      ringsShort = false;
      if (square.k < 0) { near.want([]); return -1; }
      // The square's cells, ring by ring from its middle: wanted all, placed while the frame has time (one ring at least).
      const keys: CellKey[] = [];
      for (let r = 0; r <= square.k; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) keys.push(keyOfCell(square.cx + dx, square.cy + dy));
        }
      }
      near.want(keys);
      // Every cell of the square asked off the page at once (nearest first in the queue), whatever the frame's time: asking costs nothing here.
      for (const key of keys) if (!near.has(key)) ready(near, key);
      let ring = -1, at = 0;
      for (let r = 0; r <= square.k; r++) {
        const n = r === 0 ? 1 : 8 * r;
        let whole = true;
        for (let i = at; i < at + n; i++) {
          const key = keys[i]!;
          if (near.has(key)) continue;
          // Its placement not come from off the page yet: the ring not in, its other cells derived meanwhile.
          if (!ready(near, key)) { whole = false; continue; }
          if (r > 0 && performance.now() > deadline) { whole = false; break; }
          near.ensure(key);
        }
        at += n;
        if (!whole) break;
        ring = r;
      }
      near.trim(null);
      ringsShort = ring < square.k;
      return ring;
    },
    show(square, view, deadline) {
      // The near cells: those of the square in, the rest out.
      const removed: object[] = gone.splice(0);
      for (const [key, value] of shown) {
        if (inSquare(key, square)) continue;
        shown.delete(key);
        removed.push(value);
      }
      const added: { key: object; packs: ReadonlyMap<number, Pack> }[] = [];
      if (square.k >= 0) {
        for (let dx = -square.k; dx <= square.k; dx++) for (let dy = -square.k; dy <= square.k; dy++) {
          const key = keyOfCell(square.cx + dx, square.cy + dy);
          if (shown.has(key)) continue;
          const value = near.peek(key);
          if (!value) continue;
          shown.set(key, value);
          if (value.packs.size) added.push({ key: value, packs: value.packs });
        }
      }
      if (removed.length || added.length) {
        for (const mesh of cells.update({ removed, added })) { group.add(mesh); meshList = null; }
      }
      // The far blocks: the wide ones to the view's reach, the small things only where a pixel or more.
      const reaches = [view.reach, largestSmall > 0 ? reachFor(view, largestSmall, leastSmall * (1 - HYSTERESIS)) : -1];
      busy = ringsShort;
      far.forEach((f, cls) => {
        // The same blocks as last frame: the cache's wanted list is the one it was given then (nothing else gives it one).
        const blocks = blocksFor(cls, view, reaches[cls]!);
        if (blocks.fresh) f.want(blocks.keys);
        let first = true;
        for (const key of f.wantedKeys) {
          if (f.has(key)) continue;
          // Its placement asked off the page and not come: the next one derived meanwhile.
          if (!ready(f, key)) { busy = true; continue; }
          if (!first && performance.now() > deadline) { busy = true; break; }
          f.ensure(key);
          first = false;
        }
        f.trim(null);
        // A block held but not wanted (out of the reach, out of the frustum) draws nothing.
        const wanted = blocks.set;
        // Pictures not taken yet would be blank (the near cells draw their plants whole meanwhile).
        const pictured = !spec.pictures || spec.pictures.ready();
        for (const [key, block] of heldFar[cls]!) {
          block.group.visible = wanted.has(key);
          block.pictured.visible = pictured;
          if (block.group.visible) for (const ladder of block.ladders) showLadder(ladder, view.view, view.perUnitAtOne, square, PROP_CELL);
          // A batch its material fades out whole from here: none of it drawn (its sphere's nearest depth, never more than its distance, past it).
          if (block.group.visible) for (const f of block.fading) f.mesh.visible = !fadedOut(f.mesh, f.beyond, view.view);
        }
      });
      prune();
    },
    setMap(map) { cells.setMap(map); },
    warm() {
      const out: InstancedMesh[] = [];
      for (const kindSpec of spec.kinds) {
        if (!laddered(kindSpec)) continue;
        // Its rungs with its simplified models made or not (a block made before they were draws its model in their band).
        const seen = new Set<string>();
        for (const midMade of [true, false]) {
          if (midMade && kindSpec.levels!.mid === undefined) continue;
          for (const r of rungsOf(kindSpec, midMade)) {
            for (const body of r.bodies) {
              const drawn = r.drawn(body);
              if (seen.has(drawn.name)) continue;
              seen.add(drawn.name);
              out.push(warmMesh({ ...drawn, material: r.band.material, depth: r.band.depth, castShadow: r.casts(body) }, kindSpec.tinted, YAW_POSE));
            }
          }
        }
      }
      return out;
    },
    cull(frustum, view) {
      // The pictures thin by the view culled for (`plantImpostors.ts` setView): told here too, for the far batches, whatever the near cells hold.
      spec.pictures?.setView(view, screenHalf());
      for (const still of spec.stills ?? []) still.setView(view, screenHalf());
      // The far ladders' bands (`bandOf`): the same view.
      bands.setView(view, screenHalf());
      cells.cull(frustum, view);
    },
    dispose() {
      clearAsked();
      near.clear();
      for (const f of far) f.clear();
      cells.dispose();
      bands.dispose();
      group.clear();
    },
  };
}

/**
 * The layers brought to a view, one square for all (the far batches of every layer read one `NEAR_SQUARE`): each layer's rings
 * placed within the frame's time, the square drawn near the one all have in, then each layer's far blocks.
 */
export function lookProps(layers: readonly PropLayer[], view: PropView): PropSquare {
  const deadline = performance.now() + FRAME_MS;
  const target = nearSquareOf(view, layers.reduce((most, layer) => Math.max(most, layer.largestPicture), 0));
  let k = target.k;
  for (const layer of layers) k = Math.min(k, layer.ringsIn(target, deadline));
  const square = { cx: target.cx, cy: target.cy, k };
  for (const layer of layers) layer.show(square, view, deadline);
  NEAR_SQUARE.value.set(square.cx, square.cy, square.k);
  return square;
}
