import { m } from '@world/units';
import { isMass, roofRise, storedBounds, volumeElevation, volumeHeight } from './geometry';
import { IdSlots, grown } from '@core/idSlots';
import { BuildingStore } from './store';
import { type Building, type BuildingId, volumeTop } from './types';

/** THE LOWEST THE CAMERA'S EYE MAY STAND OVER THE BUILDINGS, a continuous function of the map point */

/** How far over a roof the eye keeps, world units. */
const CLEARANCE = m(1);
/** How far round a volume its floor eases down to the building's foot, world units: the camera's radius */
const REACH = m(2);
/** The grid the volumes are filed in, world units a cell. */
const CELL = m(50);

/** DO NOT go back to an object per volume and a set per building: 29 MB of a city of 5 400. */
const STRIDE = 14;
const S_BX = 0, S_BY = 1, S_COS = 2, S_SIN = 3, S_X0 = 4, S_Y0 = 5, S_X1 = 6, S_Y1 = 7, S_FOOT = 8, S_TOP = 9;
/** What the volume surely hides (`forEachOccluder`): the bottom and top of its walls, world height, its plan inset by `S_INSET`; NaN when it hides nothing for sure (a building with voids, a volume of its own outline). */
const S_WALL0 = 10, S_WALL1 = 11, S_INSET = 12;
/** The slot of the next solid volume of the same building (-1: its last): a building's volumes a chain from its first (`SolidFiling.first`). */
const S_NEXT = 13;
/** How far the occluder's plan is drawn in from the volume's: the reliefs pushed into its faces, and a margin. */
const OCCLUDER_MARGIN = m(0.6);
const PAGE_BITS = 12;
const PAGE = 1 << PAGE_BITS;

class SolidPages {
  private pages: Float64Array[] = [];
  /** Each slot's last visit (`visitOnce`): a volume filed in several cells is visited once a walk. */
  private stamps: Uint32Array[] = [];
  private epoch = 0;
  private free: number[] = [];
  private next = 0;

  /** A slot for one volume, from the free list or a new one (a page added when it is the first of one). */
  take(): number {
    const slot = this.free.pop() ?? this.next++;
    while (this.pages.length <= slot >>> PAGE_BITS) {
      this.pages.push(new Float64Array(PAGE * STRIDE));
      this.stamps.push(new Uint32Array(PAGE));
    }
    return slot;
  }

  /** A new walk: no slot visited in it yet. */
  walk(): void {
    this.epoch = (this.epoch + 1) >>> 0;
    if (this.epoch === 0) { for (const s of this.stamps) s.fill(0); this.epoch = 1; }
  }

  /** True the first time `slot` is met in this walk. */
  visitOnce(slot: number): boolean {
    const stamps = this.stamps[slot >>> PAGE_BITS]!, k = slot & (PAGE - 1);
    if (stamps[k] === this.epoch) return false;
    stamps[k] = this.epoch;
    return true;
  }

  give(slot: number): void {
    this.free.push(slot);
  }

  /** The page holding `slot`, read at `at(slot) + S_*`. */
  page(slot: number): Float64Array {
    return this.pages[slot >>> PAGE_BITS]!;
  }

  clear(): void {
    this.pages = [];
    this.stamps = [];
    this.free = [];
    this.next = 0;
  }
}

/** Where a slot's numbers start in its page. */
const at = (slot: number): number => (slot & (PAGE - 1)) * STRIDE;

export interface CameraSolids {
  /** The lowest the eye may stand at (x, y), world height; -Infinity away from every building. */
  floorAt(x: number, y: number): number;
  /** The roof over (x, y) when the point is inside a solid volume's plan (its highest, no margin round it), world height */
  roofAt(x: number, y: number): number;
  /** Every solid volume filed in the cells over a map rectangle, once, as its building's frame */
  forEachIn(x0: number, y0: number, x1: number, y1: number, visit: SolidVisit): void;
  /** Every solid volume filed in the cells over any of the rectangles, once for all of them. */
  forEachInAny(rects: readonly Rect[], visit: SolidVisit): void;
  /** Every volume over a map rectangle that surely hides what stands behind it (`render/occlusion.ts`): the box of its walls drawn in by its reliefs, never its roof. */
  forEachOccluder(x0: number, y0: number, x1: number, y1: number, visit: OccluderVisit): void;
}

