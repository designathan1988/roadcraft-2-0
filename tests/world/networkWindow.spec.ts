import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { NetworkWindow, type RoadBakeAsk, roadsOfTiles, tilesMeeting } from '@world/networkWindow';
import { networkWork } from '@world/rebuildWork';
import { TILE, tileKey } from '@world/tiles';
import { m } from '@world/units';
import { bakeRoads } from '../../src/roadBake.worker';

/**
 * THE PAGE'S NETWORK HOLDING THE TILES NEAR THE VIEW (`world/networkWindow.ts`, `roadBake.worker.ts`): a tile wanted has its junctions and
 * ribbons solved off the page from its roads and those at their ends alone, taken by the page's build as the whole network's, none solved
 * again; the tiles no longer wanted leave; a tool's reach is held at once; and a move of the roads held is said as one (`NetworkDelta.scopeOnly`),
 * an edit never.
 */

/** A grid of streets over `n` x `n` blocks of `side`: 12 blocks of 140 m span two tiles each way. */
function grid(n: number, side: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: i * side + m(20), y: j * side + m(20) }).id);
  }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, (i + j) % 3 === 0 ? 3 : 1);
    if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
  }
  return doc;
}

/** The whole network solved alone. */
function wholeOf(doc: RoadDoc): Network {
  const whole = new Network(doc);
  whole.rebuild();
  return whole;
}

/** The pieces a network holds that are the whole network's by construction: the ribbons of the roads whose both ends have their junctions, and those junctions. */
function inside(net: Network): { segments: SegmentId[]; nodes: NodeId[] } {
  const segments = [...net.ribbons.keys()].filter((id) => { const s = net.doc.segment(id)!; return net.complete(s.a) && net.complete(s.b); }).sort((p, q) => p - q);
  const nodes = [...net.junctions.keys()].filter((node) => net.doc.node(node)!.incident.every((seg) => { const s = net.doc.segment(seg)!; return net.complete(s.a) && net.complete(s.b); })).sort((p, q) => p - q);
  return { segments, nodes };
}

/** A window whose bakes come from the worker's solve, as a job answers (a tick later); `offPage` counts the junctions that solve built (here, in the same process). */
function windowOf(doc: RoadDoc, net: Network, asks: RoadBakeAsk[] = [], offPage = { built: 0 }): NetworkWindow {
  return new NetworkWindow(doc, net, (ask) => {
    asks.push(ask);
    const before = networkWork.built;
    const bake = structuredClone(bakeRoads(ask));
    offPage.built += networkWork.built - before;
    return Promise.resolve(bake);
  }, () => 0);
}

/** The window stepped until its asks are answered and taken. */
async function settled(window: NetworkWindow): Promise<void> {
  for (let i = 0; i < 8; i++) { window.step(); await Promise.resolve(); await Promise.resolve(); }
  window.step();
}

