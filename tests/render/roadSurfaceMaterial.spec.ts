import { describe, expect, it, vi } from 'vitest';
import { Texture } from 'three';

import { createMaterials } from '@render/materials';
import { applyRoadWear, createWearField } from '@render/wear';
import { ROAD_CODE, ROAD_WEAR } from '@render/mesh/roadEdges';
import { drawGroups, type SurfaceSpec } from '@render/roadSurfaceBlocks';
import { roadCodeOf, surfaceLook } from '@render/roadSurfaces';
import type { TileSource } from '@render/roadSurfaceReads';
import { listed, textureUnits, total } from './_textureUnits';

/** The baked textures as plain ones (not in Node): a texture is a uniform here, its texels never read. */
vi.mock('@render/surfaceTextures', async (actual) => ({
  ...(await actual<typeof import('@render/surfaceTextures')>()),
  surfaceTexture: () => new Texture(),
}));

/**
 * EVERY ROAD SURFACE IN ONE MATERIAL (`mesh/roadEdges.ts` applyRoadSurface): the carriageway, its raised crossings, the footway, the kerb, a median's
 * planting and a deck's edge one program, one mesh a block (a draw where each took one), each surface drawn as its own material drew it (its row of the
 * look table the numbers that material held), its texture units within the 16 a fragment shader has (ANGLE on D3D11).
 */

/** A pass's surfaces (`roadSurfaceReads.ts` passSurfaces): a deck's edge only on a raised one. */
const SOURCES: readonly TileSource[] = [
  { kind: 'band', band: 'deckEdge' }, { kind: 'band', band: 'footway' }, { kind: 'band', band: 'curbRamp' }, { kind: 'band', band: 'kerb' },
  { kind: 'band', band: 'asphalt' }, { kind: 'median', part: 'kerb' }, { kind: 'median', part: 'planting' }, { kind: 'median', part: 'paved' },
];
const sourcesOf = (raised: boolean): readonly TileSource[] => SOURCES.filter((s) => raised || s.kind !== 'band' || s.band !== 'deckEdge');

describe('the road material', () => {
  const m = createMaterials(1);

  it('is every road surface\'s material: the surfaces\' own names are it', () => {
    for (const material of [m.asphalt, m.asphaltRaised, m.footway, m.kerb, m.verge, m.deck]) expect(material).toBe(m.road);
    expect(m.parapet).not.toBe(m.road);
  });

  it('draws a block of the ground in one mesh, and a deck\'s in two (the surfaces that cast a shadow and those that do not, as before)', () => {
    for (const raised of [false, true]) {
      const specs: SurfaceSpec[] = sourcesOf(raised).map((source, i) => {
        const look = surfaceLook(source, raised, m);
        return { source, code: roadCodeOf(source, raised), options: { name: `s${i}`, material: look.material, ...(look.castShadow !== undefined ? { castShadow: look.castShadow } : {}), receiveShadow: true } } as unknown as SurfaceSpec;
      });
      const groups = drawGroups(specs);
      expect(groups.length, raised ? 'raised' : 'ground').toBe(raised ? 2 : 1);
      // Each mesh's surfaces in the order their own materials were drawn in (by code): the later wins a pixel two meet on at one depth, as it did.
      for (const group of groups) {
        const codes = group.specs.map((spec) => spec.code ?? 0);
        expect(codes).toEqual([...codes].sort((p, q) => p - q));
      }
    }
  });

  it('gives each surface the code of the material that drew it', () => {
    expect(SOURCES.map((s) => roadCodeOf(s, false))).toEqual([ROAD_CODE.deck, ROAD_CODE.footway, ROAD_CODE.footway, ROAD_CODE.kerb, ROAD_CODE.carriageway, ROAD_CODE.kerb, ROAD_CODE.planting, ROAD_CODE.footway]);
    expect(roadCodeOf({ kind: 'band', band: 'asphalt' }, true)).toBe(ROAD_CODE.raised);
  });

  it('takes no more than the 16 texture units a fragment shader has, the sun\'s cascades and the wear counted', () => {
    applyRoadWear(m.road, createWearField(), ROAD_WEAR);
    const units = textureUnits(m.road, { instanceColor: false, morph: false, instanced: false });
    // The surfaces' 5 (colours, relief, the footway's colour and relief, the close-zoom layers), the paint's 3, the lots', the wear's, the sky's, three's
    // lighting table (`dfgLUT`) and 3 cascades: the 15 the carriageway's own material took (its map, normal and roughness maps, its close-zoom 2).
    expect(total(units), listed(units)).toBe(15);
    expect(total(units)).toBeLessThanOrEqual(16);
  });
});
