import { TILE } from '../tiles';

/** THE MAP'S SIZE, apart from the whole map's rules (`wholeMap.ts`): what the plan reads of it (`plan.ts`) without importing the rules that read
 *  the plan's own types back - DO NOT define them in `wholeMap.ts` again: `plan.ts` and `wholeMap.ts` imported each other. */
declare const __MAP_TILES__: number | undefined;
/** Set at build time (`vite.config.ts`, ROADCRAFT_MAP_TILES: the page and every worker read the same); 20 otherwise (20 km a side; the map centred on the origin, its edge on
 *  the 2,000 m plates' edges, so a multiple of 4 tiles of 1,000 m). */
export const MAP_TILES = typeof __MAP_TILES__ === 'number' ? __MAP_TILES__ : 20;
/** The map's half side, world units. */
export const MAP_HALF = (MAP_TILES / 2) * TILE;
