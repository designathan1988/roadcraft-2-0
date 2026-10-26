import { BufferAttribute, BufferGeometry, Color, Group, MeshStandardMaterial } from 'three';
import type { Polyline } from '@core/polyline';
import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { ROAD_TYPES } from '@world/roadTypes';
import { ROAD_GROUND_CLEARANCE } from '@world/structures';
import { jobPort } from '../jobs/jobPool';
import { GpuBatchedMesh } from './buildings/gpuBatchedMesh';
import { pullTowardEye } from './depthConvention';
import { FAR_CARRIAGEWAY, FAR_FAN, FAR_SECTION, FAR_STRIP, buildFarRoadCells, type FarRoadCell, type FarRoadInput } from './networkFarRoadsBuild';
import { roadPaint } from './roadPaint';
import { lookOf } from './roadSurfacePass';
import { applyRoadFarPaint } from './mesh/roadEdges';
import type { Geom } from './roads/pieceGeom';
import { nodeOwner, ownerCell, segmentOwner } from './roads/pieceOwner';
import { deckOf, segmentFarShapes } from './roads/segmentPiece';
import { junctionFarShapes } from './roads/junctionPiece';
import { ASPHALT_REFERENCE, FOOTWAY_TINT, STREET_MEANS } from './roadTones';

/**
 * EVERY ROAD OF THE MAP AT ITS FAR LEVEL, THE ROADS' ROOT LEVEL, FROM THE FIRST FRAME OF A MAP'S OPENING AND FOR GOOD (`renderer.ts`
 * buildWorld, `mesh/roadResidency.ts`): the detailed surfaces are built only for the cells the view wants (nearest first, under the
 * tier's budget), never for the whole map; every other cell is drawn by this level. It is made from the network itself: each road's and
 * junction's real outline (`Network.ribbons`, `Network.junctions`: the carriageway, and the casing its footways and kerbs fill) at its
 * class's colour over the street textures' means (as the blocks' far level paints them), at the solved heights where the solve took the
 * road and on the ground elsewhere. Each road and junction is the same piece as in the detail, coarse: its carriageway and its casing as
 * strips and fans on its own edges and mouths (`networkFarRoadsBuild.ts`), filed by its owner block (`roads/pieceOwner.ts`),
 * triangulated in a job worker: O(the pieces' vertices), proportional to the document and nothing else. A cell is hidden while the
 * detailed blocks of its square stand (`hide`), shown again when the view lets them go (`show`). Made again when the roads drawn change
 * (`outdate`) and when the opening's solve completes (every road at its solved height).
 */

/** What the outlines' heights are read from: the opening's solve (`RoadElevation`), the roads it left for later, the ground. */
export interface FarRoadHeights {
  onSegment(segment: SegmentId, x: number, y: number): number;
  at(x: number, y: number): number;
  pendingRoads?(): SegmentId[];
}

/** The class's tint over the reference the asphalt texture is authored against (`roadSurfaces.ts` CLASS_TINTS), times the texture's mean. */
const ASPHALT_REFERENCE_COLOUR = new Color(ASPHALT_REFERENCE);
const ASPHALT_BY_CLASS: readonly (readonly [number, number, number])[] = ROAD_TYPES.map((type) => {
  const c = new Color(type.color);
  return [STREET_MEANS.asphalt[0] * (c.r / ASPHALT_REFERENCE_COLOUR.r), STREET_MEANS.asphalt[1] * (c.g / ASPHALT_REFERENCE_COLOUR.g), STREET_MEANS.asphalt[2] * (c.b / ASPHALT_REFERENCE_COLOUR.b)];
});
const CASING: readonly [number, number, number] = [STREET_MEANS.footway[0] * FOOTWAY_TINT.pavers[0], STREET_MEANS.footway[1] * FOOTWAY_TINT.pavers[1], STREET_MEANS.footway[2] * FOOTWAY_TINT.pavers[2]];

/**
 * One material a layer (0 the casing, 1 the carriageway): the colours the vertices', pulled over the ground it lies on (the casing under the
 * carriageway, as `roadStandIn.ts` draws them); the carriageway's with its lines and marks inked as the detail's (`mesh/roadEdges.ts`
 * applyRoadFarPaint, its vertices' `roadSection`): no zebra, stop line or centre line goes as a block gives way to this level. The lab's sheets
 * draw this level with these materials too (`lab/catalog/layout.ts`).
 */
export function farLayerMaterial(layer: 0 | 1): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0 });
  material.name = 'road-far-network';
  if (layer === FAR_CARRIAGEWAY) applyRoadFarPaint(material);
  pullTowardEye(material, 1, layer === FAR_CARRIAGEWAY ? 3 : 2);
  return material;
}

