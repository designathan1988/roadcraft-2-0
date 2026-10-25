import {
  Color, DoubleSide, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, ShaderChunk, type SkinnedMesh, type Texture,
} from 'three';

/**
 * THE ONE MATERIAL EVERY COOKED PERSON IS DRAWN WITH (`cookedPerson.ts`): the atlas for the colour, the vertex's own colour over it,
 * the region and roughness read from the vertex (`personColor.a`), the bones from the palette pass's texture, a row a figure.
 * One program for all bodies, one depth program for their shadows: nothing of a person's look is in the program's key.
 */

/** A figure's palette row is its own (`citizenRow`): the figures of a body are drawn by level, each level a mesh of its own. */
const SKINNING = /* glsl */ `
uniform sampler2D citizenBones;
uniform mat4 bindMatrix;
uniform mat4 bindMatrixInverse;
uniform float citizenBase;
attribute float citizenRow;
mat4 getBoneMatrix(const in float i) {
  int x = int(i)*4;
  int y = int(citizenRow) + int(citizenBase);
  return mat4(texelFetch(citizenBones,ivec2(x,y),0),
    texelFetch(citizenBones,ivec2(x+1,y),0),
    texelFetch(citizenBones,ivec2(x+2,y),0),
    texelFetch(citizenBones,ivec2(x+3,y),0));
}`;

/** The region a vertex belongs to (`cookedPerson.ts` lookByte). */
export const REGION_PLAIN = 0, REGION_SKIN = 1, REGION_HAIR = 2, REGION_EYE = 3;

const PERSON_VERTEX_PARS = /* glsl */ `
attribute vec4 personColor;
varying vec4 vPerson;
varying vec2 vPersonUv;`;
const PERSON_VERTEX = /* glsl */ `
vPerson = personColor;
vPersonUv = uv;`;
const PERSON_FRAGMENT_PARS = /* glsl */ `
varying vec4 vPerson;
varying vec2 vPersonUv;
/** The region (0 plain, 1 skin, 2 hair, 3 eye) and the roughness (0..1) of the fragment, from the vertex's look byte. */
float personRegion() { return floor(vPerson.a * 255.0 / 64.0 + 0.5 / 64.0); }
float personRoughness() { return mod(vPerson.a * 255.0 + 0.5, 64.0) / 63.0; }
float personSkinWeight() { float r = personRegion(); return r > 0.5 && r < 1.5 ? 1.0 : 0.0; }
float personHairWeight() { float r = personRegion(); return r > 1.5 && r < 2.5 ? 1.0 : 0.0; }
vec3 personStrand = vec3(0.0, 1.0, 0.0);
float personSparkle = 0.5;`;

/** three's physical lighting with a person's own terms: skin wrapped and scattering, hair lit along its strands, little of the sky mirrored by any of it. */
function personLighting(): string {
  const chunk = ShaderChunk.lights_physical_pars_fragment;
  const specular = 'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;';
  const diffuse = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
  if (!chunk.includes(specular) || !chunk.includes(diffuse)) throw new Error('three lighting chunk changed: person lighting must be updated');
  const helpers = /* glsl */ `
float personStrandSpecular(vec3 T, vec3 H, float exponent) {
  float dotTH = dot(T, H);
  float sinTH = sqrt(max(0.0, 1.0 - dotTH * dotTH));
  return smoothstep(-1.0, 0.0, dotTH) * pow(sinTH, exponent);
}
float personIndirect() {
  return mix(1.0, 0.25, max(personSkinWeight(), personHairWeight()));
}
`;
  return helpers + chunk
    .replace(specular, /* glsl */ `{
      float skinW = personSkinWeight();
      float hairW = personHairWeight();
      vec3 spec = irradiance * specularBRDF * material.multiScatteringCompensation;
      spec *= mix(1.0, 0.35, skinW);
      if (hairW > 0.0) {
        vec3 H = normalize(directLight.direction + geometryViewDir);
        float shift = personSparkle - 0.5;
        vec3 t1 = normalize(personStrand + (-0.12 + 0.2 * shift) * geometryNormal);
        vec3 t2 = normalize(personStrand + (0.22 + 0.2 * shift) * geometryNormal);
        float lit = saturate(dot(geometryNormal, directLight.direction) * 0.5 + 0.5);
        vec3 strands = (vec3(0.035) + material.diffuseColor * 0.25) * personStrandSpecular(t1, H, 140.0)
          + material.diffuseColor * 0.55 * step(0.4, personSparkle) * personStrandSpecular(t2, H, 26.0);
        spec = mix(spec, strands * lit * directLight.color, hairW);
      }
      reflectedLight.directSpecular += spec;
    }`)
    .replace(diffuse, /* glsl */ `{
      float skinW = personSkinWeight();
      float hairW = personHairWeight();
      float rawNL = dot(geometryNormal, directLight.direction);
      vec3 lit = irradiance;
      if (skinW > 0.0) {
        float wrapped = saturate((rawNL + 0.4) / 1.4);
        float scatter = smoothstep(0.0, 0.3, wrapped) * smoothstep(0.62, 0.3, wrapped);
        lit = mix(lit, (vec3(wrapped) + scatter * vec3(0.32, 0.07, 0.04)) * directLight.color, skinW);
      }
      if (hairW > 0.0) lit = mix(lit, mix(0.25, 1.0, saturate(rawNL)) * directLight.color, hairW);
      reflectedLight.directDiffuse += lit * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
    }`);
}

