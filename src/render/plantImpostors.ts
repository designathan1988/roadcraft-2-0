import {
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  RedFormat,
  Scene,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type InstancedMesh,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { FRAMES, FRAME_PX, IMPOSTOR_FRAMES_GLSL, IMPOSTOR_READ_GLSL, frameBasis, hemiOctaDirection } from './impostorShaders';
import { THIN_TONE_GLSL } from './buildings/thinParts';
import { BAKE_SAMPLES, THIN_BAR_SCALE, bakeMaterialsOf } from './impostorBake';
import { onContextRestored } from './contextRestored';
import { layoutOf, pictureOf, pictureQuad, type Picture } from './pictureLayout';
import type { PicturePart } from './pictureParts';
import { foliageAtlas } from './lowPolyTrees';
import { BUSH_KINDS, TREE_SPECIES, type BushKind, type TreeSpecies } from './propGeometry';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';

/**
 * THE NEAR PLANTS' FAR PICTURES: each tree and bush model taken once from 8 x 8 directions over the
 * upper hemi-octahedron (Ryan Brucks, "Octahedral Impostors", shaderbits.com, 2018; the far woods'
 * own pictures, `farForest.ts`), drawn as one quad an instance where the model would be a few pixels.
 * Under `THIN_PX` the pictures are thinned and the ones kept grown to keep the cover (Cook, Halstead,
 * Planck, Ryu, "Stochastic Simplification of Aggregate Detail", SIGGRAPH 2007): no plant is drawn
 * smaller than a couple of pixels, none thrown into the shadow map under a texel.
 *
 * THE SAME PICTURES OF ANY STILL MODEL (`createImpostors`): a street prop, a ground-cover element. Its parts as its own materials draw
 * them (vertex colours, a texture, an alpha mask, smooth or faceted normals, one side or two), drawn as a picture with the near model's
 * own surface values (`PictureLook`); with no wind, one program for every still set ('static-impostor').
 */

/** A model to take pictures of: its body, its foliage cards, and whether the cards throw its shadow (a palm's fronds). */
export interface ImpostorModel {
  readonly body: BufferGeometry;
  readonly cards: BufferGeometry | null;
  readonly cardsCast: boolean;
}

/** A model to take pictures of: every part of it in one picture. */
export interface PictureModel {
  readonly parts: readonly PicturePart[];
  /** The size its layer measures its level by, model units across (`KindLevels.reach` doubled: a street prop's largest extent, `propLevels.ts`);
   *  none: its picture's sphere's diameter (the plants'). */
  readonly measure?: number;
}

/** How a set's pictures are drawn: the near models' own surface (their material's values, uniforms of one program) and what moves them. */
export interface PictureLook {
  readonly roughness: number;
  readonly metalness: number;
  readonly envMapIntensity: number;
  /** The wind they sway in (marked as movers, `wind.ts`); null: still (a street prop, a stone), never redrawn into the cascades for a gust. */
  readonly wind: WindResponse | null;
  /** Thinned under `THIN_PX`, the ones kept grown to keep the cover (the plants); false: each drawn at its own size, its layer choosing which (`cellInstances.ts`). */
  readonly thin: boolean;
  /** A still set's: the device pixels across (by its measure, `PictureModel.measure`) a far batch's thing is drawn as its picture from and
   *  under (`propCells.ts` far ladders, the near cells choosing their own); none: every size. */
  readonly band?: readonly [number, number];
  /** A still set drawn in order (the ground cover, `cellInstances.ts` KindLevels.ordered): its cover blended with no depth written, its layer
   *  laying the far level back to front. DO NOT write a blended picture's depth there: a near tuft's faint edge hid every tuft behind it and
   *  the far grass went from dense green to sparse beige (the ground cover's ladder sheets, 2026-10-25). */
  readonly ordered?: boolean;
  /** A still set whose every atlas level is taken from its models at that level's size (`bake`), read at the level its size on the screen asks
   *  (`STILL_READ_GLSL`): an alpha-cut model looks as its own texture's mips make it at that size - a fern's fronds thin and darken far off.
   *  DO NOT give such a set the finest picture's box-filtered mips: its far ferns and clover came out twice as covered and lighter than the
   *  models they stand for (the ground cover's ladder sheets, 2026-10-25). */
  readonly perMip?: boolean;
}

/** The plants' look (`scenery.ts` foliage: rough, not metal, a dim sky): their pictures sway in their wind and thin as they shrink. */
const plantLook = (wind: WindResponse): PictureLook => ({ roughness: 0.85, metalness: 0, envMapIntensity: 0.35, wind, thin: true });

/** A plant as parts: its faceted body (`scenery.ts` foliage, flatShading) and its leaf cards, two-sided, alpha-cut on the leaves' atlas. */
function plantParts(model: ImpostorModel): PictureModel {
  const parts: PicturePart[] = [{ geometry: model.body, normals: 'faceted', side: FrontSide, casts: true }];
  if (model.cards) {
    parts.push({ geometry: model.cards, map: foliageAtlas(), alphaTest: 0.5, normals: 'vertex', side: DoubleSide, billboard: true, casts: model.cardsCast });
  }
  return { parts };
}

/** Device pixels across under which a picture is thinned: a share kept, each grown back to this size. */
export const THIN_PX = 2;
/** The margin of the share kept, over which a plant shrinks away rather than vanishing. */
const THIN_MARGIN = 0.15;

/** A plant's pick (0..1): the bits of its place hashed, as `impostorPick` hashes them on the GPU (the same float32 bits, the same integer steps). */
export function impostorPick(x: number, y: number, z: number): number {
  pickFloats[0] = x; pickFloats[1] = y; pickFloats[2] = z;
  let h = Math.imul(pickBits[0]! ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ pickBits[1]!, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h ^ pickBits[2]!, 0x27d4eb2f) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h >>> 8) / 16_777_216;
}
const pickFloats = new Float32Array(3);
const pickBits = new Uint32Array(pickFloats.buffer);

