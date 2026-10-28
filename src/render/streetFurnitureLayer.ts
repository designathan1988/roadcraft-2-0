import { type BufferGeometry, Color, Group, type Frustum, type InstancedMesh, type Matrix4, type MeshDepthMaterial } from 'three';

import type { Change, ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import { CellFiling, grow } from '@world/cells';
import { Derived, type DerivedSpec, JournalCursor } from '@world/derived';
import type { RoadElevation } from '@world/elevation';
import { ACCESS_REACH, GROW_MINUTES, MAX_ITEM_RADIUS, plantGrowth, type LandscapeItem } from '@world/landscape';
import type { Network } from '@world/network';
import { m } from '@world/units';
import { CLUMP_READ_REACH, grassClump, type Tuft } from './grass';
import type { KindSpec } from './cellInstances';
import { RunBuilder, kindOf, warmMeshes, type RunStore } from './instanceRuns';
import { BUSH_KINDS, TREE_SPECIES } from './propGeometry';
import { PICTURE_PX, PROP_PICTURES, propPictures, sceneryPictures, type PropPicture, type PropPictures, type SceneryPictures } from './plantImpostors';
import { createPropLayer, type PropLayer, type PropPlacement } from './propCells';
import { FURNITURE_MODELS, type FurniturePlace, type LampLens, furniturePlace, isFurniture, unpackPlaces } from './furniturePlace';
import type { FurnitureCellAsk, FurnitureCellReply } from './furnitureCell.worker';
import { canQueueJobs, submitJob } from '../jobs/jobPool';
import { TIER_SPAN } from './buildings/cellPool';
import { RecordTable, TableWriter, tableBytes } from '@world/buildings/recordTable';
import { type RoadDoc, type SerializedDoc, savedNode, savedSegment } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { roadsOfTiles, tilesMeeting } from '@world/networkWindow';
import { isLevelLand } from './networkFarInput';
import { type SharedGroundAt, type SharedGroundData, groundAround } from './sharedGround';
// Its street trees' species by roll (`furniturePlace.ts`), for the lab's catalogue.
export { streetSpecies } from './furniturePlace';
import { PROP_LEAST_PX, PROP_NEAR_PX, PROP_PICTURE_PX, propMeasure, propMidLevel, simplifierLoading, type PropMidLevel } from './propLevels';
import { BEAM_FADE, SHADOW_REACH, type SceneryKit } from './scenery';

/** DO NOT go back to that: one bench placed paid for every bench of the city. */

/** How far a placed item stands from what moves it: a road within reach of its footway and of the crossings near it. */
const ROAD_REACH = ACCESS_REACH + MAX_ITEM_RADIUS + m(1);
/** Its deck's height read at its point. */
const DECK_REACH = m(1);

/** What the layer is refreshed from: the diary it reads, and the roads and their heights it places on. */
export interface FurnitureSource {
  readonly changes: ChangeJournal;
  readonly net: Network;
  readonly elevation: RoadElevation;
  readonly groundAt: (x: number, y: number) => number;
}

/** The street props' ladder (`propLevels.ts`): each one's simplified model and its picture. DO NOT go back to drawing a far prop as the box
 *  round it in its mean colour: it is not the same model (the owner's rule, 837f1866). */
export interface PropLadder {
  readonly pictures: PropPictures;
  readonly mid: Readonly<Record<PropPicture, PropMidLevel>>;
  /** One prop's simplified model made, once the simplifier is loaded (a frame's share, `PropMidLevel.make`): whether every one is made. */
  step(): boolean;
  /** Its pictures and its simplified models let go. */
  release(): void;
}

/** The kit's props' ladder for one layer: their pictures (`propPictures`) and a simplified model a prop (`propLevels.ts`). */
export function propLadder(kit: SceneryKit): PropLadder {
  const geometry: Readonly<Record<PropPicture, BufferGeometry>> = { ...kit.furniture, treePit: kit.treePit };
  // The tree pit throws no shadow (`furnitureStores`).
  const casts = Object.fromEntries(PROP_PICTURES.map((p) => [p, p !== 'treePit'])) as Record<PropPicture, boolean>;
  // Each one measured by its largest extent (the owner's tool's size), its simplified model's error held at the largest it is drawn simplified.
  const measure = Object.fromEntries(PROP_PICTURES.map((p) => [p, propMeasure(geometry[p])])) as Record<PropPicture, number>;
  const mid = Object.fromEntries(PROP_PICTURES.map((p) => [p, propMidLevel(geometry[p], measure[p])])) as Record<PropPicture, PropMidLevel>;
  const pictures = propPictures({ geometry, casts, measure, material: kit.props, band: [PROP_LEAST_PX, PROP_PICTURE_PX] });
  const simplifier = simplifierLoading();
  return {
    pictures,
    mid,
    step() {
      const next = PROP_PICTURES.find((p) => !mid[p].made());
      if (next === undefined) return true;
      if (simplifier.loaded()) mid[next].make();
      return false;
    },
    release() {
      pictures.release();
      // A simplified model's own welded attributes; one not worth its draw shares its model's, which the kit lets go.
      for (const p of PROP_PICTURES) if (mid[p].ready()) mid[p].geometry.dispose();
    },
  };
}

/** The meshes of the furniture and the street plants: the stores, and where each plant's body and cards are. */
export function furnitureStores(kit: SceneryKit, pictures: SceneryPictures, ladder: PropLadder): RunStore[] {
  const props = ladder.pictures.set;
  /** A prop; `small`: the owner's tool's ladder by its largest extent on the screen (`propLevels.ts`): whole from `PROP_NEAR_PX` across, as its
   *  simplified model from `PROP_PICTURE_PX` (where it sheds triangles; else whole), as its picture from `PROP_LEAST_PX` (`propPictures`), not
   *  drawn under it - a lamp's glow and its pools are seen from afar, never small.
   *  DO NOT draw a bin of 250 triangles a few pixels across: at the district's view the small props drew ~3.5 M triangles, scene and shadows
   *  (`npm run diagnose`, 2026-10-22). */
  /** `castsNear`: drawn simplified or as its picture, it casts by its model (a lamp, whose nine-metre shadow is seen past its picture's size). */
  const prop = (name: string, geometry: RunStore['geometry'], material: RunStore['material'], castShadow = true, receiveShadow = true, renderOrder?: number,
    small?: PropPicture, castsNear = false): RunStore =>
    ({ name, geometry, material, castShadow, receiveShadow, ...(renderOrder !== undefined ? { renderOrder } : {}), tinted: false, cards: false,
      ...(small ? {
        // Its simplified model and its picture for the colour alone: it casts by its model (`KindLevels.shadowNear`).
        levels: { reach: props.reach[ladder.pictures.at(small)]!, mid: PROP_NEAR_PX, far: PROP_PICTURE_PX, least: PROP_LEAST_PX, small: true,
          midReady: ladder.mid[small].ready, ready: () => props.ready(),
          ...(castsNear ? { shadowNear: true } : {}) },
        with: [
          { name: `${name}-mid`, geometry: ladder.mid[small].geometry, material, castShadow, receiveShadow, cards: false, far: false, mid: true },
          { name: `${name}-far`, geometry: props.quads[ladder.pictures.at(small)]!, material: props.material, depth: props.depth, castShadow, receiveShadow,
            cards: false, far: true, made: props.attach },
        ],
      } : {}) });
  const f = kit.furniture;
  const stores: RunStore[] = [
    // A column whose shadow reaches nine metres: cast by its model at every level.
    prop('street-lights', f.lamp, kit.props, true, true, undefined, 'lamp', true),
    // The lens is lit from inside; it neither casts nor takes a shadow.
    prop('street-light-lamps', kit.lampLens, kit.posedGlow, false),
    prop('street-light-pools', kit.pool, kit.posedPoolGlow, false, false, 3),
    // Its cone faded out whole past `BEAM_FADE` from the eye (`scenery.ts` beamMaterial): not drawn there (`KindLevels.fadesAt`).
    { ...prop('street-light-beams', kit.beam, kit.posedBeamGlow, false, false, 4), levels: { reach: kit.beam.boundingSphere!.radius, fadesAt: BEAM_FADE[1] } },
    prop('street-bins', f.bin, kit.props, true, true, undefined, 'bin'),
    prop('benches', f.bench, kit.props, true, true, undefined, 'bench'),
    prop('hydrants', f.hydrant, kit.props, true, true, undefined, 'hydrant'),
    prop('post-boxes', f.postbox, kit.props, true, true, undefined, 'postbox'),
    prop('phones', f.phone, kit.props, true, true, undefined, 'phone'),
    prop('drains', f.drain, kit.props, true, true, undefined, 'drain'),
    prop('tree-pits', kit.treePit, kit.props, false, true, undefined, 'treePit'),
  ];
  const far = pictures.set;
  /** A street plant: its body and its leaf cards near, its picture far (`plantImpostors.ts`), chosen by its size on the screen. */
  const plant = (name: string, body: RunStore['geometry'], material: RunStore['material'], depth: MeshDepthMaterial,
    cards: RunStore['geometry'] | undefined, cardMaterial: RunStore['material'], cardDepth: MeshDepthMaterial, picture: number): number =>
    stores.push({
      name, geometry: body, material, depth, castShadow: true, receiveShadow: true, tinted: true, cards: false,
      levels: { reach: far.reach[picture]!, far: PICTURE_PX, view: far.setView, ready: () => far.ready() },
      with: [
        // The crown's heart throws the plant's shadow; alpha-cut cards in the shadow pass cost 70 ms a frame.
        ...(cards ? [{ name: `${name}-cards`, geometry: cards, material: cardMaterial, depth: cardDepth, castShadow: false, receiveShadow: true, cards: true, far: false }] : []),
        { name: `${name}-far`, geometry: far.quads[picture]!, material: far.material, depth: far.depth, castShadow: true, receiveShadow: true, cards: false, far: true, made: far.attach },
      ],
    }) - 1;
  for (const s of TREE_SPECIES) {
    plant(`street-trees-${s}`, kit.trees[s], kit.foliage, kit.foliageDepth, kit.cards[s], kit.treeCards, kit.treeCardsDepth, pictures.treeAt(s));
  }
  for (const k of BUSH_KINDS) {
    plant(`street-bushes-${k}`, kit.bushes[k], kit.shrubs, kit.shrubsDepth, kit.cards[k], kit.shrubCards, kit.shrubCardsDepth, pictures.bushAt(k));
  }
  return stores;
}

const sameColour = (a: Color | null, b: Color | null): boolean =>
  a === b || (a !== null && b !== null && a.r === b.r && a.g === b.g && a.b === b.b);
function samePlace(a: FurniturePlace, b: FurniturePlace): boolean {
  if (a.planted !== b.planted || a.x !== b.x || a.y !== b.y || a.placed.length !== b.placed.length) return false;
  for (let i = 0; i < a.placed.length; i++) {
    const p = a.placed[i]!, q = b.placed[i]!;
    if (p.store !== q.store || p.x !== q.x || p.y !== q.y || p.z !== q.z || p.yaw !== q.yaw || p.sx !== q.sx || p.sy !== q.sy
      || p.sz !== q.sz || p.h !== q.h || !sameColour(p.tint, q.tint)) return false;
  }
  return true;
}

/** Placed items of some kinds as a product of the diary, key by key (the item's id) */
class PlacedProduct<V extends { readonly x: number; readonly y: number }> implements DerivedSpec<FurnitureSource, number, V> {
  readonly byId = false;
  readonly kinds: readonly ChangeKind[];
  /** The items holding a value, by place: the ones a change reaches, gone from the document or not. */
  private readonly filing = new CellFiling<number, V>();

  constructor(
    readonly name: string,
    private readonly pads: Readonly<Partial<Record<ChangeKind, number>>>,
    private readonly wanted: (item: LandscapeItem) => boolean,
    private readonly make: (item: LandscapeItem, source: FurnitureSource) => V | undefined,
    readonly equals: (a: V, b: V) => boolean,
  ) {
    this.kinds = Object.keys(pads) as ChangeKind[];
  }

  /** @rebuild The document's items of the product's kinds: read only when everything changed (a load, the diary forgotten). */
  allKeys(source: FurnitureSource): Iterable<number> {
    const out: number[] = [];
    for (const item of source.net.doc.landscape.values()) if (this.wanted(item)) out.push(item.id);
    for (const id of this.filing.ids()) out.push(id);
    return out;
  }

  dirty(change: Change, out: Set<number>, source: FurnitureSource): void {
    if (change.rects === null) {
      for (const id of this.allKeys(source)) out.add(id);
      return;
    }
    // DO NOT look round each of an entry's rectangles
    if (change.kind === 'landscape' && change.ids) {
      for (const id of change.ids) {
        const item = source.net.doc.landscape.get(id);
        if (!item || this.wanted(item)) out.add(id);
      }
      return;
    }
    const pad = this.pads[change.kind] ?? 0;
    // All the entry's rectangles in one look each (`landscapeInAny`, `idsMeetingAny`)
    const areas = change.rects.map((rect) => grow(rect, pad));
    for (const item of source.net.doc.landscapeInAny(areas)) if (this.wanted(item)) out.add(item.id);
    for (const id of this.filing.idsMeetingAny(areas)) out.add(id);
  }

  compute(key: number, source: FurnitureSource): V | undefined {
    const item = source.net.doc.landscape.get(key);
    return item && this.wanted(item) ? this.make(item, source) : undefined;
  }

  changed(key: number, _before: V | undefined, after: V | undefined): void {
    if (after === undefined) this.filing.remove(key);
    else this.filing.file(key, after, [after.x, after.y, after.x, after.y]);
  }
}

/** The furniture's product: where each placed item stands (a product of the diary), proved against one made from nothing. */
export function furnitureProduct(kit: SceneryKit): Derived<FurnitureSource, number, FurniturePlace> {
  return new Derived(new PlacedProduct<FurniturePlace>('street furniture', {
    landscape: 0, roads: ROAD_REACH, elevation: DECK_REACH,
  }, (item) => item.kind !== 'meadow' && item.kind !== 'sign' && item.kind !== 'streetname',
  (item, source) => furniturePlace(source.net, source.elevation, item, kit.lens), samePlace));
}

const MEADOW_STORES = (kit: SceneryKit): RunStore[] => [
  { name: 'grass-tufts', geometry: kit.tuft, material: kit.grass, castShadow: false, receiveShadow: true, tinted: true, cards: false },
  { name: 'wildflowers', geometry: kit.flower, material: kit.flowers, castShadow: false, receiveShadow: true, tinted: true, cards: false },
];

/** The long grass's things standing about a rectangle: each clump placed within reach of it (`grassClump`), the layer keeping the tufts in the cell (`propCells.ts` within). */
function grassAbout(source: FurnitureSource, stores: readonly RunStore[], rect: ChangeRect): PropPlacement {
  const builder = new RunBuilder(stores);
  for (const item of source.net.doc.landscapeIn(grow(rect, CLUMP_READ_REACH))) {
    if (item.kind !== 'meadow') continue;
    meadowInto(builder, source.elevation, source.groundAt, item);
  }
  return { packs: builder.build(), growing: false };
}

/** The long grass's kinds as the cells draw them (`propCells.ts`): a tuft measured by its model's sphere, not drawn under `PROP_LEAST_PX` across
 *  (the owner's tool's ladder, `propLevels.ts`: nothing under 1.5 px), so the far blocks hold the tufts a pixel shows and not the map's. */
const grassKinds = (stores: readonly RunStore[]): KindSpec[] => stores.map((store) => ({
  ...kindOf(store), levels: { reach: store.geometry.boundingSphere?.radius ?? m(0.5), least: PROP_LEAST_PX },
}));

/** A clump's tufts and flowers put in a run of the long grass's stores (`MEADOW_STORES`). */
function meadowInto(builder: RunBuilder, elevation: RoadElevation, groundAt: (x: number, y: number) => number, item: LandscapeItem): void {
  const clump = grassClump(elevation, groundAt, item);
  const add = (store: number, tuft: Tuft): void => {
    builder.turned(store, tuft.x, tuft.z, -tuft.y, tuft.yaw, tuft.height * tuft.width, tuft.height, tuft.height * tuft.width,
      tuft.height * Math.max(1, tuft.width), tuft.tint);
  };
  for (const tuft of clump.tufts) add(0, tuft);
  for (const tuft of clump.flowers) add(1, tuft);
}

/** A placed item's instances at the city's time (the hour's start), put in a run of the furniture's stores: a plant sized by its growth then. */
function placeInto(builder: RunBuilder, place: FurniturePlace, now: number): void {
  const growth = plantGrowth(place.planted, now);
  for (const p of place.placed) {
    let sx = p.sx, sy = p.sy, sz = p.sz;
    if (p.h > 0) {
      const height = p.h * growth;
      sx = height * p.sx; sy = height * p.sy; sz = height * p.sz;
    }
    builder.turned(p.store, p.x, p.z, -p.y, p.yaw, sx, sy, sz, Math.max(sx, sy, sz), p.tint ?? undefined);
  }
}

/** The street furniture and the long grass held round the view (`propCells.ts`), never for the map. */
export interface StreetFurnitureLayer {
  /** The furniture and the street plants: their visibility is set every frame by the zoom. */
  readonly group: Group;
  readonly meshes: readonly InstancedMesh[];
  /** The furniture's cells, brought to the view with the gardens' (`lookProps`). */
  readonly layer: PropLayer;
  /** The long grass's cells, brought to the view at every zoom (`lookProps`): its tufts drawn wherever a pixel shows them, as they were. */
  readonly grassLayer: PropLayer;
  /** The long grass's meshes (`grassLayer.group`). */
  readonly grass: Group;
  readonly triangles: number;
  /** Brings the furniture and the long grass up to the diary (and the hour): the furniture's cells an entry reached dropped, placed again as the view asks; the work done (the engine's ledger, `core/engine.ts`). */
  sync(net: Network, elevation: RoadElevation, groundAt: (x: number, y: number) => number, minutes: number): number;
  setMap(map: boolean): void;
  /** A mesh of each of its stores, as it draws them */
  warm(): InstancedMesh[];
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** Whether a plant planted then is still growing at `minutes` (unknown while the clock is). */
const stillGrowing = (planted: number | undefined, minutes: number): boolean =>
  planted !== undefined && !(Number.isFinite(minutes) && minutes - planted >= GROW_MINUTES);

/** How far from its item a placed thing may stand: a lamp's pool of light out over the widest road. */
const FURNITURE_SPREAD = m(40);


/** The furniture's things standing about a rectangle at the city's time `now` (the hour's start): each item near it placed (`furniturePlace`), a plant sized by its growth then. */
export function furnitureAbout(source: FurnitureSource, stores: readonly RunStore[], lens: LampLens, now: number, rect: ChangeRect): PropPlacement {
  const places: FurniturePlace[] = [];
  for (const item of source.net.doc.landscapeIn(grow(rect, FURNITURE_SPREAD))) {
    if (!isFurniture(item)) continue;
    const place = furniturePlace(source.net, source.elevation, item, lens);
    if (place) places.push(place);
  }
  return placementOf(places, stores, now);
}

/** Places put in runs of the furniture's stores at the city's time `now` (the hour's start): what the layer draws of them. */
export function placementOf(places: readonly FurniturePlace[], stores: readonly RunStore[], now: number): PropPlacement {
  const builder = new RunBuilder(stores);
  let growing = false;
  for (const place of places) {
    placeInto(builder, place, now);
    if (stillGrowing(place.planted, now)) growing = true;
  }
  return { packs: builder.build(), growing };
}

/** The queue matches each answer to its job (`submitJob`'s own number): an ask's id is not read. */
const UNNUMBERED = 0;
/** The furniture's band in the queue (`cellPool.ts` cellPriority): after the masses (2-2.75), the buildings' cover and the gardens (2.9) and the
 *  summaries (3), nearest the view first. DO NOT ask it with the cover: the plants of the opening wait for the cover, and a 10 km city's
 *  furniture cells and blocks held the page's one job thread before it (the opening 47 -> 104 s, 2026-10-27). */
const FURNITURE_BAND = 3.5;

/**
 * The roads' records as a job reads them (`savedNode`, `savedSegment`), each made once while the roads stand (the diary's roads, read through
 * a cursor): the cells and blocks next to each other ask the same tiles' roads. DO NOT make them again an ask: a far block's tiles hold thousands.
 */
class RoadRecords {
  private readonly cursor = new JournalCursor(['roads']);
  private doc: RoadDoc | null = null;
  private readonly nodes = new Map<NodeId, SerializedDoc['nodes'][number]>();
  private readonly segments = new Map<SegmentId, SerializedDoc['segments'][number]>();
  /** Each tile's roads and those at their ends (`roadsOfTiles`). */
  private readonly tiles = new Map<number, readonly SegmentId[]>();

  /** The roads of the tiles a rectangle meets and those at their ends, in id order, their records and their nodes'. */
  of(doc: RoadDoc, rect: ChangeRect): { scope: SegmentId[]; nodes: SerializedDoc['nodes']; segments: SerializedDoc['segments'] } {
    // Another document, or a road changed since the last ask: every record made again as asked.
    const changed = this.cursor.read(doc.changes);
    if (doc !== this.doc || changed === null || changed.length) {
      this.doc = doc;
      this.nodes.clear();
      this.segments.clear();
      this.tiles.clear();
    }
    const scope = new Set<SegmentId>();
    for (const tile of tilesMeeting(rect)) {
      let roads = this.tiles.get(tile);
      if (!roads) this.tiles.set(tile, roads = [...roadsOfTiles(doc, [tile])]);
      for (const id of roads) scope.add(id);
    }
    const ids = [...scope].sort((a, b) => a - b);
    const nodeIds = new Set<NodeId>();
    const segments = ids.map((id) => {
      let saved = this.segments.get(id);
      if (!saved) {
        const seg = doc.segment(id)!;
        this.segments.set(id, saved = savedSegment(seg));
      }
      nodeIds.add(saved.a as NodeId);
      nodeIds.add(saved.b as NodeId);
      return saved;
    });
    const nodes = [...nodeIds].sort((a, b) => a - b).map((id) => {
      let saved = this.nodes.get(id);
      if (!saved) this.nodes.set(id, saved = savedNode(doc.node(id)!));
      return saved;
    });
    return { scope: ids, nodes, segments };
  }
}

/**
 * What a job places the furniture about `rect` from (`furnitureCell.worker.ts`), read now: the items there (rows of the map's landscaping table
 * where it holds them, the others encoded), the roads of the tiles round them and every road at their ends with their nodes (as the page's
 * network holds a tile's, `networkWindow.ts`), their heights as the page's solve has them (`fieldFor`), the ground it read; null where they
 * cannot be handed over (no field to pack, a table not in shared memory).
 */
/** `shared`: the job's thread shares the page's memory (its items read by their rows where the map's table holds them); else every item is copied
 *  into a table of its own and the ground cut to the plates round the rectangle (`groundAround`: a job process, whose memory is its own). */
export function furnitureAskOf(source: FurnitureSource, rect: ChangeRect, lens: LampLens, level: boolean, ground: SharedGroundData | null,
  records: RoadRecords = new RoadRecords(), shared = true): { data: FurnitureCellAsk; transfer: ArrayBuffer[] } | null {
  const doc = source.net.doc;
  const reach = grow(rect, FURNITURE_SPREAD);
  const refs: { buffer: ArrayBufferLike; row: number }[] = [];
  const written: LandscapeItem[] = [];
  const copied = new TableWriter<LandscapeItem>(false);
  /** The map's tables rows are copied from, each read once. */
  const sources = new Map<ArrayBufferLike, RecordTable>();
  let copies = 0;
  for (const id of doc.landscapeIdsIn(reach)) {
    const ref = doc.recordRef('landscape', id);
    if (ref && shared && typeof SharedArrayBuffer !== 'undefined' && ref.buffer instanceof SharedArrayBuffer) { refs.push({ buffer: ref.buffer, row: ref.row }); continue; }
    // A job process: the row copied as it is (no record decoded); one written on the page encoded.
    if (ref && !shared) {
      let from = sources.get(ref.buffer);
      if (!from) sources.set(ref.buffer, from = new RecordTable(ref.buffer));
      copied.copyRows(from, [ref.row]);
      copies++;
      continue;
    }
    const item = doc.landscape.get(id);
    if (item) written.push(item);
  }
  if (written.length) { copied.add(written); copies += written.length; }
  const roads = grow(reach, ROAD_REACH);
  const { scope, nodes, segments } = records.of(doc, roads);
  const field = source.elevation.fieldFor?.([roads], scope);
  if (!field) return null;
  const table = copies ? tableBytes(copied.finish().buffer) : null;
  return {
    data: { id: UNNUMBERED, rect, refs, table, lens, level, ground: ground && !shared ? groundAround(ground, roads) : ground, markingStyle: doc.markingStyle, scope, field: field.data, nodes, segments },
    transfer: [...field.transfer, ...(table ? [table] : [])],
  };
}

/** `arrived`: a cell's furniture placed off the page came (a frame asked to draw it). */
export function createStreetFurniture(kit: SceneryKit, arrived: () => void = () => {}): StreetFurnitureLayer {
  const pictures = sceneryPictures(kit);
  const ladder = propLadder(kit);
  const stores = furnitureStores(kit, pictures, ladder);
  /** Each store's picture: the street plants' (`treeStore`, `bushStore`), none for the props. */
  const pictureOf = stores.map((_, i): number | null => {
    const plant = i - FURNITURE_MODELS.length;
    if (plant < 0) return null;
    return plant < TREE_SPECIES.length ? pictures.treeAt(TREE_SPECIES[plant]!) : pictures.bushAt(BUSH_KINDS[plant - TREE_SPECIES.length]!);
  });
  let source: FurnitureSource | null = null;
  let hour = Number.NaN;
  /** The roads' records the furniture's jobs are handed, made once while the roads stand. */
  const roadRecords = new RoadRecords();
  /**
   * THE FURNITURE ABOUT A RECTANGLE ASKED OF THE PAGE'S JOB THREADS (`furnitureCell.worker.ts`), each answer put in runs here at the city's hour as
   * it comes. The job solves the roads round the rectangle itself: an item stands on its road wherever the view is, not only on the roads the
   * page's network holds round the view (`networkWindow.ts`). DO NOT place them on the page: a far block of 1 km placed its thousands of items
   * there in one frame, each one's road looked up in the network. Null without a job queue.
   */
  const furnitureAsk = canQueueJobs() ? (rect: ChangeRect): Promise<PropPlacement> | null => {
    if (!source) return null;
    const level = isLevelLand(source.net.doc);
    const share = (source.groundAt as SharedGroundAt).share;
    if (!level && !share?.current) return null;
    return new Promise<PropPlacement>((done, fail) => {
      submitJob({
        // Fit for a job process (`crosses`): every road it reads handed with it, its items copied there and its ground cut to the rectangle's plates.
        service: 'furnitureCells', key: null, priority: FURNITURE_BAND * TIER_SPAN, at: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2], crosses: true,
        // Its items, roads and heights read when a thread takes it: as they stand then (an answer asked before a change is let go, `propAsks.ts`).
        write: (to) => {
          const now = source;
          const ask = now ? furnitureAskOf(now, rect, kit.lens, level, level ? null : share?.current ?? null, roadRecords, to.sharesMemory) : null;
          if (!ask) throw new Error('[furniture] the roads round a rectangle could not be handed to a job');
          return ask;
        },
        done: (answer) => {
          const reply = answer as FurnitureCellReply;
          if ('error' in reply) { fail(new Error(reply.error)); return; }
          done(placementOf(unpackPlaces(reply.places), stores, hour * 60));
        },
        failed: (message) => fail(new Error(message)),
      });
    });
  } : null;
  const layer = createPropLayer({
    name: 'street-furniture', version: 1, kinds: stores.map(kindOf), margin: SHADOW_REACH,
    // What an item's place reads (`furnitureProduct`): the item, its road within reach, the road's deck under it.
    changes: ['landscape', 'roads', 'elevation'], pad: ROAD_REACH + FURNITURE_SPREAD,
    pictures: pictures.set, pictureOf, stills: [ladder.pictures.set],
    place: (rect) => (source ? furnitureAbout(source, stores, kit.lens, hour * 60, rect) : { packs: new Map(), growing: false }),
    ...(furnitureAsk ? { ask: furnitureAsk, arrived } : {}),
  });
  // The grass throws no shadow: only what the view itself takes. Its cells as the furniture's: placed as the view asks, let go past the budget.
  const meadowStores = MEADOW_STORES(kit);
  const grassLayer = createPropLayer({
    name: 'grass', version: 1, kinds: grassKinds(meadowStores), margin: 0,
    // What a clump reads (`grassClump`): its item, the ground and the roads' heights within its reach.
    changes: ['landscape', 'elevation', 'ground'], pad: CLUMP_READ_REACH + m(1),
    pictures: null, pictureOf: meadowStores.map(() => null),
    place: (rect) => (source ? grassAbout(source, meadowStores, rect) : { packs: new Map(), growing: false }),
  });
  const layers = [layer, grassLayer];

  return {
    group: layer.group,
    get meshes() { return layer.meshes; },
    layer,
    grassLayer,
    grass: grassLayer.group,
    get triangles() { return layer.triangles + grassLayer.triangles; },
    sync(net, elevation, groundAt, minutes) {
      // The props' simplified models, one a frame until made (`PropLadder.step`).
      ladder.step();
      const fresh: FurnitureSource = { changes: net.doc.changes, net, elevation, groundAt };
      const nowHour = Number.isFinite(minutes) ? Math.floor(minutes / 60) : Number.NaN;
      const invalidated = (): number => layers.reduce((n, l) => n + l.near.work.invalidated + l.far.reduce((k, f) => k + f.work.invalidated, 0), 0);
      const before = invalidated();
      // Another document: every cell placed again from it.
      if (source && source.net.doc !== net.doc) for (const l of layers) { l.near.clear(); for (const f of l.far) f.clear(); }
      source = fresh;
      for (const l of layers) l.follow(net.doc.changes);
      // A new hour: the cells with a plant still growing placed again (and only those), and the placements come with one not yet taken.
      // DO NOT let go every placement asked: a job's answer is put in runs at the hour it comes at (`placementOf`), and every cell asked again
      // each city hour (about 4 minutes) piled the jobs asked before, still queued, under the new ones (2026-10-27).
      if (!Object.is(nowHour, hour)) {
        hour = nowHour;
        layer.forgetGrowing();
      }
      return invalidated() - before;
    },
    setMap(map) {
      for (const l of layers) l.setMap(map);
    },
    warm() {
      return [...warmMeshes([...stores, ...meadowStores]), ...layer.warm(), ...grassLayer.warm()];
    },
    cull(frustum, view) {
      for (const l of layers) l.cull(frustum, view);
    },
    dispose() {
      for (const l of layers) l.dispose();
      pictures.release();
      ladder.release();
    },
  };
}
