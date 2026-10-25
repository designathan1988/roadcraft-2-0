import { m } from '@world/units';

/** The close-up detail layer: what a surface looks like at the camera's nearest zoom. ## Why the ground went to mush up */

/** The shared on/off switch: off, the layer reads none of its textures (its weight 0, `detailW`). */
export const detailSwitch = { value: 1 };

/** GLSL for sampling a detail layer. */
export const DETAIL_GLSL = /* glsl */ `
  uniform float uDetailOn;
  // World units per pixel below which detail is fully shown, and above which it is gone.
  const float DETAIL_NEAR = ${m(0.018).toFixed(6)};
  const float DETAIL_FAR = ${m(0.064).toFixed(6)};
  const mat2 DETAIL_TURN = mat2(0.5403, 0.8415, -0.8415, 0.5403);

  float detailWeight(vec2 worldUv) {
    vec2 footprint = fwidth(worldUv);
    float perPixel = max(footprint.x, footprint.y);
    return uDetailOn * (1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR, perPixel));
  }
  // Read with the uv's own derivatives, taken outside the branch they are read in (textureGrad: a texture read in a branch has no derivatives of its own).
  vec3 detailSample(sampler2D tex, vec2 uv, vec2 dx, vec2 dy) {
    vec3 a = textureGrad(tex, uv, dx, dy).rgb * 2.0;
    vec3 b = textureGrad(tex, DETAIL_TURN * uv * 0.4137 + 0.31, DETAIL_TURN * dx * 0.4137, DETAIL_TURN * dy * 0.4137).rgb * 2.0;
    return a * mix(vec3(1.0), b, 0.55);
  }
  vec3 detailNormal(sampler2D tex, vec2 uv, vec2 dx, vec2 dy) {
    vec3 a = textureGrad(tex, uv, dx, dy).xyz * 2.0 - 1.0;
    vec3 b = textureGrad(tex, DETAIL_TURN * uv * 0.4137 + 0.31, DETAIL_TURN * dx * 0.4137, DETAIL_TURN * dy * 0.4137).xyz * 2.0 - 1.0;
    // The second sample was read through a rotation
    b.xy = b.xy * DETAIL_TURN;
    return vec3(a.xy + b.xy * 0.55, a.z);
  }
`;

/** The close-zoom layer's samples read from a texture array (`bake/catalogue.ts` road-details, a layer a family), as `detailSample` and `detailNormal`
 *  read them from a texture of their own: the same two reads, the same turn and blend, the layer the family's. After `DETAIL_GLSL`. */
export const DETAIL_ARRAY_GLSL = /* glsl */ `
  vec3 detailSampleArray(highp sampler2DArray tex, vec2 uv, float layer, vec2 dx, vec2 dy) {
    vec3 a = textureGrad(tex, vec3(uv, layer), dx, dy).rgb * 2.0;
    vec3 b = textureGrad(tex, vec3(DETAIL_TURN * uv * 0.4137 + 0.31, layer), DETAIL_TURN * dx * 0.4137, DETAIL_TURN * dy * 0.4137).rgb * 2.0;
    return a * mix(vec3(1.0), b, 0.55);
  }
  vec3 detailNormalArray(highp sampler2DArray tex, vec2 uv, float layer, vec2 dx, vec2 dy) {
    vec3 a = textureGrad(tex, vec3(uv, layer), dx, dy).xyz * 2.0 - 1.0;
    vec3 b = textureGrad(tex, vec3(DETAIL_TURN * uv * 0.4137 + 0.31, layer), DETAIL_TURN * dx * 0.4137, DETAIL_TURN * dy * 0.4137).xyz * 2.0 - 1.0;
    b.xy = b.xy * DETAIL_TURN;
    return vec3(a.xy + b.xy * 0.55, a.z);
  }
`;