/** An occluder as its building's frame: the building's centre and turn, the box in that frame, the walls' bottom and top (world height). */
export type OccluderVisit = (bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, bottom: number, top: number) => void;

/** A solid volume as its building's frame: the building's centre and turn, the volume's box in that frame, its top. */
export type SolidVisit = (bx: number, by: number, cos: number, sin: number, lx0: number, ly0: number, lx1: number, ly1: number, top: number) => void;

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** A world rectangle: [minX, minY, maxX, maxY]. */
export type Rect = readonly [number, number, number, number];

/** Where and when the ground the buildings stand on changed (the diary's ground kinds, `render/renderer.ts`). */
export interface GroundSince {
  /** The serial of the latest change of the ground. */
  readonly version: number;
  /** Where the ground changed after `since`; null when the diary cannot say (everywhere). */
  rectsSince(since: number): readonly Rect[] | null;
}

/** A building's solid volumes as a job worked them out (`solidRowsOf`): its rows on no floor, and whether its blocks are its volumes. */
export interface SolidRows { readonly id: number; readonly rows: Float64Array; readonly blocksAreVolumes: boolean }
/** The solids of `ids` worked out off the page (`render/buildings/solidJobs.ts`), asked nearest `at` first. */
export type SolidsAsk = (ids: readonly BuildingId[], buildings: BuildingStore, at: readonly [number, number]) => Promise<readonly SolidRows[]>;

/** What the cells are filled with off the page (`CameraSolidsKeeper.prefetch`). */
export interface SolidsOffPage {
  readonly ask: SolidsAsk;
  /** A building's floor known without its record (the floor kept of its row, or the one the cells' jobs measured where its blocks are its
   *  volumes: `floors.ts`); undefined: worked out from its record (`floorAt`). */
  footOf(id: BuildingId, blocksAreVolumes: boolean): number | undefined;
  /** A cell filed from off the page: what the camera and the canyon light read there may have changed (a frame asked). */
  arrived?(): void;
}

/** The town's solids as filed for the camera */
export interface CameraSolidsKeeper {
  /** Moves whenever the filing changed: what the canyon light's picture stands for. */
  readonly key: string;
  /** Takes in the buildings and the ground; true when the filing changed since the last `follow`. */
  follow(buildings: BuildingStore, ground: GroundSince): boolean;
  /** The filing, brought up to the last `follow` on the first ask after it. */
  solids(): CameraSolids;
  /** The cells over the rectangles not filled yet asked of the jobs (`SolidsOffPage`), filed as their answers come: what the questions will
   *  reach next (the canyon light's window, the occluders round the eye). Nothing without a job queue. */
  prefetch(rects: readonly Rect[]): void;
}

/**
 * DO NOT file the town again for one building. DO NOT file the whole town to answer the camera: a cell of `CELL` is filled the first time a
 * question reaches it (the eye's point, the canyon light's window, the occluders round the eye: `fill`), from the buildings the store files
 * near it by their box columns (`BuildingStore.nearIds`), each building filed once with all its volumes. The 10 km city's 249,122 buildings
 * were decoded and floored on the page in the first frame of a tilted view, 55 s of its opening (2026-10-26).
 */
/**
 * `offPage`: the cells asked ahead of the questions are filed from a job's answer (`prefetch`): each building's volumes worked out there from its
 * table row, stood here on the floor known of it (`SolidsOffPage.footOf`), a building changed since it was asked filed from its record as it
 * stands. DO NOT decode a moving view's cells' buildings on the page to file them: their records and their solids were 1.0 s of 16 s of frames
 * of a camera move over the 10 km city (2026-10-27). A question reaching a cell not filed yet fills it here, as without the jobs.
 */
