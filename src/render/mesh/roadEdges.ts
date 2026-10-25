import { Color, type Material, MeshStandardMaterial, type Texture } from 'three';
import { MOST_LINES, ROAD_PAINT_ROW, SLOT_TEXELS, roadPaint } from '../roadPaint';
import { roadMarks } from '../roadMarks';
import { ROAD_MARKS_COLOR, ROAD_MARKS_METALNESS, ROAD_MARKS_NORMAL, ROAD_MARKS_PARS } from '../roadMarksShader';
import { DETAIL_ARRAY_GLSL, DETAIL_GLSL, detailSwitch } from './detailLayer';
import { STREET_MEANS } from '../roadTones';

/** WHERE A STREET IS DIRTY AND WHERE IT IS WORN */

/** Where a material says its shader reads the `roadSection` attribute: no other surface is given it (`surfaceTiles.ts`). */
const SECTION = 'readsRoadSection';
export const readsRoadSection = (material: Material): boolean => material.userData[SECTION] === true;
/** Gives `material`'s surfaces the `roadSection` attribute: its shader reads it. */
export function marksRoadSection(material: Material): void {
  material.userData[SECTION] = true;
}

/** The carriageway's lines along its roads (`roadPaint.ts`), read from the paint's table: each line's coverage of the pixel's footprint across and
 *  along (a box filter, Quilez, https://iquilezles.org/articles/filterableprocedurals), the broken ones by the integral of their pattern
 *  F(x) = floor(x / P) d + min(mod(x, P), d) over it, so a dash under a pixel turns to the pattern's mean and never flickers; the paint worn as its
 *  own material wore it. The footprints are taken before any branch (derivatives are undefined in non-uniform flow). The marks on the road come
 *  after them (`roadMarksShader.ts`): its crossings, stop lines, arrows, legends, parking, tapers and islands, no polygon of paint either. */
const CARRIAGEWAY_PAINT = `
  {
    float across = vRoadSection.x, along = vRoadSection.y;
    float wAcross = max(fwidth(across), 1e-4), wAlong = max(fwidth(along), 1e-4);
    vec2 wPaint = vRoadWorld.xz;
    float pxPaint = length(fwidth(wPaint));
    int road = int(floor(vRoadPaintSlot + 0.5));
    if (road >= 0) {
      int at = road * ${SLOT_TEXELS};
      ivec2 cell = ivec2(at % ${ROAD_PAINT_ROW}, at / ${ROAD_PAINT_ROW});
      vec4 head = texelFetch(uRoadSegments, cell, 0);
      vec4 size = texelFetch(uRoadSegments, cell + ivec2(1, 0), 0);
      roadHalf = size.x; roadLane = size.y;
      int profile = int(floor(head.w + 0.5));
      if (profile >= 0) {
        // The painted stretch between its stop lines, its share of the pixel along.
        float inStretch = clamp((min(head.y, along + 0.5 * wAlong) - max(head.x, along - 0.5 * wAlong)) / wAlong, 0.0, 1.0);
        // The broken lines' pattern, its share of the pixel inked.
        vec2 ends = along + head.z + vec2(-0.5, 0.5) * wAlong;
        vec2 inkTo = floor(ends / max(size.w, 1e-3)) * size.z + min(mod(ends, max(size.w, 1e-3)), size.z);
        float inked = size.w > 0.0 ? clamp((inkTo.y - inkTo.x) / wAlong, 0.0, 1.0) : 1.0;
        int count = int(texelFetch(uRoadLines, ivec2(0, profile), 0).x + 0.5);
        for (int k = 0; k < ${MOST_LINES}; k++) {
          if (k >= count) break;
          vec4 line = texelFetch(uRoadLines, ivec2(1 + k * 2, profile), 0);
          vec4 tone = texelFetch(uRoadLines, ivec2(2 + k * 2, profile), 0);
          float cover = clamp((min(line.x + line.y, across + 0.5 * wAcross) - max(line.x - line.y, across - 0.5 * wAcross)) / wAcross, 0.0, 1.0);
          cover *= inStretch * (line.z > 0.5 ? inked : 1.0);
          if (cover <= 0.0) continue;
          // Worn: pinholes of asphalt through it, wider where it is worn, faded as the eye sees it finer.
          float grainP = roadPaintNoise(wPaint * 9.0);
          float worn = roadPaintNoise(wPaint * 0.7) * 0.6 + roadPaintNoise(wPaint * 2.3) * 0.4;
          float flake = roadPaintNoise(wPaint * 5.0);
          float fineSeen = 1.0 - smoothstep(0.015, 0.045, pxPaint);
          float grainSeen = 1.0 - smoothstep(0.04, 0.12, pxPaint);
          float flakeSeen = 1.0 - smoothstep(0.08, 0.2, pxPaint);
          float wear = 1.0 - 0.35 * smoothstep(0.55, 0.85, worn) * mix(0.5, smoothstep(0.4, 0.7, grainP), grainSeen);
          wear *= 1.0 - 0.25 * mix(0.14, step(0.86, roadPaintNoise(wPaint * 22.0)), fineSeen);
          if (flake < 0.05) wear *= mix(1.0, 0.45, flakeSeen);
          float a = cover * wear * 0.92;
          diffuseColor.rgb = mix(diffuseColor.rgb, tone.rgb * (0.86 + 0.14 * roadPaintNoise(wPaint * 1.3)), a);
          roadPaintCover = max(roadPaintCover, a);
        }
      }
    }
  }`;

