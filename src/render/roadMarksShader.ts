import { MARKS_HEAD, ROAD_PAINT_ROW, SLOT_TEXELS } from './roadPaint';
import { MARKS_ROW, MARK_DASHED, MARK_POLYGON, SHAPE_TEXELS } from './roadMarks';

/**
 * # THE ROADS' MARKS INKED BY THE CARRIAGEWAY'S SHADER (`roadMarks.ts`), its pieces for `mesh/roadEdges.ts`
 *
 * After the lines along the road (`roadEdges.ts` CARRIAGEWAY_PAINT): the pixel's piece (`roadSection`'s third number: a road's slot, or a plate's
 * `-2 - slot`), its bucket (a road by its arc length, a plate by x), and each group of that bucket whose box the pixel's footprint meets, each shape
 * of it covering the footprint by its share:
 * - a parallelogram: the product of its two box-filtered spans (Quilez, "Filterable procedurals",
 *   https://iquilezles.org/articles/filterableprocedurals), a dashed one times the share of the footprint its pattern inks, the pattern's integral
 *   F(x) = floor(x / P) d + min(mod(x, P), d) across it (Rougier, "Shader-Based Antialiased, Dashed, Stroked Polylines", JCGT 2(2) 2013,
 *   https://jcgt.org/published/0002/02/08/): a dash several pixels long keeps hard ends, one under a pixel turns to the pattern's mean;
 * - a regular polygon: its edge's distance (Quilez, "2D distance functions", https://iquilezles.org/articles/distfunctions2d/) over the footprint
 *   across that edge.
 * The shapes of one colour are one paint (their coverage the most of theirs: two strokes overlapping at a joint are inked once), the colours inked
 * one over another in the palette's order (`roadMarks.ts`), worn as the paint's material wore it. Every footprint is taken before any branch
 * (derivatives are undefined in non-uniform flow).
 */

/** Declarations, after the carriageway's own (`roadPaintNoise`). */
export const ROAD_MARKS_PARS = `
uniform highp sampler2D uRoadMarks;
vec4 roadMark(int at) { return texelFetch(uRoadMarks, ivec2(at % ${MARKS_ROW}, at / ${MARKS_ROW}), 0); }
// The share of [x - w/2, x + w/2] inside [0, 1].
float roadMarkSpan(float x, float w) { return clamp((min(1.0, x + 0.5 * w) - max(0.0, x - 0.5 * w)) / w, 0.0, 1.0); }
// The share of [q - w/2, q + w/2] the pattern inks (dash d in period p).
float roadMarkDash(float q, float w, float d, float p) {
  vec2 e = q + vec2(-0.5, 0.5) * w;
  vec2 ink = floor(e / p) * d + min(mod(e, p), d);
  return clamp((ink.y - ink.x) / w, 0.0, 1.0);
}
// How much of the footprint at p (its derivatives dx, dy) a shape covers.
float roadMarkCover(int at, vec2 p, vec2 dx, vec2 dy) {
  vec4 t0 = roadMark(at), t1 = roadMark(at + 1);
  int kind = int(t1.z + 0.5);
  vec2 d = p - t0.xy;
  if (kind == ${MARK_POLYGON}) {
    // The edge facing p: between the corners at k and k + 1 sides of 2 pi / n round from angle 0.
    float sector = 6.28318530718 / t0.w;
    float a = (floor(atan(d.y, d.x) / sector) + 0.5) * sector;
    vec2 n = vec2(cos(a), sin(a));
    float w = max(abs(dot(n, dx)) + abs(dot(n, dy)), 1e-6);
    return clamp(0.5 - (dot(d, n) - t0.z * cos(0.5 * sector)) / w, 0.0, 1.0);
  }
  float ws = max(abs(dot(t0.zw, dx)) + abs(dot(t0.zw, dy)), 1e-7);
  float wt = max(abs(dot(t1.xy, dx)) + abs(dot(t1.xy, dy)), 1e-7);
  float cover = roadMarkSpan(dot(t0.zw, d), ws) * roadMarkSpan(dot(t1.xy, d), wt);
  if (kind == ${MARK_DASHED} && cover > 0.0) {
    vec4 t2 = roadMark(at + 2);
    float wq = max(abs(dot(t2.yz, dx)) + abs(dot(t2.yz, dy)), 1e-6);
    cover *= roadMarkDash(t2.x + dot(t2.yz, d), wq, t1.w, t2.w);
  }
  return cover;
}
// One colour's coverage inked over the surface, worn as the paint's material wore it (pinholes of asphalt through it, wider where it is worn, faded as
// the eye sees it finer): w the world's xz, px the size of a pixel there.
void roadMarkInk(int colour, float cover, vec2 w, float px, inout vec3 rgb, inout float paintCover, inout float markCover) {
  if (colour < 0 || cover <= 0.0) return;
  float grainP = roadPaintNoise(w * 9.0);
  float worn = roadPaintNoise(w * 0.7) * 0.6 + roadPaintNoise(w * 2.3) * 0.4;
  float flake = roadPaintNoise(w * 5.0);
  float fineSeen = 1.0 - smoothstep(0.015, 0.045, px);
  float grainSeen = 1.0 - smoothstep(0.04, 0.12, px);
  float flakeSeen = 1.0 - smoothstep(0.08, 0.2, px);
  float wear = 1.0 - 0.35 * smoothstep(0.55, 0.85, worn) * mix(0.5, smoothstep(0.4, 0.7, grainP), grainSeen);
  wear *= 1.0 - 0.25 * mix(0.14, step(0.86, roadPaintNoise(w * 22.0)), fineSeen);
  if (flake < 0.05) wear *= mix(1.0, 0.45, flakeSeen);
  float a = cover * wear * 0.92;
  rgb = mix(rgb, roadMark(colour).rgb * (0.86 + 0.14 * roadPaintNoise(w * 1.3)), a);
  paintCover = max(paintCover, a);
  markCover = max(markCover, a);
}`;