/** The share of plants this many pixels across that the pictures keep, with its margin: a plant whose pick is under it may be drawn. */
export function thinWant(across: number): number {
  const keep = Math.min(1, (across / THIN_PX) ** 2);
  return keep * (1 + THIN_MARGIN);
}

const PICK_GLSL = /* glsl */ `
  float impostorPick(vec3 p) {
    uvec3 b = floatBitsToUint(p);
    uint h = (b.x ^ 0x9e3779b9u) * 0x85ebca6bu;
    h ^= h >> 13u;
    h = (h ^ b.y) * 0xc2b2ae35u;
    h ^= h >> 16u;
    h = (h ^ b.z) * 0x27d4eb2fu;
    h ^= h >> 15u;
    return float(h >> 8u) / 16777216.0;
  }
  /** How much a plant this many pixels across is grown (0: not drawn), the share kept by its pick. */
  float impostorThin(float across, float pick) {
    float keep = min(1.0, (across / uThin.x) * (across / uThin.x));
    float grow = clamp((keep * ${(1 + THIN_MARGIN).toFixed(3)} - pick) / max(keep * ${THIN_MARGIN.toFixed(3)}, 1e-6), 0.0, 1.0);
    return grow * inversesqrt(max(keep, 1e-6));
  }
`;

export const VARYINGS = /* glsl */ `
  varying vec2 vFrameUv1;
  varying vec2 vFrameUv2;
  varying vec2 vFrameUv3;
  flat varying vec2 vFrame1;
  flat varying vec2 vFrame2;
  flat varying vec2 vFrame3;
  flat varying vec3 vWeights;
  flat varying vec2 vBlock;
`;

/** The vertex shader's declarations; `shadow`: the shadow pass's; `still`: a still set's (its far batches' band, `PictureLook.band`). */
export const vertexPars = (shadow: boolean, still: boolean): string => /* glsl */ `
  ${IMPOSTOR_FRAMES_GLSL}
  attribute vec4 aSphere;
  attribute vec2 aBlock;
  ${still ? 'attribute float aMeasure;\n  uniform vec2 uBand;' : ''}
  uniform mat4 uCullView;
  uniform vec4 uThin;
  ${VARYINGS}
  ${shadow ? '' : 'flat varying mat3 vNormalToWorld;'}
  ${PICK_GLSL}
`;

/**
 * In place of three's `begin_vertex`: `transformed` is the picture's corner in the model's own frame
 * (three's instancing and the wind place it), facing the eye - or the light, in the shadow pass.
 */
export const vertexMain = (shadow: boolean, still: boolean): string => /* glsl */ `
  vec3 transformed = vec3(0.0);
  {
    vec3 foot = instanceMatrix[3].xyz;
    mat3 shape = mat3(instanceMatrix);
    float scale = max(length(shape[0]), max(length(shape[1]), length(shape[2])));
    // Its size on the screen the instances were culled for, in device pixels: the cull's own measure (\`cellInstances.ts\`).
    vec4 cullClip = uCullView * vec4(foot, 1.0);
    float perUnit = length(vec3(uCullView[0][1], uCullView[1][1], uCullView[2][1])) * uThin.y / max(cullClip.w, 1e-4);
    float across = 2.0 * aSphere.w * scale * perUnit;
    float pick = impostorPick(foot);
    // A set that does not thin (uThin.x 0, \`PictureLook.thin\`): each picture at its own size, its layer choosing which are drawn.
    float grown = uThin.x > 0.0 ? impostorThin(across, pick) : 1.0;
    ${still ? `
    #ifdef USE_INSTANCING
    // A far batch's thing (its pose's cell, \`instanceRuns.ts\` nearCode): drawn as its picture only while its own measure on the screen
    // (\`aMeasure\`, its layer's) is in the picture's band (\`PictureLook.band\`), as the near cells choose it; the colour and the shadow alike.
    if (instancePoseB.w >= 0.0) {
      float measured = 2.0 * aMeasure * scale * perUnit;
      if (measured < uBand.x || measured >= uBand.y) grown = 0.0;
    }
    #endif` : ''}
    ${shadow ? `
    // In the shadow map: one under a texel thinned again among the ones kept, the same way.
    if (uThin.x > 0.0) {
      float texels = 2.0 * aSphere.w * scale * grown * projectionMatrix[1][1] * uThin.z;
      float kept = min(1.0, (across / uThin.x) * (across / uThin.x)) * ${(1 + THIN_MARGIN).toFixed(3)};
      float keepShadow = min(1.0, texels * texels);
      float growShadow = clamp((keepShadow * ${(1 + THIN_MARGIN).toFixed(3)} - min(pick / max(kept, 1e-6), 1.0)) / max(keepShadow * ${THIN_MARGIN.toFixed(3)}, 1e-6), 0.0, 1.0);
      grown *= growShadow * inversesqrt(max(keepShadow, 1e-6));
    }` : ''}
    if (grown > 0.0) {
      mat3 toModel = inverse(shape);
      vec3 eyeWorld = cameraPosition;
      if (projectionMatrix[2][3] == 0.0) eyeWorld = foot + vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * 1.0e5;
      vec3 eye = toModel * (eyeWorld - foot) - aSphere.xyz;
      vec3 dir = normalize(eye);
      // Never from below: the lowest pictures are level.
      dir = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z) + vec3(0.0, 1e-5, 0.0));
      vec3 qx, qy;
      frameBasis(dir, qx, qy);
      vec3 corner = (qx * position.x + qy * position.y) * (2.0 * aSphere.w);
      vec3 ray = normalize(corner - eye);
      vec2 grid = hemiOctaEncode(dir) * (FRAMES - 1.0);
      vec2 cell = min(floor(grid), vec2(FRAMES - 2.0));
      vec2 f = clamp(grid - cell, 0.0, 1.0);
      vec3 w = vec3(min(1.0 - f.x, 1.0 - f.y), abs(f.x - f.y), min(f.x, f.y));
      ${still ? `// A still set's picture from its nearest frame alone (the owner's tool's \`Mu\`): three frames blended laid three outlines over each
      // other, a solid thing seen through its own ghosts - paler and wider than its model (the ladder sheets, 2026-10-25).
      vWeights = w.x >= w.y && w.x >= w.z ? vec3(1.0, 0.0, 0.0) : w.y >= w.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);` : 'vWeights = w / max(w.x + w.y + w.z, 1e-4);'}
      vFrame1 = cell;
      vFrame2 = cell + (f.x >= f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
      vFrame3 = cell + vec2(1.0);
      vFrameUv1 = frameUv(vFrame1, eye, ray, aSphere.w);
      vFrameUv2 = frameUv(vFrame2, eye, ray, aSphere.w);
      vFrameUv3 = frameUv(vFrame3, eye, ray, aSphere.w);
      vBlock = aBlock;
      ${shadow
        ? '// Behind its own sphere from the light: the picture facing the eye is never in its own shadow.\n      corner -= dir * aSphere.w;'
        : 'vNormalToWorld = transpose(toModel);'}
      transformed = (aSphere.xyz + corner) * grown;
    }
  }
