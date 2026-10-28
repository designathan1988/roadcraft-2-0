import { BufferAttribute, BufferGeometry, DataTexture, DynamicDrawUsage, Group, Matrix4, Mesh, SRGBColorSpace, Vector3, type Frustum } from 'three';
import type { ChangeKind, ChangeRect } from '@world/changes';
import { CELL, CellFiling } from '@world/cells';
import { JournalCursor } from '@world/derived';
import type { RoadElevation } from '@world/elevation';
import type { NodeId, SegmentId } from '@world/ids';
import { footwayAt, type LandscapeItem, type SignType } from '@world/landscape';
import type { Network } from '@world/network';
import { signsAtNode } from '@world/roads/derivedSigns';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { sectionOf, LAMP_ZONE } from '@world/section';
import { m } from '@world/units';
import { ViewCells, type CellKey } from '@world/viewCells';
import { createInstanceRuns, RunBuilder, warmMeshes, type Run, type RunStore } from './instanceRuns';
import { PLATE, POST, QUAD, QUAD_ORDER, SignSheets, cellUv, onTopOfPost, plateFaces, plateMaterial, streetChain, type Placed, type Sheet, type SheetCopier } from './signs';

/**
 * THE SIGNS HELD ROUND THE VIEW, NEVER FOR THE MAP (`viewCells.ts`): each cell of the world's grid stands the signs of the junctions
 * whose node lies in it and of the placed signs and street names whose item does, derived from the document when the view wants the
 * cell (within `SIGN_REACH`: past it a plate is under a pixel) and let go past the budget, least recently used first. A change of the
 * roads, the land, the landscaping or the heights drops the cells whose signs read there (`reads`, filed by cell), and no other.
 * DO NOT stand every sign of the map again, nor stand them all at a map's opening: 11,760 junctions of a 10 km city were walked on the
 * page before its first frame (2026-10-26).
 */

/** One plate standing: where, on what ground, what it says, which way it faces. */
interface Stand {
  readonly x: number;
  readonly y: number;
  readonly ground: number;
  readonly type: SignType;
  readonly text: string;
  readonly yaw: number;
}

/** A key's signs and the ground they read: a change there stands them again. */
interface SignValue {
  readonly stands: readonly Stand[];
  readonly reads: ChangeRect;
}

interface SignSource {
  readonly net: Network;
  readonly elevation: RoadElevation;
}

/** How far round a placed sign or a street's name the footway it stands on is looked for (`streetChain`'s reach). */
const ITEM_READS = m(30);
/** How far round the eye the signs' cells are held: a plate of 0.6 m is under a pixel past it at 1080p. */
const SIGN_REACH = m(700);
/** The most the cells' stands may hold on the CPU, bytes. */
const SIGN_CPU_BUDGET = 8 * 1048576;
/** What a stand costs on the CPU besides its plates' slots, bytes (an estimate). */
const STAND_BYTES = 160;
/** Cells derived a frame at most (`sync`): each a few junctions' signs. */
const CELLS_A_FRAME = 4;
/** The diary's kinds the signs read. DO NOT leave `markingStyle` out: the plates of the old standard stood after the style changed. */
const SIGN_KINDS: readonly ChangeKind[] = ['roads', 'terrain', 'landscape', 'elevation', 'markingStyle'];

const unite = (a: ChangeRect | null, b: ChangeRect): ChangeRect =>
  a === null ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const around = (x: number, y: number, r: number): ChangeRect => [x - r, y - r, x + r, y + r];
const grow = (r: ChangeRect, pad: number): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
const inRect = (x: number, y: number, r: ChangeRect): boolean => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

/** The box a segment's ribbon covers, with its casing and footways. */
function ribbonBox(net: Network, id: SegmentId): ChangeRect | null {
  const ribbon = net.ribbons.get(id);
  if (!ribbon) return null;
  const b = ribbon.full.bbox, pad = ribbon.road.width / 2 + ribbon.road.sidewalk + m(1);
  return [b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad];
}

const isSignItem = (item: LandscapeItem): boolean => item.kind === 'sign' || (item.kind === 'streetname' && !!item.text);

