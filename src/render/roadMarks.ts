import { Color, type DataTexture } from 'three';

import type { Vec2 } from '@core/vec2';
import { Digest } from '@core/digest';
import { GEO_EPS } from '@core/scalar';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { LANE_LINE, Level, ROAD_TYPES } from '@world/roadTypes';
import { STYLE_PAINT } from '@world/roads/markingStyle';
import { CYCLE_LANE_PAINT, PARKING_PAINT, type ParkingLine } from '@world/parkingLayout';
import {
  type AlongPaint, type Bar, type PaintedIsland, type StrokeSpec, type ZebraStretch, approachLegendsAt, junctionDetailAt, midBlockDetailAt, miniRoundaboutIsland,
  segmentAlongPaint, segmentMarkings, transitionMarkings,
} from '@world/markings';
import type { SegmentRibbon } from '@world/network';
import { STOP_BAR_WIDTH } from '@world/approach';
import { m } from '@world/units';
import { dataTable, roadPaint, sendTexels } from './roadPaint';

/**
 * # THE ROADS' MARKS AS DATA, DRAWN BY THE CARRIAGEWAY'S OWN SHADER (`roadMarksShader.ts`)
 *
 * Every mark painted on a road (a crosswalk's bars, a stop line, an arrow, a legend, a parking bay's lines, a taper's lines, a mini-roundabout's
 * island) is a record here, not a polygon: each of the quads the paint was once drawn as (`world/markings.ts`, `world/parkingLayout.ts`) one shape,
 * its corners the same numbers. The carriageway's fragment shader inks a pixel by the share of its footprint each shape covers, box-filtered
 * (Quilez, https://iquilezles.org/articles/filterableprocedurals): no vertex, no draw and no overdraw of paint.
 *
 * The shapes a pixel tests are those of the piece it is on, as clustered shading reads the items of a pixel's cluster from a list (Olsson,
 * Billeter, Assarsson, "Clustered Deferred and Forward Shading", HPG 2012, https://www.cse.chalmers.se/~uffe/clustered_shading_preprint.pdf; DOOM
 * 2016's decals, https://www.adriancourreges.com/blog/2016/09/09/doom-2016-graphics-study/): the piece is the road or the junction's plate the
 * carriageway's vertex says it is on (`roadSection`'s third number, `roadPaint.ts`), its marks filed in buckets along it (a road's arc length, a
 * plate's x), each bucket a list of groups of shapes. A mark is filed in the piece it lies on (a leg's crossing, stop line and legend on that leg's
 * road; a road's arrows and parking on it; a taper or an island on its node's plate) and in the pieces round its node whose triangles may read it
 * there (the plate, the other legs): so it is drawn on its own carriageway alone, never on another pass's, never on a kerb or a footway (another
 * material).
 *
 * One data texture (`uRoadMarks`, RGBA floats, `texelFetch`): the palette in its first texels, then a block a piece:
 * - its buckets, a texel each: (first entry, entries);
 * - its entries, a texel each, in the order they are inked: (group, palette index, shapes);
 * - its groups: their box (min x, min y, max x, max y), then their shapes, `SHAPE_TEXELS` each:
 *   - a parallelogram: (ox, oy, r0) (r1, kind, dash) (q0, g, period), its own coordinates (s, t) = (r0 . (p - o), r1 . (p - o)) in [0, 1] squared, a
 *     dashed one inked where q = q0 + g . (p - o) falls under `dash` in `period`;
 *   - a regular polygon: (cx, cy, radius, sides) (0, 0, kind, 0) (0, 0, 0, 0), a corner at angle 0.
 * The texture is written as pieces are placed (`place`), and sent at the build's swap (`commit`): only the texels changed (`sendTexels`).
 */

