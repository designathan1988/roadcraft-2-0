/** The window lights and the filtered pulse of the facade level's shader (`facadeLevel.ts`): what every level drawn from afar draws its
 *  windows by (the cells' facade level, their masses, the tiles, the plates and the base, all in its format). */

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
