import type { CarriagewayMaterial, FootwayMaterial } from '@world/roadSection';

/** THE STREET SURFACES' TONES over their baked textures, one source for the near roads (`roadSurfaces.ts`, `roadSurfaceReads.ts`) and the far ones (`farRoadTiles.ts`) */

/** The colour the asphalt texture is authored against (sRGB): a class's colour (`RoadType.color`) over it is the tint its carriageway is drawn with. */
export const ASPHALT_REFERENCE = 0x3a3d3f;

/** A carriageway's colour by what it is paved with (sRGB); asphalt keeps its class's. */
export const CARRIAGEWAY_COLOUR: Readonly<Record<Exclude<CarriagewayMaterial, 'asphalt'>, number>> = {
  concrete: 0x8f8d88,
  cobble: 0x6a5f52,
};

/** A footway's tone over the baked pavers, by material, linear multipliers. */
export const FOOTWAY_TINT: Readonly<Record<FootwayMaterial, readonly [number, number, number]>> = {
  pavers: [1, 1, 1],
  concrete: [1.08, 1.08, 1.1],
  stone: [1, 0.84, 0.66],
};

/** THE MEAN LINEAR ALBEDO OF EACH BAKED STREET TEXTURE (`bake/roadRecipes.ts`), every texel as stored (sRGB bytes) and read (linear): constants, worked
 *  out once from the recipes; the raised crossings' and the deck's read off their layers' last mip level (1 x 1, the mean of every texel). What the
 *  far levels paint each surface with (`networkFarRoads.ts`, `roadStandIn.ts`), and the sheets (`mesh/roadEdges.ts` roadSheetMaterial). */
export const STREET_MEANS: Readonly<Record<'asphalt' | 'raised' | 'footway' | 'kerb' | 'verge' | 'deck', readonly [number, number, number]>> = {
  asphalt: [0.040666, 0.041456, 0.044698],
  raised: [0.05127, 0.052734, 0.056152],
  footway: [0.210044, 0.208119, 0.195658],
  kerb: [0.338651, 0.331236, 0.316671],
  verge: [0.029413, 0.070144, 0.010057],
  deck: [0.386719, 0.380859, 0.361328],
};
