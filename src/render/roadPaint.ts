import { Color, DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';
import type { AlongPaint } from '@world/markings';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { Digest } from '@core/digest';

/**
 * # THE ROADS' PAINT AS THE CARRIAGEWAY'S SHADER READS IT
 *
 * A road's lines along it and every mark painted on it are drawn by the carriageway's own shader (`mesh/roadEdges.ts`, `roadMarksShader.ts`), no
 * polygon of paint: each vertex of the carriageway carries where it is across and along its road and which piece it is on (`roadSurfaceReads.ts`
 * asphaltSection: the `roadSection` attribute, its third number the road's slot here; a junction's plate `-2 - slot` of its node), and the shader
 * reads that piece's paint here and inks it where the pixel's footprint meets it, box-filtered (Quilez, "Filterable procedurals",
 * https://iquilezles.org/articles/filterableprocedurals).
 *
 * A piece's slot is its document's own, counted out one by one as the document's roads and nodes are first asked (`roadSlot`, `nodeSlot`): the
 * same document built the same way carries the same numbers, whatever else the page holds (a tile is the same to the bit twice, a worker's the
 * page's, `tests/render/toolReference.spec.ts`). A document's slots are laid in the table a page of `PAGE` at a time, each page in the first
 * free row when it is first needed, never moved; a block's vertices are given the table's own slot as the block is made on the page
 * (`resolverOf`, `mesh/surfaceTiles.ts`): a mesh's tiles (what a worker makes, what the store keeps) never carry it.
 *
 * Two data textures (WebGL2 `texelFetch`, no filtering):
 * - the slots': four texels a road or a node at its slot (`roadSlot`, `nodeSlot`): (from, to, shift, profile), (half width, lane width, dash,
 *   period), its marks' head (`roadMarks.ts`: origin, step, buckets, first texel) and one free;
 * - the profiles': a row a set of lines shared by every road painted alike, texel 0 its count, then two texels a line: (offset, half width,
 *   broken, 0) and its colour (linear r, g, b).
 *
 * Each document its own pages: the renderer's warm-up roads and the lab's layouts, documents whose ids are the same small numbers as the city's,
 * never write over the city's paint. DO NOT make a slot of an id plus a base: a tile's ids start at 2^52 (`world/tiles.ts` tileIdBase), and the
 * table such a slot asked for threw (RangeError: Invalid typed array length). A slot counted out stays its id's while the document lives (a tile
 * loaded again brings the same ids back to the same slots); what a part's vertices carry goes into its tile's key (`partSlots`), so a part kept
 * from another session is never drawn with another's.
 */

/** Texels a row of the slots' table. */
const ROAD_ROW = 1024;
/** Texels a slot. */
export const SLOT_TEXELS = 4;
/** The texel of a slot that holds its marks' head (`roadMarks.ts`). */
export const MARKS_HEAD = 2;
/** The most lines a road paints along it (an eight-lane avenue's dividers and a double centre line: nine). */
export const MOST_LINES = 16;
const PROFILE_ROW = 1 + MOST_LINES * 2;

/** Slots a page of a document's: a row of the table. */
const PAGE = ROAD_ROW / SLOT_TEXELS;

/** A document's slots: its roads' and its nodes' (a node and a road may share an id), counted out in one run, and the table's row each page of
 *  them is laid in. */
interface DocSlots {
  readonly roads: Map<number, number>;
  readonly nodes: Map<number, number>;
  count: number;
  readonly pages: number[];
}

/** A document's slot as the table holds it (`RoadPaintTable.resolverOf`). */
type SlotResolver = (slot: number) => number;

/** The roads' paint (`uRoadSegments`, `uRoadLines`): one table for every carriageway material, grown as roads come. */
class RoadPaintTable {
  readonly segments = { value: dataTable(ROAD_ROW, 64) };
  readonly lines = { value: dataTable(PROFILE_ROW, 64) };
  /**
   * Whether the tables' changes are sent as ranges (`sendTexels`, this table's and the marks', `roadMarks.ts`): only where one renderer draws the
   * roads, the game's (`renderer.ts`, `sendTableRanges`). three's update ranges are taken by the first context that uploads the texture after they
   * are added and cleared there (WebGLTextures.js updateTexture, `clearUpdateRanges`): a second renderer drawing the roads (the lab's catalogue and
   * its sheets, each its own) took the ranges alone as its first upload, its palette never sent (every mark drawn black), or never saw a range the
   * first had taken. Elsewhere every change sends the table whole.
   */
  rangesFromOneRenderer = false;
  private readonly profiles = new Map<string, number>();
  private readonly colour = new Color();
  private readonly docs = new WeakMap<object, DocSlots>();
  /** The first row no document's page holds. */
  private rows = 0;

  private slotsOf(doc: object): DocSlots {
    let slots = this.docs.get(doc);
    if (!slots) this.docs.set(doc, slots = { roads: new Map(), nodes: new Map(), count: 0, pages: [] });
    return slots;
  }

  private slotIn(slots: DocSlots, map: Map<number, number>, id: number): number {
    let slot = map.get(id);
    if (slot === undefined) {
      slot = slots.count++;
      map.set(id, slot);
      // Its page laid in the next free row the first time one of its slots is counted out.
      if (slot % PAGE === 0) {
        slots.pages.push(this.rows++);
        this.fit(this.segments, ROAD_ROW, this.rows);
      }
    }
    return slot;
  }

  /** A road's slot in its document, counted out the first time it is asked. */
  roadSlot(doc: object, id: SegmentId): number {
    const slots = this.slotsOf(doc);
    return this.slotIn(slots, slots.roads, id);
  }

  /** A node's slot in its document (its junction's plate), counted out the first time it is asked. */
  nodeSlot(doc: object, id: NodeId): number {
    const slots = this.slotsOf(doc);
    return this.slotIn(slots, slots.nodes, id);
  }

  /** Where a document's slots are in the table: what a block's vertices are given (`mesh/surfaceTiles.ts`). */
  resolverOf(doc: object): SlotResolver {
    const slots = this.slotsOf(doc);
    return (slot) => {
      const row = slots.pages[Math.floor(slot / PAGE)];
      if (row === undefined) throw new Error(`slot ${slot} was never counted out in its document (${slots.count} were)`);
      return row * PAGE + (slot % PAGE);
    };
  }

  /** Writes a road's lines and its widths at its slot: the slot its vertices carry (its document's, `roadSlot`). */
  set(doc: object, id: SegmentId, paint: AlongPaint | null, half: number, lane: number): number {
    const slot = this.roadSlot(doc, id);
    const profile = paint ? this.profileOf(paint) : -1;
    this.write(this.resolverOf(doc)(slot), 0, [paint?.from ?? 0, paint?.to ?? 0, paint?.shift ?? 0, profile, half, lane, paint?.dash ?? 1, paint?.period ?? 0]);
    return slot;
  }

  /** Writes a slot's marks' head (`roadMarks.ts`, the slot its document's): where its buckets start along (or across a plate), their step, how many
   *  and the first. */
  setMarksHead(doc: object, slot: number, origin: number, step: number, count: number, start: number): void {
    this.write(this.resolverOf(doc)(slot), MARKS_HEAD, [origin, step, count, start]);
  }

  /** The texels of one slot of the table (`resolverOf`) from its texel `texel` on, set to `values`; only those sent again (`Texture.addUpdateRange`). */
  private write(slot: number, texel: number, values: readonly number[]): void {
    const at = slot * SLOT_TEXELS + texel;
    const texture = this.segments.value;
    const data = texture.image.data as Float32Array;
    let changed = false;
    for (let k = 0; k < values.length; k++) if (data[at * 4 + k] !== values[k]) { data[at * 4 + k] = values[k]!; changed = true; }
    if (changed) sendTexels(texture, at, values.length / 4);
  }

  /** A digest of the slots the vertices of a piece may carry (`roadSurfaces.ts`, a tile's key): a road's, its ends' and their roads'; a node's and its
   *  roads' and their ends'. The slots are counted out here if they were not: a part built off the page carries them before its roads are looked at. */
  partSlots(net: Network, piece: { readonly kind: 'segment' | 'node'; readonly id: number }): number {
    const doc = net.doc;
    const digest = new Digest();
    const node = (id: NodeId): void => {
      digest.add(this.nodeSlot(doc, id));
      for (const road of doc.node(id)?.incident ?? []) {
        const segment = doc.segment(road);
        digest.add(this.roadSlot(doc, road));
        if (segment) digest.add(this.nodeSlot(doc, segment.a)).add(this.nodeSlot(doc, segment.b));
      }
    };
    if (piece.kind === 'segment') {
      const segment = doc.segment(piece.id as SegmentId);
      digest.add(this.roadSlot(doc, piece.id as SegmentId));
      if (segment) { node(segment.a); node(segment.b); }
    } else node(piece.id as NodeId);
    return digest.value();
  }

  /** The row of a set of lines, written the first time it is met. */
  private profileOf(paint: AlongPaint): number {
    const lines = paint.lines.slice(0, MOST_LINES);
    const key = lines.map((l) => `${l.offset.toFixed(4)},${l.width.toFixed(4)},${l.color},${l.dashed ? 1 : 0}`).join(';');
    const known = this.profiles.get(key);
    if (known !== undefined) return known;
    const row = this.profiles.size;
    this.profiles.set(key, row);
    this.fit(this.lines, PROFILE_ROW, row + 1);
    const data = this.lines.value.image.data as Float32Array;
    const o = row * PROFILE_ROW * 4;
    data[o] = lines.length;
    lines.forEach((l, k) => {
      const t = o + (1 + k * 2) * 4;
      data[t] = l.offset; data[t + 1] = l.width / 2; data[t + 2] = l.dashed ? 1 : 0; data[t + 3] = 0;
      // The paint's own tone as its material had it (the colour at 0.88), linear.
      this.colour.set(l.color).multiplyScalar(0.88);
      data[t + 4] = this.colour.r; data[t + 5] = this.colour.g; data[t + 6] = this.colour.b; data[t + 7] = 1;
    });
    this.lines.value.needsUpdate = true;
    return row;
  }

  /** A table grown (twice the rows, its texels kept) until it has `rows`. */
  private fit(slot: { value: DataTexture }, width: number, rows: number): void {
    const old = slot.value;
    let height = old.image.height;
    if (rows <= height) return;
    while (height < rows) height *= 2;
    const grown = dataTable(width, height);
    (grown.image.data as Float32Array).set(old.image.data as Float32Array);
    slot.value = grown;
    old.dispose();
  }
}

/** Where a data table says it has not been sent whole yet (`dataTable`): its first upload is whole, never a range of it. */
const WHOLE = 'sendWhole';

/** A float RGBA data table, read by `texelFetch` (no filtering), sent whole at its first upload (`sendTexels`). */
export function dataTable(width: number, height: number): DataTexture {
  const t = new DataTexture(new Float32Array(width * height * 4), width, height, RGBAFormat, FloatType);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.userData[WHOLE] = true;
  t.onUpdate = () => { t.userData[WHOLE] = false; };
  t.needsUpdate = true;
  return t;
}

/** The game's renderer is the only one that draws the roads: the tables' changes sent as ranges from now on (`sendTexels`). */
export function sendTableRanges(): void {
  roadPaint.rangesFromOneRenderer = true;
}

/**
 * Texels `start` to `start + count` of a data table sent to the GPU again, the rest left: three r186's update ranges (`Texture.addUpdateRange`, one
 * `texSubImage2D` a range, https://threejs.org/docs/#api/en/textures/Texture.updateRanges), each cut at the rows' ends (three sends a range as one row
 * from its first texel: one past the row's end is a GL error). DO NOT send a range of a table not yet sent: its first upload would be the ranges
 * alone (WebGLTextures.js uploadTexture: texStorage2D, then the ranges). With more than one renderer drawing the roads, the table whole
 * (`sendTableRanges`).
 */
export function sendTexels(texture: DataTexture, start: number, count: number): void {
  if (count <= 0) return;
  texture.needsUpdate = true;
  if (!roadPaint.rangesFromOneRenderer || texture.userData[WHOLE] === true) return;
  const width = texture.image.width;
  for (let at = start, end = start + count; at < end;) {
    const rowEnd = (Math.floor(at / width) + 1) * width;
    const to = Math.min(end, rowEnd);
    texture.addUpdateRange(at * 4, (to - at) * 4);
    at = to;
  }
}

/** The page's table: the carriageway's materials read it (`mesh/roadEdges.ts`), each road's look writes it (`roadSurfacePass.ts` lookOf). */
export const roadPaint = new RoadPaintTable();

/** Texels a row of the slots' table, for the shader. */
export const ROAD_PAINT_ROW = ROAD_ROW;
