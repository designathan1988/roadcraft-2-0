import { beforeAll, describe, expect, it } from 'vitest';
import { MeshBasicMaterial, type Mesh } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { Level, ROAD_TYPES, type SurfaceLevel } from '@world/roadTypes';
import type { RoadSection } from '@world/roadSection';
import type { NodeId, SegmentId } from '@world/ids';
import { type Geom, type PieceLevel, atLevel } from '@render/roads/pieceGeom';
import { type MeshedSurface, farTileName, pieceBundle } from '@render/roads/pieceMesh';
import { type Shape, segmentShapes } from '@render/roads/segmentPiece';
import { junctionShapes } from '@render/roads/junctionPiece';
import { passDesc, passReads } from '@render/roadSurfacePass';
import { passSurfaces } from '@render/roadSurfaceReads';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import type { SurfacePass } from '@render/roadSurfaceEntries';
import { FAR_SECTION, farPieceCells } from '@render/networkFarPieces';
import { ROAD_PASS_LOOK } from '@render/roadPassLook';
import type { Tile } from '@render/mesh/tileMesh';
import type { SceneMaterials } from '@render/materials';
import { type SurfaceReuse, roadSurfaceSteps } from '@render/roadSurfaces';
import { ROAD_CODE, marksRoadSection } from '@render/mesh/roadEdges';
import { coarseArrays } from '@render/mesh/roadLodPure';
import { levelsOf } from '@render/mesh/roadLod';
import type { RoadTiler } from '@render/roadTilePool';

/**
 * THE GAME'S ROADS AS THE OWNER'S ROAD TOOL BUILDS THEM (`ferramenta-vias-objetos.html`, its road builder `pu` run unchanged in Node). The tool's layouts are built in the game with the tool's cross-section
 * as near the tool's own cross-section (a 7 m carriageway, a 2.5 m footway) as the game's widths go, whole metres of the universal grid
 * (`world/roadSection.ts` normalizeRoadSection): lanes of 4 m, a footway of 3 m with its 0.15 m kerb (the game's kerb is 0.15 m tall, its face hung a
 * centimetre past its foot, 0.16 m as the tool's), and the kerb radius the game solves for it (3.5 m, asserted below), the tool run with the same
 * (A = 4, K = 0.15, F = 2.85, R = 3.5; its counts are the same as with its own defaults, only its triangles' widths change), and
 * their triangles counted from the meshes the game builds, surface by surface and level by level:
 * - the plate (the tool's `placa`), the junction's kerb faces and footway (`guia`, `calçada`: the tool's less its roads' one quad a band a side) and
 *   the carriageway (`pista`) equal to the tool's;
 * - each side of each road: its footway from the carriageway's edge and its kerb's face one quad from mouth to free end, as the tool's, but where a
 *   dropped kerb (which the tool does not have) takes its stretch: the footway's stretches and the ramps' then tile the side exactly, end to end, each
 *   stretch one quad and one kerb quad; the ramps' own triangles, the footway behind them and the kerb's end at a free end listed apart;
 * - no triangle narrower than the tool's (least altitude, 2 x area / longest edge), no point inside a plate, the mouths the same at every level, each
 *   level's kerb return's points some of the finer one's, two builds the same to the bit, a layout moved the same triangles.
 * The tool's numbers below were read from its own run with these dimensions (its builder `pu` with A = 4, K = 0.15, F = 2.85, KH = 0.16, R = 3.5), its
 * least altitudes as it gives them, to 12 significant digits. The tool measures in doubles; the game measures the positions its meshes store, floats:
 * each triangle's altitude is held to the tool's less what rounding that triangle's own nine coordinates to floats can move it (`floatSlack`).
 */

/** The tool's counts and least altitudes (metres) at each level: total, plate, kerb faces, footway, carriageway. */
interface Reference { readonly total: number; readonly plate: number; readonly kerb: number; readonly footway: number; readonly carriageway: number; readonly altitude: number }
const ref = (total: number, plate: number, kerb: number, footway: number, carriageway: number, altitude: number): Reference => ({ total, plate, kerb, footway, carriageway, altitude });

