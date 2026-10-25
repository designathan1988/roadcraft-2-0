import type { Vec2 } from '@core/vec2';
import type { PoleId, SpanId } from './ids';
import { m } from './units';
import { ROAD_TUNING } from './roads/tuning';

/** The overhead utility network: poles, the wires strung between them, and the lamps they carry. */

/** Height of a pole's mast, from the ground to the crown. */
export const POLE_HEIGHT = m(8.5);
/** Radius at the crown and at the foot. A pole tapers. */
export const POLE_TOP_RADIUS = m(0.11);
export const POLE_BASE_RADIUS = m(0.18);

/**
 * WHAT A POLE IS BUILT AS, after a distributor's standard structures (CELESC E-313.0002, "Estruturas para redes aereas convencionais de
 * distribuicao", 2024: https://www.celesc.com.br/arquivos/normas-tecnicas/especificacao-tecnica/E3130002.pdf):
 * - URBAN: the cross-arm held out over the street from the mast (the "beco" structure B1, Figura 43), the three primary wires on its pin
 *   insulators; under it the secondary rack (structure S1, Figura 71) with two wires one over the other; the street light under every wire.
 * - RURAL (outside the city): the cross-arm across the crown (the "normal" structure N1, Figura 31), the three primary wires alone.
 * DO NOT string wires in rows round the mast again: a span carried 9 (three courses of three, the middle one through the mast), and the lamp
 * hung among them.
 */
export const POLE_KINDS = ['urban', 'rural'] as const;
export type PoleKind = (typeof POLE_KINDS)[number];

/** The cross-arm (2.0 m, Figura 16): its top this far under the crown (Figura 31: 15 cm), its section. */
export const POLE_ARM_DROP = m(0.15);
export const POLE_ARM_THICK = m(0.1);
/** Its two ends along it from the mast's axis, toward the street (urban: the mast at its end) or across the crown (rural). */
export const POLE_ARM_SPAN: Readonly<Record<PoleKind, readonly [number, number]>> = { urban: [0, m(2)], rural: [-m(1), m(1)] };
/** Where the primary wires' pin insulators stand along it, from the mast's axis (Figura 16: B1 at 55, 125 and 185 cm; N1 at -95, 35 and 95). */
export const POLE_PRIMARY: Readonly<Record<PoleKind, readonly number[]>> = { urban: [m(0.55), m(1.25), m(1.85)], rural: [-m(0.95), m(0.35), m(0.95)] };
/** A pin insulator's height: a primary wire rests on its top. */
export const POLE_INSULATOR_TALL = m(0.2);
/** The brace under the arm (the "mao francesa"): from the mast this far under the arm's top (Figura 31: 50 cm) to the arm this far out. */
export const POLE_BRACE_DROP = m(0.5);
export const POLE_BRACE_REACH = m(0.45);
/** The secondary rack's spools (S1): 20 cm apart (spans to 40 m), the upper 1.3 m under the crown - at least 80 cm under the primary between
 *  circuits (Figura 1, 13.8 kV) - each this far out from the mast's axis on the street's side. An urban pole carries two. */
export const POLE_SECONDARY_OUT = m(0.22);
export const POLE_SECONDARY_DROPS: readonly number[] = [m(1.3), m(1.5)];

/** Lamp arm reach and head, for the poles that carry a light: the head under every wire (the bracket's foot ~6.3 m up, as a town's street
 *  lighting fixes it: https://saiserver.pelotas.com.br/anexos_licitacao/arq_objeto/2023-07-31_11-49-22_objeto_Anexo_02.pdf). */
export const POLE_LAMP_REACH = m(1.6);
export const POLE_LAMP_DROP = m(2);
export const POLE_LAMP_LONG = m(0.5);
export const POLE_LAMP_TALL = m(0.14);
export const POLE_LAMP_WIDE = m(0.26);

/** Default distance between poles along a drawn run, in world units. */
export const DEFAULT_POLE_SPACING = ROAD_TUNING.poles.spacing;
export const MIN_POLE_SPACING = ROAD_TUNING.poles.minSpacing;
export const MAX_POLE_SPACING = ROAD_TUNING.poles.maxSpacing;

