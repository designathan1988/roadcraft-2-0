import {
  BufferGeometry,
  BoxGeometry,
  BufferAttribute,
  InstancedBufferGeometry,
  type InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  DoubleSide,
  Material,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Object3D,
  RGBADepthPacking,
  PlaneGeometry,
  CanvasTexture,
  SRGBColorSpace,
  RepeatWrapping,
} from 'three';

import type { Network } from '@world/network';
import { m } from '@world/units';
import { BEAM_FADE, LAMP_BEAM_RADIUS, LAMP_POOL_RADIUS, type SceneryKit } from './scenery';
import { GROUND_ONLY, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { footwayRiseAt } from '@world/roads/footwayRise';
import {
  POLE_ARM_DROP,
  POLE_ARM_HALF,
  POLE_ARM_THICK,
  POLE_BASE_RADIUS,
  POLE_HEIGHT,
  POLE_LAMP_DROP,
  POLE_LAMP_LONG,
  POLE_LAMP_REACH,
  POLE_LAMP_TALL,
  POLE_LAMP_WIDE,
  POLE_TOP_RADIUS,
  WIRE_COURSES,
  WIRE_OFFSETS,
  type PoleArms,
  spanSag,
} from '@world/utilities';
import { angleOf } from '@core/vec2';
import { WIRE_WIND_UNIFORMS_GLSL, windUniforms, wireWindGlsl } from './wind';
import { cylinderWith } from './mesh/cylinder';

/** Pin insulator on the cross-arm. */
const INSULATOR_RADIUS = m(0.07);
const INSULATOR_TALL = m(0.2);
/** Arm braces: how far below the arm they meet the mast, and their section. */
const BRACE_DROP = m(0.55);
const BRACE_THICK = m(0.05);
/** Pole-top transformer can. */
const CAN_RADIUS = m(0.28);
/** Rise of the lamp bracket from the pole to the head. */
const LAMP_TILT = (8 * Math.PI) / 180;
/** How far a wire swings at mid-span in a full gust. */
const WIRE_SWING = m(0.35);
/** Half-width of a drawn cable: thicker than life so it reads at play zoom. */
const WIRE_RADIUS = m(0.035);
/** A drawn cable's width as the eye sees it: the mean width of a square section of `WIRE_RADIUS` turned every way (perimeter / pi), the tube
 *  it was drawn as until 2026-10-25. */
export const WIRE_WIDTH = (4 * Math.SQRT2 * WIRE_RADIUS) / Math.PI;
/**
 * The least width a cable is drawn on a target of `samples` a pixel, in pixels: a thinner one is drawn this wide, covering the share of it the
 * cable fills (`WIRE_GLSL`; Humus's phone-wire AA, a pixel). With four samples or more, 0.6: the standard four sample places (0.375, 0.125),
 * (0.875, 0.375), (0.125, 0.625), (0.625, 0.875) are a square grid turned 26.6 deg, its rows sqrt(5) / 4 = 0.559 px apart, so a strip 0.6 px wide
 * holds a row of them whichever way it runs and is never broken; a pixel would spread a cable twice as wide as it need be and pale the
 * wires of a span seen a pixel apart from the air (their shares overlapping: a third of their darkness lost, 2026-10-25). Sample places:
 * https://registry.khronos.org/VulkanSC/specs/1.0-extensions/man/html/VkSampleLocationsInfoEXT.html,
 * https://swiftshader.googlesource.com/SwiftShader.git/+/HEAD/src/Pipeline/Constants.hpp.
 */
export function wireClampPixels(samples: number): number {
  return samples >= 4 ? 0.6 : 1;
}
/** A cable at least this many pixels wide shows the tube's two faces, creased between them; a thinner one their mean, flat (`WIRE_GLSL`). */
const WIRE_CREASE_PIXELS = 1.5;
/** A cable seen thinner than this many pixels is not drawn: it covers no more than this share of its pixels. */
export const WIRE_MIN_PIXELS = 1 / 32;
import type { UtilityPole, UtilitySpan } from '@world/utilities';

/** The overhead utility network on screen: poles, cross-arms, wires and lamps. */

export interface Utilities {
  readonly group: Object3D;
  readonly triangles: number;
  dispose(): void;
}

export interface Placement {
  x: number;
  y: number;
  /** Height above the ground, in world units. */
  z: number;
  yaw: number;
  /** Tilt of the part's local X axis up from level, radians (a brace, a lamp bracket). */
  roll?: number;
  sx: number;
  sy: number;
  sz: number;
}

/** The instanced parts of a pole, by index into `polePartSpecs` and `placePole`'s lists. */
const POLE_PART = {
  mast: 0, arm: 1, cap: 2, brace: 3, insulator: 4, can: 5, lampArm: 6, lampHead: 7, lens: 8, pool: 9, beam: 10,
} as const;
export const POLE_PART_COUNT = 11;

/** A shape a part may be drawn with, and how far (world units) its outline strays from the part's own. */
export interface PartLevel {
  readonly geometry: BufferGeometry;
  readonly error: number;
}

/** One instanced part: its mesh's name, shape and material, and how it takes light and shadow. */
export interface PolePartSpec {
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly renderOrder: number;
  /** The light a lamp throws on the street (pool, beam): drawn at any size, seen at night from across the map. */
  readonly glows: boolean;
  /** How many times a lit surface's brightness it shines: a lens lit at night is seen smaller than a pixel (coverage times brightness). */
  readonly brightness: () => number;
  /** Its shapes, finest first: the first is `geometry`, the others coarser (`PoleLayer` picks by the error on the screen). */
  readonly levels: readonly PartLevel[];
  /** World units from the eye past which its material fades it out whole (a lamp's cone): not drawn where all of it stands deeper (`poleLayer.ts` view). */
  readonly fadesAt?: number;
}

const unlit = (): number => 1;

/** The parts in `POLE_PART` order: the catalogue's shapes and materials, the lamps' light from the scenery's kit. */
export function polePartSpecs(kit: SceneryKit): readonly PolePartSpec[] {
  const { metal, timber, housing, porcelain, steel, mastLevels, capGeometry, insulatorGeometry, canGeometry, boxGeometry, lensGeometry } = PARTS;
  const solid = (name: string, geometry: BufferGeometry, material: Material, levels: readonly PartLevel[] = [{ geometry, error: 0 }]): PolePartSpec =>
    ({ name, geometry, material, castShadow: true, receiveShadow: true, renderOrder: 0, glows: false, brightness: unlit, levels });
  const light = (name: string, geometry: BufferGeometry, material: Material, renderOrder: number): PolePartSpec =>
    ({ name, geometry, material, castShadow: false, receiveShadow: false, renderOrder, glows: true, brightness: unlit, levels: [{ geometry, error: 0 }] });
  // The lens shines the kit's glow, brighter at night (`SceneryKit.setNight`).
  const lens: PolePartSpec = {
    name: 'utility-lamp-lenses', geometry: lensGeometry, material: kit.glow, castShadow: false, receiveShadow: true, renderOrder: 0,
    glows: false, brightness: () => Math.max(1, kit.glow.color.r, kit.glow.color.g, kit.glow.color.b), levels: [{ geometry: lensGeometry, error: 0 }],
  };
  return [
    solid('utility-poles', mastLevels[0]!.geometry, timber, mastLevels),
    solid('utility-arms', boxGeometry, timber),
    solid('utility-caps', capGeometry, steel, PARTS.capLevels),
    solid('utility-braces', boxGeometry, steel),
    solid('utility-insulators', insulatorGeometry, porcelain, PARTS.insulatorLevels),
    solid('utility-transformers', canGeometry, steel, PARTS.canLevels),
    solid('utility-lamp-arms', boxGeometry, metal),
    solid('utility-lamp-heads', boxGeometry, housing),
    lens,
    light('utility-lamp-pools', kit.pool, kit.poolGlow, 3),
    // Its cone faded out whole past `BEAM_FADE` from the eye (`scenery.ts` beamMaterial): not drawn there.
    { ...light('utility-lamp-beams', kit.beam, kit.beamGlow, 4), fadesAt: BEAM_FADE[1] },
  ];
}

/** The wires' materials, from the catalogue made at load. */
export function wireParts(): { readonly material: MeshStandardMaterial; readonly depth: MeshDepthMaterial } {
  return { material: PARTS.wireMaterial, depth: PARTS.wireDepth };
}

/** One pole's parts, pushed onto `out` by `POLE_PART` */
export function placePole(
  pole: UtilityPole,
  top: number,
  frame: PoleArms,
  kerb: { x: number; y: number } | null,
  groundAt: (x: number, y: number) => number,
  out: Placement[][],
): void {
  const base = top - POLE_HEIGHT;
  out[POLE_PART.mast]!.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT / 2, yaw: 0, sx: 1, sy: 1, sz: 1 });
  // A pole cap: the weathering cap on the crown of a timber pole.
  out[POLE_PART.cap]!.push({ x: pole.x, y: pole.y, z: base + POLE_HEIGHT + m(0.03), yaw: 0, sx: 1, sy: 1, sz: 1 });

  // An instanced box is scaled on its LOCAL X and then rotated about Y
  for (const arm of frame.arms) {
    const armZ = top - POLE_ARM_DROP;
    out[POLE_PART.arm]!.push({
      x: pole.x, y: pole.y, z: armZ, yaw: angleOf(arm),
      sx: POLE_ARM_HALF * 2, sy: POLE_ARM_THICK, sz: POLE_ARM_THICK,
    });
    // Pin insulators on the arm, one under each wire of the top course.
    for (const offset of WIRE_OFFSETS) {
      out[POLE_PART.insulator]!.push({
        x: pole.x + arm.x * POLE_ARM_HALF * offset,
        y: pole.y + arm.y * POLE_ARM_HALF * offset,
        z: armZ + POLE_ARM_THICK / 2 + INSULATOR_TALL / 2,
        yaw: 0, sx: 1, sy: 1, sz: 1,
      });
    }
    // Two flat braces from the mast up to the arm, one each side.
    for (const side of [1, -1]) {
      const reach = POLE_ARM_HALF * 0.6;
      const drop = BRACE_DROP;
      out[POLE_PART.brace]!.push({
        x: pole.x + arm.x * side * reach / 2,
        y: pole.y + arm.y * side * reach / 2,
        z: armZ - drop / 2,
        yaw: angleOf({ x: arm.x * side, y: arm.y * side }),
        roll: Math.atan2(drop, reach),
        sx: Math.hypot(reach, drop),
        sy: BRACE_THICK,
        sz: BRACE_THICK * 0.5,
      });
    }
  }
  // A pole-top transformer on some poles, hung on the side away from the street.
  if (pole.id % 5 === 3) {
    const away = kerb ?? frame.arms[0] ?? { x: 0, y: 1 };
    out[POLE_PART.can]!.push({
      x: pole.x - away.x * (POLE_BASE_RADIUS + CAN_RADIUS),
      y: pole.y - away.y * (POLE_BASE_RADIUS + CAN_RADIUS),
      z: top - POLE_ARM_DROP - m(1.6),
      yaw: 0, sx: 1, sy: 1, sz: 1,
    });
  }

  if (!pole.lamp) return;
  // The light reaches out over the street, square to the kerb, whichever way the wires run
  const reach = kerb ?? frame.arms[0] ?? { x: 0, y: 1 };
  const reachYaw = angleOf(reach);
  const headX = pole.x + reach.x * POLE_LAMP_REACH;
  const headY = pole.y + reach.y * POLE_LAMP_REACH;
  const headZ = top - POLE_LAMP_DROP;
  out[POLE_PART.lampArm]!.push({
    x: pole.x + reach.x * (POLE_LAMP_REACH / 2),
    y: pole.y + reach.y * (POLE_LAMP_REACH / 2),
    z: headZ - Math.tan(LAMP_TILT) * POLE_LAMP_REACH / 2,
    yaw: reachYaw,
    // The bracket rises gently from the pole to the head, as a davit does.
    roll: LAMP_TILT,
    sx: POLE_LAMP_REACH / Math.cos(LAMP_TILT),
    sy: POLE_ARM_THICK * 0.8,
    sz: POLE_ARM_THICK * 0.8,
  });
  out[POLE_PART.lampHead]!.push({ x: headX, y: headY, z: headZ - POLE_LAMP_TALL / 2, yaw: reachYaw, sx: POLE_LAMP_LONG, sy: POLE_LAMP_TALL, sz: POLE_LAMP_WIDE });
  // The lens under the head and the pool of light on the street, lit with the street lights' own materials
  const lensZ = headZ - POLE_LAMP_TALL - m(0.004);
  const below = groundAt(headX, headY);
  out[POLE_PART.lens]!.push({ x: headX, y: headY, z: lensZ, yaw: reachYaw, sx: POLE_LAMP_LONG * 0.8, sy: 1, sz: POLE_LAMP_WIDE * 0.8 });
  out[POLE_PART.pool]!.push({ x: headX, y: headY, z: below + m(0.012), yaw: 0, sx: LAMP_POOL_RADIUS, sy: 1, sz: LAMP_POOL_RADIUS });
  // And the cone of light between them.
  out[POLE_PART.beam]!.push({ x: headX, y: headY, z: lensZ, yaw: 0, sx: LAMP_BEAM_RADIUS, sy: Math.max(m(0.004), lensZ - below), sz: LAMP_BEAM_RADIUS });
}