/** The surface's own grain read as the old programs read it: their colour map at 2.7 times its tile, none without one. */
const GRAIN_OWN = `
    #ifdef USE_MAP
    float grain = texture2D(map, vMapUv * 2.7).r;
    #else
    float grain = 0.5;
    #endif`;

/** The carriageway's dirt along its kerbs and its wheel tracks, under its paint (`CARRIAGEWAY_PAINT` first); `grain` declares its grain. */
const carriagewayDirt = (grain: string): string => `if (roadHalf > 0.0) {${grain}
    // Metres from the kerb's face (under the paint: the dirt is on the asphalt, the paint over it keeps its own tone).
    float keep = 1.0 - roadPaintCover;
    float edge = roadHalf - abs(vRoadSection.x);
    float gutter = 1.0 - smoothstep(0.05, 0.65, edge);
    diffuseColor.rgb *= 1.0 - 0.3 * gutter * (0.6 + 0.8 * grain) * keep;
    diffuseColor.rgb *= mix(vec3(1.0), vec3(1.06, 0.99, 0.9), gutter * 0.6 * keep);
    float lane = roadLane;
    if (lane > 0.5 && edge > 0.0) {
      // Each lane from its kerb side: its middle, its wheel tracks 0.85 m either side.
      float centre = abs(mod(edge, lane) - 0.5 * lane);
      float tracks = exp(-pow((centre - 0.85) / 0.3, 2.0));
      float oil = exp(-pow(centre / 0.32, 2.0));
      diffuseColor.rgb *= 1.0 + (0.11 * tracks - 0.14 * oil * (0.7 + 0.6 * grain)) * keep;
    }
  }`;

/** The footway's wear along its kerb and its lot, where `on` holds; `grain` declares its grain. */
const footwayMarks = (on: string, grain: string): string => `
  if (${on}) {
    // The asphalt's own grain as noise, so no band is an even stripe.${grain}
    // Metres from the kerb's back, and the footway's width to the lot.
    float fromKerb = vRoadSection.x, width = vRoadSection.y;
    float nearKerb = 1.0 - smoothstep(0.1, 0.6, fromKerb);
    float nearLot = 1.0 - smoothstep(0.0, 0.55, width - fromKerb);
    float walked = exp(-pow((fromKerb - 0.5 * width) / max(0.22 * width, 0.3), 2.0));
    diffuseColor.rgb *= (1.0 - 0.2 * nearKerb * (0.6 + 0.8 * grain)) * (1.0 - 0.24 * nearLot * (0.6 + 0.8 * grain)) * (1.0 + 0.07 * walked);
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.9, 1.0, 0.86), nearLot * 0.4);
  }`;

/** The stone's top in its one colour, where no baked map is drawn (`roadSheetMaterial`). */
const KERB_FLAT = `
  diffuseColor.rgb = mix(diffuseColor.rgb, uKerbColour, kerbTop);`;

/**
 * # EVERY ROAD SURFACE IN ONE MATERIAL (`applyRoadSurface`)
 *
 * The carriageway, its raised crossings, the footway (its ramps, a median's paving), the kerb's faces (a median's kerb), a median's planting and a deck's
 * edge drawn by one program, a draw a block where each took one of its own (the owner's road tool draws a whole network in one mesh, its surfaces told
 * apart by a vertex attribute). Each vertex carries its surface's code (`ROAD_CODE`, `roadSection`'s fourth number, written as a block is merged:
 * `surfaceTiles.ts`), and the pixel reads its surface's rows of the look table (`RoadLook`): its layer of the colour array and of the relief array
 * (normals, then roughness: `bake/catalogue.ts` roadArrays), how many times its texture repeats in its layer (its uv shrunk by as much reads the same
 * texels at the same mip level as its own texture did), its normals' strength, its metalness and its close-zoom layer's family and numbers
 * (`mesh/detailLayer.ts`). Each surface is drawn as its own material drew it, number for number: the carriageway's lines, marks and dirt, the
 * footway's wear and its kerb stone's top, the same reads in the same order.
 */

