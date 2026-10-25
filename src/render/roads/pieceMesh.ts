import earcut, { refine } from 'earcut';

import { type Chain, type Sampler, chainAt, chainBetween, edgeStations, ladderTriangles, stationsOf, withStations } from '../mesh/stripShape';
import { HEIGHT_TOL, type PieceShape, type SkirtRing, type Tile, type TileMeshOptions, meshShape, surfaceSampler, withoutSection } from '../mesh/tileMesh';
import { FIXED, type Geom, OWN, type PieceLevel, type PieceReach, WALL_A, WALL_B, WALL_END, WALL_START, atLevel, levelled } from './pieceGeom';
import { STATIONS_SLOT, type TileSource, slotOf } from '../roadSurfaceReads';

/**
 * # A ROAD PIECE MESHED WHOLE (`pieceGeom.ts`)
 *
 * A piece's shapes are meshed whole, nothing cut: the piece is drawn in one block, its owner's (`roads/pieceOwner.ts`), which the network's far
 * level files it under too, so the two levels swap the same pieces. Where two pieces of two blocks meet (a road's end on a junction's mouth) their
 * vertices are the same numbers, and the blocks' far levels keep them where they are (`seamsOf`, `mesh/roadLodPure.ts` BlockLock).
 * - The strips of a road share their stations: each asks where its surface leaves its chords (`stripShape.ts` stationsOf, with its own surface's
 *   tolerances) and every strip of the road takes them all, so two bands meet on their shared edge vertex for vertex.
 * - A junction's plate and its footway corners are their own outlines cut once by ear clipping and refined to Delaunay quality by edge flips: earcut
 *   3.2 and its `refine`, Mapbox, ISC (https://github.com/mapbox/earcut), Lawson's flips of every edge whose opposite corner lies inside the
 *   circumcircle (the owner's road tool's `Ul` is the same code). A Delaunay triangulation of given points maximises their smallest angle
 *   (https://en.wikipedia.org/wiki/Delaunay_triangulation), and no point is added: no fan from a middle, the worst triangulation there is on a GPU
 *   that shades in 2 x 2 pixel quads (Persson, https://www.humus.name/index.php?page=News&ID=228). Their outlines' points are their own, the mouths
 *   the roads' strips end on and the kerb returns' stations (`junctionPiece.ts`), so a road's strip and the plate share the mouth line's two ends.
 * - A piece is meshed at a level (`pieceGeom.ts` PieceLevel, atLevel): the detail, and for a junction's surfaces its blocks' far level as tiles of their
 *   own (`FAR_TILE`), the same pieces with the coarser level's points.
 */

/** A surface of a pass as a part is meshed of it: what it is made from and what each vertex reads. */
export interface MeshedSurface {
  readonly source: TileSource;
  readonly options: TileMeshOptions & { readonly name: string };
}

/** The name a part's footprint is kept under in its bundle (`footprintOf`): no surface of a pass is named so, so no block merges it, and it is kept
 *  and read back with the part's surfaces (`roadSurfaces.ts`, `derivedCache.ts`). */
export const FOOTPRINT = 'footprint';

/** What a surface's tile at the blocks' far level is kept under in its part's bundle: its name and this (`farTileName`). Only a surface some shape of
 *  the part draws coarser there has one (a junction's); every other surface's far level is its own tile (`roadSurfaces.ts`). */
const FAR_TILE = '@far';
export const farTileName = (name: string): string => `${name}${FAR_TILE}`;

/** Every surface of a piece (its shapes `reach`), each vertex read here: by surface name, in the order of `specs`; `only`, those named alone (a
 *  surface's far tile by `farTileName`), their stations still asked of every surface of `specs` (a block refilled a surface at a time is the same as
 *  built, `roadSurfaces.ts` surfaceSource). With every surface, a surface some of whose shapes are drawn coarser at the blocks' far level (a
 *  junction's, `pieceGeom.ts` atLevel) is meshed at that level too, kept under its far tile's name. */
