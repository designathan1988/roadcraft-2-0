import { m } from '@world/units';
import { CELL } from '@world/cells';
import type { SegmentId } from '@world/ids';
import type { LaneletId } from '@world/lanelets';
import { type LinkSpec, linkSpec } from './linkSpec';
import type { BodyClass } from '@world/conflictPoints';
import { segmentLine } from '@world/geometry';
import { DT, FLEET_CEILING } from '../params';
import type { SimWorld } from '../world';
import { spawnVehicleAt } from '../vehicles/spawn';
import { mayRequestSearch } from '../routing/searchScratch';
import { TRAFFIC } from '../ambient/ambient';
import { MesoModel } from './model';
import { DemandCells } from './demand';
import { MICRO_RADIUS, type MesoDelta, followView } from './memory';
import { linkId, linkSegment, reverseLink } from './tileLinks';
import { MesoPublisher, type PublishedLinks } from './mesoPublish';
import { MesoRates } from './mesoRates';
import { SlotIndex, Threads, grown } from './slots';

/** THE MESO TRAFFIC IN THE SIMULATION: the world's flows (`model.ts`) over the document's roads, and the micro window they hand their cars to and take them back from */
// The cost of a tick is bounded, not the map's size: a step's work (the rates, the model's phases, the publish) is spread over the
// ticks of its second, `MESO_WORK_PER_TICK` links a tick (Factorio's work in buckets, FFF #421); a step owed while one is under way
// waits for it (the far traffic slows, the tick does not grow). The page is sent only the links that changed (`MesoDelta`).
// DO NOT read the links off the lane graph: it holds the window's roads alone (`SimWorld.useMeso`). A link is a directed road of the
// document (`linkSpec`: its lanes, trimmed length, speed, stop line from the road's profile and the network's trims, as the lane graph
// builds its lanes from them); the lanes are asked of the graph only where the window holds them (`lanesOf`: the cars made, counted
// and taken back, the turns weighed by the movements).

/** Seconds of the city between two steps of the meso model. */
const MESO_DT = 1;
/** Links (and nodes) of meso work a tick: rates, the model's four phases and the publish together, about six units a link a step (measured: under 1 ms a tick at 200,000 links). A step of about 40,000 links keeps up with the clock at 60 ticks a second; past it the far traffic runs slower than the clock, the tick never longer. */
const MESO_WORK_PER_TICK = 4096;
/** Most cars made in the window a tick, as the edge entries admit them (`vehicles/spawn.ts` ADMIT_PER_TICK). */
const ADMIT_PER_TICK = 4;
/** How far ahead of a link's start a car handed in at its upstream end is made. */
const ENTRY_CLEARANCE = m(0.6);
/** Handoff lanes tried for a new car before it goes without a destination (its lookahead drives it, the window's edge takes it back). */
const HANDOFF_TRIES = 4;
/** A node's word (`nodes`): a turning circle, then the roads meeting at it counted in steps of `ROAD`. */
const BULB = 1;
const ROAD = 4;
/** What a step's work is doing (`job`). */
const IDLE = 0, RATES = 1, MODEL = 2, PUBLISH = 3;
const NONE: readonly LaneletId[] = Object.freeze([]);

/** The world's 250 m cell holding a point, as `CellFiling` keys it: the window finds its links by it. */
const cellOfPoint = (x: number, y: number): number => (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(y / CELL) + 32768);

export class Meso {
  model = new MesoModel(MESO_DT);
  private demand = new DemandCells();
  private clock = 0;
  /** The network's state the links were last brought up to, and the lane graph's the turns were. */
  private netSeen: object | null = null;
  private graphSeen: object | null = null;
  /** Each link its dense slot, the slots freed taken again (a link's id is a double). */
  private index = new SlotIndex();
  private slotTop = 0;
  private freeSlots: number[] = [];
  /** Room for slots below it in every table by slot. */
  private cap = 0;
  /** Each slot's link (NaN: none). */
  private linkAt = new Float64Array(0);
  /** Each slot's middle (x, y) and its demand cell (`DemandCells.cellOf`, dense; -1: none). */
  private mid = new Float64Array(0);
  private cellOf = new Int32Array(0);
  /** Each slot's road: the nodes it joins and its segment, when `placed`. */
  private endFrom = new Float64Array(0);
  private endTo = new Float64Array(0);
  private endSeg = new Float64Array(0);
  private placed = new Uint8Array(0);
  /** The slots by the 250 m cell of their middle (the window's), by the node they leave and the node they reach. */
  private cells = new Threads();
  private outAt = new Threads();
  private inAt = new Threads();
  /** Each node's word (`BULB`, `ROAD`s), while a road meets it or it is flagged. */
  private nodes = new Map<number, number>();
  /** Nodes whose links came or went since the last `settle`: their links' exits, signals and turns worked out again. */
  private touchedNodes = new Set<number>();
  /** Each slot's line (start, middle, end: x, y), whether its road is one-way, and whether the page has not had its line. */
  private lines = new Float32Array(0);
  private oneWay = new Uint8Array(0);
  private dirty = new Uint8Array(0);
  /** The micro window: where it stands, and where it was asked to go (`want`). */
  private micro = { x: 0, y: 0, r: 0 };
  private wanted: { x: number; y: number; r: number } | null = null;
  /** The vehicles the meso handed to the micro simulation: taken back when they drive out of the window. */
  readonly owned = new Set<number>();
  /** The slots inside the window: the handoff lanes are found from them (`handoffLanes`), never from the map's. */
  private readonly inside = new Set<number>();
  /** Slots with vehicles to make in the window, and how many of each to spread along it (handed with the window) rather than at its start. */
  private readonly pendingSlots = new Set<number>();
  private readonly fill = new Map<number, number>();
  /** Slots given a count of the micro vehicles last step. */
  private counted: number[] = [];

