import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Mesh, MeshStandardMaterial } from 'three';

import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import { SIGN_TYPES, snapLandscape } from '@world/landscape';
import type { ChangeRect } from '@world/changes';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';
import { createSignLayer, type SignLayerKept } from '@render/signLayer';

/** THE SIGNS HELD ROUND THE VIEW, CELL BY CELL (`signLayer.ts`): the signs the layer keeps from the diary are, at every step of random edits, the signs stood from nothing */

const span = m(400);

class Town {
  readonly doc = new RoadDoc();
  readonly net = new Network(this.doc);
  elevation: RoadElevation;
  private seen = 0;
  constructor() {
    const rng = new Rng(7);
    // The regional standard: speed plates past the junctions besides the rules' plates.
    this.doc.setMarkingStyle('br');
    for (let i = 0; i < 24; i++) this.road(rng);
    this.net.rebuild();
    this.elevation = buildRoadElevation(this.net, () => 0);
    this.seen = this.doc.changes.version;
  }
  get changes() { return this.doc.changes; }
  /** A road from a node of the town (a junction) or from anywhere. */
  road(rng: Rng): void {
    const nodes = [...this.doc.nodes.values()];
    const a = nodes.length && rng.float() < 0.8 ? nodes[Math.floor(rng.float() * nodes.length)]!
      : this.doc.addNode({ x: rng.float() * span, y: rng.float() * span });
    const b = this.doc.addNode({ x: a.x + (rng.float() - 0.5) * m(160), y: a.y + (rng.float() - 0.5) * m(160) });
    this.doc.addSegment(a.id as NodeId, b.id, 1 + Math.floor(rng.float() * 3));
  }
  /** After an edit: the network rebuilt and the roads' heights solved, written as the renderer writes them. */
  settle(): void {
    if (this.net.revision !== this.doc.revision) this.net.rebuild();
    const roads = this.doc.changes.since(this.seen, ['roads']);
    if (roads === null || roads.length) {
      this.elevation = buildRoadElevation(this.net, () => 0);
      const rects: ChangeRect[] | null = roads === null || roads.some((e) => e.rects === null) ? null
        : roads.flatMap((e) => e.rects!.map((r): ChangeRect => [r[0] - m(5), r[1] - m(5), r[2] + m(5), r[3] + m(5)]));
      this.doc.changes.record('elevation', rects);
    }
    this.seen = this.doc.changes.version;
  }
  /** A point on a footway near a random point, or the point. */
  spot(rng: Rng): { x: number; y: number } {
    const at = { x: rng.float() * span, y: rng.float() * span };
    const snap = snapLandscape(this.net, this.doc.landscape.values(), 'sign', at, m(40));
    return snap.ok ? snap.at : at;
  }
}

const sign = (town: Town, rng: Rng): { kind: 'sign' | 'streetname'; at: { x: number; y: number }; extra: { signType?: (typeof SIGN_TYPES)[number]; text: string } } =>
  rng.float() < 0.5
    ? { kind: 'sign', at: town.spot(rng), extra: { signType: SIGN_TYPES[Math.floor(rng.float() * SIGN_TYPES.length)]!, text: `${Math.floor(rng.float() * 80)}` } }
    : { kind: 'streetname', at: town.spot(rng), extra: { text: `Rua ${Math.floor(rng.float() * 1000)}` } };

const edits = [
  (town: Town, rng: Rng) => { const s = sign(town, rng); town.doc.addLandscape(s.kind, s.at, s.extra); town.settle(); },
  // A batch, as the city generator places its furniture and names: one entry.
  (town: Town, rng: Rng) => {
    const n = 1 + Math.floor(rng.float() * 12);
    town.doc.addLandscapeMany(Array.from({ length: n }, () => rng.float() < 0.5 ? sign(town, rng) : { kind: 'bench' as const, at: town.spot(rng) }));
    town.settle();
  },
  (town: Town, rng: Rng) => {
    const ids = [...town.doc.landscape.keys()];
    if (ids.length) town.doc.removeLandscape(ids[Math.floor(rng.float() * ids.length)]!);
    town.settle();
  },
  (town: Town, rng: Rng) => { town.road(rng); town.settle(); },
  (town: Town, rng: Rng) => {
    const ids = [...town.doc.segments.keys()];
    if (ids.length > 3) town.doc.removeSegment(ids[Math.floor(rng.float() * ids.length)]! as SegmentId);
    town.settle();
  },
  (town: Town, rng: Rng) => { town.doc.setMarkingStyle(rng.float() < 0.5 ? 'br' : 'classic'); town.settle(); },
];

