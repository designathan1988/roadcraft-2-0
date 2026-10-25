import { describe, expect, it } from 'vitest';
import { GRID_CELL } from '@world/grid';
import { CELL } from '@world/cells';
import { TILE, tileIJ } from '@world/tiles';
import { PLATE_SIZE, plateIJ, plateRegion, plateOf } from '@world/bounds';
import { MAP_HALF, MAP_TILES } from '@world/cityGen/mapSize';
import { tileOnMap } from '@world/cityGen/wholeMap';
import { CELL as ROAD_BLOCK, CHUNK, TILE as ROAD_PIECE } from '@render/roadSurfaceEntries';
import { TERRAIN_CELL, TERRAIN_SEGMENTS } from '@render/terrainGrid';
import { DETAIL_CELL, SIDE } from '@render/buildings/partFiling';
import { KEEP_CELL } from '@render/candidateKeep';
import { SAVE_TILE } from '@editor/chunkedSave';

/** EVERY DIVISION OF THE WORLD IS A ROUND MULTIPLE OF 10 m, EACH NESTED IN THE NEXT (the owner's decision, 2026-10-24) */
describe('the world\'s scales', () => {
  const scales: readonly (readonly [string, number])[] = [
    ['grid cell', GRID_CELL], ['road piece', ROAD_PIECE], ['road block', ROAD_BLOCK], ['cell', CELL], ['tile', TILE], ['plate', PLATE_SIZE],
    ['terrain cell', TERRAIN_CELL], ['detail cell', DETAIL_CELL], ['keep cell', KEEP_CELL], ['save square', SAVE_TILE], ['map', 2 * MAP_HALF],
  ];

  it('are the owner\'s sizes', () => {
    expect([GRID_CELL, ROAD_PIECE, ROAD_BLOCK, CELL, TILE, PLATE_SIZE, MAP_TILES, 2 * MAP_HALF]).toEqual([10, 100, 500, 250, 1_000, 2_000, 20, 20_000]);
  });

  it('are each a whole number of the universal grid\'s cells', () => {
    for (const [name, size] of scales) expect(size % GRID_CELL, name).toBe(0);
    expect(TERRAIN_CELL).toBe(GRID_CELL);
  });

  it('nest: 100 m pieces in a 500 m block, 2 x 2 blocks a 1,000 m tile, 4 x 4 cells of 250 m a tile, 2 x 2 tiles a plate, 20 tiles the map', () => {
    expect(ROAD_BLOCK).toBe(ROAD_PIECE * CHUNK);
    expect(CHUNK).toBe(5);
    expect(TILE / ROAD_BLOCK).toBe(2);
    expect(TILE / CELL).toBe(4);
    expect(PLATE_SIZE / TILE).toBe(2);
    expect(PLATE_SIZE / CELL).toBe(8);
    expect(TERRAIN_SEGMENTS * TERRAIN_CELL).toBe(PLATE_SIZE);
    expect(SIDE * DETAIL_CELL).toBe(CELL);
    expect(CELL % KEEP_CELL).toBe(0);
    expect(SAVE_TILE).toBe(TILE);
    expect(2 * MAP_HALF).toBe(MAP_TILES * TILE);
  });

  it('lay their edges on multiples of their sides from the origin: a tile and a plate start where their side divides the place', () => {
    for (const v of [0, 1, 999.5, 1_000, -0.5, -1_000, 1_999.9, 2_000, -2_000.1, 12_345]) {
      const { i, j } = tileIJ(v, -v);
      expect(i).toBe(Math.floor(v / TILE));
      expect(j).toBe(Math.floor(-v / TILE));
      const { pi, pj } = plateIJ(v, -v);
      expect(pi).toBe(Math.floor(v / PLATE_SIZE));
      expect(pj).toBe(Math.floor(-v / PLATE_SIZE));
    }
    // A plate holds exactly 2 x 2 tiles: every tile in one plate, the plate's corner a tile's.
    for (let i = -6; i < 6; i++) {
      for (let j = -6; j < 6; j++) {
        const corners = [[i * TILE, j * TILE], [(i + 1) * TILE - 1e-6, j * TILE], [i * TILE, (j + 1) * TILE - 1e-6], [(i + 1) * TILE - 1e-6, (j + 1) * TILE - 1e-6]] as const;
        expect(new Set(corners.map(([x, y]) => plateOf(x, y))).size).toBe(1);
        const r = plateRegion(plateOf(i * TILE, j * TILE));
        expect((r.cx - r.half) % TILE === 0 && (r.cy - r.half) % TILE === 0).toBe(true);
      }
    }
  });

  it('end the map on the plates\' edges, a whole number of plates each way from the origin', () => {
    expect(MAP_TILES % 4).toBe(0);
    expect(MAP_HALF % PLATE_SIZE).toBe(0);
    // The map's first and last tiles each way, and the plates their edges lie on.
    expect(tileOnMap(-MAP_TILES / 2, -MAP_TILES / 2)).toBe(true);
    expect(tileOnMap(MAP_TILES / 2 - 1, MAP_TILES / 2 - 1)).toBe(true);
    expect(tileOnMap(MAP_TILES / 2, 0)).toBe(false);
    expect(tileOnMap(-MAP_TILES / 2 - 1, 0)).toBe(false);
    const sw = plateRegion(plateOf(-MAP_HALF, -MAP_HALF)), ne = plateRegion(plateOf(MAP_HALF - 1e-6, MAP_HALF - 1e-6));
    expect([sw.cx - sw.half, sw.cy - sw.half]).toEqual([-MAP_HALF, -MAP_HALF]);
    expect([ne.cx + ne.half, ne.cy + ne.half]).toEqual([MAP_HALF, MAP_HALF]);
  });
});
