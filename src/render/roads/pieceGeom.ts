import { Digest } from '@core/digest';
import type { Chain, Diagonal } from '../mesh/stripShape';

/**
 * # A ROAD PIECE'S SURFACES AS PLAIN DATA
 *
 * The roads' surfaces are built piece by piece of the network: a road between its junctions (`segmentPiece.ts`), a junction from its own plates
 * (`junctionPiece.ts`). Each surface of a piece is a few shapes made straight from the road's centreline and cross-section or from the junction's
 * outline at each level, never from uniting the outlines of the roads round it (the way shipped road tools build them: a cross-section swept along
 * the centreline, Cities: Skylines' segment and node meshes, Unreal's spline meshes, EasyRoads3D; `reports/Vias e mobiliário urbano otimizados.md`):
 * - a strip, between two of the road's edges (the carriageway between its two edges, the footway from the carriageway's edge to its own...);
 * - a fan, a junction's plate: its outline alone, cut by ear clipping and refined (`pieceMesh.ts`), no point inside it;
 * - a polygon, a junction's footway corner (its kerb's return and its outer run), cut the same way;
 * - a face, a kerb's: a wall along a run of points;
 * - stations every strip of a group takes (a ramp's ends), and walls standing alone (a median's nose, a kerb's free end).
 * Plain data (typed arrays and numbers): made on the page from the network, meshed by the road tile workers (`roadTile.worker.ts`).
 *
 * A wall stands only where the surface steps down beside it: a kerb's face, a median's, a dropped kerb's front, a kerb's free end. Two bands of
 * one height meet on the same vertices with no wall between them, and on the ground the terrain meets a footway's outer edge on its own vertices
 * (`terrainSeams.ts`): no wall there. A deck's sides (its footway's outer edge, its free ends) are walls on a deck alone (`deckWalls`).
 */

/** A strip's or a fan's sides that hang a wall down to the surface's bottom (`TileMeshOptions.bottom`). */
export const WALL_A = 1, WALL_B = 2, WALL_START = 4, WALL_END = 8;

/**
 * The levels a piece is drawn at, finest first: the detail (0), the blocks' far level (1, `mesh/roadResidency.ts`) and the network's far level (2,
 * `networkFarRoads.ts`), the owner's road tool's three (its `Jl`: 8, 4 and 2 steps a right angle of a kerb return, kerb faces at the first two).
 * Which one a block draws is the residency's, by the block's distance. A shape's points carry the
 * coarsest level that keeps each (`Geom` levels): a level is the points of a tag at least its own, so every level's points are some of the finer
 * one's and its mouths are the same.
 */
export type PieceLevel = 0 | 1 | 2;
/** The coarsest level: every point is kept at it unless tagged finer. */
export const COARSEST: PieceLevel = 2;

/** A strip's stations: shared by every strip of its group (`>= 0`, a road's bands: one vertex row across them all), its own (`OWN`, a quad of
 *  paint draped on the road) or none but its chains' points (`FIXED`, a junction's corner, whose edges are the plates' own). */
export const OWN = -1, FIXED = -2;

