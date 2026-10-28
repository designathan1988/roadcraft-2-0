import { cellHeight } from '@world/groundPatch';

/** HOW FAR EACH LEVEL OF A TERRAIN PLATE STANDS OFF ITS FULL GROUND (CDLOD's quadtree, `terrainLod.ts`): no three.js, the plate's worker reads it too */

/** Cells along a patch, the one grid a plate instances; a quadtree node is 2 x 2 patches, so its grid is even and its odd corners morph onto even ones.
 *  The root, a node of `LOD_NODE` x 2^(LOD_LEVELS - 1) = 512 cells, holds the plate (200 cells, `terrainGrid.ts`) from its low corner and reaches past its
 *  far edges, as CDLOD lays a raster of any size ([Strugar](https://github.com/fstrugar/CDLOD): `CDLODQuadTree.cpp` counts the nodes by ceiling
 *  division and makes no child past the raster; `CDLODTerrain.vsh` getBaseVertexPos clamps a vertex onto its edge): a node or a patch wholly past the
 *  plate is never measured or drawn, one across its edge is drawn clamped onto it (`terrainLod.ts`). The level-0 patches tile the plate (200 = 25 x 8),
 *  so its cut cells are cut patch by patch (`terrainSeams.ts`). */
export const LOD_PATCH = 8;
/** Levels: 0 reads every corner of the plate, each next level every other corner of the one before. The last, the root of 512 cells, draws the whole
 *  plate as ONE patch (its first quarter, 256 cells at a step of 32; the other three past the plate, none): 128 triangles where a plate far off
 *  spans a few pixels. DO NOT stop at the 256-cell root: its four quarters were the coarsest a plate could be, 512 ground and 256 rim triangles
 *  drawn a few tenths of a pixel across at the horizon (the F7 audit, MISSION.md 3b). */
export const LOD_LEVELS = 6;
/** Cells along a node of level 0. */
export const LOD_NODE = 2 * LOD_PATCH;

/** Nodes along a side at each level: the last one may reach past the plate's far edge. */
function nodesAt(seg: number, level: number): number {
  return Math.ceil(seg / (LOD_NODE << level));
}

/** Each node's lowest and highest corner and how far its level stands off the plate's full ground, per level (`[lo, hi, err]` a node) */
export class LandLevels {
  /** Level 0's nodes first, then each next level's: `[lo, hi, err]` a node. */
  readonly data: Float32Array;
  /** The plate's worst error at each level (metres), as `measure` left it. */
  readonly worst = new Float64Array(LOD_LEVELS);
  /** How far the cut cells' terrain (`terrainSeams.ts`) stands off the grid in each node of level 0 (metres): level 0 draws it, every coarser level
   *  draws the grid, so each is off by it besides its own parting (`measure`). */
  readonly seams: Float32Array;
  /** Moves whenever the nodes' bounds and errors are written (`take`, `measure`): what a selection of the patches was made with (`LandLod.select`). */
  version = 0;
  private readonly first: number[] = [];
  private readonly dirty: Uint8Array[] = [];
  private readonly seg: number;
  private readonly n: number;

  constructor(seg: number) {
    if (seg % LOD_PATCH !== 0 || nodesAt(seg, LOD_LEVELS - 1) !== 1) {
      throw new Error(`a plate of ${seg} cells is not whole patches of ${LOD_PATCH} cells under one root of ${LOD_NODE << (LOD_LEVELS - 1)}`);
    }
    this.seg = seg;
    this.n = seg + 1;
    let count = 0;
    for (let level = 0; level < LOD_LEVELS; level++) {
      this.first.push(count);
      const side = nodesAt(seg, level);
      count += side * side;
      this.dirty.push(new Uint8Array(side * side));
    }
    this.data = new Float32Array(count * 3);
    this.seams = new Float32Array(nodesAt(seg, 0) ** 2);
  }

