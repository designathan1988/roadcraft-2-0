import { Box3, type BufferAttribute, type Camera, type Frustum, type InterleavedBuffer } from 'three';

import type { ChangeJournal, ChangeRect } from '@world/changes';
import type { PoleId, SegmentId, SpanId } from '@world/ids';
import { tilesMeeting } from '@world/networkWindow';
import { acrossJunction, lineEnd } from '@world/lineEnds';
import type { Network } from '@world/network';
import { m } from '@world/units';
import type { PoleArms, UtilityPole, UtilitySpan } from '@world/utilities';
import { ViewCells, type CellKey } from '@world/viewCells';
import type { KeptFrustum } from './cellInstances';
import { gpuOnlyAttributes } from './mesh/gpuOnly';
import { framePole, wireEnd } from './poleBake';
import { BLOCK, type Block, POLE_REACH, ViewedRoot, docPoles } from './poleLayer';
import { PartStore, ScreenScale, WireStore, screen } from './poleStores';
import type { SceneryKit } from './scenery';
import { POLE_PART_COUNT, type Placement, type PolePartSpec, type SpanEnd, type Utilities, placePole, polePartSpecs, wireScreen } from './utilities';

/** What moves a pole or its parts: the poles and wires, the roads (its kerb), the roads' heights and the ground under it. */
const POLE_CHANGES = ['utilities', 'roads', 'elevation', 'ground', 'terrain'] as const;
/** How far a change reaches a block's things: a pole within `POLE_REACH` of it reframed, and every span strung to it, up to the longest a span may run (`doc.ts` SPAN_REACH). */
const SPAN_REACH = m(200);
/** How far off the view a pole's shadow still falls into it. */
const POLE_SHADOW_REACH = m(40);
/** A block in the shadow pass: how deep the ground may be, how high a pole stands over it. */
const POLE_LOW = m(-200), POLE_HIGH = m(600);
/** A held block's own objects besides its arrays. */
const BLOCK_OVERHEAD = 4096;

/** A block of the view's poles: its parts and wires, their buffers not yet on the GPU. */
interface HeldBlock {
  readonly block: Block;
  waiting: number;
  /** Framed while a tile round it was not held by the network (`networkWindow.ts`): its poles' kerbs not all known. */
  readonly partial: boolean;
}

/** How far from a pole its kerb is looked for (`framePole`, `kerbward`): the tiles round a block it may reach into. */
const KERB_REACH = m(6);

/** What a view reaches on the ground (`propCells.ts` PropView): where from, how far, the ground's height there, its frustum. */
export interface PoleView {
  readonly x: number;
  readonly y: number;
  readonly reach: number;
  readonly ground: number;
  readonly frustum: Frustum;
}

/**
 * THE POLES HELD ROUND THE VIEW (`viewCells.ts`): the document's poles and wires block by block (`BLOCK`), each block made from the
 * document when the view reaches it (a pure function of the block and the document: its poles, the spans strung from them), its
 * matrices and wires let go on the CPU once on the GPU (`mesh/gpuOnly.ts`), dropped when an edit reaches it and made again whole.
 * A block's detail is chosen by its box nearest the eye (more detail than its nearest pole's, never less). DO NOT keep a pole's
 * state, slots and matrices for the whole map: 4,590 poles of the 8,100-building city held 21 MB (2026-10-21).
 */