const placing = new Object3D();
/** A part's matrix into `array` at `offset`, as `InstancedMesh.setMatrixAt` writes it. World y is mirrored into three's z. */
export function writePlacement(placement: Placement, array: Float32Array, offset: number): void {
  placing.position.set(placement.x, placement.z, -placement.y);
  placing.rotation.set(0, placement.yaw, placement.roll ?? 0);
  placing.scale.set(placement.sx, placement.sy, placement.sz);
  placing.updateMatrix();
  placing.matrix.toArray(array, offset);
}

/** Wires a span carries: every course and offset of the arms. */
export const SPAN_WIRES = WIRE_COURSES.length * WIRE_OFFSETS.length;
/** Numbers a wire's instance holds: its two ends in three's axes, its sag, its phase in the wind. */
export const WIRE_STRIDE = 8;

/** DO NOT build the wires' vertices on the CPU again. */
export function spanWires(
  span: UtilitySpan,
  a: { readonly x: number; readonly y: number; readonly top: number; readonly arm: { x: number; y: number } },
  b: { readonly x: number; readonly y: number; readonly top: number; readonly arm: { x: number; y: number } },
  out: Float32Array,
  at: number,
): void {
  const phase = (span.id * 2.399) % (Math.PI * 2);
  let o = at;
  // Every course and offset of the arms, as `sampleWire` lays them: its ends, and its sag from their distance.
  for (const course of WIRE_COURSES) {
    for (const offset of WIRE_OFFSETS) {
      const ax = a.x + a.arm.x * POLE_ARM_HALF * offset, ay = a.y + a.arm.y * POLE_ARM_HALF * offset, az = a.top - POLE_ARM_DROP + course;
      const bx = b.x + b.arm.x * POLE_ARM_HALF * offset, by = b.y + b.arm.y * POLE_ARM_HALF * offset, bz = b.top - POLE_ARM_DROP + course;
      // In three's axes: x, height, -y.
      out[o] = ax; out[o + 1] = az; out[o + 2] = -ay;
      out[o + 3] = bx; out[o + 4] = bz; out[o + 5] = -by;
      out[o + 6] = spanSag(Math.hypot(bx - ax, by - ay)); out[o + 7] = phase;
      o += WIRE_STRIDE;
    }
  }
}

