import { Group, type Frustum, type InstancedMesh, type Matrix4, type BufferGeometry, type Material, type MeshDepthMaterial } from 'three';
import type { BuildingStore } from '@world/buildings/store';
import type { ChangeJournal } from '@world/changes';
import type { ChangeRect } from '@world/changes';
import { canQueueJobs, submitJob } from '../jobs/jobPool';
import { TIER_SPAN } from './buildings/cellPool';
import { rowCopier, rowRefs } from './buildings/rowRefs';
import { createCellInstances, type KindSpec, type Pack } from './cellInstances';
import type { GardenCellAsk, GardenCellReply } from './gardenCell.worker';
import { GARDEN_SLACK, type GardenPlant, gardenPack, gardenPacksOf } from './gardenPlace';
import { YAW_POSE } from './instanceRuns';
import { PICTURE_PX, sceneryPictures, type SceneryPictures } from './plantImpostors';
import { createPropLayer, type PropLayer, type PropPlacement } from './propCells';
import type { SharedGroundAt } from './sharedGround';
import { BUSH_KINDS, TREE_SPECIES } from './propGeometry';
import { SHADOW_REACH, type Scenery, type SceneryKit } from './scenery';

/** DO NOT go back to rebuilding the whole town's gardens at every building. */

// Where the plants stand (`gardenPlace.ts`): the same placing on the page and off it.
export { gardenPack, gardenPlants, type GardenPlant } from './gardenPlace';

/** The buildings' garden lists to place and to take away (`gardenLists.ts`): a list is placed once and taken away by the same object. */
export interface GardenChange {
  readonly added: readonly (readonly GardenPlant[])[];
  readonly removed: readonly (readonly GardenPlant[])[];
}

export interface Gardens extends Scenery {
  /** DO NOT hand it the town's lists to find what changed: that was a pass over the town per building grown. */
  update(change: GardenChange): { readonly removed: readonly InstancedMesh[]; readonly added: readonly InstancedMesh[] };
}

/** The gardens' kinds (`KIND_KEYS`): each plant's body and leaf cards near, its picture far, chosen by its size on the screen. */
function gardenKinds(kit: SceneryKit, pictures: SceneryPictures): KindSpec[] {
  const far = pictures.set;
  /** A plant kind: its body and its leaf cards near, its picture far (`plantImpostors.ts`), chosen by its size on the screen. */
  const kind = (name: string, body: BufferGeometry, material: Material, depth: MeshDepthMaterial, cards: BufferGeometry | undefined,
    cardMaterial: Material, cardDepth: MeshDepthMaterial, picture: number): KindSpec => ({
    tinted: true,
    levels: { reach: far.reach[picture]!, far: PICTURE_PX, view: far.setView, ready: () => far.ready() },
    meshes: [
      { name, geometry: body, material, depth, castShadow: true, receiveShadow: true, cards: false, far: false },
      // The foliage cards: they throw no shadow (the crown's heart does).
      ...(cards ? [{ name: `${name}-cards`, geometry: cards, material: cardMaterial, depth: cardDepth, castShadow: false, receiveShadow: true, cards: true, far: false }] : []),
      { name: `${name}-far`, geometry: far.quads[picture]!, material: far.material, depth: far.depth, castShadow: true, receiveShadow: true, cards: false, far: true, made: far.attach },
    ],
  });
  return [
    ...TREE_SPECIES.map((s) => kind(`garden-trees-${s}`, kit.trees[s], kit.foliage, kit.foliageDepth, kit.cards[s], kit.treeCards, kit.treeCardsDepth, pictures.treeAt(s))),
    ...BUSH_KINDS.map((k) => kind(`garden-bushes-${k}`, kit.bushes[k], kit.shrubs, kit.shrubsDepth, kit.cards[k], kit.shrubCards, kit.shrubCardsDepth, pictures.bushAt(k))),
  ];
}

/** Each garden kind's picture among the scenery's (`KIND_KEYS` order). */
const gardenPictures = (pictures: SceneryPictures): number[] => [...TREE_SPECIES.map((s) => pictures.treeAt(s)), ...BUSH_KINDS.map((k) => pictures.bushAt(k))];

/** Every building's garden in one layer, given its lists (`gardenLists.ts`): what a test of the whole map places to compare. */
export function createGardens(kit: SceneryKit): Gardens {
  const pictures = sceneryPictures(kit);
  const kinds = gardenKinds(kit, pictures);
  // A plant's pose (`YAW_POSE`) goes to the GPU as it is, for a plant drawn at a new position; the vertex shader makes its matrix.
  const cells = createCellInstances(kinds, YAW_POSE, SHADOW_REACH);
  return {
    get meshes() { return cells.meshes; },
    grass: new Group(),
    get triangles() { return cells.triangles; },
    update(change) {
      // Only the gardens that came and went are read; each new one placed once for this update and let go after (the kinds hold them).
      const added = cells.update({ removed: change.removed, added: change.added.map((list) => ({ key: list, packs: gardenPack(list) })) });
      return { removed: [], added };
    },
    // A plant's level follows its size on the screen (`cellInstances.ts`).
    setNear() {},
    /** DO NOT drop the cull here unconditionally */
    setMap(map) { cells.setMap(map); },
    cull(frustum, view) { cells.cull(frustum, view); },
    exclude() { /* a garden's plants are the building's own */ },
    dispose() {
      cells.dispose();
      pictures.release();
    },
  };
}

