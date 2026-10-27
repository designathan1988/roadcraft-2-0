import type { GroundAt, PavedAt } from './foundation';
import { Digest } from '@core/digest';
import { IdSlots, grown } from '@core/idSlots';
import { storedBounds } from './geometry';
import { type Pad, type StorePads, type TownPads, padLevelAt, padOf, storePads } from './pads';
import type { BuildingFloors } from './floors';
import type { GroundSince } from './cameraSolids';
import { BuildingStore } from './store';
import type { TableRows } from './tableRows';
import type { Building, BuildingId } from './types';

/** THE BUILDINGS' SITES AS THE GROUND WAS LAST GRADED TO THEM: each building's platform */

/** A world box: [minX, minY, maxX, maxY]. */
export type SiteBox = readonly [number, number, number, number];

export interface SiteGrading {
  /** The town's platforms, filed square by square as the shapings read them (`storePads`); null before `rebuild`, and for a town with none. */
  readonly pads: TownPads | null;
  /** What changed among the buildings since the ground was graded: the box of each site added, removed or changed */
  changedSites(buildings: BuildingStore): SiteBox[] | null;
  /** A building's platform worked out again (the roads round it moved), on its floor as the floors keep it (follow them first). */
  refresh(b: Building): void;
  /** A building's platform as worked out elsewhere (the ground's worker, `groundShape.ts` `padsOfAsk`), on its floor as the floors keep it: as `refresh` would make it. */
  take(b: Building, pad: Pad | null): void;
  /** The platforms whose bank (`bankReach` past the bounds) a change of what they read (the floor's ground, the paving) since the last `follow` reaches, forgotten (`ground`: the floors' changes); every one when the diary cannot say where. */
  follow(buildings: BuildingStore, ground: GroundSince, reach: number): void;
  /** The town's platforms brought up to the store's buildings (`storePads`, the changes since the last). */
  rebuild(buildings: BuildingStore): void;
  /** The roads or the land moved: every platform is worked out afresh, and every site read again as graded. */
  forget(buildings: BuildingStore): void;
}

/** The most a box grown in a building's own frame and turned grows past the box turned (`buildingBounds` grown): a rectangle's by √2, an outline's offset ring's corner by √(2 / 0.3) ≈ 2.58 of its distance (`footprints.ts` `offsetRing`). */
const GROWN_TURNED = 2.6;

/**
 * `groundAt`: the ground a building stands on before its own grading; `pavedAt`: the footway's height; `apron`: the level ground round a
 * platform before its bank; `bankReach`: how far a building's bank reaches past its bounds (its site's box, `storedBounds(b, bankReach)`).
 *
 * DO NOT grade every building of the map, nor work every platform out to file the town: each site's digest is taken when its ground is
 * graded (a shaping reads its platform, `storePads`) or when the diary names it, a site the ground was never graded to needs no grading
 * where it stood. The 10 km map's 249,122 buildings were decoded and their platforms worked out on the page at the first stroke of its land
 * (2026-10-26).
 */