/**
 * Where the game's junctions differ from the tool's by the owner's order (2026-10-25: every corner curved inside and outside): the triangles each level
 * gains (or loses) over the tool's, plate, kerb faces and footway, the roads untouched. A footway corner is one polygon (points less two triangles):
 * the kerb's stations and its back run. The tool's back run is the leg's mouth corner, the square point Y and the next leg's mouth corner (two at a
 * straight corner, whose back is straight in both); the game's is the two mouth corners and the back arc's stations between them, concentric with
 * the kerb's return at the footway's width (`junctionPiece.ts` outerRun), as many at each level as keep the back's chords as near its arc as the
 * kerb's (`arcLevels`): so each curved corner's footway is (back stations kept - 1) triangles off the tool's. Here (R 3.5 m, footway 3 m: a back arc
 * of 0.5 m round a right angle) a right-angled corner keeps 3 stations at L0, 1 at L1 and none at L2 (its arc's ends are the mouth corners): +2, 0, -1.
 * A bend's outside is curved too (`reflexArc`), where the tool mitres it at the kerb lines' meeting point X: its kerb an arc concentric with the
 * inside's (radius 3.5 + 8 m), 8, 4 and 2 steps a right angle, its back the same arc's offset with as many: the plate gains the arc's inner stations
 * less X (+6, +2, 0), the kerb its quads less the mitre's two (+12, +4, none at L2), the footway corner (9 + 9, 5 + 5, 3 + 3 points against the tool's
 * 3 + 3: +12, +4, 0).
 */
interface Curved { readonly plate: number; readonly kerb: number; readonly footway: number }
const curved = (plate: number, kerb: number, footway: number): Curved => ({ plate, kerb, footway });
const SAME = curved(0, 0, 0);

const LEG = 70;
const at = (degrees: number): [number, number] => [LEG * Math.cos((degrees * Math.PI) / 180), LEG * Math.sin((degrees * Math.PI) / 180)];
/** The tool's layouts (`hu`, and angled T's): roads from the centre out to each end, or the bend through it. */
const CASES: readonly {
  readonly name: string; readonly ends: readonly (readonly [number, number])[]; readonly levels: readonly [Reference, Reference, Reference];
  /** The game's curved corners against the tool's, each level (`Curved`). */
  readonly curves: readonly [Curved, Curved, Curved];
}[] = [
  // Four right-angled corners: +2, 0, -1 each.
  { name: 'four-way', ends: [[70, 0], [0, 70], [-70, 0], [0, -70]], levels: [ref(178, 34, 80, 56, 8, 0.155819356441), ref(114, 18, 48, 40, 8, 0.158913031220), ref(50, 10, 0, 32, 8, 0.493196964264)],
    curves: [curved(0, 0, 8), SAME, curved(0, 0, -4)] },
  // Two right-angled corners (+2, 0, -1 each); the through road's back is straight in both.
  { name: 'T', ends: [[70, 0], [-70, 0], [0, 70]], levels: [ref(104, 18, 46, 34, 6, 0.155819356441), ref(72, 10, 30, 26, 6, 0.158913031220), ref(34, 6, 0, 22, 6, 0.493196964264)],
    curves: [curved(0, 0, 4), SAME, curved(0, 0, -2)] },
  // Its inside a right-angled corner (+2, 0, -1), its outside curved where the tool mitres it (plate +6, +2, 0; kerb +12, +4; footway +12, +4, 0).
  { name: 'bend', ends: [[-70, 0], [0, 70]], levels: [ref(64, 10, 28, 22, 4, 0.155819356441), ref(48, 6, 20, 18, 4, 0.158913031220), ref(24, 4, 0, 16, 4, 0.493196964264)],
    curves: [curved(6, 12, 14), curved(2, 4, 4), curved(0, 0, -1)] },
  // Two corners of 50.7 degrees' sweep and two of 129.3: back stations kept 3 and 3 at L0 (+2 each), 3 and 3 at L1 (+2 each), 2 and 1 at L2 (+1, 0).
  // Its L2 least altitude the curved back's own: the 129.3 degree corner's (50.7 of sweep) back arc (0.5 m) is a chord of 0.43 m across a 3 m footway, where the tool's
  // square point Y gave 0.995 m (the arc kept at L2, 2026-10-25); wider than every reference of L0 and L1.
  { name: 'diagonal', ends: [[70, 0], [-70, 0], [45, 55], [-45, -55]], levels: [ref(258, 54, 120, 76, 8, 0.147862374783), ref(162, 30, 72, 52, 8, 0.156677678227), ref(66, 18, 0, 40, 8, 0.427177574)],
    curves: [curved(0, 0, 8), curved(0, 0, 8), curved(0, 0, 2)] },
  // The 110 degree corner (70 of sweep) keeps 4, 2, 1 back stations (+3, +1, 0), the 70 degree one (110 of sweep) 3, 3, 1 (+2, +2, 0).
  { name: 'T at 70', ends: [[70, 0], [-70, 0], at(70)], levels: [ref(140, 27, 64, 43, 6, 0.149505302310), ref(92, 15, 40, 31, 6, 0.157160535455), ref(40, 9, 0, 25, 6, 0.347743779421)],
    curves: [curved(0, 0, 5), curved(0, 0, 3), SAME] },
  // The 120 degree corner (60 of sweep) keeps 2, 2, 1 (+1, +1, 0), the 60 degree one (120 of sweep) 3, 3, 1 (+2, +2, 0).
  { name: 'T at 60', ends: [[70, 0], [-70, 0], at(60)], levels: [ref(140, 27, 64, 43, 6, 0.151041775942), ref(92, 15, 40, 31, 6, 0.157601788640), ref(40, 9, 0, 25, 6, 0.287347882986)],
    curves: [curved(0, 0, 3), curved(0, 0, 3), SAME] },
  // The 135 degree corner (45 of sweep) keeps 2, 1, 1 (+1, 0, 0), the 45 degree one (135 of sweep) 3, 3, 1 (+2, +2, 0).
  { name: 'T at 45', ends: [[70, 0], [-70, 0], at(45)], levels: [ref(124, 23, 56, 39, 6, 0.152794525027), ref(84, 13, 36, 29, 6, 0.158093333244), ref(38, 8, 0, 24, 6, 0.206615015864)],
    curves: [curved(0, 0, 3), curved(0, 0, 2), SAME] },
];

