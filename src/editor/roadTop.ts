import type { ChangeKind, ChangeRect } from '@world/changes';
import { CELL, cellRect } from '@world/cells';
import { JournalCursor } from '@world/derived';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';

/** DO NOT walk `doc.nodes` on a road edit for the top: every street drawn read every node of the city again */
const KINDS: readonly ChangeKind[] = ['roads', 'elevation'];

/** A cell's key, as `world/cells.ts` keys them (column and row within ±32 767). */
const keyOf = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

/**
 * THE HIGHEST ROAD OVER A RECTANGLE (`main.ts` surfaceTopIn: where the pick's ray starts down, what the screen's ground reaches): each cell's
 * highest road end, of the roads that meet it, worked out the first time a rectangle reaches it and let go where the diary says the roads or
 * their solved heights changed. DO NOT work out the whole city's top for a pick (every node's cell at the first look and at every whole
 * change: the 10 km city's roads read for one cursor, MISSION.md item 5).
 */
export class RoadTop {
  private readonly doc: RoadDoc;
  private readonly net: Network;
  /** Each cell worked out: its highest road end (-Infinity: no road meets it). */
  private readonly cells = new Map<number, number>();
  private readonly cursor = new JournalCursor(KINDS);
  private computes = 0;

  /** `heightAt`: the solved road height at a point (`SceneHandle.elevationAt`). */
  constructor(doc: RoadDoc, net: Network, private readonly heightAt: (x: number, y: number) => number) {
    this.doc = doc;
    this.net = net;
  }

  /** The highest end of the roads meeting the cells `rect` reaches (rounded up to a whole unit); -Infinity with none. */
  heightIn(rect: ChangeRect): number {
    this.follow();
    this.computes = 0;
    let top = -Infinity;
    const cx0 = Math.floor(rect[0] / CELL), cx1 = Math.floor(rect[2] / CELL);
    const cy0 = Math.floor(rect[1] / CELL), cy1 = Math.floor(rect[3] / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = keyOf(cx, cy);
        let cell = this.cells.get(key);
        if (cell === undefined) { this.cells.set(key, cell = this.cellTop(key)); this.computes++; }
        if (cell > top) top = cell;
      }
    }
    return Number.isFinite(top) ? Math.ceil(top) : top;
  }

  /** The cells the last `heightIn` worked out (for the tests). */
  get lastComputes(): number {
    return this.computes;
  }

  /** The cells the diary's changes since the last look reach let go; all of them when it cannot say where. */
  private follow(): void {
    const entries = this.cursor.read(this.doc.changes);
    if (entries === null || entries.some((e) => e.rects === null)) { this.cells.clear(); return; }
    for (const e of entries) {
      for (const [x0, y0, x1, y1] of e.rects!) {
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) this.cells.delete(keyOf(cx, cy));
      }
    }
  }

  /** The highest end of the roads that meet cell `key` (a road's deck between its ends' heights). */
  private cellTop(key: number): number {
    let top = -Infinity;
    for (const id of this.net.segmentCells.idsMeeting(cellRect(key))) {
      const segment = this.doc.segment(id);
      if (!segment) continue;
      for (const end of [segment.a, segment.b]) {
        const node = this.doc.node(end);
        if (node) top = Math.max(top, this.heightAt(node.x, node.y));
      }
    }
    return top;
  }
}