/** Half-width of a drawn cable (`WIRE_GLSL`), for the wires' bounds. */
export const WIRE_HALF_WIDTH = WIRE_RADIUS;

/** One way of drawing a wire, shared by every cell's wires: a strip of (t along the wire, t again, corner) bent along each wire (`WIRE_GLSL`). */
interface WireTemplate {
  readonly position: BufferAttribute;
  readonly normal: BufferAttribute;
  readonly index: BufferAttribute;
  /** Chords it bends the wire into. */
  readonly segments: number;
}

/**
 * A strip of `segments` chords square to the eye, `creased` in two halves along the crease between the tube's two faces the eye sees: four
 * corners a column - 4 the `+side` edge, 6 the crease of the upper half, 7 the crease of the lower, 5 the `-side` edge - wound to face the eye
 * (`WIRE_GLSL`), or the edges alone (for wires all thinner than `WIRE_CREASE_PIXELS`); `normal.x` holds `segments`, the most chords a wire
 * drawn with it may keep (`wireChords`), `normal.y` 1 when creased. A cable is a ribbon facing the eye
 * whatever its size on the screen, as wide as the tube's silhouette and each half lit by its face: DO NOT draw it as a tube again. The tube of
 * four faces drew 8 triangles and 16 vertices a segment for what this strip draws with 4 triangles a chord, 2 once thinner than
 * `WIRE_CREASE_PIXELS` (the camera-facing ribbon power lines are drawn as: https://www.humus.name/index.php?page=3D&ID=89,
 * https://www.alanzucconi.com/?p=12724).
 */