/** The surfaces the road material draws, by the code each vertex carries. */
export const ROAD_CODE = { carriageway: 0, raised: 1, footway: 2, kerb: 3, planting: 4, deck: 5 } as const;
export type RoadCode = (typeof ROAD_CODE)[keyof typeof ROAD_CODE];
const ROAD_CODES = 6;
/** Rows of four numbers a surface takes in the look table (`RoadLook`). */
const LOOK_ROWS = 3;

/** How one surface of the road material is drawn: what its own material held. */
export interface RoadLook {
  /** Its colour's layer in the colour array; -1, the footway's own colour and relief (`RoadMaps`). */
  readonly colour: number;
  /** Its normal's and its roughness' layers in the relief array (the footway's: 0 and 1 of its own). */
  readonly normal: number;
  readonly rough: number;
  /** Times its texture repeats across its layer (`bake/catalogue.ts` tiledTexels). */
  readonly tiles: number;
  readonly normalScale: number;
  readonly metalness: number;
  /** Its close-zoom layer (`mesh/detailLayer.ts` DetailSpec): its family's layer in the details' array, and its numbers. */
  readonly detail: { readonly layer: number; readonly macroTile: number; readonly repeat: number; readonly albedo: number; readonly normal: number; readonly macroBlur: number };
}

/** The road material's textures (`bake/catalogue.ts` roadArrays). */
export interface RoadMaps {
  readonly colours: Texture;
  readonly relief: Texture;
  readonly footwayColour: Texture;
  readonly footwayRelief: Texture;
  readonly details: Texture;
  /** Layers on from a family's colour to its normal in the details' array. */
  readonly detailNormals: number;
}

/** Each surface's rows of the look table, in code order. */
function roadLookTable(looks: readonly RoadLook[]): Float32Array {
  const table = new Float32Array(ROAD_CODES * LOOK_ROWS * 4);
  looks.forEach((l, code) => {
    table.set([l.colour, l.normal, l.rough, 1 / l.tiles, l.normalScale, l.metalness, l.detail.macroTile, l.detail.layer,
      l.detail.repeat, l.detail.albedo, l.detail.normal, l.detail.macroBlur], code * LOOK_ROWS * 4);
  });
  return table;
}

/** The tangent frame three makes for a normal map without tangents (r186 `normalmap_pars_fragment` getTangentFrame, C. Schueler, "Normal Mapping
 *  Without Precomputed Tangents"): the road's, and the structures' that read its layers (`applyRoadLayers`). */
const TANGENT_FRAME = `
mat3 roadTangentFrame(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz);
  vec3 q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st);
  vec2 st1 = dFdy(uv.st);
  vec3 N = surf_norm;
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}`;

/** The pixel's surface's rows (`roadLookTable`): A (colour layer, normal layer, roughness layer, uv scale), B (normal scale, metalness, macro tile,
 *  detail layer), C (detail repeat, detail albedo, detail normal, macro blur); its colour and relief reads, the footway from its own maps; and the
 *  tangent frame (`TANGENT_FRAME`). */
const ROAD_LOOK_PARS = `
uniform vec4 uRoadLooks[${ROAD_CODES * LOOK_ROWS}];
uniform highp sampler2DArray uRoadColours;
uniform highp sampler2DArray uRoadRelief;
uniform sampler2D uFootwayColour;
uniform highp sampler2DArray uFootwayRelief;
#ifdef ROAD_DETAIL
uniform highp sampler2DArray uRoadDetails;
#endif
uniform float uRoadDetailNormals;
uniform float uKerbRepeat;
flat varying int vRoadCode;
varying vec2 vRoadUv;
vec4 roadLookA = vec4(0.0), roadLookB = vec4(0.0), roadLookC = vec4(0.0);
vec4 roadColour(vec2 uv, float bias) {
  return roadLookA.x < 0.0 ? texture(uFootwayColour, uv, bias) : texture(uRoadColours, vec3(uv * roadLookA.w, roadLookA.x), bias);
}
vec4 roadRelief(vec2 uv, float footwayLayer, float layer, float bias) {
  return roadLookA.x < 0.0 ? texture(uFootwayRelief, vec3(uv, footwayLayer), bias) : texture(uRoadRelief, vec3(uv * roadLookA.w, layer), bias);
}${TANGENT_FRAME}`;

