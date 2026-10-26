import { BufferAttribute, BufferGeometry, Group, MeshStandardMaterial } from 'three';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { jobPort } from '../jobs/jobPool';
import { GpuBatchedMesh } from './buildings/gpuBatchedMesh';
import { pullTowardEye } from './depthConvention';
import { type FarLevel, type FarRoadHeights, type PieceSlots, farCellKey, farRoadInput } from './networkFarInput';
import { FAR_CARRIAGEWAY, FAR_SECTION, type FarRoadCell, type FarRoadInput, buildFarRoadCells } from './networkFarRoadsBuild';
import { roadPaint } from './roadPaint';
import { lookOf } from './roadSurfacePass';
import { applyRoadFarPaint } from './mesh/roadEdges';
import { nodeOwner, ownerCell, segmentOwner } from './roads/pieceOwner';

/**
 * EVERY ROAD OF THE MAP AT ITS FAR LEVEL, THE ROADS' ROOT LEVEL, FROM THE FIRST FRAME OF A MAP'S OPENING AND FOR GOOD (`renderer.ts`
 * buildWorld, `mesh/roadResidency.ts`): the detailed surfaces are built only for the cells the view wants (nearest first, under the
 * tier's budget), never for the whole map; every other cell is drawn by this level. It is made OFF THE PAGE from the whole network solved
 * there (`networkBake.worker.ts`, `networkFarInput.ts` farLevelOf: each road's and junction's real outline, the carriageway and the casing
 * its footways and kerbs fill, at its class's colour over the street textures' means, at the roads' solved heights on the map's natural
 * ground), the page's own network holding the tiles near the view alone (`world/networkWindow.ts`). Each road and junction is the same
 * piece as in the detail, coarse: its carriageway and its casing as strips and fans on its own edges and mouths (`networkFarRoadsBuild.ts`),
 * filed by its owner block (`roads/pieceOwner.ts`): O(the pieces' vertices), proportional to the document and nothing else, once a map
 * (`takeWhole`). A cell is hidden while the detailed blocks of its square stand (`hide`), shown again when the view lets them go (`show`).
 * AN EDIT MAKES ITS CELLS AGAIN, NEVER THE MAP (`changed`, `refresh`): the network tells what it rebuilt (`Network.changesSince`); the
 * owner cells of those roads and junctions are stale until made again, from their pieces alone (the page's network holds them: an edit is
 * in view), in place in the batches. A move of the roads held (`NetworkDelta.scopeOnly`) is no change of the map: nothing stale. DO NOT
 * walk the whole network for an edit: a 10 km city's 35,000 pieces were read and triangulated again at every road the player drew.
 */

export type { FarRoadHeights } from './networkFarInput';

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