function stripTemplate(segments: number, creased: boolean): WireTemplate {
  const corners = creased ? [4, 6, 7, 5] : [4, 5];
  const across = corners.length, vertices = (segments + 1) * across;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const index = new Uint16Array(segments * (across / 2) * 6);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    corners.forEach((corner, k) => {
      position.set([t, t, corner], (s * across + k) * 3);
      normal.set([segments, creased ? 1 : 0, 0], (s * across + k) * 3);
    });
    if (s === segments) continue;
    // Each half (or the strip): its `+side` corner a, its `-side` corner b; a, b(next), a(next) and a, b, b(next) are anticlockwise as the eye
    // sees them (`side` = tangent x view ray).
    for (let half = 0; half < across / 2; half++) {
      const a = s * across + half * 2, n = a + across;
      index.set([a, n + 1, n, a, a + 1, n + 1], (s * (across / 2) + half) * 6);
    }
  }
  return { position: new BufferAttribute(position, 3), normal: new BufferAttribute(normal, 3), index: new BufferAttribute(index, 1), segments };
}

/** The chords of the ways of drawing a wire, finest first: the finest as many as the tube's segments. */
const WIRE_CHORDS = [8, 4, 2, 1] as const;
/** The ways of drawing a wire, finest first: creased strips of 8, 4, 2 and 1 chords, then plain ones. Made once, at load. */
const WIRE_TEMPLATES: readonly WireTemplate[] = [...WIRE_CHORDS.map((n) => stripTemplate(n, true)), ...WIRE_CHORDS.map((n) => stripTemplate(n, false))];

