import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CellMass, KitBoxes } from '@render/buildings/cellArrays';
import type { CellEntry, CellResult, CellSlice, JobKind } from '@render/buildings/cellWork';
import type { CellPool, SliceStore } from '@render/buildings/cellPool';
import type { PackedEntries } from '@render/buildings/chunk';
import type { BaseMass } from '@render/buildings/massBase';
import { GroundShare } from '@render/sharedGround';
import { Digest } from '@core/digest';
import { BLUEPRINTS, instantiate } from '@world/buildings/blueprints';
import { type RecordRef, refOf } from '@world/buildings/recordTable';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { CellWorker } from './support/cellWorkers';

/** A TILE, A PLATE AND A BASE JOINED FROM THEIR CELLS' SLICES (`cellWork.ts` CellSlice, `cellPool.ts` SliceStore, `massLevels.ts`): an edit
 *  makes its cell's slices again, its buildings alone sent and walked, every other cell's slice read as kept. */

const boxes = { parts: {}, furniture: {}, bandings: {} } as unknown as KitBoxes;
/** The ground as the atlas hands it: shared, flat (no plate made, no relief). */
const env = { groundAt: Object.assign(() => 0, { share: new GroundShare(3, 1, 1, 0) }), naturalAt: () => 0 };
const texts = new Map<string, RecordRef>();
const sigOf = (b: Building): number => new Digest().addPlain(b).value();

/** The slices kept, in memory: the derived cache's stand-in where there is no IndexedDB (Node). Cloned in and out, as the store clones. */
class MemorySlices implements SliceStore {
  readonly kept = new Map<string, CellSlice>();
  readonly forgotten: string[] = [];
  read(keys: readonly string[]): Promise<Map<string, CellSlice>> {
    const out = new Map<string, CellSlice>();
    for (const key of keys) { const slice = this.kept.get(key); if (slice) out.set(key, structuredClone(slice)); }
    return Promise.resolve(out);
  }
  keep(key: string, slice: CellSlice, was: string | null): void {
    this.kept.set(key, structuredClone(slice));
    if (was !== null && was !== key) { this.kept.delete(was); this.forgotten.push(was); }
  }
}

/** Every array of a value by its path, as bytes, and its other values. */
function leavesOf(o: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (ArrayBuffer.isView(o)) out.set(path, `${o.constructor.name}:${Buffer.from(o.buffer, o.byteOffset, o.byteLength).toString('base64')}`);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) leavesOf(v, `${path}.${k}`, out);
  else out.set(path, o);
  return out;
}
/** Where two values differ, '' when they are the same to the byte. */
function difference(a: unknown, b: unknown): string {
  const x = leavesOf(a), y = leavesOf(b);
  for (const path of new Set([...x.keys(), ...y.keys()])) if (!Object.is(x.get(path), y.get(path))) return path || '(root)';
  return '';
}

/** Three cells of one tile (t:0,0) and one base (b:0,0, its plate's level), a few presets each. */
const CELLS = ['0,0', '1,0', '0,1'] as const;
function town(): Map<string, Building[]> {
  const byCell = new Map<string, Building[]>();
  let id = 1;
  for (const cell of CELLS) {
    const [i, j] = cell.split(',').map(Number) as [number, number];
    byCell.set(cell, BLUEPRINTS.slice(0, 4).map((bp, k) => ({ ...instantiate(bp.body, { x: i * m(256) + m(30) + k * m(52), y: j * m(256) + m(110) }, 0, bp.key), id: (id++) as BuildingId }) as Building));
  }
  return byCell;
}
const packed = (list: readonly Building[]): PackedEntries => {
  for (const b of list) texts.set(String(b.id), refOf(b));
  return { ids: Float64Array.from(list.map((b) => b.id)), sigs: Float64Array.from(list.map(sigOf)), digest: 0 };
};

