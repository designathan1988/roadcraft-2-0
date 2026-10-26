import type { ChangeRect } from './changes';
import { type RoadDoc, type SerializedDoc, savedNode, savedSegment } from './doc';
import type { NodeId, SegmentId } from './ids';
import type { Network, NetworkBake } from './network';
import { TILE, tileIJ, tileKey, tileOfKey } from './tiles';

/**
 * THE ROADS THE PAGE'S NETWORK HOLDS: THE TILES NEAR THE VIEW (`Network.scope`), NEVER THE MAP. The view's road cells (`mesh/roadResidency.ts`:
 * the cells it builds in detail, under the tier's budget), the simulation's micro window and the tile under the pointer name the tiles
 * wanted (`want`, `wantAlso`); a tile that comes has its junctions and ribbons solved off the page (`roadBake.worker.ts`, `RoadBakeSource`)
 * and is held once they land (`step`, one rebuild of the network at most a frame), a tile no longer wanted leaves at that same rebuild. An
 * edit's tools read the roads where the pointer is, held or not (`ensure`: a tile the page solves itself, now). DO NOT hold a 10 km city's
 * every junction and ribbon on the page for the street in view: the page died of it (2026-10-26). The whole map's far level and a map's
 * opening are solved off the page too (`networkBake.worker.ts`), the page taking only its tiles' (`open`).
 *
 * A tile's roads are those the document files in it (`RoadDoc.tileRoads`: a road is its tile's by the middle of its ends) and every road at
 * their ends (`roadsOfTiles`): every node of a tile's roads has all its legs, so its junction is the whole network's, and a road out of the
 * tile is there whole, trimmed at the tile's end alone.
 */

/** A tile's roads asked solved off the page (`roadBake.worker.ts`): the records the solve reads, the roads held there, the junctions and ribbons wanted back. */
export interface RoadBakeAsk {
  readonly nodes: SerializedDoc['nodes'];
  readonly segments: SerializedDoc['segments'];
  readonly markingStyle: string;
  readonly scope: readonly SegmentId[];
  readonly bakeNodes: readonly NodeId[];
  readonly bakeSegments: readonly SegmentId[];
  /** Where the roads stand: the nearest the view first (`jobPool.ts` `JobSpec.at`). */
  readonly at: readonly [number, number];
}

/** Who solves a tile's roads off the page; null when the page solves them itself (no job worker: the tests). */
export type RoadBakeSource = (ask: RoadBakeAsk) => Promise<NetworkBake | null>;

/** How long a tile an edit's tool pulled in (`ensure`, `wantAlso`) stays held past the view's own tiles, ms: a tool hovering the same far place does not solve its tile again and again. */
const ALSO_KEPT_MS = 5_000;
/** Tiles asked off the page at once: the nearest first, the rest as they answer. */
const ASKED_AT_ONCE = 4;

/** The keys of the tiles a rectangle meets. */
export function tilesMeeting(rect: ChangeRect, into: Set<number> = new Set()): Set<number> {
  const lo = tileIJ(rect[0], rect[1]), hi = tileIJ(rect[2], rect[3]);
  for (let i = lo.i; i <= hi.i; i++) for (let j = lo.j; j <= hi.j; j++) into.add(tileKey(i, j));
  return into;
}

/** The keys of the tiles a circle meets (its square: a tile touched by the square and not the circle is held a little early, never late). */
export function tilesRound(x: number, y: number, r: number, into: Set<number> = new Set()): Set<number> {
  return tilesMeeting([x - r, y - r, x + r, y + r], into);
}

/** The roads of `tiles` (the document's filing) and every road at their ends. */
export function roadsOfTiles(doc: RoadDoc, tiles: Iterable<number>): Set<SegmentId> {
  const inside = new Set<SegmentId>();
  for (const key of tiles) for (const id of doc.tileRoads(key).segments) if (doc.segment(id as SegmentId)) inside.add(id as SegmentId);
  const out = new Set(inside);
  for (const id of inside) {
    const seg = doc.segment(id)!;
    for (const node of [seg.a, seg.b]) for (const other of doc.node(node)?.incident ?? []) out.add(other);
  }
  return out;
}

/** A tile's bake landed, or failed (null: the page solves the tile itself). */
interface Landed { readonly tile: number; readonly bake: NetworkBake | null }

export class NetworkWindow {
  /** The tiles held by the network now. */
  private readonly held = new Set<number>();
  /** The tiles the view wants (`want`). */
  private wanted = new Set<number>();
  /** The tiles a tool wants besides (`wantAlso`, `ensure`), each with when it was last asked for. */
  private readonly also = new Map<number, number>();
  /** The tiles asked off the page, not answered. */
  private readonly asked = new Set<number>();
  /** The tiles answered, not held yet (`step` takes them). */
  private landed: Landed[] = [];
  /** A rebuild under way (`rescope`): nothing re-enters it. */
  private rescoping = false;

  constructor(private readonly doc: RoadDoc, readonly net: Network, private readonly bakes: RoadBakeSource | null, private readonly now: () => number = () => performance.now()) {
    // A rebuild of the whole (a map put in place of this one) finds the roads held again over the map as it stands: the tiles held, their roads then.
    net.scopeOf = () => roadsOfTiles(doc, this.held);
  }

  /** The tiles held now, read only. */
  get tiles(): ReadonlySet<number> {
    return this.held;
  }

  /** Whether a tile's roads are held (`Network.scope`). */
  holds(tile: number): boolean {
    return this.held.has(tile);
  }