/**
 * The fewest chords that bend a wire of `sag` seen at `pixelsPerUnit` within a pixel of its parabola (a chord of 1/n of it strays from it by
 * sag / n^2), the finest at most. The vertex shader keeps the same for each wire (`WIRE_GLSL` wireChords).
 */
export function wireChords(pixelsPerUnit: number, sag: number): number {
  for (let i = WIRE_CHORDS.length - 1; i > 0; i--) {
    const n = WIRE_CHORDS[i]!;
    if ((sag * pixelsPerUnit) / (n * n) < 1) return n;
  }
  return WIRE_CHORDS[0];
}

/**
 * How to draw the wires of a block whose nearest point is seen at `pixelsPerUnit`, with at most `sag` of sag: the template of the chords its
 * nearest wire needs (`wireGeometry`; each farther wire keeps fewer of them, `WIRE_GLSL`), creased while that wire is `WIRE_CREASE_PIXELS`
 * wide or more, or -1 when even the nearest is too thin to draw.
 */
export function wireLevel(pixelsPerUnit: number, sag: number): number {
  const wide = WIRE_WIDTH * pixelsPerUnit;
  if (wide < WIRE_MIN_PIXELS) return -1;
  return WIRE_CHORDS.indexOf(wireChords(pixelsPerUnit, sag) as (typeof WIRE_CHORDS)[number]) + (wide >= WIRE_CREASE_PIXELS ? 0 : WIRE_CHORDS.length);
}

/** A cell's wires drawn with one template: the template's shared attributes and the cell's instances (eight numbers a wire). */
export function wireGeometry(level: number, instances: InstancedInterleavedBuffer): InstancedBufferGeometry {
  const template = WIRE_TEMPLATES[level]!;
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(template.index);
  geometry.setAttribute('position', template.position);
  geometry.setAttribute('normal', template.normal);
  geometry.setAttribute('aStart', new InterleavedBufferAttribute(instances, 3, 0));
  geometry.setAttribute('aEnd', new InterleavedBufferAttribute(instances, 3, 3));
  geometry.setAttribute('aSagPhase', new InterleavedBufferAttribute(instances, 2, 6));
  return geometry;
}

/** A wire geometry let go: its instances' buffer freed on the GPU, the templates' kept (three's dispose frees every attribute it holds). */
export function releaseWireGeometry(geometry: InstancedBufferGeometry): void {
  geometry.setIndex(null);
  geometry.deleteAttribute('position');
  geometry.deleteAttribute('normal');
  geometry.dispose();
}

/** The screen the wires are drawn on: half its height in pixels, 0 before a layer has seen it (no fade), and the least width a wire is drawn
 *  there (`wireClampPixels`). Set by `PoleLayer`. */
export const wireScreen = { uWirePixels: { value: 0 }, uWireClamp: { value: 1 } };

/**
 * A wire's vertex in the vertex shader, from its template and its instance (in three's axes): `wirePosition(pixels)` gives the vertex and
 * sets `wireT` (its place along the wire), `wireCover` (the share of its pixels it covers) and `wireNormal`; `pixels` is half the screen's
 * height, 0 for the sun's pass (the template's every chord, the wire's own width, all of it covering).
 *
 * The strip draws the tube the cable was drawn as until 2026-10-25 (a square section of `WIRE_RADIUS`, corners u, w, -u, -w round the wire)
 * as the eye sees it: as wide as its silhouette, creased where its two faces seen meet, each half lit by its face (the crease an edge the
 * multisampling smooths as it did the tube's): the cable as it looked, with 4 triangles a chord where the tube took 8 a segment.
 *
 * Each wire keeps the chords its own nearest point needs (`wireChords`), however near its block's nearest: a template's columns past them
 * fall on the ones kept, their triangles of no area (none drawn by the rasterizer). Thinner than the least width its samples hold
 * (`wireClampPixels`) a wire is drawn that wide, covering the share of it the wire fills (Humus, "Phone-wire AA", GPU Pro 5, 2014:
 * https://www.humus.name/index.php?page=3D&ID=89): DO NOT shrink it below that again - its few samples came and went along it, a dotted wire
 * crawling as the view moved.
 */