/** @rebuild The pieces of the network at the far level, their heights read on the page (`heights`, `groundAt` for the roads the solve left):
 *  what the worker triangulates. The pieces whose owner block lies inside `exclude` (cell-aligned: the blocks the opening builds in detail) are
 *  left out whole. Once a scoped opening, the whole map by design: no other level stands for the roads its view left. */
export function farRoadInput(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number,
  exclude: readonly [number, number, number, number] | null): { input: FarRoadInput; transfer: ArrayBuffer[] } {
  const owners: number[] = [], layers: number[] = [], colors: number[] = [], kinds: number[] = [], sizes: number[] = [], points: number[] = [];
  const across: number[] = [], slots: number[] = [];
  const tableSlot = roadPaint.resolverOf(net.doc);
  const pending = new Set(heights.pendingRoads?.() ?? []);
  /** Whether a block's square lies inside the area left to the detailed surfaces. */
  const excluded = (i: number, j: number): boolean => {
    if (!exclude) return false;
    const x0 = i * cell, y0 = j * cell, eps = 1e-6 * cell;
    return x0 >= exclude[0] - eps && x0 + cell <= exclude[2] + eps && y0 >= exclude[1] - eps && y0 + cell <= exclude[3] + eps;
  };
  const hit = { s: 0, distance: 0 };
  /** `line`: the road a strip of its carriageway lies on (its points' offsets across it read off it, as the detail's are, `roadField.ts`), none a
   *  plate's; `slot` the paint's slot its vertices carry (`FarRoadInput.slots`). */
  const add = (i: number, j: number, layer: number, colour: readonly [number, number, number], geom: Geom, height: (x: number, y: number) => number,
    slot: number, line?: Polyline): void => {
    const point = (x: number, y: number, s: number): void => {
      points.push(x, y, height(x, y), s);
      if (!line || layer !== FAR_CARRIAGEWAY) { across.push(0); return; }
      line.closestInto(x, y, hit);
      const f = line.sampleAt(hit.s);
      across.push((x - f.p.x) * f.n.x + (y - f.p.y) * f.n.y);
    };
    if (geom.kind === 'strip') {
      for (const c of [geom.a, geom.b]) for (let k = 0; k < c.s.length; k++) point(c.xy[k * 2]!, c.xy[k * 2 + 1]!, c.s[k]!);
      kinds.push(FAR_STRIP); sizes.push(geom.a.s.length, geom.b.s.length);
    } else if (geom.kind === 'fan') {
      point(geom.cx, geom.cy, 0);
      for (let k = 0; k < geom.ring.length; k += 2) point(geom.ring[k]!, geom.ring[k + 1]!, 0);
      kinds.push(FAR_FAN); sizes.push(geom.ring.length / 2, 0);
    } else return;
    owners.push(i, j);
    layers.push(layer);
    colors.push(colour[0], colour[1], colour[2]);
    slots.push(layer === FAR_CARRIAGEWAY ? slot : -1);
  };
  // A road the solve left lies where a solved one would on its ground: its clearance over it (`roadField.ts` onSegment), not in the ground's own plane.
  const onGround = (x: number, y: number): number => groundAt(x, y) + ROAD_GROUND_CLEARANCE;
  const roadAt = (x: number, y: number): number => { const h = heights.at(x, y); return Number.isFinite(h) ? h : onGround(x, y); };
  for (const [id, ribbon] of net.ribbons) {
    const at = segmentOwner(net, id);
    if (!at) continue;
    const [i, j] = ownerCell(at, cell);
    if (excluded(i, j)) continue;
    const height = pending.has(id) ? onGround : (x: number, y: number): number => heights.onSegment(id, x, y);
    const asphalt = ASPHALT_BY_CLASS[ribbon.typeIndex] ?? STREET_MEANS.asphalt;
    // Its lines along it in the paint's table, as its detail writes them (`roadSurfacePass.ts` lookOf).
    const look = lookOf(net, id);
    const slot = look?.paint === undefined ? -1 : tableSlot(look.paint);
    for (const shape of segmentFarShapes(net, ribbon, deckOf(net, [id]))) add(i, j, shape.layer, shape.layer === 1 ? asphalt : CASING, shape.geom, height, slot, ribbon.full);
  }
  for (const id of net.junctions.keys()) {
    const node = net.doc.node(id);
    const at = nodeOwner(net, id);
    if (!node || !at) continue;
    const [i, j] = ownerCell(at, cell);
    if (excluded(i, j)) continue;
    // A junction every road of which the solve left: on the ground, as they are.
    const height = node.incident.length > 0 && node.incident.every((s) => pending.has(s)) ? onGround : roadAt;
    const types = node.incident.map((s) => net.ribbons.get(s)?.typeIndex ?? -1).filter((t) => t >= 0);
    const asphalt = ASPHALT_BY_CLASS[types.length ? Math.max(...types) : 0] ?? STREET_MEANS.asphalt;
    // Its plate's marks: its node's slot as `-2 - slot` (`roadSurfaceReads.ts` asphaltPlate).
    const slot = -2 - tableSlot(roadPaint.nodeSlot(net.doc, id));
    for (const shape of junctionFarShapes(net, id, deckOf(net, node.incident))) add(i, j, shape.layer, shape.layer === 1 ? asphalt : CASING, shape.geom, height, slot);
  }
  const input: FarRoadInput = {
    cell, exclude, owners: new Int32Array(owners), layers: new Uint8Array(layers), colors: new Float32Array(colors),
    kinds: new Uint8Array(kinds), sizes: new Uint32Array(sizes), points: new Float64Array(points), across: new Float32Array(across), slots: new Float32Array(slots),
  };
  return {
    input,
    transfer: [input.owners, input.layers, input.colors, input.kinds, input.sizes, input.points, input.across, input.slots].map((a) => a.buffer as ArrayBuffer),
  };
}

