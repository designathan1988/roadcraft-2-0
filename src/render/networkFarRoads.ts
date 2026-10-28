import { BufferAttribute, BufferGeometry, Group, type Material, Mesh } from 'three';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import type { RoadReads } from '@world/roadField';
import { GpuBatchedMesh } from './buildings/gpuBatchedMesh';
import { type FarLevel, type FarMarks, farCellKey } from './networkFarInput';
import { FAR_SECTION, type FarRoadCell, farPieceCells } from './networkFarPieces';
import { roadPaint } from './roadPaint';
import { pieceName, roadMarks } from './roadMarks';
import { lookOf } from './roadSurfacePass';
import { ROAD_PASS_LOOK } from './roadPassLook';
import { ROAD_CODE } from './mesh/roadEdges';
import { nodeOwner, ownerCell, segmentOwner } from './roads/pieceOwner';
import { farTileCellKeys } from './networkFarTile';
import { TILE, tileOfKey } from '@world/tiles';
import { m } from '@world/units';

/**
 * EVERY ROAD OF THE MAP AT ITS ROOT LEVEL, FROM THE FIRST FRAME OF A MAP'S OPENING AND FOR GOOD (`renderer.ts` buildWorld,
 * `mesh/roadResidency.ts`): the detailed blocks are built only for the cells the view wants, never for the whole map; every other cell is drawn
 * by this level. IT IS THE DETAIL'S OWN ROAD: each road and junction the detail's pieces, surfaces and vertices (`networkFarPieces.ts`), drawn by
 * the road material (`materials.ts` roadRoot: the detail's shader, `mesh/roadEdges.ts` applyRoadSurface), so a street is one road whether its
 * block is built or not. It is made OFF THE PAGE, A 1 KM TILE A JOB (`networkFarTile.ts`), the job threads taking the tiles nearest the view
 * first, each tile put in place as it lands (`requestWhole`); the page's own network holds the tiles near the view alone (`world/networkWindow.ts`).
 * A cell is hidden while the detailed blocks of its square stand (`hide`), shown again when the view lets them go (`show`).
 * AN EDIT MAKES ITS CELLS AGAIN, NEVER THE MAP (`changed`, `refresh`): the network tells what it rebuilt (`Network.changesSince`); the owner
 * cells of those roads and junctions are stale until made again, from their pieces alone (the page's network holds them: an edit is in view), in
 * place in the batch. A move of the roads held (`NetworkDelta.scopeOnly`) is no change of the map: nothing stale. DO NOT walk the whole network
 * for an edit: a 10 km city's 35,000 pieces were read and triangulated again at every road the player drew.
 */

/** The batch and the room it has (`GpuBatchedMesh` is sized when made, grown when a cell's pieces do not fit, `ensure`). */
interface CellBatch { readonly mesh: GpuBatchedMesh; vertices: number; indices: number; instances: number }
/** A cell's instance in the batch: the instance and the geometry it draws, for the cell to be made again in place (`deleteGeometry`). */
interface CellInstance { readonly id: number; readonly geometryId: number }

/** A batch grown for a cell's pieces (`shellBatch.ts` ensure): its live geometries packed into storage a quarter more than they and the new ones hold where the holes of cells made again are worth it, grown otherwise. */
function ensure(batch: CellBatch, vertices: number, indices: number, instances: number): void {
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

/** A cell as the road material reads it: the detail's attributes (`mesh/surfaceTiles.ts` tileArrays), its section's slot the table's. */
function cellGeometry(c: FarRoadCell): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(c.positions, 3));
  g.setAttribute('normal', new BufferAttribute(c.normals, 3));
  g.setAttribute('uv', new BufferAttribute(c.uvs, 2));
  g.setAttribute('color', new BufferAttribute(c.colors, 3));
  g.setAttribute('roadSection', new BufferAttribute(c.sections, FAR_SECTION));
  g.setIndex(new BufferAttribute(c.indices, 1));
  return g;
}

