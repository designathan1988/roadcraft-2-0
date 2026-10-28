import type { CellMass } from './cellArrays';
import type { CellEnv, CellPool } from './cellPool';
import { type CellEntry, type PackedEntries, samePacked, unpack } from './chunk';
import type { CellSpan } from './cellWork';
import type { JobKind } from './cellWork';
import { type MassLevel, baseOf, cellIndex, levelCells, plateOf, tileOf } from './levelKeys';
import type { BaseMass } from './massBase';
import { warmFull } from '../uploads';

/** THE BUILDINGS' LEVELS ABOVE THE CELLS: a 1,000 m tile (L2) of masses, one mesh each (`massCells.ts` chooses them), and the base over each plate's square (the plate's own level, L3, laid cell by cell, `massBase.ts`): asked before every other once the view wants it (its plate within a plate of the view, `massCells.ts` BASE_RING), never let go while it does. A plate has no job of its own: its base is it (the same buildings, the same detail, the same bytes). */

const KIND: Readonly<Partial<Record<MassLevel, JobKind>>> = { tile: 'massTile', base: 'massBase' };
/** The base that is a plate's level (`massBase.ts`). */
const baseKeyOf = (plate: string): string => `b:${plate.slice(2)}`;

/** DO NOT ask a tile or a plate again for each cell an edit touched: the cells are touched, their levels asked once (`flush`) */
export class MassLevels {
  /** Each cell's entries as last asked for its masses (`layer.ts` `askMass`): what its tile and plate are made of. */
  private readonly entries = new Map<string, PackedEntries>();
  private readonly dirty = new Set<string>();
  /** Tiles changed and not asked: no view wants them yet (their plate stands for them, `wanted`). */
  private readonly stale = new Set<string>();
  /** Each level's job asked and not answered. */
  private readonly asked = new Map<string, number>();
  /** Called whenever what it answers may change (`layer.ts` levelOfDetail chooses the levels again then). */
  changed: () => void = () => {};
  /** How far a level is from the eye (`layer.ts`): the plates waiting are asked nearest first. */
  away: (key: string) => number = () => 0;
  /** A tile or a plate left waiting for now (`layer.ts`: out of the view while the curtain is up): asked by `pump` once it is not. */
  deferred: (key: string) => boolean = () => false;
  /** A base's prisms come (`massBase.ts`; null: none of its buildings stands from afar). */
  landBase: (key: string, base: BaseMass | null) => void = () => {};

  /** `land`: a level's masses come (null: none of its buildings has any); `remove`: a level with no building left; `plan`: a level that has buildings (its place known before its masses);
   *  `wanted`: whether a tile is wanted now (its plate refined for the view) - DO NOT ask every tile of the map: a plate stands for them from afar (Cesium asks a tile's children only when it refines). */
  constructor(private readonly pool: CellPool, private readonly land: (key: string, mass: CellMass | null) => void, private readonly remove: (key: string) => void,
    private readonly plan: (key: string) => void, private readonly wanted: (key: string) => boolean) {}

  /** The levels a player's edit changed (`touch` with `edited`): asked first in the queue (`cellPool.ts` EDIT_TIER), once. */
  private readonly edited = new Set<string>();

  /** A cell's buildings asked again (`entries`), or gone (null): its tile and plate to be asked again at `flush`; `edited`, by the player's edit (asked first). */
  touch(cell: string, entries: PackedEntries | null, edited = false): void {
    const was = this.entries.get(cell);
    // The same buildings on the same ground (the whole town filed again): its levels stand as they are.
    if (was && entries && samePacked(was, entries)) return;
    if (!was && !entries?.ids.length) return;
    if (entries?.ids.length) this.entries.set(cell, entries); else this.entries.delete(cell);
    this.changed();
    const [i, j] = cellIndex(cell);
    this.dirty.add(tileOf(i, j));
    this.dirty.add(plateOf(i, j));
    this.dirty.add(baseOf(i, j));
    if (edited) { this.edited.add(tileOf(i, j)); this.edited.add(plateOf(i, j)); this.edited.add(baseOf(i, j)); }
  }

  /** Every plate touched asked once (`PLATES_IN_FLIGHT` at a time, `pump`), made of its cells' entries; a tile touched asked once it is wanted (`pump`); a level with none left removed. */
  flush(env: CellEnv): void {
    if (this.dirty.size) this.changed();
    for (const key of this.dirty) {
      if (!this.hasAny(key)) {
        const was = this.asked.get(key);
        if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
        this.stale.delete(key);
        this.edited.delete(key);
        this.remove(key);
        continue;
      }
      this.plan(key);
      // A plate is its base's (`massBase.ts`): planned, never asked.
      if (key[0] === 'p') { this.edited.delete(key); continue; }
      // THE BASE AT ONCE once the view wants it, whatever the upload queue: it is what stands where no finer level is (`massBase.ts`). DO NOT
      // ask every base of the map: one out of the ring waits, stale, until the view comes within a plate of it (`pump`).
      if (key[0] === 'b') {
        if (this.wanted(key) || this.edited.has(key)) { this.ask(key, env); continue; }
        const was = this.asked.get(key);
        if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
        this.stale.add(key);
        continue;
      }
      // The upload queue full (`uploads.ts` warmFull): left stale, asked by `pump` once it drains.
      if (this.wanted(key) && (this.edited.has(key) || (!warmFull() && !this.deferred(key)))) this.ask(key, env);
      else {
        // Its old masses, if any, are no longer its buildings': asked again once a view wants it.
        const was = this.asked.get(key);
        if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
        this.stale.add(key);
      }
    }
    this.dirty.clear();
    this.pump(env);
  }