/** In place of three's `map_fragment`: the surface's rows, its colour map biased by the close-zoom layer's blur and the layer's albedo over it
 *  (the close-zoom layer's reads as each surface's own material made them, in their order: `mesh/detailLayer.ts` DETAIL_ARRAY_GLSL). */
const ROAD_MAP = `
  int roadCode = vRoadCode;
  roadLookA = uRoadLooks[roadCode * ${LOOK_ROWS}];
  roadLookB = uRoadLooks[roadCode * ${LOOK_ROWS} + 1];
  roadLookC = uRoadLooks[roadCode * ${LOOK_ROWS} + 2];
#ifdef ROAD_DETAIL
  float detailW = detailWeight(vRoadUv * roadLookB.z);
#else
  float detailW = 0.0;
#endif
  vec2 detailUv = vRoadUv * roadLookC.x;
  vec4 sampledDiffuseColor = roadColour(vRoadUv, detailW * roadLookC.w);
  vec2 detailDx = dFdx(detailUv), detailDy = dFdy(detailUv);
#ifdef ROAD_DETAIL
  if (detailW > 0.0) {
    vec3 detailAlbedo = detailSampleArray(uRoadDetails, detailUv, roadLookB.w, detailDx, detailDy);
    sampledDiffuseColor.rgb *= mix(vec3(1.0), detailAlbedo, detailW * roadLookC.y);
  }
#endif
  diffuseColor *= sampledDiffuseColor;`;

/** The surface's own grain (`GRAIN_OWN`), from its colour map. */
const GRAIN_ARRAY = `
    float grain = roadColour(vRoadUv * 2.7, 0.0).r;`;

/** After three's `normal_fragment_begin`: the tangent frame three made there for a normal map. */
const ROAD_TBN = `
  mat3 tbn = roadTangentFrame(-vViewPosition, normal, vRoadUv);`;

/** In place of three's `normal_fragment_maps`: the relief's normal, its strength, the close-zoom layer's normals. */
const ROAD_NORMAL = `
  vec3 mapN = roadRelief(vRoadUv, 0.0, roadLookA.y, detailW * roadLookC.w).xyz * 2.0 - 1.0;
  mapN.xy *= roadLookB.x;
#ifdef ROAD_DETAIL
  if (detailW > 0.0) {
    vec3 fineN = detailNormalArray(uRoadDetails, detailUv, roadLookB.w + uRoadDetailNormals, detailDx, detailDy);
    mapN.xy += fineN.xy * roadLookC.z * detailW;
  }
#endif
  normal = normalize(tbn * mapN);`;

/** In place of three's `roughnessmap_fragment` and `metalnessmap_fragment`. */
const ROAD_ROUGHNESS = `
float roughnessFactor = roughness;
vec4 texelRoughness = roadRelief(vRoadUv, 1.0, roadLookA.z, 0.0);
roughnessFactor *= texelRoughness.g;`;
const ROAD_METALNESS = `
float metalnessFactor = roadLookB.y;`;

/** Where the kerb stone's top is, on the footway alone: the share of the pixel where the footway's place across (metres from the stone's back,
 *  `roadSurfaceReads.ts` footwaySection) is under 0, on a footway of a road (its third number 1), box-filtered over the pixel's footprint across so
 *  the stone's back is never a jagged line; the footprint taken before any branch (derivatives are undefined in non-uniform flow). The stone's top
 *  is a band of the footway, no triangle of its own, as the owner's road tool draws it. */
const ROAD_KERB_SHARE = `
  float kerbX = vRoadSection.x;
  float kerbFoot = max(fwidth(kerbX), 1e-4);
  float kerbTop = roadCode == ${ROAD_CODE.footway} && vRoadSection.z > 0.5 ? clamp(0.5 - kerbX / kerbFoot, 0.0, 1.0) : 0.0;`;

/** The kerb's look as the kerb's own material drew it, from its rows of the table and its layers of the arrays: its tile against the footway's, the
 *  footway's close-zoom weight and uv, the kerb's blur, albedo, normals and roughness, after the footway's own colour and wear so neither tints it. */
const ROAD_KERB_TOP = `
  vec4 kerbA = uRoadLooks[${ROAD_CODE.kerb * LOOK_ROWS}], kerbB = uRoadLooks[${ROAD_CODE.kerb * LOOK_ROWS + 1}], kerbC = uRoadLooks[${ROAD_CODE.kerb * LOOK_ROWS + 2}];
  vec2 kerbUv = vRoadUv * uKerbRepeat;
  vec2 kerbDx = dFdx(kerbUv), kerbDy = dFdy(kerbUv);
  float kerbBlur = exp2(detailW * kerbC.w);
  vec3 kerbAt = vec3(kerbUv * kerbA.w, kerbA.x);
  vec2 kerbGradX = kerbDx * kerbA.w * kerbBlur, kerbGradY = kerbDy * kerbA.w * kerbBlur;`;