  /** The step's work under way (`IDLE`, `RATES`, `MODEL`, `PUBLISH`) and where it stands; whether a step is owed. */
  private job = IDLE;
  private cursor = 0;
  private owed = false;
  /** Links of work a tick (`MESO_WORK_PER_TICK`; a test may make it whole). */
  budget = MESO_WORK_PER_TICK;
  /** Steps the clock owed while one was under way, let go (the far traffic ran slower than the clock), since the start. */
  late = 0;
  /** What the page is sent (`mesoPublish.ts`). */
  private readonly publisher = new MesoPublisher();

  /** Everything of the model forgotten (another map, the simulation started over): the window kept (entered again over the new map's links at the next step). */
  reset(): void {
    this.model = new MesoModel(MESO_DT);
    this.demand = new DemandCells();
    this.clock = 0;
    this.netSeen = null;
    this.graphSeen = null;
    this.index = new SlotIndex();
    this.slotTop = 0;
    this.freeSlots = [];
    this.cap = 0;
    this.linkAt = new Float64Array(0);
    this.mid = new Float64Array(0);
    this.cellOf = new Int32Array(0);
    this.endFrom = new Float64Array(0);
    this.endTo = new Float64Array(0);
    this.endSeg = new Float64Array(0);
    this.placed = new Uint8Array(0);
    this.cells = new Threads();
    this.outAt = new Threads();
    this.inAt = new Threads();
    this.nodes = new Map();
    this.nodesChanged++;
    this.touchedNodes.clear();
    this.lines = new Float32Array(0);
    this.oneWay = new Uint8Array(0);
    this.dirty = new Uint8Array(0);
    this.owned.clear();
    this.inside.clear();
    this.pendingSlots.clear();
    this.fill.clear();
    this.counted = [];
    this.job = IDLE;
    this.cursor = 0;
    this.owed = false;
    this.publisher.reset();
    this.published = { model: this.model, linkAt: this.linkAt, oneWay: this.oneWay, lines: this.lines, dirty: this.dirty };
    this.windowMoves++;
    // The window stands where it was asked to: entered again over the new map's links at the next step.
    this.wanted ??= { ...this.micro };
    this.micro = { x: 0, y: 0, r: 0 };
  }

  /** The page's copy of the links is new (its first window, or it lost deltas): the next publish sends every link. */
  requestWhole(): void {
    this.publisher.requestWhole();
  }

  /** The links changed since the last call, for the page (null: nothing new). */
  takeDelta(): MesoDelta | null {
    return this.publisher.takeDelta();
  }

  /** The micro window asked to stand round (x, y), moved at the next step; `r` the most it grows to (`follow`). */
  want(x: number, y: number, r = MICRO_RADIUS): void {
    this.wanted = { x, y, r };
    this.most = r;
  }
  private most = 0;

  /** The micro window as it stands (null before it stands anywhere). */
  microWindow(): { readonly x: number; readonly y: number; readonly r: number } | null {
    return this.micro.r > 0 ? this.micro : null;
  }

  /** The world moves the window (`SimWorld.useMeso`): the lane graph holds the window's roads, built before the window moves onto them (`wantedWindow`, `windowMoved`); off, the window moves itself at each step. */
  driven = false;

  /** Where the window would move to now (`want`, `followView`); null: it stays. */
  wantedWindow(): { readonly x: number; readonly y: number; readonly r: number } | null {
    return this.wanted;
  }

  /** The roads of `to` are the lane graph's: the window moves there now (`SimWorld.rescopeSteps`). */
  windowMoved(w: SimWorld, to: { readonly x: number; readonly y: number; readonly r: number }): void {
    this.sync(w);
    this.settle(w);
    this.moveWindow(w, to);
  }

