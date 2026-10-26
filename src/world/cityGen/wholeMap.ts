import { MAP_HALF, MAP_TILES } from './mapSize';

/** THE MAP (the player's order, 2026-10-16): a square of `MAP_TILES` tiles each way round the origin, 20 km x 20 km, the city over the WHOLE of it; never a world without an edge. The size will be the player's choice. */
// The map's size (`mapSize.ts`): its tiles and half side, here for the rules' readers.
export { MAP_HALF } from './mapSize';
/** Whether tile (i, j) is on the map (-10..9 each way at 20). */
export const tileOnMap = (i: number, j: number): boolean => i >= -MAP_TILES / 2 && i < MAP_TILES / 2 && j >= -MAP_TILES / 2 && j < MAP_TILES / 2;
/** Whether a point is on the map. */
export const onMap = (x: number, y: number): boolean => x >= -MAP_HALF && x < MAP_HALF && y >= -MAP_HALF && y < MAP_HALF;