/** A vertex's colour as stored (`Uint16Array` normalized: 0-65535 read as 0-1, three's `BufferAttribute.normalized`): a third of a float's bytes twice over, a step of 1.5e-5 against the darkest asphalt's 0.04. */
const COLOUR_STEPS = 65535;

/**
 * The whole network's far roads (see the file's comment), KEPT FOR GOOD AS THE ROADS' ROOT LEVEL (`mesh/roadResidency.ts`): a cell is
 * shown where no block draws it in detail, hidden while the detailed blocks of its square stand (`hide`), shown again when the view lets
 * them go (`show`). Its vertices are kept small (a position, a normal of three bytes, a colour of three shorts: 21 bytes where floats
 * took 36).
 * ONE BATCH A LAYER (`GpuBatchedMesh`: a cell an instance, shown or hidden by `setVisibleAt`, culled by the frustum one by one, drawn in
 * one multi-draw): DO NOT make a mesh a cell and layer - a city of 70,000 buildings drew 378 of them at its map view (189 cells), 27% of
 * the view's 1,395 draw calls (step-70k, 2026-10-22).
 */
export class NetworkFarRoads {
  readonly group = new Group();
  private readonly materials = [farLayerMaterial(0), farLayerMaterial(1)] as const;
  private worker: Worker | null = null;
  private asked = 0;
  /** A request not answered yet: the opening waits for it (`pending`). */
  private waiting = false;
  private triangleCount = 0;
  /** Each cell's triangles, by its key (`x,y` on the cells' grid): the cells of the map with roads, what the view chooses from (`roadResidency.ts`) and the probes count. */
  readonly cells = new Map<string, number>();
  /** Each cell's instances in the layers' batches, by its key. */
  private readonly meshesOf = new Map<string, { readonly batch: GpuBatchedMesh; readonly id: number }[]>();
  /** The cells hidden (`hide`): the detailed blocks of their squares stand. Kept across the levels made: a level landing hides them again. */
  private readonly hidden = new Set<string>();
  /** The level standing: the request it answers (`asked`), its cells' side, the area it left to the detailed surfaces. Null: none landed. */
  private made: { id: number; cell: number; exclude: readonly [number, number, number, number] | null } | null = null;
  /** The last request made before the roads drawn changed (`outdate`): a level answering it or one before stands for none of them. */
  private staleThrough = 0;

  constructor() {
    this.group.name = 'road-far-network';
  }

  /** Whether the level asked is still being made. */
  get pending(): boolean {
    return this.waiting;
  }

  get triangles(): number {
    return this.triangleCount;
  }

  /** The level made for the network as it stands (replacing any when it lands), the area `exclude` left to the detailed surfaces. */
  request(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number, exclude: readonly [number, number, number, number] | null): void {
    const id = ++this.asked;
    this.waiting = true;
    const asking = { id, cell, exclude };
    const { input, transfer } = farRoadInput(net, heights, groundAt, cell, exclude);
    const landed = (cells: readonly FarRoadCell[]): void => { if (id === this.asked) { this.made = asking; this.place(cells); this.waiting = false; } };
    const failed = (why: unknown): void => {
      console.warn('[roads] the far roads could not be made off the page; made here', why);
      this.worker = null;
      if (id === this.asked) landed(buildFarRoadCells(input));
    };
    // Where no worker can be made (Node: the specs that open a city), made here.
    if (typeof Worker === 'undefined') { landed(buildFarRoadCells(input)); return; }
    try {
      const worker = this.worker ??= jobPort('roadFar');
      worker.onmessage = (event: MessageEvent<{ id: number; cells?: FarRoadCell[]; error?: string }>) => {
        if (event.data.id !== id) return;
        if (event.data.cells) landed(event.data.cells); else failed(event.data.error);
      };
      worker.onerror = (event) => failed(event.message);
      worker.postMessage({ id, input }, transfer);
    } catch (error) {
      failed(error);
    }
  }

