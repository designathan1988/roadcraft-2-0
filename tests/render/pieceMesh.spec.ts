import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { Level } from '@world/roadTypes';
import { medianNose } from '@world/landscape';
import type { NodeId } from '@world/ids';
import type { Chain } from '@render/mesh/stripShape';
import { HEIGHT_TOL, type Tile, type TileMeshOptions } from '@render/mesh/tileMesh';
import { type TileSource, slotOf } from '@render/roadSurfaceReads';
import { type Geom, type PieceReach, WALL_A, WALL_B, WALL_END, WALL_START } from '@render/roads/pieceGeom';
import { type MeshedSurface, pieceBundle, seamsOf } from '@render/roads/pieceMesh';
import { type Shape, segmentShapes } from '@render/roads/segmentPiece';
import { junctionShapes } from '@render/roads/junctionPiece';

/**
 * A ROAD PIECE MESHED (`roads/pieceMesh.ts`): what the polygon mesher's tests held (`tileShape.ts`, gone with the outlines it cut), held of the
 * pieces' strips and plates - every top face up and none without area, a surface covered exactly, its height within the tolerance, two bands meeting
 * on the same vertices, a skirt following its surface and its foot, one uv a vertex, a triangle inside one texture frame, and the cost bounded; a
 * plate its outline's points alone, and a road's ends on its junction's mouths (the seams its blocks' far levels keep).
 */

const BANDS = ['deckEdge', 'footway', 'kerb', 'asphalt', 'curbRamp'] as const;
const SOURCES: readonly TileSource[] = [
  ...BANDS.map((band): TileSource => ({ kind: 'band', band })),
  ...(['kerb', 'planting', 'paved'] as const).map((part): TileSource => ({ kind: 'median', part })),
];

const flatUv = (x: number, y: number, out: [number, number]): void => { out[0] = x / 10; out[1] = y / 10; };
const base: TileMeshOptions = { top: () => 0, uv: flatUv, leastEdge: 0.5 };

/** The surfaces of a piece's shapes, each meshed with `options`. */
function specsFor(reach: PieceReach, options: TileMeshOptions): MeshedSurface[] {
  return SOURCES.filter((source) => reach.has(slotOf(source))).map((source) => ({ source, options: { ...options, name: slotOf(source) } }));
}

/** A piece's shapes by surface (`roadSurfacePass.ts` geomsOf). */
function reachOf(shapes: readonly Shape[]): Map<string, Geom[]> {
  const reach = new Map<string, Geom[]>();
  for (const { slot, geom } of shapes) {
    const list = reach.get(slot);
    if (list) list.push(geom); else reach.set(slot, [geom]);
  }
  return reach;
}

/** A chain along y = `y` from x0 to x1, a point every `step` (its arc length its x), `wobble` off the line. */
function chain(y: number, x0: number, x1: number, step: number, wobble = 0): Chain {
  const xy: number[] = [], s: number[] = [];
  for (let x = x0; x < x1 - 1e-9; x += step) { xy.push(x, y + (wobble ? wobble * Math.sin(x) : 0)); s.push(x); }
  xy.push(x1, y); s.push(x1);
  return { xy: Float64Array.from(xy), s: Float64Array.from(s) };
}

const strip = (a: Chain, b: Chain, walls = 0, group = 0): Geom => ({ kind: 'strip', a, b, group, walls });
const one = (slot: string, geoms: Geom[]): PieceReach => new Map([[slot, geoms]]);
const asphaltSpec = (options: TileMeshOptions): MeshedSurface[] => [{ source: { kind: 'band', band: 'asphalt' }, options: { ...options, name: 'asphalt' } }];