/** Sag of a span, as a fraction of its length. */
const WIRE_SAG_RATIO = 0.018;
/** However long the span, the sag stops growing past this. */
export const WIRE_MAX_SAG = m(1.4);

/** How many points a span is flattened into. */
export const WIRE_SEGMENTS = 8;

export interface UtilityPole {
  readonly id: PoleId;
  x: number;
  y: number;
  /** Whether this pole carries a street light. */
  lamp: boolean;
  /** What it is built as (`POLE_KINDS`). */
  kind: PoleKind;
}

/** A wire's seat on a pole: how far along the arm toward the street (or across the crown) from the mast's axis, and how far over (+) or
 *  under (-) the crown. */
export interface WireSeat {
  readonly along: number;
  readonly rise: number;
}

/** The primary wires' seats on a pole of `kind`: on its insulators' tops. */
export function primarySeats(kind: PoleKind): readonly WireSeat[] {
  return POLE_PRIMARY[kind].map((along) => ({ along, rise: POLE_INSULATOR_TALL - POLE_ARM_DROP }));
}

/** The secondary wires' seats: on an urban pole's rack, none on a rural one. */
export function secondarySeats(kind: PoleKind): readonly WireSeat[] {
  return kind === 'urban' ? POLE_SECONDARY_DROPS.map((drop) => ({ along: POLE_SECONDARY_OUT, rise: -drop })) : [];
}

/** The wires a span between poles of these kinds carries: the three primary always, the two secondary between two urban poles. */
export function spanCarries(a: PoleKind, b: PoleKind): { readonly primary: number; readonly secondary: number } {
  return { primary: POLE_PRIMARY.urban.length, secondary: a === 'urban' && b === 'urban' ? POLE_SECONDARY_DROPS.length : 0 };
}

/** Which way a pole's arms reach out (toward the street): the way to the kerb, or off the streets a way fixed in the world - its arm turned
 *  positive along its larger axis, the same at every pole of a line however it wanders, so its wires never cross from one side to the other
 *  between two poles (a sign of x alone flipped between the poles of a line running along y). */
export function poleToward(kerb: Vec2 | null, arm: Vec2): Vec2 {
  if (kerb) return kerb;
  const back = Math.abs(arm.x) >= Math.abs(arm.y) ? arm.x < 0 : arm.y < 0;
  return back ? { x: -arm.x, y: -arm.y } : arm;
}

/** An arm turned to reach toward the street (`poleToward`): itself or its opposite. */
export function streetArm(arm: Vec2, toward: Vec2): Vec2 {
  return arm.x * toward.x + arm.y * toward.y >= 0 ? arm : { x: -arm.x, y: -arm.y };
}

export interface UtilitySpan {
  readonly id: SpanId;
  a: PoleId;
  b: PoleId;
}

/** Sag at the middle of a span of this length. */
export function spanSag(length: number): number {
  return Math.min(WIRE_MAX_SAG, length * WIRE_SAG_RATIO);
}

/** Height of a catenary above the chord, at normalised position `t` in [0, 1]. */
export function wireDrop(t: number, sag: number): number {
  const u = t * 2 - 1;
  return sag * (1 - u * u);
}

/** Which poles of a run carry a lamp. */
export const poleCarriesLamp = (index: number): boolean => index % 2 === 0;

/** What the poles of a new run carry: a street light on none, every other one, or all of them. */
export const POLE_LAMP_MODES = ['none', 'alternate', 'all'] as const;
export type PoleLampMode = (typeof POLE_LAMP_MODES)[number];

/** Deflection at and above which a pole is a CORNER: each line leaving it gets its own cross-arm, square to that line */
const CORNER_DEFLECTION = (60 * Math.PI) / 180;