/** The cross-section on the game's urban class (see above): two lanes of 4 m, a footway of 3 m with its kerb, whole metres as the game keeps them. */
const SECTION: RoadSection = { laneWidth: 4, sidewalk: 3, median: 0, speedKmh: 50, priority: 1 };
const URBAN = ROAD_TYPES.findIndex((t) => t.id === 'urban');

/** A layout built in the game, moved by (dx, dy). */
function build(ends: readonly (readonly [number, number])[], dx = 0, dy = 0): Network {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: dx, y: dy });
  for (const [x, y] of ends) doc.addSegment(centre.id, doc.addNode({ x: dx + x, y: dy + y }).id, URBAN, null, 0, 'both', null, 'ground', SECTION);
  const net = new Network(doc);
  net.rebuild();
  return net;
}

/** Each surface the ground pass draws (its paint aside), read on flat ground. */
function surfacesOf(net: Network): MeshedSurface[] {
  const elevation = buildRoadElevation(net, () => 0);
  const reads = passReads(net, elevation, () => 0);
  const pass: SurfacePass = { id: 'ground', structure: 'ground' };
  const look = { scale: { asphalt: 4, footway: 2, kerb: 1, verge: 4, deck: 4 }, classTint: [], referenceTint: [1, 1, 1] as const, pavingTint: {} };
  return passSurfaces(passDesc(net, pass, false, look), reads);
}

const byTile = (shapes: readonly Shape[]): Map<string, Geom[]> => {
  const reach = new Map<string, Geom[]>();
  for (const { slot, geom } of shapes) { const list = reach.get(slot); if (list) list.push(geom); else reach.set(slot, [geom]); }
  return reach;
};

/** A triangle's altitude on its longest edge (2 x area / longest edge, in 3D), its nine coordinates x, y, z of each corner. */
function altitudeOf(c: readonly number[]): number {
  const ux = c[3]! - c[0]!, uy = c[4]! - c[1]!, uz = c[5]! - c[2]!, vx = c[6]! - c[0]!, vy = c[7]! - c[1]!, vz = c[8]! - c[2]!;
  const twice = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  const longest = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(c[6]! - c[3]!, c[7]! - c[4]!, c[8]! - c[5]!));
  return twice / longest;
}

