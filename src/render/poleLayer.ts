import { type Camera, LOD } from 'three';

import type { Change, ChangeRect } from '@world/changes';
import type { RoadDoc } from '@world/doc';
import type { PoleId, SpanId } from '@world/ids';
import type { Network } from '@world/network';
import { PoleIndex } from '@world/poleIndex';
import { m } from '@world/units';
import type { PoleArms, PoleKind, UtilityPole, UtilitySpan } from '@world/utilities';
import { type PoleSource, framePole, wireEnd } from './poleBake';
import type { SceneryKit } from './scenery';
import { PartStore, ScreenScale, WireStore, screen } from './poleStores';
import { POLE_PART_COUNT, type Placement, type PolePartSpec, type Utilities, placePole, polePartSpecs, wireScreen } from './utilities';

export type { PoleSource } from './poleBake';

/** DO NOT build the whole layer again for a change; DO NOT pace or hold it. */


/** The document's poles as a layer's source. */
export const docPoles = (doc: RoadDoc): PoleSource => ({ poles: doc.poles, spans: doc.poleSpans, spansAt: (id) => doc.spansAt(id) });

/** How far from a pole a change of the roads or the ground can move it: its kerb (`kerbward`), its lamp's pool. */
export const POLE_REACH = m(12);


interface PoleState {
  /** The block it is drawn in (`blockKey`). */
  readonly block: string;
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly kerb: { x: number; y: number } | null;
  readonly frame: PoleArms;
  readonly kind: PoleKind;
  /** Its slots in each part's mesh (`POLE_PART`). */
  readonly slots: number[][];
}

/** The layer's root: three calls an LOD's `update` with the camera before it draws its children, each time it draws (`WebGLRenderer.projectObject`). */
export class ViewedRoot extends LOD {
  constructor(private readonly onView: (camera: Camera) => void) {
    super();
  }

  override update(camera: Camera): void {
    this.onView(camera);
  }
}

/** THE LAYER IN BLOCKS OF THE PLANE: a store a part and one for the wires in each, so a block out of the view is culled by three and each is drawn at the detail its own nearest pole asks. DO NOT keep one store a part for the whole layer: its bounds were the city's, never culled, and its levels chosen by the pole nearest the eye, every wire, insulator and lamp of a large city drawn at that detail at every frame (26,145 wires of 64 triangles, 3 M triangles at a close view, 2026-10-20). DO NOT make them a world cell (250 m) either: forty meshes a part over a city, drawn. A world tile (`world/tiles.ts` TILE): four world cells a side. */
export const BLOCK = m(1_000);
const blockKey = (x: number, y: number): string => `${Math.floor(x / BLOCK)},${Math.floor(y / BLOCK)}`;

export interface Block {
  readonly parts: PartStore[];
  readonly wires: WireStore;
  /** The poles placed in it here (none for a block of wires only): where it is nearest the eye. */
  readonly poles: Set<PoleId>;
}