/** The cross-arms of one pole: every distinct arm, and the one each span hangs from. */
export interface PoleArms {
  /** Unit directions of the arms on this pole, one per physical arm. */
  readonly arms: readonly Vec2[];
  /** Per span reaching this pole: the arm it hangs from, oriented to the LEFT of the span's a -> b. */
  readonly bySpan: ReadonlyMap<SpanId, Vec2>;
}

const perp = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });
const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 1 };
};

/** Which way every pole's cross-arm lies, as line construction standards frame a pole */
export function poleArms(
  poles: ReadonlyMap<PoleId, UtilityPole>,
  spans: ReadonlyMap<SpanId, UtilitySpan>,
  idle: (pole: UtilityPole) => Vec2 = () => ({ x: 0, y: 1 }),
): Map<PoleId, PoleArms> {
  const reaching = new Map<PoleId, UtilitySpan[]>();
  for (const span of spans.values()) {
    if (!poles.has(span.a) || !poles.has(span.b)) continue;
    for (const end of [span.a, span.b]) {
      const list = reaching.get(end);
      if (list) list.push(span);
      else reaching.set(end, [span]);
    }
  }
  const out = new Map<PoleId, PoleArms>();
  for (const pole of poles.values()) out.set(pole.id, poleArmsAt(pole, reaching.get(pole.id) ?? [], poles, idle));
  return out;
}

/** One pole's arms (`poleArms`), from the spans reaching it in the order they were strung */
export function poleArmsAt(
  pole: UtilityPole,
  reaching: Iterable<UtilitySpan>,
  poles: ReadonlyMap<PoleId, UtilityPole>,
  idle: (pole: UtilityPole) => Vec2 = () => ({ x: 0, y: 1 }),
): PoleArms {
  const lines: { span: UtilitySpan; d: Vec2 }[] = [];
  for (const span of reaching) {
    const a = poles.get(span.a);
    const b = poles.get(span.b);
    if (!a || !b) continue;
    if (span.a === pole.id) lines.push({ span, d: unit({ x: b.x - a.x, y: b.y - a.y }) });
    if (span.b === pole.id) lines.push({ span, d: unit({ x: a.x - b.x, y: a.y - b.y }) });
  }
  const bySpan = new Map<SpanId, Vec2>();
  /** The arm for a span, turned to lie left of the span's own a -> b. */
  const oriented = (arm: Vec2, span: UtilitySpan): Vec2 => {
    const a = poles.get(span.a)!;
    const b = poles.get(span.b)!;
    const along = { x: b.x - a.x, y: b.y - a.y };
    return along.x * arm.y - along.y * arm.x >= 0 ? arm : { x: -arm.x, y: -arm.y };
  };
  if (lines.length === 0) return { arms: [unit(idle(pole))], bySpan };
  if (lines.length === 1) {
    const arm = perp(lines[0]!.d);
    bySpan.set(lines[0]!.span.id, oriented(arm, lines[0]!.span));
    return { arms: [arm], bySpan };
  }
  if (lines.length === 2) {
    const [p, q] = lines as [{ span: UtilitySpan; d: Vec2 }, { span: UtilitySpan; d: Vec2 }];
    // Deflection: how far the line turns here (0 on a straight run).
    const cos = Math.max(-1, Math.min(1, -(p.d.x * q.d.x + p.d.y * q.d.y)));
    if (Math.acos(cos) < CORNER_DEFLECTION) {
      // The line's direction through the pole; the arm square to it lies on the bisector.
      const arm = perp(unit({ x: p.d.x - q.d.x, y: p.d.y - q.d.y }));
      bySpan.set(p.span.id, oriented(arm, p.span));
      bySpan.set(q.span.id, oriented(arm, q.span));
      return { arms: [arm], bySpan };
    }
  }
  const arms: Vec2[] = [];
  for (const line of lines) {
    const arm = perp(line.d);
    bySpan.set(line.span.id, oriented(arm, line.span));
    // Two lines leaving straight through each other share one arm.
    if (!arms.some((other) => Math.abs(other.x * arm.y - other.y * arm.x) < 0.09)) arms.push(arm);
  }
  return { arms, bySpan };
}
