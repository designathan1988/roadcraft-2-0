import type { ChangeRect } from '@world/changes';
import { CandidateKeep, KEEP_CELL, keepCellKey, keepCellOf } from './candidateKeep';

/** DO NOT hold a kind's places as one list again: a change in one cell made the whole list, and every place's test, again */

/** The keep cell holding a point. */
export const keepCellAt = (x: number, y: number): number => keepCellKey(Math.floor(x / KEEP_CELL), Math.floor(y / KEEP_CELL));

/** The rectangle a keep cell covers. */
export function keepCellRect(key: number): ChangeRect {
  const [i, j] = keepCellOf(key);
  return [i * KEEP_CELL, j * KEEP_CELL, (i + 1) * KEEP_CELL, (j + 1) * KEEP_CELL];
}

/** Each keep cell a rectangle grown by `pad` reaches, into `out`. */
export function keepCellsOver(rect: ChangeRect, pad: number, out: Set<number>): Set<number> {
  const i0 = Math.floor((rect[0] - pad) / KEEP_CELL), i1 = Math.floor((rect[2] + pad) / KEEP_CELL);
  const j0 = Math.floor((rect[1] - pad) / KEEP_CELL), j1 = Math.floor((rect[3] + pad) / KEEP_CELL);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.add(keepCellKey(i, j));
  return out;
}

/** Keep cells to a side of the blocks the waiting cells are ranked by (`CellKeeps.settle`): ten, half a kilometre. */
const RANK_CELLS = 10;
/** The block holding a keep cell. */
const blockOf = (key: number): number => {
  const [i, j] = keepCellOf(key);
  return keepCellKey(Math.floor(i / RANK_CELLS), Math.floor(j / RANK_CELLS));
};

/**
 * THE PLACES OF A KIND KEPT CELL BY CELL, EACH CELL TESTED IN ITS TURN, NEAREST THE VIEW FIRST: a `CandidateKeep` per keep cell, filled on
 * its own. A cell filled (`fill`) waits untested; `settle` tests the waiting cells, the blocks nearest the view's focus first, until the
 * frame's deadline, and a cell is drawn once tested (`cellKeys`, `standingIn`). A cell whose places are all to be tested again (`refreshAll`)
 * keeps standing as it was until its turn. DO NOT test a kind's every cell in the frame that fills it: a 10 km city's trees and covers, each
 * tested against the roads and the buildings' covers (every building's footprint decoded from its table), held the page for minutes while
 * the saved map reopened (2026-10-26).
 */
/** The cells not ready (`settle`) asked again at most this many times a call: the next call asks the next ones. */
const UNREADY_PROBES = 64;

export class CellKeeps<C extends { readonly x: number; readonly y: number }> {
  private readonly keeps = new Map<number, CandidateKeep<C>>();
  /** The cells filled and not tested yet, with their places; one also in `keeps` stands as it was until its turn. */
  private readonly waiting = new Map<number, readonly C[]>();
  /** The tested cells whose places are all to be tested again (`refreshAll`), standing as they were until their turn. */
  private readonly stale = new Set<number>();
  /** The waiting and the stale cells by the block holding them (`RANK_CELLS`): the blocks are ranked by their distance to the focus. */
  private readonly queued = new Map<number, Set<number>>();
  /** The cells whose places, or their standing, changed since the last `takeChangedCells`; null: every cell. */
  private changed: Set<number> | null = null;
  /** Places tested since the keeps were made: the work, for the specs. */
  tested = 0;
  private readonly counted = (c: C): number | null => {
    this.tested++;
    return this.test(c);
  };

  /**
   * `test`: the ground under a place where it may stand, null where it may not (`CandidateKeep`). `ready`: whether what the test reads is in
   * over a cell's rectangle (the buildings' cover worked out off the page, `CoverIndex.ready`); a cell not ready waits its turn untested, and
   * a change reaching it tests it whole when it is. None: always.
   */
  constructor(private readonly test: (c: C) => number | null, private readonly ready: ((rect: ChangeRect) => boolean) | null = null) {}

  /** Cells holding tested places. */
  get size(): number {
    return this.keeps.size;
  }

  /** Whether cells wait for their test (`settle`). */
  get waits(): boolean {
    return this.queued.size > 0;
  }

  private enqueue(key: number): void {
    const block = blockOf(key);
    const cells = this.queued.get(block);
    if (cells) cells.add(key); else this.queued.set(block, new Set([key]));
  }

  private dequeue(key: number): void {
    const block = blockOf(key);
    const cells = this.queued.get(block);
    if (!cells) return;
    cells.delete(key);
    if (!cells.size) this.queued.delete(block);
  }