interface Tri { readonly a: number; readonly b: number; readonly c: number; readonly top: boolean }
/** A tile's triangles, each told top (its normal up) or skirt. */
function trianglesOf(tile: Tile): Tri[] {
  const out: Tri[] = [];
  for (let i = 0; i < tile.indices.length; i += 3) {
    const a = tile.indices[i]!, b = tile.indices[i + 1]!, c = tile.indices[i + 2]!;
    out.push({ a, b, c, top: (tile.normals[a * 3 + 1]! + tile.normals[b * 3 + 1]! + tile.normals[c * 3 + 1]!) / 3 > 0.5 });
  }
  return out;
}
const P = (tile: Tile, v: number): [number, number, number] => [tile.positions[v * 3]!, -tile.positions[v * 3 + 2]!, tile.positions[v * 3 + 1]!];
/** A triangle's twice-area on the plan, counter-clockwise positive. */
function twiceArea(tile: Tile, t: Tri): number {
  const [ax, ay] = P(tile, t.a), [bx, by] = P(tile, t.b), [cx, cy] = P(tile, t.c);
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
/** The plan area of a tile's top faces, and whether all of them face up with some area. */
function topArea(tile: Tile): { area: number; up: boolean } {
  let area = 0, up = true;
  for (const t of trianglesOf(tile)) {
    if (!t.top) continue;
    const w = twiceArea(tile, t);
    area += Math.abs(w) / 2;
    if (w <= 1e-9) up = false;
  }
  return { area, up };
}
/** A strip's or a fan's plan area (its outline's: a along, b back; a fan's ring). */
function geomArea(g: Geom): number {
  const ring: number[] = [];
  if (g.kind === 'strip') {
    ring.push(...g.a.xy);
    for (let i = g.b.s.length - 1; i >= 0; i--) ring.push(g.b.xy[i * 2]!, g.b.xy[i * 2 + 1]!);
  } else if (g.kind === 'fan' || g.kind === 'poly') ring.push(...g.ring);
  let sum = 0;
  for (let i = 0; i < ring.length; i += 2) { const j = (i + 2) % ring.length; sum += ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!; }
  return Math.abs(sum) / 2;
}

/** A grid of streets (`tessellation.spec.ts` once): 5 columns by 4 rows, three classes. */
function gridNetwork(): Network {
  const doc = new RoadDoc();
  const xs = [-600, -300, 0, 300, 600], ys = [-420, -140, 140, 420];
  const grid = ys.map((y) => xs.map((x) => doc.addNode({ x, y })));
  for (let r = 0; r < grid.length; r++) for (let k = 0; k < xs.length - 1; k++) doc.addSegment(grid[r]![k]!.id, grid[r]![k + 1]!.id, r === 1 ? 3 : 1);
  for (let k = 0; k < xs.length; k++) for (let r = 0; r < grid.length - 1; r++) doc.addSegment(grid[r]![k]!.id, grid[r + 1]![k]!.id, k === 2 ? 2 : 1);
  const net = new Network(doc);
  net.rebuild();
  return net;
}

/** Every piece of a network as its shapes by surface. */
function piecesOf(net: Network): { kind: 'segment' | 'node'; id: number; reach: Map<string, Geom[]> }[] {
  const out: { kind: 'segment' | 'node'; id: number; reach: Map<string, Geom[]> }[] = [];
  for (const [id, ribbon] of net.ribbons) out.push({ kind: 'segment', id, reach: reachOf(segmentShapes(net, ribbon)) });
  for (const id of net.junctions.keys()) out.push({ kind: 'node', id, reach: reachOf(junctionShapes(net, id as NodeId)) });
  return out;
}

describe('a strip meshed (tileShapeFlip, surfaceMesh: one way round, none without area, covered exactly)', () => {
  it('faces up whichever way round its chains run, and covers its outline exactly', () => {
    const a = chain(0, 0, 160, 20), b = chain(7, 0, 160, 20);
    for (const g of [strip(a, b), strip(b, a)]) {
      const tile = pieceBundle(one('asphalt', [g]), asphaltSpec(base)).get('asphalt')!;
      const { area, up } = topArea(tile);
      expect(up).toBe(true);
      expect(area).toBeCloseTo(160 * 7, 3);
    }
  });

  it('draws nothing of a strip with no width rather than triangles with no area', () => {
    const a = chain(0, 0, 40, 10);
    expect(pieceBundle(one('asphalt', [strip(a, a)]), asphaltSpec(base)).size).toBe(0);
    expect(pieceBundle(new Map(), asphaltSpec(base)).size).toBe(0);
  });

  it('lays a flat strip as one ladder of its chains\' points: two triangles a stretch, where the grid gave hundreds', () => {
    // 1,400 x 1.5 m (`tessellation.spec.ts`: under 4,000 triangles at an 8 m edge); a flat plane is exact with its four corners.
    const tile = pieceBundle(one('asphalt', [strip(chain(0, 0, 1400, 1400), chain(1.5, 0, 1400, 1400))]), asphaltSpec(base)).get('asphalt')!;
    expect(tile.indices.length / 3).toBe(2);
    const wide = pieceBundle(one('asphalt', [strip(chain(0, 0, 1400, 1400), chain(60, 0, 1400, 1400))]), asphaltSpec(base)).get('asphalt')!;
    expect(wide.indices.length / 3).toBe(2);
  });
});

describe('a plate meshed (surfaceMesh: covered exactly, faces up, the points of its outline alone: ear clipping refined by edge flips)', () => {
  const square = Float64Array.of(-10, -10, 10, -10, 10, 10, -10, 10);
  const walls = new Uint8Array(4).fill(1);
  /** Every vertex of a tile's top faces is a point of `ring`, and its top faces are the ring's points less two. */
  const outlineOnly = (tile: Tile, ring: Float64Array): void => {
    let faces = 0;
    for (const t of trianglesOf(tile)) {
      if (!t.top) continue;
      faces++;
      for (const v of [t.a, t.b, t.c]) {
        const [x, y] = P(tile, v);
        let near = Infinity;
        for (let i = 0; i < ring.length; i += 2) near = Math.min(near, Math.hypot(ring[i]! - x, ring[i + 1]! - y));
        expect(near).toBeLessThan(1e-4);
      }
    }
    expect(faces).toBe(ring.length / 2 - 2);
  };
  it('covers its outline either way round, two triangles for a square, no point in its middle', () => {
    for (const ring of [square, Float64Array.of(-10, 10, 10, 10, 10, -10, -10, -10)]) {
      const tile = pieceBundle(one('asphalt', [{ kind: 'fan', cx: 0, cy: 0, ring, walls, plate: true }]), asphaltSpec(base)).get('asphalt')!;
      const { area, up } = topArea(tile);
      expect(up).toBe(true);
      expect(area).toBeCloseTo(400, 6);
      outlineOnly(tile, ring);
    }
  });

  it('cuts an outline not seen whole from its middle the same way', () => {
    const ell = Float64Array.of(0, 0, 20, 0, 20, 5, 5, 5, 5, 20, 0, 20);
    const tile = pieceBundle(one('asphalt', [{ kind: 'fan', cx: 15, cy: 15, ring: ell, walls: new Uint8Array(6).fill(1), plate: true }]), asphaltSpec(base)).get('asphalt')!;
    const { area, up } = topArea(tile);
    expect(up).toBe(true);
    expect(area).toBeCloseTo(100 + 75, 6);
    outlineOnly(tile, ell);
  });

  it('adds no point to a plate whose surface is not a plane: its outline alone, as the road tool of the owner draws it', () => {
    const top = (x: number, y: number): number => 0.05 * Math.abs(x) + 0.03 * Math.abs(y);
    const tile = pieceBundle(one('asphalt', [{ kind: 'fan', cx: 0, cy: 0, ring: square, walls, plate: true }]), asphaltSpec({ ...base, top })).get('asphalt')!;
    outlineOnly(tile, square);
  });
});

describe('a surface\'s height within the tolerance (surfaceMesh, tessellation: refined until it is the surface, not to a grid)', () => {
  const top = (x: number, y: number): number => 1 + Math.sin(x / 40) * 2 + Math.cos(y / 55);
  it('stands within the tolerance of its surface everywhere, its stations where the surface leaves its chords', () => {
    const tile = pieceBundle(one('asphalt', [strip(chain(-150, -150, 150, 300), chain(-142, -150, 150, 300))]), asphaltSpec({ ...base, top })).get('asphalt')!;
    let worst = 0;
    for (const t of trianglesOf(tile)) {
      const [a, b, c] = [P(tile, t.a), P(tile, t.b), P(tile, t.c)];
      for (const [u, v] of [[1 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5], [0.25, 0.25]] as const) {
        const w = 1 - u - v;
        const x = a[0] * w + b[0] * u + c[0] * v, y = a[1] * w + b[1] * u + c[1] * v, z = a[2] * w + b[2] * u + c[2] * v;
        worst = Math.max(worst, Math.abs(z - top(x, y)));
      }
    }
    // The tolerance along (`stationsOf`); across, the ruled strip's chord over 8 m of the curve (cos(y / 55): 8^2 / 8 / 55^2 = 2.6 mm).
    expect(worst).toBeLessThanOrEqual(HEIGHT_TOL + 0.003);
    // And no more stations than the surface asks: far fewer than a lattice of 8 m (300 x 8 at 8 m: ~75 triangles a row).
    expect(tile.indices.length / 3).toBeLessThan(300);
  });
});

describe('two bands of a road (surfaceMesh: no T-junction, no crack between them)', () => {
  it('meet on the same vertices along the edge they share, the stations any of them asked taken by both', () => {
    const top = (x: number): number => 0.4 * Math.sin(x / 12);
    const inner = chain(0, 0, 120, 120), edge = chain(3.5, 0, 120, 120), outer = chain(5.5, 0, 120, 120);
    const reach = new Map<string, Geom[]>([['asphalt', [strip(inner, edge)]], ['kerb', [strip(edge, outer)]]]);
    const specs: MeshedSurface[] = [
      { source: { kind: 'band', band: 'asphalt' }, options: { ...base, top, name: 'asphalt' } },
      { source: { kind: 'band', band: 'kerb' }, options: { ...base, top, name: 'kerb' } },
    ];
    const bundle = pieceBundle(reach, specs);
    const onEdge = (tile: Tile): Set<string> => {
      const out = new Set<string>();
      for (let v = 0; v < tile.positions.length / 3; v++) { const [x, y] = P(tile, v); if (Math.abs(y - 3.5) < 1e-6) out.add(x.toFixed(4)); }
      return out;
    };
    const a = onEdge(bundle.get('asphalt')!), b = onEdge(bundle.get('kerb')!);
    expect(a.size).toBeGreaterThan(2);
    expect([...a].sort()).toEqual([...b].sort());
    // Within a band every edge is one triangle's or two's.
    for (const tile of bundle.values()) {
      const seen = new Map<string, number>();
      for (const t of trianglesOf(tile)) for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const key = p < q ? `${p}:${q}` : `${q}:${p}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const count of seen.values()) expect(count).toBeLessThanOrEqual(2);
    }
  });
});

describe('a skirt (skirtSplit, surfaceMesh: follows its surface and its foot, faces out, only with a foot)', () => {
  const TOL = HEIGHT_TOL;
  const top = (x: number): number => 0.3 * Math.sin(x / 15);
  const floorOf = (x: number): number => top(x) - 0.5;

  /** How far the top of the wall along the strip's outer edge (y = 13) stands off the surface between its vertices. */
  function topError(length: number, wobble: number): number {
    const g = strip(chain(10, 0, length, 2), chain(13, 0, length, 2, wobble), WALL_B);
    const tile = pieceBundle(one('asphalt', [g]), asphaltSpec({ ...base, top: (x) => top(x), bottom: (x) => floorOf(x) })).get('asphalt')!;
    const tops: [number, number][] = [];
    for (let v = 0; v < tile.positions.length / 3; v++) {
      const [x, y, z] = P(tile, v);
      if (Math.abs(y - 13) < 0.01 && Math.abs(z - top(x)) < 0.05) tops.push([x, z]);
    }
    tops.sort((p, q) => p[0] - q[0]);
    let worst = 0;
    for (let i = 1; i < tops.length; i++) {
      const [x0, z0] = tops[i - 1]!, [x1, z1] = tops[i]!;
      for (let k = 1; k < 20; k++) { const t = k / 20; worst = Math.max(worst, Math.abs(z0 + (z1 - z0) * t - top(x0 + (x1 - x0) * t))); }
    }
    return worst;
  }

  it('follows the surface along a plain strip, a long one, and one whose points wobble under a millimetre', () => {
    expect(topError(60, 0)).toBeLessThanOrEqual(TOL * 2);
    expect(topError(200, 0)).toBeLessThanOrEqual(TOL * 2);
    expect(topError(200, 0.0003)).toBeLessThanOrEqual(TOL * 2);
  });

  it('is there only with a foot, down to it, its faces out, one uv a vertex', () => {
    const g = strip(chain(-50, -50, 50, 10), chain(50, -50, 50, 10), WALL_A | WALL_B | WALL_START | WALL_END);
    const flat = pieceBundle(one('asphalt', [g]), asphaltSpec({ ...base, top: () => 1 })).get('asphalt')!;
    const solid = pieceBundle(one('asphalt', [g]), asphaltSpec({ ...base, top: () => 1, bottom: () => -3 })).get('asphalt')!;
    expect(solid.positions.length).toBeGreaterThan(flat.positions.length);
    let lowest = Infinity, checked = 0;
    for (let v = 0; v < solid.positions.length / 3; v++) {
      const [x, y, z] = P(solid, v);
      lowest = Math.min(lowest, z);
      const nx = solid.normals[v * 3]!, ny = solid.normals[v * 3 + 1]!, nz = -solid.normals[v * 3 + 2]!;
      if (Math.abs(ny) > 0.01) continue;
      // On the +x wall the normal points to +x, and so on.
      if (Math.abs(x) > 49.5 && Math.abs(y) < 48) { expect(Math.sign(nx)).toBe(Math.sign(x)); checked++; }
      if (Math.abs(y) > 49.5 && Math.abs(x) < 48) { expect(Math.sign(nz)).toBe(Math.sign(y)); checked++; }
    }
    // Down to its foot, a tolerance under it (`tileMesh.ts` meshSkirts: the surface below may be refined that much under the wall's chord).
    expect(lowest).toBeCloseTo(-3 - HEIGHT_TOL, 5);
    expect(checked).toBeGreaterThan(0);
    for (const tile of [flat, solid]) expect(tile.uvs.length / 2).toBe(tile.positions.length / 3);
  });
});

describe('texture frames at a junction (surfaceMesh: a triangle inside one frame)', () => {
  // Two roads meeting at right angles: along X at y = 0, and along Y at x = 0.
  const frame = (x: number, y: number, pickX: number, pickY: number, out: [number, number]): void => {
    if (Math.abs(pickY) < Math.abs(pickX)) { out[0] = y / 10; out[1] = x / 10; } else { out[0] = -x / 10; out[1] = y / 10; }
  };
  // A plate across the corner: its edge from (60, 10) to (10, 60) crosses from one road's frame into the other's.
  const corner = Float64Array.of(4, 4, 60, 10, 10, 60);
  const worstStretch = (tile: Tile): number => {
    let worst = 1;
    for (const t of trianglesOf(tile)) {
      for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const [px, py] = P(tile, p), [qx, qy] = P(tile, q);
        const world = Math.hypot(px - qx, py - qy);
        const texture = Math.hypot(tile.uvs[p * 2]! - tile.uvs[q * 2]!, tile.uvs[p * 2 + 1]! - tile.uvs[q * 2 + 1]!) * 10;
        if (world > 1e-3) worst = Math.max(worst, texture / world, world / Math.max(texture, 1e-6));
      }
    }
    return worst;
  };
  const make = (framed: boolean): Tile => pieceBundle(one('asphalt', [{ kind: 'fan', cx: 24.6, cy: 24.6, ring: corner, walls: new Uint8Array(3) }]),
    asphaltSpec({ ...base, top: () => 1, uv: (x, y, out) => frame(x, y, x, y, out), ...(framed ? { uvFrame: frame } : {}) })).get('asphalt')!;

  it('smears a triangle across two frames when left alone, and keeps each inside one when asked to', () => {
    expect(worstStretch(make(false))).toBeGreaterThan(2);
    expect(worstStretch(make(true))).toBeLessThan(1.01);
  });
});

describe('the pieces of a city (tileShapeFlip, tessellation: every triangle up and with area, covered exactly, the cost bounded)', () => {
  const net = gridNetwork();
  const pieces = piecesOf(net);

  it('meshes every surface of every road and junction facing up, none without area, covering its shapes exactly', () => {
    let shapes = 0;
    for (const piece of pieces) {
      const bundle = pieceBundle(piece.reach, specsFor(piece.reach, base));
      for (const [slot, geoms] of piece.reach) {
        if (!SOURCES.some((s) => slotOf(s) === slot)) continue;
        const tile = bundle.get(slot);
        expect(tile, `${piece.kind} ${piece.id} ${slot}`).toBeDefined();
        const { area, up } = topArea(tile!);
        expect(up, `${piece.kind} ${piece.id} ${slot}`).toBe(true);
        const expected = geoms.reduce((t, g) => t + geomArea(g), 0);
        // The tile's positions are floats: a vertex 600 m out is stored to 6e-5 m, a 0.15 m kerb's area to 4e-4 of itself.
        expect(Math.abs(area - expected), `${piece.kind} ${piece.id} ${slot}`).toBeLessThanOrEqual(1e-3 * expected + 1e-3);
        shapes += geoms.length;
      }
    }
    expect(shapes).toBeGreaterThan(100);
  });

  it('keeps a whole city grid inside the triangle budget the grid mesher was held to', () => {
    let total = 0;
    for (const piece of pieces) for (const tile of pieceBundle(piece.reach, specsFor(piece.reach, base)).values()) total += tile.indices.length / 3;
    // The work is counted (triangles), never timed (tests/arch/testRules.spec.ts). The polygon mesher was held under 200,000.
    expect(total).toBeLessThan(200_000);
    expect(total).toBeGreaterThan(0);
  });
});

describe('a road\'s end on its junction\'s mouth (the seam the far levels keep, `seamsOf`)', () => {
  /** Whether (x, y) lies on one of `seams` (x0, y0, x1, y1 each), and how far from the nearest. */
  const gap = (seams: Float64Array, x: number, y: number): number => {
    let best = Infinity;
    for (let e = 0; e + 3 < seams.length; e += 4) {
      const ax = seams[e]!, ay = seams[e + 1]!, ex = seams[e + 2]! - ax, ey = seams[e + 3]! - ay;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + ex * t - x, ay + ey * t - y));
    }
    return best;
  };

  it('meets its junction on the same mouth: every end of either side on the other\'s seams, none a near miss', () => {
    const net = gridNetwork();
    let shared = 0;
    for (const [nodeId] of net.junctions) {
      const node = net.doc.node(nodeId as NodeId)!;
      const junction = seamsOf(reachOf(junctionShapes(net, nodeId as NodeId)));
      const roads = node.incident.map((id) => seamsOf(reachOf(segmentShapes(net, net.ribbons.get(id)!))));
      const road = new Float64Array(roads.reduce((n, r) => n + r.length, 0));
      roads.reduce((at, r) => { road.set(r, at); return at + r.length; }, 0);
      // Every end of the junction's seams (its corners' ends, its plate's mouths) on a road's.
      for (let e = 0; e < junction.length; e += 2) {
        expect(gap(road, junction[e]!, junction[e + 1]!), `node ${nodeId} junction seam point`).toBeLessThan(1e-6);
        shared++;
      }
      // Every end of a road's strips near the node on the junction's seams, or a dropped kerb's cut inside the road: an end at the arc length a
      // ramp of the road starts or ends at (`segmentPiece.ts` rampStretches), never a near miss of the mouth.
      for (const id of node.incident) {
        const ribbon = net.ribbons.get(id)!, segment = net.doc.segment(id)!;
        const shapes = segmentShapes(net, ribbon);
        const cuts = shapes.flatMap((s) => (s.slot === 'curbRamp' && s.geom.kind === 'strip' ? [s.geom.a.s[0]!, s.geom.a.s[s.geom.a.s.length - 1]!] : []));
        // A median ends at its nose, set back from the crossing (`world/landscape.ts` medianNose) past the carriageway's mouth: at that arc length
        // on its road, the larger of the two (these roads are straight: the mouth's trim is its distance from the node along the road).
        const atA = segment.a === nodeId;
        const trim = net.trims.get(id)![atA ? 'a' : 'b'][Level.Asphalt]!;
        const reach = Math.max(trim, medianNose(net, id, nodeId as NodeId));
        const nose = atA ? reach : ribbon.full.length - reach;
        let noses = 0;
        for (const { slot, geom } of shapes) {
          const median = slot.startsWith('median:');
          const chains = geom.kind === 'strip' ? [geom.a, geom.b] : geom.kind === 'face' ? [geom.run] : [];
          for (const c of chains) {
            for (const k of [0, c.s.length - 1]) {
              const x = c.xy[k * 2]!, y = c.xy[k * 2 + 1]!;
              if (Math.hypot(x - node.x, y - node.y) > 40) continue;
              if (median) {
                noses++;
                expect(c.s[k]!, `node ${nodeId} road ${id} median end ${x}, ${y}: at its nose`).toBeCloseTo(nose, 6);
                continue;
              }
              const d = gap(junction, x, y);
              const cut = cuts.some((s) => Math.abs(s - c.s[k]!) < 1e-6);
              expect(d < 1e-6 || cut, `node ${nodeId} road ${id} end ${x}, ${y}: ${d} off the mouth, at no ramp's end`).toBe(true);
            }
          }
        }
        // A road with a raised median ends it at each nose near the node: its two kerbs' two edges and the planting's two (`segmentPiece.ts` medianShapes).
        const raised = ribbon.road.median > 0 && !ribbon.road.medianFlush;
        expect(noses, `node ${nodeId} road ${id} median ends`).toBe(raised ? 6 : 0);
      }
    }
    expect(shared).toBeGreaterThan(100);
  });
});