/** Cells made with the pieces' own ids in their carriageways' sections (`lookOf` ids) given the table's slots, in place: a road's `id` its slot,
 *  a plate's `-2 - node` its node's `-2 - slot` (`mesh/surfaceTiles.ts` tableSlot). The other surfaces' third number is their own (a footway's kerb). */
export function resolveFarPieces(cells: readonly FarRoadCell[], doc: RoadDoc): void {
  const table = roadPaint.resolverOf(doc);
  const slotOf = new Map<number, number>();
  const resolve = (piece: number): number => {
    let slot = slotOf.get(piece);
    if (slot === undefined) {
      slot = piece >= 0 ? table(roadPaint.roadSlot(doc, piece as SegmentId)) : piece <= -2 ? -2 - table(roadPaint.nodeSlot(doc, (-2 - piece) as NodeId)) : piece;
      slotOf.set(piece, slot);
    }
    return slot;
  };
  for (const c of cells) {
    const s = c.sections;
    for (let at = 0; at < s.length; at += FAR_SECTION) if (s[at + 3]! <= ROAD_CODE.raised) s[at + 2] = resolve(s[at + 2]!);
  }
}

/** The root level of the roads a network holds made here, a mesh a cell (the lab's sheets, `lab/catalog/layout.ts`): as the game draws it. */
export function farLevelMeshes(net: Network, field: RoadReads, groundAt: (x: number, y: number) => number, cell: number, material: Material): Mesh[] {
  const cells = farPieceCells(net, field, groundAt, cell, null, ROAD_PASS_LOOK);
  // @rebuild Walks the whole map: a lab sheet's layout, every road of it.
  for (const id of net.ribbons.keys()) lookOf(net, id);
  resolveFarPieces(cells, net.doc);
  return cells.filter((c) => c.indices.length > 0).map((c) => {
    const mesh = new Mesh(cellGeometry(c), material);
    mesh.name = `road-far-network-${c.key}`;
    return mesh;
  });
}

/** Who makes a tile's level off the page (`render/networkFarJobs.ts`: `networkFarTile.ts` on a job thread, nearest `at` first); null when it comes with nothing (a failure: said on the console, the tile's cells drawn by the detail where the view takes them). */
export type FarTileSource = (doc: RoadDoc, tile: number, cell: number, at: readonly [number, number]) => Promise<FarLevel | null>;

/** How far round the view's centre the tiles are that the opening waits for (`pending`): the view's want reach of road cells (`renderer.ts` ROAD_WANT_REACH). */
const FAR_NEAR_REACH = m(2_500);
/** How far from the view's centre a tile's marks are placed (`followMarks`): past it a crossing is under a pixel at any view that shows it. */
const MARKS_REACH = m(2_000);

/** A tile's marks as landed (`FarLevel.marks`), its centre, and whether they stand in the marks' texture. */
interface TileMarks { readonly at: readonly [number, number]; marks: readonly FarMarks[]; placed: boolean }

/**
 * The whole network's root level (see the file's comment), KEPT FOR GOOD (`mesh/roadResidency.ts`): a cell is shown where no block draws it in
 * detail, hidden while the detailed blocks of its square stand (`hide`), shown again when the view lets them go (`show`).
 * ONE BATCH (`GpuBatchedMesh`: a cell an instance, shown or hidden by `setVisibleAt`, culled by the frustum one by one, drawn in one multi-draw):
 * DO NOT make a mesh a cell - a city of 70,000 buildings drew 378 of them at its map view (189 cells), 27% of the view's 1,395 draw calls
 * (step-70k, 2026-10-22). An edit's cells are made again in place in the batch (`refresh`).
 */