`;

export const FRAGMENT_PARS = /* glsl */ `
  ${IMPOSTOR_READ_GLSL}
  uniform vec2 uBlocks;
  ${VARYINGS}
`;

/** Each picture's uv change across the pixel, on the atlas, taken before anything is discarded. */
const FRAGMENT_SLOPES = /* glsl */ `
  vec2 impostorAtlas = FRAMES * uBlocks;
  vec2 impostorDx1 = dFdx(vFrameUv1) / impostorAtlas, impostorDy1 = dFdy(vFrameUv1) / impostorAtlas;
  vec2 impostorDx2 = dFdx(vFrameUv2) / impostorAtlas, impostorDy2 = dFdy(vFrameUv2) / impostorAtlas;
  vec2 impostorDx3 = dFdx(vFrameUv3) / impostorAtlas, impostorDy3 = dFdy(vFrameUv3) / impostorAtlas;
`;
const readOf = (atlas: string): string => /* glsl */ `(
    impostorRead(${atlas}, vFrameUv1, vFrame1, vBlock, uBlocks, impostorDx1, impostorDy1) * vWeights.x
    + impostorRead(${atlas}, vFrameUv2, vFrame2, vBlock, uBlocks, impostorDx2, impostorDy2) * vWeights.y
    + impostorRead(${atlas}, vFrameUv3, vFrame3, vBlock, uBlocks, impostorDx3, impostorDy3) * vWeights.z)`;

/** In place of three's `map_fragment`: the pictures' colour, the cover kept as the mips thin it (`farForest.ts`). */
const COLOUR_MAP = /* glsl */ `
  ${FRAGMENT_SLOPES}
  vec4 impostorColour = ${readOf('uAlbedo')};
  {
    vec2 texel = vec2(textureSize(uAlbedo, 0));
    float lod = max(0.0, 0.5 * log2(max(dot(impostorDx1 * texel, impostorDx1 * texel), dot(impostorDy1 * texel, impostorDy1 * texel))));
    float cover = impostorColour.a * (1.0 + lod * 0.3);
    cover = clamp((cover - 0.5) / max(fwidth(cover), 1e-4) + 0.5, 0.0, 1.0);
    if (cover < 0.01) discard;
    // Stored premultiplied and gamma-encoded (\`bakeColourMaterial\`); the plant's own tint is three's instance colour.
    diffuseColor = vec4(diffuseColor.rgb * pow(impostorColour.rgb / max(impostorColour.a, 1e-4), vec3(2.2)), cover);
  }
