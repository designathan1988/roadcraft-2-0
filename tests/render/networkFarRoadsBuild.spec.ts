import { describe, expect, it } from 'vitest';
import { FAR_FAN, FAR_STRIP, buildFarRoadCells, type FarRoadCell, type FarRoadInput } from '@render/networkFarRoadsBuild';

/** A shape as the page hands it over (`networkFarRoads.ts` farRoadInput): its owner block, layer, colour, and a strip's two chains (x, y, s) or a
 *  fan's middle and outline (x, y), at height `z`. */
type ShapeIn =
  | { owner: [number, number]; layer: number; colour: [number, number, number]; z?: number; a: [number, number, number][]; b: [number, number, number][] }
  | { owner: [number, number]; layer: number; colour: [number, number, number]; z?: number; centre: [number, number]; ring: [number, number][] };

function input(shapes: readonly ShapeIn[], cell = 100): FarRoadInput {
  const owners: number[] = [], layers: number[] = [], colors: number[] = [], kinds: number[] = [], sizes: number[] = [], points: number[] = [];
  for (const s of shapes) {
    owners.push(...s.owner); layers.push(s.layer); colors.push(...s.colour);
    const z = s.z ?? 0;
    if ('a' in s) {
      for (const [x, y, t] of [...s.a, ...s.b]) points.push(x, y, z, t);
      kinds.push(FAR_STRIP); sizes.push(s.a.length, s.b.length);
    } else {
      points.push(s.centre[0], s.centre[1], z, 0);
      for (const [x, y] of s.ring) points.push(x, y, z, 0);
      kinds.push(FAR_FAN); sizes.push(s.ring.length, 0);
    }
  }
  return {
    cell, owners: new Int32Array(owners), layers: new Uint8Array(layers), colors: new Float32Array(colors),
    kinds: new Uint8Array(kinds), sizes: new Uint32Array(sizes), points: new Float64Array(points),
    // Each point's offset across: its y (the chains here run along x); each shape's paint slot: its index.
    across: Float32Array.from({ length: points.length / 4 }, (_, i) => points[i * 4 + 1]!), slots: Float64Array.from(kinds, (_, i) => i),
  };
}

/** A chain along y = `y` from x0 to x1, its arc length its x. */
const along = (y: number, x0: number, x1: number, step = 10): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let x = x0; x < x1; x += step) out.push([x, y, x]);
  out.push([x1, y, x1]);
  return out;
};

/** The plan area a cell's triangles cover (positions are x, height, -y), and whether every triangle runs counter-clockwise on the plan. */
function area(cells: readonly FarRoadCell[], layer: number, key?: string): { area: number; ccw: boolean } {
  let sum = 0, ccw = true;
  for (const c of cells) {
    if (c.layer !== layer || (key !== undefined && c.key !== key)) continue;
    const p = c.positions;
    for (let t = 0; t < c.indices.length; t += 3) {
      const a = c.indices[t]! * 3, b = c.indices[t + 1]! * 3, d = c.indices[t + 2]! * 3;
      // On the plan: (x, y) = (x, -z).
      const twice = (p[b]! - p[a]!) * (-p[d + 2]! + p[a + 2]!) - (-p[b + 2]! + p[a + 2]!) * (p[d]! - p[a]!);
      sum += Math.abs(twice) / 2;
      if (twice <= 0) ccw = false;
    }
  }
  return { area: sum, ccw };
}

const CASING: [number, number, number] = [0.2, 0.2, 0.2];
const ASPHALT: [number, number, number] = [0.04, 0.04, 0.04];

