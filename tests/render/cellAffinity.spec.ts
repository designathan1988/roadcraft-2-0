import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KitBoxes } from '@render/buildings/cellArrays';
import type { CellEntry, CellJob, CellResult } from '@render/buildings/cellWork';
import { GroundShare } from '@render/sharedGround';
import { Digest } from '@core/digest';
import { BLUEPRINTS, instantiate } from '@world/buildings/blueprints';
import { type RecordRef, refOf } from '@world/buildings/recordTable';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { CellWorker } from './support/cellWorkers';

/** A CELL'S JOBS GO TO THE WORKER THAT RAN ITS LAST (`jobPool.ts` JobSpec.affinity, `cellPool.ts` affinityOf): the buildings' programs a
 *  worker keeps (`cellWork.ts`) read there, not walked again on another worker. */

const boxes = { parts: {}, furniture: {}, bandings: {} } as unknown as KitBoxes;
/** The ground as the atlas hands it: shared, flat (no plate made, no relief). */
const env = { groundAt: Object.assign(() => 0, { share: new GroundShare(3, 1, 1, 0) }), naturalAt: () => 0 };
const texts = new Map<string, RecordRef>();
const entryOf = (b: Building): CellEntry => { texts.set(String(b.id), refOf(b)); return { key: String(b.id), sig: new Digest().addPlain(b).value(), digest: 0 }; };
/** Every preset stood in a row from `x`: the buildings of a cell. */
function row(x: number, first: number): Building[] {
  return BLUEPRINTS.slice(0, 6).map((bp, k) => ({ ...instantiate(bp.body, { x: x + k * m(36), y: m(120) }, 0, bp.key), id: (first + k) as BuildingId }) as Building);
}

describe("a cell's jobs on the worker of its last", () => {
  beforeEach(() => {
    CellWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', CellWorker);
    // Two workers in the pool (four threads less the page's and the simulation's).
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a square's masses at every level on one worker, each building walked once (`JobSpec.affinity`)", async () => {
    // Three workers: the derived cache's writer kept clear of queued jobs (`jobPool.ts` KEPT_CLEAR, its lane opened by the pool's kept
    // store), two for the cells. With two, the writer's worker took no job and every square's went to the other: no affinity to keep.
    vi.stubGlobal('navigator', { hardwareConcurrency: 5 });
    const { CellPool, affinityOf } = await import('@render/buildings/cellPool');
    const { tileOf } = await import('@render/buildings/levelKeys');
    // Two cells in two squares of the base (`levelKeys.ts` baseOf): cell 0,0 in square 0,0, cell 8,0 in square 1,0.
    expect(affinityOf('mass', '0,0')).not.toBe(affinityOf('mass', '8,0'));
    expect(affinityOf('massTile', tileOf(0, 0))).toBe(affinityOf('mass', '0,0'));
    expect(affinityOf('massTile', tileOf(8, 0))).toBe(affinityOf('mass', '8,0'));
    expect(affinityOf('massBase', 'b:0,0')).toBe(affinityOf('mass', '0,0'));
    expect(affinityOf('cell', '0,0')).toBe('cell:0,0');
    const a = row(m(16), 1).map(entryOf), b = row(8 * m(256) + m(16), 101).map(entryOf);
    const pool = new CellPool(() => boxes, (e) => () => texts.get(e.key)!);
    const results: CellResult[] = [];
    const run = (kind: 'mass' | 'massTile', cell: string, entries: readonly CellEntry[]): void => { pool.run(kind, cell, entries, env, (r) => results.push(r)); };
    const drain = async (): Promise<void> => { for (const w of CellWorker.made) await w.drain(); };
    // The cells' masses: one worker each.
    run('mass', '0,0', a);
    run('mass', '8,0', b);
    expect(CellWorker.made).toHaveLength(3);
    await drain();
    // The writer's worker ran no cell's job; the cells' two, one square each.
    expect(CellWorker.made.filter((w) => (w as CellWorker).ran.length === 0)).toHaveLength(1);
    const [w0, w1] = CellWorker.made.filter((w) => (w as CellWorker).ran.length > 0) as [CellWorker, CellWorker];
    expect(w0.ran).toEqual(['mass 0,0']);
    expect(w1.ran).toEqual(['mass 8,0']);
    const walks = (w: CellWorker): number => w.work!.keptPrograms().walks;
    expect([walks(w0), walks(w1)]).toEqual([a.length, b.length]);
    // Their tiles, the second square's asked first: by the queue's order alone it would go to the first worker (the first warm one, `hostFor`), and every building be walked again there.
    w0.work!.keptPrograms().resetCounts();
    w1.work!.keptPrograms().resetCounts();
    run('massTile', tileOf(8, 0), b);
    run('massTile', tileOf(0, 0), a);
    await drain();
    expect(w0.ran).toEqual(['mass 0,0', `massTile ${tileOf(0, 0)}`]);
    expect(w1.ran).toEqual(['mass 8,0', `massTile ${tileOf(8, 0)}`]);
    // No building walked again: each tile a filter over the programs its worker kept.
    expect([walks(w0), walks(w1)]).toEqual([0, 0]);
    expect(w0.work!.keptPrograms().hits).toBe(a.length);
    expect(w1.work!.keptPrograms().hits).toBe(b.length);
    expect(results.every((r) => r.mass)).toBe(true);
  });

  it("gives a job whose worker is busy to a free one when nothing else waits: its buildings walked again there (the affinity moves)", async () => {
    const { CellPool } = await import('@render/buildings/cellPool');
    const { tileOf } = await import('@render/buildings/levelKeys');
    const a = row(m(16), 1).map(entryOf);
    const pool = new CellPool(() => boxes, (e) => () => texts.get(e.key)!);
    pool.run('mass', '0,0', a, env, () => {});
    await CellWorker.made[0]!.drain();
    const w0 = CellWorker.made[0]!;
    // Its worker busy with another cell's detail; the square's tile asked meanwhile, nothing else waiting: DO NOT hold the free worker idle for it.
    pool.run('mass', '1,0', row(m(256) + m(16), 201).map(entryOf), env, () => {});
    expect(w0.waiting).toHaveLength(1);
    pool.run('massTile', tileOf(0, 0), a, env, () => {});
    expect(CellWorker.made).toHaveLength(2);
    const w1 = CellWorker.made[1]!;
    expect(w1.waiting.map((q) => (q.data as CellJob).kind)).toEqual(['massTile']);
    await w1.drain();
    expect(w1.work!.keptPrograms().walks).toBe(a.length);
    // The square's next job goes to the worker that ran its last: the second.
    await w0.drain();
    pool.run('mass', '0,0', a, env, () => {});
    expect(w1.waiting.map((q) => (q.data as CellJob).cell)).toEqual(['0,0']);
  });
});