/** Half the spacing of floats (32-bit) at the magnitude of `v`: how far storing `v` as one may move it (round to nearest). */
const halfFloatStep = (v: number): number => (v === 0 ? 2 ** -150 : 2 ** (Math.floor(Math.log2(Math.abs(v))) - 24));

/**
 * How far a triangle's altitude may stand off its value in doubles once its corners are stored as floats (the game's meshes, `tileMesh.ts`
 * weldVertices): each coordinate's half float step times how fast the altitude changes with it (central differences in doubles), summed. A
 * first-order bound of that triangle's own rounding, nothing else; the narrowest triangles here move by tens of nanometres.
 */
function floatSlack(c: readonly number[]): number {
  let slack = 0;
  for (let k = 0; k < 9; k++) {
    const h = 1e-6 * Math.max(1, Math.abs(c[k]!));
    const up = [...c], down = [...c];
    up[k] = c[k]! + h; down[k] = c[k]! - h;
    slack += (Math.abs(altitudeOf(up) - altitudeOf(down)) / (2 * h)) * halfFloatStep(c[k]!);
  }
  return slack;
}

/** A triangle's altitude and its float slack (`floatSlack`). */
type Thin = readonly [altitude: number, slack: number];
/** The triangles narrower than this are kept with their slack to be held to the tool's least altitude (every one of the tool's is wider). */
const THIN = 0.2;

/** A tile's triangles: their count, their least altitude, and every triangle under `THIN` with its float slack. */
function measure(tile: Tile): { triangles: number; altitude: number; thin: Thin[] } {
  let altitude = Infinity;
  const thin: Thin[] = [];
  const p = tile.positions;
  for (let i = 0; i < tile.indices.length; i += 3) {
    const c = [0, 1, 2].flatMap((k) => { const v = tile.indices[i + k]! * 3; return [p[v]!, p[v + 1]!, p[v + 2]!]; });
    const a = altitudeOf(c);
    altitude = Math.min(altitude, a);
    if (a < THIN) thin.push([a, floatSlack(c)]);
  }
  return { triangles: tile.indices.length / 3, altitude, thin };
}

/** Every triangle held to the tool's least altitude `least`: none narrower than it by more than its own float slack, and no slack over a micrometre. */
function holdsTo(thin: readonly Thin[], least: number, label: string): void {
  for (const [altitude, slack] of thin) {
    if (altitude >= least) continue;
    // Narrower in floats than the tool in doubles: by no more than its own rounding, and that under a micrometre.
    expect(slack, `${label}: a triangle's float slack`).toBeLessThanOrEqual(1e-6);
    expect(altitude + slack, `${label}: a triangle of ${altitude} m against the tool's ${least} m`).toBeGreaterThanOrEqual(least);
  }
}

/** A shape's triangles at a level, meshed alone (its surface's options), and their least altitude. */
function meshOne(slot: string, geom: Geom, specs: readonly MeshedSurface[], level: 0 | 1): { triangles: number; altitude: number; thin: Thin[] } {
  const spec = specs.find((s) => (s.source.kind === 'band' ? s.source.band : '') === slot);
  if (!spec) return { triangles: 0, altitude: Infinity, thin: [] };
  const bundle = pieceBundle(new Map([[slot, [geom]]]), [spec]);
  const tile = level === 1 ? bundle.get(farTileName(spec.options.name)) ?? bundle.get(spec.options.name) : bundle.get(spec.options.name);
  return tile ? measure(tile) : { triangles: 0, altitude: Infinity, thin: [] };
}

/** What a layout draws at a level, counted the tool's way: its plate, kerb faces, footway and carriageway, and apart what the tool does not have. */
interface Count {
  plate: number; kerb: number; footway: number; carriageway: number;
  /** The junctions' own kerb faces and footway (the tool's `guia` and `calçada` less its roads'). */
  junctionKerb: number; junctionFootway: number;
  /** The dropped kerbs' own triangles, the footway behind them, and the kerb's ends at a road's free end. */
  ramps: number; behindRamps: number; kerbEnds: number;
  /** Stretches of a road's footway from the carriageway's edge (each one quad, one kerb quad beside it). */
  stretches: number;
  altitude: number; rampAltitude: number;
  /** The tool's structure's triangles under `THIN` (the ramps' apart), each with its float slack. */
  thin: Thin[];
}

