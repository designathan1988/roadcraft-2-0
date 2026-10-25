import { Color, DoubleSide, FrontSide, MeshStandardMaterial } from 'three';

import { disposeSurfaceTextures, surfaceTexture } from './surfaceTextures';
import {
  ASPHALT_TILE, DECK_TILE, FOOTWAY_TILE, KERB_TILE, ROAD_COLOUR_LAYERS, ROAD_DETAIL_LAYERS, ROAD_LAYER_SIZE, ROAD_RELIEF_LAYERS, ROAD_SURFACE_SIZE, VERGE_TILE,
} from './bake/roadRecipes';
import { DETAIL_WORLD_SIZE, type DetailKind } from './bake/detailRecipes';
import { detailSwitch } from './mesh/detailLayer';
import { ROAD_CODE, type RoadLook, type RoadMaps, applyRoadLayers, applyRoadSurface } from './mesh/roadEdges';
import { applyLotOverlay } from './lotOverlay';

/** Every material the scene uses, its surfaces baked at build time (`bake/roadRecipes.ts`) and shared. */

export interface SceneMaterials {
  /** Every road surface's one material (`mesh/roadEdges.ts` applyRoadSurface): the carriageway, its raised crossings, the footway, the kerb, a
   *  median's planting and a deck's edge, each told by the code its vertices carry. The surfaces' own names below are this material too. */
  readonly road: MeshStandardMaterial;
  readonly asphalt: MeshStandardMaterial;
  readonly asphaltRaised: MeshStandardMaterial;
  readonly footway: MeshStandardMaterial;
  readonly kerb: MeshStandardMaterial;
  readonly verge: MeshStandardMaterial;
  readonly deck: MeshStandardMaterial;
  /** The deck's concrete again, for the parapets. */
  readonly parapet: MeshStandardMaterial;
  readonly concrete: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  /** World units one tile of each surface covers, for UV generation. */
  readonly scale: {
    readonly asphalt: number;
    readonly footway: number;
    readonly kerb: number;
    readonly verge: number;
    readonly deck: number;
  };
  /** Switches the close-zoom detail layer on every material that has one. */
  setDetail(enabled: boolean): void;
  dispose(): void;
}

/** The kerb's normal map's strength: its face's and its top's (drawn on the footway, `mesh/roadEdges.ts` ROAD_KERB_TOP) alike. */
const KERB_NORMAL_SCALE = 0.85;
/** The road material's colour: the maps' tone untinted, each surface's own (`RoadLook`). */
const ROAD_TINT = 0xffffff;