export type Geom =
  | {
    readonly kind: 'strip';
    /** Its inner edge and its outer edge, over the same stretch of its road (`Chain.s`). */
    readonly a: Chain;
    readonly b: Chain;
    readonly group: number;
    /** `WALL_A | WALL_B | WALL_START | WALL_END`: the sides that step down, on the ground and on a deck. */
    readonly walls: number;
    /** The sides that are a deck's own sides: walled only on a deck (`TileMeshOptions.deck`). */
    readonly deckWalls?: number;
    /** Its outer chain `b` is a ground road's outer edge, which the terrain meets (`terrainSeams.ts`): stationed by its own heights alone
     *  (`stripShape.ts` edgeStations), as the terrain reads it, not by the group's. */
    readonly outer?: true;
    /** The diagonal its quads are cut along (`stripShape.ts` Diagonal); none, the shorter. */
    readonly diagonal?: Diagonal;
    /** A junction's: off every road's section (`TileMeshOptions.plateOffRoad`). */
    readonly plate?: true;
    /** Each point's coarsest level (`PieceLevel`), chain a's and chain b's (a junction's corner, `FIXED`); none: every point at every level. */
    readonly aLevels?: Uint8Array;
    readonly bLevels?: Uint8Array;
  }
  | {
    readonly kind: 'fan';
    /** Its middle (the network's far level used to fan it from there; nothing reads it to mesh it now). */
    readonly cx: number;
    readonly cy: number;
    /** Its outline, counter-clockwise, x and y a point, not closed. */
    readonly ring: Float64Array;
    /** Each edge's wall (edge i from point i to point i + 1): 1 walled. */
    readonly walls: Uint8Array;
    readonly plate?: true;
    /** Each edge a mouth (edge i from point i to point i + 1): 1 where it is where a road's strips end on it (`pieceMesh.ts` seamsOf). */
    readonly mouths?: Uint8Array;
    /** Each point's coarsest level (`PieceLevel`); none: every point at every level. */
    readonly levels?: Uint8Array;
  }
  | {
    readonly kind: 'poly';
    readonly ring: Float64Array;
    readonly walls: Uint8Array;
    readonly plate?: true;
    readonly mouths?: Uint8Array;
    readonly levels?: Uint8Array;
    /** Each edge's wall on a deck alone (`TileMeshOptions.deck`): a junction's footway's outer side over a bridge. */
    readonly deckWalls?: Uint8Array;
    /** Its first `kerb` points are a kerb's line (a junction's footway corner from its kerb's return): each vertex's place across the footway is
     *  read as its distance from that line less `kerbWidth`, the kerb stone's top drawn by the footway's shader where it is under 0 (`mesh/roadEdges.ts`). */
    readonly kerb?: number;
    readonly kerbWidth?: number;
  }
  /**
   * A wall standing along a run of points (a kerb's face), from the surface's top down to its bottom, facing the run's right (its left with `left`);
   * its points the group's stations as a strip's are (`group`), each point's coarsest level (`levels`), and the way each point faces on the plan
   * (`normals`, x and y a point: a kerb's return's face lit round, as the owner's tool lights it) where given, else each quad its own.
   */
  | {
    readonly kind: 'face';
    readonly run: Chain;
    readonly group: number;
    readonly left?: true;
    readonly levels?: Uint8Array;
    readonly normals?: Float64Array;
  }
  | { readonly kind: 'stations'; readonly group: number; readonly s: Float64Array }
  /** Walls standing on their own: four numbers an edge, the outside on its right. */
  | { readonly kind: 'walls'; readonly edges: Float64Array };

/** One shape of a piece, with its box and its digest, measured once when its piece is made. */
export interface Input {
  readonly geom: Geom;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly digest: number;
}

/** A shape's box and digest; null for one with nothing in it. */
export function inputOf(geom: Geom): Input | null {
  const digest = new Digest().addText(geom.kind);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (xy: ArrayLike<number>): void => {
    digest.add(xy.length);
    for (let i = 0; i + 1 < xy.length; i += 2) {
      const x = xy[i]!, y = xy[i + 1]!;
      digest.add(x).add(y);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  };
  const list = (values: ArrayLike<number>): void => { digest.add(values.length); for (let i = 0; i < values.length; i++) digest.add(values[i]!); };
  const optional = (values: ArrayLike<number> | undefined): void => { if (values) list(values); else digest.add(-1); };
  switch (geom.kind) {
    case 'strip':
      if (geom.a.s.length < 2 || geom.b.s.length < 2) return null;
      take(geom.a.xy); list(geom.a.s); take(geom.b.xy); list(geom.b.s);
      digest.add(geom.group).add(geom.walls).add(geom.deckWalls ?? 0).add(geom.outer ? 1 : 0).add(geom.diagonal ?? 0).add(geom.plate ? 1 : 0);
      optional(geom.aLevels); optional(geom.bLevels);
      break;
    case 'fan':
      if (geom.ring.length < 6) return null;
      digest.add(geom.cx).add(geom.cy);
      take(geom.ring); list(geom.walls); digest.add(geom.plate ? 1 : 0);
      optional(geom.mouths); optional(geom.levels);
      break;
    case 'poly':
      if (geom.ring.length < 6) return null;
      take(geom.ring); list(geom.walls); digest.add(geom.plate ? 1 : 0);
      optional(geom.mouths); optional(geom.levels); optional(geom.deckWalls);
      digest.add(geom.kerb ?? -1).add(geom.kerbWidth ?? -1);
      break;
    case 'face':
      if (geom.run.s.length < 2) return null;
      take(geom.run.xy); list(geom.run.s);
      digest.add(geom.group).add(geom.left ? 1 : 0);
      optional(geom.levels); optional(geom.normals);
      break;
    case 'stations':
      if (geom.s.length === 0) return null;
      digest.add(geom.group); list(geom.s);
      // No place of its own: it moves no box.
      return { geom, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, digest: digest.value() };
    case 'walls':
      if (geom.edges.length < 4) return null;
      take(geom.edges);
      break;
  }
  return { geom, minX, minY, maxX, maxY, digest: digest.value() };
}

/** What one part of a piece is meshed from (`pieceMesh.ts`): its shapes by surface (`slotOf`), in the walk's order. */
export type PieceReach = ReadonlyMap<string, readonly Geom[]>;

/** Whether a shape has points some level leaves out (`atLevel`): a junction's, whose kerb returns are drawn coarser far away. */
export function levelled(g: Geom): boolean {
  switch (g.kind) {
    case 'strip': return !!(g.aLevels || g.bLevels);
    case 'fan': case 'poly': case 'face': return !!g.levels;
    default: return false;
  }
}

/** The indices of the points a level keeps (`levels[i] >= level`), every one without tags. */
function kept(count: number, levels: Uint8Array | undefined, level: PieceLevel): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (!levels || levels[i]! >= level) out.push(i);
  return out;
}