  /** The cut cells' errors (`terrainSeams.ts`, a cell each, `ix + iy * seg`; null: none cut) as each node of level 0's worst, the nodes whose worst
   *  changed marked to be measured again. */
  setSeams(cells: ArrayLike<number> | null, errors: ArrayLike<number> | null): void {
    const side = nodesAt(this.seg, 0);
    const next = new Float32Array(side * side);
    if (cells && errors) {
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k]!, ix = c % this.seg, iy = (c - ix) / this.seg;
        const node = Math.floor(ix / LOD_NODE) + Math.floor(iy / LOD_NODE) * side;
        if (errors[k]! > next[node]!) next[node] = errors[k]!;
      }
    }
    for (let k = 0; k < next.length; k++) {
      if (next[k] === this.seams[k]) continue;
      this.seams[k] = next[k]!;
      this.dirty[0]![k] = 1;
    }
  }

  /** The nodes as measured elsewhere (the plate's worker, `plateMesh.ts`), every mark cleared. */
  take(data: Float32Array): void {
    this.version++;
    this.data.set(data);
    for (const d of this.dirty) d.fill(0);
    this.sumUp();
  }

  /** The node's lowest corner, highest corner and error. */
  lo(level: number, nx: number, ny: number): number { return this.data[(this.first[level]! + nx + ny * nodesAt(this.seg, level)) * 3]!; }
  hi(level: number, nx: number, ny: number): number { return this.data[(this.first[level]! + nx + ny * nodesAt(this.seg, level)) * 3 + 1]!; }

  /** The nodes holding a box of corners or the cells round it (their diagonals follow those corners) marked to be measured again. */
  markBox(x0: number, x1: number, y0: number, y1: number): void {
    const side = nodesAt(this.seg, 0);
    const nx0 = Math.max(0, Math.floor((x0 - 1) / LOD_NODE)), nx1 = Math.min(side - 1, Math.floor((x1 + 1) / LOD_NODE));
    const ny0 = Math.max(0, Math.floor((y0 - 1) / LOD_NODE)), ny1 = Math.min(side - 1, Math.floor((y1 + 1) / LOD_NODE));
    for (let ny = ny0; ny <= ny1; ny++) for (let nx = nx0; nx <= nx1; nx++) this.dirty[0]![nx + ny * side] = 1;
  }

  /** The nodes holding corner `i` marked to be measured again. */
  markCorner(i: number): void {
    const ix = i % this.n, iy = (i - ix) / this.n;
    this.markBox(ix, ix, iy, iy);
  }

  /** Every node marked. */
  markAll(): void {
    for (const d of this.dirty) d.fill(1);
  }

  /** The marked nodes measured again from the drawn corners and diagonals, and each level's worst error with them. */
  measure(heights: ArrayLike<number>, flip: ArrayLike<number>): void {
    this.version++;
    const n = this.n;
    for (let level = 0; level < LOD_LEVELS; level++) {
      const side = nodesAt(this.seg, level);
      const span = LOD_NODE << level;
      const marks = this.dirty[level]!;
      const up = level + 1 < LOD_LEVELS ? this.dirty[level + 1]! : null;
      // The parents' side: a side of an odd count of nodes has a last parent of one child (the root reaches past the plate).
      const upSide = nodesAt(this.seg, level + 1);
      for (let ny = 0; ny < side; ny++) {
        for (let nx = 0; nx < side; nx++) {
          const k = nx + ny * side;
          if (!marks[k]) continue;
          marks[k] = 0;
          if (up) up[(nx >> 1) + (ny >> 1) * upSide] = 1;
          const o = (this.first[level]! + k) * 3;
          if (level === 0) {
            let lo = Infinity, hi = -Infinity;
            // Its corners on the plate: a node across the far edge holds the corners up to it.
            for (let j = ny * span; j <= Math.min((ny + 1) * span, this.seg); j++) {
              for (let i = nx * span; i <= Math.min((nx + 1) * span, this.seg); i++) {
                const h = heights[i + j * n] as number;
                if (h < lo) lo = h;
                if (h > hi) hi = h;
              }
            }
            this.data[o] = lo; this.data[o + 1] = hi; this.data[o + 2] = this.seams[k]!;
            continue;
          }
          // A node's error: its children's worst and how far its own level parts from theirs (the triangle inequality); a child wholly past the plate is none.
          let lo = Infinity, hi = -Infinity, err = 0;
          const below = this.first[level - 1]!, belowSide = nodesAt(this.seg, level - 1);
          for (let q = 0; q < 4; q++) {
            const cx = nx * 2 + (q & 1), cy = ny * 2 + (q >> 1);
            if (cx >= belowSide || cy >= belowSide) continue;
            const c = (below + cx + cy * belowSide) * 3;
            lo = Math.min(lo, this.data[c]!); hi = Math.max(hi, this.data[c + 1]!); err = Math.max(err, this.data[c + 2]!);
          }
          this.data[o] = lo; this.data[o + 1] = hi;
          this.data[o + 2] = err + parting(heights, flip, n, this.seg, level, nx * span, ny * span, span);
        }
      }
    }
    this.sumUp();
  }

  /** Each level's worst error over its nodes. */
  private sumUp(): void {
    for (let level = 0; level < LOD_LEVELS; level++) {
      const side = nodesAt(this.seg, level);
      let worst = 0;
      for (let k = 0; k < side * side; k++) worst = Math.max(worst, this.data[(this.first[level]! + k) * 3 + 2]!);
      this.worst[level] = worst;
    }
  }
}

