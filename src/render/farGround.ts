import { PLATE_SIZE, plateOf } from '@world/bounds';

/**
 * THE FAR GROUND AS A QUADTREE BY DISTANCE (CDLOD, Strugar 2009: a quadtree of regular grids, each node drawn while the observer stands
 * past its level's range, the ranges growing with the level): level 0 a plate's patch, each level above a 2 x 2 of the one below drawn with
 * the same grid of quads, twice as coarse. DO NOT keep every plate of the map resident and drawn (100 plates of 20 km, 625 of 50 km, 10,000 of
 * 50 km): what is resident is what the view's distance asks, a few levels of rings round it, whatever the map's size.
 */

/** A node is split while the view is nearer its box than this many times its side: level 1's (from 2 x 2 plates down to the plates), and above it. DO NOT lower `SPLIT_PLATES` under 2 sqrt 2 (a map of 6 x 6 plates' farthest 2 x 2 from its corner, 4 sqrt 2 plates off): within it every plate of a map of 6 x 6 plates (12 km) stays a plate's patch wherever the view stands (the ground seen as before). */
export const SPLIT_PLATES = 3;
export const SPLIT_ABOVE = 2;

/** One node of the far ground chosen for the view: its level, its key, its square (world units; clipped to the map's ring where it passes it), its quads' step and how many of its quads lie on the map each way. */
export interface FarNode {
  readonly key: string;
  readonly k: number;
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly quadsX: number;
  readonly quadsY: number;
  /** Level 0: the plate it is (`world/bounds.ts` `plateOf`); above: none. */
  readonly plate: number | null;
  /** Its edges (south, north, west, east) on the map ring's edge: no skirt there (the cut side stands there). */
  readonly rim: readonly [boolean, boolean, boolean, boolean];
}


/**
 * The nodes the far ground draws for a view standing over (x, y), each with `quads` quads a side, on the map of half side `half` round the origin
 * (`wholeMap.ts` MAP_HALF: whole plates each way, its edge on the plates' edges, `world/bounds.ts`): from the root (the smallest square of plates
 * holding the map, from its south-west corner) down while the view is nearer than its split. Never more than the levels of the map times a ring
 * of nodes each: the same count for any map the view stands in the middle of.
 */
export function farNodesFor(x: number, y: number, half: number, quads: number): FarNode[] {
  const extent = half;
  if (half <= 0 || half % PLATE_SIZE !== 0) throw new Error(`a map of half side ${half} does not end on the plates' edges (${PLATE_SIZE})`);
  const across = (2 * half) / PLATE_SIZE;
  let top = 0;
  while (1 << top < across) top++;
  const out: FarNode[] = [];
  const visit = (k: number, a: number, b: number): void => {
    const side = PLATE_SIZE * (1 << k);
    const x0 = -extent + a * side, y0 = -extent + b * side;
    if (x0 >= extent - 1e-6 || y0 >= extent - 1e-6) return;
    const x1 = Math.min(x0 + side, extent), y1 = Math.min(y0 + side, extent);
    const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
    if (k > 0 && Math.hypot(dx, dy) < (k === 1 ? SPLIT_PLATES : SPLIT_ABOVE) * side) {
      for (let q = 0; q < 4; q++) visit(k - 1, a * 2 + (q & 1), b * 2 + (q >> 1));
      return;
    }
    const step = side / quads;
    out.push({
      key: `${k}:${a}:${b}`, k, x0, y0, step,
      quadsX: Math.round((x1 - x0) / step), quadsY: Math.round((y1 - y0) / step),
      plate: k === 0 ? plateOf(x0 + side / 2, y0 + side / 2) : null,
      rim: [y0 <= -extent + 1e-6, y1 >= extent - 1e-6, x0 <= -extent + 1e-6, x1 >= extent - 1e-6],
    });
  };
  visit(top, 0, 0);
  return out;
}

