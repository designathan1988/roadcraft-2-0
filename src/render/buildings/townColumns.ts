import { IdSlots, grown } from '@core/idSlots';
import { buildingHeight, storedBounds } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import {
  MARK_FLIES, MARK_SIGNATURE, SUMMARY_GROUND_MAX_X, SUMMARY_GROUND_MAX_Y, SUMMARY_GROUND_MIN_X, SUMMARY_GROUND_MIN_Y, SUMMARY_HEIGHT, SUMMARY_MARKS,
  SUMMARY_MASS_SIG, SUMMARY_SIG, fliesFlag, isSignature, recordDigests, wornDigest,
} from '@world/buildings/summary';
import { BATCH_CELL } from './layerCells';

/** WHAT THE BUILDINGS LAYER KEEPS OF EACH BUILDING, AS NUMBERS IN COLUMNS BY ITS ID (`layer.ts`): its digests, its place and box, its cell and what it flies; never its record (report "Arquitetura para cidades grandes": the table is the source of truth, a record is decoded while it is read). A record is read once when it comes or changes (`file`), and again only where its cell is made near the camera. */

/** Set once the record's numbers are in its columns (`file`); cleared when the diary names it (`stale`). */
export const KNOWN = 1;
/** It flies a flag (`buildings/summary.ts` `fliesFlag`): its summary is asked even far (the flags). */
export const FLIES = 2;
/** A signature building (`signature.ts` `drawsSignature`): its body drawn with parts of its own. */
export const SIGNATURE = 4;
/** Shown by the layer (not hidden by the preview nor a ruin): its flags read from what is kept of it. */
export const SHOWN = 8;
/** What the workers emitted of it is kept (`keptSig`, `keptDigest`). */
export const KEPT = 16;
/** Filed in the town (`TownIndex`), in the cell `filedI`, `filedJ`. */
export const FILED = 32;

/** The digests of a record (`buildings/summary.ts`): the same the tables' summary columns hold. */
export { recordDigests };

export class TownColumns {
  private readonly slots = new IdSlots(1024);
  /** The digests of the members the records filed share (`recordDigests`). */
  readonly members = new WeakMap<object, number>();
  flags = new Uint8Array(16);
  /** The id held at each slot. */
  ids = new Float64Array(16);
  /** The anchor (the cell is worked out of it). */
  x = new Float64Array(16);
  y = new Float64Array(16);
  /** Its stored box (`storedBounds`), and its height over its foot. */
  minX = new Float32Array(16);
  minY = new Float32Array(16);
  maxX = new Float32Array(16);
  maxY = new Float32Array(16);
  height = new Float32Array(16);
  /** The box of the ground it reads (`storedBounds` grown by its module twice: `layerCells.ts` `groundDigest`). */
  groundMinX = new Float64Array(16);
  groundMinY = new Float64Array(16);
  groundMaxX = new Float64Array(16);
  groundMaxY = new Float64Array(16);
  /** Its record's digest, with and without its wear. */
  sig = new Float64Array(16);
  massSig = new Float64Array(16);
  /** What the kept summary was made of (`KEPT`): its record's and its ground's digests. */
  keptSig = new Float64Array(16);
  keptDigest = new Float64Array(16);
  /** The cell it is filed in (`FILED`): where it stood when last filed, whatever its record says now. */
  filedI = new Int32Array(16);
  filedJ = new Int32Array(16);

  constructor() {
    this.slots.onGrow = (n) => {
      this.flags = grown(this.flags, n);
      this.ids = grown(this.ids, n);
      this.x = grown(this.x, n); this.y = grown(this.y, n);
      this.minX = grown(this.minX, n); this.minY = grown(this.minY, n); this.maxX = grown(this.maxX, n); this.maxY = grown(this.maxY, n);
      this.height = grown(this.height, n);
      this.groundMinX = grown(this.groundMinX, n); this.groundMinY = grown(this.groundMinY, n);
      this.groundMaxX = grown(this.groundMaxX, n); this.groundMaxY = grown(this.groundMaxY, n);
      this.sig = grown(this.sig, n); this.massSig = grown(this.massSig, n);
      this.keptSig = grown(this.keptSig, n); this.keptDigest = grown(this.keptDigest, n);
      this.filedI = grown(this.filedI, n); this.filedJ = grown(this.filedJ, n);
    };
  }

  get size(): number {
    return this.slots.size;
  }

  /** The slot of an id; -1 when it has none. */
  slotOf(id: number): number {
    return this.slots.get(id);
  }

  /** The id held at a slot. */
  idOf(slot: number): number {
    return this.ids[slot]!;
  }