  private shown(key: string): boolean {
    return !this.hidden.has(key);
  }

  private place(cells: readonly FarRoadCell[]): void {
    this.clearMeshes();
    for (const layer of [0, 1] as const) {
      const mine = cells.filter((c) => (c.layer === 0 ? 0 : 1) === layer && c.indices.length > 0);
      if (!mine.length) continue;
      let vertices = 0, indices = 0;
      for (const c of mine) { vertices += c.positions.length / 3; indices += c.indices.length; }
      const batch = new GpuBatchedMesh(mine.length, vertices, indices, this.materials[layer]);
      batch.name = 'road-far-network';
      batch.renderOrder = layer === 0 ? 1 : 2;
      batch.receiveShadow = true;
      batch.matrixAutoUpdate = false;
      // Opaque, each layer pulled over the one under it (`pullTowardEye`): no order among its cells to keep.
      batch.sortObjects = false;
      for (const c of mine) {
        const g = new BufferGeometry();
        const count = c.positions.length / 3;
        const normals = new Int8Array(count * 3);
        for (let i = 1; i < normals.length; i += 3) normals[i] = 127;
        const colours = new Uint16Array(c.colors.length);
        for (let i = 0; i < colours.length; i++) colours[i] = Math.round(Math.min(1, Math.max(0, c.colors[i]!)) * COLOUR_STEPS);
        g.setAttribute('position', new BufferAttribute(c.positions, 3));
        g.setAttribute('normal', new BufferAttribute(normals, 3, true));
        g.setAttribute('color', new BufferAttribute(colours, 3, true));
        if (layer === FAR_CARRIAGEWAY) g.setAttribute('roadSection', new BufferAttribute(c.sections, FAR_SECTION));
        g.setIndex(new BufferAttribute(c.indices, 1));
        const id = batch.addInstance(batch.addGeometry(g));
        batch.setVisibleAt(id, this.shown(c.key));
        g.dispose();
        const n = c.indices.length / 3;
        this.triangleCount += n;
        this.cells.set(c.key, (this.cells.get(c.key) ?? 0) + n);
        const list = this.meshesOf.get(c.key);
        if (list) list.push({ batch, id }); else this.meshesOf.set(c.key, [{ batch, id }]);
      }
      batch.computeBoundingSphere();
      batch.computeBoundingBox();
      this.group.add(batch);
    }
  }

  /** The cells drawing roads, by key (`x,y` on the cells' grid). */
  cellKeys(): string[] {
    return [...this.cells.keys()];
  }

  /** Whether the level standing draws the cell's roads as the blocks do: made of the roads drawn, with roads there, its pieces not left to the detailed surfaces (`RoadResidency.network`: the area left out is cell-aligned, a cell inside it or not). */
  covers(key: string): boolean {
    const made = this.made;
    if (!made || made.id <= this.staleThrough || !this.meshesOf.has(key)) return false;
    const e = made.exclude;
    if (!e) return true;
    const [i, j] = key.split(',').map(Number) as [number, number];
    const x0 = i * made.cell, y0 = j * made.cell;
    return !(e[0] < x0 + made.cell && e[2] > x0 && e[1] < y0 + made.cell && e[3] > y0);
  }

  /** Whether the level standing is not of the roads drawn (none, made before they changed, or cut by an area left to the detail): made again when a cell must be drawn by it (`RoadResidency.wantsNetwork`). */
  outdated(): boolean {
    return !this.made || this.made.id <= this.staleThrough || this.made.exclude !== null;
  }

  /** The roads drawn changed (a build of a road edit landed, `renderer.ts`): every level asked so far stands for none of them. */
  outdate(): void {
    this.staleThrough = this.asked;
  }

  /** A cell hidden: the detailed blocks of its square stand (a cell the view took landed, `roadResidency.ts`). */
  hide(key: string): void {
    this.hidden.add(key);
    for (const { batch, id } of this.meshesOf.get(key) ?? []) batch.setVisibleAt(id, false);
  }

  /** A cell shown: the view let its blocks go, or drew it at this level (`roadResidency.ts`). */
  show(key: string): void {
    this.hidden.delete(key);
    for (const { batch, id } of this.meshesOf.get(key) ?? []) batch.setVisibleAt(id, true);
  }

  private clearMeshes(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      (child as GpuBatchedMesh).dispose();
    }
    this.cells.clear();
    this.meshesOf.clear();
    this.triangleCount = 0;
  }

  /** The level let go: another map opened. */
  clear(): void {
    this.hidden.clear();
    this.made = null;
    this.staleThrough = this.asked + 1;
    this.asked++;
    this.waiting = false;
    this.clearMeshes();
  }

  dispose(): void {
    this.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const material of this.materials) material.dispose();
  }
}