export class NetworkFarRoads {
  readonly group = new Group();
  private asked = 0;
  private triangleCount = 0;
  /** Each cell's triangles, by its key (`x,y` on the cells' grid): the cells of the map with roads, what the view chooses from (`roadResidency.ts`) and the probes count. */
  readonly cells = new Map<string, number>();
  /** The batch; null until the level landed with pieces. */
  private batch: CellBatch | null = null;
  /** Each cell's instance in the batch, by its key. */
  private readonly meshesOf = new Map<string, CellInstance>();
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
  /** Who makes a tile's level off the page (`FarTileSource`); null: the level made here from the page's network. */
  source: FarTileSource | null = null;
  /** The tiles of the map's level asked and not landed (`requestWhole`), and of them those near the view when asked: what the opening waits for (`pending`). */
  private readonly tilesWaiting = new Set<number>();
  private readonly nearWaiting = new Set<number>();
  /** Each tile's marks (`FarLevel.marks`), placed in the marks' texture while the view is near (`followMarks`). */
  private readonly tileMarks = new Map<number, TileMarks>();
  /** The document the marks were placed for. */
  private marksDoc: RoadDoc | null = null;

  /** `material`: the road material it is drawn with (`materials.ts` roadRoot, the detail's own shader). */
  constructor(private readonly material: Material) {
    this.group.name = 'road-far-network';
  }

  /** Whether the level asked is still being made where the view stands: a tile near the view (`FAR_NEAR_REACH`) not landed. The tiles beyond come after, nearest first. */
  get pending(): boolean {
    return this.nearWaiting.size > 0;
  }

  /** Tiles of the map's level still being made, near the view or not. */
  get tilesPending(): number {
    return this.tilesWaiting.size;
  }

  get triangles(): number {
    return this.triangleCount;
  }

  /**
   * THE MAP'S LEVEL MADE TILE BY TILE OFF THE PAGE (`source`, `networkFarTile.ts`): every tile with a road (the document's tile index, no road
   * read) asked at once, the job threads taking them nearest the view's centre (`at`) first; each tile's cells put in place as it lands
   * (`replaceCells`), the level standing for the tiles landed. With no source, made here from the page's network (every road it holds: a
   * test's, a map with no job worker).
   */
  requestWhole(net: Network, field: RoadReads, groundAt: (x: number, y: number) => number, cell: number, centre: { readonly x: number; readonly y: number }): void {
    const id = ++this.asked;
    const token = net.state;
    const source = this.source;
    this.tilesWaiting.clear();
    this.nearWaiting.clear();
    this.clearMeshes();
    this.clearMarks();
    this.made = { id, cell };
    this.token = token;
    this.stale.clear();
    this.staleAll = false;
    const doc = net.doc;
    this.marksDoc = doc;
    if (!source) { this.place(this.madeHere(net, field, groundAt, cell, null)); return; }
    for (const tile of doc.roadTileKeys()) {
      const { i, j } = tileOfKey(tile);
      const at: readonly [number, number] = [(i + 0.5) * TILE, (j + 0.5) * TILE];
      this.tilesWaiting.add(tile);
      if (Math.hypot(at[0] - centre.x, at[1] - centre.y) <= FAR_NEAR_REACH + TILE) this.nearWaiting.add(tile);
      const landed = (level: FarLevel | null): void => {
        if (id !== this.asked) return;
        this.tilesWaiting.delete(tile);
        this.nearWaiting.delete(tile);
        if (!level) return;
        for (const { id: road, paint, half, lane } of level.paints) roadPaint.set(doc, road, paint, half, lane);
        resolveFarPieces(level.cells, doc);
        this.replaceCells(farTileCellKeys(tile, cell), level.cells);
        // Its marks, placed when the view is near (`followMarks`).
        if (level.marks?.length) this.tileMarks.set(tile, { at, marks: level.marks, placed: false });
      };
      source(doc, tile, cell, at).then(landed, (error: unknown) => {
        console.error(`[roads] the far roads of tile ${tile} were not made`, error);
        landed(null);
      });
    }
  }