const WIRE_GLSL = `
        uniform float uWireClamp;
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute vec2 aSagPhase;
        float wireT;
        float wireCover;
        vec3 wireNormal;
        vec3 wireAt(float t) {
          float u = t * 2.0 - 1.0;
          vec3 p = mix(aStart, aEnd, t);
          p.y -= aSagPhase.x * (1.0 - u * u);
          return p;
        }
        // Pixels a unit spans at the wire's nearest point: its chord's nearest to the eye, less its sag (never farther than the wire).
        float wireScale(float pixels) {
          if (!isPerspectiveMatrix(projectionMatrix)) return pixels * projectionMatrix[1][1];
          vec3 c = aEnd - aStart;
          float k = clamp(dot(cameraPosition - aStart, c) / max(dot(c, c), 1e-8), 0.0, 1.0);
          return pixels * projectionMatrix[1][1] / max(length(aStart + c * k - cameraPosition) - aSagPhase.x, 1e-4);
        }
        // The chords the wire keeps (wireChords on the CPU): the fewest powers of two keeping its sag within a pixel, at most the template's.
        float wireChords(float scale, float finest) {
          float need = sqrt(aSagPhase.x * scale);
          return min(finest, need < 1.0 ? 1.0 : exp2(floor(log2(need)) + 1.0));
        }
        vec3 wirePosition(float pixels) {
          float chords = pixels > 0.0 ? wireChords(wireScale(pixels), normal.x) : normal.x;
          wireT = floor(position.x * chords + 0.5) / chords;
          vec3 p = wireAt(wireT);
          // A strip across the curve's tangent d, square to the ray from the eye.
          vec3 d = aEnd - aStart;
          d.y += 4.0 * aSagPhase.x * (wireT * 2.0 - 1.0);
          d = normalize(d);
          vec3 ray = isPerspectiveMatrix(projectionMatrix) ? p - cameraPosition : -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
          vec3 side = cross(d, ray);
          float sl = length(side);
          side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
          // The square tube round d (corners u, w, -u, -w, u level) seen across 'side': its silhouette's corners, at +-h radii across, and
          // between them the corner facing the eye, at 'split' of h, the crease of the two faces the eye sees.
          vec3 u = vec3(-d.z, 0.0, d.x);
          float ul = length(u);
          u = ul > 1e-6 ? u / ul : vec3(1.0, 0.0, 0.0);
          vec3 w = normalize(cross(u, d));
          float au = dot(u, side), aw = dot(w, side);
          bool level = abs(au) >= abs(aw);
          vec3 edge = level ? (au >= 0.0 ? u : -u) : (aw >= 0.0 ? w : -w);
          vec3 mid = level ? w : u;
          mid = dot(mid, ray) <= 0.0 ? mid : -mid;
          float h = max(abs(au), abs(aw));
          float split = dot(mid, side) / h;
          vec3 high = normalize(edge + mid), low = normalize(mid - edge);
          float width = 2.0 * ${WIRE_RADIUS.toFixed(6)} * h;
          // Its width on the screen here: under uWireClamp px drawn that wide, covering the share it fills; under ${WIRE_MIN_PIXELS.toFixed(4)} px none.
          float wide = 1e6;
          wireCover = 1.0;
          if (pixels > 0.0) {
            float depth = isPerspectiveMatrix(projectionMatrix) ? max(-(modelViewMatrix * vec4(p, 1.0)).z, 1e-4) : 1.0;
            wide = width * pixels * projectionMatrix[1][1] / depth;
            wireCover = wide < ${WIRE_MIN_PIXELS.toFixed(6)} ? 0.0 : min(wide / uWireClamp, 1.0);
            width = wireCover > 0.0 ? width / wireCover : 0.0;
          }
          // Corners 4 and 6 the upper half, lit by the face at +side; 7 and 5 the lower. Under ${WIRE_CREASE_PIXELS} px the creases fall on the
          // +side edge (the upper half of no area) and the strip is lit by the faces' mean, by their shares of it.
          float corner = position.z;
          bool creased = normal.y > 0.5 && wide >= ${WIRE_CREASE_PIXELS.toFixed(2)};
          float across = corner < 4.5 ? 1.0 : corner < 5.5 ? -1.0 : creased ? split : 1.0;
          wireNormal = creased ? (corner < 4.5 || corner > 5.5 && corner < 6.5 ? high : low) : normalize(high * (1.0 - split) + low * (1.0 + split));
          return p + side * (across * 0.5 * width);
        }`;