export function pieceBundle(reach: PieceReach, specs: readonly MeshedSurface[], only?: ReadonlySet<string>): Map<string, Tile> {
  const samplers = specs.map((spec) => surfaceSampler(spec.options));
  // The stations of each group of strips: one set the strips ask together (`sharedStations`), and those the piece names.
  const named = new Map<number, number[]>(), members = new Map<number, Member[]>();
  for (const g of reach.get(STATIONS_SLOT) ?? []) if (g.kind === 'stations') { const list = named.get(g.group) ?? []; list.push(...g.s); named.set(g.group, list); }
  specs.forEach((spec, k) => {
    for (const g of reach.get(slotOf(spec.source)) ?? []) {
      if (g.kind !== 'strip' || g.group < 0) continue;
      const sampler = g.plate && spec.options.plateOffRoad ? surfaceSampler(withoutSection(spec.options)) : samplers[k]!;
      const list = members.get(g.group) ?? [];
      list.push({ a: g.a, b: g.b, sampler });
      members.set(g.group, list);
    }
  });
  const stations = new Map<number, number[]>();
  for (const group of new Set([...named.keys(), ...members.keys()])) {
    const own = named.get(group) ?? [];
    stations.set(group, [...new Set([...own, ...sharedStations(members.get(group) ?? [], own)])].sort((p, q) => p - q));
  }
  const bundle = new Map<string, Tile>();
  const meshAt = (spec: MeshedSurface, k: number, level: PieceLevel): Tile | null => {
    const geoms = reach.get(slotOf(spec.source));
    if (!geoms?.length) return null;
    const options = spec.options;
    const sampler = samplers[k]!;
    const plateSampler = options.plateOffRoad ? surfaceSampler(withoutSection(options)) : sampler;
    const pieces: PieceShape[] = [];
    const skirts: SkirtRing[] = [];
    for (const whole of geoms) {
      const g = atLevel(whole, level);
      if (!g) continue;
      shapeOf(g, options, g.kind !== 'stations' && g.kind !== 'walls' && g.kind !== 'face' && g.plate ? plateSampler : sampler, stations, pieces, skirts);
    }
    if (pieces.length === 0 && skirts.length === 0) return null;
    return meshShape({ pieces, skirts: options.bottom ? skirts : null }, options);
  };
  specs.forEach((spec, k) => {
    const name = spec.options.name;
    if (!only || only.has(name)) {
      const tile = meshAt(spec, k, 0);
      if (tile) bundle.set(name, tile);
    }
    // Its far level's own tile where some shape of it is drawn coarser there.
    const far = farTileName(name);
    if (only && !only.has(far)) return;
    const coarser = (reach.get(slotOf(spec.source)) ?? []).some(levelled);
    if (!coarser) return;
    const tile = meshAt(spec, k, 1);
    if (tile) bundle.set(far, tile);
  });
  // A pass at grade: what its part draws over the ground, for the terrain to be cut along (none for a raised one: its deck stands on piers).
  if (!only && !specs.some((spec) => spec.options.deck)) {
    const print = footprintOf(bundle, specs);
    if (print) bundle.set(FOOTPRINT, print);
  }
  return bundle;
}

/**
 * A part's footprint: every face its surfaces draw over the ground (x, height, -y of three corners each, nine floats a triangle, no index), the
 * walls (no area on the plan) left out - what the terrain is cut away under and meets the outline of
 * (`terrainSeams.ts`), the drawn vertices themselves, so the two meet on the same numbers. Null for a part with none.
 */
function footprintOf(bundle: ReadonlyMap<string, Tile>, specs: readonly MeshedSurface[]): Tile | null {
  const out: number[] = [];
  for (const spec of specs) {
    const tile = bundle.get(spec.options.name);
    if (!tile) continue;
    const p = tile.positions, index = tile.indices;
    for (let t = 0; t + 2 < index.length; t += 3) {
      const a = index[t]! * 3, b = index[t + 1]! * 3, c = index[t + 2]! * 3;
      // Twice its area on the plan (x, -z): a wall's is none.
      const twice = (p[b]! - p[a]!) * (p[a + 2]! - p[c + 2]!) - (p[a + 2]! - p[b + 2]!) * (p[c]! - p[a]!);
      if (!(Math.abs(twice) > LEAST_AREA)) continue;
      for (const v of [a, b, c]) out.push(p[v]!, p[v + 1]!, p[v + 2]!);
    }
  }
  if (out.length === 0) return null;
  const none = (): Float32Array => new Float32Array(0);
  return { positions: Float32Array.from(out), normals: none(), uvs: none(), colors: none(), sections: none(), indices: new Uint32Array(0) };
}

