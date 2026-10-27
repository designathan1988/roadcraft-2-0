import { Color } from 'three';
import { ROAD_TYPES } from '@world/roadTypes';
import type { CarriagewayMaterial } from '@world/roadSection';
import { ASPHALT_TILE, DECK_TILE, FOOTWAY_TILE, KERB_TILE, VERGE_TILE } from './bake/roadRecipes';
import { ASPHALT_REFERENCE, CARRIAGEWAY_COLOUR } from './roadTones';
import type { PassLook } from './roadSurfacePass';

/** THE CONSTANTS THE ROADS ARE DRAWN WITH, AS NUMBERS (`PassLook`): the same on the page (`roadSurfaces.ts`) and in a job (`networkFarPieces.ts`), so a
 *  road made anywhere is the same road. */

/** The tint the asphalt material is authored against, so 1.0 means "as baked". */
const TINT_REFERENCE = new Color(ASPHALT_REFERENCE);
/** A colour against the reference, channel by channel: the multiplier a vertex is tinted with. */
const againstReference = (tint: Color): [number, number, number] =>
  [tint.r / TINT_REFERENCE.r, tint.g / TINT_REFERENCE.g, tint.b / TINT_REFERENCE.b];
/** Linear-space tints per road class, against the reference: the carriageway's tint a vertex, by its class. */
export const CLASS_TINTS: readonly number[] = Object.freeze(ROAD_TYPES.flatMap((type) => againstReference(new Color(type.color))));
export const REFERENCE_TINT: readonly [number, number, number] = Object.freeze(againstReference(TINT_REFERENCE));
/** A carriageway's tone by what it is paved with; asphalt keeps its class's. */
export const PAVING_TINTS: Readonly<Record<string, readonly [number, number, number]>> = Object.freeze(Object.fromEntries(
  (Object.keys(CARRIAGEWAY_COLOUR) as Exclude<CarriagewayMaterial, 'asphalt'>[]).map((name) => [name, againstReference(new Color(CARRIAGEWAY_COLOUR[name]))])));

/** The roads' look with the road material's own texture scales (`materials.ts` scale): what a job draws them with. */
export const ROAD_PASS_LOOK: PassLook = Object.freeze({
  scale: { asphalt: ASPHALT_TILE, footway: FOOTWAY_TILE, kerb: KERB_TILE, verge: VERGE_TILE, deck: DECK_TILE },
  classTint: CLASS_TINTS,
  referenceTint: REFERENCE_TINT as [number, number, number],
  pavingTint: PAVING_TINTS,
});