/** What a shape is: a parallelogram inked whole, one inked where its pattern says, a regular polygon. */
const MARK_SOLID = 0;
export const MARK_DASHED = 1;
export const MARK_POLYGON = 2;
/** Texels a shape. */
export const SHAPE_TEXELS = 3;
/** Texels a row of the marks' texture. */
export const MARKS_ROW = 1024;
/** Texels the palette holds at the texture's start: the most colours the roads are painted in. */
export const PALETTE_TEXELS = 64;
/** A bucket's length along its piece. */
const BUCKET = m(2);
/** How far past a mark the buckets it is filed in reach: a far pixel's footprint along the road (a grazing view) still finds it. */
const MARK_MARGIN = m(3);
/** The most a group of a line's shapes spans: a long line cut into groups, each culled by its own box. */
const GROUP_SPAN = m(4);

/** The stop lines' and the zebras' paint. */
export const STOP_PAINT = '#ece9d9';
export const ZEBRA_PAINT = '#f4f1e3';

/** A shape as the shader reads it: its twelve numbers (`SHAPE_TEXELS` texels), its box and its corners (a polygon its corners). */
interface MarkShape {
  readonly data: readonly number[];
  readonly box: readonly [number, number, number, number];
  readonly corners: readonly Vec2[];
}

/** Shapes of one colour culled by one box: a stroke's quads, a crosswalk's run of bars, a stop line, an island. */
export interface MarkGroup {
  readonly color: string;
  readonly shapes: readonly MarkShape[];
  readonly box: readonly [number, number, number, number];
}

/** A piece of the roads: a road or a node's plate. */
export interface MarkPiece {
  readonly kind: 'segment' | 'node';
  readonly id: number;
}

export const pieceName = (piece: MarkPiece): string => `${piece.kind === 'node' ? 'n' : 's'}${piece.id}`;
/** A source placed by the roads' far level (`networkFarRoads.ts` followMarks): its piece's name after this. Written where the detail's own source of
 *  the same piece is not (`commit`): the far level's marks stand for a piece until its detail derives them. */
const FAR_SOURCE = 'f:';

/** A pattern along a shape: q = q0 + g . (p - o), inked under `dash` in `period`. */
interface Pattern {
  readonly q0: number;
  readonly gx: number;
  readonly gy: number;
  readonly dash: number;
  readonly period: number;
}

/** A parallelogram from `o` along `e1` and `e2`; null where it has no area. */
function parallelogram(o: Vec2, e1: Vec2, e2: Vec2, pattern: Pattern | null): MarkShape | null {
  const det = e1.x * e2.y - e2.x * e1.y;
  if (!(Math.abs(det) > GEO_EPS * GEO_EPS)) return null;
  const r0x = e2.y / det, r0y = -e2.x / det, r1x = -e1.y / det, r1y = e1.x / det;
  const corners = [o, { x: o.x + e1.x, y: o.y + e1.y }, { x: o.x + e1.x + e2.x, y: o.y + e1.y + e2.y }, { x: o.x + e2.x, y: o.y + e2.y }];
  return {
    data: [o.x, o.y, r0x, r0y, r1x, r1y, pattern ? MARK_DASHED : MARK_SOLID, pattern?.dash ?? 0, pattern?.q0 ?? 0, pattern?.gx ?? 0, pattern?.gy ?? 0, pattern?.period ?? 0],
    box: boxOf(corners),
    corners,
  };
}

function boxOf(points: readonly Vec2[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return [minX, minY, maxX, maxY];
}

const unite = (boxes: readonly (readonly [number, number, number, number])[]): [number, number, number, number] => [
  Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])),
];

/** One quad of paint from `a` to `b`, `half` either side: the quad the paint was drawn as (its corners a -/+ n, b +/- n), `pattern` its dashes. */
function quadShape(a: Vec2, b: Vec2, half: number, pattern: ((o: Vec2, e1: Vec2, e2: Vec2) => Pattern) | null = null): MarkShape | null {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length < GEO_EPS) return null;
  const nx = (-dy / length) * half, ny = (dx / length) * half;
  const o = { x: a.x - nx, y: a.y - ny }, e1 = { x: dx, y: dy }, e2 = { x: nx * 2, y: ny * 2 };
  return parallelogram(o, e1, e2, pattern ? pattern(o, e1, e2) : null);
}