  /** The places of cell `key` from now on (each standing in it), tested in their turn (`settle`); an empty list lets the cell go. */
  fill(key: number, list: readonly C[], same?: (a: C, b: C) => boolean): void {
    const was = this.keeps.get(key);
    if (!list.length) {
      this.waiting.delete(key);
      this.stale.delete(key);
      this.dequeue(key);
      if (was) { this.keeps.delete(key); this.changed?.add(key); }
      return;
    }
    // The same places as before (a dab that changed nothing here): kept as they stand, not tested nor drawn again.
    if (was && same && was.list.length === list.length && was.list.every((c, k) => same(c, list[k]!))) {
      if (this.waiting.delete(key) && !this.stale.has(key)) this.dequeue(key);
      return;
    }
    this.waiting.set(key, list);
    this.enqueue(key);
  }

  /** @rebuild Every cell let go (the map opened, or the diary cannot say what changed): the next look draws every cell. */
  clear(): void {
    this.keeps.clear();
    this.waiting.clear();
    this.stale.clear();
    this.queued.clear();
    this.changed = null;
  }

  /** The places a change reached tested again, in the tested cells the change reaches only (`CandidateKeep.refresh`): a waiting cell is tested whole in its turn. */
  refresh(rects: readonly ChangeRect[], pad: number): void {
    // Each cell is asked only of the rectangles that reach it, cut to it: a wide change reads each cell once.
    const reaching = new Map<number, ChangeRect[]>();
    const cells = new Set<number>();
    for (const r of rects) {
      cells.clear();
      for (const key of keepCellsOver(r, pad, cells)) {
        if (!this.keeps.has(key) || this.waiting.has(key)) continue;
        const [x0, y0, x1, y1] = keepCellRect(key);
        const cut: ChangeRect = [Math.max(r[0], x0 - pad), Math.max(r[1], y0 - pad), Math.min(r[2], x1 + pad), Math.min(r[3], y1 + pad)];
        const list = reaching.get(key);
        if (list) list.push(cut); else reaching.set(key, [cut]);
      }
    }
    for (const [key, cut] of reaching) {
      // What the test reads not in there yet: the cell tested whole in its turn, once it is.
      if (this.ready && !this.ready(keepCellRect(key))) {
        if (!this.stale.has(key)) { this.stale.add(key); this.enqueue(key); }
        continue;
      }
      if (this.keeps.get(key)!.refresh(cut, pad)) this.changed?.add(key);
    }
  }

  /** @rebuild Every place to be tested again, each cell in its turn (`settle`): a change the diary cannot place. */
  refreshAll(): void {
    for (const key of this.keeps.keys()) {
      if (this.stale.has(key) || this.waiting.has(key)) continue;
      this.stale.add(key);
      this.enqueue(key);
    }
  }

  /** The waiting and stale cells tested, those of the blocks nearest (`x`, `y`) first, until `deadline` (`performance.now()`), one cell at least: each cell tested whole, then drawn. Whether cells still wait. */
  settle(x: number, y: number, deadline: number): boolean {
    if (!this.queued.size) return false;
    // The cells whose test reads what is not in yet probed at most `UNREADY_PROBES` a call. DO NOT probe them to the deadline: thousands wait on
    // the same few cover cells in flight, and each frame of a street's view spent its whole budget asking them again (1.3 s of the city tour's
    // 3.8 min in `settle`, the lab's tour, 2026-10-27).
    let probes = 0;
    const span = RANK_CELLS * KEEP_CELL;
    const blocks = [...this.queued.keys()].map((block) => {
      const [i, j] = keepCellOf(block);
      return { block, d: Math.hypot((i + 0.5) * span - x, (j + 0.5) * span - y) };
    }).sort((a, b) => a.d - b.d);
    let first = true;
    let unready = false;
    for (const { block } of blocks) {
      const cells = this.queued.get(block)!;
      for (const key of cells) {
        if (!first && performance.now() >= deadline) return true;
        // What its test reads not in yet (asked by `ready`): left waiting, the next cell taken.
        // The skip held to the deadline too: thousands of cells may wait on the same few in flight.
        if (this.ready && !this.ready(keepCellRect(key))) {
          unready = true;
          if (++probes >= UNREADY_PROBES || performance.now() >= deadline) return true;
          continue;
        }
        first = false;
        cells.delete(key);
        const list = this.waiting.get(key);
        if (list) {
          this.waiting.delete(key);
          this.stale.delete(key);
          const keep = new CandidateKeep(list, this.counted);
          keep.refresh(null, 0);
          keep.takeChangedCells();
          this.keeps.set(key, keep);
          this.changed?.add(key);
        } else if (this.stale.delete(key)) {
          if (this.keeps.get(key)?.refresh(null, 0)) this.changed?.add(key);
        }
      }
      if (!cells.size) this.queued.delete(block);
    }
    return unready;
  }

  /** The cells whose places changed since the last call, and the call itself the new start; null: every cell. */
  takeChangedCells(): Set<number> | null {
    const out = this.changed;
    this.changed = new Set();
    return out;
  }

  /** Every cell with tested places. */
  cellKeys(): IterableIterator<number> {
    return this.keeps.keys();
  }

  /** The places standing in a cell, and the ground under each. */
  standingIn(key: number): { readonly c: C; readonly z: number }[] {
    return this.keeps.get(key)?.standingIn(key) ?? [];
  }
}