/** The wires' materials: lit with the wind, and the shadow's depth, both bending the template along each wire. */
function wireMaterials(): { readonly lit: MeshStandardMaterial; readonly depth: MeshDepthMaterial } {
  // Blended: a wire under a pixel covers a share of the pixel it is drawn across (`WIRE_GLSL`); one pass for both faces (three draws a
  // two-sided transparent material twice otherwise), the strip facing the eye.
  const lit = new MeshStandardMaterial({ color: 0x1e2224, roughness: 0.55, metalness: 0.3, side: DoubleSide, transparent: true });
  lit.forceSinglePass = true;
  lit.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windUniforms, { uWireAmp: { value: WIRE_SWING } }, wireScreen);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_WIND_UNIFORMS_GLSL}
        uniform float uWirePixels;
        varying float vWireCover;${WIRE_GLSL}`)
      .replace('#include <beginnormal_vertex>', `
        vec3 wirePoint = wirePosition(uWirePixels);
        vec3 objectNormal = wireNormal;
        vWireCover = wireCover;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = wirePoint;
        float wireSwing = 4.0 * wireT * (1.0 - wireT);${wireWindGlsl('wireSwing', 'aSagPhase.y')}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vWireCover;`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        diffuseColor.a *= vWireCover;`);
  };
  lit.customProgramCacheKey = () => 'wire-ribbon';
  // The shadow as it was: the wire at rest, without the wind, the tube's silhouette as the sun sees it.
  // // No colour: the sun's maps are read by their depth texture alone (three r186 PCF compares `shadow.map.depthTexture`), nothing reads the packed colour (AGT-35).
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wireScreen);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${WIRE_GLSL}`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = wirePosition(0.0);`);
  };
  depth.customProgramCacheKey = () => 'wire-ribbon-depth';
  return { lit, depth };
}

/** The pole layer's materials and shapes, one set for every build (the built layer and the run's preview). */
interface UtilityParts {
  readonly metal: MeshStandardMaterial;
  readonly timber: MeshStandardMaterial;
  readonly housing: MeshStandardMaterial;
  readonly wireMaterial: MeshStandardMaterial;
  readonly wireDepth: MeshDepthMaterial;
  readonly porcelain: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  /** The mast, finest first (`mastShape`). */
  readonly mastLevels: readonly PartLevel[];
  /** The cap, the insulator and the transformer's can, finest first (`roundShape`): their first level their geometry. */
  readonly capLevels: readonly PartLevel[];
  readonly insulatorLevels: readonly PartLevel[];
  readonly canLevels: readonly PartLevel[];
  readonly capGeometry: BufferGeometry;
  readonly insulatorGeometry: BufferGeometry;
  readonly canGeometry: BufferGeometry;
  readonly boxGeometry: BoxGeometry;
  readonly lensGeometry: BufferGeometry;
}
/** Made once, at load (`PARTS`, the end of this file), never disposed (a few materials and small shapes) */
function makeUtilityParts(): UtilityParts {
  const parts = madeUtilityParts();
  // Each shape's bounds once, at load: the pole layer grows its meshes' bounds from the spheres, and sizes a piece on the screen from the boxes.
  const levels = [parts.mastLevels, parts.capLevels, parts.insulatorLevels, parts.canLevels].flatMap((list) => list.map((level) => level.geometry));
  for (const geometry of [...levels, parts.capGeometry, parts.insulatorGeometry, parts.canGeometry, parts.boxGeometry, parts.lensGeometry]) {
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }
  return parts;
}

function madeUtilityParts(): UtilityParts {
  const metal = new MeshStandardMaterial({
    color: 0x4a4a46,
    roughness: 0.68,
    metalness: 0.35,
  });
  // Creosoted timber: a grain of long streaks up the pole, a few knots and checks
  const timber = new MeshStandardMaterial({
    color: 0xffffff,
    map: woodTexture(),
    roughness: 0.92,
    metalness: 0,
  });
  // The luminaire as seen from above: its housing.
  const housing = new MeshStandardMaterial({ color: 0xa9b0ad, roughness: 0.5, metalness: 0.3 });
  const wires = wireMaterials();
  // Each round piece, finest first: its own sides, then fewer, each as wide on average (`roundShape`).
  const cap = [10, 6, 4].map((sides) => roundShape(POLE_TOP_RADIUS * 0.4, POLE_TOP_RADIUS * 1.15, m(0.08), sides, 10, { top: true, bottom: true }));
  // Its foot stands on the arm.
  const insulator = [10, 6, 4].map((sides) => roundShape(INSULATOR_RADIUS * 0.55, INSULATOR_RADIUS, INSULATOR_TALL, sides, 10, { top: true, bottom: false }));
  const can = [14, 8, 5].map((sides) => roundShape(CAN_RADIUS, CAN_RADIUS, m(0.95), sides, 14, { top: true, bottom: true }));
  return {
    metal, timber, housing, wireMaterial: wires.lit, wireDepth: wires.depth,
    // A pin insulator: a glazed porcelain bell on a short pin.
    porcelain: new MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.25, metalness: 0 }),
    steel: new MeshStandardMaterial({ color: 0x8c9590, roughness: 0.45, metalness: 0.55 }),
    mastLevels: [12, 6, 3].map(mastShape),
    capLevels: cap, insulatorLevels: insulator, canLevels: can,
    capGeometry: cap[0]!.geometry,
    insulatorGeometry: insulator[0]!.geometry,
    canGeometry: can[0]!.geometry,
    boxGeometry: new BoxGeometry(1, 1, 1),
    // One face, looking down: a lens only shines down (see `lampLensGeometry`).
    lensGeometry: new PlaneGeometry(1, 1).rotateX(Math.PI / 2),
  };
}