/** A canvas without a page: the sizes it is given, and a 2D context that draws nothing. */
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  const context: unknown = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? () => ({ width: 0 }) : () => {},
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => context };
}

/** The eye over the town's middle: the whole town within the layer's reach. */
const EYE = { x: span / 2, y: span / 2 };

/** The layer brought up to the town, every cell the view wants stood; the plates standing, as text, sorted. */
function stood(layer: SignLayerKept, town: Town): string[] {
  for (let i = 0; i < 200; i++) {
    layer.sync(town.net, town.elevation, EYE);
    if (layer.cells.wantedKeys.every((key) => layer.cells.has(key))) break;
  }
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return layer.standing().map((s) => JSON.stringify([r(s.x), r(s.y), r(s.ground), s.type, s.text, r(s.yaw)])).sort();
}

describe('the signs kept from the diary, cell by cell', () => {
  beforeAll(() => { vi.stubGlobal('document', { createElement: () => fakeCanvas() }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('are, at every step, the signs stood from nothing, and an idle sync stands no cell again', () => {
    const town = new Town();
    const rng = new Rng(0x5167);
    const kept = createSignLayer();
    stood(kept, town);
    let compared = 0;
    for (let step = 0; step < 120; step++) {
      edits[Math.floor(rng.float() * edits.length)]!(town, rng);
      const mine = stood(kept, town);
      const fresh = createSignLayer();
      const want = stood(fresh, town);
      expect(mine, `step ${step}`).toEqual(want);
      compared += want.length;
      fresh.dispose();
      // Nothing new: nothing stood again.
      const before = kept.cells.work.derived;
      kept.sync(town.net, town.elevation, EYE);
      expect(kept.cells.work.derived, `step ${step}: an idle sync stands nothing`).toBe(before);
    }
    expect(compared).toBeGreaterThan(500);
    kept.dispose();
  });

  it('stand no junction again for a landscaping entry: only the cells of the signs and names it placed', () => {
    const town = new Town();
    const rng = new Rng(0x51);
    for (let i = 0; i < 20; i++) edits[3]!(town, rng);
    const layer = createSignLayer();
    stood(layer, town);
    expect(layer.standing().length).toBeGreaterThan(3);
    // Benches everywhere: nothing of the signs to stand.
    town.doc.addLandscapeMany(Array.from({ length: 40 }, () => ({ kind: 'bench' as const, at: town.spot(rng) })));
    town.settle();
    let before = layer.cells.work.derived;
    stood(layer, town);
    expect(layer.cells.work.derived - before).toBe(0);
    // Three names: their cells, three at most, and no junction's cell elsewhere.
    town.doc.addLandscapeMany([0, 1, 2].map((i) => ({ kind: 'streetname' as const, at: town.spot(rng), extra: { text: `Rua ${i}` } })));
    town.settle();
    before = layer.cells.work.derived;
    stood(layer, town);
    expect(layer.cells.work.derived - before).toBeLessThanOrEqual(3);
    layer.dispose();
  });

  it('a post and a plate drawn with the programs of the posts and plates the layer stands (compiled ahead)', () => {
    const town = new Town();
    const rng = new Rng(0x9a);
    for (let i = 0; i < 20; i++) edits[0]!(town, rng);
    const layer = createSignLayer();
    stood(layer, town);
    const drawn = new Map<string, Mesh>();
    layer.group.traverse((o) => { if ((o as Mesh).isMesh) drawn.set(o.name, o as Mesh); });
    const warm = layer.warm();
    expect(new Set(warm.map((w) => w.name))).toEqual(new Set(drawn.keys()));
    // What three keys a program by (`WebGLPrograms.getParameters`)
    const key = (mesh: Mesh): string => {
      const mat = mesh.material as MeshStandardMaterial;
      const instanced = mesh as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
      return JSON.stringify([mat.type, !!mat.map, mat.alphaTest > 0, mat.side, mat.vertexColors, mat.transparent, mat.roughness, mat.metalness,
        !!instanced.isInstancedMesh, !!instanced.instanceColor, mesh.castShadow, Object.keys(mesh.geometry.attributes).sort()]);
    };
    for (const mesh of warm) expect(key(mesh), mesh.name).toBe(key(drawn.get(mesh.name)!));
    layer.dispose();
  });
});