`;

/**
 * A still picture's read (`createImpostors`, no wind): its one frame (the nearest, `vertexMain`) read as the game's four samples a pixel see
 * the model - four taps at the standard 4x pattern's places in the pixel ((-2, -6), (6, -2), (-6, 2), (2, 6) sixteenths: Direct3D's and Vulkan's
 * standard sample positions), each a point of the full-size picture (its finest level: the model as taken, multisampled), averaged as the
 * multisampled model is resolved - its sample tests the picture's texels. DO NOT read it filtered over the pixel (trilinear, or a box each
 * quarter of it): the picture came out a pixel wider and as much paler than its model, a thin dark leg grey (the ladder sheets, 2026-10-25).
 */
export const STILL_READ_GLSL = /* glsl */ `
  vec2 stillUv() { return vWeights.x > 0.5 ? vFrameUv1 : vWeights.y > 0.5 ? vFrameUv2 : vFrameUv3; }
  vec2 stillFrame() { return vWeights.x > 0.5 ? vFrame1 : vWeights.y > 0.5 ? vFrame2 : vFrame3; }
  // The texel of mip level \`level\` under a point of a frame (held inside the frame, \`atlasUv\`), unfiltered.
  vec4 stillTexel(sampler2D atlas, vec2 uv, vec2 frame, int level) {
    ivec2 size = textureSize(atlas, level);
    ivec2 at = ivec2(atlasUv(uv, frame, vBlock, uBlocks, float(level)) * vec2(size));
    return texelFetch(atlas, clamp(at, ivec2(0), size - 1), level);
  }
  vec4 stillRead(sampler2D atlas, vec2 uv, vec2 frame, vec2 ux, vec2 uy) {
    // A set taken at every level (\`PictureLook.perMip\`): the level a pixel spans two texels of (taken with the model's map read as the
    // model's own pixel reads it there, \`bake\` mapBias), its texels at the four taps as they are, unfiltered: each tap the model's sample at
    // that point, as the multisampled alpha-cut model is drawn. DO NOT filter them (bilinear, or the level whose texel is the pixel): each
    // texel already holds its multisampled share, and a far fern or clover came out a pale wash two or three pixels wide where the model is
    // a few dark pixels (the ground cover's ladder sheets, 2026-10-25).
    // One exit, its value set on both ways: D3D's compiler (ANGLE) took a return inside the branch for a value left unset (X4000).
    vec4 read = vec4(0.0);
    if (uPerMip > 0.5) {
      int level = int(clamp(floor(log2(max(max(length(ux), length(uy)) * FRAME_PX, 1.0)) - 0.5), 0.0, log2(FRAME_PX)));
      read = 0.25 * (stillTexel(atlas, uv + ux * -0.125 + uy * -0.375, frame, level)
        + stillTexel(atlas, uv + ux * 0.375 + uy * -0.125, frame, level)
        + stillTexel(atlas, uv + ux * -0.375 + uy * 0.125, frame, level)
        + stillTexel(atlas, uv + ux * 0.125 + uy * 0.375, frame, level));
    } else {
      // No change across a sample: the finest level, read at a point.
      vec2 gx = vec2(0.0), gy = vec2(0.0);
      read = 0.25 * (
        impostorRead(atlas, uv + ux * -0.125 + uy * -0.375, frame, vBlock, uBlocks, gx, gy)
        + impostorRead(atlas, uv + ux * 0.375 + uy * -0.125, frame, vBlock, uBlocks, gx, gy)
        + impostorRead(atlas, uv + ux * -0.375 + uy * 0.125, frame, vBlock, uBlocks, gx, gy)
        + impostorRead(atlas, uv + ux * 0.125 + uy * 0.375, frame, vBlock, uBlocks, gx, gy));
    }
    return read;
  }
`;

/** A still picture's frame and its uv's change across the pixel, taken before anything is discarded (`STILL_READ_GLSL`). */
export const STILL_SLOPES = /* glsl */ `
  vec2 stillAt = stillUv(), stillIn = stillFrame();
  vec2 stillUx = dFdx(stillAt), stillUy = dFdy(stillAt);
`;
export const stillOf = (atlas: string): string => `stillRead(${atlas}, stillAt, stillIn, stillUx, stillUy)`;

/** A still set's colour (`createImpostors`, no wind): its cover the mips' own - each texel's share of the model as rasterised, multisampled
 *  as the game draws (`bake`), box-filtered down the mips - straight into alpha to coverage. DO NOT grow it as the plants' is grown (`COLOUR_MAP`:
 *  a foliage's cover kept as its mips thin it): a bench's bars and a lamp's column came out bolder and paler than the models they stand for. */
export const COLOUR_MAP_STILL = /* glsl */ `
  ${STILL_SLOPES}
  vec4 impostorColour = ${stillOf('uAlbedo')};
  {
    float cover = impostorColour.a;
    // Nothing of the model here: no depth written either.
    if (cover < ${(0.5 / 255).toFixed(6)}) discard;
    // Stored premultiplied and gamma-encoded (\`bakeColourMaterial\`, \`bakeWithMaterial\`): the colour a texel's cover holds, never brighter
    // than a colour can be (eight bits of a sliver's colour over eight bits of its cover).
    diffuseColor = vec4(diffuseColor.rgb * pow(min(impostorColour.rgb / max(impostorColour.a, 1e-4), vec3(1.0)), vec3(2.2)), cover);
    // A thin part's raw colour toned here as its mesh tones it (\`buildings/thinParts.ts\` thinTone), by the metres this pixel spans: over
    // the share of the texel it holds (\`b\`), with its bar and the tone behind it (their mean over that share).
    if (uHasThin > 0.5) {
      vec4 thinParts = ${stillOf('uThinParts')};
      if (thinParts.b > 1e-3) {
        float share = thinParts.b / max(thinParts.a, 1e-4);
        float bar = thinParts.r / thinParts.b * ${THIN_BAR_SCALE.toFixed(3)};
        float behind = thinParts.g / thinParts.b;
        diffuseColor.rgb = mix(diffuseColor.rgb, thinTone(diffuseColor.rgb, bar, behind, thinMetresPerPixel(-vViewPosition)), share);
      }
    }
  }
`;

/** After three's `normal_fragment_begin`: the pictures' normal, from the model's frame to the view's; `read`: how a picture is read. */
export const colourNormal = (read: string, still: boolean): string => still ? /* glsl */ `
  {
    // A still picture's normal its texel's mean, NOT made a unit again: the mean of a lit top and a shaded side, made a unit, lit the pair as
    // one face turned half to the light, brighter than the two (the ladder sheets, 2026-10-25). Its length kept, a Lambert light on it is the
    // mean of the lights on the faces it stands for, the sky's light (a hemisphere) exactly so (Toksvig, "Mipmapping Normal Maps", Journal of
    // Graphics Tools 10(3), 2005).
    vec4 packed = ${read};
    vec3 n = packed.rgb / max(packed.a, 1e-4) * 2.0 - 1.0;
    // Turned to the world by the instance's normal matrix, its length its own again (a scaled instance's matrix scales it).
    vec3 world = vNormalToWorld * n;
    world *= length(n) / max(length(world), 1e-6);
    normal = mat3(viewMatrix) * world;
    nonPerturbedNormal = normal;
  }