  /** A map about to be put in place (`restoreInto`, whose rebuild from nothing builds the roads held, found over the new map by `Network.scopeOf`): these tiles held, nothing else of the window kept. */
  open(tiles: Iterable<number>): void {
    this.held.clear();
    this.wanted.clear();
    this.also.clear();
    this.asked.clear();
    this.landed = [];
    for (const key of tiles) this.held.add(key);
    // Over the map as it stands now: a map put in place after this has them found again (`scopeOf`).
    this.net.scope = roadsOfTiles(this.doc, this.held);
  }

  /** `tiles` held now, whatever the view wants: those not held solved here (a map's opening cells, `renderer.ts` buildWorld; a tool's reach, `ensure`). */
  ensureTiles(tiles: Iterable<number>): void {
    if (this.rescoping) return;
    let missing = false;
    for (const key of tiles) if (!this.held.has(key)) { this.held.add(key); missing = true; }
    if (missing) this.rescope();
  }

  /** The tiles the view wants held (its road cells', the micro window's): those not held are asked off the page; those held and not wanted go at the next `step`. */
  want(tiles: ReadonlySet<number>): void {
    this.wanted = new Set(tiles);
  }

  /** Tiles a tool wants besides the view's (the pointer's): kept `ALSO_KEPT_MS` past the last ask. */
  wantAlso(tiles: Iterable<number>): void {
    const at = this.now();
    for (const key of tiles) this.also.set(key, at);
  }

  /** The tiles wanted now: the view's, and a tool's while they are fresh. */
  private wantedNow(): Set<number> {
    const out = new Set(this.wanted);
    const at = this.now();
    for (const [key, asked] of this.also) {
      if (at - asked > ALSO_KEPT_MS) this.also.delete(key); else out.add(key);
    }
    return out;
  }

  /**
   * @rebuild One move of the roads held at most: the tiles whose bakes landed come in (and, with no job worker, the tiles wanted come in solved
   * here), the tiles no longer wanted go; the next tiles wanted asked off the page. Whether the network was rebuilt.
   */
  step(): boolean {
    const wanted = this.wantedNow();
    const coming = new Set<number>();
    for (const { tile, bake } of this.landed.splice(0)) {
      this.asked.delete(tile);
      // Answered after the view moved on: not held for nothing.
      if (!wanted.has(tile) || this.held.has(tile)) continue;
      if (bake) this.net.offerBake(bake);
      coming.add(tile);
    }
    const going = new Set<number>();
    for (const key of this.held) if (!wanted.has(key)) going.add(key);
    if (this.bakes === null) for (const key of wanted) if (!this.held.has(key)) coming.add(key);
    for (const key of coming) this.held.add(key);
    for (const key of going) this.held.delete(key);
    // The next tiles asked once those held are known: a tile just come is never asked again.
    if (this.bakes !== null) this.askNext(wanted);
    if (!coming.size && !going.size) return false;
    this.rescope();
    return true;
  }

  /** The tiles wanted and neither held nor asked, asked off the page, `ASKED_AT_ONCE` in flight. */
  private askNext(wanted: ReadonlySet<number>): void {
    const bakes = this.bakes!;
    for (const key of wanted) {
      if (this.asked.size >= ASKED_AT_ONCE) return;
      if (this.held.has(key) || this.asked.has(key)) continue;
      const ask = this.askOf(key);
      if (!ask) { this.landed.push({ tile: key, bake: null }); continue; }
      this.asked.add(key);
      void bakes(ask).then((bake) => { this.landed.push({ tile: key, bake }); }, () => { this.landed.push({ tile: key, bake: null }); });
    }
  }

  /** What a tile's solve off the page reads: its roads and those at their ends, with every node of theirs; null for a tile with no road. */
  private askOf(tile: number): RoadBakeAsk | null {
    const doc = this.doc;
    const scope = roadsOfTiles(doc, [tile]);
    if (!scope.size) return null;
    const inside = new Set<SegmentId>();
    for (const id of doc.tileRoads(tile).segments) if (doc.segment(id as SegmentId)) inside.add(id as SegmentId);
    const bakeNodes = new Set<NodeId>();
    for (const id of inside) { const seg = doc.segment(id)!; bakeNodes.add(seg.a); bakeNodes.add(seg.b); }
    const nodes = new Set<NodeId>();
    for (const id of scope) { const seg = doc.segment(id)!; nodes.add(seg.a); nodes.add(seg.b); }
    const { i, j } = tileOfKey(tile);
    return {
      nodes: [...nodes].sort((p, q) => p - q).map((id) => savedNode(doc.node(id)!)),
      segments: [...scope].sort((p, q) => p - q).map((id) => savedSegment(doc.segment(id)!)),
      markingStyle: doc.markingStyle,
      scope: [...scope].sort((p, q) => p - q),
      bakeNodes: [...bakeNodes].sort((p, q) => p - q),
      bakeSegments: [...scope].sort((p, q) => p - q),
      at: [(i + 0.5) * TILE, (j + 0.5) * TILE],
    };
  }

  /** The roads an edit's tool reads in `rect` held now, solved here where their tiles are not held (`Network.holdNear`): a tile asked for by hand stays a while (`wantAlso`). */
  ensure(rect: ChangeRect): void {
    const tiles = tilesMeeting(rect);
    this.wantAlso(tiles);
    this.ensureTiles(tiles);
  }

  /** The network rebuilt to hold the tiles held (`Network.rescope`): what came is built (from the bakes offered where their inputs are the same), what left goes. */
  private rescope(): void {
    this.rescoping = true;
    try {
      this.net.rescope(roadsOfTiles(this.doc, this.held));
    } finally {
      this.rescoping = false;
    }
  }
}