  /** The tiles changed since last asked that a view now wants (a plate refined): asked (each frame, `layer.ts`; as many as tiles changed, never the map). */
  pump(env: CellEnv): void {
    for (const key of this.stale) {
      // A base as soon as the view wants it, whatever the upload queue (`flush`).
      if (key[0] === 'b') {
        if (!this.wanted(key)) continue;
        this.stale.delete(key);
        if (this.hasAny(key)) this.ask(key, env);
        continue;
      }
      // DO NOT ask masses to upload while the upload queue is full: their arrays waited on the page (conf77, 2026-10-17); asked once it drains.
      if (warmFull() && !this.edited.has(key)) continue;
      if (!this.wanted(key) || (this.deferred(key) && !this.edited.has(key))) continue;
      this.stale.delete(key);
      if (this.hasAny(key)) this.ask(key, env);
    }
  }

  /** A tile whose masses were let go, neither drawn nor wanted, or let go out of the view for the budget (`massCells.ts` evictLevels): asked again once a view wants it (`pump`, `deferred`); a base let go past the ring, once its plate is within it. */
  release(key: string): void {
    if (key[0] === 'p' || !this.hasAny(key)) return;
    const was = this.asked.get(key);
    if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
    this.stale.add(key);
    this.changed();
  }

  /** A level's buildings, its cells' in order (column by column): entries made now, for the job asked; `cells`, each cell's count of them (the
   *  job joins its cells' slices, `cellPool.ts` SliceStore). */
  private listOf(key: string, cells?: CellSpan[]): CellEntry[] {
    const { i0, j0, n } = levelCells(key);
    const list: CellEntry[] = [];
    for (let i = i0; i < i0 + n; i++) {
      for (let j = j0; j < j0 + n; j++) {
        const some = this.entries.get(`${i},${j}`);
        if (!some) continue;
        const from = list.length;
        unpack(some, list);
        cells?.push({ cell: `${i},${j}`, count: list.length - from });
      }
    }
    return list;
  }

  /** Whether a level has any building (its cells' packed entries), no entry made. */
  private hasAny(key: string): boolean {
    const { i0, j0, n } = levelCells(key);
    for (let i = i0; i < i0 + n; i++) for (let j = j0; j < j0 + n; j++) if (this.entries.has(`${i},${j}`)) return true;
    return false;
  }

  /** A level asked of the workers, made of its cells' buildings (`listOf`), the older ask of it cancelled. */
  private ask(key: string, env: CellEnv): void {
    const cells: CellSpan[] = [];
    const list = this.listOf(key, cells);
    const was = this.asked.get(key);
    if (was !== undefined) { this.pool.cancel(was); this.asked.delete(key); }
    const kind = KIND[levelCells(key).level];
    if (!kind) throw new Error(`[buildings] no job makes level ${key}: a plate is its base's`);
    // DO NOT read `id` in the answer before it is given: on the page the answer comes inside `run`.
    let id = -1;
    const edited = this.edited.delete(key);
    id = this.pool.run(kind, key, list, env, (result) => {
      if (this.asked.get(key) === id) this.asked.delete(key);
      this.changed();
      if (key[0] === 'b') this.landBase(key, result.base ?? null);
      else this.land(key, result.mass ?? null);
    // The base in the far levels' band (`cellPool.ts` hole), before the view's detail: until it comes nothing stands there.
    }, `${kind}|${key}`, edited, key[0] === 'b', false, cells);
    if (this.pool.isRunning(id)) this.asked.set(key, id);
  }

  /** Whether a level's buildings changed since its masses were made (asked and not come, or not asked yet): its mesh, if any, is of older buildings. A plate's are its base's. */
  outdated(key: string): boolean {
    if (key[0] === 'p') key = baseKeyOf(key);
    return this.asked.has(key) || this.stale.has(key) || this.dirty.has(key);
  }

  /** Levels asked and not come. */
  get asking(): number {
    return this.asked.size;
  }

  /** Every request cancelled and every cell forgotten (a context restored, the layer gone): the next filing touches them all again. */
  clear(): void {
    this.changed();
    for (const id of this.asked.values()) this.pool.cancel(id);
    this.asked.clear();
    this.entries.clear();
    this.dirty.clear();
    this.stale.clear();
    this.edited.clear();
  }
}