describe('the network far roads, from the pieces', () => {
  it('lays a road as its carriageway and its casing each side, strips sharing their edges: the layers never overlap', () => {
    const cells = buildFarRoadCells(input([
      { owner: [0, 0], layer: 1, colour: ASPHALT, a: along(3, 0, 40), b: along(7, 0, 40) },
      { owner: [0, 0], layer: 0, colour: CASING, a: along(3, 0, 40), b: along(0, 0, 40) },
      { owner: [0, 0], layer: 0, colour: CASING, a: along(7, 0, 40), b: along(10, 0, 40) },
    ]));
    const asphalt = area(cells, 1), casing = area(cells, 0);
    expect(asphalt.area).toBeCloseTo(160, 6);
    expect(casing.area).toBeCloseTo(240, 6);
    // Front faces up whichever way round the chains run.
    expect(asphalt.ccw && casing.ccw).toBe(true);
  });

  it('gives the carriageway\'s vertices their section as the detail\'s carry it (across, along, its paint\'s slot, the carriageway\'s code), the casing\'s none', () => {
    const cells = buildFarRoadCells(input([
      { owner: [0, 0], layer: 1, colour: ASPHALT, a: along(3, 0, 40), b: along(7, 0, 40) },
      { owner: [0, 0], layer: 0, colour: CASING, a: along(3, 0, 40), b: along(0, 0, 40) },
      { owner: [0, 0], layer: 1, colour: ASPHALT, centre: [60, 5], ring: [[50, 0], [70, 0], [70, 10], [50, 10]] },
    ]));
    const casing = cells.find((c) => c.layer === 0)!, carriageway = cells.find((c) => c.layer === 1)!;
    expect(casing.sections.length).toBe(0);
    expect(carriageway.sections.length).toBe((carriageway.positions.length / 3) * 4);
    for (let v = 0; v < carriageway.positions.length / 3; v++) {
      const x = carriageway.positions[v * 3]!, y = -carriageway.positions[v * 3 + 2]!;
      const [across, alongS, slot, code] = carriageway.sections.subarray(v * 4, v * 4 + 4);
      // The input's offset across is each point's y here; a strip's along its arc length (its x), a plate's -1; each shape's slot its index.
      expect(across).toBeCloseTo(y, 6);
      expect(code).toBe(0);
      if (x <= 40) { expect(alongS).toBeCloseTo(x, 6); expect(slot).toBe(0); } else { expect(alongS).toBe(-1); expect(slot).toBe(2); }
    }
  });

  it('draws a piece whole in its owner\'s block, across a block\'s edge, at its heights', () => {
    const cells = buildFarRoadCells(input([{ owner: [1, 0], layer: 1, colour: ASPHALT, z: 2, a: along(0, 80, 130), b: along(10, 80, 130) }]));
    expect(cells.map((c) => c.key)).toEqual(['1,0']);
    expect(area(cells, 1, '1,0').area).toBeCloseTo(500, 6);
    for (const c of cells) for (let i = 1; i < c.positions.length; i += 3) expect(c.positions[i]).toBeCloseTo(2, 5);
  });

  it('fills a junction\'s plate from its outline alone: ear clipping refined by edge flips, its points less two triangles, no point inside it', () => {
    // The owner's road tool's four ways at its far level (`pu`, A = 3.5 m, R = 4 m): each leg's two mouth corners and its kerb return's middle station.
    const r = 4, c = 7.5, mid = c - r * Math.SQRT1_2;
    const plate: [number, number][] = [
      [7.5, -3.5], [7.5, 3.5], [mid, mid], [3.5, 7.5], [-3.5, 7.5], [-mid, mid], [-7.5, 3.5], [-7.5, -3.5], [-mid, -mid], [-3.5, -7.5], [3.5, -7.5], [mid, -mid],
    ];
    const cells = buildFarRoadCells(input([{ owner: [0, 0], layer: 1, colour: ASPHALT, centre: [0, 0], ring: plate }]));
    let twice = 0;
    for (let i = 0; i < plate.length; i++) { const p = plate[i]!, q = plate[(i + 1) % plate.length]!; twice += p[0] * q[1] - q[0] * p[1]; }
    // Its positions are floats: the area to a few square millimetres.
    expect(area(cells, 1).area).toBeCloseTo(twice / 2, 4);
    expect(area(cells, 1).ccw).toBe(true);
    const cell = cells[0]!;
    // Points less two: the middle given is no vertex (the tool's plate is 12 points, 10 triangles; the fan drew 12 round the middle).
    expect(cell.indices.length / 3).toBe(plate.length - 2);
    expect(cell.positions.length / 3).toBe(plate.length);
    for (let v = 0; v < cell.positions.length; v += 3) expect(Math.hypot(cell.positions[v]!, cell.positions[v + 2]!)).toBeGreaterThan(1);
    // Refined to Delaunay quality (Lawson's flips): no triangle's circumcircle holds another of its points; and none narrower than the tool's own far
    // level (its least altitude, 2 x area / longest edge: 1.203 m with these dimensions).
    const xy = (v: number): [number, number] => [cell.positions[v * 3]!, -cell.positions[v * 3 + 2]!];
    let least = Infinity;
    for (let t = 0; t < cell.indices.length; t += 3) {
      const [a, b, d] = [xy(cell.indices[t]!), xy(cell.indices[t + 1]!), xy(cell.indices[t + 2]!)];
      const area2 = Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]));
      least = Math.min(least, area2 / Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(d[0] - b[0], d[1] - b[1]), Math.hypot(a[0] - d[0], a[1] - d[1])));
      for (let v = 0; v < cell.positions.length / 3; v++) {
        if (v === cell.indices[t] || v === cell.indices[t + 1] || v === cell.indices[t + 2]) continue;
        const [px, py] = xy(v);
        const rows = [a, b, d].map(([x, y]) => [x - px, y - py, (x - px) ** 2 + (y - py) ** 2] as const);
        const det = rows[0]![0] * (rows[1]![1] * rows[2]![2] - rows[2]![1] * rows[1]![2]) - rows[0]![1] * (rows[1]![0] * rows[2]![2] - rows[2]![0] * rows[1]![2])
          + rows[0]![2] * (rows[1]![0] * rows[2]![1] - rows[2]![0] * rows[1]![1]);
        // Counter-clockwise on the plan: inside the circle is a positive determinant (a tolerance for cocircular points).
        expect(det, `triangle ${t / 3} vertex ${v}`).toBeLessThanOrEqual(1e-6);
      }
    }
    expect(least).toBeGreaterThanOrEqual(1.203);
    // An L whose corner hides part of it from the middle given: its outline alone all the same.
    const ell: [number, number][] = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
    const clipped = buildFarRoadCells(input([{ owner: [0, 0], layer: 1, colour: ASPHALT, centre: [15, 15], ring: [...ell].reverse() }]));
    expect(area(clipped, 1).area).toBeCloseTo(20 * 5 + 5 * 15, 6);
    expect(area(clipped, 1).ccw).toBe(true);
    expect(clipped[0]!.indices.length / 3).toBe(ell.length - 2);
  });
});