export function cameraSolidsKeeper(floorAt: (b: Building) => number, boxOf: (b: Building) => Rect, reach: number,
  offPage: SolidsOffPage | null = null): CameraSolidsKeeper {
  const filing = new SolidFiling();
  /** The cells whose every building is filed. */
  const filled = new Set<number>();
  /** The cells asked of the jobs and not come, each with the change serial it was asked at (`changedAt`). */
  const asking = new Map<number, number>();
  /** Each building named changed, by the serial of the `follow` that named it, while some cell is being asked; `wholeAt`, the serial the
   *  filing was last let go whole at (every answer asked before it dropped). */
  const changedAt = new Map<BuildingId, number>();
  let serial = 0, wholeAt = 0;
  /** The cells of the last `prefetch` (DO NOT look again at every cell of a view that stands: thousands a frame). */
  let prefetched = '';
  let buildings: BuildingStore | null = null;
  /** The cells over a rectangle filled: each building a volume of which may be filed in one of them (its box grown by `REACH`, `forEachCellOf`) filed, once. */
  const fill = (x0: number, y0: number, x1: number, y1: number): void => {
    const town = buildings;
    if (!town) return;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const key = cellKey(cx, cy);
        if (filled.has(key)) continue;
        filled.add(key);
        for (const id of town.nearIds(cx * CELL - REACH, cy * CELL - REACH, (cx + 1) * CELL + REACH, (cy + 1) * CELL + REACH)) {
          if (filing.has(id)) continue;
          const b = town.get(id);
          if (b) filing.add(b, floorAt(b));
        }
      }
    }
  };
  /** Whether a building's box grown by `REACH` meets a cell filled: filed there again when it changes. */
  const inFilled = (b: Building): boolean => {
    const box = storedBounds(b);
    for (let cx = Math.floor((box.minX - REACH) / CELL); cx <= Math.floor((box.maxX + REACH) / CELL); cx++) {
      for (let cy = Math.floor((box.minY - REACH) / CELL); cy <= Math.floor((box.maxY + REACH) / CELL); cy++) if (filled.has(cellKey(cx, cy))) return true;
    }
    return false;
  };
  /** The filing as the questions read it: each cell they reach filled first. */
  const asked: CameraSolids = {
    floorAt: (x, y) => { fill(x, y, x, y); return filing.floorAt(x, y); },
    roofAt: (x, y) => { fill(x, y, x, y); return filing.roofAt(x, y); },
    forEachIn: (x0, y0, x1, y1, visit) => { fill(x0, y0, x1, y1); filing.forEachIn(x0, y0, x1, y1, visit); },
    forEachInAny: (rects, visit) => { for (const r of rects) fill(r[0], r[1], r[2], r[3]); filing.forEachInAny(rects, visit); },
    forEachOccluder: (x0, y0, x1, y1, visit) => { fill(x0, y0, x1, y1); filing.forEachOccluder(x0, y0, x1, y1, visit); },
  };
  const read = BuildingStore.cursor();
  let groundSeen = -1;
  /** Buildings to file again at the next ask (named by the diary, or the ground moved under them), or the whole town. */
  const pending = new Set<BuildingId>();
  let whole = true;
  let version = 0;
  return {
    get key() { return String(version); },
    follow(town, ground) {
      if (town !== buildings) { buildings = town; whole = true; }
      const was = pending.size;
      const wholeWas = whole;
      // Another store is another diary: the cursor reads it as everything changed.
      const ids = town.changedFor(read);
      serial++;
      if (ids) for (const id of ids) { pending.add(id); if (asking.size) changedAt.set(id, serial); }
      else whole = true;
      if (groundSeen !== ground.version) {
        const rects = groundSeen < 0 ? null : ground.rectsSince(groundSeen);
        if (rects === null) whole = true;
        else if (!whole) {
          // Every change in one look (`nearAny`): a change at a time read the cells they share again for each.
          for (const b of town.nearAny(rects, reach, (b, r) => overlaps(boxOf(b), r))) { pending.add(b.id); if (asking.size) changedAt.set(b.id, serial); }
        }
        groundSeen = ground.version;
      }
      // The first follow, or a building named since the filing was last asked for.
      if (version > 0 && pending.size === was && whole === wholeWas) return false;
      version++;
      return true;
    },
    solids() {
      if (whole) {
        // The diary cannot say what changed: every cell let go, filled again as the questions reach it.
        filing.clear();
        filled.clear();
        whole = false;
        wholeAt = serial;
        prefetched = '';
      } else {
        for (const id of pending) {
          filing.remove(id);
          const b = buildings?.get(id);
          if (b && inFilled(b)) filing.add(b, floorAt(b));
        }
      }
      pending.clear();
      return asked;
    },
    prefetch(rects) {
      const town = buildings;
      if (!offPage || !town || whole) return;
      const range = rects.map((r) => `${Math.floor(r[0] / CELL)},${Math.floor(r[1] / CELL)},${Math.floor(r[2] / CELL)},${Math.floor(r[3] / CELL)}`).join('|');
      if (range === prefetched) return;
      prefetched = range;
      for (const [x0, y0, x1, y1] of rects) for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const key = cellKey(cx, cy);
          if (filled.has(key) || asking.has(key)) continue;
          const ids = town.nearIds(cx * CELL - REACH, cy * CELL - REACH, (cx + 1) * CELL + REACH, (cy + 1) * CELL + REACH).filter((id) => !filing.has(id));
          if (!ids.length) { filled.add(key); continue; }
          const askedAt = serial;
          asking.set(key, askedAt);
          const landed = (answers: readonly SolidRows[]): void => {
            asking.delete(key);
            if (town === buildings && askedAt >= wholeAt && !filled.has(key)) {
              const rows = new Map(answers.map((a) => [a.id as BuildingId, a]));
              for (const id of ids) {
                if (filing.has(id)) continue;
                const answer = rows.get(id);
                const changed = (changedAt.get(id) ?? -1) > askedAt;
                const foot = answer && !changed ? offPage.footOf(id, answer.blocksAreVolumes) : undefined;
                if (answer && !changed && foot !== undefined) { filing.addRows(id, answer.rows, foot); continue; }
                // Changed since it was asked, or no floor known of it: as the page files it, from its record as it stands.
                const b = town.get(id);
                if (b) filing.add(b, floorAt(b));
              }
              filled.add(key);
              offPage.arrived?.();
            }
            if (!asking.size) changedAt.clear();
          };
          offPage.ask(ids, town, [(cx + 0.5) * CELL, (cy + 0.5) * CELL]).then(landed, (error: unknown) => {
            console.error('[buildings] a cell of the camera\'s solids could not be worked out off the page; filled when asked', error);
            asking.delete(key);
            if (!asking.size) changedAt.clear();
          });
        }
      }
    },
  };
}

