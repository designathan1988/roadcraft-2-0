import { BackSide, DoubleSide, FrontSide, GLSL3, ShaderChunk, ShaderMaterial, type Material, type Side } from 'three';
import type { PicturePart } from './pictureParts';

/**
 * THE MATERIALS THE PICTURES ARE TAKEN WITH (`plantImpostors.ts` createImpostors): a part's colour, gamma-encoded, and its normal in the
 * model's frame into two targets (and, in a set with thin parts, their bar and tone into a third), and its shadow's outline - with a plain
 * material of the part's own colours and normals, or with its own near material (`PicturePart.material`).
 */

/** A thin part's bar is kept in the third picture as its share of this many metres (a window frame's is 0.05, a baluster's 0.02). */
export const THIN_BAR_SCALE = 0.25;

/** The side three r186 draws a material's shadow with (`WebGLShadowMap` shadowSide, PCF and Basic maps): what the near model casts. */
const SHADOW_SIDE: Readonly<Record<Side, Side>> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };

/** The samples a still set's pictures are taken with: the game's own multisampling on its upper tiers (`quality.ts` msaa 4). */
export const BAKE_SAMPLES = 4;

/** three r186's own read of a material's map (`map_fragment`): a picture of an alpha-cut set reads it mips coarser (`bakeMaterialsOf` mapBias). */
const MAP_READ = 'texture2D( map, vMapUv )';
if (!ShaderChunk.map_fragment.includes(MAP_READ)) throw new Error('impostorBake: three\'s map_fragment no longer reads its map as r186 did');

const BAKE_OUT = /* glsl */ `
  layout(location = 0) out vec4 gColour;
  layout(location = 1) out vec4 gNormal;
`;

/** The material a part's pictures are taken with: its colour (the map times its vertex colours) gamma-encoded, its normal in the model's frame
 *  (`COLOUR_NORMAL` reads it back); its map read `mapBias` mips coarser than the picture's texels ask. */
function bakeColourMaterial(part: PicturePart, thinSet: boolean, mapBias: number): ShaderMaterial {
  const coloured = part.geometry.getAttribute('color') !== undefined;
  const defines: Record<string, string> = {};
  if (thinSet) defines['BAKE_THIN'] = '';
  if (part.map) defines['BAKE_MAP'] = '';
  defines['BAKE_MAP_BIAS'] = mapBias.toFixed(1);
  if (part.map && (part.alphaTest ?? 0) > 0) defines['BAKE_CUT'] = (part.alphaTest ?? 0).toFixed(4);
  if (part.billboard) defines['BAKE_BILLBOARD'] = '';
  if (part.normals === 'faceted') defines['BAKE_FACETED'] = '';
  // A two-sided part's back seen: its normal turned to the eye, as three's two-sided lighting turns it (`normal_fragment_begin`); leaf cards keep theirs (the crown's).
  if (part.side === DoubleSide && part.normals === 'vertex' && !part.billboard) defines['BAKE_TURN'] = '';
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexColors: coloured,
    side: part.side,
    defines,
    uniforms: { uMap: { value: part.map ?? null } },
    vertexShader: /* glsl */ `
      #ifdef BAKE_BILLBOARD
      attribute vec2 aCorner;
      #endif
      varying vec3 vColour;
      varying vec3 vNormalLocal;
      varying vec3 vView;
      varying vec2 vMapUv;
      void main() {
        #ifdef USE_COLOR
        vColour = color;
        #else
        vColour = vec3(1.0);
        #endif
        vNormalLocal = normal;
        vMapUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        #ifdef BAKE_BILLBOARD
        mv.xy += aCorner;
        #endif
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${BAKE_OUT}
      #ifdef BAKE_THIN
      layout(location = 2) out vec4 gThin;
      #endif
      uniform sampler2D uMap;
      varying vec3 vColour;
      varying vec3 vNormalLocal;
      varying vec3 vView;
      varying vec2 vMapUv;
      void main() {
        vec3 colour = vColour;
        #ifdef BAKE_MAP
        vec4 texel = texture(uMap, vMapUv, BAKE_MAP_BIAS);
        #ifdef BAKE_CUT
        if (texel.a < BAKE_CUT) discard;
        #endif
        colour *= texel.rgb;
        #endif
        #ifdef BAKE_FACETED
        vec3 local = normalize(transpose(mat3(viewMatrix)) * normalize(cross(dFdx(vView), dFdy(vView))));
        #else
        vec3 local = normalize(vNormalLocal);
        #ifdef BAKE_TURN
        if (!gl_FrontFacing) local = -local;
        #endif
        #endif
        gColour = vec4(pow(max(colour, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
        gNormal = vec4(local * 0.5 + 0.5, 1.0);
        #ifdef BAKE_THIN
        gThin = vec4(0.0, 0.0, 0.0, 1.0);
        #endif
      }`,
  });
}