/** The paint's slots a piece's vertices carry on the page: the table's own (`roadPaint.ts` resolverOf), a road's look written as its detail writes it (`roadSurfacePass.ts` lookOf). */
export function pageSlots(net: Network): PieceSlots {
  const table = roadPaint.resolverOf(net.doc);
  return {
    road: (id) => { const look = lookOf(net, id); return look?.paint === undefined ? -1 : table(look.paint); },
    node: (id) => table(roadPaint.nodeSlot(net.doc, id)),
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

/** A level made off the page (`networkFarInput.ts` farLevelOf, each carriageway vertex carrying its piece's id) made the page's: every road's paint written in the table as its detail writes it (`roadPaint.set`), each vertex's section given its piece's table slot (a road's, a plate's `-2 - slot` of its node). */
export function resolveFarPieces(level: FarLevel, doc: RoadDoc): void {
  for (const { id: road, paint, half, lane } of level.paints) roadPaint.set(doc, road, paint, half, lane);
  const table = roadPaint.resolverOf(doc);
  const slotOf = new Map<number, number>();
  const resolve = (piece: number): number => {
    let slot = slotOf.get(piece);
    if (slot === undefined) {
      slot = piece === -1 ? -1 : piece >= 0 ? table(roadPaint.roadSlot(doc, piece as SegmentId)) : -2 - table(roadPaint.nodeSlot(doc, (-2 - piece) as NodeId));
      slotOf.set(piece, slot);
    }
    return slot;
  };
  for (const c of level.cells) {
    if (c.layer !== FAR_CARRIAGEWAY) continue;
    for (let v = 0; v < c.pieces.length; v++) c.sections[v * FAR_SECTION + 2] = resolve(c.pieces[v]!);
  }
}

/** Who makes the whole map's level off the page (`main.ts`: the network job, `networkBake.worker.ts`); null when it comes with nothing (no job worker, a failure: the level then made here from the page's network, which holds what it holds). */
export type FarLevelSource = (doc: RoadDoc, cell: number) => Promise<FarLevel | null>;

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
  /** The level standing: the request it answers (`asked`), its cells' side. Null: none landed. */
  private made: { id: number; cell: number } | null = null;
  /** The network's state the level standing was read from (`Network.state`); null, no level read yet. */
  private token: object | null = null;
  /** The cells whose roads the network rebuilt since the level was read (`changed`): drawn as they were until made again (`refresh`). */
  private readonly stale = new Set<string>();
  /** The network could not say what changed since the level was read (another map, a rebuild of the whole): every cell stale. */
  private staleAll = false;
  /** Who makes the whole map's level off the page (`FarLevelSource`); null: made here. */
  source: FarLevelSource | null = null;

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

  /**
   * The whole map's level made off the page from the document (`source`), replacing any when it lands; with no source, or when it answers
   * nothing, made here from the page's network (every road it holds: a test's, a map with no job worker).
   */
  requestWhole(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number): void {
    const id = ++this.asked;
    this.waiting = true;
    const token = net.state;
    const source = this.source;
    if (!source) { this.requestHere(id, net, heights, groundAt, cell, token); return; }
    void source(net.doc, cell).then((level) => {
      if (id !== this.asked) return;
      if (level) this.takeWhole(level, net.doc, token);
      else this.requestHere(id, net, heights, groundAt, cell, token);
    }, (error: unknown) => {
      console.warn('[roads] the far roads could not be made off the page; made here', error);
      if (id === this.asked) this.requestHere(id, net, heights, groundAt, cell, token);
    });
  }

  /** A whole level made off the page and handed in (`FarLevel`, a city's opening): its roads' paint written in the table, its pieces' ids resolved to their slots, the level put in place. */
  takeWhole(level: FarLevel, doc: RoadDoc, token: object): void {
    const id = ++this.asked;
    resolveFarPieces(level, doc);
    this.made = { id, cell: level.cell };
    this.token = token;
    this.stale.clear();
    this.staleAll = false;
    this.place(level.cells);
    this.waiting = false;
  }

  /** The level of the roads the page's network holds, triangulated off the page. */
  private requestHere(id: number, net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number, token: object): void {
    const { input, transfer } = farRoadInput(net, heights, groundAt, cell, null, pageSlots(net));
    this.ask(id, input, transfer, (cells) => {
      this.made = { id, cell };
      this.token = token;
      this.stale.clear();
      this.staleAll = false;
      this.place(cells);
    });
  }

  /** The network rebuilt (a world build landed, `renderer.ts`): the owner cells of the roads and junctions an edit changed are stale, made again by `refresh`; the roads held moving (`scopeOnly`) changes nothing of the map. */
  changed(net: Network): void {
    if (!this.made) return;
    const delta = net.changesSince(this.token);
    this.token = net.state;
    if (delta === null) { this.staleAll = true; return; }
    if (delta.scopeOnly) return;
    const cell = this.made.cell;
    const roads = new Set<SegmentId>(delta.segments);
    // A junction's plate and corners follow its roads, a road's strips end on its junctions' mouths: both sides of every change.
    for (const node of delta.nodes) for (const id of net.doc.node(node)?.incident ?? []) roads.add(id);
    const nodes = new Set<NodeId>(delta.nodes);
    for (const id of roads) { const s = net.doc.segment(id); if (s) { nodes.add(s.a); nodes.add(s.b); } }
    for (const id of roads) { const at = segmentOwner(net, id); if (at) this.stale.add(farCellKey(...ownerCell(at, cell))); }
    for (const id of nodes) { const at = nodeOwner(net, id); if (at) this.stale.add(farCellKey(...ownerCell(at, cell))); }
    // A piece gone (its road removed) is drawn where it was until its cell is made again: the cell it stood in, from the instances standing.
    for (const r of delta.rects) {
      for (let i = Math.floor(r[0] / cell); i <= Math.floor(r[2] / cell); i++) {
        for (let j = Math.floor(r[1] / cell); j <= Math.floor(r[3] / cell); j++) { const key = farCellKey(i, j); if (this.meshesOf.has(key)) this.stale.add(key); }
      }
    }
  }

  /** The level brought up to the roads drawn: the stale cells made again in place from the page's network, or the whole level again where the network could not say what changed. */
  refresh(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number): void {
    if (!this.made || this.staleAll || this.made.cell !== cell) { this.requestWhole(net, heights, groundAt, cell); return; }
    if (this.stale.size === 0) return;
    const keys = new Set(this.stale);
    const id = ++this.asked;
    this.waiting = true;
    const token = net.state;
    const { input, transfer } = farRoadInput(net, heights, groundAt, cell, keys, pageSlots(net));
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

  /** Whether the level standing draws the cell's roads as the blocks do: made of the roads drawn (not stale), with roads there. */
  covers(key: string): boolean {
    return this.made !== null && !this.staleAll && !this.stale.has(key) && this.meshesOf.has(key);
  }

  /** Whether the level standing is not of the roads drawn in some cell (none, a cell stale): brought up by `refresh` when a cell must be drawn by it (`RoadResidency.wantsNetwork`). */
  outdated(): boolean {
    return !this.made || this.staleAll || this.stale.size > 0;
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