/** A junction's signs (`signsAtNode`), reading its segments' ground. */
function junctionSigns({ net, elevation }: SignSource, node: NodeId): SignValue | undefined {
  const at = net.doc.node(node);
  if (!at) return undefined;
  const stands: Stand[] = [];
  for (const sign of signsAtNode(net, node)) {
    const ground = elevation.onSegment(sign.segment, sign.x, sign.y) + footwayRiseAt(net, sign.x, sign.y);
    stands.push({ x: sign.x, y: sign.y, ground, type: sign.type, text: sign.text, yaw: Math.atan2(sign.facing.x, -sign.facing.y) });
  }
  if (!stands.length) return undefined;
  let reads: ChangeRect = around(at.x, at.y, ITEM_READS);
  for (const seg of at.incident) {
    const box = ribbonBox(net, seg);
    if (box) reads = unite(reads, box);
  }
  return { stands, reads };
}

/** A placed sign's plate, or a street name's plates at both ends of every segment of its street. */
function itemSigns({ net, elevation }: SignSource, id: number): SignValue | undefined {
  const item = net.doc.landscape.get(id);
  if (!item || !isSignItem(item)) return undefined;
  const stands: Stand[] = [];
  let reads: ChangeRect = around(item.x, item.y, ITEM_READS);
  if (item.kind === 'sign') {
    const hit = footwayAt(net, item, m(0.6));
    if (!hit) return { stands, reads };
    const ground = elevation.onSegment(hit.segment, item.x, item.y) + footwayRiseAt(net, item.x, item.y);
    // A traffic sign faces the traffic coming towards it on its side of the street.
    const facing = { x: -hit.frame.t.x * hit.side, y: -hit.frame.t.y * hit.side };
    const type = item.signType ?? 'stop';
    const yaw = type === 'street' || type === 'direction' || type === 'info'
      ? Math.atan2(-hit.frame.n.x * hit.side, hit.frame.n.y * hit.side) // read from the street
      : Math.atan2(facing.x, -facing.y);
    stands.push({ x: item.x, y: item.y, ground, type, text: item.text ?? '', yaw });
    return { stands, reads };
  }
  // The name plates: at both ends of every segment of the named street, on its right-hand footway, beside the corner.
  for (const seg of streetChain(net, item)) {
    const segment = net.doc.segment(seg), ribbon = net.ribbons.get(seg);
    if (!segment || !ribbon) continue;
    const box = ribbonBox(net, seg);
    if (box) reads = unite(reads, box);
    const section = sectionOf(ribbon.road, segment.direction);
    for (const [node, sign] of [[segment.a, 1], [segment.b, -1]] as const) {
      // On the right-hand footway seen from the corner: the road's right from `a`, its left from `b`.
      const zone = (sign > 0 ? section.right : section.left).furnishing;
      const out = zone.inner + Math.min(LAMP_ZONE, Math.max(zone.outer - zone.inner, m(0.2))) / 2;
      if ((net.doc.node(node)?.incident.length ?? 0) < 2) continue;
      const s = sign > 0 ? net.mouthDistance(seg, node) + m(1.5) : ribbon.full.length - net.mouthDistance(seg, node) - m(1.5);
      if (s <= 0 || s >= ribbon.full.length) continue;
      const f = ribbon.full.sampleAt(s);
      const side = sign > 0 ? -1 : 1;
      const x = f.p.x + f.n.x * out * side, y = f.p.y + f.n.y * out * side;
      const ground = elevation.onSegment(seg, x, y) + footwayRiseAt(net, x, y);
      // Parallel to the street, readable from both sides.
      stands.push({ x, y, ground, type: 'street', text: item.text!, yaw: Math.atan2(f.n.x, -f.n.y) });
    }
  }
  return { stands, reads };
}

/** A cell's signs: the junctions whose node lies in its square and the placed signs and street names whose item does (`cellSigns`). */
function cellSigns(source: SignSource, rect: ChangeRect): SignValue {
  const { net } = source;
  const stands: Stand[] = [];
  let reads: ChangeRect | null = null;
  const take = (value: SignValue | undefined): void => {
    if (!value) return;
    stands.push(...value.stands);
    reads = unite(reads, value.reads);
  };
  // The junctions filed over the square whose node lies in it (a node with no junction stands no sign: `signsAtNode` reads the junction's mouths).
  const nodes = net.junctionCells.idsMeeting(rect).filter((id) => { const n = net.doc.node(id); return !!n && inRect(n.x, n.y, rect); }).sort((p, q) => p - q);
  for (const node of nodes) take(junctionSigns(source, node));
  for (const item of net.doc.landscapeIn(rect)) if (isSignItem(item) && inRect(item.x, item.y, rect)) take(itemSigns(source, item.id));
  return { stands, reads: reads ?? rect };
}

