import type { Filed, MarkPiece } from './roadMarks';
import type { RoadDoc } from '@world/doc';
import { FLAT_GROUND } from '@world/elevation';
import type { SegmentId } from '@world/ids';
import type { AlongPaint } from '@world/markings';
import { RELIEF_FLAT, TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import type { FarRoadCell } from './networkFarPieces';

export { farCellKey } from './networkFarPieces';

/**
 * WHAT THE NETWORK'S ROOT LEVEL HANDS THE PAGE (`networkFarTile.ts`, `networkFarRoads.ts`): a tile's cells made of the detail's own pieces
 * (`networkFarPieces.ts`), the paint of the roads it owns and their marks. The map's level is made off the page tile by tile, the page's network
 * holding the tiles near the view alone (`world/networkWindow.ts`); an edit's cells are made again from the page's network (`networkFarRoads.ts` refresh).
 */

/** A road's paint as the carriageway's shader reads it (`roadPaint.ts` set): its lines along it, its half width and its lane width; made off the page for every road of the map, written on the page when the level lands. */
export interface RoadPaintRecord {
  readonly id: SegmentId;
  readonly paint: AlongPaint | null;
  readonly half: number;
  readonly lane: number;
}

/** A TILE'S ROOT LEVEL (`networkFarTile.ts`): its cells, each carriageway vertex carrying its piece's id (`lookOf` ids), the paint of every road it owns. */
export interface FarLevel {
  readonly cell: number;
  readonly cells: readonly FarRoadCell[];
  readonly paints: readonly RoadPaintRecord[];
  /** The marks of the pieces the tile owns (`roadMarks.ts` nodeMarks, roadStrokes), each filed as `roadMarks.place` takes them: its crossings, stop
   *  lines, legends and arrows (none where the level was made from the page's network, `NetworkFarRoads.requestHere`). */
  readonly marks?: readonly FarMarks[];
}
/** A piece's marks as the far level places them (`NetworkFarRoads.followMarks`). */
export interface FarMarks {
  readonly source: MarkPiece;
  readonly into: readonly (readonly [MarkPiece, readonly Filed[]])[];
}

/** Whether a map's land is level: a new map's flat relief with no stamp (every station's ground the same, `FLAT_GROUND`). */
export const isLevelLand = (doc: RoadDoc): boolean => doc.terrainRelief === RELIEF_FLAT && doc.terrainStamps.length === 0;

/** The ground a network's solve reads off the page: level, or the land's stamps on their relief (`world/terrain.ts`). */
export function naturalGroundOf(doc: RoadDoc): (x: number, y: number) => number {
  if (isLevelLand(doc)) return FLAT_GROUND;
  // The index's revision is its caller's bookkeeping (`world/terrain.ts`): none here, the index read once.
  const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
  return (x, y) => sampleTerrainHeight(index, x, y);
}
