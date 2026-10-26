import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';
import type { Walkways } from '@world/walkways';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { Meso } from '@sim/meso/meso';
import { TopologyCatchUp } from '@sim/topologyCatchUp';
import { DT } from '@sim/params';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { spawnVehicleAt } from '@sim/vehicles/spawn';

/** THE LANE GRAPH AND THE WALKWAYS HOLD THE MICRO WINDOW'S ROADS ALONE (`SimWorld.useMeso`, `LaneletGraph.scope`, `Walkways.scope`): built where the window goes, taken out where it left, every car handed to the meso at its edge */

const BLOCK = 120;

/** A grid of 12 x 12 blocks (1.4 km a side) with a road off the map at two corners. */
function town(): RoadDoc {
  const n = 12;
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

/** The game's world: the micro window on, the meso driving the map, the topology caught up off the step as the frame loop does (`simHost.ts`). */
function game(): { w: SimWorld; meso: Meso; frames: (seconds: number) => void; whole: LaneletGraph } {
  const doc = town();
  const net = new Network(doc);
  net.rebuild();
  const whole = new LaneletGraph();
  whole.build(doc, net);
  const w = new SimWorld(doc, net, 0x3e52);
  w.useMicroWindow();
  const meso = new Meso();
  w.useMeso(meso);
  w.trafficIntensity = 10;
  w.clock.paused = false;
  const topology = new TopologyCatchUp();
  const frames = (seconds: number): void => {
    for (let t = 0; t < Math.round(seconds / DT); t++) {
      const catching = topology.step(w, net.trafficToken(), false);
      if (!catching) topology.stepWindow(w, net.trafficToken());
      w.topologyDeferred = catching;
      w.walkwaysNow();
      step(w, { traffic: true, pedestrians: false });
    }
  };
  return { w, meso, frames, whole };
}

/** Every junction of the graph has every one of its roads' lanes (its legs all there), and every lane's road is one the window holds. */
function expectWindowRoads(w: SimWorld, win: { x: number; y: number; r: number }): void {
  const inside = new Set<number>();
  for (const seg of w.doc.segments.values()) {
    const a = w.doc.node(seg.a)!, b = w.doc.node(seg.b)!;
    if (Math.hypot((a.x + b.x) / 2 - win.x, (a.y + b.y) / 2 - win.y) < win.r) inside.add(seg.id);
  }
  const held = new Set<number>();
  for (const seg of inside) for (const node of [w.doc.segment(seg)!.a, w.doc.segment(seg)!.b]) for (const other of w.doc.node(node)!.incident) held.add(other);
  for (const lane of w.graph.lanelets.values()) if (lane.kind === 'link') expect(held.has(lane.segment!), `lane ${lane.id}`).toBe(true);
  for (const seg of held) expect(w.graph.linksOfSegment(seg).length, `road ${seg}`).toBeGreaterThan(0);
  for (const node of w.graph.junctions.keys()) {
    for (const seg of w.doc.node(node)!.incident) expect(w.graph.linksOfSegment(seg).length, `junction ${node}, road ${seg}`).toBeGreaterThan(0);
  }
}

describe("the micro window's roads", () => {
  it('are the only roads the lane graph and the walkways hold, their junctions whole, and move with the window', () => {
    const { w, meso, frames, whole } = game();
    // Round the south-west corner, where a road leads off the map: the meso's cars come in there.
    const win = { x: m(-600), y: m(-600), r: m(250) };
    meso.want(win.x, win.y, win.r);
    frames(2);
    expect(w.graph.lanelets.size).toBeGreaterThan(0);
    expect(w.graph.lanelets.size).toBeLessThan(whole.lanelets.size / 3);
    expectWindowRoads(w, win);
    expect(meso.microWindow()).toEqual(win);
    // The footways held are the roads held, and the window's edge has the ends people come in and go out at.
    const walkways = (w as unknown as { walkways: Walkways }).walkways;
    for (const way of w.walkwaysNow().walkways()) if (way.segment !== undefined) expect(w.graph.linksOfSegment(way.segment).length, `footway of ${way.segment}`).toBeGreaterThan(0);
    expect(walkways.edgeEnds().length).toBeGreaterThan(0);
    frames(40);
    expect(meso.owned.size).toBeGreaterThan(5);
    for (const id of meso.owned) {
      const v = w.vehicles.get(id as never)!;
      expect(w.lanelet(v.lanelet), `vehicle ${id}`).toBeDefined();
    }
    // The window moves east: the roads it left go, those it reached come, no car lost between the two models.
    w.trafficIntensity = 0;
    frames(1);
    const total = (): number => meso.model.vehicles() + meso.owned.size;
    const before = total();
    const moved = { x: m(-100), y: m(-600), r: m(250) };
    meso.want(moved.x, moved.y, moved.r);
    frames(3);
    expect(meso.microWindow()).toEqual(moved);
    expectWindowRoads(w, moved);
    // A car or two left the map by the corner's road end meanwhile.
    expect(Math.abs(total() - before)).toBeLessThanOrEqual(4);
    for (const v of w.vehicles.values()) expect(w.lanelet(v.lanelet), `vehicle ${v.id}`).toBeDefined();
  });

  it("hands a car that is not the meso's own to the meso at the window's edge, its trip ending there", () => {
    const { w, meso, frames } = game();
    meso.want(m(-600), m(-600), m(250));
    frames(2);
    w.trafficIntensity = 0;
    const lanes = [...w.graph.lanelets.values()].filter((l) => l.kind === 'link' && meso.slotOfLane(w, l.id) !== undefined && meso.model.isInside(meso.slotOfLane(w, l.id)!));
    const lane = lanes.find((l) => l.length > m(60))!;
    const sedan = ARCHETYPES.find((a) => a.id === 'sedan')!;
    const id = spawnVehicleAt(w, lane.id, m(30), sedan);
    expect(id).not.toBeNull();
    const v = w.vehicles.get(id as never)!;
    expect(meso.owned.has(v.id)).toBe(false);
    // Bound for a lane just past the window's edge, not a road end of the map.
    expect(v.destination).not.toBeNull();
    expect(new Set(meso.handoffLanes(w)).has(v.destination!)).toBe(true);
    const handed = meso.model.handedIn;
    frames(120);
    expect(w.vehicles.has(id as never)).toBe(false);
    expect(meso.model.handedIn).toBeGreaterThan(handed);
  });
});
