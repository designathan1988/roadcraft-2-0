/**
 * The part of Constrainautor 4.1 (`@kninnug/constrainautor`, ISC, https://github.com/kninnug/Constrainautor) the terrain's cut cells use
 * (`terrainSeams.ts`), as its README documents it. Its package's types are its TypeScript source, which the project's flags
 * (`noUncheckedIndexedAccess`) do not pass: `tsconfig.json` `paths` reads this in its place; the code run is the package's own (`lib/`).
 */

/** A triangulation as Delaunator 5 leaves it (`delaunator`), changed in place by the constraining. */
export interface DelaunatorLike {
  readonly coords: ArrayLike<number>;
  triangles: Uint32Array;
  halfedges: Int32Array;
  hull: Uint32Array;
}

export default class Constrainautor {
  /** The triangulation constrained, in place; `edges` (pairs of point indices) constrained at once (`constrainAll`). */
  constructor(del: DelaunatorLike, edges?: readonly (readonly [number, number])[]);
  readonly del: DelaunatorLike;
  /** Ensures an edge between points `p1` and `p2`: the half-edge from p1 to p2, or the negative of the one from p2 to p1. */
  constrainOne(p1: number, p2: number): number;
  constrainAll(edges: readonly (readonly [number, number])[]): this;
  delaunify(deep?: boolean): this;
  isConstrained(edge: number): boolean;
  findEdge(p1: number, p2: number): number;
  /** Points Delaunator left out (two too near to tell apart): an edge between one of them throws. */
  untriangulatedPoints(): number[];
}
