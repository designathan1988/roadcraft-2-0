import { describe, expect, it } from 'vitest';

import { CELL, byPart, cellOfPart, cellRectOfPart, ownedPart, partKey, pieceKey, pieceOfPart } from '@render/roadSurfaceEntries';
import { WORLD_REACH, tileIdBase, tileKey } from '@world/tiles';

/** The tiles' reach each way (`world/tiles.ts` TILE_REACH): keys from the lowest corner to the highest. */
const REACH = 1 << 15;
/** A tile's range of ids (`world/tiles.ts` TILE_IDS). */
const TILE_IDS = 1 << 19;
/** The blocks of the world's reach each way. */
const CELL_REACH = Math.ceil(WORLD_REACH / CELL);

const LOW = tileIdBase(tileKey(-REACH, -REACH));
const HIGH = tileIdBase(tileKey(REACH - 1, REACH - 1)) + TILE_IDS - 1;
/** Ids a world hands out: before the tiles, the first and last of a tile's range at both corners of the world, and the last safe integer. */
const IDS = [0, 1, 2 ** 20 - 1, LOW, LOW + 1, tileIdBase(tileKey(0, 0)), tileIdBase(tileKey(0, 0)) + TILE_IDS - 1, HIGH - 1, HIGH, Number.MAX_SAFE_INTEGER];
const CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [-1, -1], [1, -1], [-1, 1], [-CELL_REACH, -CELL_REACH], [CELL_REACH - 1, CELL_REACH - 1], [-CELL_REACH, CELL_REACH - 1], [-2048, -2048], [2047, 2047], [-2049, 2048],
];

describe('a road surface part key', () => {
  it('names the ids of the extreme tiles exactly', () => {
    expect(Number.isSafeInteger(HIGH)).toBe(true);
    expect(LOW).toBe(2 ** 52 + 2 ** 20);
  });

  it('gives back its piece and its block, for every id and block at the ends of the range', () => {
    for (const id of IDS) {
      for (const kind of ['segment', 'node'] as const) {
        for (const [cx, cy] of CELLS) {
          const key = partKey(pieceKey(kind, id), cx, cy);
          expect(pieceOfPart(key)).toEqual({ kind, id });
          expect(cellOfPart(key)).toEqual([cx, cy]);
          expect(cellRectOfPart(key)).toEqual([cx * CELL, cy * CELL, (cx + 1) * CELL, (cy + 1) * CELL]);
        }
      }
    }
  });

  it('never makes a node and a road, nor ids one apart, nor blocks one apart, one key', () => {
    const seen = new Map<string, string>();
    for (const base of IDS) {
      for (const id of [base - 1, base, base + 1]) {
        if (!Number.isSafeInteger(id) || id < 0) continue;
        for (const kind of ['segment', 'node'] as const) {
          for (const [cx, cy] of [...CELLS, ...CELLS.map(([x, y]) => [x + 1, y] as const), ...CELLS.map(([x, y]) => [x, y + 1] as const)]) {
            if (Math.abs(cx) >= 2 ** 23 || Math.abs(cy) >= 2 ** 23) continue;
            const key = partKey(pieceKey(kind, id), cx, cy);
            const what = `${kind} ${id} at ${cx},${cy}`;
            const before = seen.get(key);
            if (before !== undefined) expect(before).toBe(what);
            seen.set(key, what);
          }
        }
      }
    }
    expect(pieceKey('node', LOW)).not.toBe(pieceKey('segment', LOW + 1));
    expect(pieceKey('node', LOW)).not.toBe(pieceKey('segment', LOW));
  });

  it('sorts by id, a road before a junction of the same id, then by column and row', () => {
    const keys = [
      partKey(pieceKey('node', HIGH), 0, 0),
      partKey(pieceKey('segment', HIGH), 5, -3),
      partKey(pieceKey('segment', HIGH), -5, 3),
      partKey(pieceKey('segment', HIGH), -5, -3),
      partKey(pieceKey('node', LOW), CELL_REACH - 1, 0),
      partKey(pieceKey('segment', LOW + 1), -CELL_REACH, 0),
      partKey(pieceKey('segment', 7), 0, 0),
    ];
    const order = [...keys].sort(byPart).map((key) => [pieceOfPart(key).id, pieceOfPart(key).kind, ...cellOfPart(key)]);
    expect(order).toEqual([
      [7, 'segment', 0, 0],
      [LOW, 'node', CELL_REACH - 1, 0],
      [LOW + 1, 'segment', -CELL_REACH, 0],
      [HIGH, 'segment', -5, -3],
      [HIGH, 'segment', -5, 3],
      [HIGH, 'segment', 5, -3],
      [HIGH, 'node', 0, 0],
    ]);
  });

  it('files a piece in the block its owner point lies in, at both ends of the world', () => {
    const near = WORLD_REACH - 1;
    expect(cellOfPart(ownedPart(pieceKey('segment', HIGH), { x: near, y: -near }))).toEqual([CELL_REACH - 1, -CELL_REACH]);
    expect(cellOfPart(ownedPart(pieceKey('node', LOW), { x: -CELL / 2, y: CELL / 2 }))).toEqual([-1, 0]);
  });

  it('refuses what it cannot name exactly', () => {
    expect(() => pieceKey('segment', 2 ** 53)).toThrow();
    expect(() => pieceKey('node', 1.5)).toThrow();
    expect(() => pieceKey('node', -1)).toThrow();
    expect(() => partKey(pieceKey('segment', 1), 2 ** 23, 0)).toThrow();
    expect(() => partKey(pieceKey('segment', 1), 0, 0.5)).toThrow();
  });
});