/** Floats a quad takes: six corners of three (position, normal) or two (uv). */
const QUAD_3 = 18, QUAD_2 = 12;

/** One sheet's plates: quads in slots of one mesh, a free list, grown when full. */
interface PlateStore {
  readonly sheet: Sheet;
  readonly mesh: Mesh;
  capacity: number;
  /** Slots handed out so far (the draw range); free ones below it are zero-area. */
  used: number;
  readonly free: number[];
  /** Each slot's plate, for its uv when the sheet grows. */
  readonly cells: (Placed | null)[];
}

/** What one cell stands in the layer: its signs, its posts' run and its plates' slots. */
interface Standing {
  readonly stands: readonly Stand[];
  readonly run: Run | null;
  readonly plates: readonly { readonly store: PlateStore; readonly slot: number; readonly type: SignType; readonly text: string }[];
}

export interface SignLayerKept {
  readonly group: Group;
  /** The signs' cells held round the view (`viewCells.ts`). */
  readonly cells: ViewCells<Standing>;
  /** Brings the signs up to the diary and to the view: the cells a change reached dropped, the cells the view wants round `eye` stood (a few a frame); the cells stood. */
  sync(net: Network, elevation: RoadElevation, eye: { readonly x: number; readonly y: number }): number;
  /** Every plate standing now, in the cells' order (the specs read them). */
  standing(): Stand[];
  /** A post and a plate as the layer draws them, for their programs to be compiled before the first sign stands */
  warm(): Mesh[];
  /** The posts the camera can see (`InstanceRuns.cull`), every frame. */
  cull(frustum: Frustum, view: Matrix4): void;
  /** A WebGL context restored: the plates' sheets painted again (their pixels were only on the GPU). */
  refill(): void;
  /** The GPU copy a sheet already sent takes its new plates by (`SignSheets.useCopier`, VIA-04). */
  useCopier(copy: SheetCopier): void;
  dispose(): void;
}

const POST_STORES: RunStore[] = [{
  name: 'sign-posts', geometry: POST.geometry, material: POST.material,
  castShadow: true, receiveShadow: true, tinted: false, cards: false,
}];