function countAt(net: Network, level: 0 | 1): Count {
  const specs = surfacesOf(net);
  const out: Count = { plate: 0, kerb: 0, footway: 0, carriageway: 0, junctionKerb: 0, junctionFootway: 0, ramps: 0, behindRamps: 0, kerbEnds: 0, stretches: 0, altitude: Infinity, rampAltitude: Infinity, thin: [] };
  const take = (m: { triangles: number; altitude: number; thin: Thin[] }, ramp = false): number => {
    if (m.triangles > 0) { if (ramp) out.rampAltitude = Math.min(out.rampAltitude, m.altitude); else { out.altitude = Math.min(out.altitude, m.altitude); out.thin.push(...m.thin); } }
    return m.triangles;
  };
  for (const id of net.junctions.keys()) {
    for (const { slot, geom } of junctionShapes(net, id as NodeId)) {
      const n = take(meshOne(slot, geom, specs, level));
      if (slot === 'asphalt') out.plate += n; else if (slot === 'kerb') { out.kerb += n; out.junctionKerb += n; } else if (slot === 'footway') { out.footway += n; out.junctionFootway += n; }
    }
  }
  for (const ribbon of net.ribbons.values()) {
    const shapes = ribbonShapes(net, ribbon.id);
    for (const { slot, geom } of shapes) {
      // A band the ground pass does not draw (a deck's edge): none of its triangles.
      if (!specs.some((spec) => spec.source.kind === 'band' && spec.source.band === slot)) continue;
      if (slot === 'curbRamp') { out.ramps += take(meshOne(slot, geom, specs, level), true); continue; }
      const n = take(meshOne(slot, geom, specs, level));
      if (slot === 'asphalt') { out.carriageway += n; continue; }
      if (slot === 'kerb' && geom.kind === 'walls') { out.kerbEnds += n; continue; }
      // A footway strip behind a ramp starts on the ramp's back, not on the carriageway's edge.
      if (slot === 'footway' && geom.kind === 'strip' && behindRamp(geom, shapes)) { out.behindRamps += n; continue; }
      if (slot === 'kerb') out.kerb += n; else if (slot === 'footway') { out.footway += n; out.stretches++; }
      expect(n, `${slot} stretch of road ${ribbon.id}: one quad`).toBe(2);
    }
    tiled(net, ribbon.id, shapes);
  }
  return out;
}

/**
 * Each side of a road from mouth (or free end) to mouth: its footway's stretches from the carriageway's edge and its ramps' stretches end to end, no
 * gap and no overlap (arc lengths along the road, to a micrometre), a kerb face beside each footway stretch on the same stretch: the tool's one quad a
 * band a side, cut where a dropped kerb takes the kerb and the footway, and nowhere else.
 */
