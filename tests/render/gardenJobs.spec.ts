import { describe, expect, it } from 'vitest';

import { rowCopier } from '@render/buildings/rowRefs';
import { serve as serveGardens, type GardenCellAsk, type GardenCellReply } from '@render/gardenCell.worker';
import { GARDEN_SLACK, gardenPacksOf } from '@render/gardenPlace';
import type { Pack } from '@render/cellInstances';
import { createPropAsks } from '@render/propAsks';
import type { PropPlacement } from '@render/propCells';
import { GroundShare, sharedGroundReaders } from '@render/sharedGround';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { TableWriter } from '@world/buildings/recordTable';
import { BuildingStore } from '@world/buildings/store';
import { type Building, type BuildingElement, asBuildingId } from '@world/buildings/types';
import { ChangeJournal, type ChangeRect } from '@world/changes';
import { ViewCells } from '@world/viewCells';
import { m } from '@world/units';

/** THE GARDENS PLACED OFF THE PAGE (`gardenCell.worker.ts`, `propAsks.ts`): the same plants as placed on the page, a cell derived once they came, an answer a change reached never taken */

const KINDS: BuildingElement['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];
/** A building with a garden of each kind of plant. */
function building(id: number, x: number, y: number): Building {
  const bp = BLUEPRINTS[id % BLUEPRINTS.length]!;
  const elements: BuildingElement[] = KINDS.map((kind, i) => ({ id: 100 + i, kind, x: m(2) + i * m(3), y: m(-4), facing: 0, w: kind === 'hedge' ? m(9) : m(2), d: m(1.5), z: 0, h: m(2) + i, angle: 0.1 * i }));
  return { ...JSON.parse(JSON.stringify(bp.body)), id: asBuildingId(id), x, y, rotation: id * 0.4, elements } as Building;
}

/** A job's answer from the worker's own code, in this thread. */
function answerOf(ask: GardenCellAsk): GardenCellReply {
  let reply: GardenCellReply | null = null;
  const scope = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (message: unknown) => { reply = message as GardenCellReply; } };
  serveGardens(scope);
  scope.onmessage!({ data: ask } as MessageEvent);
  return reply!;
}

const sameValues = (packs: ReadonlyMap<number, Pack>): Record<number, unknown> =>
  Object.fromEntries([...packs].map(([kind, p]) => [kind, { data: [...p.data], colours: p.colours ? [...p.colours] : null, scales: [...p.scales], count: p.count }]));

describe('the gardens placed off the page', () => {
  it('places the same plants as the page, read from the rows where the table holds them or copied', () => {
    const buildings = new BuildingStore(new ChangeJournal());
    for (let i = 1; i <= 24; i++) buildings.restore(asBuildingId(i), building(i, (i % 6) * m(40), Math.floor(i / 6) * m(40)));
    const ground = new GroundShare(9, m(10), m(40), m(3)).current!;
    const { groundAt } = sharedGroundReaders(ground);
    const rect: ChangeRect = [m(30), m(30), m(150), m(130)];
    const ids = buildings.nearIds(rect[0] - GARDEN_SLACK, rect[1] - GARDEN_SLACK, rect[2] + GARDEN_SLACK, rect[3] + GARDEN_SLACK);
    const onPage = gardenPacksOf(ids.map((id) => buildings.get(id)!), groundAt);
    expect(onPage.size).toBeGreaterThan(2);

    // Copied, as for a thread of another process.
    const copied = answerOf({ id: 1, rect, ground, table: rowCopier()(ids, buildings) });
    if ('error' in copied) throw new Error(copied.error);
    expect(sameValues(new Map(copied.packs.map((p) => [p.kind, p])))).toEqual(sameValues(onPage));

    // By their rows in a table (the map's, in the same memory).
    const writer = new TableWriter();
    writer.add(ids.map((id) => buildings.get(id)!));
    const table = writer.finish().buffer;
    const byRow = answerOf({ id: 2, rect, ground, table: null, refs: ids.map((_, row) => ({ buffer: table, row })) });
    if ('error' in byRow) throw new Error(byRow.error);
    expect(sameValues(new Map(byRow.packs.map((p) => [p.kind, p])))).toEqual(sameValues(onPage));
  });
});