/** The bones' palette and this body's row base, as the skinning reads them. */
export interface PaletteSource { readonly uniform: { value: Texture }; readonly base: { value: number } }

/** `mesh`: the cooked body whose bind matrices the skinning reads. */
function patchSkinning(material: MeshStandardMaterial | MeshDepthMaterial, palette: PaletteSource, mesh: SkinnedMesh): void {
  material.defines = { ...material.defines, USE_SKINNING: '' };
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms['citizenBones'] = palette.uniform;
    shader.uniforms['citizenBase'] = palette.base;
    shader.uniforms['bindMatrix'] = { value: mesh.bindMatrix };
    shader.uniforms['bindMatrixInverse'] = { value: mesh.bindMatrixInverse };
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_pars_vertex>', SKINNING);
  };
}

/** Alpha under which a texel of the atlas is a hole (the hair's cards): the cook writes the same into the file (`CookedMesh.alphaTest`). */
export const PERSON_ALPHA_TEST = 0.35;

export interface PersonMaterials {
  readonly lit: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
  dispose(): void;
}

/** The lit material and the shadow's depth material of a cooked body drawn with `atlas`. */
export function createPersonMaterials(atlas: Texture, alphaTest: number, palette: PaletteSource, mesh: SkinnedMesh): PersonMaterials {
  const lit = new MeshStandardMaterial({
    map: atlas, color: new Color(0xffffff), roughness: 1, metalness: 0, side: DoubleSide, alphaTest, alphaToCoverage: true,
  });
  patchSkinning(lit, palette, mesh);
  const skinned = lit.onBeforeCompile;
  lit.onBeforeCompile = (shader, renderer) => {
    skinned.call(lit, shader, renderer);
    shader.vertexShader = `${PERSON_VERTEX_PARS}\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${PERSON_VERTEX}`);
    shader.fragmentShader = `${PERSON_FRAGMENT_PARS}\n${shader.fragmentShader}`
      // The vertex's own colour over the atlas (white where the atlas holds the colour, the colour where the atlas is white): sRGB bytes, as the atlas's texels are (a dark coat keeps its shades).
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= sRGBTransferEOTF(vec4(vPerson.rgb, 1.0)).rgb;'
        // Skin seen from inside (the cheeks' and lips' inner side through an open mouth) is the body's dark inside, not lit skin.
        + '\nif (!gl_FrontFacing) diffuseColor.rgb *= mix(vec3(1.0), vec3(0.09, 0.045, 0.045), personSkinWeight());')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = personRoughness();')
      .replace('#include <lights_physical_pars_fragment>', personLighting())
      // The strands' direction, for the hair's highlights: from the atlas's coordinates as they run over the surface
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
        {
          vec3 dp1 = dFdx(-vViewPosition), dp2 = dFdy(-vViewPosition);
          vec2 du1 = dFdx(vPersonUv), du2 = dFdy(vPersonUv);
          vec3 along = dp2 * du1.x - dp1 * du2.x;
          personStrand = along - normal * dot(along, normal);
          personStrand = dot(personStrand, personStrand) > 1e-12 ? normalize(personStrand) : vec3(0.0, 1.0, 0.0);
          personSparkle = fract(sin(dot(floor(vPersonUv * vec2(640.0, 48.0)), vec2(12.9898, 78.233))) * 43758.5453);
        }`)
      // Skin, cloth and hair hardly mirror the sky
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectSpecular *= personIndirect();');
  };
  lit.customProgramCacheKey = () => 'person-v3';
  // No colour: the sun's maps are read by their depth texture alone (three r186 PCF compares `shadow.map.depthTexture`); the atlas's alpha cuts the hair's holes.
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false, map: atlas, alphaTest, side: DoubleSide });
  patchSkinning(depth, palette, mesh);
  depth.customProgramCacheKey = () => 'person-depth-v3';
  return {
    lit, depth,
    dispose() { lit.dispose(); depth.dispose(); },
  };
}