export function createMaterials(anisotropy: number): SceneMaterials {
  const materials: MeshStandardMaterial[] = [];
  const keep = <T extends MeshStandardMaterial>(value: T): T => {
    materials.push(value);
    return value;
  };

  // Every road surface in one material, each as its own material drew it: its maps' layers (`bake/catalogue.ts` roadArrays), its normals' strength,
  // its metalness and its close-zoom layer (the numbers each surface's material held: the kerb's top drawn on the footway with the kerb's own).
  const road = keep(new MeshStandardMaterial({
    color: new Color(ROAD_TINT), roughness: 1, metalness: 0, side: FrontSide, shadowSide: DoubleSide, envMapIntensity: 0.55, vertexColors: true,
  }));
  road.name = 'road-surface';
  const colour = (key: (typeof ROAD_COLOUR_LAYERS)[number]): number => ROAD_COLOUR_LAYERS.indexOf(key);
  const relief = (key: (typeof ROAD_RELIEF_LAYERS)[number]): number => ROAD_RELIEF_LAYERS.indexOf(key);
  const tiles = (key: keyof typeof ROAD_SURFACE_SIZE): number => ROAD_LAYER_SIZE / ROAD_SURFACE_SIZE[key];
  const detail = (kind: DetailKind & (typeof ROAD_DETAIL_LAYERS)[number], macroTile: number, albedo: number, normal: number, macroBlur: number): RoadLook['detail'] =>
    ({ layer: ROAD_DETAIL_LAYERS.indexOf(kind), macroTile, repeat: macroTile / DETAIL_WORLD_SIZE[kind], albedo, normal, macroBlur });
  const looks: RoadLook[] = [];
  const asphaltDetail = detail('asphalt', ASPHALT_TILE, 0.6, 0.65, 1.6);
  looks[ROAD_CODE.carriageway] = { colour: colour('asphalt'), normal: relief('asphalt'), rough: ROAD_RELIEF_LAYERS.length + relief('asphalt'), tiles: tiles('asphalt'), normalScale: 1, metalness: 0.02, detail: asphaltDetail };
  // The raised crossings' paler asphalt: its own colour on the road's normal and roughness.
  looks[ROAD_CODE.raised] = { colour: colour('asphalt-raised'), normal: relief('asphalt'), rough: ROAD_RELIEF_LAYERS.length + relief('asphalt'), tiles: tiles('asphalt-raised'), normalScale: 0.9, metalness: 0.02, detail: asphaltDetail };
  // The footway's maps its own (twice the others' size): its colour, its normal (layer 0) and roughness (layer 1).
  looks[ROAD_CODE.footway] = { colour: -1, normal: 0, rough: 1, tiles: 1, normalScale: 1, metalness: 0, detail: detail('concrete', FOOTWAY_TILE, 0.7, 0.8, 0.6) };
  looks[ROAD_CODE.kerb] = { colour: colour('kerb'), normal: relief('kerb'), rough: ROAD_RELIEF_LAYERS.length + relief('kerb'), tiles: tiles('kerb'), normalScale: KERB_NORMAL_SCALE, metalness: 0, detail: detail('concrete', KERB_TILE, 0.55, 0.7, 0.8) };
  looks[ROAD_CODE.planting] = { colour: colour('verge'), normal: relief('verge'), rough: ROAD_RELIEF_LAYERS.length + relief('verge'), tiles: tiles('verge'), normalScale: 0.9, metalness: 0, detail: detail('grass', VERGE_TILE, 1, 1.2, 2) };
  // The deck's edge, and the structures' concrete (`applyRoadLayers` below).
  const deckLook: RoadLook = { colour: colour('deck'), normal: relief('deck'), rough: ROAD_RELIEF_LAYERS.length + relief('deck'), tiles: tiles('deck'), normalScale: 1, metalness: 0.02, detail: detail('concrete', DECK_TILE, 0.6, 0.8, 1) };
  looks[ROAD_CODE.deck] = deckLook;
  const maps: RoadMaps = {
    colours: surfaceTexture('road-surfaces:map', anisotropy), relief: surfaceTexture('road-surfaces:relief', anisotropy),
    footwayColour: surfaceTexture('road-footway:map', anisotropy), footwayRelief: surfaceTexture('road-footway:relief', anisotropy),
    details: surfaceTexture('road-details', anisotropy), detailNormals: ROAD_DETAIL_LAYERS.length,
  };
  applyRoadSurface(road, maps, looks, FOOTWAY_TILE / KERB_TILE);
  // The structures' concrete, the deck's (`structures.ts`), read from the road's layers: the parapets and walls with the deck's close-zoom layer.
  const parapetMaterial = keep(new MeshStandardMaterial({
    color: new Color(0xffffff), roughness: 1, metalness: 0.02, side: FrontSide, shadowSide: DoubleSide, envMapIntensity: 0.55,
  }));
  applyRoadLayers(parapetMaterial, maps, deckLook, true);
  // The piers, abutments and tunnel mouths: the deck's maps, tinted, without the close-zoom layer.
  const concreteMaterial = keep(new MeshStandardMaterial({ color: 0x9fa4a2, roughness: 1, metalness: 0.02, side: FrontSide }));
  applyRoadLayers(concreteMaterial, maps, deckLook, false);
  // The lots coloured into the street's own surfaces (`lotOverlay.ts`)
  applyLotOverlay(road);

  return {
    road,
    asphalt: road,
    asphaltRaised: road,
    footway: road,
    kerb: road,
    verge: road,
    deck: road,
    parapet: parapetMaterial,
    concrete: concreteMaterial,
    steel: keep(
      new MeshStandardMaterial({
        color: 0x8e979a,
        roughness: 0.42,
        metalness: 0.72,
        side: DoubleSide,
      }),
    ),
    scale: {
      asphalt: ASPHALT_TILE,
      footway: FOOTWAY_TILE,
      kerb: KERB_TILE,
      verge: VERGE_TILE,
      deck: DECK_TILE,
    },
    setDetail(enabled) {
      detailSwitch.value = enabled ? 1 : 0;
    },
    dispose() {
      for (const material of materials) material.dispose();
      // The baked textures (detail layers included) are shared and kept by name, so they are the material set's to release
      disposeSurfaceTextures();
    },
  };
}