/**
 * Where a piece meets the pieces next to it, as segments (x0, y0, x1, y1 each): every strip's two ends (a road's end on a junction's mouth, a mitre,
 * a dropped kerb's ends), a junction's plate's and footway corners' mouths (`Geom` mouths: the edges across each leg, where the road's carriageway
 * and footway end), and a kerb face's two ends (a point: its foot and its top). Nothing else of a junction: its kerb returns are its own, drawn at each
 * level by their own stations (`pieceGeom.ts` atLevel). A block's far level keeps every vertex on them where it is (`mesh/roadLodPure.ts` BlockLock):
 * two blocks drawing the two sides of a mouth meet on the same vertices at every level.
 */
export function seamsOf(reach: PieceReach): Float64Array {
  const out: number[] = [];
  const end = (c: Chain, last: boolean): [number, number] => last ? [c.xy[c.xy.length - 2]!, c.xy[c.xy.length - 1]!] : [c.xy[0]!, c.xy[1]!];
  for (const geoms of reach.values()) {
    for (const g of geoms) {
      if (g.kind === 'strip') {
        for (const last of [false, true]) out.push(...end(g.a, last), ...end(g.b, last));
      } else if ((g.kind === 'fan' || g.kind === 'poly') && g.mouths) {
        const count = g.ring.length / 2;
        for (let i = 0; i < count; i++) {
          if (!g.mouths[i]) continue;
          const j = (i + 1) % count;
          out.push(g.ring[i * 2]!, g.ring[i * 2 + 1]!, g.ring[j * 2]!, g.ring[j * 2 + 1]!);
        }
      } else if (g.kind === 'face') {
        for (const last of [false, true]) { const [x, y] = end(g.run, last); out.push(x, y, x, y); }
      }
    }
  }
  return Float64Array.from(out);
}

/** A strip of a group as its stations are asked (`sharedStations`): its two chains and what its surface varies in. */
interface Member { readonly a: Chain; readonly b: Chain; readonly sampler: Sampler }

/**
 * The stations a group of strips (a road's bands) takes, asked of them together: between each two of the points any of them has (and `named`), every
 * strip over that stretch read at the quarters and the middle on both chains and across (`stripShape.ts` stationsOf, each with its own surface's
 * tolerances and floors); a stretch any of them leaves is cut at its middle, the same station for all, and both halves read again. DO NOT ask each strip
 * on its own and unite their stations: each halves its own stretch, and two bands of different lengths put two stations a few millimetres apart, a
 * quad of needles across every band (`tests/render/stripSlivers.spec.ts`). On the flat a road's bands are planes: no station, one quad each, as the
 * owner's road tool lays them.
 */
function sharedStations(members: readonly Member[], named: readonly number[], budget = 4096): number[] {
  if (members.length === 0) return [];
  const range = members.map((m) => [Math.max(m.a.s[0]!, m.b.s[0]!), Math.min(m.a.s[m.a.s.length - 1]!, m.b.s[m.b.s.length - 1]!)] as const);
  const cuts = [...new Set([...members.flatMap((m) => [...m.a.s, ...m.b.s]), ...named])].sort((p, q) => p - q);
  const pa: [number, number] = [0, 0], pb: [number, number] = [0, 0];
  const scratch: number[] = [];
  /** Each strip's readings at a station (on chain a, on chain b, across the middle); null for a strip not over it. */
  const read = (s: number): (Float64Array | null)[] => members.map((m, i) => {
    if (s < range[i]![0] - 1e-9 || s > range[i]![1] + 1e-9) return null;
    const size = m.sampler.size, out = new Float64Array(size * 3);
    chainAt(m.a, s, pa); chainAt(m.b, s, pb);
    m.sampler.sample(pa[0], pa[1], scratch); for (let k = 0; k < size; k++) out[k] = scratch[k]!;
    m.sampler.sample(pb[0], pb[1], scratch); for (let k = 0; k < size; k++) out[size + k] = scratch[k]!;
    m.sampler.sample((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, scratch); for (let k = 0; k < size; k++) out[size * 2 + k] = scratch[k]!;
    return out;
  });
  const leaves = (s: number, t: number, rs: (Float64Array | null)[], rt: (Float64Array | null)[]): boolean => {
    const quarters = [0.25, 0.5, 0.75].map((f) => read(s + (t - s) * f));
    return members.some((m, i) => {
      const a0 = rs[i], a1 = rt[i];
      if (!a0 || !a1) return false;
      const size = m.sampler.size;
      const c0 = chainAt(m.a, s, [0, 0]), c1 = chainAt(m.a, t, [0, 0]), d0 = chainAt(m.b, s, [0, 0]), d1 = chainAt(m.b, t, [0, 0]);
      const span = Math.max(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]), Math.hypot(d1[0] - d0[0], d1[1] - d0[1]));
      return [0.25, 0.5, 0.75].some((f, q) => {
        const got = quarters[q]![i];
        if (!got) return false;
        for (let column = 0; column < 3; column++) {
          for (let k = 0; k < size; k++) {
            if (span <= m.sampler.floor[k]!) continue;
            // A quantity read on the outline alone (a skirt's foot) is not read across the middle.
            if (column === 2 && m.sampler.outline?.[k]) continue;
            const at = column * size + k;
            if (Math.abs(got[at]! - (a0[at]! + (a1[at]! - a0[at]!) * f)) > m.sampler.tolerance[k]!) return true;
          }
        }
        return false;
      });
    });
  };
  const added: number[] = [];
  let left = budget;
  const visit = (s: number, t: number, rs: (Float64Array | null)[], rt: (Float64Array | null)[], depth: number): void => {
    if (left <= 0 || depth > 16 || !leaves(s, t, rs, rt)) return;
    const mid = (s + t) / 2, rm = read(mid);
    added.push(mid);
    left--;
    visit(s, mid, rs, rm, depth + 1);
    visit(mid, t, rm, rt, depth + 1);
  };
  let rs = read(cuts[0]!);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const s = cuts[i]!, t = cuts[i + 1]!;
    const rt = read(t);
    if (t - s >= 1e-6) visit(s, t, rs, rt, 0);
    rs = rt;
  }
  return added;
}

