import { BufferAttribute, BufferGeometry, Color, Group, MeshStandardMaterial } from 'three';
import type { Polyline } from '@core/polyline';
import type { NodeId, SegmentId } from '@world/ids';
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
 * triangulated in a job worker: O(the pieces' vertices), proportional to the document and nothing else - once a map, and once more when
 * a scoped opening's solve completes (every road at its solved height). A cell is hidden while the detailed blocks of its square stand
 * (`hide`), shown again when the view lets them go (`show`).
 * AN EDIT MAKES ITS CELLS AGAIN, NEVER THE MAP (`changed`, `refresh`): the network tells what it rebuilt (`Network.changesSince`); the
 * owner cells of those roads and junctions are stale until made again, from their pieces alone, in place in the batches. DO NOT walk the
 * whole network for an edit: a 10 km city's 35,000 pieces were read and triangulated again at every road the player drew.
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

/** A cell's key on the blocks' grid (`roads/pieceOwner.ts` ownerCell), as the residency and the batches name it. */
const keyOf = (i: number, j: number): string => `${i},${j}`;

/** @rebuild The pieces of the network at the far level, their heights read on the page (`heights`, `groundAt` for the roads the solve left):
 *  what the worker triangulates. The pieces whose owner block lies inside `exclude` (cell-aligned) are left out whole. `only`: the cells to make
 *  (an edit's, `NetworkFarRoads.refresh`): the pieces whose owner block is one of them and no other; none, the whole map (a map opened). */
export function farRoadInput(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number,
  exclude: readonly [number, number, number, number] | null, only: ReadonlySet<string> | null = null): { input: FarRoadInput; transfer: ArrayBuffer[] } {
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
  const road = (id: SegmentId, i: number, j: number): void => {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) return;
    const height = pending.has(id) ? onGround : (x: number, y: number): number => heights.onSegment(id, x, y);
    const asphalt = ASPHALT_BY_CLASS[ribbon.typeIndex] ?? STREET_MEANS.asphalt;
    // Its lines along it in the paint's table, as its detail writes them (`roadSurfacePass.ts` lookOf).
    const look = lookOf(net, id);
    const slot = look?.paint === undefined ? -1 : tableSlot(look.paint);
    for (const shape of segmentFarShapes(net, ribbon, deckOf(net, [id]))) add(i, j, shape.layer, shape.layer === 1 ? asphalt : CASING, shape.geom, height, slot, ribbon.full);
  };
  const junction = (id: NodeId, i: number, j: number): void => {
    const node = net.doc.node(id);
    if (!node) return;
    // A junction every road of which the solve left: on the ground, as they are.
    const height = node.incident.length > 0 && node.incident.every((s) => pending.has(s)) ? onGround : roadAt;
    const types = node.incident.map((s) => net.ribbons.get(s)?.typeIndex ?? -1).filter((t) => t >= 0);
    const asphalt = ASPHALT_BY_CLASS[types.length ? Math.max(...types) : 0] ?? STREET_MEANS.asphalt;
    // Its plate's marks: its node's slot as `-2 - slot` (`roadSurfaceReads.ts` asphaltPlate).
    const slot = -2 - tableSlot(roadPaint.nodeSlot(net.doc, id));
    for (const shape of junctionFarShapes(net, id, deckOf(net, node.incident))) add(i, j, shape.layer, shape.layer === 1 ? asphalt : CASING, shape.geom, height, slot);
  };
  if (only === null) {
    for (const id of net.ribbons.keys()) {
      const at = segmentOwner(net, id);
      if (!at) continue;
      const [i, j] = ownerCell(at, cell);
      if (!excluded(i, j)) road(id, i, j);
    }
    for (const id of net.junctions.keys()) {
      const at = nodeOwner(net, id);
      if (!at) continue;
      const [i, j] = ownerCell(at, cell);
      if (!excluded(i, j)) junction(id, i, j);
    }
  } else {
    // The pieces owned by the cells asked: those filed over each cell's square whose owner point lies in it (a piece is drawn whole in its owner's block, whatever it reaches into).
    const roads = new Set<SegmentId>(), junctions = new Set<NodeId>();
    for (const key of only) {
      const [i, j] = key.split(',').map(Number) as [number, number];
      const rect: [number, number, number, number] = [i * cell, j * cell, (i + 1) * cell, (j + 1) * cell];
      for (const id of net.segmentCells.idsMeeting(rect)) {
        const at = segmentOwner(net, id);
        if (at && keyOf(...ownerCell(at, cell)) === key) roads.add(id);
      }
      for (const id of net.junctionCells.idsMeeting(rect)) {
        const at = nodeOwner(net, id);
        if (at && keyOf(...ownerCell(at, cell)) === key) junctions.add(id);
      }
    }
    for (const id of [...roads].sort((p, q) => p - q)) { const [i, j] = ownerCell(segmentOwner(net, id)!, cell); if (!excluded(i, j)) road(id, i, j); }
    for (const id of [...junctions].sort((p, q) => p - q)) { const [i, j] = ownerCell(nodeOwner(net, id)!, cell); if (!excluded(i, j)) junction(id, i, j); }
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

/** A layer's batch and the room it has (`GpuBatchedMesh` is sized when made, grown when a cell's pieces do not fit, `ensure`). */
interface LayerBatch { readonly mesh: GpuBatchedMesh; vertices: number; indices: number; instances: number }
/** A cell's instance in a layer's batch: the instance and the geometry it draws, for the cell to be made again in place (`deleteGeometry`). */
interface CellInstance { readonly batch: LayerBatch; readonly id: number; readonly geometryId: number }

/** A batch grown for a cell's pieces (`shellBatch.ts` ensure): its live geometries packed into storage a quarter more than they and the new ones hold where the holes of cells made again are worth it, grown otherwise. */
function ensure(batch: LayerBatch, vertices: number, indices: number, instances: number): void {
  const mesh = batch.mesh;
  if (vertices > mesh.unusedVertexCount || indices > mesh.unusedIndexCount) {
    const used = mesh.usedCounts();
    const storedVertices = batch.vertices - mesh.unusedVertexCount, storedIndices = batch.indices - mesh.unusedIndexCount;
    const pack = storedVertices - used.vertices > used.vertices / 4 || storedIndices - used.indices > used.indices / 4;
    batch.vertices = Math.max(Math.ceil(((pack ? used.vertices : storedVertices) + vertices) * 1.25), 1 << 12);
    batch.indices = Math.max(Math.ceil(((pack ? used.indices : storedIndices) + indices) * 1.25), 1 << 13);
    if (pack) mesh.compact(batch.vertices, batch.indices);
    else mesh.setGeometrySize(batch.vertices, batch.indices);
  }
  if (mesh.instanceCount + instances > batch.instances) {
    batch.instances = Math.max(batch.instances * 2, mesh.instanceCount + instances);
    mesh.setInstanceCount(batch.instances);
  }
}

/** A cell's layer as its geometry: the positions, a normal of three bytes straight up, a colour of three shorts, the carriageway's section, the triangles. */
function cellGeometry(c: FarRoadCell): BufferGeometry {
  const g = new BufferGeometry();
  const count = c.positions.length / 3;
  const normals = new Int8Array(count * 3);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 127;
  const colours = new Uint16Array(c.colors.length);
  for (let i = 0; i < colours.length; i++) colours[i] = Math.round(Math.min(1, Math.max(0, c.colors[i]!)) * COLOUR_STEPS);
  g.setAttribute('position', new BufferAttribute(c.positions, 3));
  g.setAttribute('normal', new BufferAttribute(normals, 3, true));
  g.setAttribute('color', new BufferAttribute(colours, 3, true));
  if (c.layer === FAR_CARRIAGEWAY) g.setAttribute('roadSection', new BufferAttribute(c.sections, FAR_SECTION));
  g.setIndex(new BufferAttribute(c.indices, 1));
  return g;
}

/**
 * The whole network's far roads (see the file's comment), KEPT FOR GOOD AS THE ROADS' ROOT LEVEL (`mesh/roadResidency.ts`): a cell is
 * shown where no block draws it in detail, hidden while the detailed blocks of its square stand (`hide`), shown again when the view lets
 * them go (`show`). Its vertices are kept small (a position, a normal of three bytes, a colour of three shorts: 21 bytes where floats
 * took 36).
 * ONE BATCH A LAYER (`GpuBatchedMesh`: a cell an instance, shown or hidden by `setVisibleAt`, culled by the frustum one by one, drawn in
 * one multi-draw): DO NOT make a mesh a cell and layer - a city of 70,000 buildings drew 378 of them at its map view (189 cells), 27% of
 * the view's 1,395 draw calls (step-70k, 2026-10-22). An edit's cells are made again in place in the batches (`refresh`).
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
  /** Each layer's batch; null until the level landed with pieces of that layer. */
  private readonly batches: (LayerBatch | null)[] = [null, null];
  /** Each cell's instances in the layers' batches, by its key. */
  private readonly meshesOf = new Map<string, CellInstance[]>();
  /** The cells hidden (`hide`): the detailed blocks of their squares stand. Kept across the levels made: a level landing hides them again. */
  private readonly hidden = new Set<string>();
  /** The level standing: the request it answers (`asked`), its cells' side, the area it left to the detailed surfaces. Null: none landed. */
  private made: { id: number; cell: number; exclude: readonly [number, number, number, number] | null } | null = null;
  /** The network's state the level standing was read from (`Network.state`); null, no level read yet. */
  private token: object | null = null;
  /** The cells whose roads the network rebuilt since the level was read (`changed`): drawn as they were until made again (`refresh`). */
  private readonly stale = new Set<string>();
  /** The network could not say what changed since the level was read (another map, a rebuild of the whole): every cell stale. */
  private staleAll = false;

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
    const token = net.state;
    const { input, transfer } = farRoadInput(net, heights, groundAt, cell, exclude);
    this.ask(id, input, transfer, (cells) => {
      this.made = asking;
      this.token = token;
      this.stale.clear();
      this.staleAll = false;
      this.place(cells);
    });
  }

  /** The network rebuilt (a world build landed, `renderer.ts`): the owner cells of the roads and junctions it changed are stale, made again by `refresh`. */
  changed(net: Network): void {
    if (!this.made) return;
    const delta = net.changesSince(this.token);
    this.token = net.state;
    if (delta === null) { this.staleAll = true; return; }
    const cell = this.made.cell;
    const roads = new Set<SegmentId>(delta.segments);
    // A junction's plate and corners follow its roads, a road's strips end on its junctions' mouths: both sides of every change.
    for (const node of delta.nodes) for (const id of net.doc.node(node)?.incident ?? []) roads.add(id);
    const nodes = new Set<NodeId>(delta.nodes);
    for (const id of roads) { const s = net.doc.segment(id); if (s) { nodes.add(s.a); nodes.add(s.b); } }
    for (const id of roads) { const at = segmentOwner(net, id); if (at) this.stale.add(keyOf(...ownerCell(at, cell))); }
    for (const id of nodes) { const at = nodeOwner(net, id); if (at) this.stale.add(keyOf(...ownerCell(at, cell))); }
    // A piece gone (its road removed) is drawn where it was until its cell is made again: the cell it stood in, from the instances standing.
    for (const r of delta.rects) {
      for (let i = Math.floor(r[0] / cell); i <= Math.floor(r[2] / cell); i++) {
        for (let j = Math.floor(r[1] / cell); j <= Math.floor(r[3] / cell); j++) { const key = keyOf(i, j); if (this.meshesOf.has(key)) this.stale.add(key); }
      }
    }
  }

  /** The level brought up to the roads drawn: the stale cells made again in place, or the whole level where the network could not say what changed. */
  refresh(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number): void {
    if (!this.made || this.staleAll || this.made.cell !== cell) { this.request(net, heights, groundAt, cell, null); return; }
    if (this.stale.size === 0) return;
    const keys = new Set(this.stale);
    const id = ++this.asked;
    this.waiting = true;
    const token = net.state;
    const { input, transfer } = farRoadInput(net, heights, groundAt, cell, null, keys);
    this.ask(id, input, transfer, (cells) => {
      this.token = token;
      for (const key of keys) this.stale.delete(key);
      this.replaceCells(keys, cells);
    });
  }

  /** The worker asked for the cells of `input`; `landed` once they come (and the request is still the last). Where no worker can be made (Node: the specs that open a city), made here. */
  private ask(id: number, input: FarRoadInput, transfer: ArrayBuffer[], landed: (cells: readonly FarRoadCell[]) => void): void {
    const land = (cells: readonly FarRoadCell[]): void => { if (id === this.asked) { landed(cells); this.waiting = false; } };
    const failed = (why: unknown): void => {
      console.warn('[roads] the far roads could not be made off the page; made here', why);
      this.worker = null;
      if (id === this.asked) land(buildFarRoadCells(input));
    };
    if (typeof Worker === 'undefined') { land(buildFarRoadCells(input)); return; }
    try {
      const worker = this.worker ??= jobPort('roadFar');
      worker.onmessage = (event: MessageEvent<{ id: number; cells?: FarRoadCell[]; error?: string }>) => {
        if (event.data.id !== id) return;
        if (event.data.cells) land(event.data.cells); else failed(event.data.error);
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

  /** The whole level put in place: a batch a layer, sized for its cells. */
  private place(cells: readonly FarRoadCell[]): void {
    this.clearMeshes();
    for (const layer of [0, 1] as const) {
      const mine = cells.filter((c) => (c.layer === 0 ? 0 : 1) === layer && c.indices.length > 0);
      if (!mine.length) continue;
      let vertices = 0, indices = 0;
      for (const c of mine) { vertices += c.positions.length / 3; indices += c.indices.length; }
      const batch = this.makeBatch(layer, mine.length, vertices, indices);
      for (const c of mine) this.addCell(batch, c);
      batch.mesh.computeBoundingSphere();
      batch.mesh.computeBoundingBox();
    }
  }

  /** The cells `keys` made again in place: their instances taken out of the batches, the cells made put in (a cell made with no pieces, its roads gone, stays out). */
  private replaceCells(keys: ReadonlySet<string>, cells: readonly FarRoadCell[]): void {
    const touched = new Set<LayerBatch>();
    for (const key of keys) {
      for (const { batch, geometryId } of this.meshesOf.get(key) ?? []) { batch.mesh.deleteGeometry(geometryId); touched.add(batch); }
      this.meshesOf.delete(key);
      this.triangleCount -= this.cells.get(key) ?? 0;
      this.cells.delete(key);
    }
    for (const layer of [0, 1] as const) {
      const mine = cells.filter((c) => (c.layer === 0 ? 0 : 1) === layer && c.indices.length > 0 && keys.has(c.key));
      if (!mine.length) continue;
      let vertices = 0, indices = 0;
      for (const c of mine) { vertices += c.positions.length / 3; indices += c.indices.length; }
      const batch = this.batches[layer] ?? this.makeBatch(layer, mine.length, vertices, indices);
      ensure(batch, vertices, indices, mine.length);
      for (const c of mine) this.addCell(batch, c);
      touched.add(batch);
    }
    for (const batch of touched) { batch.mesh.computeBoundingSphere(); batch.mesh.computeBoundingBox(); }
  }

  /** A layer's batch made for this many cells, vertices and indices, in the group. */
  private makeBatch(layer: 0 | 1, instances: number, vertices: number, indices: number): LayerBatch {
    const mesh = new GpuBatchedMesh(instances, vertices, indices, this.materials[layer]);
    mesh.name = 'road-far-network';
    mesh.renderOrder = layer === 0 ? 1 : 2;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // Opaque, each layer pulled over the one under it (`pullTowardEye`): no order among its cells to keep.
    mesh.sortObjects = false;
    this.group.add(mesh);
    const batch: LayerBatch = { mesh, vertices, indices, instances };
    this.batches[layer] = batch;
    return batch;
  }

  /** A cell's layer into its batch, shown or hidden as the cell is. */
  private addCell(batch: LayerBatch, c: FarRoadCell): void {
    const g = cellGeometry(c);
    const geometryId = batch.mesh.addGeometry(g);
    const id = batch.mesh.addInstance(geometryId);
    batch.mesh.setVisibleAt(id, this.shown(c.key));
    g.dispose();
    const n = c.indices.length / 3;
    this.triangleCount += n;
    this.cells.set(c.key, (this.cells.get(c.key) ?? 0) + n);
    const list = this.meshesOf.get(c.key);
    const instance: CellInstance = { batch, id, geometryId };
    if (list) list.push(instance); else this.meshesOf.set(c.key, [instance]);
  }

  /** The cells drawing roads, by key (`x,y` on the cells' grid). */
  cellKeys(): string[] {
    return [...this.cells.keys()];
  }

  /** Whether the level standing draws the cell's roads as the blocks do: made of the roads drawn (not stale), with roads there, its pieces not left to the detailed surfaces (`RoadResidency.network`: the area left out is cell-aligned, a cell inside it or not). */
  covers(key: string): boolean {
    const made = this.made;
    if (!made || this.staleAll || this.stale.has(key) || !this.meshesOf.has(key)) return false;
    const e = made.exclude;
    if (!e) return true;
    const [i, j] = key.split(',').map(Number) as [number, number];
    const x0 = i * made.cell, y0 = j * made.cell;
    return !(e[0] < x0 + made.cell && e[2] > x0 && e[1] < y0 + made.cell && e[3] > y0);
  }

  /** Whether the level standing is not of the roads drawn in some cell (none, a cell stale, or cut by an area left to the detail): brought up by `refresh` when a cell must be drawn by it (`RoadResidency.wantsNetwork`). */
  outdated(): boolean {
    return !this.made || this.staleAll || this.stale.size > 0 || this.made.exclude !== null;
  }

  /** A cell hidden: the detailed blocks of its square stand (a cell the view took landed, `roadResidency.ts`). */
  hide(key: string): void {
    this.hidden.add(key);
    for (const { batch, id } of this.meshesOf.get(key) ?? []) batch.mesh.setVisibleAt(id, false);
  }

  /** A cell shown: the view let its blocks go, or drew it at this level (`roadResidency.ts`). */
  show(key: string): void {
    this.hidden.delete(key);
    for (const { batch, id } of this.meshesOf.get(key) ?? []) batch.mesh.setVisibleAt(id, true);
  }

  private clearMeshes(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      (child as GpuBatchedMesh).dispose();
    }
    this.batches[0] = this.batches[1] = null;
    this.cells.clear();
    this.meshesOf.clear();
    this.triangleCount = 0;
  }

  /** The level let go: another map opened. */
  clear(): void {
    this.hidden.clear();
    this.made = null;
    this.token = null;
    this.stale.clear();
    this.staleAll = false;
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