function tiled(net: Network, id: SegmentId, shapes: readonly Shape[]): void {
  const asphalt = shapes.find((s) => s.slot === 'asphalt')!.geom;
  if (asphalt.kind !== 'strip') throw new Error('a carriageway is a strip');
  const line = net.ribbons.get(id)!.full, near = { s: 0, distance: 0 };
  /** The side of the road a point lies on: 1 its normal's side, -1 the other. */
  const sideOf = (x: number, y: number): number => { line.closestInto(x, y, near); const f = line.sampleAt(near.s); return Math.sign((x - f.p.x) * f.n.x + (y - f.p.y) * f.n.y); };
  for (const edge of [asphalt.a, asphalt.b]) {
    const side = sideOf(edge.xy[0]!, edge.xy[1]!);
    const start = edge.s[0]!, end = edge.s[edge.s.length - 1]!;
    const stretches: [number, number][] = [], faces: [number, number][] = [], footways: [number, number][] = [];
    for (const { slot, geom } of shapes) {
      if (geom.kind === 'face' && slot === 'kerb' && sideOf(geom.run.xy[0]!, geom.run.xy[1]!) === side) faces.push([geom.run.s[0]!, geom.run.s[geom.run.s.length - 1]!]);
      if (geom.kind !== 'strip' || !(slot === 'curbRamp' || slot === 'footway') || sideOf(geom.a.xy[0]!, geom.a.xy[1]!) !== side) continue;
      // From the carriageway's edge: a footway's stretch or a ramp's part (the footway behind a ramp starts on the ramp's back).
      if (slot === 'footway' && behindRamp(geom, shapes)) continue;
      stretches.push([geom.a.s[0]!, geom.a.s[geom.a.s.length - 1]!]);
      if (slot === 'footway') footways.push([geom.a.s[0]!, geom.a.s[geom.a.s.length - 1]!]);
    }
    stretches.sort((p, q) => p[0] - q[0]);
    expect(stretches[0]![0], `road ${id} side ${side} starts at its mouth`).toBeCloseTo(start, 6);
    for (let i = 1; i < stretches.length; i++) expect(stretches[i]![0], `road ${id} side ${side} stretch ${i} follows on`).toBeCloseTo(stretches[i - 1]![1], 6);
    expect(stretches[stretches.length - 1]![1], `road ${id} side ${side} ends at its end`).toBeCloseTo(end, 6);
    expect(faces.sort((p, q) => p[0] - q[0]), `road ${id} side ${side}: a kerb face beside each footway stretch`).toEqual(footways.sort((p, q) => p[0] - q[0]));
  }
}

/** Whether a footway strip lies behind a ramp (its inner chain is a ramp's back). */
function behindRamp(geom: Geom & { kind: 'strip' }, shapes: readonly Shape[]): boolean {
  return shapes.some((s) => s.slot === 'curbRamp' && s.geom.kind === 'strip' && Math.hypot(s.geom.b.xy[0]! - geom.a.xy[0]!, s.geom.b.xy[1]! - geom.a.xy[1]!) < 1e-6);
}

const ribbonShapes = (net: Network, id: SegmentId): Shape[] => segmentShapes(net, net.ribbons.get(id)!);

/** The network's root level (L2) of a layout counted the tool's way, as the game makes it (`networkFarPieces.ts` farPieceCells: the far shapes meshed
 *  as the detail's surfaces): the plate (a junction's carriageway, its vertices carrying its node), the casing (the footway's band) and the
 *  carriageway's strips; and its triangles narrower than the tool's widest least altitude with their float slack. */
function countFar(net: Network): { plate: number; casing: number; carriageway: number; thin: Thin[] } {
  const out = { plate: 0, casing: 0, carriageway: 0, thin: [] as Thin[] };
  const cells = farPieceCells(net, buildRoadElevation(net, () => 0), () => 0, 1000, null, ROAD_PASS_LOOK);
  for (const cell of cells) {
    for (let t = 0; t < cell.indices.length; t += 3) {
      const c = [0, 1, 2].flatMap((k) => { const v = cell.indices[t + k]! * 3; return [cell.positions[v]!, cell.positions[v + 1]!, cell.positions[v + 2]!]; });
      const a = altitudeOf(c);
      if (a < 1.5) out.thin.push([a, floatSlack(c)]);
      const at = cell.indices[t]! * FAR_SECTION, code = cell.sections[at + 3]!, slot = cell.sections[at + 2]!;
      if (code === ROAD_CODE.carriageway) { if (slot <= -2) out.plate++; else out.carriageway++; } else if (code === ROAD_CODE.footway) out.casing++;
    }
  }
  return out;
}

beforeAll(async () => { await MeshoptSimplifier.ready; });