describe("the page's network window", () => {
  it('holds a tile wanted with its junctions solved off the page, the same as the whole network, none solved here', async () => {
    const doc = grid(12, m(140));
    expect(tilesMeeting([0, 0, 12 * m(140), 12 * m(140)]).size).toBe(4);
    const whole = wholeOf(doc);
    const net = new Network(doc);
    const asks: RoadBakeAsk[] = [];
    const offPage = { built: 0 };
    const window = windowOf(doc, net, asks, offPage);
    const first = tileKey(0, 0);
    window.want(new Set([first]));
    const before = { ...networkWork };
    await settled(window);
    expect(window.holds(first)).toBe(true);
    expect(asks.length).toBe(1);
    // Its roads and those at their ends, and nothing of the other tiles.
    expect(new Set(net.ribbons.keys())).toEqual(roadsOfTiles(doc, [first]));
    expect(net.ribbons.size).toBeLessThan(doc.segments.size / 2);
    for (const node of net.junctions.keys()) expect(net.complete(node)).toBe(true);
    // Every node of the tile's roads has its junction, taken from the worker's solve: the whole network's, piece for piece; none built here.
    const { segments, nodes } = inside(net);
    expect(nodes.length).toBeGreaterThan(20);
    expect(net.exportBake(nodes, segments)).toEqual(whole.exportBake(nodes, segments));
    for (const id of segments) expect(net.trims.get(id)).toEqual(whole.trims.get(id));
    // Every junction built off the page (here, in the same process), none on it.
    expect(offPage.built).toBeGreaterThan(20);
    expect(networkWork.built - before.built).toBe(offPage.built);
  });

  it('moves with the view: the tiles that came in, the tiles that left out, said as a move of the roads held and not an edit', async () => {
    const doc = grid(12, m(140));
    const net = new Network(doc);
    const window = windowOf(doc, net);
    window.want(new Set([tileKey(0, 0)]));
    await settled(window);
    const was = new Set(net.ribbons.keys());
    const state = net.state;
    window.want(new Set([tileKey(1, 0)]));
    await settled(window);
    expect(window.holds(tileKey(0, 0))).toBe(false);
    expect(window.holds(tileKey(1, 0))).toBe(true);
    const now = new Set(net.ribbons.keys());
    expect(now).toEqual(roadsOfTiles(doc, [tileKey(1, 0)]));
    expect([...was].some((id) => !now.has(id))).toBe(true);
    const delta = net.changesSince(state)!;
    expect(delta.scopeOnly).toBe(true);
    for (const id of was) if (!now.has(id)) expect(delta.segments.has(id)).toBe(true);
    // An edit's rebuild is never a move of the roads held alone.
    const edited = net.state;
    const a = doc.node([...now].map((id) => doc.segment(id)!.a)[0]!)!;
    doc.addSegment(a.id, doc.addNode({ x: a.x + m(30), y: a.y + m(31) }).id, 1);
    net.rebuild();
    expect(net.changesSince(edited)!.scopeOnly).toBe(false);
  });

  it("holds a tool's reach at once, solved here, and keeps it a while past the view's own tiles", async () => {
    const doc = grid(12, m(140));
    const net = new Network(doc);
    let now = 0;
    const window = new NetworkWindow(doc, net, (ask) => Promise.resolve(bakeRoads(ask)), () => now);
    window.want(new Set([tileKey(0, 0)]));
    await settled(window);
    // Round the grid's node at (1280, 1280), in the tile across from the first.
    const far: [number, number, number, number] = [TILE + m(270), TILE + m(270), TILE + m(290), TILE + m(290)];
    expect(net.ribbonsMeeting(far).length).toBe(0);
    window.ensure(far);
    expect(window.holds(tileKey(1, 1))).toBe(true);
    expect(net.ribbonsMeeting(far).length).toBeGreaterThan(0);
    // The view's look keeps its own tiles only; the tool's stays until its time is up.
    window.want(new Set([tileKey(0, 0)]));
    window.step();
    expect(window.holds(tileKey(1, 1))).toBe(true);
    now = 10_000;
    window.step();
    expect(window.holds(tileKey(1, 1))).toBe(false);
  });

  it('solves the tiles wanted here when no worker can (the specs), and finds the roads held again over a map put in place', () => {
    const doc = grid(12, m(140));
    const net = new Network(doc);
    const window = new NetworkWindow(doc, net, null, () => 0);
    window.want(new Set([tileKey(0, 1)]));
    expect(window.step()).toBe(true);
    expect(new Set(net.ribbons.keys())).toEqual(roadsOfTiles(doc, [tileKey(0, 1)]));
    expect(window.step()).toBe(false);
    // Another map in place of this one (the same tiles held): the network's rebuild from nothing holds that map's roads of the tiles.
    const other = grid(6, m(300));
    doc.replaceFromJSON(other.toJSON(), { repair: false, whole: true });
    net.rebuild({ full: true });
    expect(new Set(net.ribbons.keys())).toEqual(roadsOfTiles(doc, [tileKey(0, 1)]));
    expect(net.ribbons.size).toBeGreaterThan(0);
  });
});
