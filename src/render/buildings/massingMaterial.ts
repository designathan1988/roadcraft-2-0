import { Color, MeshStandardMaterial } from 'three';
import { m } from '@world/units';
import { ROOM_LAMP_GLSL } from './roomLamps';
import { applyLotOverlay } from '../lotOverlay';
import { LOOKS } from '../bake/finishRecipes';
import { finishFar } from './finishes';
import { CURTAIN_WALL } from './massing';

/** The material of buildings seen from afar (`massing.ts`) */

/** The glass a window is seen as from afar: the detail's pane (`kit.ts` glass 0x7c8e98) scatters next to nothing (`glassRoom.ts`: its albedo times 0.06), what it shows is the sky's reflection and the room behind it. DO NOT paint it its base colour: the black-glass towers turned pale blue from afar (the player, 2026-10-20). */
const GLASS = new Color(0x7c8e98).multiplyScalar(0.06);
/** The room seen through a pane by day, as the detail shows it once the pane is a few pixels (`glassRoom.ts` paneTiny's mean), lit by `roomDaylight`. */
export const ROOM_SEEN_GLSL = 'vec3(0.42, 0.45, 0.47)';

export interface MassingUniforms {
  /** Share of rooms lit at this hour (`kit.ts` `awakeShare`). */
  readonly roomsAwake: { value: number };
  /** How bright a lit window glows (0 by day), as the detailed panes' `emissiveIntensity`. */
  readonly massingNight: { value: number };
  /** The share of the room behind a pane seen by day (`kit.ts` roomDaylight), as the detailed panes show it. */
  readonly roomDaylight?: { value: number };
}

/** GLSL `<prefix>Pulse(x, w, a0, a1)`: a pulse [a0, a1) repeated every 1 seen through a pixel whose footprint is w periods, and `<prefix>Footprint(cell)`, that footprint per axis.
 * A tent filter of radius w (the pulse's second integral, Inigo Quilez "filterable procedurals"): its response sinc squared, the first side lobe at -26.5 dB against a box's -13 dB,
 * so the windows stay drawn while a bay holds 2 pixels and do not shimmer. DO NOT fade to the mean from 4 pixels a bay: the facades went flat and soft at mid distance (the player, 2026-10-23).
 * Taken on fract(x) (the filtered pulse repeats with it): the second integral of a far bay index loses the float's precision. Under 0.05 a pixel a period, the box of the first integral (a bay of 20 pixels rings at nothing; the tent's second difference would lose the float there). */
export function PULSE_GLSL(prefix: string): string {
  return `
float ${prefix}PulseFirst(float x, float a0, float a1) { return floor(x) * (a1 - a0) + clamp(fract(x), a0, a1) - a0; }
float ${prefix}PulseSecond(float x, float a0, float a1) {
  float l = a1 - a0, n = floor(x), f = x - n;
  float g = f < a0 ? 0.0 : f <= a1 ? 0.5 * (f - a0) * (f - a0) : 0.5 * l * l + l * (f - a1);
  return l * (0.5 * n * (n - 1.0) + n * f) + n * (0.5 * l * l + l * (1.0 - a1)) + g;
}
float ${prefix}Pulse(float x, float w, float a0, float a1) {
  if (a1 <= a0) return 0.0;
  float mean = clamp(a1 - a0, 0.0, 1.0);
  float fade = smoothstep(0.5, 1.0, w);
  if (fade >= 1.0) return mean;
  float c = fract(x);
  float filtered = w < 0.05
    ? (${prefix}PulseFirst(c + 0.5 * w, a0, a1) - ${prefix}PulseFirst(c - 0.5 * w, a0, a1)) / w
    : (${prefix}PulseSecond(c + w, a0, a1) - 2.0 * ${prefix}PulseSecond(c, a0, a1) + ${prefix}PulseSecond(c - w, a0, a1)) / (w * w);
  return mix(filtered, mean, fade);
}
// The footprint as the gradient's length per axis: DO NOT take fwidth (|dx| + |dy|), up to 1.41 times it in an oblique view.
vec2 ${prefix}Footprint(vec2 cell) { vec2 dx = dFdx(cell), dy = dFdy(cell); return max(sqrt(dx * dx + dy * dy), vec2(1e-4)); }`;
}

/** The base's colour (`massBase.ts` paint): 5-6-5 bits of sRGB in the vertex's fourth short, read back linear (IEC 61966-2-1). */
const BASE_PAINT_GLSL = `
  float basePacked = floor(basePaint * 65535.0 + 0.5);
  vec3 baseSrgb = vec3(floor(basePacked / 2048.0) / 31.0, mod(floor(basePacked / 32.0), 64.0) / 63.0, mod(basePacked, 32.0) / 31.0);
  vColor = vec4(mix(baseSrgb / 12.92, pow((baseSrgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), baseSrgb)), 1.0);`;

