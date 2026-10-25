import type { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { Digest } from '@core/digest';
import type { ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import { junctionBounds } from '@world/ribbons';
import { ViewCells } from '@world/viewCells';
import { JournalCursor } from '@world/derived';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { ROAD_STRUCTURES, roadStructure } from '@world/structures';
import { m } from '@world/units';
import {
  type Bar,
  type StrokeSpec,
  approachLegendsAt,
  junctionDetailAt,
  midBlockDetailAt,
  miniRoundaboutIsland,
  transitionMarkings,
  type ZebraStretch,
} from '@world/markings';
import { parkingLinesOf, parksAlong } from '@world/parkingLayout';
import {
  type Filed, type MarkGroup, type MarkPasses, type MarkPiece, STOP_PAINT, barGroup, fileMarks, islandGroup, parkingGroups, roadMarks, roadStrokes, strokeGroups, zebraGroup,
} from './roadMarks';
import { type Geom, type Input, inputOf } from './roads/pieceGeom';
import { type Shape, segmentShapes } from './roads/segmentPiece';
import { junctionShapes } from './roads/junctionPiece';
import { nodeOwner, segmentOwner } from './roads/pieceOwner';
import {
  type CellHold, type Entry, type InputResidency, NODE_PAD, type NodeItem, type PartKey, PHASE, type PassInputs, type Reach, type SegmentItem, type Superset, type SurfacePass, TILE, TILE_REACH, WAKE_PAD, alignmentPass, byPart, byWalk, cellRectOfPart, entryBytes, entryOf, growRect, isGroundPass, ownedPart, pieceKey, pieceOfPart, surfaceInputWork, unite,
} from './roadSurfaceEntries';

export { CELL, ROAD_INPUT_RESIDENCY, TILE_REACH, byPart, cellRectOfPart, cellOfPart, surfaceInputWork } from './roadSurfaceEntries';
export type { InputResidency, PartKey, Reach, SurfacePass } from './roadSurfaceEntries';

/**
 * DO NOT gather a pass's inputs by walking the whole map and filtering by the pass
 *
 * THE ROADS' SURFACES' INPUTS, PIECE BY PIECE: each road and each junction is a piece (`roadSurfaceEntries.ts` pieceKey), its shapes made from its
 * own centreline and cross-section or its own outlines (`roads/segmentPiece.ts`, `roads/junctionPiece.ts`) and filed under each part of it, its
 * one part: the piece whole, in the block that owns it (`roads/pieceOwner.ts`), meshed from its shapes whole (`roads/pieceMesh.ts`), nothing cut at a
 * block's edge. An edit to a road makes that road's part and its two junctions' again, and no other.
 */
export class SurfaceInputs {
  /** `gates`: the entrances a street's parking keeps clear of (`parkingLayout.ts` gatesNear), for a network without its buildings (a road bake in a worker, `nearRoadTiles.ts`); none: the document's buildings. */
  /** `residency`: the inputs held round the view, cell by cell (`viewCells.ts`), each item derived only when a part it reaches is visited; none: every item derived for good (a bake in a worker, the tests). */
  constructor(private readonly gates: ((line: Polyline, half: number) => [Vec2, Vec2][]) | null = null, residency: InputResidency | null = null) {
    this.cells = residency ? new ViewCells<CellHold>({
      name: 'road surface inputs',
      version: 1,
      reach: residency.reach,
      cpuBudget: residency.cpuBudget,
      derive: (_key, rect) => this.deriveCell(rect),
      release: (key, hold) => this.releaseCell(key, hold),
    }) : null;
  }

  /** The cells the inputs are held in round the view; null: every item derived for good. */
  readonly cells: ViewCells<CellHold> | null;
  /** The items not derived now, filed by their boxes: what a visited part derives (`wakeTile`). */
  private dormantSegments = new CellFiling<SegmentId, SegmentItem>(TILE);
  private dormantNodes = new CellFiling<NodeId, NodeItem>(TILE);
  /** The items derived now (held round the view only). */
  private readonly residentSegments = new Set<SegmentId>();
  private readonly residentNodes = new Set<NodeId>();
  /** What the derived items' inputs hold, bytes (an estimate, `entryBytes`). */
  residentBytes = 0;
  /** Set while every item is let go at once (`rebuildAll`): the cells let go with them make nothing dormant. */
  private resetting = false;

  private net: Network | null = null;
  /** The network's state the inputs stand for (`Network.state`). */
  private token: object | null = null;
  private style: string | null = null;
  /** The buildings' entries read (a street's parking keeps clear of their gates, `parkingLayout.ts`). */
  private readonly buildings = new JournalCursor(['buildings']);
  private readonly segments = new Map<SegmentId, SegmentItem>();
  private readonly nodes = new Map<NodeId, NodeItem>();
  /** The roads with an end raised by hand: drawn in an alignment of their own. */
  private readonly manual = new Set<SegmentId>();
  /** Each such road's alignment, by its lowest id; and each alignment's roads, in id order. */
  private readonly rootOf = new Map<SegmentId, SegmentId>();
  private readonly chains = new Map<SegmentId, SegmentId[]>();
  /** The document's roads in each pass. */
  private readonly count = new Map<string, number>();
  private readonly passes = new Map<string, PassInputs>();
  /** Passes made so far: each pass's birth number. */
  private births = 0;

  /** @rebuild Brings the inputs up to `net`: the items its change since the last refresh names, and the roads round them, made again */
  refresh(net: Network): void {
    const doc = net.doc;
    const same = this.net === net && this.token !== null;
    const delta = same ? net.changesSince(this.token) : null;
    const styleChanged = this.style !== doc.markingStyle;
    const buildings = this.buildings.read(doc.changes);
    this.net = net;
    this.token = net.state;
    this.style = doc.markingStyle;
    // A change of the paint's standard repaints every road and junction
    if (delta === null || styleChanged || buildings === null || buildings.some((entry) => entry.rects === null)) {
      this.rebuildAll(net);
      return;
    }

    const segs = new Set<SegmentId>(delta.segments);
    // A crossing is fitted to the footway along its road, a flush footway lowers the kerbs on it
    if (delta.rects.length) for (const id of net.segmentCells.idsMeetingAny(delta.rects)) segs.add(id);
    const nodes = new Set<NodeId>(delta.nodes);
    const ends = (id: SegmentId): void => {
      const segment = doc.segment(id);
      if (segment) { nodes.add(segment.a); nodes.add(segment.b); }
      const item = this.segments.get(id);
      if (item) { nodes.add(item.ends[0]); nodes.add(item.ends[1]); }
    };
    for (const id of segs) ends(id);
    // A road's lines stop at its nodes' stop lines and crossings, and its ends lie on their plates' mouths
    for (const node of nodes) for (const id of doc.node(node)?.incident ?? []) segs.add(id);
    for (const id of segs) ends(id);
    // A building changed beside a street with parking: the bays keep clear of its gates.
    const near: ChangeRect[] = [];
    for (const entry of buildings) for (const r of entry.rects ?? []) near.push([r[0] - PARKING_REACH, r[1] - PARKING_REACH, r[2] + PARKING_REACH, r[3] + PARKING_REACH]);
    if (near.length) {
      for (const id of net.segmentCells.idsMeetingAny(near)) {
        const ribbon = net.ribbons.get(id);
        if (ribbon && parksAlong(net, ribbon)) segs.add(id);
      }
    }
    // The alignments the roads changed are in, and the roads whose pass that moved.
    for (const id of this.reassign(net, segs)) {
      if (segs.has(id) || this.passOf(net, id) === (this.segments.get(id)?.pass ?? null)) continue;
      segs.add(id);
      ends(id);
    }
    for (const id of [...segs].sort((p, q) => p - q)) this.placeSegment(net, id);
    for (const node of [...nodes].sort((p, q) => p - q)) this.placeNode(net, node);
  }

  /** @rebuild Every item made again: the network could not say what changed (a load, the first build). Held round the view, every item is only filed by its box, its inputs derived when a part it reaches is visited (`wakeTile`): DO NOT derive the whole map's shapes before the city appears. */
  private rebuildAll(net: Network): void {
    this.resetting = true;
    this.cells?.clear();
    this.resetting = false;
    this.dormantSegments = new CellFiling<SegmentId, SegmentItem>(TILE);
    this.dormantNodes = new CellFiling<NodeId, NodeItem>(TILE);
    this.residentSegments.clear();
    this.residentNodes.clear();
    this.residentBytes = 0;
    this.passes.clear();
    this.segments.clear();
    this.nodes.clear();
    this.manual.clear();
    this.rootOf.clear();
    this.chains.clear();
    this.count.clear();
    // Every mark let go with them, placed again as each item is (`roadMarks.ts`, written at the build's swap).
    roadMarks.clear(net.doc);
    const ids = [...net.doc.segments.keys()].sort((p, q) => p - q);
    this.reassign(net, ids);
    const nodes = [...net.doc.nodes.keys()].sort((p, q) => p - q);
    if (this.cells) {
      for (const id of ids) this.fileSegment(net, id);
      for (const node of nodes) this.fileNode(net, node);
      return;
    }
    for (const id of ids) this.placeSegment(net, id);
    for (const node of nodes) this.placeNode(net, node);
  }

  /** A road filed as not derived (held round the view): its pass counted, its parts filed (`Superset`). */
  private fileSegment(net: Network, id: SegmentId): void {
    const segment = net.doc.segment(id);
    if (!segment) return;
    const pass = this.passOf(net, id)!;
    this.count.set(pass, (this.count.get(pass) ?? 0) + 1);
    const box = this.segmentBox(net, id);
    const fresh: SegmentItem = { pass, ends: [segment.a, segment.b], entries: [], box, superset: null, bytes: 0 };
    const item = this.dormant(fresh, [pass], this.segmentParts(net, id));
    this.segments.set(id, item);
    if (item.box) this.dormantSegments.file(id, item, item.box);
  }

  /** A node filed as not derived: its owner's pass, its parts. */
  private fileNode(net: Network, node: NodeId): void {
    const box = this.nodeBox(net, node);
    if (!box) return;
    const owner = this.ownerOf(net, node);
    const item = this.dormant({ entries: [], box, superset: null, bytes: 0 }, owner !== null ? [owner] : [], this.nodeParts(net, node));
    this.nodes.set(node, item);
    this.dormantNodes.file(node, item, box);
  }

  /** A road's part: the road whole, in the block the middle of its centreline lies in; none where it has no ribbon. */
  private segmentParts(net: Network, id: SegmentId): PartKey[] {
    const at = segmentOwner(net, id);
    return at ? [ownedPart(pieceKey('segment', id), at)] : [];
  }

  /** A junction's part: the junction whole, in the block its node lies in. */
  private nodeParts(net: Network, node: NodeId): PartKey[] {
    const at = nodeOwner(net, node);
    return at ? [ownedPart(pieceKey('node', node), at)] : [];
  }

  /** The box a road's inputs lie in: its ribbon's (`ribbonBounds`, every level), or null when it has none. */
  private segmentBox(net: Network, id: SegmentId): ChangeRect | null {
    const box = net.segmentCells.rectOf(id);
    return box ? growRect(box, TILE_REACH + NODE_PAD) : null;
  }

  /**
   * The box a node's inputs may lie in: its roads' boxes and its plates', grown by `NODE_PAD`, and the box of every shape it makes (`entries`, else
   * those it has made: `junctionPiece.ts`), each shape's own (`pieceGeom.ts` inputOf); null for a node with neither. DO NOT take its outlines'
   * rings for its shapes: a kerb return past a straight angle is mitred and a footway's back corner squared as the owner's road tool draws them, out
   * past the rings (16 m in the grid-and-bends fixture), and a build handed the field for the rings alone read no road there
   * (`tests/render/roadTileWorkers.spec.ts`).
   */
  private nodeBox(net: Network, node: NodeId, entries?: readonly Entry[]): ChangeRect | null {
    let box: ChangeRect | null = null;
    for (const id of net.doc.node(node)?.incident ?? []) box = unite(box, net.segmentCells.rectOf(id) ?? null);
    const byLevel = net.junctions.get(node);
    if (byLevel) box = unite(box, junctionBounds(byLevel));
    if (box) box = growRect(box, NODE_PAD);
    for (const { input } of entries ?? this.nodes.get(node)?.entries ?? []) {
      // A shape with no place of its own (stations) moves no box.
      if (input.minX <= input.maxX) box = unite(box, [input.minX, input.minY, input.maxX, input.maxY]);
    }
    return box;
  }

  /** An item made not derived: its parts counted in its passes (`PassInputs.dormant`) before its entries go, so no pass is left empty on the way. */
  private dormant<T extends { readonly entries: readonly Entry[] | null; readonly box: ChangeRect | null; readonly superset: Superset | null; readonly bytes: number }>(item: T, passes: readonly string[], parts: readonly PartKey[]): T {
    const superset: Superset | null = item.box && passes.length && parts.length ? { passes, tiles: parts } : null;
    if (superset) {
      for (const id of superset.passes) {
        const pass = this.passFor(id);
        for (const key of superset.tiles) pass.dormant.set(key, (pass.dormant.get(key) ?? 0) + 1);
      }
    }
    if (item.entries) { this.unfile(item.entries, true); this.residentBytes -= item.bytes; }
    return { ...item, entries: null, superset, bytes: 0 };
  }

  /** A dormant item's superset taken out of its passes (it is derived now, or gone); `dirty`: its parts visited by the next build (what it drew there may have changed). */
  private undormant(superset: Superset | null, dirty: boolean): void {
    if (!superset) return;
    for (const id of superset.passes) {
      const pass = this.passes.get(id);
      if (!pass) continue;
      for (const key of superset.tiles) {
        const n = (pass.dormant.get(key) ?? 0) - 1;
        if (n > 0) pass.dormant.set(key, n); else pass.dormant.delete(key);
        if (dirty) pass.dirty.add(key);
      }
      if (pass.tiles.size === 0 && pass.dormant.size === 0) this.passes.delete(pass.id);
    }
  }

  /** A pass's inputs, made if it has none yet. */
  private passFor(id: string): PassInputs {
    let pass = this.passes.get(id);
    if (!pass) this.passes.set(id, pass = { id, tiles: new Map(), dormant: new Map(), born: this.births++, dirty: new Set() });
    return pass;
  }

  /** The box of a part's whole piece: where what it reads lies. DO NOT take its share of its block alone: a part is meshed from its piece whole
   *  (its strips' stations asked of every stretch of it, `roads/pieceMesh.ts`), so the two parts of a road that crosses a block's edge read the
   *  same heights and meet on the same vertices. */
  private partRect(key: PartKey): ChangeRect {
    const net = this.net;
    if (!net) return cellRectOfPart(key);
    const piece = pieceOfPart(key);
    return (piece.kind === 'segment' ? this.segmentBox(net, piece.id as SegmentId) : this.nodeBox(net, piece.id as NodeId)) ?? cellRectOfPart(key);
  }

  /** Where a part's piece lies (`partRect`), for the build: its ground's and its heights' reads. */
  rectOf(key: PartKey): ChangeRect {
    return this.partRect(key);
  }

  /** The items that may put inputs in part `key` derived, with the cells round its piece (`WAKE_PAD`): what a build visiting it reads is whole. Nothing when every item is derived for good. */
  wakeTile(key: PartKey): void {
    if (this.cells) this.wakeRect(growRect(this.partRect(key), WAKE_PAD));
  }

  /** The cells a rectangle reaches derived (`deriveCell`), none of them let go for another. */
  private wakeRect(rect: ChangeRect): void {
    const cells = this.cells;
    if (!cells || !this.net) return;
    const keys: number[] = [];
    cells.forCellsOver(rect, (cell) => { keys.push(cell); });
    cells.ensureMany(keys);
  }

  /** A cell of the residency derived: every road and node whose box meets it derived (silently: the same inputs they had), and found. */
  private deriveCell(rect: ChangeRect): { value: CellHold; cpuBytes: number } {
    const net = this.net!;
    const segments = new Set<SegmentId>([...net.segmentCells.idsMeeting(rect), ...this.dormantSegments.idsMeeting(rect)]);
    const nodes = new Set<NodeId>(this.dormantNodes.idsMeeting(rect));
    let bytes = 0;
    for (const id of [...segments].sort((p, q) => p - q)) {
      const item = this.segments.get(id);
      if (!item) { segments.delete(id); continue; }
      if (!item.entries) this.placeSegment(net, id, true);
      bytes += this.segments.get(id)?.bytes ?? 0;
      for (const end of item.ends) nodes.add(end);
    }
    for (const node of [...nodes].sort((p, q) => p - q)) {
      const item = this.nodes.get(node);
      if (!item) { nodes.delete(node); continue; }
      if (!item.entries) this.placeNode(net, node, true);
      bytes += this.nodes.get(node)?.bytes ?? 0;
    }
    return { value: { segments: [...segments], nodes: [...nodes] }, cpuBytes: bytes };
  }

  /** Whether a box meets a cell held now (other than `except`). */
  private held(box: ChangeRect | null, except: number): boolean {
    const cells = this.cells;
    if (!cells || !box) return false;
    let found = false;
    cells.forCellsOver(box, (key) => { if (!found && key !== except && cells.has(key)) found = true; });
    return found;
  }

  /** A cell let go: the items it found that no other held cell meets made not derived again. */
  private releaseCell(key: number, hold: CellHold): void {
    if (this.resetting) return;
    for (const id of hold.segments) this.letGoSegment(id, key);
    for (const node of hold.nodes) this.letGoNode(node, key);
  }

  private letGoSegment(id: SegmentId, except: number): void {
    const item = this.segments.get(id);
    if (!item?.entries || this.held(item.box, except)) return;
    const dormant = this.dormant(item, item.pass !== null ? [item.pass] : [], this.net ? this.segmentParts(this.net, id) : []);
    this.segments.set(id, dormant);
    this.residentSegments.delete(id);
    if (dormant.box) this.dormantSegments.file(id, dormant, dormant.box);
  }

  private letGoNode(node: NodeId, except: number): void {
    const item = this.nodes.get(node);
    if (!item?.entries || this.held(item.box, except) || !this.net) return;
    const owner = this.ownerOf(this.net, node);
    const dormant = this.dormant(item, owner !== null ? [owner] : [], this.nodeParts(this.net, node));
    this.nodes.set(node, dormant);
    this.residentNodes.delete(node);
    if (dormant.box) this.dormantNodes.file(node, dormant, dormant.box);
  }

  /** The inputs brought back to the view after a build (`roadSurfaces.ts`): the cells round the eye wanted (`most` of them derived ahead), every item derived that no held cell meets let go, the cells kept to their budget. */
  keepNear(eye: { readonly x: number; readonly y: number } | null, most = 4): void {
    const cells = this.cells;
    if (!cells || !this.net || !eye) return;
    cells.look(eye);
    cells.pump(most);
    // At rest a quarter of the budget, past the cells the view wants: the rest is a build's room to sweep the map (`ROAD_INPUT_RESIDENCY`).
    cells.trim(null, cells.spec.cpuBudget / 4);
    for (const id of [...this.residentSegments]) this.letGoSegment(id, Number.NaN);
    for (const node of [...this.residentNodes]) this.letGoNode(node, Number.NaN);
  }

  /** Whether a road has an end raised by hand: it is drawn from its own deck, in an alignment. */
  private static raisedByHand(net: Network, id: SegmentId): boolean {
    const segment = net.doc.segment(id);
    return !!segment && (Math.abs(net.doc.node(segment.a)?.heightOffset ?? 0) > 1e-6 ||
      Math.abs(net.doc.node(segment.b)?.heightOffset ?? 0) > 1e-6);
  }

  /** The alignments of `ids` made again */
  private reassign(net: Network, ids: Iterable<SegmentId>): Set<SegmentId> {
    const doc = net.doc;
    const redo = new Set<SegmentId>();
    for (const id of ids) {
      const now = SurfaceInputs.raisedByHand(net, id);
      const was = this.manual.has(id);
      if (now) this.manual.add(id); else this.manual.delete(id);
      if (!now && !was) continue;
      redo.add(id);
      const root = this.rootOf.get(id);
      if (root === undefined) continue;
      for (const member of this.chains.get(root) ?? []) redo.add(member);
      this.chains.delete(root);
    }
    for (const id of redo) this.rootOf.delete(id);
    const reached = new Set<SegmentId>();
    for (const start of redo) {
      if (!this.manual.has(start) || this.rootOf.has(start)) continue;
      const component: SegmentId[] = [start];
      const seen = new Set<SegmentId>([start]);
      for (let k = 0; k < component.length; k++) {
        const segment = doc.segment(component[k]!);
        if (!segment) continue;
        for (const end of [segment.a, segment.b]) {
          // Bent or straight: a bend's junction plate belongs to the pass that holds both its legs.
          const incident = doc.node(end)?.incident;
          if (!incident || incident.length !== 2) continue;
          for (const other of incident) {
            if (seen.has(other) || !this.manual.has(other)) continue;
            seen.add(other);
            component.push(other);
          }
        }
      }
      component.sort((p, q) => p - q);
      const root = component[0]!;
      for (const member of component) {
        // An alignment this one joined: its roads move into this one.
        const before = this.rootOf.get(member);
        if (before !== undefined && before !== root) {
          for (const moved of this.chains.get(before) ?? []) reached.add(moved);
          this.chains.delete(before);
        }
        this.rootOf.set(member, root);
        reached.add(member);
      }
      this.chains.set(root, component);
    }
    for (const id of reached) redo.add(id);
    return redo;
  }

  /** The pass a road is drawn in: its alignment when raised by hand, else its structural level. */
  private passOf(net: Network, id: SegmentId): string | null {
    const segment = net.doc.segment(id);
    if (!segment) return null;
    const root = this.rootOf.get(id);
    return root !== undefined ? alignmentPass(root) : segment.structure;
  }

  /** A road's inputs made again and filed: its bands, median and dropped kerbs (`segmentPiece.ts`), its paint. `silent`: derived again as it was
   *  (held round the view, `wakeTile`): no part made dirty. */
  private placeSegment(net: Network, id: SegmentId, silent = false): void {
    surfaceInputWork.segments++;
    const old = this.segments.get(id);
    if (old) {
      if (old.entries) { this.unfile(old.entries, silent); this.residentBytes -= old.bytes; }
      else this.dormantSegments.remove(id);
      if (old.pass !== null) this.count.set(old.pass, (this.count.get(old.pass) ?? 1) - 1);
      this.segments.delete(id);
      this.residentSegments.delete(id);
    }
    const segment = net.doc.segment(id);
    const source: MarkPiece = { kind: 'segment', id };
    if (!segment) { roadMarks.place(net.doc, source, []); if (old && !old.entries) this.undormant(old.superset, !silent); return; }
    const pass = this.passOf(net, id)!;
    this.count.set(pass, (this.count.get(pass) ?? 0) + 1);
    const entries: Entry[] = [];
    const box = this.segmentBox(net, id);
    const parts = this.segmentParts(net, id);
    const ribbon = net.ribbons.get(id);
    const marks: MarkGroup[] = [];
    if (ribbon && parts.length) {
      let seq = 0;
      const add = (slot: string, phase: number, geom: Geom): void => {
        const input = inputOf(geom);
        if (input) entries.push(entryOf(input, slot, phase, id, seq++, pass, parts));
      };
      for (const shape of segmentShapes(net, ribbon)) add(shape.slot, PHASE.road, shape.geom);
      // Its arrows and bus lanes' legends, its parking bays and the no-parking lines beside them (`world/parkingLayout.ts`): marks the carriageway's
      // shader draws (`roadMarks.ts`), no polygon of paint.
      for (const spec of roadStrokes(net, ribbon)) marks.push(...strokeGroups(spec));
      const gates = this.gates && parksAlong(net, ribbon) ? this.gates(ribbon.full, ribbon.road.width / 2) : null;
      const hit = { s: 0, distance: 0 };
      const along = (p: Vec2): number => { ribbon.full.closestInto(p.x, p.y, hit); return hit.s; };
      for (const line of parkingLinesOf(net, ribbon, gates)) marks.push(...parkingGroups(line, along));
    }
    roadMarks.place(net.doc, source, fileMarks(net, source, marks, this.markPasses(net)));
    const bytes = entryBytes(entries);
    this.segments.set(id, { pass, ends: [segment.a, segment.b], entries, box: this.cells ? box : null, superset: null, bytes });
    this.file(entries, silent);
    this.residentBytes += bytes;
    if (this.cells) this.residentSegments.add(id);
    // Its superset out once its entries are in (no pass left empty on the way); made by an edit, the parts it reached before visited again.
    if (old && !old.entries) this.undormant(old.superset, !silent);
  }

  /** A node's inputs made again and filed, in the pass of its lowest road: its plates and corners (`junctionPiece.ts`), its paint. */
  private placeNode(net: Network, node: NodeId, silent = false): void {
    surfaceInputWork.nodes++;
    const old = this.nodes.get(node);
    if (old) {
      if (old.entries) { this.unfile(old.entries, silent); this.residentBytes -= old.bytes; }
      else this.dormantNodes.remove(node);
      this.nodes.delete(node);
      this.residentNodes.delete(node);
    }
    const record = net.doc.node(node);
    const source: MarkPiece = { kind: 'node', id: node };
    if (!record) { roadMarks.place(net.doc, source, []); if (old && !old.entries) this.undormant(old.superset, !silent); return; }
    const entries: Entry[] = [];
    const owner = this.ownerOf(net, node);
    const parts = this.nodeParts(net, node);
    const filed: [MarkPiece, Filed[]][] = [];
    if (owner !== null && parts.length) {
      let seq = 0;
      const add = (slot: string, phase: number, geom: Geom): void => {
        const input = inputOf(geom);
        if (input) entries.push(entryOf(input, slot, phase, node, seq++, owner, parts));
      };
      for (const shape of junctionShapes(net, node) as Shape[]) add(shape.slot, PHASE.junction, shape.geom);
      filed.push(...this.nodeMarks(net, node, owner));
    }
    roadMarks.place(net.doc, source, filed);
    const box = this.nodeBox(net, node, entries);
    const bytes = entryBytes(entries);
    if (entries.length || this.cells) this.nodes.set(node, { entries, box: this.cells ? box : null, superset: null, bytes });
    this.file(entries, silent);
    this.residentBytes += bytes;
    if (this.cells) this.residentNodes.add(node);
    if (old && !old.entries) this.undormant(old.superset, !silent);
  }

  /** The pass a junction's plates are drawn in: that of its lowest road that is not a tunnel */
  private ownerOf(net: Network, node: NodeId): string | null {
    const record = net.doc.node(node);
    if (!record) return null;
    let lowest = Infinity;
    let owner: string | null = null;
    for (const id of record.incident) {
      const structure = net.doc.segment(id)?.structure ?? 'ground';
      if (structure === 'tunnel') continue;
      const clearance = roadStructure(structure).clearance;
      if (clearance < lowest) {
        lowest = clearance;
        owner = this.passOf(net, id);
      }
    }
    // A node of tunnels only: its first road's pass.
    if (owner === null && record.incident.length) owner = this.passOf(net, record.incident[0]!);
    return owner;
  }

  /** The passes a mark's pieces are drawn in (`roadMarks.ts` fileMarks): a road's, a node's plate's. */
  private markPasses(net: Network): MarkPasses {
    return { segment: (id) => this.passOf(net, id), node: (id) => this.ownerOf(net, id) };
  }

  /**
   * A node's marks (`roadMarks.ts`), each filed on the piece it lies on: the taper's lines on its plate (in any pass, as they always were); and for a
   * junction drawn at ground level, as its paint always was: each leg's stop line, crossings and the rule's legends on that leg's own carriageway,
   * in whatever pass that road is drawn (DO NOT file them in the plate's pass: as polygons there, a leg of another pass, a road raised by hand, had
   * them float over its own deck or sink under it), and a mini-roundabout's island on its plate.
   */
  private nodeMarks(net: Network, node: NodeId, owner: string): [MarkPiece, Filed[]][] {
    const passes = this.markPasses(net);
    const plate: MarkPiece = { kind: 'node', id: node };
    const onPlate: MarkGroup[] = [];
    // The tapers where a road carries on at another width, whose lane lines and edge lines run on through them.
    if (net.transitions.has(node)) for (const spec of transitionMarkings(net, node)) onPlate.push(...strokeGroups(spec));
    const onLegs = new Map<SegmentId, MarkGroup[]>();
    const onLeg = (seg: SegmentId, group: MarkGroup | null): void => {
      if (!group) return;
      let list = onLegs.get(seg);
      if (!list) onLegs.set(seg, list = []);
      list.push(group);
    };
    if (isGroundPass(owner)) {
      const stops: Bar[] = [], zebras: Bar[] = [], runs: ZebraStretch[] = [], stopSegs: SegmentId[] = [];
      junctionDetailAt(net, node, stops, zebras, runs, stopSegs);
      midBlockDetailAt(net, node, stops, zebras, runs, stopSegs);
      stops.forEach((bar, k) => onLeg(stopSegs[k]!, barGroup(STOP_PAINT, bar)));
      // A crosswalk a shape a run of its bars, the bars cut by the shader (`ZebraStretch`), not a quad a bar.
      for (const run of runs) onLeg(run.seg, zebraGroup(run));
      // Mini-roundabouts' painted islands (V5), and the junction rule's words and symbols before the stop lines (V6).
      const island = miniRoundaboutIsland(net, node);
      if (island) onPlate.push(islandGroup(island));
      const legends: StrokeSpec[] = [], legendSegs: SegmentId[] = [];
      approachLegendsAt(net, node, net.doc.markingStyle, legends, legendSegs);
      legends.forEach((spec, k) => { for (const group of strokeGroups(spec)) onLeg(legendSegs[k]!, group); });
    }
    const out: [MarkPiece, Filed[]][] = fileMarks(net, plate, onPlate, passes);
    for (const [seg, groups] of [...onLegs].sort((p, q) => p[0] - q[0])) out.push(...fileMarks(net, { kind: 'segment', id: seg }, groups, passes));
    return out;
  }

  /** `silent`: entries derived again as they were (`wakeTile`), or let go while what they drew still stands (`dormant`): what the parts read is put together again, no part made dirty. */
  private file(entries: readonly Entry[], silent = false): void {
    for (const entry of entries) {
      const pass = this.passFor(entry.pass);
      for (const key of entry.tiles) {
        let tile = pass.tiles.get(key);
        if (!tile) pass.tiles.set(key, tile = { key, slots: new Map(), own: 0, reach: null, digest: 0 });
        let set = tile.slots.get(entry.slot);
        if (!set) tile.slots.set(entry.slot, set = new Set());
        set.add(entry);
        tile.own++;
        tile.reach = null;
        if (!silent) pass.dirty.add(key);
      }
    }
  }

  private unfile(entries: readonly Entry[], silent = false): void {
    for (const entry of entries) {
      const pass = this.passes.get(entry.pass);
      if (!pass) continue;
      for (const key of entry.tiles) {
        const tile = pass.tiles.get(key);
        const set = tile?.slots.get(entry.slot);
        if (!tile || !set) continue;
        set.delete(entry);
        if (set.size === 0) tile.slots.delete(entry.slot);
        tile.own--;
        tile.reach = null;
        if (!silent) pass.dirty.add(key);
        if (tile.own === 0) pass.tiles.delete(key);
      }
      if (pass.tiles.size === 0 && pass.dormant.size === 0) this.passes.delete(pass.id);
    }
  }

  /** A pass's birth and the parts whose inputs changed since the build last settled them; null when the pass is not there. */
  dirtyOf(pass: string): { readonly born: number; readonly keys: ReadonlySet<PartKey> } | null {
    const p = this.passes.get(pass);
    return p ? { born: p.born, keys: p.dirty } : null;
  }

  /** The build that took these parts of a pass finished: they are no longer dirty (a pass made again since keeps its own). */
  settle(pass: string, born: number, keys: Iterable<PartKey>): void {
    const p = this.passes.get(pass);
    if (!p || p.born !== born) return;
    for (const key of keys) p.dirty.delete(key);
  }

  /** A part a build visits: the items reaching it derived (`wakeTile`), then whether the pass has it. */
  visits(pass: string, key: PartKey): boolean {
    this.wakeTile(key);
    return this.hasTile(pass, key);
  }

  /** Whether a pass has a part at `key`: inputs filed there, or an item not derived now that may put some (`wakeTile` derives them). */
  hasTile(pass: string, key: PartKey): boolean {
    const p = this.passes.get(pass);
    return !!p && (p.tiles.has(key) || p.dormant.has(key));
  }

  /** The parts of a pass whose piece's box meets one of `rects` (a change of the ground or the heights there): filed or dormant. */
  partsMeeting(pass: string, rects: readonly (readonly number[])[]): PartKey[] {
    const net = this.net, p = this.passes.get(pass);
    if (!net || !p || rects.length === 0) return [];
    const boxes = rects.map((r): ChangeRect => [r[0]!, r[1]!, r[2]!, r[3]!]);
    const out = new Set<PartKey>();
    const take = (parts: readonly PartKey[]): void => { for (const key of parts) if (p.tiles.has(key) || p.dormant.has(key)) out.add(key); };
    for (const id of net.segmentCells.idsMeetingAny(boxes)) {
      take(this.segmentParts(net, id));
      const segment = net.doc.segment(id);
      if (segment) for (const node of [segment.a, segment.b]) take(this.nodeParts(net, node));
    }
    return [...out];
  }

  /** The passes of the surfaces: every structural level, then each alignment raised by hand, by its lowest road. */
  passList(): SurfacePass[] {
    const out: SurfacePass[] = ROAD_STRUCTURES.map((structure) => ({ id: structure.id, structure: structure.id }));
    for (const root of [...this.chains.keys()].sort((p, q) => p - q)) {
      out.push({ id: alignmentPass(root), structure: 'ground', segment: root, chain: this.chains.get(root)! });
    }
    return out;
  }

  /** Whether some road of the document is drawn in a pass. */
  present(pass: string): boolean {
    return (this.count.get(pass) ?? 0) > 0;
  }

  /** The keys of a pass's parts, in order. */
  tileKeys(pass: string): PartKey[] {
    const p = this.passes.get(pass);
    if (!p) return [];
    const keys = new Set(p.tiles.keys());
    for (const key of p.dormant.keys()) keys.add(key);
    return [...keys].sort(byPart);
  }

  /** What a part of a pass reads, put together when something in it changed: its piece's shapes by surface, in the walk's order. */
  reachOf(passId: string, key: PartKey): { readonly reach: Reach; readonly digest: number } {
    // Held round the view: the items reaching it derived first (a build visiting it has, `wakeTile`).
    this.wakeTile(key);
    const pass = this.passes.get(passId)!;
    const tile = pass.tiles.get(key)!;
    if (tile.reach) return { reach: tile.reach, digest: tile.digest };
    const slots = [...tile.slots.keys()].sort();
    const reach = new Map<string, Input[]>();
    const digest = new Digest();
    for (const slot of slots) {
      const inputs = [...tile.slots.get(slot)!].sort(byWalk).map((entry) => entry.input);
      reach.set(slot, inputs);
      digest.addText(slot).add(inputs.length);
      for (const input of inputs) digest.add(input.digest);
    }
    tile.reach = reach;
    tile.digest = digest.value();
    return { reach, digest: tile.digest };
  }
}

/** How far from a building's box a street's parking may read its gates (`parkingLayout.ts` `entrancesNear`). */
const PARKING_REACH = m(8.5);