/** A chain's points at `keep`. */
function chainOf(c: Chain, keep: readonly number[]): Chain {
  const xy = new Float64Array(keep.length * 2), s = new Float64Array(keep.length);
  keep.forEach((k, n) => { xy[n * 2] = c.xy[k * 2]!; xy[n * 2 + 1] = c.xy[k * 2 + 1]!; s[n] = c.s[k]!; });
  return { xy, s };
}

/** Pairs at `keep` (x, y a point). */
const pairsOf = (values: Float64Array, keep: readonly number[]): Float64Array => {
  const out = new Float64Array(keep.length * 2);
  keep.forEach((k, n) => { out[n * 2] = values[k * 2]!; out[n * 2 + 1] = values[k * 2 + 1]!; });
  return out;
};

/** One flag a point at `keep`: the edge from a kept point to the next kept one takes the flag of the edge from that point (the points a level leaves
 *  out lie inside one run of a junction's outline, whose edges carry one flag). */
const flagsOf = (flags: Uint8Array, keep: readonly number[]): Uint8Array => Uint8Array.from(keep.map((k) => flags[k]!));

/** A shape at a level (`PieceLevel`): the points tagged that level or coarser (`Geom` levels), the rest of it as it is; the shape itself when it carries
 *  no tags; null where too few points are left to draw. */
export function atLevel(g: Geom, level: PieceLevel): Geom | null {
  if (level === 0 || !levelled(g)) return g;
  switch (g.kind) {
    case 'strip': {
      const ka = kept(g.a.s.length, g.aLevels, level), kb = kept(g.b.s.length, g.bLevels, level);
      if (ka.length < 2 || kb.length < 2) return null;
      const { aLevels: _a, bLevels: _b, ...rest } = g;
      return { ...rest, a: chainOf(g.a, ka), b: chainOf(g.b, kb) };
    }
    case 'fan':
    case 'poly': {
      const keep = kept(g.ring.length / 2, g.levels, level);
      if (keep.length < 3) return null;
      const base = { ring: pairsOf(g.ring, keep), walls: flagsOf(g.walls, keep), ...(g.mouths ? { mouths: flagsOf(g.mouths, keep) } : {}), ...(g.plate ? { plate: true as const } : {}) };
      if (g.kind === 'fan') return { kind: 'fan', cx: g.cx, cy: g.cy, ...base };
      return {
        kind: 'poly', ...base, ...(g.deckWalls ? { deckWalls: flagsOf(g.deckWalls, keep) } : {}),
        ...(g.kerb !== undefined ? { kerb: keep.filter((k) => k < g.kerb!).length } : {}), ...(g.kerbWidth !== undefined ? { kerbWidth: g.kerbWidth } : {}),
      };
    }
    case 'face': {
      const keep = kept(g.run.s.length, g.levels, level);
      if (keep.length < 2) return null;
      return { kind: 'face', run: chainOf(g.run, keep), group: g.group, ...(g.left ? { left: true as const } : {}), ...(g.normals ? { normals: pairsOf(g.normals, keep) } : {}) };
    }
    default:
      return g;
  }
}