  /**
   * Whoever drives on these roads is the meso's again, as `takeBack` makes a car that drove out of the window: taken off the micro
   * simulation and counted on the road's link (the roads leave the lane graph, `SimWorld.rescopeSteps`). The buses are their timetable's
   * (`transit.ts` takeOff), not the meso's.
   */
  takeBackFrom(w: SimWorld, segments: ReadonlySet<SegmentId>): void {
    const left = new Map<number, number>();
    for (const seg of segments) {
      for (const id of w.graph.linksOfSegment(seg)) {
        const slot = this.slotOfLane(w, id);
        for (const vid of [...w.rt(id).order]) {
          const v = w.vehicles.get(vid);
          if (!v || v.free || v.lanelet !== id || v.archetype.shape === 'bus') continue;
          w.removeVehicle(v);
          this.owned.delete(vid);
          if (slot === undefined || !this.model.has(slot)) continue;
          if (this.model.isInside(slot)) left.set(slot, (left.get(slot) ?? 0) + 1);
          else this.model.microExit(slot);
        }
      }
    }
    // A link inside the window whose road leaves the graph: its cars are the model's again, as when it leaves the window.
    for (const [slot, k] of left) this.leave(w, slot, k);
  }

  /** Stage 2 (`pipeline.ts`): the links brought up to the document and the lane graph, cars made in the window, and a share of the step's work. */
  step(w: SimWorld, traffic: boolean): void {
    if (!traffic) return;
    this.scale = w.trafficIntensity * w.demandMultiplier;
    this.sync(w);
    this.settle(w);
    // Following the view, judged against the window as it stands: DO NOT judge against the page's ask (`want`, its most each frame), the window jumped to it and lost its hysteresis.
    if (w.focus && this.most > 0) this.wanted = followView(this.micro, w.focus, this.most);
    // Driven by the world, the window moves once its roads are the lane graph's (`windowMoved`).
    if (this.wanted && !this.driven) this.moveWindow(w, this.wanted);
    this.admit(w);
    this.clock += DT;
    if (this.clock + 1e-9 >= MESO_DT) {
      this.clock -= MESO_DT;
      if (this.owed || this.job !== IDLE) this.late++;
      this.owed = true;
    }
    // A step owed starts once the one under way is done: DO NOT run two in a tick to catch up (the tick would grow with the map).
    if (this.job === IDLE && this.owed) { this.owed = false; this.begin(w); }
    if (this.job !== IDLE) this.work(w, this.budget);
  }

  /** The slot of a link lane of the graph (a bus lane has none, as the model counts no bus lane), if its road is in the model. */
  slotOfLane(w: SimWorld, id: LaneletId): number | undefined {
    const lane = w.graph.lanelets.get(id);
    if (!lane || lane.kind !== 'link' || lane.segment === undefined || lane.use === 'bus') return undefined;
    const seg = w.doc.segment(lane.segment);
    if (!seg) return undefined;
    return this.slotOfLink(linkId(lane.segment, seg.a === lane.from ? 0 : 1));
  }

  /** The slot of a link (`tileLinks.ts` linkId), if it is in the model. */
  slotOfLink(link: number): number | undefined {
    const slot = this.index.get(link);
    return slot >= 0 ? slot : undefined;
  }

  /** The link a slot holds (NaN: none). */
  linkOfSlot(slot: number): number {
    return slot < this.cap ? this.linkAt[slot]! : Number.NaN;
  }

  /** The graph's lanes of a slot's link (none where the graph does not hold its road: outside the window), in id order. */
  private lanesOf(w: SimWorld, slot: number): readonly LaneletId[] {
    if (!this.placed[slot]) return NONE;
    const from = this.endFrom[slot]!;
    let out: LaneletId[] | null = null;
    for (const id of w.graph.linksOfSegment(this.endSeg[slot]! as SegmentId)) {
      const lane = w.graph.lanelets.get(id);
      if (lane && lane.from === from && lane.use !== 'bus') (out ??= []).push(id);
    }
    return out ? out.sort() : NONE;
  }

  /** Whether the graph holds a slot's lanes (its road is the window's). */
  private hasLanes(w: SimWorld, slot: number): boolean {
    if (!this.placed[slot]) return false;
    const from = this.endFrom[slot]!;
    for (const id of w.graph.linksOfSegment(this.endSeg[slot]! as SegmentId)) {
      const lane = w.graph.lanelets.get(id);
      if (lane && lane.from === from && lane.use !== 'bus') return true;
    }
    return false;
  }

  // ------------------------------------------------------------ slots