export function siteGrading(
  groundAt: GroundAt,
  pavedAt: PavedAt | undefined,
  apron: number,
  bankReach: number,
  /** Each building's floor as kept for every reader (`floors.ts`), on `groundAt` and `pavedAt` */
  floors?: BuildingFloors,
): SiteGrading {
  const floorOf = floors ? (b: Building): number => floors.floorOf(b) : undefined;
  /** A building's site: its bounds grown by its bank's reach. */
  const bankBox = (b: Building): SiteBox => {
    const r = storedBounds(b, bankReach);
    return [r.minX, r.minY, r.maxX, r.maxY];
  };
  /** A site's box from its building's box as the store files it, nothing decoded: at least `bankBox` (`GROWN_TURNED`). */
  const bankOfBox = (minX: number, minY: number, maxX: number, maxY: number): SiteBox => {
    const g = bankReach * GROWN_TURNED;
    return [minX - g, minY - g, maxX + g, maxY + g];
  };
  /** The town's platforms, filed as the shapings read them, and the store they are filed from. */
  let padsCache: StorePads | null = null;
  let padsStore: BuildingStore | null = null;
  /** Each building's platform by record, while the roads and the land stand. */
  let padsKnown = new WeakMap<Building, Pad | null>();
  const padFor = (b: Building): Pad | null => {
    if (!padsKnown.has(b)) padsKnown.set(b, padOf(b, groundAt, pavedAt, apron, floorOf));
    return padsKnown.get(b) ?? null;
  };
  /** The buildings the ground was last graded for, by id: its site digested, the box its bank reaches, and the table's row it was read from (its table's number, `tableNumber`; 0 a record of the page's), in columns at its slot (`core/idSlots.ts`). DO NOT keep the record here: every building of the map was held decoded (the table decodes a record while it is read, `tableRows.ts`); nor an object a building in a `Map`. */
  const graded = new IdSlots(1024);
  let gradedSite = new Float64Array(16), gradedBox = new Float64Array(64), gradedMark = new Uint8Array(16);
  let gradedTable = new Float64Array(16), gradedRow = new Float64Array(16);
  graded.onGrow = (n) => {
    gradedSite = grown(gradedSite, n); gradedBox = grown(gradedBox, n * 4); gradedMark = grown(gradedMark, n);
    gradedTable = grown(gradedTable, n); gradedRow = grown(gradedRow, n);
  };
  const boxAt = (slot: number): SiteBox => [gradedBox[slot * 4]!, gradedBox[slot * 4 + 1]!, gradedBox[slot * 4 + 2]!, gradedBox[slot * 4 + 3]!];
  /** Each table a number of its own, for the rows graded (a map read again is another table). */
  const tables = new WeakMap<TableRows, number>();
  let tablesMade = 0;
  const tableNumber = (table: TableRows): number => {
    let n = tables.get(table);
    if (n === undefined) tables.set(table, n = ++tablesMade);
    return n;
  };
  /** What a building's site is graded from, as a digest (`core/digest.ts`), once per record */
  const siteKey = new WeakMap<Building, number>();
  const siteKeyOf = (b: Building): number => {
    let key = siteKey.get(b);
    if (key === undefined) {
      const pad = padFor(b);
      const digest = new Digest();
      if (pad) {
        digest.add(pad.solidCount).add(pad.stepped ? 1 : 0);
        pad.rings.forEach((ring, i) => {
          const level = pad.levels[i]!;
          digest.add(pad.water[i] ? 1 : 0).add(pad.paved[i] ? 1 : 0).add(ring.length);
          // To the millimetre, as the text was: a platform moved by less grades the same.
          for (const p of ring) digest.add(Math.round(p.x * 1000)).add(Math.round(p.y * 1000)).add(Math.round(padLevelAt(level, p.x, p.y) * 1000));
        });
      } else digest.add(-1);
      key = digest.value();
      siteKey.set(b, key);
    }
    return key;
  };
  /** A building's site taken as the ground is graded to it now: its digest, its bank's box and the row it is read from. */
  const note = (buildings: BuildingStore, b: Building, slot: number, site: number, box: SiteBox): void => {
    gradedSite[slot] = site;
    for (let k = 0; k < 4; k++) gradedBox[slot * 4 + k] = box[k]!;
    const row = buildings.standing(b.id);
    gradedTable[slot] = row ? tableNumber(row.table) : 0;
    gradedRow[slot] = row ? row.row : -1;
  };
  /** A building's platform as a shaping reads it (`storePads`): the ground graded to its site from now on. */
  const resolvePad = (buildings: BuildingStore, id: number): Pad | null => {
    const b = buildings.get(id as BuildingId);
    if (!b) return null;
    const pad = padFor(b);
    const site = siteKeyOf(b);
    const was = graded.get(id);
    if (was < 0 || gradedSite[was] !== site) note(buildings, b, graded.take(id), site, bankBox(b));
    return pad;
  };
  const padsFor = (buildings: BuildingStore): StorePads => storePads(apron, {
    nearIds: (x0, y0, x1, y1) => buildings.nearIds(x0, y0, x1, y1),
    padOf: (id) => resolvePad(buildings, id),
    eachBox: (visit) => buildings.eachBox(visit),
  });
  /** The diary's revision the sites were last read at, and the town's platforms at; -1: read them all. */
  const sitesRead = BuildingStore.cursor();
  const padsBuilt = BuildingStore.cursor();
  /** The ground's version the platforms were last brought to (`follow`); -1: never. */
  let groundSeen = -1;
  /** Buildings whose platform was worked out again for the roads (`refresh`) since the town's platforms were brought up. */
  const refreshed = new Set<BuildingId>();
  /** @rebuild The whole store read only when the diary cannot say which buildings changed: its rows from their columns (nothing decoded), a record of the page's graded. */
  const changedSites = (buildings: BuildingStore): SiteBox[] | null => {
    const boxes: SiteBox[] = [];
    const take = (q: SiteBox): void => { boxes.push(q); };
    const grade = (b: Building): number => {
      const was = graded.get(b.id);
      const site = siteKeyOf(b);
      // A new record of the same site (aged, renamed): nothing to grade.
      if (was >= 0 && gradedSite[was] === site) return was;
      if (was >= 0) take(boxAt(was));
      const now = bankBox(b);
      take(now);
      const slot = graded.take(b.id);
      note(buildings, b, slot, site, now);
      return slot;
    };
    const ids = buildings.changedFor(sitesRead);
    if (ids) {
      for (const id of ids) {
        const b = buildings.get(id);
        if (b) grade(b);
        else { const was = graded.get(id); if (was >= 0) { take(boxAt(was)); graded.delete(id); } }
      }
      return boxes.length ? boxes : null;
    }
    // Each building as it stands marked; those left unmarked are gone. A row of the table graded as the same row stands as it was graded (a record is replaced, never edited; its wear moves no site); any other, where it was graded and its bank from its box column, graded when its ground is (`resolvePad`).
    gradedMark.fill(0);
    buildings.eachStanding((id, table, at) => {
      const slot = graded.get(id);
      if (slot >= 0 && gradedTable[slot] === tableNumber(table) && gradedRow[slot] === at) { gradedMark[slot] = 1; return; }
      if (slot >= 0) { take(boxAt(slot)); graded.delete(id); }
      const box = table.boxAt(at);
      take(box ? bankOfBox(box.minX, box.minY, box.maxX, box.maxY) : bankBox(table.record(at)));
    }, (b) => { const slot = grade(b); gradedMark[slot] = 1; });
    const gone: number[] = [];
    graded.forEach((id, slot) => { if (!gradedMark[slot]) { take(boxAt(slot)); gone.push(id); } });
    for (const id of gone) graded.delete(id);
    return boxes.length ? boxes : null;
  };
  return {
    get pads() { return padsCache && padsStore && padsStore.size > 0 ? padsCache : null; },
    changedSites,
    refresh(b) {
      // DO NOT forget its floor here: the floors follow the diary themselves (`floors.ts` `follow`, read before the platforms are), and a floor still right was worked out again for every building a road block reached.
      padsKnown.set(b, padOf(b, groundAt, pavedAt, apron, floorOf));
      refreshed.add(b.id);
    },
    take(b, pad) {
      padsKnown.set(b, pad);
      refreshed.add(b.id);
    },
    follow(buildings, ground, reach) {
      if (ground.version === groundSeen) return;
      const rects = groundSeen < 0 ? null : ground.rectsSince(groundSeen);
      groundSeen = ground.version;
      // DO NOT forget the whole town's platforms for a change the diary places: only those whose bank it reaches (`floors.ts` `follow`, the same changes).
      if (rects === null) { this.forget(buildings); return; }
      // `reach`: how far a bank reaches past its building's bounds (the store files the bounds).
      for (const b of buildings.nearAny(rects, reach, (b, r) => {
        const box = bankBox(b);
        return box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1];
      })) {
        padsKnown.delete(b);
        siteKey.delete(b);
        refreshed.add(b.id);
      }
    },
    /** The changes since the last, each building's platform filed again where a square filed holds it (`StorePads.changed`); every square let go when the diary cannot say which changed. */
    rebuild(buildings) {
      if (!padsCache || padsStore !== buildings) {
        padsStore = buildings;
        padsCache = padsFor(buildings);
        padsBuilt.reset();
        buildings.changedFor(padsBuilt);
        refreshed.clear();
        return;
      }
      const ids = buildings.changedFor(padsBuilt);
      if (ids) for (const id of new Set([...ids, ...refreshed])) padsCache.changed(id);
      else padsCache.forgetAll();
      refreshed.clear();
    },
    forget(buildings) {
      padsKnown = new WeakMap();
      floors?.forgetAll();
      graded.clear();
      padsCache?.forgetAll();
      // Every site to be read again as the ground is graded to it: the diary read up to now.
      sitesRead.reset();
      buildings.changedFor(sitesRead);
      padsBuilt.reset();
    },
  };
}
