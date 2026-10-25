import { MeshBasicMaterial, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';

import type { Vec2 } from '@core/vec2';
import { RoadDoc, type JunctionControl } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import type { NodeId, SegmentId } from '@world/ids';
import { ROAD_TYPES } from '@world/roadTypes';
import type { RoadStructure } from '@world/structures';
import type { MarkingStyleId } from '@world/roads/markingStyle';
import { m } from '@world/units';
import { type Bar, type StrokeSpec, type ZebraStretch, approachLegendsAt, junctionDetailAt, midBlockDetailAt, miniRoundaboutIsland, transitionMarkings } from '@world/markings';
import { parkingLinesOf } from '@world/parkingLayout';
import type { SceneMaterials } from '@render/materials';
import { marksRoadSection } from '@render/mesh/roadEdges';
import { buildRoadSurfaces, type SurfaceReuse } from '@render/roadSurfaces';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { pieceOfPart } from '@render/roadSurfaceEntries';
import { MARK_DASHED, MARK_POLYGON, SHAPE_TEXELS, STOP_PAINT, ZEBRA_PAINT, type MarkPiece, roadMarks, roadStrokes } from '@render/roadMarks';
import { MARKS_HEAD, SLOT_TEXELS, roadPaint } from '@render/roadPaint';

/**
 * THE ROADS' MARKS DRAWN BY THE CARRIAGEWAY'S SHADER (`render/roadMarks.ts`, `render/roadMarksShader.ts`): no triangle of paint in any road's
 * build, every mark the quad the paint was drawn as (its corners the same numbers as `world/markings.ts` gives), read back through the texture
 * as the shader reads it, filed on its own carriageway.
 */

const materials = new Proxy({}, {
  get: (_t, key) => {
    if (key === 'scale') return new Proxy({}, { get: () => 4 });
    const material = new MeshBasicMaterial({ vertexColors: true });
    marksRoadSection(material);
    return material;
  },
}) as unknown as SceneMaterials;
const flat = (): number => 0;
const LEG = m(70);

type Lay = (doc: RoadDoc, type: number) => void;
const road = (doc: RoadDoc, type: number, x0: number, y0: number, x1: number, y1: number, structure: RoadStructure = 'ground'): SegmentId =>
  doc.addSegment(doc.addNode({ x: x0, y: y0 }).id, doc.addNode({ x: x1, y: y1 }).id, type, null, 0, 'both', null, structure)!.id;
/** Roads from the centre out to each end, meeting there; the centre returned. */
const meeting = (doc: RoadDoc, type: number, ends: readonly (readonly [number, number])[], structures: readonly RoadStructure[] = []): NodeId => {
  const centre = doc.addNode({ x: 0, y: 0 });
  ends.forEach(([x, y], k) => doc.addSegment(doc.addNode({ x, y }).id, centre.id, type, null, 0, 'both', null, structures[k] ?? 'ground'));
  return centre.id;
};
const CROSS: readonly (readonly [number, number])[] = [[-LEG, 0], [LEG, 0], [0, LEG], [0, -LEG]];
const controlled = (control: JunctionControl): Lay => (doc, t) => { doc.setNodeControl(meeting(doc, t, CROSS), control); };

/** Every layout of the lab's catalogue (`lab/catalog/layout.ts`), and those whose paint it lacks: the junction's rules, a crossing mid-block, a taper. */
const LAYOUTS: readonly (readonly [string, Lay])[] = [
  ['straight', (doc, t) => { road(doc, t, -LEG, 0, LEG, 0); }],
  ['one way', (doc, t) => { doc.addSegment(doc.addNode({ x: -LEG, y: 0 }).id, doc.addNode({ x: LEG, y: 0 }).id, t, null, 0, 'aToB'); }],
  ['bend', (doc, t) => { meeting(doc, t, [[-LEG, 0], [0, LEG]]); }],
  ['three ways', (doc, t) => { meeting(doc, t, [[-LEG, 0], [LEG, 0], [0, LEG]]); }],
  ['four ways', (doc, t) => { meeting(doc, t, CROSS); }],
  ['three ways, the third at 70 degrees', (doc, t) => { meeting(doc, t, [[LEG, 0], [-LEG, 0], [LEG * Math.cos((70 * Math.PI) / 180), LEG * Math.sin((70 * Math.PI) / 180)]]); }],
  ['four ways crossed at 45 degrees', (doc, t) => { meeting(doc, t, [[-LEG, 0], [LEG, 0], [LEG * Math.SQRT1_2, LEG * Math.SQRT1_2], [-LEG * Math.SQRT1_2, -LEG * Math.SQRT1_2]]); }],
  ['raised', (doc, t) => { road(doc, t, -LEG, 0, LEG, 0, 'elevated'); }],
  ['bridge', (doc, t) => { road(doc, t, -LEG, 0, LEG, 0, 'bridge'); }],
  ['tunnel', (doc, t) => { road(doc, t, -LEG, 0, LEG, 0, 'tunnel'); }],
  ['parking', (doc, t) => { doc.addSegment(doc.addNode({ x: -LEG, y: 0 }).id, doc.addNode({ x: LEG, y: 0 }).id, t, null, 0, 'both', null, 'ground', undefined, { left: 'parallel', right: 'cycle' }); }],
  ['four ways, stop', controlled('stop')],
  ['four ways, yield', controlled('yield')],
  ['four ways, priority', controlled('priority')],
  ['four ways, signals', controlled('signal')],
  ['four ways, mini-roundabout', controlled('mini')],
  ['a crossing mid-block', (doc, t) => {
    const a = doc.addNode({ x: -LEG, y: 0 }), mid = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: LEG, y: 0 });
    const s = doc.addSegment(a.id, mid.id, t)!;
    doc.addSegment(mid.id, b.id, t);
    doc.setNodeCrossing(mid.id, 'zebra', s.id);
  }],
  ['a taper to the next class', (doc, t) => {
    const a = doc.addNode({ x: -LEG, y: 0 }), mid = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: LEG, y: 0 });
    doc.addSegment(a.id, mid.id, t);
    doc.addSegment(mid.id, b.id, (t + 1) % ROAD_TYPES.length);
  }],
];