describe('a square level joined from its cells\' slices', () => {
  beforeEach(() => {
    CellWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', CellWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-joins the tile and the base (the plate\'s level) of an edited building from its cell alone, every other cell read as kept', async () => {
    const { CellPool } = await import('@render/buildings/cellPool');
    const { MassLevels } = await import('@render/buildings/massLevels');
    const store = new MemorySlices();
    const pool = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, true, undefined, store);
    const masses = new Map<string, CellMass | null>(), bases = new Map<string, BaseMass | null>();
    const levels = new MassLevels(pool, (key, mass) => masses.set(key, mass), () => {}, () => {}, () => true);
    levels.landBase = (key, base) => bases.set(key, base);
    const byCell = town();
    for (const [cell, list] of byCell) levels.touch(cell, packed(list));
    levels.flush(env);
    await CellWorker.drainAll();
    // No job of the plate's: its base is it (`massBase.ts`).
    expect([...masses.keys()].sort()).toEqual(['t:0,0']);
    expect([...bases.keys()]).toEqual(['b:0,0']);
    // Each cell's slice of each level kept: three cells, two levels.
    expect(store.kept.size).toBe(CELLS.length * 2);

    /** A level as every building of it walked at once on the page, no slice (the join's reference). */
    const reference = (kind: JobKind, key: string, cells: Map<string, Building[]>): CellResult => {
      const page = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, false, undefined, null);
      const { i0, j0, n } = { i0: kind === 'massTile' ? 0 : -4, j0: kind === 'massTile' ? 0 : -4, n: kind === 'massTile' ? 4 : 8 };
      const list: CellEntry[] = [];
      for (let i = i0; i < i0 + n; i++) for (let j = j0; j < j0 + n; j++) for (const b of cells.get(`${i},${j}`) ?? []) list.push({ key: String(b.id), sig: sigOf(b), digest: 0 });
      let got: CellResult | null = null;
      page.run(kind, key, list, env, (r) => { got = r; });
      return got!;
    };
    // The levels joined from slices are the levels made whole, byte for byte.
    expect(difference(masses.get('t:0,0'), reference('massTile', 't:0,0', byCell).mass)).toBe('');
    expect(difference(bases.get('b:0,0'), reference('massBase', 'b:0,0', byCell).base)).toBe('');

    // One building of cell 1,0 edited (moved two metres): its cell filed again, its levels asked again.
    const edited = [...byCell.get('1,0')!];
    edited[1] = { ...edited[1]!, x: edited[1]!.x + m(2) };
    byCell.set('1,0', edited);
    const reads = (): number => CellWorker.made.reduce((n, w) => n + (w.work ? w.work.keptPrograms().walks + w.work.keptPrograms().hits : 0), 0);
    const walks = (): number => CellWorker.made.reduce((n, w) => n + (w.work ? w.work.keptPrograms().walks : 0), 0);
    for (const w of CellWorker.made) w.work?.keptPrograms().resetCounts();
    const ranBefore = CellWorker.made.map((w) => w.jobs.length);
    levels.touch('1,0', packed(edited), true);
    levels.flush(env);
    await CellWorker.drainAll();
    const jobs = CellWorker.made.flatMap((w, k) => w.jobs.slice(ranBefore[k]));
    expect(jobs.map((j) => j.kind).sort()).toEqual(['massBase', 'massTile']);
    const editedKeys = edited.map((b) => String(b.id)).sort();
    for (const job of jobs) {
      // Only the edited cell's buildings sent; the two other cells handed as their kept slices.
      expect(job.entries.map((e) => e.key).sort()).toEqual(editedKeys);
      expect(job.spans).toEqual([{ cell: '1,0', count: edited.length }]);
      expect(job.slices!.map((s) => s.cell).sort()).toEqual(['0,0', '0,1']);
    }
    // No building of another cell walked or read: each of the two levels read the edited cell's buildings, no more; the moved one walked.
    expect(reads()).toBe(2 * edited.length);
    expect(walks()).toBeGreaterThanOrEqual(1);
    expect(walks()).toBeLessThanOrEqual(2);
    // The edited cell's new slices kept, its old ones forgotten.
    expect(store.forgotten).toHaveLength(2);
    expect(store.kept.size).toBe(CELLS.length * 2);
    // And the levels re-joined are the levels made whole with the edit.
    expect(difference(masses.get('t:0,0'), reference('massTile', 't:0,0', byCell).mass)).toBe('');
    expect(difference(bases.get('b:0,0'), reference('massBase', 'b:0,0', byCell).base)).toBe('');
    // ...and differ from before the edit (the edit is in them).
    const before = town();
    expect(difference(masses.get('t:0,0'), reference('massTile', 't:0,0', before).mass)).not.toBe('');
  });

  it('asks the base at once in the far levels\' band, as before slices: its job joins its cells\' slices, those not kept made in it', async () => {
    const { CellPool, FAR_TIER, TIER_SPAN } = await import('@render/buildings/cellPool');
    const { MassLevels } = await import('@render/buildings/massLevels');
    const jobPool = await import('@/jobs/jobPool');
    const asked: { key: string | null; priority: number }[] = [];
    const real = jobPool.submitJob;
    vi.spyOn(jobPool, 'submitJob').mockImplementation((spec) => { asked.push({ key: spec.key, priority: spec.priority }); return real(spec); });
    const pool: CellPool = new CellPool(() => boxes, (e) => () => texts.get(e.key)!, true, undefined, new MemorySlices());
    const levels = new MassLevels(pool, () => {}, () => {}, () => {}, () => false);
    for (const [cell, list] of town()) levels.touch(cell, packed(list));
    levels.flush(env);
    await CellWorker.drainAll();
    const base = asked.find((a) => a.key === 'cells:massBase|b:0,0');
    expect(base?.priority).toBe(FAR_TIER * TIER_SPAN);
    // The base the first job asked (no tile is wanted; the plate is the base's).
    expect(asked[0]?.key).toBe('cells:massBase|b:0,0');
  });
});