/** The mast with `sides` sides and no ends: its base stands in the ground, its crown inside the cap (`placePole`: the cap's foot 1 cm below the
 *  crown, 15 % wider); a coarse one as wide as the round one on average */
function mastShape(sides: number): PartLevel {
  // A polygon's mean width is its perimeter over pi: 2 n R sin(pi / n) / pi = 2 r.
  const widen = sides >= 12 ? 1 : Math.PI / (sides * Math.sin(Math.PI / sides));
  const geometry = cylinderWith(POLE_TOP_RADIUS * widen, POLE_BASE_RADIUS * widen, POLE_HEIGHT, sides, { top: false, bottom: false });
  // How far its outline strays from a round mast at the foot: outside at a corner, inside mid-face.
  const r = POLE_BASE_RADIUS, R = r * widen;
  const error = sides >= 12 ? 0 : Math.max(R - r, r - R * Math.cos(Math.PI / sides));
  return { geometry, error };
}

/**
 * A round piece (a frustum `tall` high, `top` and `bottom` radii) with `sides` sides and the ends `ends` keeps, as `mastShape` makes the mast's
 * levels: under its own `full` sides as wide on average as the round one (a polygon's perimeter over pi), its error how far its outline strays
 * from the round one at its widest (outside at a corner, inside mid-face). A piece of a few pixels drawn with 10 or 14 sides spent triangles
 * on a roundness under a pixel (the F7 audit: caps 40, insulators 30, cans 56 triangles each at the district's view, 2026-10-25).
 */
function roundShape(top: number, bottom: number, tall: number, sides: number, full: number, ends: { readonly top: boolean; readonly bottom: boolean }): PartLevel {
  const widen = sides >= full ? 1 : Math.PI / (sides * Math.sin(Math.PI / sides));
  const geometry = cylinderWith(top * widen, bottom * widen, tall, sides, ends);
  const r = Math.max(top, bottom), R = r * widen;
  const error = sides >= full ? 0 : Math.max(R - r, r - R * Math.cos(Math.PI / sides));
  return { geometry, error };
}

/** Ground a pole stands on: the footway where there is one, the terrain where there is not. */
export function poleGroundAt(
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  /** The network, to stand a pole level with a footway laid flush (`footwayRiseAt`). */
  net?: Network,
): (x: number, y: number) => number {
  return (x, y) => {
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    // `half` is the CASING half-width, which runs a little past the footway.
    const onFootway = road.type >= 0 && Math.abs(road.across) <= road.half;
    if (!onFootway) return terrainAt(x, y);
    return elevation.at(x, y, GROUND_ONLY) + (net ? footwayRiseAt(net, x, y) : FOOTWAY_RISE);
  };
}

let woodCache: CanvasTexture | null = null;
/** The wood of a pole: dark brown, long grain, knots and drying cracks. Shared. */
function woodTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (woodCache) return woodCache;
  const W = 128, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4e3b2a';
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Grain: thin streaks of lighter and darker wood running up the pole.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, light = rnd() < 0.5;
    g.strokeStyle = light ? `rgba(120, 92, 64, ${0.15 + rnd() * 0.25})` : `rgba(30, 20, 12, ${0.15 + rnd() * 0.3})`;
    g.lineWidth = 0.5 + rnd() * 1.5;
    g.beginPath();
    let px = x;
    g.moveTo(px, 0);
    for (let y = 0; y <= H; y += 16) { px += (rnd() - 0.5) * 1.5; g.lineTo(px, y); }
    g.stroke();
  }
  // Knots and checks.
  for (let i = 0; i < 6; i++) {
    const x = rnd() * W, y = rnd() * H, r = 3 + rnd() * 5;
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 2);
    grad.addColorStop(0, 'rgba(25, 15, 8, 0.85)');
    grad.addColorStop(1, 'rgba(25, 15, 8, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(x, y, r, r * 2.2, 0, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 10; i++) {
    const x = rnd() * W, y = rnd() * H, len = 30 + rnd() * 90;
    g.strokeStyle = 'rgba(15, 10, 6, 0.7)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y + len); g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1, 2);
  woodCache = t;
  return t;
}

/** DO NOT make them lazily on the first build again: that is a material made in a frame. */
const PARTS: UtilityParts = makeUtilityParts();