export class PoleCells implements Utilities {
  readonly group: ViewedRoot;
  readonly cells: ViewCells<HeldBlock>;
  private readonly specs: readonly PolePartSpec[];
  private readonly live = new Set<Block>();
  /** The camera (its matrices, the screen's height) and the lights' brightness the held blocks were last viewed from (`view`). */
  private seenFrom: number[] = [];
  /** The blocks viewed from it. */
  private viewed = new WeakSet<Block>();
  private readonly scale = new ScreenScale();
  private readonly scratch: Placement[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
  private from: { net: Network; groundAt: (x: number, y: number) => number } | null = null;
  private readonly box = new Box3();
  /** The blocks a look wants and their distances, kept from look to look (`look`): DO NOT make a list of objects every frame (75 MB of a
   *  13 s flight over the city, `npm run diagnose`, 2026-10-22). */
  private readonly wantedPool: { key: CellKey; d: number }[] = [];
  private readonly wantedOrder: { key: CellKey; d: number }[] = [];
  private readonly wantedKeys: CellKey[] = [];
  /** Blocks the view wants not made yet. */
  busy = false;

  constructor(kit: SceneryKit, name = 'utilities') {
    this.group = new ViewedRoot((camera) => this.view(camera));
    this.group.name = name;
    this.specs = polePartSpecs(kit);
    this.cells = new ViewCells<HeldBlock>({
      name, version: 1, side: BLOCK, reach: 0, cpuBudget: 16 * 1048576, gpuBudget: 128 * 1048576,
      kinds: POLE_CHANGES, pad: POLE_REACH + SPAN_REACH,
      derive: (key, rect) => this.derive(key, rect),
      release: (_key, held) => this.release(held.block),
    });
  }

  get triangles(): number {
    let triangles = 0;
    for (const block of this.live) for (const part of block.parts) triangles += part.perInstance * part.count;
    return triangles;
  }

  /** The network and the ground the poles are framed on (`poleGroundAt`): a new document drops every block. */
  source(net: Network, groundAt: (x: number, y: number) => number): void {
    if (this.from && this.from.net.doc !== net.doc) this.cells.clear();
    this.from = { net, groundAt };
  }

  /** The network's state the blocks were last brought up to (`Network.changesSince`). */
  private netState: object | null = null;

  /** Whether a tile a block's kerbs may lie in is not held by the network now (a tile's roads come and go whole, its first one asked). */
  private partial(rect: ChangeRect): boolean {
    const net = this.from?.net;
    if (!net || net.scope === null) return false;
    for (const tile of tilesMeeting([rect[0] - KERB_REACH, rect[1] - KERB_REACH, rect[2] + KERB_REACH, rect[3] + KERB_REACH])) {
      for (const id of net.doc.tileRoads(tile).segments) { if (!net.holds(id as SegmentId)) return true; break; }
    }
    return false;
  }

  /** The diary's changes since the last look, and the roads the network came to hold or let go: the blocks they reached dropped, made again as
   *  the view asks. A pole's way to the street is its kerb in the network (`framePole`, `kerbward`), which holds the roads near the view alone
   *  (`networkWindow.ts`). DO NOT keep a block framed before its streets were held: its poles had found the kerb of the street behind the
   *  block or none at all, their lamps turned to the buildings, and kept so as the camera came to them (the player, 2026-10-27). */
  follow(journal: ChangeJournal): void {
    this.cells.follow(journal);
    const net = this.from?.net;
    if (!net) return;
    const delta = this.netState === null ? null : net.changesSince(this.netState);
    this.netState = net.state;
    // The roads held moved: the blocks framed without some of them, where they came or went, framed again. DO NOT drop every block the
    // window's move reached: each is a kilometre of poles, every one's kerb read again, at each tile the camera brings in. An edit's
    // rebuild is the diary's (`follow` above).
    if (!delta?.scopeOnly || !delta.rects.length) return;
    const stale = new Set<CellKey>();
    const pad = POLE_REACH;
    for (const r of delta.rects) {
      this.cells.forCellsOver([r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad], (key) => { if (this.cells.peek(key)?.partial) stale.add(key); });
    }
    if (stale.size) this.cells.forget(stale);
  }

  /** The blocks a view wants (in its reach, in its frustum or the margin round it), nearest first, made while the frame has time (one at least). */
  look(view: PoleView, deadline: number): void {
    if (!this.from) return;
    const wanted = this.wantedOrder;
    wanted.length = 0;
    const reach = view.reach, margin = POLE_SHADOW_REACH;
    const bx0 = Math.floor((view.x - reach) / BLOCK), bx1 = Math.floor((view.x + reach) / BLOCK);
    const by0 = Math.floor((view.y - reach) / BLOCK), by1 = Math.floor((view.y + reach) / BLOCK);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const x0 = bx * BLOCK, y0 = by * BLOCK, x1 = x0 + BLOCK, y1 = y0 + BLOCK;
        const d = Math.hypot(Math.max(x0 - view.x, 0, view.x - x1), Math.max(y0 - view.y, 0, view.y - y1));
        if (d > reach) continue;
        // Three's axes: x east, y up, z south.
        this.box.min.set(x0 - margin, view.ground + POLE_LOW, -(y1 + margin));
        this.box.max.set(x1 + margin, view.ground + POLE_HIGH, -(y0 - margin));
        // Off the frame but under the near cascade (`KeptFrustum.keep`): held, its poles casting there. DO NOT drop a block for leaving the
        // frame: its shadow left the near cascade with it, and came back with it, at every frame of a flight (`utility-poles`, 2026-10-22).
        if (!view.frustum.intersectsBox(this.box) && !(view.frustum as KeptFrustum).keep?.intersectsBox(this.box)) continue;
        const one = this.wantedPool[wanted.length] ?? (this.wantedPool[wanted.length] = { key: 0 as CellKey, d: 0 });
        one.key = this.cells.cellAt(x0 + BLOCK / 2, y0 + BLOCK / 2);
        one.d = d;
        wanted.push(one);
      }
    }
    wanted.sort((a, b) => a.d - b.d || a.key - b.key);
    const keys = this.wantedKeys;
    keys.length = 0;
    for (const w of wanted) keys.push(w.key);
    this.cells.want(keys);
    this.busy = false;
    let first = true;
    for (const key of this.cells.wantedKeys) {
      if (this.cells.has(key)) continue;
      if (!first && performance.now() > deadline) { this.busy = true; break; }
      this.cells.ensure(key);
      first = false;
    }
    this.cells.trim(null);
  }

  /** A block made from the document, its buffers let go once on the GPU (and given back after a lost context: the block made again). */
  private derive(key: CellKey, rect: ChangeRect): { value: HeldBlock; cpuBytes: number } {
    const block = this.build(rect);
    const held: HeldBlock = { block, waiting: 0, partial: this.partial(rect) };
    const buffers: (BufferAttribute | InterleavedBuffer)[] = [];
    // The parts' matrices stay on the page (tens of KB a block): the sun's shadow stores are drawn again under each pole that came, went or moved (`renderer.ts` casterChanges reads the matrices), not thrown away for a block of a kilometre coming into view. The wires' instances go to the GPU alone.
    for (const part of block.parts) {
      const matrices = part.seal();
      if (matrices) buffers.push(matrices);
    }
    const wires = block.wires.seal();
    if (wires) {
      buffers.push(wires);
      gpuOnlyAttributes(block.wires.drawn!, { wires }, () => {
        const again = this.build(rect);
        const array = again.wires.instances;
        this.release(again);
        return { wires: array };
      });
    }
    let bytes = 0;
    const cells = this.cells;
    for (const buffer of buffers) {
      bytes += (buffer.array as Float32Array).byteLength;
      held.waiting++;
      const letGo = buffer.onUploadCallback;
      let sent = false;
      buffer.onUpload(function (this: BufferAttribute | InterleavedBuffer) {
        letGo.call(this);
        if (sent) return;
        sent = true;
        // Every buffer of the block on the GPU: what it holds is the GPU's now.
        if (--held.waiting === 0) cells.account(key, BLOCK_OVERHEAD, bytes);
      });
    }
    this.live.add(block);
    return { value: held, cpuBytes: bytes + BLOCK_OVERHEAD };
  }

  /** A block's stores filled from the document: the poles standing in `rect` (its own, filed as `blockKey` files them) and the spans strung from them. */
  private build(rect: ChangeRect): Block {
    const { net, groundAt } = this.from!;
    const doc = net.doc;
    const source = docPoles(doc);
    const block: Block = { parts: this.specs.map((spec) => new PartStore(spec, this.group)), wires: new WireStore(this.group), poles: new Set() };
    type Framed = { x: number; y: number; top: number; kerb: { x: number; y: number } | null; frame: PoleArms };
    const frames = new Map<PoleId, Framed>();
    const frameOf = (pole: UtilityPole): Framed => {
      let framed = frames.get(pole.id);
      if (!framed) {
        const { top, kerb, frame } = framePole(net, groundAt, source, pole, undefined);
        frames.set(pole.id, framed = { x: pole.x, y: pole.y, top, kerb, frame });
      }
      return framed;
    };
    const bx = Math.round(rect[0] / BLOCK), by = Math.round(rect[1] / BLOCK);
    const out = this.scratch;
    const own: UtilityPole[] = [];
    for (const pole of doc.polesIn(rect)) {
      if (Math.floor(pole.x / BLOCK) !== bx || Math.floor(pole.y / BLOCK) !== by) continue;
      own.push(pole);
      const framed = frameOf(pole);
      for (const list of out) list.length = 0;
      placePole(pole, framed.top, framed.frame, framed.kerb, groundAt, out);
      out.forEach((list, part) => { for (const placement of list) block.parts[part]!.add(pole.id, placement); });
    }
    for (const pole of own) {
      for (const span of doc.spansAt(pole.id)) {
        if (span.a !== pole.id) continue;
        const other = doc.poles.get(span.b);
        if (!other) continue;
        block.wires.add(span, wireEnd(span, frameOf(pole), pole.kind), wireEnd(span, frameOf(other), other.kind));
      }
      // Its line carried across the junction it stops at (`lineEnds.ts`): drawn by the block of the lower pole, each end's arm its line's.
      const across = acrossJunction(doc, pole.id);
      const other = across && across.id > pole.id ? doc.poles.get(across.id) : undefined;
      const mine = other ? lineEnd(doc, pole.id) : null;
      if (other && mine) {
        const strung: UtilitySpan = { id: -1 as SpanId, a: pole.id, b: other.id };
        const end = (at: UtilityPole, line: SpanId): SpanEnd => {
          const framed = frameOf(at);
          return wireEnd({ ...strung, id: line }, framed, at.kind);
        };
        block.wires.add(strung, end(pole, mine.span), end(other, across!.span));
      }
    }
    for (const part of block.parts) part.flush();
    block.wires.flush();
    return block;
  }

  private release(block: Block): void {
    for (const part of block.parts) part.dispose();
    block.wires.dispose();
    this.live.delete(block);
  }

  /** Each held block's nearest corner as this camera sees it, each time three draws the layer: what its parts fade and coarsen by. A camera that
   *  has not moved since the last view sees every piece as it did: only the blocks made since are viewed. DO NOT view every piece of every
   *  held block at every draw of a still view: it was the most of a street's frame (1.35 s of the city tour's 3.8 min in `PoleStore.view`, the
   *  lab's tour, 2026-10-27). */
  private view(camera: Camera): void {
    const seen = this.seenFrom;
    // A light's pieces are shown by its brightness too (dusk lights them): a change of it is a new view.
    const brightness = new Set<number>();
    for (const block of this.live) for (const part of block.parts) brightness.add(part.brightness);
    const now = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, screen.halfHeight, ...[...brightness].sort((a, b) => a - b)];
    const still = seen.length === now.length && now.every((v, i) => v === seen[i]);
    if (!still) { this.seenFrom = now; this.viewed = new WeakSet(); }
    this.scale.set(camera);
    wireScreen.uWirePixels.value = screen.halfHeight;
    for (const block of this.live) {
      if (still && this.viewed.has(block)) continue;
      this.viewed.add(block);
      let nearest = -Infinity;
      for (const part of block.parts) if (part.count > 0) nearest = Math.max(nearest, this.scale.atBox(part.box));
      if (block.wires.count > 0) nearest = Math.max(nearest, this.scale.atBox(block.wires.box));
      for (const part of block.parts) part.view(this.scale);
      block.wires.view(this.scale, nearest);
    }
  }

  dispose(): void {
    this.cells.clear();
    this.group.clear();
  }
}