/** A pattern along a quad from its start to its end (`quadShape`): q from `qa` at `a` to `qb` at `b`. */
const alongQuad = (qa: number, qb: number, dash: number, period: number) => (_o: Vec2, e1: Vec2, e2: Vec2): Pattern => {
  // q = qa + (qb - qa) s, s the coordinate along e1: its row of the inverse (`parallelogram`).
  const det = e1.x * e2.y - e2.x * e1.y;
  return { q0: qa, gx: ((qb - qa) * e2.y) / det, gy: (-(qb - qa) * e2.x) / det, dash, period };
};

/** The groups of one stroke (`StrokeSpec`): its quads, a solid line's, or a broken one's inked where its pattern says along the stroke's own length
 *  from its `dashOffset` (where the paint's quads were cut, a dash a quad), consecutive quads grouped under `GROUP_SPAN`. `along`, for a broken line
 *  along its road (a parking lane's edge, `parkingGroups`): each point's place in its pattern instead. */
export function strokeGroups(spec: StrokeSpec, along?: (p: Vec2) => number): MarkGroup[] {
  const pattern = spec.dash?.length ? spec.dash : null;
  if (pattern && pattern.length !== 2) throw new Error(`a dash pattern of ${pattern.length} numbers is not a dash and a gap`);
  const shapes: MarkShape[] = [];
  let travelled = spec.dashOffset;
  for (let i = 1; i < spec.points.length; i++) {
    const a = spec.points[i - 1]!, b = spec.points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const period = pattern ? pattern[0]! + pattern[1]! : 0;
    const shape = !pattern ? quadShape(a, b, spec.width / 2)
      : along ? quadShape(a, b, spec.width / 2, alongQuad(along(a), along(b), pattern[0]!, period))
        : quadShape(a, b, spec.width / 2, alongQuad(travelled, travelled + length, pattern[0]!, period));
    // A stretch too short for a quad is no length of the pattern either (as the quads were cut).
    if (length >= GEO_EPS) travelled += length;
    if (shape) shapes.push(shape);
  }
  return groupsOf(spec.color, shapes);
}

/** Consecutive shapes of one colour as groups, each spanning `GROUP_SPAN` at most (one shape alone may span more). */
function groupsOf(color: string, shapes: readonly MarkShape[]): MarkGroup[] {
  const out: MarkGroup[] = [];
  let run: MarkShape[] = [];
  const close = (): void => { if (run.length) out.push({ color, shapes: run, box: unite(run.map((s) => s.box)) }); run = []; };
  for (const shape of shapes) {
    if (run.length) {
      const box = unite([...run.map((s) => s.box), shape.box]);
      if (Math.hypot(box[2] - box[0], box[3] - box[1]) > GROUP_SPAN) close();
    }
    run.push(shape);
  }
  close();
  return out;
}

/** A stop line (or any bar) as one group: its quad. */
export function barGroup(color: string, bar: Bar): MarkGroup | null {
  const shape = quadShape(bar.a, bar.b, bar.width / 2);
  return shape ? { color, shapes: [shape], box: shape.box } : null;
}

/** A run of a crosswalk's bars as one shape (`ZebraStretch`): its quad from `from` to `from + used` along `nrm`, inked where its offset across from
 *  `from` falls under `bar` in `pitch`, as the zebra's paint inked it (offset `nrm . (p - a) - from`). */
export function zebraGroup(run: ZebraStretch): MarkGroup | null {
  const { a, b, nrm, from, used, bar, pitch } = run;
  const o = { x: a.x + nrm.x * from, y: a.y + nrm.y * from };
  const shape = parallelogram(o, { x: b.x - a.x, y: b.y - a.y }, { x: nrm.x * used, y: nrm.y * used }, { q0: 0, gx: nrm.x, gy: nrm.y, dash: bar, period: pitch });
  return shape ? { color: ZEBRA_PAINT, shapes: [shape], box: shape.box } : null;
}

/** A mini-roundabout's island as one regular polygon (`PaintedIsland`, a corner at angle 0). */
export function islandGroup(island: PaintedIsland): MarkGroup {
  const corners = Array.from({ length: island.sides }, (_, i) => {
    const a = (i / island.sides) * Math.PI * 2;
    return { x: island.x + Math.cos(a) * island.radius, y: island.y + Math.sin(a) * island.radius };
  });
  const shape: MarkShape = { data: [island.x, island.y, island.radius, island.sides, 0, 0, MARK_POLYGON, 0, 0, 0, 0, 0], box: boxOf(corners), corners };
  return { color: island.color, shapes: [shape], box: shape.box };
}