  /** Whether an id's numbers are those of its record now (filed since the diary last named it). */
  known(id: number): boolean {
    const slot = this.slots.get(id);
    return slot >= 0 && (this.flags[slot]! & KNOWN) !== 0;
  }

  /** A record's numbers put in its columns (what was kept of it and whether it is shown stay). */
  file(b: Building): number {
    const slot = this.slots.take(b.id);
    this.ids[slot] = b.id;
    const box = storedBounds(b);
    const { sig, massSig } = recordDigests(b, this.members);
    this.x[slot] = b.x; this.y[slot] = b.y;
    this.minX[slot] = box.minX; this.minY[slot] = box.minY; this.maxX[slot] = box.maxX; this.maxY[slot] = box.maxY;
    this.height[slot] = buildingHeight(b);
    const ground = storedBounds(b, b.module * 2);
    this.groundMinX[slot] = ground.minX; this.groundMinY[slot] = ground.minY; this.groundMaxX[slot] = ground.maxX; this.groundMaxY[slot] = ground.maxY;
    this.sig[slot] = sig;
    this.massSig[slot] = massSig;
    let flags = (this.flags[slot]! & (SHOWN | KEPT | FILED)) | KNOWN;
    if (fliesFlag(b)) flags |= FLIES;
    if (isSignature(b)) flags |= SIGNATURE;
    this.flags[slot] = flags;
    return slot;
  }

  /**
   * A row of the town's table put in its columns from the table's own (its place, its box, its summary: `buildings/summary.ts`), its record
   * never decoded: the same numbers `file` reads out of the record. `summary` holds column c of the row at `summary[c * rows + row]`; `wear`,
   * the wear written over the row (`TableItems.writeField`, NaN: none), its digest worked out of the one without its wear (`wornDigest`).
   */
  fileRow(id: number, x: number, y: number, box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number },
    summary: Float64Array, rows: number, row: number, wear = Number.NaN): number {
    const slot = this.slots.take(id);
    const at = (c: number): number => summary[c * rows + row]!;
    this.ids[slot] = id;
    this.x[slot] = x; this.y[slot] = y;
    this.minX[slot] = box.minX; this.minY[slot] = box.minY; this.maxX[slot] = box.maxX; this.maxY[slot] = box.maxY;
    this.height[slot] = at(SUMMARY_HEIGHT);
    this.groundMinX[slot] = at(SUMMARY_GROUND_MIN_X); this.groundMinY[slot] = at(SUMMARY_GROUND_MIN_Y);
    this.groundMaxX[slot] = at(SUMMARY_GROUND_MAX_X); this.groundMaxY[slot] = at(SUMMARY_GROUND_MAX_Y);
    this.sig[slot] = Number.isNaN(wear) ? at(SUMMARY_SIG) : wornDigest(at(SUMMARY_MASS_SIG), wear);
    this.massSig[slot] = at(SUMMARY_MASS_SIG);
    const marks = at(SUMMARY_MARKS);
    let flags = (this.flags[slot]! & (SHOWN | KEPT | FILED)) | KNOWN;
    if (marks & MARK_FLIES) flags |= FLIES;
    if (marks & MARK_SIGNATURE) flags |= SIGNATURE;
    this.flags[slot] = flags;
    return slot;
  }

  /** The record of an id changed (the diary named it): its numbers read again when next asked. */
  stale(id: number): void {
    const slot = this.slots.get(id);
    if (slot >= 0) this.flags[slot]! &= ~KNOWN;
  }

  /** An id gone from the document: its slot handed back. */
  drop(id: number): void {
    const slot = this.slots.get(id);
    if (slot < 0) return;
    this.flags[slot] = 0;
    this.slots.delete(id);
  }

  /** Every id let go (another document, the whole town filed again). */
  clear(): void {
    this.slots.clear();
    this.flags.fill(0);
  }

  /** Every id held, with its slot. */
  forEach(visit: (id: number, slot: number) => void): void {
    this.slots.forEach(visit);
  }

  has(slot: number, flag: number): boolean {
    return slot >= 0 && (this.flags[slot]! & flag) !== 0;
  }

  set(slot: number, flag: number, on: boolean): void {
    if (slot < 0) return;
    if (on) this.flags[slot]! |= flag; else this.flags[slot]! &= ~flag;
  }

  /** The coarse cell an id is filed in (`BATCH_CELL`), from its anchor. */
  cellOf(slot: number): string {
    return `${Math.floor(this.x[slot]! / BATCH_CELL)},${Math.floor(this.y[slot]! / BATCH_CELL)}`;
  }
}