const overlaps = (a: Rect, b: Rect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const cellKey = (cx: number, cy: number): number => (cx + 4096) * 8192 + (cy + 4096);

/** Numbers of a building's solid volume as it stands on no floor (`solidRowsOf`): the building's centre and turn, the volume's box in its frame,
 *  its top over the floor (with `CLEARANCE`), the bottom and top of its walls over the floor (NaN: it hides nothing for sure), their inset. */
export const SOLID_ROW = 12;
const R_BX = 0, R_BY = 1, R_COS = 2, R_SIN = 3, R_X0 = 4, R_Y0 = 5, R_X1 = 6, R_Y1 = 7, R_TOP = 8, R_WALL0 = 9, R_WALL1 = 10, R_INSET = 11;

/**
 * A building's solid volumes as numbers on no floor (`SOLID_ROW` each), and whether every volume of it is its own block (none a void, an
 * intersection or an exclusive one: the floor the cells' jobs measure is its floor, `floors.ts` measured). The same on the page and in a job
 * (`cameraSolid.worker.ts`): the floor added where they are filed (`SolidFiling.addRows`).
 */
export function solidRowsOf(b: Building): { readonly rows: Float64Array; readonly blocksAreVolumes: boolean } {
  const cos = Math.cos(b.rotation);
  const sin = Math.sin(b.rotation);
  // A building carved by a void or an intersection hides nothing for sure: its masses' union is not its solid.
  const carved = b.volumes.some((v) => !v.open && !isMass(v));
  const solid = b.volumes.filter((v) => !v.open && isMass(v));
  const rows = new Float64Array(solid.length * SOLID_ROW);
  solid.forEach((v, k) => {
    const o = k * SOLID_ROW;
    rows[o + R_BX] = b.x; rows[o + R_BY] = b.y; rows[o + R_COS] = cos; rows[o + R_SIN] = sin;
    rows[o + R_X0] = v.x; rows[o + R_Y0] = v.y; rows[o + R_X1] = v.x + v.w; rows[o + R_Y1] = v.y + v.d;
    rows[o + R_TOP] = volumeHeight(b, v) + roofRise(b, v) + CLEARANCE;
    // Its walls, drawn in by the deepest relief pushed into them: what surely stands (its roof left out, a ridge hides less than its box).
    let inset = OCCLUDER_MARGIN;
    for (const r of v.reliefs ?? []) if (r.depth < 0) inset = Math.max(inset, -r.depth + OCCLUDER_MARGIN);
    const solidWalls = !carved && !v.outline && v.w > 2 * inset && v.d > 2 * inset && v.storeys.length > 0;
    rows[o + R_WALL0] = solidWalls ? Math.max(0, volumeElevation(b, v, v.base)) : NaN;
    rows[o + R_WALL1] = solidWalls ? volumeElevation(b, v, volumeTop(v)) : NaN;
    rows[o + R_INSET] = inset;
  });
  return { rows, blocksAreVolumes: !b.volumes.some((v) => v.mode) };
}

/** The cells a volume's world box grown by the reach touches (its numbers at `o` in `page`), each told once. */
function forEachCellOf(page: Float64Array, o: number, visit: (key: number) => void): void {
  const bx = page[o + S_BX]!, by = page[o + S_BY]!, cos = page[o + S_COS]!, sin = page[o + S_SIN]!;
  const x0 = page[o + S_X0]!, y0 = page[o + S_Y0]!, x1 = page[o + S_X1]!, y1 = page[o + S_Y1]!;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let corner = 0; corner < 4; corner++) {
    const lx = corner === 0 || corner === 3 ? x0 : x1;
    const ly = corner < 2 ? y0 : y1;
    const wx = bx + lx * cos - ly * sin;
    const wy = by + lx * sin + ly * cos;
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
  }
  for (let cx = Math.floor((minX - REACH) / CELL); cx <= Math.floor((maxX + REACH) / CELL); cx++) {
    for (let cy = Math.floor((minY - REACH) / CELL); cy <= Math.floor((maxY + REACH) / CELL); cy++) visit(cellKey(cx, cy));
  }
}