  private slotFor(link: number): number {
    let slot = this.index.get(link);
    if (slot >= 0) return slot;
    slot = this.freeSlots.pop() ?? this.slotTop++;
    this.reserve(slot + 1);
    this.index.set(link, slot);
    this.linkAt[slot] = link;
    return slot;
  }

  /** Room for slots below `n` in every table by slot, doubling. */
  private reserve(n: number): void {
    if (n <= this.cap) return;
    const next = Math.max(n, this.cap * 2, 64);
    this.linkAt = grown(this.linkAt, next, Number.NaN);
    this.mid = grown(this.mid, next * 2);
    this.cellOf = grown(this.cellOf, next, -1);
    this.endFrom = grown(this.endFrom, next);
    this.endTo = grown(this.endTo, next);
    this.endSeg = grown(this.endSeg, next);
    this.placed = grown(this.placed, next);
    this.lines = grown(this.lines, next * 6);
    this.oneWay = grown(this.oneWay, next);
    this.dirty = grown(this.dirty, next);
    this.publisher.reserve(next);
    for (const t of [this.cells, this.outAt, this.inAt]) t.reserve(next);
    this.cap = next;
    this.published = { model: this.model, linkAt: this.linkAt, oneWay: this.oneWay, lines: this.lines, dirty: this.dirty };
  }

  /** The tables the publisher reads (`mesoPublish.ts`), made once per growth of them: DO NOT make one a tick. */
  private published: PublishedLinks = { model: this.model, linkAt: this.linkAt, oneWay: this.oneWay, lines: this.lines, dirty: this.dirty };

  /** The roads meeting at `node` (distinct segments). */
  private roadsAt(node: number): number {
    return Math.floor((this.nodes.get(node) ?? 0) / ROAD);
  }

  private flagged(node: number, flag: number): boolean {
    return ((this.nodes.get(node) ?? 0) & flag) !== 0;
  }

  private flag(node: number, flag: number): void {
    this.nodes.set(node, (this.nodes.get(node) ?? 0) | flag);
    this.nodesChanged++;
  }

  /** A road more or fewer at `node`; with none left, the node's flags go with it. */
  private addRoads(node: number, d: number): void {
    const v = (this.nodes.get(node) ?? 0) + d * ROAD;
    if (v < ROAD) this.nodes.delete(node); else this.nodes.set(node, v);
    this.nodesChanged++;
  }

  /** Whether a placed slot of `segment` leaves or reaches `node`. */
  private segmentAt(node: number, segment: number): boolean {
    for (const t of [this.outAt, this.inAt]) {
      for (let s = t.head(t.group(node)); s >= 0; s = t.after(s)) if (this.endSeg[s] === segment) return true;
    }
    return false;
  }

  /** A slot's road filed at its nodes (the joins, the turns). */
  private placeEnds(slot: number, from: number, to: number, segment: number): void {
    if (this.placed[slot] === 1 && this.endFrom[slot] === from && this.endTo[slot] === to && this.endSeg[slot] === segment) return;
    if (this.placed[slot]) this.unplaceEnds(slot);
    const newFrom = !this.segmentAt(from, segment);
    const newTo = to !== from && !this.segmentAt(to, segment);
    this.endFrom[slot] = from;
    this.endTo[slot] = to;
    this.endSeg[slot] = segment;
    this.placed[slot] = 1;
    this.nodesChanged++;
    this.outAt.add(slot, from);
    this.inAt.add(slot, to);
    if (newFrom) this.addRoads(from, 1);
    if (newTo) this.addRoads(to, 1);
    this.touchedNodes.add(from);
    this.touchedNodes.add(to);
  }

  private unplaceEnds(slot: number): void {
    const from = this.endFrom[slot]!, to = this.endTo[slot]!, segment = this.endSeg[slot]!;
    this.placed[slot] = 0;
    this.nodesChanged++;
    this.outAt.remove(slot);
    this.inAt.remove(slot);
    if (!this.segmentAt(from, segment)) this.addRoads(from, -1);
    if (to !== from && !this.segmentAt(to, segment)) this.addRoads(to, -1);
    this.touchedNodes.add(from);
    this.touchedNodes.add(to);
  }

  /** A slot's place: its middle filed for the window, its demand cell, its line (start, middle, end) for the page. */
  private placeLine(slot: number, line: readonly number[], oneWay: boolean): void {
    const x = line[2]!, y = line[3]!;
    this.mid[2 * slot] = x;
    this.mid[2 * slot + 1] = y;
    this.cellOf[slot] = this.demand.cellOf(x, y);
    this.cells.add(slot, cellOfPoint(x, y));
    for (let k = 0; k < 6; k++) this.lines[slot * 6 + k] = line[k]!;
    this.oneWay[slot] = oneWay ? 1 : 0;
    this.dirty[slot] = 1;
  }