  /** The cells of `only` (none: every road the network holds) made here from the page's network, its roads' paint written as the detail writes it
   *  (`lookOf`), their slots the table's. */
  private madeHere(net: Network, field: RoadReads, groundAt: (x: number, y: number) => number, cell: number, only: ReadonlySet<string> | null): FarRoadCell[] {
    const cells = farPieceCells(net, field, groundAt, cell, only, ROAD_PASS_LOOK);
    const roads = new Set<SegmentId>();
    // @rebuild Walks the whole map: the level made here whole (no job thread), every road the network holds.
    if (only === null) for (const id of net.ribbons.keys()) roads.add(id);
    else {
      for (const key of only) {
        const [i, j] = key.split(',').map(Number) as [number, number];
        for (const id of net.segmentCells.idsMeeting([i * cell, j * cell, (i + 1) * cell, (j + 1) * cell])) roads.add(id);
      }
    }
    for (const id of roads) lookOf(net, id);
    resolveFarPieces(cells, net.doc);
    return cells;
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
    // The marks of the pieces changed let go: the detail places them anew (an edit is in view), and the far level's of before would come back
    // once its blocks went.
    const changedPieces = new Set<string>();
    for (const id of roads) changedPieces.add(pieceName({ kind: 'segment', id }));
    for (const id of nodes) changedPieces.add(pieceName({ kind: 'node', id }));
    this.dropMarks(changedPieces);
    // A piece gone (its road removed) is drawn where it was until its cell is made again: the cell it stood in, from the instances standing.
    for (const r of delta.rects) {
      for (let i = Math.floor(r[0] / cell); i <= Math.floor(r[2] / cell); i++) {
        for (let j = Math.floor(r[1] / cell); j <= Math.floor(r[3] / cell); j++) { const key = farCellKey(i, j); if (this.meshesOf.has(key)) this.stale.add(key); }
      }
    }
  }

  /** The level brought up to the roads drawn: the stale cells made again in place from the page's network, or the whole level again where the network could not say what changed. */
  refresh(net: Network, field: RoadReads, groundAt: (x: number, y: number) => number, cell: number, centre: { readonly x: number; readonly y: number }): void {
    if (!this.made || this.staleAll || this.made.cell !== cell) { this.requestWhole(net, field, groundAt, cell, centre); return; }
    if (this.stale.size === 0) return;
    const keys = new Set(this.stale);
    this.token = net.state;
    this.stale.clear();
    this.replaceCells(keys, this.madeHere(net, field, groundAt, cell, keys));
  }

  private shown(key: string): boolean {
    return !this.hidden.has(key);
  }

  /** The whole level put in place: one batch, sized for its cells. */
  private place(cells: readonly FarRoadCell[]): void {
    this.clearMeshes();
    const mine = cells.filter((c) => c.indices.length > 0);
    if (!mine.length) return;
    let vertices = 0, indices = 0;
    for (const c of mine) { vertices += c.positions.length / 3; indices += c.indices.length; }
    const batch = this.makeBatch(mine.length, vertices, indices);
    for (const c of mine) this.addCell(batch, c);
    batch.mesh.computeBoundingSphere();
    batch.mesh.computeBoundingBox();
  }

  /** The cells `keys` made again in place: their instances taken out of the batch, the cells made put in (a cell made with no pieces, its roads gone, stays out). */
  private replaceCells(keys: ReadonlySet<string>, cells: readonly FarRoadCell[]): void {
    let touched = false;
    for (const key of keys) {
      const was = this.meshesOf.get(key);
      if (was && this.batch) { this.batch.mesh.deleteGeometry(was.geometryId); touched = true; }
      this.meshesOf.delete(key);
      this.triangleCount -= this.cells.get(key) ?? 0;
      this.cells.delete(key);
    }
    const mine = cells.filter((c) => c.indices.length > 0 && keys.has(c.key));
    if (mine.length) {
      let vertices = 0, indices = 0;
      for (const c of mine) { vertices += c.positions.length / 3; indices += c.indices.length; }
      const batch = this.batch ?? this.makeBatch(mine.length, vertices, indices);
      ensure(batch, vertices, indices, mine.length);
      for (const c of mine) this.addCell(batch, c);
      touched = true;
    }
    if (touched && this.batch) { this.batch.mesh.computeBoundingSphere(); this.batch.mesh.computeBoundingBox(); }
  }

  /** The batch made for this many cells, vertices and indices, in the group. */
  private makeBatch(instances: number, vertices: number, indices: number): CellBatch {
    const mesh = new GpuBatchedMesh(instances, vertices, indices, this.material);
    mesh.name = 'road-far-network';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // Opaque: no order among its cells to keep.
    mesh.sortObjects = false;
    this.group.add(mesh);
    const batch: CellBatch = { mesh, vertices, indices, instances };
    this.batch = batch;
    return batch;
  }

