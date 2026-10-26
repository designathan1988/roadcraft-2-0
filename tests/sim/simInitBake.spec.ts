import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import { SimHost } from '@sim/host/simHost';
import { type FromSim, type ToSim, makeSharedFrames } from '@sim/host/protocol';
import { trafficMapOf } from '@sim/agents/trafficBuildings';
import { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { Network, type NetworkBake } from '@world/network';
import { networkWork } from '@world/rebuildWork';
import { m } from '@world/units';

/** SIM-04: the worker's network holds the micro window's roads alone, and takes the page's junctions and ribbons of them as solved (`bakeAsk`), building the same network the page would; nothing of the map is sent whole at the start. */

function grid(n: number, side: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: i * side, y: j * side }).id);
  }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    if (i < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, (i + j) % 3 === 0 ? 3 : 1);
    if (j < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, 1);
  }
  return doc;
}

const CONTROLS = { speed: 1, paused: false, traffic: true, pedestrians: false, trafficIntensity: 1, pedestrianIntensity: 1, demandMultiplier: 1, maxShare: 1, focus: null };

/** The page's client and the worker's host in one thread, each message handled in order; `page`: the page's network, which answers the worker's asks. */
function wired(doc: RoadDoc, page: Network | null): { host: SimHost; client: SimClient; settled: () => Promise<void> } {
  const client = new SimClient(doc, page);
  let chain = Promise.resolve();
  const host = new SimHost((message: FromSim) => (client as unknown as { receive(m: FromSim): void }).receive(message));
  (client as unknown as { worker: { postMessage(message: ToSim): void } }).worker = {
    postMessage: (message) => { chain = chain.then(() => host.handle(message)); },
  };
  return { host, client, settled: () => chain };
}

/** The window stood round (x, y) with radius `r`: told, then frames enough for its roads to be held and its junctions built. */
async function windowed(host: SimHost, settled: () => Promise<void>, x: number, y: number, r: number): Promise<void> {
  await host.handle({ type: 'window', x, y, r, whole: false });
  for (let f = 0; f < 12; f++) {
    await host.handle({ type: 'frame', wall: 1 / 30, hold: false, controls: CONTROLS } as ToSim);
    await settled();
  }
}

const netOf = (host: SimHost): Network => (host as unknown as { net: Network }).net;
/** The roads held whose both ends have their junctions (not the window's edge), and those junctions. */
const insideSegments = (net: Network): SegmentId[] => [...net.ribbons.keys()].filter((id) => { const s = net.doc.segment(id)!; return net.complete(s.a) && net.complete(s.b); });
const insideNodes = (net: Network): NodeId[] => [...net.junctions.keys()].filter((node) => net.doc.node(node)!.incident.every((seg) => { const s = net.doc.segment(seg)!; return net.complete(s.a) && net.complete(s.b); }));
const inside = (net: Network): NetworkBake => net.exportBake(insideNodes(net), insideSegments(net));

describe("the worker's network", () => {
  it("holds the window's roads alone, takes the page's junctions of them as solved, and is the network the page solved", async () => {
    const doc = grid(4, m(140));
    const page = new Network(doc);
    page.rebuild();
    const { host, settled } = wired(doc, page);
    const before = networkWork.built;
    await host.handle({ type: 'init', map: trafficMapOf(doc), seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges', bakes: true } as ToSim);
    // Nothing of the map before the window stands.
    expect(netOf(host).ribbons.size).toBe(0);
    // A window over the left half: its roads held, their junctions taken from the page, none solved here.
    await windowed(host, settled, m(140), m(280), m(230));
    const net = netOf(host);
    expect(net.ribbons.size).toBeGreaterThan(0);
    expect(net.ribbons.size).toBeLessThan(doc.segments.size);
    expect(networkWork.built - before).toBe(0);
    for (const id of net.ribbons.keys()) expect(net.holds(id)).toBe(true);
    for (const node of net.junctions.keys()) expect(net.complete(node), `junction ${node}`).toBe(true);
    // The window's inside (the roads whose both ends have their junctions, and those junctions) is the page's network, piece for piece; a road out of the window ends where it leaves it.
    expect(inside(net)).toEqual(page.exportBake(insideNodes(net), insideSegments(net)));
    const segments = [...net.ribbons.keys()];
    // The window moves to the right half: the roads that left are gone, those that came are the page's again.
    await windowed(host, settled, m(420), m(280), m(230));
    expect(networkWork.built - before).toBe(0);
    const moved = netOf(host);
    expect([...moved.ribbons.keys()]).not.toEqual(segments);
    for (const id of moved.ribbons.keys()) expect(moved.holds(id)).toBe(true);
    expect(inside(moved)).toEqual(page.exportBake(insideNodes(moved), insideSegments(moved)));
  });

  it("solves the window's junctions itself where no page holds them solved", async () => {
    const doc = grid(4, m(140));
    const { host, settled } = wired(doc, null);
    const before = networkWork.built;
    await host.handle({ type: 'init', map: trafficMapOf(doc), seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges' } as ToSim);
    await windowed(host, settled, m(280), m(280), m(600));
    const net = netOf(host);
    expect(net.ribbons.size).toBe(doc.segments.size);
    expect(networkWork.built - before).toBeGreaterThanOrEqual(doc.nodes.size - 4);
    const page = new Network(doc);
    page.rebuild();
    expect(net.exportBake(doc.nodes.keys(), doc.segments.keys())).toEqual(page.exportBake(doc.nodes.keys(), doc.segments.keys()));
  });
});