  /** A link gone from the world: what was on it leaves the model, its slot free. */
  private dropSlot(slot: number): void {
    // Its micro cars went with the road: what was handed to it and not made is the model's again, and goes with the link.
    if (this.model.isInside(slot)) this.model.leaveWindow(slot, 0);
    if (this.placed[slot]) this.unplaceEnds(slot);
    this.model.dropLink(slot);
    this.cells.remove(slot);
    this.pendingSlots.delete(slot);
    this.fill.delete(slot);
    if (this.inside.delete(slot)) this.windowMoves++;
    this.dirty[slot] = 0;
    const link = this.linkAt[slot]!;
    if (!Number.isNaN(link)) this.index.delete(link);
    this.linkAt[slot] = Number.NaN;
    this.freeSlots.push(slot);
  }

  // ------------------------------------------------------------ the links, by the document, and the turns, by the lane graph

  /** DO NOT read every road of the map for an edit: only those the network's changes name; nor the lanes of the map: only the graph's changes, for the turns. */
  private sync(w: SimWorld): void {
    const net = w.net;
    if (this.netSeen !== net.state) {
      const delta = this.netSeen === null ? null : net.changesSince(this.netSeen);
      this.netSeen = net.state;
      // The land use of the hour, for the new links' first cars (`relink`).
      this.demand.sync(w.buildings, w.doc.changes);
      this.demand.atHour((w.city.minutes(w) % 1440) / 60);
      if (delta === null) this.relinkAll(w);
      else {
        // A road, and every road at a node that changed (its line, its end, the roads meeting there).
        const segments = new Set<number>(delta.segments);
        for (const node of delta.nodes) for (const seg of w.doc.node(node)?.incident ?? []) segments.add(seg);
        for (const seg of [...segments].sort((a, b) => a - b)) this.relink(w, seg as SegmentId);
      }
    }
    if (this.graphSeen !== w.topologyLog.state) {
      const changes = w.topologyLog.since(this.graphSeen);
      this.graphSeen = w.topologyLog.state;
      if (changes === null) {
        // @rebuild The lane graph built whole: every link's turns, and whether each has its lanes.
        for (const node of this.nodes.keys()) this.touchedNodes.add(node);
        for (let slot = 0; slot < this.slotTop; slot++) if (this.model.has(slot)) this.refreshInside(w, slot);
      } else {
        for (const change of changes) {
          for (const node of change.junctions) this.touchedNodes.add(node);
          // A road whose lanes came or went: its links' cars are the micro simulation's while the window holds them.
          for (const seg of change.segments) {
            for (const dir of [0, 1] as const) {
              const slot = this.slotOfLink(linkId(seg, dir));
              if (slot !== undefined) this.refreshInside(w, slot);
            }
          }
        }
      }
    }
  }

  /** @rebuild Every road of the document, and every link whose road is gone. */
  private relinkAll(w: SimWorld): void {
    for (let slot = 0; slot < this.slotTop; slot++) {
      const link = this.linkAt[slot]!;
      if (!Number.isNaN(link) && !w.doc.segment(linkSegment(link) as SegmentId)) this.dropSlot(slot);
    }
    for (const seg of [...w.doc.segments.keys()].sort((a, b) => a - b)) this.relink(w, seg);
  }

  /** One road's two links made again from the document; a way it carries nothing goes. */
  private relink(w: SimWorld, segId: SegmentId): void {
    const seg = w.doc.segment(segId);
    for (const dir of [0, 1] as const) {
      const link = linkId(segId, dir);
      const spec = seg ? linkSpec(w, seg, dir === 0) : null;
      if (!spec) {
        const had = this.index.get(link);
        if (had >= 0) this.dropSlot(had);
        continue;
      }
      const slot = this.slotFor(link);
      this.placeEnds(slot, spec.from, spec.to, segId);
      const a = w.doc.requireNode(seg!.a), b = w.doc.requireNode(seg!.b);
      for (const end of [a, b]) if (end.end === 'bulb') this.flag(end.id, BULB);
      const line = segmentLine({ x: a.x, y: a.y }, { x: b.x, y: b.y }, seg!.curve);
      const mid = line.sampleAt(line.length / 2).p;
      this.placeLine(slot, [a.x, a.y, mid.x, mid.y, b.x, b.y], seg!.direction !== 'both');
      this.setSpec(slot, spec);
      this.refreshInside(w, slot);
    }
  }

  /** A slot inside the window while its middle is in it and the graph holds its lanes (the cars are made on them). */
  private refreshInside(w: SimWorld, slot: number): void {
    if (!this.model.has(slot)) return;
    const inside = this.inWindow(this.mid[2 * slot]!, this.mid[2 * slot + 1]!) && this.hasLanes(w, slot);
    if (inside && !this.model.isInside(slot)) this.enter(slot);
    else if (!inside && this.model.isInside(slot)) this.leave(w, slot);
  }