/** A parking line's groups (`ParkingLine`): a dashed edge along its road by its run (`ParkingDashRun`: the road's arc length past the run's start). */
export function parkingGroups(line: ParkingLine, alongRoad: (p: Vec2) => number): MarkGroup[] {
  const spec: StrokeSpec = { points: line.points, width: line.width, color: line.color, dash: line.dash, dashOffset: 0 };
  const run = line.run;
  return run ? strokeGroups({ ...spec, dash: [run.dash, run.period - run.dash] }, (p) => alongRoad(p) - run.from) : strokeGroups(spec);
}

/** The colours the roads are painted in, in the order they are inked one over another: the cycle lane's area first, under every line. */
function knownColours(): string[] {
  return [...new Set([CYCLE_LANE_PAINT, ...ROAD_TYPES.map((rt) => rt.line), LANE_LINE, ...STYLE_PAINT, ...PARKING_PAINT, STOP_PAINT, ZEBRA_PAINT])];
}

/** A mark filed in a piece: its group, and the range of the piece's bucket coordinate it reaches (a road's arc length, a plate's x). */
export interface Filed {
  readonly group: MarkGroup;
  readonly lo: number;
  readonly hi: number;
}

/** One document's marks: what each piece placed into each piece (`place`), the pieces to write again at the next `commit`, each piece's block. */
interface DocMarks {
  readonly sources: Map<string, { readonly digest: number; readonly into: Map<string, Filed[]> }>;
  readonly targets: Map<string, { readonly piece: MarkPiece; readonly from: Set<string> }>;
  readonly dirty: Set<string>;
  readonly blocks: Map<string, { readonly start: number; readonly size: number }>;
}

/** Where a piece's marks are read and how far its triangles reach (`fileMarks`): which pass it is drawn in. */
export interface MarkPasses {
  /** The pass a road is drawn in; null for none. */
  segment(id: SegmentId): string | null;
  /** The pass a node's plate is drawn in; null for none. */
  node(id: NodeId): string | null;
}

/** The roads' marks: one texture for every carriageway material (`uRoadMarks`), grown as marks come. */
class RoadMarks {
  readonly texture: { value: DataTexture } = { value: dataTable(MARKS_ROW, 16) };
  private readonly docs = new WeakMap<object, DocMarks>();
  private readonly palette = new Map<string, number>();
  private readonly colour = new Color();
  /** Free ranges of texels between blocks, by start; `top`, the first texel no block reaches. */
  private free: [number, number][] = [];
  private top = PALETTE_TEXELS;

  constructor() {
    for (const color of knownColours()) this.paletteIndex(color);
  }

  /** A colour's place in the palette, written the first time it is met. */
  paletteIndex(color: string): number {
    const known = this.palette.get(color);
    if (known !== undefined) return known;
    const index = this.palette.size;
    if (index >= PALETTE_TEXELS) throw new Error(`the roads are painted in more than ${PALETTE_TEXELS} colours`);
    this.palette.set(color, index);
    // The paint's own tone as its material had it (the colour at 0.88), linear.
    this.colour.set(color).multiplyScalar(0.88);
    const data = this.texture.value.image.data as Float32Array;
    data.set([this.colour.r, this.colour.g, this.colour.b, 1], index * 4);
    sendTexels(this.texture.value, index, 1);
    return index;
  }

  /** Every colour of the palette, in its order. */
  colours(): string[] {
    return [...this.palette.keys()];
  }

  /** Every colour a document's marks are painted in, as placed (`place`). */
  placedColours(doc: object): string[] {
    const out = new Set<string>();
    for (const source of this.docs.get(doc)?.sources.values() ?? []) for (const list of source.into.values()) for (const f of list) out.add(f.group.color);
    return [...out];
  }

  private docOf(doc: object): DocMarks {
    let marks = this.docs.get(doc);
    if (!marks) this.docs.set(doc, marks = { sources: new Map(), targets: new Map(), dirty: new Set(), blocks: new Map() });
    return marks;
  }