/**
 * What a block's far level keeps where it is besides the seams (`seamsOf`): every point of a shape drawn coarser there (a junction's plate, kerb faces
 * and footway corners at the far level, `pieceGeom.ts` atLevel), as segments. That level is already its own (the owner's road tool's L1); DO NOT let
 * the simplifier take more of it, a surface at a time: the plate, the kerb's face and the footway share a kerb return's stations, and each simplified
 * on its own would open a crack between them.
 */
export function farLocksOf(reach: PieceReach): Float64Array {
  const out: number[] = [];
  const along = (xy: ArrayLike<number>, closed: boolean): void => {
    const count = xy.length / 2;
    for (let i = 0; i + (closed ? 0 : 1) < count; i++) {
      const j = (i + 1) % count;
      out.push(xy[i * 2]!, xy[i * 2 + 1]!, xy[j * 2]!, xy[j * 2 + 1]!);
    }
  };
  for (const geoms of reach.values()) {
    for (const whole of geoms) {
      if (!levelled(whole)) continue;
      const g = atLevel(whole, 1);
      if (!g) continue;
      if (g.kind === 'fan' || g.kind === 'poly') along(g.ring, true);
      else if (g.kind === 'face') along(g.run.xy, false);
      else if (g.kind === 'strip') { along(g.a.xy, false); along(g.b.xy, false); }
    }
  }
  return Float64Array.from(out);
}