  // ------------------------------------------------------------ the numbers and the turns

  /** A node where the world ends: one road, not a turning circle (`RoadDoc.mapEdge`). */
  private readonly edgeAt = (node: number): boolean => this.roadsAt(node) === 1 && !this.flagged(node, BULB);

  /** A live slot's numbers from the document (`linkSpec`); its exit over the roads met at its end. */
  private setSpec(slot: number, spec: LinkSpec): void {
    const had = this.model.has(slot);
    this.model.setLink(slot, { to: spec.to, lanes: spec.lanes, length: spec.length, vFree: spec.vFree, controlled: spec.controlled, exit: this.edgeAt(spec.to) });
    if (!had) {
      // A slot taken again starts with no trips of the link it held before: its rates come with the next step's (`ratesIn`).
      this.model.setGeneration(slot, 0);
      this.model.setSinkShare(slot, 0);
      this.seedNew(slot, spec.length);
    }
  }

  /** A slot's numbers read again off the document (its end's roads changed: `settle`). */
  private respec(w: SimWorld, slot: number): void {
    if (!this.placed[slot]) return;
    const seg = w.doc.segment(this.endSeg[slot]! as SegmentId);
    const spec = seg ? linkSpec(w, seg, seg.a === this.endFrom[slot]) : null;
    if (spec) this.setSpec(slot, spec); else this.dropSlot(slot);
  }

  /** A new link starts as a street of its land use stands at this hour (in free flow): the map is full from its first step. */
  private seedNew(slot: number, length: number): void {
    const n = this.demand.carsPer100m(this.cellOf[slot]!) * (length / m(100)) * this.scale;
    if (n > 0) this.model.seed(slot, n);
  }

  /** The demand's scale, as the simulation last set it (`step`). */
  private scale = 1;

  /** The links whose ends' roads changed: their exits and signals, and their turns, worked out again. */
  private settle(w: SimWorld): void {
    if (!this.touchedNodes.size) return;
    const nodes = this.touchedNodes;
    this.touchedNodes = new Set();
    const ins = new Set<number>();
    for (const node of nodes) for (const i of this.model.inLinks(node)) ins.add(i);
    for (const i of ins) this.respec(w, i);
    for (const i of ins) this.returns(w, i);
  }

  /** A link's turns: the links its lanes' movements lead onto (weighted by how many) where the window holds them; by the roads' lanes elsewhere; a U-turn only when nothing else. */
  private returns(w: SimWorld, slot: number): void {
    if (!this.model.has(slot)) return;
    const node = this.model.toAt(slot);
    const outs = this.outAt.list(node).filter((o) => this.model.has(o));
    const lanes = this.lanesOf(w, slot);
    const back = this.index.get(reverseLink(this.linkAt[slot]!));
    const weight = new Map<number, number>();
    if (lanes.length && outs.every((o) => this.hasLanes(w, o))) {
      for (const id of lanes) {
        for (const cid of w.graph.exitsOf(id)) {
          const c = w.connector(cid);
          const j = c ? this.slotOfLane(w, c.toLane) : undefined;
          if (j === undefined) continue;
          weight.set(j, (weight.get(j) ?? 0) + 1);
        }
      }
    } else {
      for (const o of outs) weight.set(o, this.model.lanesAt(o));
    }
    if (weight.size > 1 && back >= 0) weight.delete(back);
    const to = [...weight.keys()].sort((a, b) => a - b);
    this.model.setTurns(slot, to, to.map((j) => weight.get(j)!));
  }

  // ------------------------------------------------------------ the micro window

  /** Whether a point is inside the micro window as it stands (its links' cars are the micro simulation's), the window grown by `pad`. */
  insideWindow(x: number, y: number, pad = 0): boolean {
    return this.inWindow(x, y, pad);
  }

  private inWindow(x: number, y: number, pad = 0): boolean {
    const win = this.micro;
    return win.r > 0 && Math.hypot(x - win.x, y - win.y) < win.r + pad;
  }