/** The base's facade (`massBase.ts` gridShorts, a wall's last corner's: `flat`): its wall's way along from the face's own slope (as three's
 *  `flatShading` takes its normal), its storeys counted from its foot, its bays, its windows - the masses' facade, drawn by the same pulses and
 *  lit rooms below. A roof (its face up) or a block with no grid (its storey 0) draws none. */
const BASE_GRID_GLSL = `{
  vec3 faceN = normalize(cross(dFdx(vBaseWorld), dFdy(vBaseWorld)));
  float storey = vBaseGrid.x / 100.0, bay = vBaseGrid.y / 100.0;
  if (abs(faceN.y) < 0.5 && storey > 0.0 && bay > 0.0) {
    float along = dot(vBaseWorld.xz, normalize(vec2(-faceN.z, faceN.x)));
    float c = vBaseGrid.z, d = vBaseGrid.w;
    float curtain = mod(floor(c / 128.0), 2.0), office = mod(floor(c / 64.0), 2.0);
    fFacade = vec4(along, bay, storey, vBaseFoot + mod(d, 64.0) / 8.0);
    fGlazing = vec2(floor(c / 256.0) / 255.0 + curtain * ${CURTAIN_WALL.toFixed(1)}, mod(c, 64.0) / 64.0 + office * 2.0);
    fWindow = vec2(floor(d / 2048.0), mod(floor(d / 64.0), 32.0)) / 31.0;
  } else fFacade.y = 0.0;
}`;