/** The height range of a cell of `step` corners at a point of it (corner units), over both its diagonals: the shader picks one by its own floats. A cell
 *  across the plate's far edge is drawn from its corners clamped onto the edge (`terrainLod.ts` landCorner): it spans up to the edge. */
function coarseRange(h: ArrayLike<number>, n: number, seg: number, step: number, x: number, y: number, out: { lo: number; hi: number }): void {
  const last = Math.ceil(seg / step) - 1;
  const cx = Math.min(last, Math.floor(x / step)), cy = Math.min(last, Math.floor(y / step));
  const x0 = cx * step, y0 = cy * step, x1 = Math.min(x0 + step, seg), y1 = Math.min(y0 + step, seg);
  const u = (x - x0) / (x1 - x0), v = (y - y0) / (y1 - y0);
  const a = h[x0 + y0 * n] as number, b = h[x0 + y1 * n] as number;
  const c = h[x1 + y1 * n] as number, d = h[x1 + y0 * n] as number;
  const p = cellHeight(a, b, c, d, u, v, 0), q = cellHeight(a, b, c, d, u, v, 1);
  out.lo = Math.min(p, q); out.hi = Math.max(p, q);
}

const fineAt = { lo: 0, hi: 0 };
const coarseAt = { lo: 0, hi: 0 };
/** How far level `level` parts from level `level - 1` over a node: read at the finer level's corners and cell centres, where two piecewise-planar grounds
 *  part most. The node's corners on the plate alone, a finer cell across its far edge up to it (as `coarseRange`). */
function parting(h: ArrayLike<number>, flip: ArrayLike<number>, n: number, seg: number, level: number, x0: number, y0: number, span: number): number {
  const s = 1 << (level - 1), coarse = s << 1;
  const xEnd = Math.min(x0 + span, seg), yEnd = Math.min(y0 + span, seg);
  let most = 0;
  const take = (x: number, y: number): void => {
    coarseRange(h, n, seg, coarse, x, y, coarseAt);
    most = Math.max(most, coarseAt.hi - fineAt.lo, fineAt.hi - coarseAt.lo);
  };
  for (let y = y0; ; y = Math.min(y + s, yEnd)) {
    for (let x = x0; ; x = Math.min(x + s, xEnd)) {
      fineAt.lo = fineAt.hi = h[x + y * n] as number;
      take(x, y);
      if (x < xEnd && y < yEnd) {
        // The finer cell's centre: its own diagonal at level 0, either one above.
        const x1 = Math.min(x + s, seg), y1 = Math.min(y + s, seg);
        const a = h[x + y * n] as number, b = h[x + y1 * n] as number, c = h[x1 + y1 * n] as number, d = h[x1 + y * n] as number;
        if (s === 1) fineAt.lo = fineAt.hi = cellHeight(a, b, c, d, 0.5, 0.5, flip[x + y * seg] as number);
        else { fineAt.lo = Math.min(a + c, b + d) / 2; fineAt.hi = Math.max(a + c, b + d) / 2; }
        take((x + x1) / 2, (y + y1) / 2);
      }
      if (x >= xEnd) break;
    }
    if (y >= yEnd) break;
  }
  return most;
}
