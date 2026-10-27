import { m } from '@world/units';

/** A STREET LAMP'S MEASURES, with nothing of its model or its materials: what the furniture is placed by on the page and off it (`furniturePlace.ts`). */

/** A residential lighting column is 8 to 10 m with a 1.5 to 2.5 m outreach. */
export const LAMP_HEIGHT = m(9);
export const LAMP_OUTREACH = m(2.1);
/** Radius of the bright core under a street lamp (the cone's foot). */
export const LAMP_POOL_RADIUS = m(4.6);
/** The light a street lamp lays on the road: not a spotlight's disc but the long patch of a road luminaire's spread */
export const POOL_ALONG = 1.6;
/** A lamp's visible cone of light, drawn as Volumetric Light Beam draws one (saladgamer.com/vlb-doc/comp-lightbeam-sd/) */
/** The cone's radius at the ground: the bright core of the pool. */
export const LAMP_BEAM_RADIUS = LAMP_POOL_RADIUS * 0.8;