describe('a prop layer\'s placements asked off the page', () => {
  /** A layer's asks with answers it lands by hand. */
  function asks() {
    const journal = new ChangeJournal();
    const cells = new ViewCells<number>({ name: 'test', version: 1, side: m(100), reach: 0, cpuBudget: Infinity, derive: () => ({ value: 0, cpuBytes: 0 }) });
    const pending: { rect: ChangeRect; done: (p: PropPlacement) => void; fail: (e: Error) => void }[] = [];
    let placedHere = 0, arrived = 0;
    const placing = (tag: number): PropPlacement => ({ packs: new Map([[tag, { data: new Float32Array(8), colours: null, scales: new Float32Array(1), count: 1 }]]), growing: false });
    const layer = createPropAsks({
      name: 'test', changes: ['buildings'], pad: m(2),
      place: () => { placedHere++; return placing(-1); },
      ask: (rect) => new Promise((done, fail) => pending.push({ rect, done, fail })),
      arrived: () => { arrived++; },
    });
    return { journal, cells, pending, layer, placing, placedHere: () => placedHere, arrived: () => arrived };
  }

  it('derives a cell only once its placement came, from that placement, asked once', async () => {
    const t = asks();
    const key = t.cells.cellAt(m(150), m(50));
    t.cells.want([key]);
    expect(t.layer.ready(t.cells, key)).toBe(false);
    expect(t.layer.ready(t.cells, key)).toBe(false);
    expect(t.pending).toHaveLength(1);
    const came = t.placing(7);
    t.pending[0]!.done(came);
    await Promise.resolve();
    expect(t.arrived()).toBe(1);
    expect(t.layer.ready(t.cells, key)).toBe(true);
    expect(t.layer.placementFor(t.cells, key, t.cells.rectOf(key))).toBe(came);
    expect(t.placedHere()).toBe(0);
    // Taken: the next one asked again.
    expect(t.layer.ready(t.cells, key)).toBe(false);
    expect(t.pending).toHaveLength(2);
  });

  it('never takes an answer a change reached, and asks it again', async () => {
    const t = asks();
    const key = t.cells.cellAt(m(150), m(50));
    t.cells.want([key]);
    t.layer.follow(t.journal);
    expect(t.layer.ready(t.cells, key)).toBe(false);
    // A building changed inside the cell while its placement was out.
    t.journal.record('buildings', [[m(120), m(20), m(130), m(30)]]);
    t.layer.follow(t.journal);
    t.pending[0]!.done(t.placing(7));
    await Promise.resolve();
    expect(t.arrived()).toBe(0);
    expect(t.layer.ready(t.cells, key)).toBe(false);
    expect(t.pending).toHaveLength(2);
    // A change elsewhere lets it be.
    t.journal.record('buildings', [[m(900), m(900), m(910), m(910)]]);
    t.layer.follow(t.journal);
    const came = t.placing(8);
    t.pending[1]!.done(came);
    await Promise.resolve();
    expect(t.layer.placementFor(t.cells, key, t.cells.rectOf(key))).toBe(came);
  });

  it('places on the page what could not be placed off it', async () => {
    const t = asks();
    const key = t.cells.cellAt(m(50), m(50));
    t.cells.want([key]);
    expect(t.layer.ready(t.cells, key)).toBe(false);
    t.pending[0]!.fail(new Error('a worker lost'));
    await Promise.resolve();
    await Promise.resolve();
    expect(t.layer.ready(t.cells, key)).toBe(true);
    expect(t.placedHere()).toBe(1);
  });

  it('lets go an answer no cache wants any more', async () => {
    const t = asks();
    const key = t.cells.cellAt(m(50), m(50));
    t.cells.want([key]);
    t.layer.ready(t.cells, key);
    t.pending[0]!.done(t.placing(3));
    await Promise.resolve();
    t.cells.want([]);
    t.layer.prune();
    // Wanted again: asked again, the one let go never taken.
    t.cells.want([key]);
    expect(t.layer.ready(t.cells, key)).toBe(false);
    expect(t.pending).toHaveLength(2);
  });
});
