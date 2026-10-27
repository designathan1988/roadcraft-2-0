import { FINISHES } from '@world/buildings/materials';
import { ROAD_TYPES } from '@world/roadTypes';
import { catalogRoads } from '@world/roads/catalog';
import { DRAW_SHAPES, TIER_SHAPES } from '../ui/builder/catalog';
import type { PhotoShelf } from '../ui/photos';
import { CARD_PHOTO, catalogSpan } from '../ui/roads/templates';
import { profileSwatch } from '../ui/roads/profileSwatch';
import { photographAll } from './builderPhotos';
import { materialSwatch } from './swatches/materialSwatch';
import { planSwatch } from './swatches/planSwatch';
import { roadSwatch } from './swatches/roadSwatch';

/**
 * EVERY PHOTO OF THE INTERFACE, TAKEN ONCE (`scripts/interface-photos.mjs`, written to `src/ui/photos/<shelf>/`): what each menu shows of
 * its options. Run again after a change to what an option looks like (`npm run photos`); `tests/ui/interfacePhotos.spec.ts` holds the set whole.
 */

/** The options each shelf shows that the game ships (the player's own are photographed as they are saved). */
export function shippedOptions(): Record<Exclude<PhotoShelf, 'builder'>, readonly string[]> {
  return {
    finish: [...FINISHES],
    plan: [...new Set([...Object.values(DRAW_SHAPES), ...Object.values(TIER_SHAPES)])],
    roadClass: ROAD_TYPES.map((_, index) => String(index)),
    road: catalogRoads().map((r) => r.id),
  };
}

/** Each shelf's photos as PNG data URLs, by option id. */
export async function photographInterface(): Promise<Record<PhotoShelf, Record<string, string>>> {
  const options = shippedOptions();
  const roads = new Map(catalogRoads().map((r) => [r.id, r]));
  const span = catalogSpan();
  return {
    builder: await photographAll(),
    finish: Object.fromEntries(options.finish.map((f) => [f, materialSwatch(f as (typeof FINISHES)[number])])),
    plan: Object.fromEntries(options.plan.map((shape) => [shape, planSwatch(shape as Parameters<typeof planSwatch>[0])])),
    roadClass: Object.fromEntries(ROAD_TYPES.map((rt, index) => [String(index), roadSwatch(rt)])),
    road: Object.fromEntries(options.road.map((id) => [id, profileSwatch(roads.get(id)!.profile, span, CARD_PHOTO.width, CARD_PHOTO.height)])),
  };
}
