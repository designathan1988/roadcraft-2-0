/** THE KEYS OF THE BUILDINGS' CELLS AND LEVELS: a cell "i,j", a 1,000 m tile "t:x,y", a 2,000 m plate "p:x,y" and the base over a plate's square "b:x,y" (`massBase.ts`) (`massLevels.ts`, `massCells.ts`, `cellPool.ts`); imports nothing, so each reads them without the others */

/** Cells a tile and a plate are on a side (`world/cells.ts` CELL, 250 m: 1,000 m and 2,000 m, `bounds.ts` PLATE_SIZE). */
export const TILE_CELLS = 4;
/** The plates' edges lie on the cells' origin and every eighth cell line after it (`bounds.ts`: plate (pi, pj) from (pi, pj) x PLATE_SIZE), as the
 *  tiles' on every fourth: each plate holds four whole tiles. */
const PLATE_CELLS = 8;

export type MassLevel = 'tile' | 'plate' | 'base';

/** The tile and the plate a cell (column, row) lies in, as keys ("t:x,y", "p:x,y"). */
export const tileOf = (i: number, j: number): string => `t:${Math.floor(i / TILE_CELLS)},${Math.floor(j / TILE_CELLS)}`;
export const plateOf = (i: number, j: number): string => `p:${Math.floor(i / PLATE_CELLS)},${Math.floor(j / PLATE_CELLS)}`;
/** The base (the top level, `massBase.ts`) a cell lies under: its plate's square. */
export const baseOf = (i: number, j: number): string => `b:${Math.floor(i / PLATE_CELLS)},${Math.floor(j / PLATE_CELLS)}`;

/** The square of the base a job's key stands in (`baseOf`), as "x,y": a cell's ("i,j"), a tile's, a plate's or a base's. The masses' jobs of
 *  a square go to the worker that ran its last (`cellPool.ts` affinityOf): each building's program walked there once for its every level. */
export function squareKeyOf(key: string): string {
  if (key[1] !== ':') { const [i, j] = cellIndex(key); return baseOf(i, j).slice(2); }
  if (key[0] !== 't') return key.slice(2);
  const { i0, j0 } = levelCells(key);
  return baseOf(i0, j0).slice(2);
}

/** A cell's column and row from its key ("i,j", `layer.ts` `cellOf`). */
export function cellIndex(key: string): readonly [number, number] {
  const comma = key.indexOf(',');
  return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
}

/** The cells a level's key covers: its first column and row and its side, in cells. */
export function levelCells(key: string): { readonly level: MassLevel; readonly i0: number; readonly j0: number; readonly n: number } {
  const comma = key.indexOf(',');
  const a = Number(key.slice(2, comma)), b = Number(key.slice(comma + 1));
  return key[0] === 't'
    ? { level: 'tile', i0: a * TILE_CELLS, j0: b * TILE_CELLS, n: TILE_CELLS }
    : { level: key[0] === 'b' ? 'base' : 'plate', i0: a * PLATE_CELLS, j0: b * PLATE_CELLS, n: PLATE_CELLS };
}