export class PoleLayer implements Utilities {
  readonly group: ViewedRoot;
  private readonly specs: readonly PolePartSpec[];
  private readonly blocks = new Map<string, Block>();
  private readonly poles = new Map<PoleId, PoleState>();
  /** Each span strung here, with its block of the plane and its place in that block's wires. */
  private readonly spans = new Map<SpanId, { readonly span: UtilitySpan; readonly key: string; block: number }>();
  /** The poles drawn here by place, and the spans strung to each: what an edit takes away is found here. */
  private readonly index = new PoleIndex();
  private readonly scratch: Placement[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
  private readonly scale = new ScreenScale();

  constructor(kit: SceneryKit, name = 'utilities') {
    this.group = new ViewedRoot((camera) => this.view(camera));
    this.group.name = name;
    this.specs = polePartSpecs(kit);
  }

  /** The block of key `key`, made when first asked. */
  private block(key: string): Block {
    let block = this.blocks.get(key);
    if (!block) {
      block = { parts: this.specs.map((spec) => new PartStore(spec, this.group)), wires: new WireStore(this.group), poles: new Set() };
      this.blocks.set(key, block);
    }
    return block;
  }

  get triangles(): number {
    let triangles = 0;
    for (const block of this.blocks.values()) for (const part of block.parts) triangles += part.perInstance * part.count;
    return triangles;
  }

  /** The poles this layer holds inside a rectangle, where it drew them. */
  polesIn(rect: ChangeRect): PoleId[] {
    return this.index.near(rect).filter((id) => {
      const pole = this.poles.get(id)!;
      return pole.x >= rect[0] && pole.x <= rect[2] && pole.y >= rect[1] && pole.y <= rect[3];
    });
  }

  /** Every pole this layer holds. */
  ids(): IterableIterator<PoleId> {
    return this.poles.keys();
  }

  /** Every pole and span of the source, on an empty layer, in the source's order: the layer a full build makes */
  fill(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource): void {
    for (const pole of source.poles.values()) this.place(net, groundAt, source, pole, undefined);
    for (const span of source.spans.values()) this.string(span);
    this.flush();
  }

  /** These poles placed again as the source has them */
  redo(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource, seeds: Iterable<PoleId>): void {
    const fresh = new Set(seeds);
    const dirty = new Set(fresh);
    for (const id of fresh) {
      for (const sid of this.index.spansAt(id)) { const s = this.spans.get(sid)!.span; dirty.add(s.a === id ? s.b : s.a); }
      if (source.poles.has(id)) for (const s of source.spansAt(id)) dirty.add(s.a === id ? s.b : s.a);
    }
    if (dirty.size === 0) return;
    // The spans reaching them, as strung here and as the source has them.
    const strung = new Set<SpanId>();
    const wanted = new Map<SpanId, UtilitySpan>();
    for (const id of dirty) {
      for (const sid of this.index.spansAt(id)) strung.add(sid);
      if (source.poles.has(id)) for (const s of source.spansAt(id)) wanted.set(s.id, s);
    }
    for (const sid of strung) this.unstring(sid);
    for (const id of dirty) {
      const was = this.poles.get(id);
      if (was) this.unplace(id, was);
      const pole = source.poles.get(id);
      if (pole) this.place(net, groundAt, source, pole, fresh.has(id) || !was || was.x !== pole.x || was.y !== pole.y ? undefined : was.kerb);
    }
    for (const span of wanted.values()) this.string(span);
    this.flush();
  }

  /** The diary's changes since the layer was last brought up (none with a null rectangle: that is a whole build), from `source` (the document's, `docPoles`) */
  follow(net: Network, groundAt: (x: number, y: number) => number, doc: RoadDoc, entries: readonly Change[], source: PoleSource = docPoles(doc)): void {
    const seeds = new Set<PoleId>();
    for (const entry of entries) {
      const pad = entry.kind === 'utilities' ? 0 : POLE_REACH;
      for (const r of entry.rects ?? []) {
        const rect: ChangeRect = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
        for (const pole of doc.polesIn(rect)) {
          if (pole.x >= rect[0] && pole.x <= rect[2] && pole.y >= rect[1] && pole.y <= rect[3]) seeds.add(pole.id);
        }
        for (const id of this.polesIn(rect)) seeds.add(id);
      }
    }
    this.redo(net, groundAt, source, seeds);
  }

  /** A pole framed and its parts placed; its way to the kerb kept from before, or undefined to read it (`kerbward`). */
  private place(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource,
    pole: UtilityPole, kept: { x: number; y: number } | null | undefined): void {
    const { top, kerb, frame } = framePole(net, groundAt, source, pole, kept);
    const slots: number[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
    const key = blockKey(pole.x, pole.y);
    const block = this.block(key);
    if (source.draws?.(pole) ?? true) {
      const out = this.scratch;
      for (const list of out) list.length = 0;
      placePole(pole, top, frame, kerb, groundAt, out);
      out.forEach((list, part) => { for (const placement of list) slots[part]!.push(block.parts[part]!.add(pole.id, placement)); });
    }
    block.poles.add(pole.id);
    this.poles.set(pole.id, { block: key, x: pole.x, y: pole.y, top, kerb, frame, kind: pole.kind, slots });
    this.index.putPole(pole);
  }

  private unplace(id: PoleId, state: PoleState): void {
    const block = this.blocks.get(state.block)!;
    block.poles.delete(id);
    state.slots.forEach((slots, part) => {
      const store = block.parts[part];
      if (!store) return;
      // Highest first: the last slot is then never one of this pole's still to go.
      for (const slot of [...slots].sort((a, b) => b - a)) {
        const moved = store.remove(slot);
        if (moved === null) continue;
        const theirs = this.poles.get(moved)!.slots[part]!;
        theirs[theirs.indexOf(store.count)] = slot;
      }
    });
    this.poles.delete(id);
    this.index.deletePole(id);
  }

  /** A span's wires, when both its poles stand here; framed as each end frames it. */
  private string(span: UtilitySpan): void {
    if (this.spans.has(span.id)) return;
    const a = this.poles.get(span.a), b = this.poles.get(span.b);
    if (!a || !b) return;
    // In the block of its first pole.
    const key = a.block;
    const block = this.block(key).wires.add(span, wireEnd(span, a, a.kind), wireEnd(span, b, b.kind));
    this.spans.set(span.id, { span, key, block });
    this.index.putSpan(span);
  }

  private unstring(id: SpanId): void {
    const held = this.spans.get(id);
    if (!held) return;
    const moved = this.blocks.get(held.key)!.wires.remove(held.block);
    if (moved !== null) this.spans.get(moved)!.block = held.block;
    this.spans.delete(id);
    this.index.deleteSpan(held.span);
  }

  /** Every store's changes sent. */
  private flush(): void {
    for (const block of this.blocks.values()) {
      for (const part of block.parts) part.flush();
      block.wires.flush();
    }
  }

  /** Each block's nearest pole as this camera sees it, each time three draws the layer: what its parts fade and coarsen by. */
  private view(camera: Camera): void {
    this.scale.set(camera);
    wireScreen.uWirePixels.value = screen.halfHeight;
    for (const block of this.blocks.values()) {
      let nearest = -Infinity;
      if (block.poles.size > 0) {
        // A pole's own reach, the top of its mast standing at (x, top, -y) in three's axes.
        for (const id of block.poles) {
          const pole = this.poles.get(id)!;
          nearest = Math.max(nearest, this.scale.atPoint(pole.x, pole.top / 2, -pole.y, pole.top / 2));
        }
      } else {
        // A block of wires only: the nearest corner of what it holds.
        for (const part of block.parts) if (part.count > 0) nearest = Math.max(nearest, this.scale.atBox(part.box));
        if (block.wires.count > 0) nearest = Math.max(nearest, this.scale.atBox(block.wires.box));
      }
      for (const part of block.parts) part.view(this.scale);
      block.wires.view(this.scale, nearest);
    }
  }

  dispose(): void {
    // The instances and the wires are this layer's; the parts' shapes and materials are shared (`PARTS`).
    for (const block of this.blocks.values()) {
      for (const part of block.parts) part.dispose();
      block.wires.dispose();
    }
    this.blocks.clear();
    this.group.clear();
  }

}


/** The layer of every pole of a source, built whole (a load, a preview, the shaders' warm-up). */
export function buildUtilities(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  source: PoleSource = docPoles(net.doc),
  name = 'utilities',
): PoleLayer {
  const layer = new PoleLayer(kit, name);
  layer.fill(net, groundAt, source);
  return layer;
}

/** A planned pole run, as the editor would build it: in order, each pole new or already standing. */
export interface PolePreviewInput {
  readonly poles: readonly { readonly x: number; readonly y: number; readonly lamp: boolean; readonly kind: PoleKind; readonly standing: boolean }[];
}

/** The run under the pointer, drawn as it will stand */
export function buildPolePreview(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  input: PolePreviewInput,
): Utilities {
  const poles = new Map<PoleId, UtilityPole>();
  const spans = new Map<SpanId, UtilitySpan>();
  const reaching = new Map<PoleId, UtilitySpan[]>();
  const standing = new Set<PoleId>();
  input.poles.forEach((pole, index) => {
    const id = (index + 1) as PoleId;
    poles.set(id, { id, x: pole.x, y: pole.y, lamp: pole.lamp, kind: pole.kind });
    if (pole.standing) standing.add(id);
    if (index === 0) return;
    const span: UtilitySpan = { id: index as SpanId, a: index as PoleId, b: id };
    spans.set(span.id, span);
    for (const end of [span.a, span.b]) reaching.set(end, [...(reaching.get(end) ?? []), span]);
  });
  return buildUtilities(net, groundAt, kit,
    { poles, spans, spansAt: (id) => reaching.get(id) ?? [], draws: (pole) => !standing.has(pole.id) }, 'utility-preview');
}