const ROAD_KERB_COLOUR = `
  if (kerbTop > 0.0) {
    vec3 kerbAlbedo = textureGrad(uRoadColours, kerbAt, kerbGradX, kerbGradY).rgb;
#ifdef ROAD_DETAIL
    if (detailW > 0.0) kerbAlbedo *= mix(vec3(1.0), detailSampleArray(uRoadDetails, detailUv, roadLookB.w, detailDx, detailDy), detailW * kerbC.y);
#endif
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * kerbAlbedo, kerbTop);
  }`;
const ROAD_KERB_NORMAL = `
  if (kerbTop > 0.0) {
    vec3 kerbN = textureGrad(uRoadRelief, vec3(kerbAt.xy, kerbA.y), kerbGradX, kerbGradY).xyz * 2.0 - 1.0;
    kerbN.xy *= kerbB.x;
#ifdef ROAD_DETAIL
    if (detailW > 0.0) kerbN.xy += detailNormalArray(uRoadDetails, detailUv, roadLookB.w + uRoadDetailNormals, detailDx, detailDy).xy * kerbC.z * detailW;
#endif
    normal = normalize(mix(normal, normalize(tbn * kerbN), kerbTop));
  }`;
const ROAD_KERB_ROUGHNESS = `
  if (kerbTop > 0.0) roughnessFactor = mix(roughnessFactor, roughness * textureGrad(uRoadRelief, vec3(kerbAt.xy, kerbA.z), kerbGradX, kerbGradY).g, kerbTop);`;

/**
 * Every road surface drawn by one material (the section's head above): its maps and look table, the carriageway's paint, lines, marks and dirt
 * (`ROAD_CODE.carriageway`, `raised`), the footway's wear and kerb top (`footway`); each as its own material drew it. The paint's slot a vertex
 * carries is the carriageway's alone (-1 elsewhere: no line, no mark), so the lines' and marks' code runs on every pixel and inks the carriageway
 * alone. Applied once, before the lots' overlay (`lotOverlay.ts`) and the wear (`wear.ts` applyRoadWear). `kerbRepeat`: the kerb's tile against the
 * footway's, where its top is drawn on the footway.
 */