/** The material a part's shadow outline is taken with: its cover, cut by its map's alpha as its colour is, drawn with the side it casts with. */
function bakeOutlineMaterial(part: PicturePart): ShaderMaterial {
  const defines: Record<string, string> = {};
  if (part.map && (part.alphaTest ?? 0) > 0) defines['BAKE_CUT'] = (part.alphaTest ?? 0).toFixed(4);
  if (part.billboard) defines['BAKE_BILLBOARD'] = '';
  return new ShaderMaterial({
    glslVersion: GLSL3,
    side: SHADOW_SIDE[part.side],
    defines,
    uniforms: { uMap: { value: part.map ?? null } },
    vertexShader: /* glsl */ `
      #ifdef BAKE_BILLBOARD
      attribute vec2 aCorner;
      #endif
      varying vec2 vMapUv;
      void main() {
        vMapUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        #ifdef BAKE_BILLBOARD
        mv.xy += aCorner;
        #endif
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      layout(location = 0) out vec4 gCover;
      uniform sampler2D uMap;
      varying vec2 vMapUv;
      void main() {
        #ifdef BAKE_CUT
        if (texture(uMap, vMapUv).a < BAKE_CUT) discard;
        #endif
        gCover = vec4(1.0);
      }`,
  });
}

/**
 * A part's own near material taking its pictures (`PicturePart.material`): a copy of it (three's `clone` copies its values, not its patches)
 * compiled with its own patches first, then, where three has its colour (`diffuseColor`, after its maps, vertex colours, alpha test) and its
 * normal (after `normal_fragment_maps`: flat or smooth, turned to the eye on a back face), the two written into the pictures' targets and the
 * rest of the shading left out; or, for the outline, the cover alone. Its vertex shader is its own: a pose or a wind of an instanced material
 * does nothing to the mesh the pictures are taken of (`cellInstances.ts` poseVertexShader, `wind.ts`: under `USE_INSTANCING`).
 */
function bakeWithMaterial(material: Material, outline: boolean, thin: PicturePart['thin'] | null, thinSet: boolean, mapBias: number): Material {
  const copy = material.clone();
  copy.side = outline ? SHADOW_SIDE[material.side] : material.side;
  const own = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey.bind(material);
  // A thin part's colour as it is before its tone (`thinParts.ts`: the tone follows `color_fragment`): the picture tones it where it is drawn.
  const colour = thin ? 'pictureRaw' : 'diffuseColor.rgb';
  const thinOut = !thinSet ? '' : thin
    ? `gThin = vec4(${(thin.bar / THIN_BAR_SCALE).toFixed(6)}, ${thin.behind.toFixed(6)}, 1.0, 1.0);`
    : 'gThin = vec4(0.0, 0.0, 0.0, 1.0);';
  copy.onBeforeCompile = (shader, renderer) => {
    own(shader, renderer);
    const outputs = outline ? '' : `layout(location = 1) out highp vec4 gNormal;${thinSet ? '\nlayout(location = 2) out highp vec4 gThin;' : ''}`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${outputs}`)
      .replace('#include <map_fragment>', mapBias === 0 ? '#include <map_fragment>' : ShaderChunk.map_fragment.replace(MAP_READ, `texture2D( map, vMapUv, ${mapBias.toFixed(1)} )`))
      .replace('#include <color_fragment>', `#include <color_fragment>${thin ? '\n  vec3 pictureRaw = diffuseColor.rgb;' : ''}`)
      .replace('#include <normal_fragment_maps>', outline
        ? '#include <normal_fragment_maps>\n  gl_FragColor = vec4(1.0);\n  return;'
        : `#include <normal_fragment_maps>
  gl_FragColor = vec4(pow(max(${colour}, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
  gNormal = vec4(normalize(transpose(mat3(viewMatrix)) * normal) * 0.5 + 0.5, 1.0);
  ${thinOut}
  return;`);
  };
  // Never its own program: the same code with the pictures' ending (a thin part's numbers in its source: one a kind of thin part).
  const thinKey = !thinSet ? '' : thin ? `-thin-${thin.bar}-${thin.behind}` : '-thin';
  copy.customProgramCacheKey = () => `${key()}|picture-${outline ? 'outline' : 'colour'}${thinKey}${mapBias ? `|bias-${mapBias}` : ''}`;
  return copy;
}

/** The materials a part's pictures and its shadow outline are taken with (`bake`); `thinSet`: its set takes its thin parts' third picture;
 *  `mapBias`: its colour's map read so many mips coarser than a texel of the picture asks (an alpha-cut set's levels, each drawn where a pixel
 *  spans two of its texels: the map read as the model's own pixel there reads it, `PictureLook.perMip`). */
export function bakeMaterialsOf(part: PicturePart, thinSet = false, mapBias = 0): { readonly colour: Material; readonly outline: Material } {
  if (part.material) {
    return { colour: bakeWithMaterial(part.material, false, part.thin ?? null, thinSet, mapBias), outline: bakeWithMaterial(part.material, true, null, false, 0) };
  }
  if (part.thin) throw new Error('bakeMaterialsOf: a thin part is taken with its own material (its tone is its shader\'s)');
  return { colour: bakeColourMaterial(part, thinSet, mapBias), outline: bakeOutlineMaterial(part) };
}