export function createSignLayer(): SignLayerKept {
  const group = new Group();
  group.name = 'signs';
  const posts = createInstanceRuns('sign-posts', POST_STORES, m(4));
  group.add(posts.group);
  const stores = new Map<Sheet, PlateStore>();
  const sheets = new SignSheets({
    // A sheet grown: the uv of its plates moved (the sheet is taller), written again, that sheet's alone.
    grown: (sheet) => { const store = stores.get(sheet); if (store) rewriteUv(store); },
    gone: (sheet) => {
      const store = stores.get(sheet);
      if (!store) return;
      group.remove(store.mesh);
      store.mesh.geometry.dispose();
      stores.delete(sheet);
    },
  });
  /** The plate the programs are compiled ahead with (`warm`), made with the layer and kept while it is */
  const warmPicture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  warmPicture.colorSpace = SRGBColorSpace;
  warmPicture.needsUpdate = true;
  const warmMaterial = plateMaterial(warmPicture);
  // Scratch, one for the layer (never one per post or per plate).
  const matrix = new Matrix4(), corner = new Vector3(), scale = new Vector3();

  const storeOf = (sheet: Sheet): PlateStore => {
    let store = stores.get(sheet);
    if (store) return store;
    const geometry = new BufferGeometry();
    const mesh = new Mesh(geometry, sheet.material);
    mesh.name = 'sign-plates';
    mesh.castShadow = true;
    // A sphere round the whole map rejects nothing; the plates are small and few next to the town.
    mesh.frustumCulled = false;
    store = { sheet, mesh, capacity: 0, used: 0, free: [], cells: [] };
    stores.set(sheet, store);
    sized(store, 64);
    group.add(mesh);
    return store;
  };
  /** The store's arrays at `capacity` quads, the slots in use copied over: a buffer does not change size (three.js manual, "How to update things"). */
  const sized = (store: PlateStore, capacity: number): void => {
    const old = store.mesh.geometry;
    const position = new Float32Array(capacity * QUAD_3), normal = new Float32Array(capacity * QUAD_3), uv = new Float32Array(capacity * QUAD_2);
    if (store.capacity > 0) {
      position.set((old.getAttribute('position') as BufferAttribute).array as Float32Array);
      normal.set((old.getAttribute('normal') as BufferAttribute).array as Float32Array);
      uv.set((old.getAttribute('uv') as BufferAttribute).array as Float32Array);
    }
    const geometry = new BufferGeometry();
    for (const [name, array, size] of [['position', position, 3], ['normal', normal, 3], ['uv', uv, 2]] as const) {
      geometry.setAttribute(name, new BufferAttribute(array, size).setUsage(DynamicDrawUsage));
    }
    geometry.setDrawRange(0, store.used * 6);
    old.dispose();
    store.mesh.geometry = geometry;
    store.capacity = capacity;
  };
  const touch = (store: PlateStore, slot: number): void => {
    const g = store.mesh.geometry;
    for (const [name, n] of [['position', QUAD_3], ['normal', QUAD_3], ['uv', QUAD_2]] as const) {
      const a = g.getAttribute(name) as BufferAttribute;
      a.addUpdateRange(slot * n, n);
      a.needsUpdate = true;
    }
  };
  const writeUv = (store: PlateStore, slot: number, placed: Placed): void => {
    const uv = (store.mesh.geometry.getAttribute('uv') as BufferAttribute).array as Float32Array;
    const c = cellUv(placed);
    QUAD_ORDER.forEach((i, k) => {
      uv[slot * QUAD_2 + k * 2] = QUAD[i]![0] < 0 ? c.u0 : c.u1;
      uv[slot * QUAD_2 + k * 2 + 1] = QUAD[i]![1] < 0 ? c.v0 : c.v1;
    });
  };
  /** @rebuild A sheet grown (its rows doubled, a handful of times in a town's life): its plates' uv written again. */
  const rewriteUv = (store: PlateStore): void => {
    store.cells.forEach((placed, slot) => { if (placed) writeUv(store, slot, placed); });
    const a = store.mesh.geometry.getAttribute('uv') as BufferAttribute;
    a.clearUpdateRanges();
    a.needsUpdate = true;
  };
  const putQuad = (placed: Placed, face: { x: number; y: number; yaw: number }, ground: number, type: SignType): { store: PlateStore; slot: number } => {
    const store = storeOf(placed.sheet);
    let slot = store.free.pop();
    if (slot === undefined) {
      if (store.used === store.capacity) sized(store, Math.ceil(store.capacity * 1.5) + 512);
      slot = store.used++;
      store.mesh.geometry.setDrawRange(0, store.used * 6);
    }
    const size = PLATE[type];
    const g = store.mesh.geometry;
    const position = (g.getAttribute('position') as BufferAttribute).array as Float32Array;
    const normal = (g.getAttribute('normal') as BufferAttribute).array as Float32Array;
    // The quad of the plane of 1 x 1, turned and sized as `buildSigns` turned it.
    matrix.makeRotationY(face.yaw).scale(scale.set(m(size.w), m(size.h), 1)).setPosition(face.x, ground + m(size.z), -face.y);
    QUAD_ORDER.forEach((i, k) => {
      corner.set(QUAD[i]![0], QUAD[i]![1], 0).applyMatrix4(matrix);
      position[slot * QUAD_3 + k * 3] = corner.x; position[slot * QUAD_3 + k * 3 + 1] = corner.y; position[slot * QUAD_3 + k * 3 + 2] = corner.z;
      normal[slot * QUAD_3 + k * 3] = Math.sin(face.yaw); normal[slot * QUAD_3 + k * 3 + 1] = 0; normal[slot * QUAD_3 + k * 3 + 2] = Math.cos(face.yaw);
    });
    store.cells[slot] = placed;
    writeUv(store, slot, placed);
    touch(store, slot);
    return { store, slot };
  };
  const freeQuad = (store: PlateStore, slot: number): void => {
    const g = store.mesh.geometry;
    // Zero area: drawn as nothing until the slot is taken again.
    ((g.getAttribute('position') as BufferAttribute).array as Float32Array).fill(0, slot * QUAD_3, (slot + 1) * QUAD_3);
    store.cells[slot] = null;
    store.free.push(slot);
    touch(store, slot);
  };
  /** A cell's plates let go and its posts' run taken out. */
  const letGo = (was: Standing): void => {
    for (const plate of was.plates) {
      if (stores.get(plate.store.sheet) === plate.store) freeQuad(plate.store, plate.slot);
      sheets.drop(plate.type, plate.text);
    }
    if (was.run) posts.update({ removed: [was.run], added: [] });
  };
  /** A cell's signs stood: its posts' run put in, its plates on their sheets. */
  const standOf = (stands: readonly Stand[]): Standing => {
    const builder = new RunBuilder(POST_STORES);
    const plates: Standing['plates'][number][] = [];
    for (const s of stands) {
      const size = PLATE[s.type];
      // Up to the plate's top behind it; up to its bottom under a plate on top of it.
      const top = m(size.z + (onTopOfPost(s.type) ? -size.h / 2 : size.h / 2));
      builder.turned(0, s.x, s.ground + top / 2, -s.y, 0, 1, top, 1, Math.max(1, top));
      const placed = sheets.take(s.type, s.text);
      for (const face of plateFaces(s.type, s.x, s.y, s.yaw)) {
        // The sheet may have been let go and made again since `take`: the store of the plate's sheet now.
        const { store, slot } = putQuad(placed, face, s.ground, s.type);
        plates.push({ store, slot, type: s.type, text: s.text });
      }
    }
    const run = stands.length ? builder.build() : null;
    if (run) posts.update({ removed: [], added: [run] });
    return { stands, run, plates };
  };

  let source: SignSource | null = null;
  /** The cells by the box their signs read: what a change there reaches. */
  const reads = new CellFiling<CellKey, Standing>();
  const cells = new ViewCells<Standing>({
    name: 'signs', version: 1, side: CELL, reach: SIGN_REACH, cpuBudget: SIGN_CPU_BUDGET,
    derive(key, rect) {
      const value = cellSigns(source!, rect);
      const standing = standOf(value.stands);
      reads.file(key, standing, value.reads);
      return { value: standing, cpuBytes: value.stands.length * STAND_BYTES + 64 };
    },
    release(key, standing) {
      reads.remove(key);
      letGo(standing);
    },
  });
  const cursor = new JournalCursor(SIGN_KINDS);
  /** The diary's changes since the last sync: the cells whose signs read there dropped (`reads`), and those where a sign may stand now. */
  const follow = (net: Network): void => {
    const entries = cursor.read(net.doc.changes);
    if (entries === null) { cells.clear(); return; }
    const dropped = new Set<CellKey>();
    const rects: ChangeRect[] = [];
    for (const e of entries) {
      if (e.rects === null || e.kind === 'markingStyle') { cells.clear(); return; }
      // A landscaping entry names its items (`RoadDoc.addLandscapeMany`): the cells of the signs and names among them, and of the items gone (their kind unknown: the entry's own rectangles). DO NOT stand the junctions round a bench again.
      if (e.kind === 'landscape' && e.ids) {
        let gone = false;
        for (const id of e.ids) {
          const item = net.doc.landscape.get(id);
          if (!item) gone = true;
          else if (isSignItem(item)) dropped.add(cells.cellAt(item.x, item.y));
        }
        if (gone) rects.push(...e.rects);
        continue;
      }
      for (const key of reads.idsMeetingAny(e.rects)) dropped.add(key);
      // A sign may stand now where none did: the cells of the change.
      for (const r of e.rects) rects.push(grow(r, ITEM_READS));
    }
    cells.forget(dropped);
    if (rects.length) cells.invalidate(rects);
  };

  return {
    group,
    cells,
    sync(net, elevation, eye) {
      if (typeof document === 'undefined') return 0;
      // Another document, or another solve of the heights: every cell stood again from it.
      if (source && source.net.doc !== net.doc) cells.clear();
      source = { net, elevation };
      follow(net);
      cells.look(eye);
      const stood = cells.pump(CELLS_A_FRAME);
      // The sheets with new plates painted and sent, before the frame draws them.
      sheets.flush();
      return stood;
    },
    standing() {
      const out: Stand[] = [];
      // The keys taken first: a `peek` makes its cell the most recently used, moving it in the cells' order.
      for (const key of [...cells.keys()]) { const standing = cells.peek(key); if (standing) out.push(...standing.stands); }
      return out;
    },
    refill() {
      sheets.refill();
    },
    useCopier(copy) {
      sheets.useCopier(copy);
    },
    warm() {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(QUAD_3), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(QUAD_3), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(QUAD_2), 2));
      const plate = new Mesh(geometry, warmMaterial);
      plate.name = 'sign-plates';
      plate.castShadow = true;
      plate.frustumCulled = false;
      return [...warmMeshes(POST_STORES), plate];
    },
    cull(frustum, view) {
      posts.cull(frustum, view);
    },
    dispose() {
      warmMaterial.dispose();
      warmPicture.dispose();
      cells.clear();
      posts.dispose();
      for (const store of stores.values()) store.mesh.geometry.dispose();
      stores.clear();
      sheets.dispose();
      group.clear();
    },
  };
}