describe('a taper between two classes (`junctionPiece.ts` outerRun on a straight corner)', () => {
  it('keeps the footway at its width round the kerb\'s S: its back curved with the kerb, never one chord from mouth to mouth', () => {
    // An urban road carrying on as an avenue through a node: both footways 2 m from the carriageway's edge, the carriageway's edge an S between them.
    const doc = new RoadDoc();
    const urban = 1, avenue = 2;
    const a = doc.addNode({ x: -70, y: 0 }), mid = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: 70, y: 0 });
    doc.addSegment(a.id, mid.id, urban);
    doc.addSegment(mid.id, b.id, avenue);
    const net = new Network(doc);
    net.rebuild();
    const footways = junctionShapes(net, mid.id).filter((s) => s.slot === 'footway');
    expect(footways).toHaveLength(2);
    const width = 2;
    for (const { geom } of footways) {
      if (geom.kind !== 'poly' || geom.kerb === undefined) throw new Error('a junction\'s footway corner is a polygon from its kerb');
      const kerb = geom.kerb, count = geom.ring.length / 2;
      // The kerb's S: more than its two mouth corners; the back as many points as follow it.
      expect(kerb).toBeGreaterThan(2);
      expect(count - kerb).toBeGreaterThan(2);
      for (let v = kerb; v < count; v++) {
        const x = geom.ring[v * 2]!, y = geom.ring[v * 2 + 1]!;
        let near = Infinity;
        for (let i = 0; i + 1 < kerb; i++) {
          const ax = geom.ring[i * 2]!, ay = geom.ring[i * 2 + 1]!, ex = geom.ring[i * 2 + 2]! - ax, ey = geom.ring[i * 2 + 3]! - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
          near = Math.min(near, Math.hypot(ax + ex * t - x, ay + ey * t - y));
        }
        // At the footway's width from the kerb's stations, within their chords' sagitta.
        expect(Math.abs(near - width), `back point ${x.toFixed(3)}, ${y.toFixed(3)}`).toBeLessThan(0.05);
      }
    }
  });
});