/** The solid volumes filed by cell (their slots in `SolidPages`), each building's taken out and filed again on its own. */
class SolidFiling implements CameraSolids {
  private readonly pages = new SolidPages();
  private readonly cells = new Map<number, number[]>();
  /** DO NOT keep each building's record and arrays of its slots and cells (a `Map` entry, a record held decoded and two arrays a building of the map): its first volume's slot by its id, in a column (`IdSlots`), the rest chained in the pages (`S_NEXT`), its cells worked out again from its volumes' boxes when it is taken out. */
  private readonly filedIds = new IdSlots(1024);
  private first = new Int32Array(16);

  constructor() {
    this.filedIds.onGrow = (n) => { this.first = grown(this.first, n); };
  }

  clear(): void {
    this.cells.clear();
    this.filedIds.clear();
    this.pages.clear();
  }

  /** Whether a building is filed (with its volumes, or as one with none). */
  has(id: BuildingId): boolean {
    return this.filedIds.get(id) >= 0;
  }

  /** `b`'s solid volumes filed, standing on `foot`. */
  add(b: Building, foot: number): void {
    this.addRows(b.id, solidRowsOf(b).rows, foot);
  }

  /** A building's solid volumes filed from their numbers on no floor (`solidRowsOf`, made here or by a job), standing on `foot`. */
  addRows(id: BuildingId, rows: Float64Array, foot: number): void {
    let head = -1, last = -1;
    for (let r = 0; r < rows.length; r += SOLID_ROW) {
      const solid = this.pages.take();
      const page = this.pages.page(solid), o = at(solid);
      page[o + S_BX] = rows[r + R_BX]!; page[o + S_BY] = rows[r + R_BY]!; page[o + S_COS] = rows[r + R_COS]!; page[o + S_SIN] = rows[r + R_SIN]!;
      page[o + S_X0] = rows[r + R_X0]!; page[o + S_Y0] = rows[r + R_Y0]!; page[o + S_X1] = rows[r + R_X1]!; page[o + S_Y1] = rows[r + R_Y1]!;
      page[o + S_FOOT] = foot; page[o + S_TOP] = foot + rows[r + R_TOP]!;
      page[o + S_WALL0] = foot + rows[r + R_WALL0]!;
      page[o + S_WALL1] = foot + rows[r + R_WALL1]!;
      page[o + S_INSET] = rows[r + R_INSET]!;
      page[o + S_NEXT] = -1;
      if (last >= 0) this.pages.page(last)[at(last) + S_NEXT] = solid; else head = solid;
      last = solid;
      // The world box of the volume grown by the reach, filed in every cell it touches.
      forEachCellOf(page, o, (k) => {
        const list = this.cells.get(k);
        if (list) list.push(solid);
        else this.cells.set(k, [solid]);
      });
    }
    // Its slot taken first: taking it may grow the column (`onGrow`); one with no solid volume filed too (-1), never read again for a cell.
    const filed = this.filedIds.take(id);
    this.first[filed] = head;
  }