/** The marks inked into `diffuseColor` (after the carriageway's lines, `roadPaintCover` raised where they are, `roadMarkShare` how much of the
 *  pixel they cover: lit as the paint's mesh was, `ROAD_MARKS_METALNESS`, `ROAD_MARKS_NORMAL`). */
export const ROAD_MARKS_COLOR = `
  float roadMarkShare = 0.0;
  {
    // The plan's point (x, -z of three's axes) and its footprint; the world's xz the paint's wear is read at, and a pixel's size there.
    vec2 markP = vec2(vRoadWorld.x, -vRoadWorld.z);
    vec2 markDx = dFdx(markP), markDy = dFdy(markP);
    vec2 markReach = abs(markDx) + abs(markDy);
    float markPx = length(fwidth(vRoadWorld.xz));
    int markRoad = int(floor(vRoadPaintSlot + 0.5));
    int markSlot = markRoad >= 0 ? markRoad : -2 - markRoad;
    if (markSlot >= 0) {
      int at = markSlot * ${SLOT_TEXELS} + ${MARKS_HEAD};
      vec4 head = texelFetch(uRoadSegments, ivec2(at % ${ROAD_PAINT_ROW}, at / ${ROAD_PAINT_ROW}), 0);
      int buckets = int(head.z + 0.5);
      if (buckets > 0) {
        float coord = markRoad >= 0 ? vRoadSection.y : markP.x;
        vec4 bucket = roadMark(int(head.w + 0.5) + clamp(int(floor((coord - head.x) / head.y)), 0, buckets - 1));
        int first = int(bucket.x + 0.5), count = int(bucket.y + 0.5);
        int runColour = -1;
        float runCover = 0.0;
        for (int i = 0; i < count; i++) {
          vec4 entry = roadMark(first + i);
          int colour = int(entry.y + 0.5);
          if (colour != runColour) {
            roadMarkInk(runColour, runCover, vRoadWorld.xz, markPx, diffuseColor.rgb, roadPaintCover, roadMarkShare);
            runColour = colour;
            runCover = 0.0;
          }
          int g = int(entry.x + 0.5);
          vec4 box = roadMark(g);
          if (markP.x < box.x - markReach.x || markP.x > box.z + markReach.x || markP.y < box.y - markReach.y || markP.y > box.w + markReach.y) continue;
          int shapes = int(entry.z + 0.5);
          for (int k = 0; k < shapes; k++) runCover = max(runCover, roadMarkCover(g + 1 + k * ${SHAPE_TEXELS}, markP, markDx, markDy));
        }
        roadMarkInk(runColour, runCover, vRoadWorld.xz, markPx, diffuseColor.rgb, roadPaintCover, roadMarkShare);
      }
    }
  }`;

/**
 * Under the marks the surface lit as the paint's own mesh was (its material, deleted with `markings.ts`: metalness 0, no normal map, the
 * flat normal of the triangle under it): the carriageway's metalness and the relief of its normal map faded out by the marks' cover. Its roughness
 * is the paint's 0.72 already (`roadPaintCover`, as the lines'). The sky's reflection needs nothing: the paint's material and the carriageway's
 * read the scene's environment, whose intensity three puts in place of each material's own (WebGLRenderer.js setProgram, `scene.environmentIntensity`).
 * The lines along the road keep the carriageway's lighting, as they were drawn before the marks came (`mesh/roadEdges.ts` CARRIAGEWAY_PAINT).
 */
/** After `metalnessmap_fragment`. */
export const ROAD_MARKS_METALNESS = '\nmetalnessFactor = mix(metalnessFactor, 0.0, roadMarkShare);';
/** Before `clearcoat_normal_fragment_begin`: after the normal map, the close-zoom layer's included (`mesh/detailLayer.ts` puts its own in place of
 *  `normal_fragment_maps`); `nonPerturbedNormal` the triangle's own (three's normal_fragment_begin). */
export const ROAD_MARKS_NORMAL = 'normal = normalize(mix(normal, nonPerturbedNormal, roadMarkShare));\n';