/** A layout built as the game builds it, its marks written (`adopt`): the network, its inputs and the build. */
function built(lay: Lay, type: number, style: MarkingStyleId = 'classic'): { doc: RoadDoc; net: Network; inputs: SurfaceInputs; meshes: Mesh[] } {
  const doc = new RoadDoc();
  doc.setMarkingStyle(style);
  lay(doc, type);
  const net = new Network(doc);
  net.rebuild();
  const inputs = new SurfaceInputs();
  const reuse = { tiles: new Map(), dependsOn: () => 0, chunks: new Map(), inputs } as unknown as SurfaceReuse;
  const surfaces = buildRoadSurfaces(net, buildRoadElevation(net, flat), materials, flat, reuse);
  const meshes: Mesh[] = [];
  surfaces.group.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
  return { doc, net, inputs, meshes };
}

const key = (p: Vec2): string => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
/** A quad's corners as a set (its order and its start are the drawing's, not the shape's). */
const cornersKey = (corners: readonly Vec2[]): string => corners.map(key).sort().join(' ');
/** The quad the paint drew from `a` to `b`, `half` either side (`paintQuads.ts` quad, deleted: a -/+ n, b +/- n). */
function quadCorners(a: Vec2, b: Vec2, half: number): Vec2[] | null {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length < m(0.00004)) return null;
  const nx = (-dy / length) * half, ny = (dx / length) * half;
  return [{ x: a.x - nx, y: a.y - ny }, { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }];
}

/** Every quad and island the paint of a document drew, from `world/markings.ts` and `world/parkingLayout.ts` alone, by the item that paints it:
 *  solid strokes a quad a stretch, broken ones a quad a stretch they are inked on (the shader cuts its dashes), a crossing a quad a run of bars. */