  /** The building's solids taken out of their cells. */
  remove(id: BuildingId): void {
    const filed = this.filedIds.get(id);
    if (filed < 0) return;
    for (let slot = this.first[filed]!; slot >= 0;) {
      const page = this.pages.page(slot), o = at(slot);
      forEachCellOf(page, o, (k) => {
        const list = this.cells.get(k);
        if (!list) return;
        const i = list.indexOf(slot);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.cells.delete(k);
      });
      const next = page[o + S_NEXT]!;
      this.pages.give(slot);
      slot = next;
    }
    this.filedIds.delete(id);
  }

  forEachIn(x0: number, y0: number, x1: number, y1: number, visit: SolidVisit): void {
    this.pages.walk();
    this.visitCells(x0, y0, x1, y1, visit);
  }

  forEachInAny(rects: readonly Rect[], visit: SolidVisit): void {
    this.pages.walk();
    for (let i = 0; i < rects.length; i++) { const box = rects[i]!; this.visitCells(box[0], box[1], box[2], box[3], visit); }
  }

  /** The slots filed over a rectangle not yet met in this walk. */
  private visitCells(x0: number, y0: number, x1: number, y1: number, visit: SolidVisit): void {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const slot of list) {
          if (!this.pages.visitOnce(slot)) continue;
          const p = this.pages.page(slot), o = at(slot);
          visit(p[o + S_BX]!, p[o + S_BY]!, p[o + S_COS]!, p[o + S_SIN]!, p[o + S_X0]!, p[o + S_Y0]!, p[o + S_X1]!, p[o + S_Y1]!, p[o + S_TOP]! - CLEARANCE);
        }
      }
    }
  }

  forEachOccluder(x0: number, y0: number, x1: number, y1: number, visit: OccluderVisit): void {
    this.pages.walk();
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const slot of list) {
          const p = this.pages.page(slot), o = at(slot);
          const bottom = p[o + S_WALL0]!;
          if (Number.isNaN(bottom) || !this.pages.visitOnce(slot)) continue;
          const inset = p[o + S_INSET]!;
          visit(p[o + S_BX]!, p[o + S_BY]!, p[o + S_COS]!, p[o + S_SIN]!, p[o + S_X0]! + inset, p[o + S_Y0]! + inset, p[o + S_X1]! - inset, p[o + S_Y1]! - inset, bottom, p[o + S_WALL1]!);
        }
      }
    }
  }

  floorAt(x: number, y: number): number {
    return lowestEye(this.pages, this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, REACH);
  }

  roofAt(x: number, y: number): number {
    const eye = lowestEye(this.pages, this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))), x, y, 0);
    return eye === -Infinity ? eye : eye - CLEARANCE;
  }
}

/** The lowest the eye may stand at (x, y) over `list`, its floor easing down over `reach` round each volume. */
function lowestEye(pages: SolidPages, list: readonly number[] | undefined, x: number, y: number, reach: number): number {
  let floor = -Infinity;
  if (!list) return floor;
  for (const slot of list) {
    const p = pages.page(slot), o = at(slot);
    const top = p[o + S_TOP]!;
    if (top <= floor) continue;
    const cos = p[o + S_COS]!, sin = p[o + S_SIN]!;
    const dx = x - p[o + S_BX]!, dy = y - p[o + S_BY]!;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const ox = Math.max(p[o + S_X0]! - lx, 0, lx - p[o + S_X1]!);
    const oy = Math.max(p[o + S_Y0]! - ly, 0, ly - p[o + S_Y1]!);
    const d = Math.hypot(ox, oy);
    if (reach === 0 ? d > 0 : d >= reach) continue;
    floor = Math.max(floor, reach === 0 ? top : top - (top - p[o + S_FOOT]!) * smoothstep(d / reach));
  }
  return floor;
}
