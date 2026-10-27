import { describe, expect, it } from 'vitest';

import { pointInPolygon } from '@core/polygon';
import { coverRows } from '@render/buildings/coverJobs';
import { type CoverAsk, coverCellOf, coverPolygons, createCoverIndex, packCover, unpackCover } from '@render/buildings/layerCells';
import { TableWriter, tableRecords } from '@world/buildings/recordTable';
import { serve as serveCover, type CoverCellReply } from '@render/buildings/coverCell.worker';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { BuildingStore } from '@world/buildings/store';
import { type Building, asBuildingId } from '@world/buildings/types';
import { ChangeJournal } from '@world/changes';
import { m } from '@world/units';

/** The plant cull's index of where the buildings stand, derived cell by cell from the document and dropped where its diary says */
function building(id: number, x: number, y: number, rotation = 0): Building {
  const bp = BLUEPRINTS[id % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: asBuildingId(id), x, y, rotation } as Building;
}

/** Whether some building of the store covers (x, y), asked of every one: what the index must answer. */
const coveredByAny = (store: BuildingStore, x: number, y: number): boolean => {
  for (const b of store.all()) for (const poly of coverPolygons(b)) if (pointInPolygon({ x, y }, poly)) return true;
  return false;
};

/** The cover asked off the page as the job threads answer it (`coverCell.worker.ts`), in this thread: the rows copied, read, packed and unpacked; answered when `land` is called. */
function threadAsk(): { ask: CoverAsk; land: () => Promise<void>; asked: () => number } {
  const rows = coverRows();
  const queue: (() => void)[] = [];
  let asked = 0;
  const ask: CoverAsk = (rect, buildings) => {
    asked++;
    // The rows read when asked; answered later, as a job is.
    const table = rows(rect, buildings);
    return new Promise((done) => queue.push(() => done(unpackCover(packCover(coverCellOf(table ? tableRecords<Building>(table) : [], rect))))));
  };
  const land = async (): Promise<void> => {
    while (queue.length) queue.shift()!();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { ask, land, asked: () => asked };
}

describe('the cover index, cell by cell', () => {
  it('answers as every building asked, through edits', () => {
    let seed = 3;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const changes = new ChangeJournal();
    const buildings = new BuildingStore(changes);
    const live = createCoverIndex();
    // Across several of the world's cells (256 m), so buildings straddle their edges.
    const span = m(520);
    let covered = 0;
    for (let step = 0; step < 120; step++) {
      const id = 1 + Math.floor(rand() * 20);
      if (buildings.has(asBuildingId(id)) && rand() < 0.3) buildings.remove(asBuildingId(id));
      else buildings.restore(asBuildingId(id), building(id, rand() * span, rand() * span, rand() * Math.PI));
      if (step % 10 !== 9) continue;
      live.follow({ buildings, changes });
      for (let i = 0; i < 400; i++) {
        const x = rand() * span * 1.2 - span * 0.1, y = rand() * span * 1.2 - span * 0.1;
        const want = coveredByAny(buildings, x, y);
        expect(live.covers(x, y)).toBe(want);
        if (want) covered++;
      }
    }
    expect(covered).toBeGreaterThan(30);
  });

  it('worked out off the page, answers as every building asked once its cells are in, an answer asked before an edit let go', async () => {
    let seed = 11;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const changes = new ChangeJournal();
    const buildings = new BuildingStore(changes);
    const span = m(520);
    for (let id = 1; id <= 20; id++) buildings.restore(asBuildingId(id), building(id, rand() * span, rand() * span, rand() * Math.PI));
    const jobs = threadAsk();
    const index = createCoverIndex(jobs.ask);
    index.follow({ buildings, changes });
    const area = [-span * 0.1, -span * 0.1, span * 1.1, span * 1.1] as const;
    const fill = async (): Promise<void> => {
      for (let round = 0; round < 50 && !index.ready(area); round++) await jobs.land();
      expect(index.ready(area)).toBe(true);
    };
    const check = (): number => {
      let covered = 0;
      for (let i = 0; i < 3000; i++) {
        const x = rand() * span * 1.2 - span * 0.1, y = rand() * span * 1.2 - span * 0.1;
        const want = coveredByAny(buildings, x, y);
        expect(index.covers(x, y)).toBe(want);
        if (want) covered++;
      }
      return covered;
    };
    // Nothing in before its cells come back: not ready, and nothing covered meanwhile.
    expect(index.ready(area)).toBe(false);
    await fill();
    expect(check()).toBeGreaterThan(30);
    // An edit while cells are in flight: what they read may be gone, so their answers are let go and the cells asked again.
    buildings.remove(asBuildingId(3));
    index.follow({ buildings, changes });
    index.ready(area);
    buildings.restore(asBuildingId(3), building(3, span / 2, span / 2));
    buildings.remove(asBuildingId(7));
    index.follow({ buildings, changes });
    await fill();
    check();
    expect(jobs.asked()).toBeGreaterThan(0);
  });

  it('lets go of only the cells in flight an edit reached: a town that grows still gets its cover', async () => {
    const changes = new ChangeJournal();
    const buildings = new BuildingStore(changes);
    buildings.restore(asBuildingId(1), building(1, m(40), m(40)));
    const jobs = threadAsk();
    const index = createCoverIndex(jobs.ask);
    index.follow({ buildings, changes });
    const near = [m(0), m(0), m(100), m(100)] as const;
    expect(index.ready(near)).toBe(false);
    const asked = jobs.asked();
    // A building raised kilometres away while the near cell is in flight: its answer still held, never asked again.
    buildings.restore(asBuildingId(2), building(2, m(3000), m(3000)));
    index.follow({ buildings, changes });
    await jobs.land();
    expect(index.ready(near)).toBe(true);
    expect(jobs.asked()).toBe(asked);
    // One raised in it while it is asked again: the stale answer let go, the cell asked once more.
    buildings.restore(asBuildingId(3), building(3, m(60), m(10)));
    index.follow({ buildings, changes });
    expect(index.ready(near)).toBe(false);
    const again = jobs.asked();
    buildings.restore(asBuildingId(4), building(4, m(20), m(80)));
    index.follow({ buildings, changes });
    await jobs.land();
    expect(index.ready(near)).toBe(false);
    expect(jobs.asked()).toBeGreaterThan(again);
    await jobs.land();
    expect(index.ready(near)).toBe(true);
    for (const [x, y] of [[40, 40], [60, 10], [20, 80], [90, 90]] as const) expect(index.covers(m(x), m(y))).toBe(coveredByAny(buildings, m(x), m(y)));
  });

  it('packs a cell into arrays of its own: an empty cell sent twice, as a job sends it, both times whole', () => {
    for (let k = 0; k < 2; k++) {
      const packed = packCover(coverCellOf([], [0, 0, m(250), m(250)]));
      const transfer = [packed.xy.buffer, packed.starts.buffer, packed.keys.buffer, packed.at.buffer, packed.polygons.buffer] as ArrayBuffer[];
      const moved = structuredClone(packed, { transfer });
      expect(moved.starts.length).toBe(1);
      expect(unpackCover(moved).starts.length).toBe(1);
    }
    const one = building(1, m(40), m(40));
    const full = coverCellOf([one], [0, 0, m(250), m(250)]);
    const packed = packCover(full);
    structuredClone(packed, { transfer: [packed.xy.buffer, packed.starts.buffer] as ArrayBuffer[] });
    // The cell packed still holds its own arrays.
    expect(full.xy.length).toBeGreaterThan(0);
  });

  it('works a cell out the same from the rows of the map table (a thread sharing its memory) as from rows copied for it', () => {
    const buildings = Array.from({ length: 6 }, (_, i) => building(i + 1, m(20 + 40 * i), m(30 + 25 * (i % 3))));
    const writer = new TableWriter(true);
    writer.add(buildings);
    const map = writer.finish().buffer;
    const copied = new TableWriter(false);
    copied.add(buildings);
    const rect = [0, 0, m(250), m(250)] as const;
    const replies: CoverCellReply[] = [];
    const scope = { postMessage: (reply: CoverCellReply) => { replies.push(reply); }, onmessage: null as ((event: MessageEvent) => void) | null };
    serveCover(scope as never);
    scope.onmessage!({ data: { id: 1, rect, table: null, refs: buildings.map((_, row) => ({ buffer: map, row })) } } as MessageEvent);
    scope.onmessage!({ data: { id: 2, rect, table: copied.finish().buffer } } as MessageEvent);
    const [a, b] = replies.map((r) => ('cover' in r ? unpackCover(r.cover) : null));
    expect(a && b).toBeTruthy();
    expect([...a!.xy]).toEqual([...b!.xy]);
    expect([...a!.starts]).toEqual([...b!.starts]);
    expect([...a!.buckets.keys()]).toEqual([...b!.buckets.keys()]);
  });

  it('drops only the cells an edit reached, and moves its version with them', () => {
    const changes = new ChangeJournal();
    const buildings = new BuildingStore(changes);
    for (let i = 0; i < 40; i++) buildings.restore(asBuildingId(i + 1), building(i + 1, (i % 8) * m(300), Math.floor(i / 8) * m(300)));
    const index = createCoverIndex();
    index.follow({ buildings, changes });
    // Every cell asked once.
    for (let x = 0; x < m(2400); x += m(64)) for (let y = 0; y < m(1500); y += m(64)) index.covers(x, y);
    const held = index.cells.size;
    const v = index.version;
    const before = index.cells.work.invalidated;
    buildings.restore(asBuildingId(5), building(5, m(1210), m(20)));
    index.follow({ buildings, changes });
    const dropped = index.cells.work.invalidated - before;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(9);
    expect(index.cells.size).toBe(held - dropped);
    expect(index.version).toBe(v + 1);
    expect(index.covers(m(1215), m(25))).toBe(coveredByAny(buildings, m(1215), m(25)));
  });
});