/** One shape's triangles and walls, into `pieces` and `skirts`. */
function shapeOf(g: Geom, options: TileMeshOptions, sampler: Sampler, stations: ReadonlyMap<number, readonly number[]>,
  pieces: PieceShape[], skirts: SkirtRing[]): void {
  switch (g.kind) {
    case 'strip': {
      const added = g.group >= 0 ? stations.get(g.group) ?? [] : g.group === OWN ? stationsOf(g, sampler) : [];
      const a = g.group === FIXED ? g.a : withStations(g.a, added);
      // A ground road's outer edge: the stations its own heights ask, the terrain's vertices on it (`terrainSeams.ts` asks the same).
      const b = g.group === FIXED ? g.b : g.outer && !options.deck ? withStations(g.b, edgeStations(g.b, options.top, HEIGHT_TOL, options.leastEdge))
        : withStations(g.b, added);
      const walls = g.walls | (options.deck ? g.deckWalls ?? 0 : 0);
      // Cut across into chains where the surface is not a plane across (`TileMeshOptions.across`): a's and b's own points kept, the chains between
      // at every station of either.
      const n = Math.max(1, Math.round(options.across ?? 1));
      const chains: Chain[] = [a];
      for (let k = 1; k < n; k++) chains.push(chainBetween(a, b, k / n));
      chains.push(b);
      const xy: number[] = [], tris: number[] = [];
      for (let k = 0; k + 1 < chains.length; k++) {
        const made = ladderTriangles({ a: chains[k]!, b: chains[k + 1]! }, g.diagonal);
        const base = xy.length / 2;
        for (let i = 0; i < made.xy.length; i++) xy.push(made.xy[i]!);
        for (let i = 0; i < made.tris.length; i++) tris.push(base + made.tris[i]!);
      }
      push(pieces, xy, tris, g.plate === true);
      if (walls) {
        // Its outline: a along, across its end, b back, across its start.
        const ring: number[] = [];
        for (let i = 0; i < a.s.length; i++) ring.push(a.xy[i * 2]!, a.xy[i * 2 + 1]!);
        for (let i = b.s.length - 1; i >= 0; i--) ring.push(b.xy[i * 2]!, b.xy[i * 2 + 1]!);
        const na = a.s.length, count = ring.length / 2;
        const walled = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          // Edge i runs from point i to point i + 1.
          if (i < na - 1) walled[i] = walls & WALL_A ? 1 : 0;
          else if (i === na - 1) walled[i] = walls & WALL_END ? 1 : 0;
          else if (i < count - 1) walled[i] = walls & WALL_B ? 1 : 0;
          else walled[i] = walls & WALL_START ? 1 : 0;
        }
        wallsOf(ring, walled, skirts);
      }
      return;
    }
    case 'fan': {
      // A junction's plate: its outline alone (the module's head).
      const made = plateTriangles(g.ring);
      push(pieces, made.xy, made.tris, g.plate === true);
      wallsOf(g.ring, g.walls, skirts);
      return;
    }
    case 'poly': {
      const made = plateTriangles(g.ring);
      push(pieces, made.xy, made.tris, g.plate === true, g.kerb !== undefined ? kerbDistances(made.xy, g.kerb, g.kerbWidth ?? 0) : undefined);
      const walls = Uint8Array.from(g.walls, (w, i) => w | (options.deck && g.deckWalls ? g.deckWalls[i]! : 0));
      wallsOf(g.ring, walls, skirts);
      return;
    }
    case 'face': {
      const run = g.group >= 0 ? withStations(g.run, stations.get(g.group) ?? []) : g.run;
      const count = run.s.length;
      const facing = g.normals && g.normals.length === count * 2 ? g.normals : null;
      const edges: number[] = [], normals: number[] = [];
      for (let i = 0; i + 1 < count; i++) {
        // The wall faces the run's right: a run facing its left is walked each edge backwards.
        const [p, q] = g.left ? [i + 1, i] : [i, i + 1];
        const ax = run.xy[p * 2]!, ay = run.xy[p * 2 + 1]!, bx = run.xy[q * 2]!, by = run.xy[q * 2 + 1]!;
        if (Math.abs(bx - ax) + Math.abs(by - ay) < 1e-6) continue;
        edges.push(ax, ay, bx, by);
        if (facing) normals.push(facing[p * 2]!, facing[p * 2 + 1]!, facing[q * 2]!, facing[q * 2 + 1]!);
      }
      if (edges.length) skirts.push({ flip: false, edges: Float64Array.from(edges), ...(facing ? { normals: Float64Array.from(normals) } : {}) });
      return;
    }
    case 'walls':
      if (g.edges.length >= 4) skirts.push({ flip: false, edges: g.edges });
      return;
    case 'stations':
      return;
  }
}

/** Least twice-area of a triangle kept, square metres: one with less has no area to draw (two chains meeting at a point, a station on a corner). */
const LEAST_AREA = 1e-8;

/** Triangles into `pieces`, their winding measured, a triangle with no area left out; `across`, each vertex's place across its footway (`PieceShape`). */
function push(pieces: PieceShape[], xy: ArrayLike<number>, tris: ArrayLike<number>, plate: boolean, across?: Float64Array): void {
  const own = Float64Array.from(xy), kept: number[] = [];
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = tris[t]! * 2, b = tris[t + 1]! * 2, c = tris[t + 2]! * 2;
    const twice = (own[b]! - own[a]!) * (own[c + 1]! - own[a + 1]!) - (own[b + 1]! - own[a + 1]!) * (own[c]! - own[a]!);
    if (Math.abs(twice) > LEAST_AREA) kept.push(tris[t]!, tris[t + 1]!, tris[t + 2]!);
  }
  if (kept.length === 0) return;
  const list = Uint32Array.from(kept);
  pieces.push({ xy: own, tris: list, flip: trianglesArea(own, list) < 0, ...(plate ? { plate } : {}), ...(across ? { across } : {}) });
}