export function applyRoadSurface(material: MeshStandardMaterial, maps: RoadMaps, looks: readonly RoadLook[], kerbRepeat: number): void {
  marksRoadSection(material);
  material.vertexColors = true;
  const uniforms = {
    uRoadLooks: { value: roadLookTable(looks) },
    uRoadColours: { value: maps.colours }, uRoadRelief: { value: maps.relief }, uFootwayColour: { value: maps.footwayColour },
    uFootwayRelief: { value: maps.footwayRelief }, uRoadDetails: { value: maps.details }, uRoadDetailNormals: { value: maps.detailNormals },
    uKerbRepeat: { value: kerbRepeat }, uDetailOn: detailSwitch,
  };
  const carriageway = `roadCode <= ${ROAD_CODE.raised}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // The close-zoom layer (`uRoadDetails`) read by every program but the far blocks' batch (`farBlockBatches.ts`): far off, where its weight is
    // 0, and its batch already takes two units for its instances (three's batchingTexture, batchingIdTexture). DO NOT read it there: with the
    // sun's three cascades the batch asked 17 texture units, past the 16 WebGL 2 guarantees, and its program was refused (2026-10-25).
    if (!shader.batching) shader.fragmentShader = `#define ROAD_DETAIL
${shader.fragmentShader}`;
    // The paint's table, one for every carriageway (`roadPaint.ts`): the uniform objects shared, so a table grown reaches every program.
    shader.uniforms['uRoadSegments'] = roadPaint.segments;
    shader.uniforms['uRoadLines'] = roadPaint.lines;
    shader.uniforms['uRoadMarks'] = roadMarks.texture;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 roadSection;
varying vec3 vRoadSection;
flat varying int vRoadCode;
flat varying float vRoadPaintSlot;
varying vec3 vRoadWorld;
varying vec2 vRoadUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRoadSection = roadSection.xyz;
vRoadCode = int(roadSection.w + 0.5);
vRoadPaintSlot = roadSection.w < ${ROAD_CODE.raised}.5 ? roadSection.z : -1.0;
vRoadUv = uv;`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRoadSection;
flat varying float vRoadPaintSlot;
varying vec3 vRoadWorld;
uniform highp sampler2D uRoadSegments;
uniform highp sampler2D uRoadLines;
float roadPaintHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float roadPaintNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(roadPaintHash(i), roadPaintHash(i + vec2(1.0, 0.0)), f.x), mix(roadPaintHash(i + vec2(0.0, 1.0)), roadPaintHash(i + vec2(1.0, 1.0)), f.x), f.y);
}${ROAD_MARKS_PARS}
${DETAIL_GLSL}
${DETAIL_ARRAY_GLSL}
${ROAD_LOOK_PARS}`)
      .replace('#include <map_fragment>', ROAD_MAP)
      .replace('#include <color_fragment>', `#include <color_fragment>
  float roadPaintCover = 0.0;
  float roadHalf = 0.0, roadLane = 0.0;${CARRIAGEWAY_PAINT}${ROAD_MARKS_COLOR}
  ${carriagewayDirt(GRAIN_ARRAY)}${footwayMarks(`roadCode == ${ROAD_CODE.footway} && vRoadSection.y > 0.0`, GRAIN_ARRAY)}`)
      .replace('#include <alphamap_fragment>', `${ROAD_KERB_SHARE}${ROAD_KERB_TOP}${ROAD_KERB_COLOUR}\n#include <alphamap_fragment>`)
      .replace('#include <roughnessmap_fragment>', `${ROAD_ROUGHNESS}\nif (${carriageway}) roughnessFactor = mix(roughnessFactor, 0.72, roadPaintCover);${ROAD_KERB_ROUGHNESS}`)
      .replace('#include <metalnessmap_fragment>', `${ROAD_METALNESS}\nif (${carriageway}) {${ROAD_MARKS_METALNESS}\n}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>${ROAD_TBN}`)
      .replace('#include <normal_fragment_maps>', `${ROAD_NORMAL}${ROAD_KERB_NORMAL}`)
      .replace('#include <clearcoat_normal_fragment_begin>', `if (${carriageway}) {\n${ROAD_MARKS_NORMAL}}\n#include <clearcoat_normal_fragment_begin>`);
  };
  material.customProgramCacheKey = () => 'road-surface-v1';
}

/** The wear's channels on the road material (`wear.ts` applyRoadWear), where its surfaces' own materials had them: the wheels' on the carriageway
 *  (not on its raised crossings, whose material had none), the feet's on the footway (its ramps and a median's paving). */
export const ROAD_WEAR: readonly { readonly when: string; readonly channel: 0 | 1 }[] = [
  { when: `vRoadCode == ${ROAD_CODE.carriageway}`, channel: 0 },
  { when: `vRoadCode == ${ROAD_CODE.footway}`, channel: 1 },
];

/** Each surface's colour on an optimisation sheet (`lab/catalog/items.ts` sheetMaterial), where no baked map is drawn: its baked texture's mean
 *  (`roadTones.ts` STREET_MEANS, linear), the colour its map averages to from afar, as the far levels paint it: a sheet's L0 and its L2 the same
 *  tones. DO NOT give it a colour of its own: the sheets showed the near level paler than the far one where the game draws them alike. */
const SHEET_COLOURS: Readonly<Record<RoadCode, readonly [number, number, number]>> = {
  [ROAD_CODE.carriageway]: STREET_MEANS.asphalt, [ROAD_CODE.raised]: STREET_MEANS.raised, [ROAD_CODE.footway]: STREET_MEANS.footway,
  [ROAD_CODE.kerb]: STREET_MEANS.kerb, [ROAD_CODE.planting]: STREET_MEANS.verge, [ROAD_CODE.deck]: STREET_MEANS.deck,
};

/**
 * The road material on an optimisation sheet (`lab/catalog/items.ts` sheetMaterial): each surface in its sheet colour by the code its vertices carry,
 * the carriageway's lines, marks and dirt drawn by its own code (`CARRIAGEWAY_PAINT`, `roadMarksShader.ts`), the kerb stone's top on the footway in
 * the kerb's colour (`KERB_FLAT`, where `ROAD_KERB_SHARE` puts it): what the sheet drew of each surface's own material, in one.
 */