` : /* glsl */ `
  {
    vec4 packed = ${read};
    vec3 n = normalize(packed.rgb / max(packed.a, 1e-4) * 2.0 - 1.0);
    normal = normalize(mat3(viewMatrix) * normalize(vNormalToWorld * n));
    nonPerturbedNormal = normal;
  }
`;

/** Before three's `alphatest_fragment` in the shadow pass: the outline that throws the shadow (its casting parts', `bakeOutlineMaterial`). */
const SHADOW_CUT = /* glsl */ `
  {
    ${FRAGMENT_SLOPES}
    float impostorCover = ${readOf('uShadow')}.r;
    if (impostorCover < 0.5) discard;
    diffuseColor.a = impostorCover;
  }
`;

/** What a set's frames are taken with: the scene and the camera they are drawn by, each model's sphere, the atlas's blocks across. */
export interface PictureFrames { readonly scene: Scene; readonly camera: OrthographicCamera; readonly pictures: readonly Picture[]; readonly blocks: { readonly x: number } }

/** Every frame of every model of `frames` drawn into `target`, a frame `framePx` texels across (`createImpostors`, `buildings/partPictures.ts`):
 *  model `k`'s meshes put in the cleared scene by `fill`, `atLast` run before the last frame is drawn. */
export function takePictureFrames(renderer: WebGLRenderer, target: WebGLRenderTarget, framePx: number, frames: PictureFrames, fill: (k: number) => void, atLast: (() => void) | null): void {
  const { scene, camera, pictures, blocks } = frames;
  const direction = new Vector3(), tangent = new Vector3(), bitangent = new Vector3();
  // Made with every mip level (three allocates them by `generateMipmaps` when the target is first set), made once after the last picture.
  target.scissorTest = false;
  target.viewport.set(0, 0, target.width, target.height);
  renderer.setRenderTarget(target);
  for (const t of target.textures) t.generateMipmaps = false;
  renderer.clear(true, true, true);
  target.scissorTest = true;
  const last = pictures.length * FRAMES * FRAMES - 1;
  let taken = 0;
  pictures.forEach(({ centre, radius: r }, k) => {
    scene.clear();
    fill(k);
    camera.left = -r; camera.right = r; camera.top = r; camera.bottom = -r;
    camera.near = 0.01 * r; camera.far = 4 * r;
    camera.updateProjectionMatrix();
    const bx = (k % blocks.x) * FRAMES * framePx, by = Math.floor(k / blocks.x) * FRAMES * framePx;
    for (let row = 0; row < FRAMES; row++) {
      for (let col = 0; col < FRAMES; col++) {
        hemiOctaDirection(col / (FRAMES - 1), row / (FRAMES - 1), direction);
        frameBasis(direction, tangent, bitangent);
        camera.position.copy(centre).addScaledVector(direction, 2 * r);
        camera.up.copy(bitangent);
        camera.lookAt(centre);
        camera.updateMatrixWorld();
        const x = bx + col * framePx, y = by + row * framePx;
        target.viewport.set(x, y, framePx, framePx);
        target.scissor.set(x, y, framePx, framePx);
        renderer.setRenderTarget(target);
        if (taken++ === last && atLast) atLast();
        renderer.render(scene, camera);
      }
    }
  });
  target.scissorTest = false;
  target.viewport.set(0, 0, target.width, target.height);
}

export interface PlantImpostors {
  /** Each model's quad: four corners, its sphere and its block on the atlas in their attributes. */
  readonly quads: readonly BufferGeometry[];
  /** The atlas's colour and normal pictures, its blocks across and down, and each model's sphere (one unit tall): what the far woods draw from too (`farForest.ts`). */
  readonly albedo: Texture;
  readonly normals: Texture;
  readonly blocks: { readonly x: number; readonly y: number };
  readonly spheres: readonly { readonly centre: Vector3; readonly radius: number }[];
  /** Each model's sphere radius, one unit tall: the size a plant's level is chosen by (`cellInstances.ts`). */
  readonly reach: readonly number[];
  readonly material: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
  /** The view the instances were culled for and half the screen's height, device pixels: what the pictures thin by. */
  setView(view: Matrix4, halfHeight: number): void;
  /** Whether the pictures are taken (`takeWaitingPictures`): until then the plants are drawn whole. */
  ready(): boolean;
  /** A mesh drawn with the pictures: the shadow map's size read before its shadow. */
  attach(mesh: InstancedMesh): void;
  dispose(): void;
}

/** Picture sets not taken yet: taken at the next `takeWaitingPictures`. */
const waiting = new Set<(renderer: WebGLRenderer) => void>();

/** Takes the pictures of every set made since, between draws (`farForest.ts` `update`, as it takes its own): never inside a draw. */
export function takeWaitingPictures(renderer: WebGLRenderer): void {
  for (const take of [...waiting]) take(renderer);
}

/** A set of pictures made outside this file (`buildings/partPictures.ts`) taken with the others at the next `takeWaitingPictures`; what it gives back takes it off the list. */
export function waitForPictures(take: (renderer: WebGLRenderer) => void): () => void {
  waiting.add(take);
  return () => { waiting.delete(take); };
}

/** The pictures of these plants, taken at the next `takeWaitingPictures`, swaying in `wind`; `key` says whose; `ownModels`: the models' geometries let go once taken. */
export function createPlantImpostors(models: readonly ImpostorModel[], wind: WindResponse, key: string, ownModels = false): PlantImpostors {
  return createImpostors(models.map(plantParts), plantLook(wind), key, ownModels);
}

/** The most models one set's atlas holds (4 x 4 blocks of `FRAMES` x `FRAME_PX`, 2,048 texels a side): more make a set a group, every set one program. */
export const SET_MODELS = 16;

/** The pictures of these models, taken at the next `takeWaitingPictures`, drawn with `look`; `key` says whose; `ownModels`: the models' geometries let go once taken. */
export function createImpostors(models: readonly PictureModel[], look: PictureLook, key: string, ownModels = false): PlantImpostors {
  if (models.length > SET_MODELS) throw new Error(`createImpostors: ${models.length} models in one set (${SET_MODELS} at most: a set per group)`);
  const pictures = models.map(pictureOf);
  // Each model's measure, model units across: its layer's (`PictureModel.measure`), else its picture's sphere.
  const measures = models.map((model, k) => model.measure ?? 2 * pictures[k]!.radius);
  /** A still set's pictures, sized by their layer's own measure: its far batches' band (`vertexMain`). */
  const still = !look.wind;
  /** A still set with thin parts (`PicturePart.thin`): a third picture, their raw colours' bar and tone behind (`THIN_BAR_SCALE`). */
  const thinSet = still && models.some((model) => model.parts.some((part) => part.thin));
  const blocks = layoutOf(models.length);
  const block = FRAMES * FRAME_PX;
  /** The atlas's mips only where read (the plants', `COLOUR_MAP`, `farForest.ts`; a `perMip` set's): any other still set reads level 0 alone
   *  (`STILL_READ_GLSL`), its chain a third more held for nothing (three r186 getMipLevels). The outline keeps its own: `SHADOW_CUT` reads them. */
  const atlasLevels = !still || look.perMip === true;
  // Two pictures per view, the colour and the normal; and the outline that throws the shadow. DO NOT keep a depth buffer the size of the atlas for its life: it is drawn once (`bake`, a target of its own with depth).
  const atlas = new WebGLRenderTarget(blocks.x * block, blocks.y * block, { count: thinSet ? 3 : 2, depthBuffer: false, generateMipmaps: atlasLevels });
  // A set with no thin part reads a picture of none (one program for every still set: `COLOUR_MAP_STILL` asks `uHasThin`).
  const noThin = new DataTexture(new Uint8Array(4), 1, 1);
  noThin.needsUpdate = true;
  const outline = new WebGLRenderTarget(blocks.x * block, blocks.y * block, { format: RedFormat, depthBuffer: false, generateMipmaps: true });
  for (const t of [...atlas.textures, outline.texture]) { t.minFilter = atlasLevels || t === outline.texture ? LinearMipmapLinearFilter : LinearFilter; t.magFilter = LinearFilter; }
  const uniforms = {
    uAlbedo: { value: atlas.textures[0]! },
    uNormals: { value: atlas.textures[1]! },
    uThinParts: { value: thinSet ? atlas.textures[2]! : noThin },
    uHasThin: { value: thinSet ? 1 : 0 },
    uPerMip: { value: look.perMip === true ? 1 : 0 },
    uShadow: { value: outline.texture },
    uBlocks: { value: new Vector2(blocks.x, blocks.y) },
    uCullView: { value: new Matrix4() },
    // Pixels under which pictures thin; half the screen's height, device pixels; half the shadow map's, texels.
    // 0 for a set that does not thin (`PictureLook.thin`).
    uThin: { value: new Vector4(look.thin ? THIN_PX : 0, 540, 2048, 0) },
    // The pixels a still set's far batches draw a picture between (`PictureLook.band`; none: every size).
    uBand: { value: new Vector2(look.band?.[0] ?? 0, look.band?.[1] ?? Number.MAX_VALUE) },
  };

  // A still set's cover blended over what is behind it (its depth written, in three's transparent pass: a near one hides what stands behind it): its fractions as they are. DO NOT
  // give it to alpha to coverage, as the plants' (their cover cut at a half, `COLOUR_MAP`): a fraction becomes so many of a pixel's samples,
  // fewer than its share on this GPU, and a picture lost half its ink - the bench, the drain drawn near white (the ladder sheets,
  // `src/lab/propLadderSheet.ts` propPictureDiagnosis, 2026-10-25).
  const material = new MeshStandardMaterial({
    roughness: look.roughness, metalness: look.metalness, envMapIntensity: look.envMapIntensity,
    ...(look.wind ? { alphaToCoverage: true } : { transparent: true, depthWrite: look.ordered !== true }),
  });
  // The quad faces the light in the shadow pass: three would draw only its back.
  material.shadowSide = DoubleSide;
  if (look.wind) applyWind(material, look.wind, `${key}-impostor`);
  const windColour = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    windColour(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars(false, still)}`)
      .replace('#include <begin_vertex>', vertexMain(false, still));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}\nuniform sampler2D uAlbedo;\nuniform sampler2D uNormals;\nflat varying mat3 vNormalToWorld;${still ? `\nuniform sampler2D uThinParts;\nuniform float uHasThin;\nuniform float uPerMip;\n${THIN_TONE_GLSL}\n${STILL_READ_GLSL}` : ''}`)
      .replace('#include <map_fragment>', still ? COLOUR_MAP_STILL : COLOUR_MAP)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${colourNormal(still ? stillOf('uNormals') : readOf('uNormals'), still)}`);
  };
  // One program for every set of pictures that sways (the scenery's, the nature's) and one for every still set (the street props', the ground
  // cover's): the same code, their atlas, blocks and surface uniforms. DO NOT key it by the set.
  const program = look.wind ? 'plant-impostor' : 'static-impostor';
  material.customProgramCacheKey = () => program;

  // No colour: the cascades compare their depth texture (`sunCascades.ts` cascadeMap); a still set's is never marked as a mover (`wind.ts` markSway).
  const depth = look.wind ? windDepthMaterial(look.wind, `${key}-impostor`) : new MeshDepthMaterial({ colorWrite: false });
  const windDepth = depth.onBeforeCompile.bind(depth);
  depth.onBeforeCompile = (shader, renderer) => {
    windDepth(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars(true, still)}`)
      .replace('#include <begin_vertex>', vertexMain(true, still));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}\nuniform sampler2D uShadow;`)
      .replace('#include <alphatest_fragment>', `${SHADOW_CUT}\n#include <alphatest_fragment>`);
  };
  depth.customProgramCacheKey = () => `${program}-depth`;

  const quads = pictures.map((picture, k) => pictureQuad(picture, k, blocks, still ? measures[k]! : null));

  let baked = false;
  let unlisten: (() => void) | null = null;
  /** The pictures taken between draws (the far woods' own way, `farForest.ts` `takePictures`), again after a lost context (`contextRestored.ts`:
   *  the park's palms were gone after one, audit 2026-10-25), the atlas's levels allocated as it was first made. */
  const bake = (renderer: WebGLRenderer): void => {
    baked = true;
    waiting.delete(bake);
    unlisten ??= onContextRestored(renderer, () => { waiting.add(bake); });
    for (const t of atlas.textures) t.generateMipmaps = atlasLevels;
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    const scene = new Scene();
    // Each part's materials, made for this drawing and let go after it.
    // An alpha-cut set's map read a mip coarser than each level's texels: a level is drawn where a pixel spans two of them (\`STILL_READ_GLSL\`).
    const colours = models.map((model) => model.parts.map((part) => bakeMaterialsOf(part, thinSet, look.perMip === true ? 1 : 0).colour));
    const shadows = models.map((model) => model.parts.map((part) => (part.casts ? bakeMaterialsOf(part, thinSet).outline : null)));
    const was = {
      target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
      shadows: renderer.shadowMap.autoUpdate, colour: renderer.getClearColor(new Color()),
    };
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    // The colour and normal pictures drawn with a depth buffer that lives only as long as the drawing: copied onto the atlas after.
    // A still set's multisampled as the game draws (its edges' texels hold their rasterised share: the cover `COLOUR_MAP_STILL` reads); an
    // alpha-cut set's (`PictureLook.perMip`) a sample a texel, its levels read at half a pixel a texel, four taps a pixel: the game's four
    // samples, not four times four (its far clover came out smoother and paler than the model's, 2026-10-25); the plants' as they always were.
    const samples = still && look.perMip !== true ? BAKE_SAMPLES : 0;
    const drawn = new WebGLRenderTarget(atlas.width, atlas.height, { count: atlas.textures.length, depthBuffer: true, generateMipmaps: false, samples });
    const frames: PictureFrames = { scene, camera, pictures, blocks };
    /** Every frame of every model drawn into `target`, a frame `framePx` texels across (`takePictureFrames`): each part with its pass's material;
     *  the outline's mips made after its last picture, the colour's on the atlas, once copied. */
    const takeFrames = (target: WebGLRenderTarget, pass: 'colour' | 'shadow', framePx: number): void => takePictureFrames(renderer, target, framePx, frames, (k) => {
      models[k]!.parts.forEach((part, p) => {
        const drawnWith = pass === 'colour' ? colours[k]![p]! : shadows[k]![p];
        if (drawnWith) scene.add(new Mesh(part.geometry, drawnWith));
      });
    }, target === outline ? () => { outline.texture.generateMipmaps = true; } : null);
    takeFrames(drawn, 'colour', FRAME_PX);
    takeFrames(outline, 'shadow', FRAME_PX);
    scene.clear();
    renderer.initRenderTarget(atlas);
    if (look.perMip === true) {
      // Every level taken from the models at its own size, sampled as the finest (`PictureLook.perMip`), and copied to its level of the
      // atlas (three r186 `copyTextureToTexture` dstLevel). The levels were made with the atlas (`generateMipmaps` when it was first set),
      // never made again from the finest.
      for (const t of atlas.textures) t.generateMipmaps = false;
      for (let i = 0; i < atlas.textures.length; i++) renderer.copyTextureToTexture(drawn.textures[i]!, atlas.textures[i]!);
      for (let level = 1; FRAME_PX >> level >= 1; level++) {
        const taken = new WebGLRenderTarget(atlas.width >> level, atlas.height >> level, { count: atlas.textures.length, depthBuffer: true, generateMipmaps: false, samples });
        takeFrames(taken, 'colour', FRAME_PX >> level);
        for (let i = 0; i < atlas.textures.length; i++) renderer.copyTextureToTexture(taken.textures[i]!, atlas.textures[i]!, null, null, 0, level);
        taken.dispose();
      }
    } else {
      // The pictures onto the atlas, and its mips (if any) made by a draw of nothing into it (three r186 `render` ends with `updateRenderTargetMipmap`).
      for (let i = 0; i < atlas.textures.length; i++) renderer.copyTextureToTexture(drawn.textures[i]!, atlas.textures[i]!);
      if (atlasLevels) { renderer.setRenderTarget(atlas); renderer.render(scene, camera); }
    }
    drawn.dispose();
    if (ownModels) for (const model of models) for (const part of model.parts) part.geometry.dispose();
    renderer.setRenderTarget(was.target);
    renderer.setClearColor(was.colour, was.alpha);
    renderer.autoClear = was.autoClear;
    renderer.shadowMap.autoUpdate = was.shadows;
    for (const m of [...colours.flat(), ...shadows.flat()]) m?.dispose();
  };

  waiting.add(bake);
  const viewport = new Vector4();
  return {
    quads,
    albedo: atlas.textures[0]!,
    normals: atlas.textures[1]!,
    blocks,
    spheres: pictures,
    reach: measures.map((x) => x / 2),
    material,
    depth,
    setView(view, halfHeight) {
      uniforms.uCullView.value.copy(view);
      uniforms.uThin.value.y = halfHeight;
    },
    ready: () => baked,
    attach(mesh) {
      const shadow = mesh.onBeforeShadow.bind(mesh);
      mesh.onBeforeShadow = (renderer, ...rest) => {
        // The shadow map is the target being drawn: its height, texels.
        uniforms.uThin.value.z = renderer.getCurrentViewport(viewport).w / 2;
        shadow(renderer, ...rest);
      };
    },
    dispose() {
      waiting.delete(bake);
      unlisten?.();
      for (const q of quads) q.dispose();
      material.dispose();
      depth.dispose();
      atlas.dispose();
      outline.dispose();
      noThin.dispose();
    },
  };
}