describe('the tool\'s layouts built by the game: its structure, triangle for triangle', () => {
  for (const c of CASES) {
    it(`${c.name}: plate, kerb faces, footway and carriageway as the tool's at L0 and L1, its features apart`, () => {
      const net = build(c.ends);
      // The cross-section and the kerb radius the tool was run with: the game keeps the section as given, and solves the returns at 3.5 m.
      for (const s of net.doc.segments.values()) expect(s.section, `${c.name} section`).toEqual(SECTION);
      for (const j of net.junctions.values()) for (const k of j.get(Level.Asphalt as SurfaceLevel)!.corners) if (k.fillet) expect(k.fillet.r, `${c.name} kerb radius`).toBeCloseTo(3.5, 9);
      for (const level of [0, 1] as const) {
        const got = countAt(net, level);
        const want = c.levels[level], curves = c.curves[level];
        const label = `${c.name} L${level}`;
        // The tool's roads draw one kerb quad and one footway quad a side: 4 triangles of each an arm.
        const arms = c.ends.length;
        expect(got.plate, `${label} plate`).toBe(want.plate + curves.plate);
        expect(got.junctionKerb, `${label} junction kerb faces`).toBe(want.kerb + curves.kerb - 4 * arms);
        expect(got.junctionFootway, `${label} junction footway`).toBe(want.footway + curves.footway - 4 * arms);
        expect(got.carriageway, `${label} carriageway`).toBe(want.carriageway);
        holdsTo(got.thin, want.altitude, `${label} least altitude (ramps apart)`);
      }
    });
    it(`${c.name}: the network's far level as the tool's L2`, () => {
      const far = countFar(build(c.ends));
      const want = c.levels[2], curves = c.curves[2];
      expect(far.plate, `${c.name} L2 plate`).toBe(want.plate + curves.plate);
      expect(far.casing, `${c.name} L2 footway`).toBe(want.footway + curves.footway);
      expect(far.carriageway, `${c.name} L2 carriageway`).toBe(want.carriageway);
      holdsTo(far.thin, want.altitude, `${c.name} L2 least altitude`);
    });
  }
});

/** A junction's plate's outline at a level (x, y pairs) and its mouths' corners. */
function plateAt(net: Network, level: PieceLevel): { ring: Float64Array; mouths: number[] } {
  const node = [...net.junctions.keys()][0]! as NodeId;
  const plate = junctionShapes(net, node).find((s) => s.slot === 'asphalt')!.geom;
  const g = atLevel(plate, level)!;
  if (g.kind !== 'fan') throw new Error('a plate is a fan');
  const mouths: number[] = [];
  for (let i = 0; i < g.ring.length / 2; i++) if (g.mouths?.[i]) mouths.push(g.ring[i * 2]!, g.ring[i * 2 + 1]!, g.ring[((i + 1) % (g.ring.length / 2)) * 2]!, g.ring[((i + 1) % (g.ring.length / 2)) * 2 + 1]!);
  return { ring: g.ring, mouths };
}

describe('a junction\'s levels', () => {
  const net = build(CASES[0]!.ends);

  it('has the same mouths at every level, and each level\'s outline some of the finer one\'s points', () => {
    const levels = ([0, 1, 2] as const).map((l) => plateAt(net, l));
    expect(levels[1]!.mouths).toEqual(levels[0]!.mouths);
    expect(levels[2]!.mouths).toEqual(levels[0]!.mouths);
    const has = (ring: Float64Array, x: number, y: number): boolean => { for (let i = 0; i < ring.length; i += 2) if (ring[i] === x && ring[i + 1] === y) return true; return false; };
    for (const [coarse, fine] of [[2, 1], [1, 0]] as const) {
      const c = levels[coarse]!.ring, f = levels[fine]!.ring;
      for (let i = 0; i < c.length; i += 2) expect(has(f, c[i]!, c[i + 1]!), `L${coarse} point ${i / 2} in L${fine}`).toBe(true);
    }
  });

  it('draws no point inside its plate: every vertex of the plate\'s mesh is a point of its outline', () => {
    const specs = surfacesOf(net);
    for (const level of [0, 1] as const) {
      const { ring } = plateAt(net, level);
      const node = [...net.junctions.keys()][0]! as NodeId;
      const reach = byTile(junctionShapes(net, node));
      const asphalt = specs.find((s) => s.source.kind === 'band' && s.source.band === 'asphalt')!;
      const bundle = pieceBundle(new Map([['asphalt', reach.get('asphalt')!]]), [asphalt]);
      const tile = (level === 1 ? bundle.get(farTileName(asphalt.options.name)) : bundle.get(asphalt.options.name))!;
      for (let v = 0; v < tile.positions.length / 3; v++) {
        const x = tile.positions[v * 3]!, y = -tile.positions[v * 3 + 2]!;
        let near = Infinity;
        for (let i = 0; i < ring.length; i += 2) near = Math.min(near, Math.hypot(ring[i]! - x, ring[i + 1]! - y));
        // Positions are stored as floats: a hundredth of a millimetre at 70 m.
        expect(near, `L${level} vertex ${v}`).toBeLessThan(1e-4);
      }
      expect(tile.indices.length / 3).toBe(ring.length / 2 - 2);
    }
  });

  it('is built the same to the bit twice, and the same triangles anywhere it is moved', () => {
    const bits = (n: Network): string => {
      const specs = surfacesOf(n);
      const parts: string[] = [];
      for (const id of [...n.junctions.keys()].sort((p, q) => p - q)) {
        for (const [name, tile] of [...pieceBundle(byTile(junctionShapes(n, id as NodeId)), specs)].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
          parts.push(name, Array.from(tile.positions).join(','), Array.from(tile.indices).join(','), Array.from(tile.normals).join(','), Array.from(tile.sections).join(','));
        }
      }
      return parts.join('|');
    };
    expect(bits(build(CASES[0]!.ends))).toBe(bits(build(CASES[0]!.ends)));
    for (const c of CASES) {
      const here = build(c.ends), there = build(c.ends, 1234.5, -987.25);
      for (const level of [0, 1] as const) {
        const a = countAt(here, level), b = countAt(there, level);
        expect({ ...b, altitude: 0, rampAltitude: 0, thin: [] }, `${c.name} L${level} moved`).toEqual({ ...a, altitude: 0, rampAltitude: 0, thin: [] });
      }
      expect({ ...countFar(there), thin: [] }, `${c.name} L2 moved`).toEqual({ ...countFar(here), thin: [] });
    }
  });
});