  /** The marks a piece places (`source`), each filed in the pieces it lies on (`fileMarks`): what it placed before replaced, written at the next `commit`.
   *  `far`: placed by the roads' far level, a source of its own that gives way to the detail's of the same piece. */
  place(doc: object, source: MarkPiece, into: Iterable<readonly [MarkPiece, readonly Filed[]]>, far = false): void {
    const marks = this.docOf(doc);
    const name = (far ? FAR_SOURCE : '') + pieceName(source);
    const filed = new Map<string, Filed[]>();
    for (const [piece, list] of into) {
      if (!list.length) continue;
      const key = pieceName(piece);
      const known = filed.get(key);
      if (known) known.push(...list); else filed.set(key, [...list]);
      if (!marks.targets.has(key)) marks.targets.set(key, { piece, from: new Set() });
    }
    const digest = new Digest();
    for (const [key, list] of [...filed].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
      digest.addText(key);
      for (const f of list) { digest.addText(f.group.color).add(f.lo).add(f.hi); for (const s of f.group.shapes) digest.addAll(s.data); }
    }
    const old = marks.sources.get(name);
    const value = digest.value();
    if (old && old.digest === value && old.into.size === filed.size) return;
    for (const key of old?.into.keys() ?? []) { marks.targets.get(key)?.from.delete(name); marks.dirty.add(key); }
    if (filed.size) marks.sources.set(name, { digest: value, into: filed }); else marks.sources.delete(name);
    for (const key of filed.keys()) { marks.targets.get(key)!.from.add(name); marks.dirty.add(key); }
  }

  /** Every mark the detail placed in a document let go (a load, a change of its paint's standard), written at the next `commit`; the far level's
   *  stay, its own to place (`networkFarRoads.ts`). */
  clear(doc: object): void {
    const marks = this.docOf(doc);
    for (const [name, source] of [...marks.sources]) {
      if (name.startsWith(FAR_SOURCE)) continue;
      for (const key of source.into.keys()) { marks.targets.get(key)?.from.delete(name); marks.dirty.add(key); }
      marks.sources.delete(name);
    }
  }

  /** The marks of a document placed since the last commit written into the texture and their heads into the slots' table (`roadPaint.ts`): at the
   *  build's swap, so a block drawn until then never shows the marks of the next. */
  commit(doc: object, only?: ReadonlySet<string>): void {
    const marks = this.docs.get(doc);
    if (!marks || marks.dirty.size === 0) return;
    for (const key of [...marks.dirty].sort()) {
      // `only`: the pieces the far level placed in (`networkFarRoads.ts`), the detail's left for its build's swap.
      if (only && !only.has(key)) continue;
      marks.dirty.delete(key);
      const target = marks.targets.get(key);
      if (!target) continue;
      const filed: Filed[] = [];
      for (const name of [...target.from].sort()) {
        // The far level's marks of a piece the detail placed: the detail's alone (the same marks, from the network the detail holds).
        if (name.startsWith(FAR_SOURCE) && target.from.has(name.slice(FAR_SOURCE.length))) continue;
        filed.push(...(marks.sources.get(name)?.into.get(key) ?? []));
      }
      const old = marks.blocks.get(key);
      if (old) { this.release(old.start, old.size); marks.blocks.delete(key); }
      const slot = target.piece.kind === 'node' ? roadPaint.nodeSlot(doc, target.piece.id as NodeId) : roadPaint.roadSlot(doc, target.piece.id as SegmentId);
      if (filed.length === 0) {
        roadPaint.setMarksHead(doc, slot, 0, BUCKET, 0, 0);
        if (target.from.size === 0) marks.targets.delete(key);
        continue;
      }
      const block = this.write(filed);
      marks.blocks.set(key, { start: block.start, size: block.size });
      roadPaint.setMarksHead(doc, slot, block.origin, BUCKET, block.buckets, block.start);
    }
  }