/**
 * A FAR PATCH DRAWN AT THE STRIDE ITS RELIEF ALLOWS: its grid of `quads` quads a side drawn every `stride`-th corner (1, 2, 4... `quads`), the
 * coarsest whose height strays from the full grid's by under `FAR_ERROR_PX` on the screen where the patch stands nearest the eye (Ulrich's
 * chunked LOD screen-space error; the near plates' own rule, `terrainLod.ts` LOD_PIXELS). A flat patch is two triangles: DO NOT draw every far
 * patch at its full grid whatever its relief (a plain's 2,048 triangles a patch, 240 k of the district's view, the F7 audit, 2026-10-25). The
 * coarse quads are unions of the full grid's (the same diagonal, corner (1, 0) to (0, 1)): the surfaces differ most at the full grid's corners,
 * where the error is measured. Its skirts hide the seams with a neighbour drawn at another stride.
 */

/** Whether the far patches take the stride their relief allows (the lab's "Optimisations", `optimizations.ts` farStride: the game as it draws,
 *  on); off, every patch at its full grid, as before the strides. */
export const farStrides = { byRelief: true };

/** Strides a patch may be drawn at: 1, 2, 4, 8, 16, 32 (`FAR_QUADS`). */
export const FAR_STRIDES = 6;
/** Pixels a far patch's stride may stray on the screen: half the near plates' (`terrainLod.ts` LOD_PIXELS 1). */
export const FAR_ERROR_PX = 0.5;
/** A stride is left for a coarser one only under this share of its bound, and taken back at the whole of it: no stride flickering at its edge. */
const FAR_COARSEN = 0.8;

/**
 * The most each stride's surface strays from the full grid's (height, world units), into `out` from `at` (stride 1 first, its 0): from the grid's
 * heights `h`, `side` corners a row, the corner (i, j) at `h[(j + pad) * side + i + pad]`, `quads` quads a side.
 */
export function strideErrorsInto(out: Float32Array, at: number, h: ArrayLike<number>, side: number, pad: number, quads: number): void {
  const H = (i: number, j: number): number => h[(j + pad) * side + i + pad]!;
  out[at] = 0;
  for (let p = 1; p < FAR_STRIDES; p++) {
    const s = 1 << p;
    let worst = 0;
    if (s <= quads) {
      for (let j = 0; j <= quads; j++) {
        const cj = Math.min(Math.floor(j / s) * s, quads - s), v = (j - cj) / s;
        for (let i = 0; i <= quads; i++) {
          const ci = Math.min(Math.floor(i / s) * s, quads - s), u = (i - ci) / s;
          const h00 = H(ci, cj), h10 = H(ci + s, cj), h01 = H(ci, cj + s), h11 = H(ci + s, cj + s);
          // The quad's two triangles: (00, 10, 01) and (10, 11, 01), split along 10-01.
          const drawn = u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
          worst = Math.max(worst, Math.abs(H(i, j) - drawn));
        }
      }
    } else worst = Infinity;
    out[at + p] = worst;
  }
}

/**
 * The stride a patch is drawn at: the coarsest whose error (`errors` from `at`, `strideErrorsInto`) spans under `FAR_ERROR_PX` where its box
 * stands nearest the eye, `pixelsAt(distance)` the pixels a world unit spans there, and that divides its quads on the map each way (a patch the
 * map's edge cuts); `held`, the stride it was drawn at, kept up to its bound.
 */
export function strideFor(errors: ArrayLike<number>, at: number, pixels: number, quadsX: number, quadsY: number, held: number): number {
  let stride = 1;
  if (!farStrides.byRelief) return stride;
  for (let p = 1; p < FAR_STRIDES; p++) {
    const s = 1 << p;
    if (quadsX % s !== 0 || quadsY % s !== 0) break;
    if (errors[at + p]! * pixels <= FAR_ERROR_PX * (s <= held ? 1 : FAR_COARSEN)) stride = s;
  }
  return stride;
}
