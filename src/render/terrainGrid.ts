import { PLATE_SIZE } from '@world/bounds';

/** THE TERRAIN PLATE'S GRID: its numbers alone, for the workers (`buildings/buildingMesh.ts`) that must not load the page's terrain (`terrain.ts`) and its pools */

/** Side of one terrain plate, in world units: the map is laid in square plates */
export const TERRAIN_SIZE = PLATE_SIZE;
/** Cells per side: 200 cells of 10 m (`world/bounds.ts` PLATE_SIZE), the universal grid's cell (`world/grid.ts` GRID_CELL): every corner on its lines.
 *  Where a footway's outer edge crosses a cell, the cell is drawn conformed to it (`terrainSeams.ts`). */
export const TERRAIN_SEGMENTS = 200;
/** World size of one terrain quad. */
export const TERRAIN_CELL = TERRAIN_SIZE / TERRAIN_SEGMENTS;
/** Half the terrain plate's extent. */
export const TERRAIN_HALF = TERRAIN_SIZE / 2;