  /** A piece's block written (`RoadMarks` layout): its buckets, its entries, its groups. */
  private write(filed: readonly Filed[]): { start: number; size: number; origin: number; buckets: number } {
    let lo = Infinity, hi = -Infinity;
    for (const f of filed) { lo = Math.min(lo, f.lo); hi = Math.max(hi, f.hi); }
    const origin = Math.floor((lo - MARK_MARGIN) / BUCKET) * BUCKET;
    const buckets = Math.max(1, Math.ceil((hi + MARK_MARGIN - origin) / BUCKET));
    // Each group once, in the order filed; each bucket its groups, inked in the palette's order (an area under the lines over it).
    const groups = [...new Set(filed.map((f) => f.group))];
    const lists: { group: MarkGroup; order: number }[][] = Array.from({ length: buckets }, () => []);
    filed.forEach((f, order) => {
      const k0 = Math.max(0, Math.floor((f.lo - MARK_MARGIN - origin) / BUCKET)), k1 = Math.min(buckets - 1, Math.floor((f.hi + MARK_MARGIN - origin) / BUCKET));
      for (let k = k0; k <= k1; k++) lists[k]!.push({ group: f.group, order });
    });
    for (const list of lists) list.sort((p, q) => this.paletteIndex(p.group.color) - this.paletteIndex(q.group.color) || p.order - q.order);
    const entries = lists.reduce((n, list) => n + list.length, 0);
    const groupTexels = groups.reduce((n, g) => n + 1 + g.shapes.length * SHAPE_TEXELS, 0);
    const size = buckets + entries + groupTexels;
    const start = this.allocate(size);
    const data = this.texture.value.image.data as Float32Array;
    const at = new Map<MarkGroup, number>();
    let g = start + buckets + entries;
    for (const group of groups) {
      at.set(group, g);
      data.set(group.box, g * 4);
      group.shapes.forEach((shape, k) => data.set(shape.data, (g + 1 + k * SHAPE_TEXELS) * 4));
      g += 1 + group.shapes.length * SHAPE_TEXELS;
    }
    let e = start + buckets;
    lists.forEach((list, k) => {
      data.set([e, list.length, 0, 0], (start + k) * 4);
      for (const { group } of list) { data.set([at.get(group)!, this.paletteIndex(group.color), group.shapes.length, 0], e * 4); e++; }
    });
    sendTexels(this.texture.value, start, size);
    return { start, size, origin, buckets };
  }

  /** `size` texels for a block: the first free range that holds them, else past the last block (the texture grown to hold it). */
  private allocate(size: number): number {
    for (let i = 0; i < this.free.length; i++) {
      const [start, length] = this.free[i]!;
      if (length < size) continue;
      if (length === size) this.free.splice(i, 1); else this.free[i] = [start + size, length - size];
      return start;
    }
    const start = this.top;
    this.top += size;
    this.fit(this.top);
    return start;
  }

  /** A block's texels free again, merged with the free ranges beside it; zeroed, so no stale list is ever read from them. */
  private release(start: number, size: number): void {
    const data = this.texture.value.image.data as Float32Array;
    data.fill(0, start * 4, (start + size) * 4);
    sendTexels(this.texture.value, start, size);
    const free = this.free;
    let i = 0;
    while (i < free.length && free[i]![0] < start) i++;
    free.splice(i, 0, [start, size]);
    // Merged with the one after it, then with the one before.
    if (i + 1 < free.length && free[i]![0] + free[i]![1] === free[i + 1]![0]) { free[i] = [free[i]![0], free[i]![1] + free[i + 1]![1]]; free.splice(i + 1, 1); }
    if (i > 0 && free[i - 1]![0] + free[i - 1]![1] === free[i]![0]) { free[i - 1] = [free[i - 1]![0], free[i - 1]![1] + free[i]![1]]; free.splice(i, 1); }
  }

  /** The texture grown (twice the rows, its texels kept) until it holds `texels`. */
  private fit(texels: number): void {
    const old = this.texture.value;
    let height = old.image.height;
    const rows = Math.ceil(texels / MARKS_ROW);
    if (rows <= height) return;
    while (height < rows) height *= 2;
    const grown = dataTable(MARKS_ROW, height);
    (grown.image.data as Float32Array).set(old.image.data as Float32Array);
    this.texture.value = grown;
    old.dispose();
  }