/** The plants of the gardens standing about a rectangle (at least every one in it): the buildings whose bounds (their elements' too) meet it, each one's garden placed. */
function gardenPacksAbout(buildings: BuildingStore, groundAt: (x: number, y: number) => number, rect: readonly [number, number, number, number]): ReadonlyMap<number, Pack> {
  // A building's bounds hold its garden's elements (`buildingBounds`): a plant stands within them.
  return gardenPacksOf(buildings.near(rect[0] - GARDEN_SLACK, rect[1] - GARDEN_SLACK, rect[2] + GARDEN_SLACK, rect[3] + GARDEN_SLACK), groundAt);
}

/** The queue matches each answer to its job (`submitJob`'s own number): an ask's id is not read. */
const UNNUMBERED = 0;
/** The gardens' band in the queue (`cellPool.ts` cellPriority): with the buildings' cover (`coverJobs.ts`), after the masses and their levels (2-2.75), before the summaries (3); nearest the view first within it. */
const GARDEN_BAND = 2.9;

/**
 * THE GARDENS ABOUT A RECTANGLE ASKED OF THE PAGE'S JOB THREADS (`gardenCell.worker.ts`): the buildings the store files about it (`nearIds`) read where
 * the map's table holds them, the ground off the shared plates. DO NOT place them on the page: a far block of 1 km decoded every building standing in
 * it in one frame, its gardens' share of the page's frames on a camera move (2026-10-27). Null where they cannot be asked off the page now: no job
 * queue, or the ground not shared (`SharedGroundAt.share`).
 */
function gardenJobAsk(buildings: BuildingStore, groundAt: (x: number, y: number) => number): ((rect: ChangeRect) => Promise<PropPlacement> | null) | null {
  if (!canQueueJobs()) return null;
  const share = (groundAt as SharedGroundAt).share;
  if (!share) return null;
  const copied = rowCopier();
  return (rect) => {
    if (!share.current) return null;
    return new Promise<PropPlacement>((done, fail) => {
      submitJob({
        // The page's own threads alone (no `crosses`): they read the map's table and the plates where they stand.
        service: 'gardenCells', key: null, priority: GARDEN_BAND * TIER_SPAN, at: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2],
        // Its rows and ground read when a thread takes it: as they stand then (an answer asked before a change is let go, `propCells.ts` follow).
        write: () => {
          const ground = share.current;
          if (!ground) throw new Error('[gardens] the ground is not shared any more');
          const ids = buildings.nearIds(rect[0] - GARDEN_SLACK, rect[1] - GARDEN_SLACK, rect[2] + GARDEN_SLACK, rect[3] + GARDEN_SLACK);
          const rows = rowRefs(ids, buildings) ?? { table: copied(ids, buildings) };
          return { data: { id: UNNUMBERED, rect, ground, ...rows } satisfies GardenCellAsk, transfer: rows.table ? [rows.table] : [] };
        },
        done: (answer) => {
          const reply = answer as GardenCellReply;
          if ('error' in reply) { fail(new Error(reply.error)); return; }
          const packs = new Map<number, Pack>();
          for (const { kind, data, colours, scales, count } of reply.packs) packs.set(kind, { data, colours, scales, count });
          done({ packs, growing: false });
        },
        failed: (message) => fail(new Error(message)),
      });
    });
  };
}

/** THE GARDENS HELD ROUND THE VIEW (`propCells.ts`): placed cell by cell from the buildings of the document, near whole, far as their pictures. */
export interface GardenCells {
  readonly layer: PropLayer;
  readonly meshes: readonly InstancedMesh[];
  readonly triangles: number;
  /** The buildings and the ground the gardens are placed from: the cells placed from another store all dropped. */
  source(buildings: BuildingStore, groundAt: (x: number, y: number) => number): void;
  /** The diary's changes of the buildings and the ground since the last look (when the ground is settled: a stroke over). */
  follow(journal: ChangeJournal): void;
  setMap(map: boolean): void;
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** `arrived`: a cell's gardens placed off the page came (a frame asked to draw them). */
export function createGardenCells(kit: SceneryKit, arrived: () => void = () => {}): GardenCells {
  const pictures = sceneryPictures(kit);
  let from: { buildings: BuildingStore; groundAt: (x: number, y: number) => number; ask: ((rect: ChangeRect) => Promise<PropPlacement> | null) | null } | null = null;
  const layer = createPropLayer({
    name: 'gardens', version: 1, kinds: gardenKinds(kit, pictures), margin: SHADOW_REACH,
    // What a garden's place reads: its building, and the ground under each plant (`gardenLists.ts` read the same).
    changes: ['buildings', 'elevation', 'ground'], pad: GARDEN_SLACK,
    pictures: pictures.set, pictureOf: gardenPictures(pictures),
    place: (rect) => ({ packs: from ? gardenPacksAbout(from.buildings, from.groundAt, rect) : new Map(), growing: false }),
    ask: (rect) => from?.ask?.(rect) ?? null,
    arrived,
  });
  return {
    layer,
    get meshes() { return layer.meshes; },
    get triangles() { return layer.triangles; },
    source(buildings, groundAt) {
      if (from?.buildings === buildings && from.groundAt === groundAt) return;
      const again = from !== null;
      from = { buildings, groundAt, ask: gardenJobAsk(buildings, groundAt) };
      if (again) { layer.near.clear(); for (const f of layer.far) f.clear(); layer.forgetAsked(); }
    },
    follow(journal) { layer.follow(journal); },
    setMap(map) { layer.setMap(map); },
    cull(frustum, view) { layer.cull(frustum, view); },
    dispose() {
      layer.dispose();
      pictures.release();
    },
  };
}
