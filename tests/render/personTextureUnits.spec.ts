import { describe, expect, it } from 'vitest';
import { DataTexture, FloatType, Matrix4, RGBAFormat, type Mesh, type SkinnedMesh } from 'three';
import { createPersonMaterials } from '@render/people/personMaterial';
import { personProgramStandIns } from '@render/riggedCitizens';
import { cascadedSunChunks, SUN_CASCADES } from '@render/sunCascades';
import { MAX_UNITS, listed, textureUnits, total } from './_textureUnits';

/** THE PEOPLE'S PROGRAMS FIT 12 TEXTURE UNITS (`_textureUnits.ts`): a cooked body reads one atlas and its bones' palette, nothing else of its own. */

describe('the people\'s texture units', () => {
  cascadedSunChunks();

  it('a cooked body, lit with its face\'s morphs, reads its atlas and its palette', () => {
    const palette = { uniform: { value: new DataTexture(new Float32Array(16), 4, 1, RGBAFormat, FloatType) }, base: { value: 0 } };
    const mesh = { bindMatrix: new Matrix4(), bindMatrixInverse: new Matrix4() } as unknown as SkinnedMesh;
    const atlas = new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
    const { lit, depth } = createPersonMaterials(atlas, 0.35, palette, mesh);
    for (const morph of [false, true]) {
      const units = textureUnits(lit, { instanceColor: true, morph });
      expect(total(units), `morph ${morph}: ${listed(units)}`).toBeLessThanOrEqual(MAX_UNITS);
      if (morph) {
        expect(listed(units).split(' ').sort()).toEqual([`directionalShadowMap[${SUN_CASCADES}]`, 'citizenBones', 'dfgLUT', 'envMap', 'map',
          'morphTargetsTexture', 'morphTexture'].sort());
      }
      expect(total(textureUnits(depth, { instanceColor: true, morph }))).toBeLessThanOrEqual(MAX_UNITS);
    }
  });

  it('every stand-in the catalogue compiles, lit or cast into the shadow', () => {
    const { lit, shadow } = personProgramStandIns();
    let programs = 0;
    for (const group of [lit, shadow]) {
      group.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const units = textureUnits(material, { instanceColor: false, morph: false });
          programs++;
          expect(total(units), `${material.customProgramCacheKey()}: ${listed(units)}`).toBeLessThanOrEqual(MAX_UNITS);
        }
      });
    }
    // Two bodies (with and without a face), their shadows, and the card.
    expect(programs).toBeGreaterThanOrEqual(3);
  });
});