  /** A cell into the batch, shown or hidden as the cell is. */
  private addCell(batch: CellBatch, c: FarRoadCell): void {
    const g = cellGeometry(c);
    const geometryId = batch.mesh.addGeometry(g);
    const id = batch.mesh.addInstance(geometryId);
    batch.mesh.setVisibleAt(id, this.shown(c.key));
    g.dispose();
    const n = c.indices.length / 3;
    this.triangleCount += n;
    this.cells.set(c.key, (this.cells.get(c.key) ?? 0) + n);
    this.meshesOf.set(c.key, { id, geometryId });
  }

  /**
   * THE FAR LEVEL'S MARKS NEAR THE VIEW (`roadMarks.ts`, a source of their own the detail's of the same piece replaces): each tile's crossings,
   * stop lines, legends and arrows placed while its centre is within `MARKS_REACH` of (x, y), let go past it; written at once for the pieces they
   * reach (`RoadMarks.commit` of those). DO NOT place every tile's: the texture would hold the whole map's marks, most of them under a pixel.
   */
  followMarks(x: number, y: number): void {
    const doc = this.marksDoc;
    if (!doc || this.tileMarks.size === 0) return;
    const touched = new Set<string>();
    for (const tile of this.tileMarks.values()) {
      const want = Math.hypot(tile.at[0] - x, tile.at[1] - y) <= MARKS_REACH + TILE;
      if (want === tile.placed) continue;
      this.placeTile(doc, tile, want, touched);
    }
    if (touched.size) roadMarks.commit(doc, touched);
  }

  /** A tile's marks placed in the texture, or let go (`want` false); the pieces they reach added to `touched`. */
  private placeTile(doc: RoadDoc, tile: TileMarks, want: boolean, touched: Set<string>): void {
    for (const { source, into } of tile.marks) {
      roadMarks.place(doc, source, want ? into : [], true);
      for (const [piece] of into) touched.add(pieceName(piece));
    }
    tile.placed = want;
  }

  /** The marks of `pieces` (by `pieceName`) let go from every tile, and from the texture where placed. */
  private dropMarks(pieces: ReadonlySet<string>): void {
    const doc = this.marksDoc;
    if (!doc || pieces.size === 0) return;
    const touched = new Set<string>();
    for (const tile of this.tileMarks.values()) {
      const gone = tile.marks.filter((mark) => pieces.has(pieceName(mark.source)));
      if (!gone.length) continue;
      if (tile.placed) for (const { source, into } of gone) { roadMarks.place(doc, source, [], true); for (const [piece] of into) touched.add(pieceName(piece)); }
      tile.marks = tile.marks.filter((mark) => !pieces.has(pieceName(mark.source)));
    }
    if (touched.size) roadMarks.commit(doc, touched);
  }

  /** Every tile's marks let go. */
  private clearMarks(): void {
    const doc = this.marksDoc;
    const touched = new Set<string>();
    if (doc) for (const tile of this.tileMarks.values()) if (tile.placed) this.placeTile(doc, tile, false, touched);
    if (doc && touched.size) roadMarks.commit(doc, touched);
    this.tileMarks.clear();
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
    const at = this.meshesOf.get(key);
    if (at && this.batch) this.batch.mesh.setVisibleAt(at.id, false);
  }

  /** A cell shown: the view let its blocks go, or drew it at this level (`roadResidency.ts`). */
  show(key: string): void {
    this.hidden.delete(key);
    const at = this.meshesOf.get(key);
    if (at && this.batch) this.batch.mesh.setVisibleAt(at.id, true);
  }

  private clearMeshes(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      (child as GpuBatchedMesh).dispose();
    }
    this.batch = null;
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
    this.tilesWaiting.clear();
    this.nearWaiting.clear();
    this.clearMeshes();
    this.clearMarks();
    this.marksDoc = null;
  }

  dispose(): void {
    this.clear();
  }
}