function paintedOf(net: Network): Map<string, number> {
  const out = new Map<string, number>();
  const put = (source: string, color: string, corners: readonly Vec2[] | null): void => {
    if (!corners) return;
    const k = `${source}|${color}|${cornersKey(corners)}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  };
  const strokes = (source: string, spec: StrokeSpec): void => {
    for (let i = 1; i < spec.points.length; i++) put(source, spec.color, quadCorners(spec.points[i - 1]!, spec.points[i]!, spec.width / 2));
  };
  for (const id of net.doc.segments.keys()) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) continue;
    for (const spec of roadStrokes(net, ribbon)) strokes(`s${id}`, spec);
    for (const line of parkingLinesOf(net, ribbon, null)) strokes(`s${id}`, { points: line.points, width: line.width, color: line.color, dash: line.dash, dashOffset: 0 });
  }
  for (const node of net.doc.nodes.keys()) {
    if (net.transitions.has(node)) for (const spec of transitionMarkings(net, node)) strokes(`n${node}`, spec);
    const stops: Bar[] = [], zebras: Bar[] = [], runs: ZebraStretch[] = [];
    junctionDetailAt(net, node, stops, zebras, runs);
    midBlockDetailAt(net, node, stops, zebras, runs);
    for (const bar of stops) put(`n${node}`, STOP_PAINT, quadCorners(bar.a, bar.b, bar.width / 2));
    for (const { a, b, nrm, from, used } of runs) {
      put(`n${node}`, ZEBRA_PAINT, [
        { x: a.x + nrm.x * from, y: a.y + nrm.y * from }, { x: b.x + nrm.x * from, y: b.y + nrm.y * from },
        { x: b.x + nrm.x * (from + used), y: b.y + nrm.y * (from + used) }, { x: a.x + nrm.x * (from + used), y: a.y + nrm.y * (from + used) },
      ]);
    }
    const island = miniRoundaboutIsland(net, node);
    if (island) {
      put(`n${node}`, island.color, Array.from({ length: island.sides }, (_, i) => {
        const t = (i / island.sides) * Math.PI * 2;
        return { x: island.x + Math.cos(t) * island.radius, y: island.y + Math.sin(t) * island.radius };
      }));
    }
    const legends: StrokeSpec[] = [];
    approachLegendsAt(net, node, net.doc.markingStyle, legends);
    for (const spec of legends) strokes(`n${node}`, spec);
  }
  return out;
}

/** The marks the document holds, keyed as `paintedOf` keys the paint. */
function marksOf(doc: RoadDoc): Map<string, number> {
  const out = new Map<string, number>();
  for (const { source, color, shape } of roadMarks.shapesOf(doc)) {
    const k = `${source}|${color}|${cornersKey(shape.corners)}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

describe('no triangle of paint: every road class in every layout', () => {
  for (const [name, lay] of LAYOUTS) {
    it(`${name}: no paint surface, slot or mesh, and its marks the paint's own quads`, () => {
      let marked = 0;
      for (let t = 0; t < ROAD_TYPES.length; t++) {
        const { doc, net, inputs, meshes } = built(lay, t);
        // No mesh of paint: every road mesh is a band's, a median's or a far level of one.
        for (const mesh of meshes) expect(mesh.name, `${ROAD_TYPES[t]!.id}`).not.toMatch(/mark|paint/);
        // No shape of paint in any part of any pass (`roadSurfaceInputs.ts`): a part's surfaces are its bands' and its median's.
        for (const pass of inputs.passList()) {
          for (const part of inputs.tileKeys(pass.id)) {
            if (!inputs.hasTile(pass.id, part)) continue;
            for (const slot of inputs.reachOf(pass.id, part).reach.keys()) expect(slot).toMatch(/^(deckEdge|footway|kerb|asphalt|curbRamp|median:|stations)/);
          }
        }
        const want = paintedOf(net), got = marksOf(doc);
        // Every quad the paint drew a mark, of its colour, by the same item, corner for corner (the junction's paint is drawn at ground level only,
        // as it always was: a raised, a bridge's or a tunnel's road alone has no junction).
        expect([...got].sort(), `${ROAD_TYPES[t]!.id} ${name}`).toEqual([...want].sort());
        marked += got.size;
      }
      // A straight road of some class has no paint but its lines along it (the carriageway's own, `roadPaint.ts`); every junction has some.
      if (/four|three|mid-block|taper|parking/.test(name)) expect(marked).toBeGreaterThan(0);
    });
  }

  for (const style of ['classic', 'br', 'us', 'eu'] as MarkingStyleId[]) {
    it(`the ${style} standard: the junctions' rules, legends and crossings, the paint's own quads`, () => {
      for (const [name, lay] of LAYOUTS.filter(([n]) => /four ways/.test(n))) {
        const urban = ROAD_TYPES.findIndex((rt) => rt.id === 'urban');
        const { doc, net, meshes } = built(lay, urban, style);
        for (const mesh of meshes) expect(mesh.name).not.toMatch(/mark|paint/);
        expect([...marksOf(doc)].sort(), `${style} ${name}`).toEqual([...paintedOf(net)].sort());
      }
    });
  }
});

/** The shapes' coverage at a point as the shader reads it (`roadMarksShader.ts`, its arithmetic in TypeScript): the piece's head in the slots'
 *  table, its bucket, each entry's group's box and its shapes, a footprint of `w` square. Each palette colour's coverage, its shapes' most. */
function shaderReads(doc: RoadDoc, piece: MarkPiece, p: Vec2, coord: number, w: number, out: Map<number, number>): Map<number, number> {
  out.clear();
  const local = piece.kind === 'node' ? roadPaint.nodeSlot(doc, piece.id as NodeId) : roadPaint.roadSlot(doc, piece.id as SegmentId);
  const slots = roadPaint.segments.value.image.data as Float32Array;
  const marks = roadMarks.texture.value.image.data as Float32Array;
  const h = (roadPaint.resolverOf(doc)(local) * SLOT_TEXELS + MARKS_HEAD) * 4;
  const buckets = Math.round(slots[h + 2]!);
  if (buckets <= 0) return out;
  const b = (Math.round(slots[h + 3]!) + Math.min(buckets - 1, Math.max(0, Math.floor((coord - slots[h]!) / slots[h + 1]!)))) * 4;
  const span = (x: number, width: number): number => Math.min(1, Math.max(0, (Math.min(1, x + 0.5 * width) - Math.max(0, x - 0.5 * width)) / width));
  const ink = (e: number, d: number, period: number): number => Math.floor(e / period) * d + Math.min(e - period * Math.floor(e / period), d);
  const first = Math.round(marks[b]!), count = Math.round(marks[b + 1]!);
  for (let i = 0; i < count; i++) {
    const e = (first + i) * 4;
    const g = Math.round(marks[e]!), colour = Math.round(marks[e + 1]!), shapes = Math.round(marks[e + 2]!);
    if (p.x < marks[g * 4]! - w || p.x > marks[g * 4 + 2]! + w || p.y < marks[g * 4 + 1]! - w || p.y > marks[g * 4 + 3]! + w) continue;
    let cover = out.get(colour) ?? 0;
    for (let k = 0; k < shapes; k++) {
      const t = (g + 1 + k * SHAPE_TEXELS) * 4;
      const dx = p.x - marks[t]!, dy = p.y - marks[t + 1]!;
      let c: number;
      if (Math.round(marks[t + 6]!) === MARK_POLYGON) {
        const sector = (Math.PI * 2) / marks[t + 3]!;
        const a = (Math.floor(Math.atan2(dy, dx) / sector) + 0.5) * sector;
        const nx = Math.cos(a), ny = Math.sin(a);
        c = Math.min(1, Math.max(0, 0.5 - (dx * nx + dy * ny - marks[t + 2]! * Math.cos(0.5 * sector)) / ((Math.abs(nx) + Math.abs(ny)) * w)));
      } else {
        const r0x = marks[t + 2]!, r0y = marks[t + 3]!, r1x = marks[t + 4]!, r1y = marks[t + 5]!;
        c = span(r0x * dx + r0y * dy, (Math.abs(r0x) + Math.abs(r0y)) * w) * span(r1x * dx + r1y * dy, (Math.abs(r1x) + Math.abs(r1y)) * w);
        if (Math.round(marks[t + 6]!) === MARK_DASHED && c > 0) {
          const d = marks[t + 7]!, q = marks[t + 8]! + marks[t + 9]! * dx + marks[t + 10]! * dy, period = marks[t + 11]!;
          const width = (Math.abs(marks[t + 9]!) + Math.abs(marks[t + 10]!)) * w;
          c *= Math.min(1, Math.max(0, (ink(q + 0.5 * width, d, period) - ink(q - 0.5 * width, d, period)) / width));
        }
      }
      cover = Math.max(cover, c);
    }
    out.set(colour, cover);
  }
  return out;
}

/** Whether `p` is inside a convex quad's corners by more than `margin` (outside by more than `margin`: -1; on its edge: 0). */
function insideQuad(corners: readonly Vec2[], p: Vec2, margin: number): number {
  let area = 0;
  for (let i = 0; i < corners.length; i++) { const a = corners[i]!, b = corners[(i + 1) % corners.length]!; area += a.x * b.y - b.x * a.y; }
  const sign = Math.sign(area);
  let least = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!, b = corners[(i + 1) % corners.length]!;
    const ex = b.x - a.x, ey = b.y - a.y, length = Math.hypot(ex, ey);
    least = Math.min(least, (sign * (ex * (p.y - a.y) - ey * (p.x - a.x))) / length);
  }
  return least > margin ? 1 : least < -margin ? -1 : 0;
}

describe('read back through the texture as the shader reads it', () => {
  const cases: readonly (readonly [string, Lay, MarkingStyleId])[] = [
    ['four ways, br', LAYOUTS.find(([n]) => n === 'four ways')![1], 'br'],
    ['four ways, stop, us', controlled('stop'), 'us'],
    ['four ways, mini-roundabout, eu', controlled('mini'), 'eu'],
    ['a crossing mid-block', LAYOUTS.find(([n]) => n === 'a crossing mid-block')![1], 'classic'],
    ['parking', LAYOUTS.find(([n]) => n === 'parking')![1], 'classic'],
    ['a taper to the next class', LAYOUTS.find(([n]) => n === 'a taper to the next class')![1], 'classic'],
  ];
  for (const [name, lay, style] of cases) {
    it(`${name}: on a 2 cm grid, every point a mark inks is inked in its colour through every piece it is filed in, and no other`, () => {
      const urban = ROAD_TYPES.findIndex((rt) => rt.id === 'urban');
      const { doc, net } = built(lay, urban, style);
      const shapes = roadMarks.shapesOf(doc);
      expect(shapes.length).toBeGreaterThan(0);
      const STEP = m(0.02), MARGIN = m(0.005), W = m(0.0001);
      const hit = { s: 0, distance: 0 };
      const coordOf = (piece: MarkPiece, p: Vec2): number => {
        if (piece.kind === 'node') return p.x;
        net.ribbons.get(piece.id as SegmentId)!.full.closestInto(p.x, p.y, hit);
        return hit.s;
      };
      const pieceOf = (name: string): MarkPiece => ({ kind: name[0] === 'n' ? 'node' : 'segment', id: Number(name.slice(1)) });
      let inked = 0, clear = 0;
      const reads = new Map<number, number>();
      /** Where a shape inks at `p`, by its own geometry: 1 inside it (and under its pattern) by more than `MARGIN`, -1 outside, 0 on its edge. */
      const inksOne = (s: (typeof shapes)[number], p: Vec2): number => {
        const data = s.shape.data;
        if (Math.round(data[6]!) === MARK_POLYGON) {
          const [cx, cy, radius, sides] = data as [number, number, number, number];
          const sector = (Math.PI * 2) / sides, a = (Math.floor(Math.atan2(p.y - cy, p.x - cx) / sector) + 0.5) * sector;
          const d = (p.x - cx) * Math.cos(a) + (p.y - cy) * Math.sin(a) - radius * Math.cos(sector / 2);
          return d < -MARGIN ? 1 : d > MARGIN ? -1 : 0;
        }
        const inside = insideQuad(s.shape.corners, p, MARGIN);
        if (inside < 0 || Math.round(data[6]!) !== MARK_DASHED) return inside;
        const [ox, oy, , , , , , d, q0, gx, gy, period] = data as number[];
        const q = q0! + gx! * (p.x - ox!) + gy! * (p.y - oy!), at = q - period! * Math.floor(q / period!);
        const reach = MARGIN * Math.hypot(gx!, gy!);
        const under = at > reach && at < d! - reach ? 1 : at > d! + reach && at < period! - reach ? -1 : 0;
        return inside === 1 ? under : Math.min(0, under);
      };
      const near = (a: readonly number[], b: readonly number[]): boolean => a[0]! <= b[2]! + m(0.2) && a[2]! >= b[0]! - m(0.2) && a[1]! <= b[3]! + m(0.2) && a[3]! >= b[1]! - m(0.2);
      for (const { color, shape, into } of shapes) {
        const index = roadMarks.paletteIndex(color);
        for (const target of into) {
          const piece = pieceOf(target);
          // What inks this colour through this piece near the shape: the shapes of its colour filed in it.
          const filed = shapes.filter((s) => s.color === color && s.into.includes(target) && near(s.shape.box, shape.box));
          const [x0, y0, x1, y1] = shape.box;
          for (let x = x0 - m(0.1); x <= x1 + m(0.1); x += STEP) {
            for (let y = y0 - m(0.1); y <= y1 + m(0.1); y += STEP) {
              const p = { x, y };
              let want = -1;
              for (const s of filed) { want = Math.max(want, inksOne(s, p)); if (want === 1) break; }
              if (want === 0) continue;
              const got = shaderReads(doc, piece, p, coordOf(piece, p), W, reads).get(index) ?? 0;
              if (want === 1) { if (!(got > 0.999)) expect(got, `${target} ${color} at ${key(p)}`).toBeGreaterThan(0.999); inked++; }
              else { if (got !== 0) expect(got, `${target} ${color} at ${key(p)}`).toBe(0); clear++; }
            }
          }
        }
      }
      expect(inked).toBeGreaterThan(1000);
      expect(clear).toBeGreaterThan(1000);
    });
  }
});

describe('each mark on its own carriageway', () => {
  it('a junction with a bridge leg: its leg\'s marks on the leg\'s own carriageway, none on another pass\'s', () => {
    const urban = ROAD_TYPES.findIndex((rt) => rt.id === 'urban');
    const { doc, inputs } = built((d, t) => { meeting(d, t, CROSS, ['ground', 'bridge', 'ground', 'ground']); }, urban);
    // Each piece's pass: the pass whose parts hold it (`roadSurfaceInputs.ts`).
    const passes = new Map<string, string>();
    for (const pass of inputs.passList()) {
      for (const part of inputs.tileKeys(pass.id)) {
        const piece = pieceOfPart(part);
        passes.set(`${piece.kind === 'node' ? 'n' : 's'}${piece.id}`, pass.id);
      }
    }
    const passOf = (target: string): string => passes.get(target) ?? `no pass holds ${target}`;
    expect(new Set(passes.values()).size).toBeGreaterThan(1);
    const shapes = roadMarks.shapesOf(doc);
    expect(shapes.length).toBeGreaterThan(0);
    // Every piece a group is filed in is drawn in one pass: a mark never shows on another pass's carriageway.
    for (const { into } of shapes) expect(new Set(into.map(passOf)).size).toBe(1);
  });

  it('an edit writes again the marks of the pieces it touches alone', () => {
    const urban = ROAD_TYPES.findIndex((rt) => rt.id === 'urban');
    const doc = new RoadDoc();
    const centre = meeting(doc, urban, CROSS);
    // A second junction further east, untouched by the edit.
    const east = doc.addNode({ x: LEG * 3, y: 0 });
    const [eastEnd] = [...doc.nodes.values()].filter((n) => n.x === LEG && n.y === 0);
    doc.addSegment(eastEnd!.id, east.id, urban);
    doc.addSegment(east.id, doc.addNode({ x: LEG * 3, y: LEG }).id, urban);
    doc.addSegment(east.id, doc.addNode({ x: LEG * 3, y: -LEG }).id, urban);
    const net = new Network(doc);
    net.rebuild();
    const inputs = new SurfaceInputs();
    const reuse = { tiles: new Map(), dependsOn: () => 0, chunks: new Map(), inputs } as unknown as SurfaceReuse;
    buildRoadSurfaces(net, buildRoadElevation(net, flat), materials, flat, reuse);
    const pieces: MarkPiece[] = [...[...doc.nodes.keys()].map((id): MarkPiece => ({ kind: 'node', id })), ...[...doc.segments.keys()].map((id): MarkPiece => ({ kind: 'segment', id }))];
    const blocks = (): Map<string, string> => new Map(pieces.map((p) => [`${p.kind}${p.id}`, JSON.stringify(roadMarks.blockOf(doc, p))]));
    const before = blocks();
    expect([...before.values()].filter((b) => b !== 'null').length).toBeGreaterThan(4);
    doc.setNodeControl(centre, 'stop');
    net.rebuild();
    buildRoadSurfaces(net, buildRoadElevation(net, flat), materials, flat, reuse);
    const after = blocks();
    const touched = new Set([`node${centre}`, ...doc.node(centre)!.incident.map((s) => `segment${s}`)]);
    const changed = [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.filter((k) => !touched.has(k))).toEqual([]);
    // The east junction's marks are where they were.
    expect(after.get(`node${east.id}`)).toBe(before.get(`node${east.id}`));
  });
});