export function roadSheetMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  marksRoadSection(material);
  const colours = Array.from({ length: ROAD_CODES }, (_, code) => new Color().setRGB(...SHEET_COLOURS[code as RoadCode]));
  const carriageway = `vRoadCode <= ${ROAD_CODE.raised}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uRoadSegments'] = roadPaint.segments;
    shader.uniforms['uRoadLines'] = roadPaint.lines;
    shader.uniforms['uRoadMarks'] = roadMarks.texture;
    shader.uniforms['uRoadSheetColours'] = { value: colours };
    shader.uniforms['uKerbColour'] = { value: new Color().setRGB(...SHEET_COLOURS[ROAD_CODE.kerb]) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 roadSection;
varying vec3 vRoadSection;
flat varying int vRoadCode;
flat varying float vRoadPaintSlot;
varying vec3 vRoadWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRoadSection = roadSection.xyz;
vRoadCode = int(roadSection.w + 0.5);
vRoadPaintSlot = roadSection.w < ${ROAD_CODE.raised}.5 ? roadSection.z : -1.0;`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRoadSection;
flat varying int vRoadCode;
flat varying float vRoadPaintSlot;
varying vec3 vRoadWorld;
uniform vec3 uRoadSheetColours[${ROAD_CODES}];
uniform vec3 uKerbColour;
uniform highp sampler2D uRoadSegments;
uniform highp sampler2D uRoadLines;
float roadPaintHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float roadPaintNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(roadPaintHash(i), roadPaintHash(i + vec2(1.0, 0.0)), f.x), mix(roadPaintHash(i + vec2(0.0, 1.0)), roadPaintHash(i + vec2(1.0, 1.0)), f.x), f.y);
}${ROAD_MARKS_PARS}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= uRoadSheetColours[vRoadCode];')
      .replace('#include <color_fragment>', `#include <color_fragment>
  float roadPaintCover = 0.0;
  float roadHalf = 0.0, roadLane = 0.0;${CARRIAGEWAY_PAINT}${ROAD_MARKS_COLOR}
  ${carriagewayDirt(GRAIN_OWN)}`)
      .replace('#include <alphamap_fragment>', `
  float kerbX = vRoadSection.x;
  float kerbFoot = max(fwidth(kerbX), 1e-4);
  float kerbTop = vRoadCode == ${ROAD_CODE.footway} && vRoadSection.z > 0.5 ? clamp(0.5 - kerbX / kerbFoot, 0.0, 1.0) : 0.0;${KERB_FLAT}
#include <alphamap_fragment>`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nif (${carriageway}) roughnessFactor = mix(roughnessFactor, 0.72, roadPaintCover);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nif (${carriageway}) {${ROAD_MARKS_METALNESS}\n}`)
      .replace('#include <clearcoat_normal_fragment_begin>', `if (${carriageway}) {\n${ROAD_MARKS_NORMAL}}\n#include <clearcoat_normal_fragment_begin>`);
  };
  material.customProgramCacheKey = () => 'road-surface-sheet-v1';
  return material;
}

/**
 * The network's far level's carriageway (`networkFarRoads.ts` farLayerMaterial): its vertices' colours (the asphalt's mean at its class's tint) and,
 * over them, the carriageway's lines, marks and dirt by the detail's own code (`CARRIAGEWAY_PAINT`, `roadMarksShader.ts`, `carriagewayDirt`) read
 * from the same tables, its vertices carrying the same section (`networkFarRoadsBuild.ts` FarRoadCell sections): the paint the detail inks at a
 * distance (its mean over the pixel's footprint) inked here alike. Its own grain none (no map: `GRAIN_OWN` reads 0.5). The marks' textures are
 * the three data tables every carriageway reads (`uRoadSegments`, `uRoadLines`, `uRoadMarks`); no other map.
 */
export function applyRoadFarPaint(material: MeshStandardMaterial): void {
  marksRoadSection(material);
  const carriageway = `vRoadCode <= ${ROAD_CODE.raised}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uRoadSegments'] = roadPaint.segments;
    shader.uniforms['uRoadLines'] = roadPaint.lines;
    shader.uniforms['uRoadMarks'] = roadMarks.texture;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 roadSection;
varying vec3 vRoadSection;
flat varying int vRoadCode;
flat varying float vRoadPaintSlot;
varying vec3 vRoadWorld;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRoadSection = roadSection.xyz;
vRoadCode = int(roadSection.w + 0.5);
vRoadPaintSlot = roadSection.w < ${ROAD_CODE.raised}.5 ? roadSection.z : -1.0;`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRoadSection;
flat varying int vRoadCode;
flat varying float vRoadPaintSlot;
varying vec3 vRoadWorld;
uniform highp sampler2D uRoadSegments;
uniform highp sampler2D uRoadLines;
float roadPaintHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float roadPaintNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(roadPaintHash(i), roadPaintHash(i + vec2(1.0, 0.0)), f.x), mix(roadPaintHash(i + vec2(0.0, 1.0)), roadPaintHash(i + vec2(1.0, 1.0)), f.x), f.y);
}${ROAD_MARKS_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  float roadPaintCover = 0.0;
  float roadHalf = 0.0, roadLane = 0.0;${CARRIAGEWAY_PAINT}${ROAD_MARKS_COLOR}
  ${carriagewayDirt(GRAIN_OWN)}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nif (${carriageway}) roughnessFactor = mix(roughnessFactor, 0.72, roadPaintCover);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nif (${carriageway}) {${ROAD_MARKS_METALNESS}\n}`)
      .replace('#include <clearcoat_normal_fragment_begin>', `if (${carriageway}) {\n${ROAD_MARKS_NORMAL}}\n#include <clearcoat_normal_fragment_begin>`);
  };
  material.customProgramCacheKey = () => 'road-far-paint-v1';
}