/** The trees' wind on their pictures (`scenery.ts` TREE_WIND, `natureTrees.ts` FOREST_WIND: the same breeze). */
export const PICTURE_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

/** Device pixels across under which a plant is drawn as its picture (the frames are `FRAME_PX` wide: never magnified past it). */
export const PICTURE_PX = 48;

/** The gardens' and the street's plants' pictures: the scenery's models, its trees then its bushes. */
export interface SceneryPictures {
  readonly set: PlantImpostors;
  treeAt(species: TreeSpecies): number;
  bushAt(kind: BushKind): number;
  /** Let go by a layer: the pictures go with the last one. */
  release(): void;
}

/** The plants of the scenery's kit the pictures are made of (`scenery.ts` SceneryKit): only these, so this file does not import the kit, which imports the poses that import the pictures. */
interface PlantModels {
  readonly trees: Readonly<Record<TreeSpecies, BufferGeometry>>;
  readonly bushes: Readonly<Record<BushKind, BufferGeometry>>;
  readonly cards: Readonly<Partial<Record<TreeSpecies | BushKind, BufferGeometry>>>;
}

const sceneryShared = new WeakMap<PlantModels, { set: PlantImpostors; users: number }>();
/** One set of pictures for the gardens and the street (`gardens.ts`, `streetFurnitureLayer.ts`): one atlas, one program. */
export function sceneryPictures(kit: PlantModels): SceneryPictures {
  let shared = sceneryShared.get(kit);
  if (!shared) {
    const models: ImpostorModel[] = [
      ...TREE_SPECIES.map((s) => ({ body: kit.trees[s], cards: kit.cards[s] ?? null, cardsCast: false })),
      ...BUSH_KINDS.map((k) => ({ body: kit.bushes[k], cards: kit.cards[k] ?? null, cardsCast: false })),
    ];
    sceneryShared.set(kit, shared = { set: createPlantImpostors(models, PICTURE_WIND, 'scenery'), users: 0 });
  }
  shared.users++;
  const held = shared;
  let released = false;
  return {
    set: held.set,
    treeAt: (species) => TREE_SPECIES.indexOf(species),
    bushAt: (kind) => TREE_SPECIES.length + BUSH_KINDS.indexOf(kind),
    release() {
      if (released) return;
      released = true;
      if (--held.users > 0) return;
      held.set.dispose();
      sceneryShared.delete(kit);
    },
  };
}

