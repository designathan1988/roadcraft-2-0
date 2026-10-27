import type { ChangeRect } from '@world/changes';
import type { TableReader } from '@world/buildings/recordTable';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import type { LandscapeItem } from '@world/landscape';
import { Network } from '@world/network';
import { type FieldData, fieldOf } from '@world/roadField';
import type { SegmentId } from '@world/ids';
import { METERS_PER_UNIT } from '@world/units';
import type { JobScope } from '../jobs/jobScope';
import { type BuildingRows, rowRecords } from './buildings/rowRefs';
import { type FurniturePlace, type LampLens, furniturePlace, isFurniture, packPlaces } from './furniturePlace';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';

/**
 * THE STREET FURNITURE ABOUT A RECTANGLE PLACED OFF THE PAGE (`streetFurnitureLayer.ts` furnitureJobAsk): the items read where the map's
 * landscaping table holds them (`rowRefs.ts`), the roads round them solved here as the page's network solves a tile's (`roadBake.worker.ts`:
 * its roads and every road at their ends, so each of their junctions is the whole network's), their heights the page's solve's (`fieldFor`),
 * each item placed (`furniturePlace`, the page's own code) and its instances handed back as numbers (`packPlaces`).
 */

export interface FurnitureCellAsk extends BuildingRows {
  readonly id: number;
  /** The items' rectangle: those standing in it are placed. */
  readonly rect: ChangeRect;
  /** The roads round it: their records, and those of their nodes. */
  readonly nodes: SerializedDoc['nodes'];
  readonly segments: SerializedDoc['segments'];
  readonly markingStyle: string;
  readonly scope: readonly SegmentId[];
  /** The roads' heights as the page's solve has them (`RoadElevation.fieldFor`). */
  readonly field: FieldData;
  /** The ground the solve read where no road's profile answers: level land's (0), or the natural ground of the shared plates. */
  readonly level: boolean;
  readonly ground: SharedGroundData | null;
  readonly lens: LampLens;
}
export type FurnitureCellReply = { readonly id: number; readonly places: Float64Array } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  /** The map's tables read by this thread, by their buffer (the same memory as the page's). */
  const readers = new WeakMap<ArrayBufferLike, TableReader<LandscapeItem>>();
  scope.onmessage = (event: MessageEvent<FurnitureCellAsk>) => {
    const ask = event.data;
    try {
      const doc = RoadDoc.fromJSON({ version: 1, unit: METERS_PER_UNIT, nodes: ask.nodes, segments: ask.segments, terrain: [], poles: [], poleSpans: [], markingStyle: ask.markingStyle }, { repair: false });
      const net = new Network(doc);
      net.scope = new Set(ask.scope);
      net.rebuild({ full: true });
      const terrainAt = ask.level || !ask.ground ? (): number => 0 : sharedGroundReaders(ask.ground).naturalAt;
      const heights = fieldOf(ask.field, terrainAt);
      const places: FurniturePlace[] = [];
      for (const item of rowRecords<LandscapeItem>(ask, readers)) {
        if (!isFurniture(item)) continue;
        const place = furniturePlace(net, heights, item, ask.lens);
        if (place) places.push(place);
      }
      const packed = packPlaces(places);
      scope.postMessage({ id: ask.id, places: packed } satisfies FurnitureCellReply, [packed.buffer]);
    } catch (error) {
      console.error('[furniture] a rectangle\'s street furniture could not be placed off the page', error);
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies FurnitureCellReply);
    }
  };
}