  /** What a piece's marks hold in the texture now, for the tests: its block's texels (none: 0). */
  blockOf(doc: object, piece: MarkPiece): { readonly start: number; readonly size: number } | null {
    return this.docs.get(doc)?.blocks.get(pieceName(piece)) ?? null;
  }

  /** The shapes filed in a piece, from every piece that placed them, as they will be written (`commit`): one digest, for the tests. */
  filedDigest(doc: object, piece: MarkPiece): number {
    const marks = this.docs.get(doc);
    const key = pieceName(piece);
    const digest = new Digest();
    for (const name of [...marks?.targets.get(key)?.from ?? []].sort()) {
      for (const f of marks!.sources.get(name)?.into.get(key) ?? []) {
        digest.addText(f.group.color);
        for (const s of f.group.shapes) digest.addAll(s.data);
      }
    }
    return digest.value();
  }

  /** Every shape a document's marks hold, by the piece that placed it, for the tests: what is painted, where. */
  shapesOf(doc: object): { readonly source: string; readonly color: string; readonly shape: MarkShape; readonly into: readonly string[] }[] {
    const out: { source: string; color: string; shape: MarkShape; into: readonly string[] }[] = [];
    for (const [source, placed] of this.docs.get(doc)?.sources ?? []) {
      // Each group once, with every piece it is filed in (`fileMarks`).
      const into = new Map<MarkGroup, string[]>();
      for (const [target, list] of placed.into) {
        for (const f of list) {
          const known = into.get(f.group);
          if (known) known.push(target); else into.set(f.group, [target]);
        }
      }
      for (const [group, targets] of into) for (const shape of group.shapes) out.push({ source, color: group.color, shape, into: targets });
    }
    return out;
  }
}

/** The page's marks: the carriageway's materials read them (`mesh/roadEdges.ts`), the road surfaces' inputs write them (`roadSurfaceInputs.ts`). */
export const roadMarks = new RoadMarks();

/** A piece's coordinate its buckets run along at (x, y): a road's arc length on its centreline, a plate's x. */
function coordinateOf(net: Network, piece: MarkPiece): ((p: Vec2) => number) | null {
  if (piece.kind === 'node') return (p) => p.x;
  const line = net.ribbons.get(piece.id as SegmentId)?.full;
  if (!line) return null;
  const hit = { s: 0, distance: 0 };
  return (p) => { line.closestInto(p.x, p.y, hit); return hit.s; };
}

/** The range of a piece's coordinate a group reaches: of its shapes' corners. */
function rangeOf(coordinate: (p: Vec2) => number, group: MarkGroup): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const shape of group.shapes) for (const p of shape.corners) { const c = coordinate(p); lo = Math.min(lo, c); hi = Math.max(hi, c); }
  return [lo, hi];
}

/**
 * Marks lying on `lying` filed for `roadMarks.place`: in that piece, and in the pieces round its nodes whose triangles may read them there, of the
 * same pass (a node's plate where the mark reaches its box; another leg of the node where the mark comes within that leg's carriageway's half width
 * of its centreline, `MARK_MARGIN` more).
 */