/** A still model's look from its near material: the same surface values, no wind, drawn at its own size (`PictureLook`). */
export function stillLook(material: { readonly roughness: number; readonly metalness: number; readonly envMapIntensity: number }): PictureLook {
  return { roughness: material.roughness, metalness: material.metalness, envMapIntensity: material.envMapIntensity, wind: null, thin: false };
}

/** The street props pictured (`streetFurnitureLayer.ts`), in the set's order: every solid prop of the furniture (not the lamps' glows). */
export const PROP_PICTURES = ['lamp', 'bin', 'bench', 'hydrant', 'postbox', 'phone', 'drain', 'treePit'] as const;
export type PropPicture = (typeof PROP_PICTURES)[number];

/** The props of the scenery's kit the pictures are made of (`scenery.ts` SceneryKit), each with whether it throws a shadow, and the material
 *  they are drawn with near: only these, so this file does not import the kit. */
export interface PropModels {
  readonly geometry: Readonly<Record<PropPicture, BufferGeometry>>;
  readonly casts: Readonly<Record<PropPicture, boolean>>;
  /** Each one's measure, model units across (`PictureModel.measure`, `propLevels.ts` propMeasure). */
  readonly measure: Readonly<Record<PropPicture, number>>;
  /** Their near material (`scenery.ts` props): their pictures taken with it, drawn with its surface (`stillLook`). */
  readonly material: MeshStandardMaterial;
  /** The pixels a far batch draws a prop as its picture between (`PictureLook.band`). */
  readonly band: readonly [number, number];
}

/** The street props' pictures: one atlas, the still program. */
export interface PropPictures {
  readonly set: PlantImpostors;
  at(prop: PropPicture): number;
  release(): void;
}

/** The street props' pictures (`streetFurnitureLayer.ts` PropLadder): each prop's one part as its material draws it (vertex colours, smooth
 *  normals), measured by its layer's measure, its far batches' band. Made for the one layer that draws them; let go with it. */
export function propPictures(kit: PropModels): PropPictures {
  const models: PictureModel[] = PROP_PICTURES.map((prop) => ({
    parts: [{ geometry: kit.geometry[prop], normals: 'vertex', side: kit.material.side, casts: kit.casts[prop], material: kit.material }],
    measure: kit.measure[prop],
  }));
  const set = createImpostors(models, { ...stillLook(kit.material), band: kit.band }, 'props');
  let released = false;
  return {
    set,
    at: (prop) => PROP_PICTURES.indexOf(prop),
    release() {
      if (released) return;
      released = true;
      set.dispose();
    },
  };
}