  /** The slots whose middle is in the rectangle, by the cells it covers, added to `out`. */
  private slotsIn(x0: number, y0: number, x1: number, y1: number, out: Set<number>): void {
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL), cy0 = Math.floor(y0 / CELL), cy1 = Math.floor(y1 / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cells = this.cells;
        for (let s = cells.head(cells.group((cx + 32768) * 65536 + (cy + 32768))); s >= 0; s = cells.after(s)) {
          const x = this.mid[2 * s]!, y = this.mid[2 * s + 1]!;
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.add(s);
        }
      }
    }
  }

  /** DO NOT look at every link of the map: only those filed where the window was or will be. */
  private moveWindow(w: SimWorld, to: { readonly x: number; readonly y: number; readonly r: number }): void {
    this.wanted = null;
    const was = this.micro;
    const look = new Set<number>();
    if (was.r > 0) this.slotsIn(was.x - was.r, was.y - was.r, was.x + was.r, was.y + was.r, look);
    if (to.r > 0) this.slotsIn(to.x - to.r, to.y - to.r, to.x + to.r, to.y + to.r, look);
    this.micro = { x: to.x, y: to.y, r: to.r };
    this.windowMoves++;
    for (const slot of [...look].sort((a, b) => a - b)) this.refreshInside(w, slot);
  }

  /** A link comes into the window: its cars are to be made along it. */
  private enter(slot: number): void {
    const n = this.model.enterWindow(slot);
    this.inside.add(slot);
    this.windowMoves++;
    if (n <= 0) return;
    this.fill.set(slot, Math.floor(n));
    this.pendingSlots.add(slot);
  }

  /** A link leaves the window: the micro simulation's cars on it (those the meso made) taken off and counted on it again; `taken`: cars taken off it already (`takeBackFrom`). */
  private leave(w: SimWorld, slot: number, taken = 0): void {
    let k = taken;
    for (const id of this.lanesOf(w, slot)) {
      for (const vid of [...w.rt(id).order]) {
        const v = w.vehicles.get(vid);
        if (!v || !this.owned.has(vid) || v.lanelet !== id) continue;
        w.removeVehicle(v);
        this.owned.delete(vid);
        k++;
      }
    }
    this.pendingSlots.delete(slot);
    this.fill.delete(slot);
    this.inside.delete(slot);
    this.windowMoves++;
    this.model.leaveWindow(slot, k);
  }

  /** Window moves and links in or out of it (`handoffLanes` found again after one). */
  private windowMoves = 0;
  private handoffAt = -1;
  private handoffNodes = -1;
  private handoffGraph: object | null = null;
  private handoff: LaneletId[] = [];

  /**
   * The lanes just outside the window that a road out of it leads onto: where a micro car of the meso is handed back (`takeBack`).
   * Found from the window's own links (those inside, the roads out of their end nodes), never from the map's: the cost follows the
   * window's size, not the city's.
   */
  handoffLanes(w: SimWorld): readonly LaneletId[] {
    if (this.handoffAt === this.windowMoves && this.handoffNodes === this.nodesChanged && this.handoffGraph === w.topologyLog.state) return this.handoff;
    this.handoffAt = this.windowMoves;
    this.handoffNodes = this.nodesChanged;
    this.handoffGraph = w.topologyLog.state;
    const slots = new Set<number>();
    for (const s of this.inside) {
      if (!this.model.has(s)) continue;
      const outs = this.outAt;
      for (let o = outs.head(outs.group(this.model.toAt(s))); o >= 0; o = outs.after(o)) {
        if (this.model.has(o) && !this.model.isInside(o)) slots.add(o);
      }
    }
    const lanes: LaneletId[] = [];
    for (const o of [...slots].sort((a, b) => a - b)) lanes.push(...this.lanesOf(w, o));
    this.handoff = lanes;
    return lanes;
  }

  /**
   * DO NOT send a car of the meso to a random exit of the whole map (`chooseVehicleDestination`): its trip in the micro simulation
   * ends where it leaves the window, so its goal is a lane just past the window's edge (`handoffLanes`) - its search bounded by the
   * window. Null: none it may reach (its lookahead drives it, and the edge takes it back all the same).
   */
  readonly handoffDestination = (w: SimWorld, start: LaneletId, body: BodyClass): LaneletId | null => {
    const lanes = this.handoffLanes(w);
    if (!lanes.length) return null;
    const rng = w.rng.meso;
    for (let k = 0; k < HANDOFF_TRIES; k++) {
      const goal = lanes[rng.int(0, lanes.length - 1)]!;
      if (goal === start || !w.graph.lanelets.has(goal) || w.rt(goal).ghost) continue;
      if (w.laneReaches.mayReach(w, start, goal, body)) return goal;
    }
    return null;
  };

  /** The cars handed to the window made, a few a tick (as the edge entries admit them), up to the fleet the machine carries and the tick's trip searches. */
  private admit(w: SimWorld): void {
    if (!this.pendingSlots.size) return;
    const ceiling = Math.floor(FLEET_CEILING * w.populationShare);
    const rng = w.rng.meso;
    let tries = ADMIT_PER_TICK;
    for (const slot of this.pendingSlots) {
      if (tries <= 0 || w.vehicles.size >= ceiling) return;
      if (!this.model.isInside(slot)) { this.pendingSlots.delete(slot); this.fill.delete(slot); continue; }
      // The graph does not hold its lanes yet (the window moving onto them): its cars wait.
      const lanes = this.lanesOf(w, slot);
      if (!lanes.length) continue;
      while (tries > 0 && this.model.pending(slot) >= 1 && w.vehicles.size < ceiling) {
        // A new car's trip search waits for the next tick past the tick's budget: its slot keeps its place (Aimsun's entry retried at the next step).
        if (!mayRequestSearch(w)) return;
        tries--;
        const lane = w.lanelet(lanes[rng.int(0, lanes.length - 1)]!);
        if (!lane) break;
        const arch = rng.weighted(TRAFFIC);
        const spread = (this.fill.get(slot) ?? 0) > 0;
        const room = lane.length - arch.length - m(0.8);
        if (room <= 0) break;
        const s = spread ? arch.length + m(0.4) + rng.float() * room : Math.min(lane.length - m(0.4), arch.length + ENTRY_CLEARANCE);
        const id = spawnVehicleAt(w, lane.id, s, arch, this.handoffDestination);
        if (id === null) break;
        this.owned.add(id);
        this.model.takePending(slot, 1);
        if (spread) this.fill.set(slot, this.fill.get(slot)! - 1);
      }
      if (this.model.pending(slot) < 1) { this.pendingSlots.delete(slot); this.fill.delete(slot); }
    }
  }

  /** Whoever drove out of the window onto a link of the meso (its own cars, the lots' and the works' too; the buses are their timetable's): taken off the micro simulation onto the link they reached. */
  private takeBack(w: SimWorld): void {
    for (const id of [...w.occupied]) {
      const slot = this.slotOfLane(w, id);
      if (slot === undefined || !this.model.has(slot) || this.model.isInside(slot)) continue;
      for (const vid of [...w.rt(id).order]) {
        const v = w.vehicles.get(vid);
        if (!v || v.free || v.lanelet !== id || v.archetype.shape === 'bus') continue;
        w.removeVehicle(v);
        this.owned.delete(vid);
        this.model.microExit(slot);
      }
    }
    for (const id of this.owned) if (!w.vehicles.has(id as never)) this.owned.delete(id);
  }

  /** The micro simulation's vehicles on each link inside the window (all of them: buses and the lots' cars take room too). */
  private countMicro(w: SimWorld): void {
    for (const slot of this.counted) this.model.setMicro(slot, 0);
    const counts = new Map<number, number>();
    for (const id of w.occupied) {
      const slot = this.slotOfLane(w, id);
      if (slot === undefined || !this.model.isInside(slot)) continue;
      counts.set(slot, (counts.get(slot) ?? 0) + w.rt(id).order.length);
    }
    this.counted = [...counts.keys()];
    for (const [slot, n] of counts) this.model.setMicro(slot, n);
  }

  // ------------------------------------------------------------ the step's work, spread over ticks

  /** A step begun: the window's cars counted (bounded by the window), the demand of the hour read once a cell. */
  private begin(w: SimWorld): void {
    this.takeBack(w);
    this.countMicro(w);
    this.demand.sync(w.buildings, w.doc.changes);
    this.demand.atHour((w.city.minutes(w) % 1440) / 60);
    this.rates.readCells(this.demand);
    this.job = RATES;
    this.cursor = 0;
  }

  /** Up to `budget` links of the step's work: the rates, then the model's phases, then the publish. */
  private work(w: SimWorld, budget: number): void {
    let left = budget;
    while (left > 0 && this.job !== IDLE) {
      if (this.job === RATES) {
        const end = Math.min(this.model.slots, this.cursor + left);
        this.rates.ratesIn(this.model, this.cursor, end, this.cellOf, this.placed, this.endFrom, this.edgeAt, this.nodesChanged, this.scale);
        left -= end - this.cursor;
        this.cursor = end;
        if (end >= this.model.slots) this.job = MODEL;
      } else if (this.job === MODEL) {
        left = this.model.stepSome(left);
        if (this.model.stepping) continue;
        // DO NOT make only the cars handed when a link came into the window: those that drove in since are made too.
        for (const slot of this.model.handed) this.pendingSlots.add(slot);
        this.job = PUBLISH;
        this.cursor = 0;
        this.publisher.begin();
      } else {
        const end = Math.min(this.model.slots, this.cursor + left);
        this.publisher.publishIn(this.cursor, end, this.published);
        left -= end - this.cursor;
        this.cursor = end;
        if (end < this.model.slots) continue;
        this.publisher.end(this.model.slots, w.clock.time, this.micro.x, this.micro.y, this.micro.r);
        this.job = IDLE;
      }
    }
  }

  /** The rates of the links (`mesoRates.ts`), and the node map's change (`nodesChanged`, bumped by every change of `nodes` and every slot placed or let go). */
  private readonly rates = new MesoRates();
  private nodesChanged = 1;
}