export function fileMarks(net: Network, lying: MarkPiece, groups: readonly MarkGroup[], passes: MarkPasses): [MarkPiece, Filed[]][] {
  const out = new Map<MarkPiece, Filed[]>();
  if (groups.length === 0) return [];
  const pass = lying.kind === 'node' ? passes.node(lying.id as NodeId) : passes.segment(lying.id as SegmentId);
  const pieces = new Map<string, MarkPiece>();
  const add = (piece: MarkPiece, group: MarkGroup): void => {
    const key = pieceName(piece);
    const known = pieces.get(key) ?? piece;
    pieces.set(key, known);
    const coordinate = coordinateOf(net, known);
    if (!coordinate) return;
    const [lo, hi] = rangeOf(coordinate, group);
    let list = out.get(known);
    if (!list) out.set(known, list = []);
    list.push({ group, lo, hi });
  };
  const nodes = lying.kind === 'node' ? [lying.id as NodeId] : (() => {
    const segment = net.doc.segment(lying.id as SegmentId);
    return segment ? [...new Set([segment.a, segment.b])] : [];
  })();
  const hit = { s: 0, distance: 0 };
  for (const group of groups) {
    add(lying, group);
    const [x0, y0, x1, y1] = group.box;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, radius = Math.hypot(x1 - x0, y1 - y0) / 2;
    for (const node of nodes) {
      const plate = net.junctions.get(node)?.get(Level.Asphalt);
      if (lying.kind !== 'node' && plate && !plate.ring.isEmpty && passes.node(node) === pass) {
        const box = plate.ring.bbox;
        if (x0 <= box.maxX + MARK_MARGIN && x1 >= box.minX - MARK_MARGIN && y0 <= box.maxY + MARK_MARGIN && y1 >= box.minY - MARK_MARGIN) add({ kind: 'node', id: node }, group);
      }
      for (const leg of net.doc.node(node)?.incident ?? []) {
        if (lying.kind === 'segment' && leg === lying.id) continue;
        if (passes.segment(leg) !== pass) continue;
        const ribbon = net.ribbons.get(leg);
        if (!ribbon) continue;
        ribbon.full.closestInto(cx, cy, hit);
        if (hit.distance <= radius + ribbon.road.width / 2 + MARK_MARGIN) add({ kind: 'segment', id: leg }, group);
      }
    }
  }
  return [...out];
}

/** How far from a road's mouth at `node` its lines along it start: its stop line or crossing (`roadStrokes`). */
function strokeCut(net: Network, ribbon: SegmentRibbon, node: NodeId | undefined, trim: number): number {
  if (node === undefined) return 0;
  const crossing = net.doc.node(node)?.crossing;
  if (net.doc.degree(node) < 3 && !crossing) return 0;
  return Math.max(0, net.stopLineDistance(ribbon.id, node) + STOP_BAR_WIDTH / 2 - trim);
}

/** A road's lines along it (`segmentAlongPaint`), from its mouth's stop line or crossing to the other's: drawn by the carriageway's shader
 *  (`mesh/roadEdges.ts`, `roadPaint.ts`). */
export function roadAlongPaint(net: Network, ribbon: SegmentRibbon): AlongPaint | null {
  const trims = net.trims.get(ribbon.id);
  const start = trims?.a[Level.Asphalt] ?? 0;
  const segment = net.doc.segment(ribbon.id);
  const cutA = strokeCut(net, ribbon, segment?.a, start);
  const cutB = strokeCut(net, ribbon, segment?.b, trims?.b[Level.Asphalt] ?? 0);
  return segmentAlongPaint(ribbon, start, cutA, cutB, net.doc.markingStyle);
}

/**
 * A node's marks, each filed on the piece it lies on (`fileMarks`), as the detail (`roadSurfaceInputs.ts`) and the far level (`networkFarTile.ts`)
 * place them: the taper's lines on its plate (in any pass, as they always were); and for a junction drawn at ground level (`ground`), as its paint
 * always was: each leg's stop line, crossings and the rule's legends on that leg's own carriageway, in whatever pass that road is drawn (DO NOT file
 * them in the plate's pass: as polygons there, a leg of another pass, a road raised by hand, had them float over its own deck or sink under it), and
 * a mini-roundabout's island on its plate.
 */
export function nodeMarks(net: Network, node: NodeId, ground: boolean, passes: MarkPasses): [MarkPiece, Filed[]][] {
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
  if (ground) {
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

/** A road's own paint along it that is not a line (`segmentMarkings`: its turn arrows, its bus lanes' legends). */
export function roadStrokes(net: Network, ribbon: SegmentRibbon): StrokeSpec[] {
  const trims = net.trims.get(ribbon.id);
  const start = trims?.a[Level.Asphalt] ?? 0;
  const segment = net.doc.segment(ribbon.id);
  // From the mouth to the stop line (or the crossing) is not painted along.
  const cutA = strokeCut(net, ribbon, segment?.a, start);
  const cutB = strokeCut(net, ribbon, segment?.b, trims?.b[Level.Asphalt] ?? 0);
  return segmentMarkings(ribbon, start, cutA, cutB, net.doc.markingStyle);
}
