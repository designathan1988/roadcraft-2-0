import { describe, expect, it } from 'vitest';
import { DETAIL_CELL, LEAVES, SIDE, morton, shellHalf, shellPieceOf } from '@render/buildings/partFiling';
import { CELL } from '@world/cells';
import { GRID_CELL } from '@world/grid';

/** A CELL'S SUB-CELLS IN ONE ORDER, AND ITS SHELLS IN FOUR PIECES (`partFiling.ts`): five sub-cells of 50 m a side of a 250 m cell */
describe('the sub-cells of a cell', () => {
  it('are whole sub-cells of the universal grid, five a side', () => {
    expect(SIDE).toBe(5);
    expect(SIDE * DETAIL_CELL).toBe(CELL);
    expect(DETAIL_CELL % GRID_CELL).toBe(0);
  });

  it('take every place of the order once, 0 to 24', () => {
    const seen = new Set<number>();
    for (let v = 0; v < SIDE; v++) for (let u = 0; u < SIDE; u++) seen.add(morton(u, v));
    expect(seen.size).toBe(LEAVES);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(LEAVES - 1);
  });

  it('keep Morton\'s locality: the first 4 and 16 places are the 2 x 2 and 4 x 4 squares at the corner, a step of the order a short one', () => {
    const at: [number, number][] = [];
    for (let v = 0; v < SIDE; v++) for (let u = 0; u < SIDE; u++) at[morton(u, v)] = [u, v];
    for (const k of [4, 16]) {
      const side = Math.sqrt(k);
      for (let r = 0; r < k; r++) expect(at[r]![0] < side && at[r]![1] < side, `place ${r}`).toBe(true);
    }
    // The order steps to a neighbour (a side or a corner) most of the time, and never further than across the cell.
    let near = 0;
    for (let r = 0; r + 1 < LEAVES; r++) {
      const d = Math.max(Math.abs(at[r]![0] - at[r + 1]![0]), Math.abs(at[r]![1] - at[r + 1]![1]));
      if (d === 1) near++;
      expect(d).toBeLessThan(SIDE);
    }
    expect(near / (LEAVES - 1)).toBeGreaterThan(0.6);
  });
});

describe('the shells\' pieces of a cell', () => {
  it('are four a cell, each whole sub-cells (150 m and 100 m a side), no piece shared by two cells', () => {
    const cellsOfPiece = new Map<string, string>();
    for (const [ci, cj] of [[0, 0], [1, 0], [-1, 2], [-3, -4]] as const) {
      const pieces = new Map<string, [number, number, number, number]>();
      // Every metre of the cell: its piece, and each piece's box.
      for (let y = cj * CELL + 0.5; y < (cj + 1) * CELL; y += 1) {
        for (let x = ci * CELL + 0.5; x < (ci + 1) * CELL; x += 1) {
          const key = shellPieceOf(x, y);
          const was = cellsOfPiece.get(key);
          expect(was === undefined || was === `${ci},${cj}`, `piece ${key} in two cells`).toBe(true);
          cellsOfPiece.set(key, `${ci},${cj}`);
          const box = pieces.get(key) ?? [Infinity, Infinity, -Infinity, -Infinity];
          pieces.set(key, [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]);
        }
      }
      expect(pieces.size).toBe(4);
      const sides = [...pieces.values()].map((b) => [Math.round(b[2] - b[0] + 1), Math.round(b[3] - b[1] + 1)].sort((a, b) => a - b).join('x')).sort();
      expect(sides).toEqual(['100x100', '100x150', '100x150', '150x150']);
      // Each piece's edges on the sub-cells' lines: its area the cell's share of whole sub-cells, the four together the cell once.
      let area = 0;
      for (const b of pieces.values()) area += Math.round(b[2] - b[0] + 1) * Math.round(b[3] - b[1] + 1);
      expect(area).toBe(CELL * CELL);
    }
  });

  it('split a cell where its sub-cells split: the lower half three of the five', () => {
    expect([0, 1, 2, 3, 4].map((s) => shellHalf(s * DETAIL_CELL + 1))).toEqual([0, 0, 0, 1, 1]);
    expect(shellHalf(CELL + 1)).toBe(2);
    expect(shellHalf(-1)).toBe(-1);
  });
});
