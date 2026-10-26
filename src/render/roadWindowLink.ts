import type { RoadDoc } from '@world/doc';
import type { FarTileSource } from './networkFarRoads';

/**
 * THE PAGE'S NETWORK WINDOW AS THE RENDERER DRIVES IT (`world/networkWindow.ts`, owned by `main.ts` with the network): the tiles the view's
 * road cells want told to it each look (`want`), its moves stepped a frame between the builds (`step`: the network rebuilt to hold the tiles
 * that came, solved off the page), a cell built only once its tile is held (`holds`), the tiles a map opens with held at once (`ensureTiles`);
 * and who makes the map's far level off the page, tile by tile (`farLevel`, `networkFarRoads.ts`).
 */
export interface RoadWindowLink {
  want(tiles: ReadonlySet<number>): void;
  step(): boolean;
  holds(tile: number): boolean;
  ensureTiles(tiles: Iterable<number>): void;
  readonly farLevel: FarTileSource | null;
  /** A map opened, its first world being built (`renderer.ts` buildWorld): what its owner does off the page for it (a legacy map's repairs). */
  opened(doc: RoadDoc): void;
}