/** Each vertex's distance from a polygon's kerb line (its first `kerb` points) less the kerb's width: under 0 over the kerb stone's top, which the
 *  footway's shader draws (`mesh/roadEdges.ts`), as the owner's road tool reads it (its footway's `road.y`). */
function kerbDistances(xy: Float64Array, kerb: number, width: number): Float64Array {
  const count = xy.length / 2;
  const out = new Float64Array(count);
  for (let v = 0; v < count; v++) {
    const x = xy[v * 2]!, y = xy[v * 2 + 1]!;
    let best = v < kerb ? 0 : Infinity;
    for (let i = 0; best > 0 && i + 1 < kerb; i++) {
      const ax = xy[i * 2]!, ay = xy[i * 2 + 1]!, ex = xy[i * 2 + 2]! - ax, ey = xy[i * 2 + 3]! - ay;
      const l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + ex * t - x, ay + ey * t - y));
    }
    out[v] = (Number.isFinite(best) ? best : 0) - width;
  }
  return out;
}

/** The walled edges of a closed outline (`walls[i]`: the edge from point i to point i + 1), with the outline's winding. */
function wallsOf(ring: ArrayLike<number>, walls: ArrayLike<number>, skirts: SkirtRing[]): void {
  const count = ring.length / 2;
  const edges: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!walls[i]) continue;
    const j = (i + 1) % count;
    const ax = ring[i * 2]!, ay = ring[i * 2 + 1]!, bx = ring[j * 2]!, by = ring[j * 2 + 1]!;
    if (Math.abs(bx - ax) + Math.abs(by - ay) < 1e-6) continue;
    edges.push(ax, ay, bx, by);
  }
  if (edges.length) skirts.push({ flip: ringArea(ring) < 0, edges: Float64Array.from(edges) });
}

/** A strip's, a plate's or a polygon's triangles on the plan alone, counter-clockwise (seen from above): the far level's and a road just built's
 *  (`networkFarRoads.ts`, `roadStandIn.ts`); null for another shape or none. */
export function flatTriangles(g: Geom): { xy: Float64Array; tris: Uint32Array } | null {
  let made: { xy: Float64Array; tris: Uint32Array };
  if (g.kind === 'strip') made = ladderTriangles({ a: g.a, b: g.b }, g.diagonal);
  else if (g.kind === 'fan' || g.kind === 'poly') made = plateTriangles(g.ring);
  else return null;
  const kept: number[] = [];
  for (let t = 0; t + 2 < made.tris.length; t += 3) {
    const a = made.tris[t]! * 2, b = made.tris[t + 1]! * 2, c = made.tris[t + 2]! * 2;
    const twice = (made.xy[b]! - made.xy[a]!) * (made.xy[c + 1]! - made.xy[a + 1]!) - (made.xy[b + 1]! - made.xy[a + 1]!) * (made.xy[c]! - made.xy[a]!);
    if (Math.abs(twice) <= LEAST_AREA) continue;
    if (twice > 0) kept.push(made.tris[t]!, made.tris[t + 1]!, made.tris[t + 2]!);
    else kept.push(made.tris[t]!, made.tris[t + 2]!, made.tris[t + 1]!);
  }
  return kept.length ? { xy: made.xy, tris: Uint32Array.from(kept) } : null;
}

/** An outline cut by ear clipping (earcut) and its triangles refined to Delaunay quality by edge flips (`refine`), no point added: a junction's plate,
 *  a footway corner (the module's head). Points less two triangles. */
function plateTriangles(ring: ArrayLike<number>): { xy: Float64Array; tris: Uint32Array } {
  const xy = Float64Array.from(ring);
  const tris = earcut(xy, undefined, 2);
  refine(tris, xy, 2);
  return { xy, tris: Uint32Array.from(tris) };
}

/** Twice the summed signed area of triangles over a flat [x, y, ...] list; positive means counter-clockwise. */
function trianglesArea(flat: ArrayLike<number>, tris: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = tris[i]! * 2, b = tris[i + 1]! * 2, c = tris[i + 2]! * 2;
    const ax = flat[a]!, ay = flat[a + 1]!;
    sum += (flat[b]! - ax) * (flat[c + 1]! - ay) - (flat[b + 1]! - ay) * (flat[c]! - ax);
  }
  return sum;
}

/** Twice the signed area of a closed outline of x, y pairs; positive means counter-clockwise. */
function ringArea(ring: ArrayLike<number>): number {
  const count = ring.length / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    sum += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!;
  }
  return sum;
}