/** The masses' material; `base`, the top level's (`massBase.ts`): no normal of its own - each face shaded by its own slope (three's `flatShading`), each triangle in its last corner's colour and grid (`flat` varyings), its windows drawn from its grid (`BASE_GRID_GLSL`). */
export function createMassingMaterial(uniforms: MassingUniforms, base = false): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: base });
  material.name = base ? 'building-massing-base' : 'building-massing';
  const glass = `vec3(${GLASS.r.toFixed(5)}, ${GLASS.g.toFixed(5)}, ${GLASS.b.toFixed(5)})`;
  // A curtain wall's spandrels and mullions: the glass finish as the facade level draws it from afar (`finishes.ts` finishFar, `FAR_FINISH`):
  // its tint (the vertex's, the light it scatters) over what its metal leaves (its albedo), its metal, its gloss and its sky.
  const curtain = finishFar().glass;
  const curtainAlbedo = (1 / (1 - curtain.metal)).toFixed(5), curtainMetal = curtain.metal.toFixed(5), curtainRough = curtain.rough.toFixed(5);
  const curtainSky = LOOKS.glass.envMapIntensity.toFixed(5), curtainShare = CURTAIN_WALL.toFixed(1);
  material.onBeforeCompile = (shader) => {
    shader.uniforms['roomsAwake'] = uniforms.roomsAwake;
    shader.uniforms['massingNight'] = uniforms.massingNight;
    shader.uniforms['roomDaylight'] = uniforms.roomDaylight ?? { value: 0 };
    shader.vertexShader = shader.vertexShader
      // A vertex's facade (along, foot) in full floats, its grid (bay, storey, glass share) in half floats, its seed whole (`cellArrays.ts` `CellMass`).
      .replace('#include <common>', '#include <common>\nattribute vec2 facade;\nattribute vec4 facadeGrid;\nattribute float glazingSeed;\nvarying vec4 vFacade;\nvarying vec2 vGlazing;\nvarying vec2 vWindow;\nvarying float vHeight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = vec4(facade.x, facadeGrid.x, facadeGrid.y, facade.y);\nvGlazing = vec2(facadeGrid.z, glazingSeed);\nvWindow = vec2(floor(facadeGrid.w / 32.0 + 0.01), mod(floor(facadeGrid.w + 0.5), 32.0)) / 31.0;\nvHeight = (modelMatrix * vec4(transformed, 1.0)).y;');
    if (base) {
      // Its colour from its paint, one a triangle; an up normal for what reads one in the vertex stage (the shadow's normal bias, the lots' overlay): the face's own is taken from its slope in the fragment stage.
      shader.vertexShader = shader.vertexShader
        .replace('#include <color_pars_vertex>', 'flat varying vec4 vColor;\nattribute float basePaint;\nattribute vec4 baseGrid;\nflat varying vec4 vBaseGrid;\nflat varying float vBaseFoot;\nvarying vec3 vBaseWorld;')
        .replace('#include <color_vertex>', `${BASE_PAINT_GLSL}\n  vBaseGrid = baseGrid;\n  vBaseWorld = (modelMatrix * vec4(position, 1.0)).xyz;\n  vBaseFoot = vBaseWorld.y;`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);');
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_pars_fragment>', 'flat varying vec4 vColor;\nflat varying vec4 vBaseGrid;\nflat varying float vBaseFoot;\nvarying vec3 vBaseWorld;');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float roomsAwake;
uniform float massingNight;
uniform float roomDaylight;
varying vec4 vFacade;
varying vec2 vGlazing;
// The windows' sill and head, shares of the storey (massing.ts windowCode): the face's own windows, as the detail cuts them.
varying vec2 vWindow;
varying float vHeight;
float massGlass = 0.0;
// A curtain wall's pixel (1): what is not its windows is its finish, the glass's look from afar.
float massCurtain = 0.0;
float massLit = 0.0;
vec3 massLamp = vec3(1.0);
${ROOM_LAMP_GLSL}
${PULSE_GLSL('mass')}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec4 fFacade = vFacade;
vec2 fGlazing = vGlazing;
vec2 fWindow = vWindow;
${base ? BASE_GRID_GLSL : ''}
if (fFacade.y > 0.0) {
  // Bays along the face and storeys up it.
  vec2 cell = vec2(fFacade.x / fFacade.y, (vHeight - fFacade.w) / max(fFacade.z, 0.01));
  vec2 foot = massFootprint(cell);
  // A curtain wall's share is \`CURTAIN_WALL\` over its windows' (\`massing.ts\`): its windows as the detail cuts them, its storeys' spandrels and its mullions between them.
  massCurtain = step(${curtainShare}, fGlazing.x);
  float share = fGlazing.x - massCurtain * ${curtainShare};
  float across = massPulse(cell.x, foot.x, 0.5 - 0.5 * share, 0.5 + 0.5 * share);
  float up = massPulse(cell.y, foot.y, fWindow.x, fWindow.y);
  // A window under a pixel leaves its mean: kept at full strength the glass the detail shows, not washed into the wall (the town at 1–2 km read as pastel boxes, 2026-10-20).
  // A curtain wall's at its own share: what is round its windows is its glass finish, as dark as the detail draws it, not a wall to wash.
  massGlass = clamp(across * up * mix(1.45, 1.0, massCurtain), 0.0, 1.0) * step(0.0, cell.y);
  // Which room is lit: its own lot near, the share awake once a window is under a pixel; by day (\`massingNight\` 0, a uniform: one branch for every pixel) none glows, so none is worked out.
  if (massingNight > 0.0) {
    vec2 room = floor(cell);
    float seed = fract(fGlazing.y), office = step(1.5, fGlazing.y);
    float lot = fract(sin(dot(room, vec2(12.9898, 78.233)) + seed * 437.585) * 43758.5453);
    float near = step(1.0 - roomsAwake, lot);
    float sub = smoothstep(0.5, 1.5, max(foot.x, foot.y));
    massLit = mix(near, roomsAwake, sub);
    // Its lamp from the mix the detailed panes draw from (\`roomLamps.ts\`); under a pixel, the mix's mean, so a far block holds its colour.
    massLamp = mix(roomLamp(fract(lot * 17.31), office), roomLampMean(office), sub);
  }
  // The panes as the detail draws them: dark glass, the sky's reflection and the room behind it (emissive below); round a curtain wall's, its glass finish (its albedo here, its metal, gloss and sky below).
  diffuseColor.rgb = mix(diffuseColor.rgb * mix(1.0, ${curtainAlbedo}, massCurtain), ${glass}, massGlass);
  // The foot of the wall in the street's shade: a block stands on the ground, not on a card (the town from afar, 2026-10-20).
  diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, ${m(1.4).toFixed(4)}, vHeight - fFacade.w));
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, ${curtainRough}, massCurtain), 0.06, massGlass);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, ${curtainMetal}, massCurtain * (1.0 - massGlass));`)
      // The curtain wall's finish shows the sky as the detail's does (its own envMapIntensity, `finishRecipes.ts` glass); the panes theirs, as before.
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular ) && defined( USE_ENVMAP )
  radiance *= mix(1.0, ${curtainSky}, massCurtain * (1.0 - massGlass));
#endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += (massLamp * massingNight * massLit + ${ROOM_SEEN_GLSL} * roomDaylight) * massGlass;`);
  };
  material.customProgramCacheKey = () => (base ? 'building-massing-base-v3' : 'building-massing-lamps-v8');
  // A built lot's yard, coloured from afar as up close (`lotOverlay.ts`).
  applyLotOverlay(material, { building: true });
  return material;
}