describe('the blocks’ far level of a junction (`roadSurfaces.ts`): its own level-1 mesh, not the detail simplified', () => {
  const readingAll = (): MeshBasicMaterial => { const m = new MeshBasicMaterial({ vertexColors: true }); marksRoadSection(m); return m; };
  const made = new Map<string | symbol, MeshBasicMaterial>();
  const materials = new Proxy({}, { get: (_t, key) => (key === 'scale' ? new Proxy({}, { get: () => 4 }) : made.get(key) ?? made.set(key, readingAll()).get(key)) }) as unknown as SceneMaterials;

  /** Every block's full and far triangles of the road's bands (paint aside), built as the game builds them, far levels made on the page. */
  async function blocks(net: Network): Promise<{ full: number; far: number }> {
    const flat = (): number => 0;
    const tiler: RoadTiler = { tiles: () => Promise.reject(new Error('the tiles are built on the page')), check: () => {}, coarsen: (arrays, lock) => Promise.resolve(coarseArrays(structuredClone(arrays), lock)) };
    const chunks = new Map<string, { mesh: Mesh }>();
    const reuse = { tiles: new Map(), dependsOn: () => 0, chunks, inputs: new SurfaceInputs(), near: () => true } as unknown as SurfaceReuse;
    const steps = roadSurfaceSteps(net, buildRoadElevation(net, flat), materials, flat, reuse, tiler);
    for (;;) {
      const step = steps.next();
      if (step.done) { step.value.adopt(); break; }
      if (step.value === 'wait') await new Promise((done) => setTimeout(done, 0));
    }
    let full = 0, far = 0;
    for (const { mesh } of chunks.values()) {
      if (mesh.name.startsWith('markings')) continue;
      full += (mesh.geometry.index?.count ?? 0) / 3;
      const coarse = levelsOf(mesh)?.coarse;
      far += ((coarse ?? mesh).geometry.index?.count ?? 0) / 3;
    }
    return { full, far };
  }

  for (const c of CASES) {
    it(`${c.name}: the far level the junction's L1 shapes and the roads' own, triangle for triangle`, async () => {
      const net = build(c.ends);
      const sum = (k: Count): number => k.plate + k.kerb + k.footway + k.carriageway + k.ramps + k.behindRamps + k.kerbEnds;
      const got = await blocks(net);
      expect(got.full, `${c.name} full level`).toBe(sum(countAt(net, 0)));
      expect(got.far, `${c.name} far level`).toBe(sum(countAt(net, 1)));
    });
  }
});