/**
 * One surface's look read from the road material's arrays (`bake/catalogue.ts` roadArrays): the structures' concrete (`materials.ts`: the parapets
 * and walls with the close-zoom layer, `detail`, the piers and abutments without), the deck's layers. Three's own reads of a map, a normal map and a
 * roughness map (r186 `map_fragment`, `normal_fragment_maps`, `roughnessmap_fragment`; the close-zoom layer's as the parapets' own material
 * made them, `mesh/detailLayer.ts` DETAIL_ARRAY_GLSL) from the layers `look` names, its normals' strength its row's. DO NOT bake the deck's maps on their own besides: the same texels twice
 * on the GPU. The material's own maps none.
 */
export function applyRoadLayers(material: MeshStandardMaterial, maps: RoadMaps, look: RoadLook, detail: boolean): void {
  const uniforms = {
    uLayerLook: { value: roadLookTable([look]).subarray(0, LOOK_ROWS * 4) },
    uRoadColours: { value: maps.colours }, uRoadRelief: { value: maps.relief },
    ...(detail ? { uRoadDetails: { value: maps.details }, uRoadDetailNormals: { value: maps.detailNormals }, uDetailOn: detailSwitch } : {}),
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRoadUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoadUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec4 uLayerLook[${LOOK_ROWS}];
uniform highp sampler2DArray uRoadColours;
uniform highp sampler2DArray uRoadRelief;
varying vec2 vRoadUv;${detail ? `
uniform highp sampler2DArray uRoadDetails;
uniform float uRoadDetailNormals;
${DETAIL_GLSL}
${DETAIL_ARRAY_GLSL}` : ''}${TANGENT_FRAME}`)
      .replace('#include <map_fragment>', `
  vec4 layerA = uLayerLook[0], layerB = uLayerLook[1], layerC = uLayerLook[2];
  vec3 layerUv = vec3(vRoadUv * layerA.w, layerA.x);${detail ? `
  float detailW = detailWeight(vRoadUv * layerB.z);
  vec2 detailUv = vRoadUv * layerC.x;
  vec4 sampledDiffuseColor = texture(uRoadColours, layerUv, detailW * layerC.w);
  vec2 detailDx = dFdx(detailUv), detailDy = dFdy(detailUv);
  if (detailW > 0.0) {
    vec3 detailAlbedo = detailSampleArray(uRoadDetails, detailUv, layerB.w, detailDx, detailDy);
    sampledDiffuseColor.rgb *= mix(vec3(1.0), detailAlbedo, detailW * layerC.y);
  }` : `
  vec4 sampledDiffuseColor = texture(uRoadColours, layerUv);`}
  diffuseColor *= sampledDiffuseColor;`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;
vec4 texelRoughness = texture(uRoadRelief, vec3(layerUv.xy, layerA.z));
roughnessFactor *= texelRoughness.g;`)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  mat3 tbn = roadTangentFrame(-vViewPosition, normal, vRoadUv);')
      .replace('#include <normal_fragment_maps>', `${detail ? `
  vec3 mapN = texture(uRoadRelief, vec3(layerUv.xy, layerA.y), detailW * layerC.w).xyz * 2.0 - 1.0;
  mapN.xy *= layerB.x;
  if (detailW > 0.0) {
    vec3 fineN = detailNormalArray(uRoadDetails, detailUv, layerB.w + uRoadDetailNormals, detailDx, detailDy);
    mapN.xy += fineN.xy * layerC.z * detailW;
  }` : `
  vec3 mapN = texture(uRoadRelief, vec3(layerUv.xy, layerA.y)).xyz * 2.0 - 1.0;
  mapN.xy *= layerB.x;`}
  normal = normalize(tbn * mapN);`);
  };
  material.customProgramCacheKey = () => `road-layers-v1${detail ? '-detail' : ''}`;
}