describe('the network far roads\' paint, from a network', () => {
  it('carries each road\'s slot and its offsets across as the detail reads them, and each plate its node\'s slot', async () => {
    const { RoadDoc } = await import('@world/doc');
    const { Network } = await import('@world/network');
    const { ROAD_TYPES, Level, sideHalfWidth } = await import('@world/roadTypes');
    const { farRoadInput } = await import('@render/networkFarInput');
    const { pageSlots } = await import('@render/networkFarRoads');
    const { roadPaint } = await import('@render/roadPaint');
    const { lookOf } = await import('@render/roadSurfacePass');
    const doc = new RoadDoc();
    const urban = ROAD_TYPES.findIndex((t) => t.id === 'urban');
    const centre = doc.addNode({ x: 0, y: 0 });
    for (const [x, y] of [[70, 0], [0, 70], [-70, 0], [0, -70]] as const) doc.addSegment(centre.id, doc.addNode({ x, y }).id, urban);
    const net = new Network(doc);
    net.rebuild();
    const { input } = farRoadInput(net, { onSegment: () => 0, at: () => 0 }, () => 0, 1000, null, pageSlots(net));
    const table = roadPaint.resolverOf(doc);
    const roadSlots = new Set([...net.ribbons.keys()].map((id) => table(lookOf(net, id)!.paint!)));
    const plate = -2 - table(roadPaint.nodeSlot(doc, centre.id));
    const half = sideHalfWidth(ROAD_TYPES[urban]!, Level.Asphalt, 'left');
    let at = 0, strips = 0, plates = 0;
    for (let k = 0; k < input.kinds.length; k++) {
      const count = input.kinds[k] === FAR_FAN ? 1 + input.sizes[k * 2]! : input.sizes[k * 2]! + input.sizes[k * 2 + 1]!;
      if (input.layers[k] === 1) {
        if (input.kinds[k] === FAR_STRIP) {
          strips++;
          expect(roadSlots.has(input.slots[k]!)).toBe(true);
          // Its chains are its carriageway's two edges: half its width either side.
          for (let p = at; p < at + count; p++) expect(Math.abs(input.across[p]!)).toBeCloseTo(half, 5);
        } else { plates++; expect(input.slots[k]).toBe(plate); }
      } else expect(input.slots[k]).toBe(-1);
      at += count;
    }
    expect(strips).toBe(4);
    expect(plates).toBe(1);
  });
});

describe('the network far roads, from a city', () => {
  it('files every piece in its owner\'s block, and the cells asked alone hold their own pieces and no other', async () => {
    const { planCity, DEFAULT_CITY } = await import('@world/cityGen/plan');
    const { layCity } = await import('@editor/cityGenerator');
    const { Network } = await import('@world/network');
    const { farRoadInput } = await import('@render/networkFarInput');
    const { pageSlots } = await import('@render/networkFarRoads');
    const { segmentOwner, nodeOwner, ownerCell } = await import('@render/roads/pieceOwner');
    const net = new Network(layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })));
    net.rebuild();
    const heights = { onSegment: () => 0, at: () => 0 };
    const cell = 200;
    const whole = farRoadInput(net, heights, () => 0, cell, null, pageSlots(net)).input;
    const owners = new Set<string>();
    for (const id of net.ribbons.keys()) { const at = segmentOwner(net, id); if (at) owners.add(ownerCell(at, cell).join(',')); }
    for (const id of net.junctions.keys()) { const at = nodeOwner(net, id); if (at) owners.add(ownerCell(at, cell).join(',')); }
    const filed = new Set<string>();
    for (let k = 0; k < whole.kinds.length; k++) filed.add(`${whole.owners[k * 2]},${whole.owners[k * 2 + 1]}`);
    expect(filed.size).toBeGreaterThan(1);
    for (const key of filed) expect(owners.has(key)).toBe(true);
    // The block holding the most pieces, asked alone (an edit's cell made again): its pieces and no other, as many as the whole level filed there.
    const counts = new Map<string, number>();
    for (let k = 0; k < whole.kinds.length; k++) { const key = `${whole.owners[k * 2]},${whole.owners[k * 2 + 1]}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
    const [busiest, many] = [...counts].sort((p, q) => q[1] - p[1])[0]!;
    const only = farRoadInput(net, heights, () => 0, cell, new Set([busiest]), pageSlots(net)).input;
    expect(only.kinds.length).toBe(many);
    for (let k = 0; k < only.kinds.length; k++) expect(`${only.owners[k * 2]},${only.owners[k * 2 + 1]}`).toBe(busiest);
  });
});
