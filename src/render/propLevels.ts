import { BufferAttribute, BufferGeometry, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { HYSTERESIS } from './cellInstances';
import { surfaceOff } from './mesh/surfaceOff';
import { weldGeometry } from './mesh/weld';
import { VEHICLE_ERROR_PIXELS } from './quality';

/**
 * A STREET PROP'S LADDER, THE OWNER'S TOOL'S (its pieces' levels, `Qd`: `s >= 48 ? L0 : s >= 16 ? L1 : s >= 1.5 ? impostor : none`, `s` the
 * piece's largest extent on the screen): drawn whole from `PROP_NEAR_PX` across, as its simplified model from `PROP_PICTURE_PX`, as its
 * octahedral picture from `PROP_LEAST_PX` (`plantImpostors.ts` propPictures; Ryan Brucks, "Octahedral Impostors", shaderbits.com, 2018),
 * not at all under it. The simplified model is meshoptimizer's (https://github.com/zeux/meshoptimizer#simplification): welded, its borders
 * locked, its error held under `ERROR_PIXELS` at the largest size it is ever drawn at - the swap is not seen.
 */

/** Device pixels across from which a prop is drawn whole (L0). */
export const PROP_NEAR_PX = 48;
/** Device pixels across from which a prop is drawn simplified (L1); under it, as its picture. */
export const PROP_PICTURE_PX = 16;
/** Device pixels across from which a prop's picture is drawn; under it, nothing. */
export const PROP_LEAST_PX = 1.5;

/** The size a prop's level is measured by, model units: its box's largest extent (the owner's tool's `size`). */
export function propMeasure(model: BufferGeometry): number {
  if (!model.boundingBox) model.computeBoundingBox();
  const b = model.boundingBox!;
  return Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
}
/** The most a simplified model may be off its model on the screen, pixels: what the vehicles' levels hold (`quality.ts`). */
export const ERROR_PIXELS = VEHICLE_ERROR_PIXELS;
/** A simplified model that keeps more than this share of its model's triangles is not worth its draw: the model is drawn down to the picture. */
const WORTH = 0.9;
/** The attributes the simplifier weighs, a float each (normal x, y, z, colour r, g, b): ~1 for unit attributes (meshoptimizer README, `simplifyWithAttributes`). */
const WEIGHTS = [1, 1, 1, 1, 1, 1];

/** The error a prop `across` model units across (its measure, `KindLevels.reach` doubled) may have: `ERROR_PIXELS` at the largest size it is drawn
 *  simplified at, the near bar grown by the band an instance keeps its level in (`cellInstances.ts` HYSTERESIS). */
export function propLevelError(across: number): number {
  return (ERROR_PIXELS * across) / (PROP_NEAR_PX * (1 + HYSTERESIS));
}

/** A prop's simplified model: the model itself until it is made, then the simplified one (`ready`), or never when it would shed too little. */
export interface PropMidLevel {
  readonly geometry: BufferGeometry;
  /** Made, and worth its draw. */
  ready(): boolean;
  /** Whether `make` has run. */
  made(): boolean;
  /** The simplified model made now (the simplifier loaded, `simplifierLoading`): a few to 25 ms a prop (the phone the most, 2026-10-24),
   *  one prop a frame (`streetFurnitureLayer.ts` PropLadder.step). DO NOT simplify and measure every prop in one go at the opening. */
  make(): void;
}

/** The index of `model` simplified within `error` (model units): welded by position, normal and colour, borders locked, isolated bits under the
 *  error pruned (meshoptimizer README: `LockBorder`, `ErrorAbsolute`, `Prune`); its welded attributes and the simplified index. */
function simplifiedProp(model: BufferGeometry, error: number): BufferGeometry {
  const copy = new BufferGeometry();
  for (const name of ['position', 'normal', 'color'] as const) {
    const attribute = model.getAttribute(name) as BufferAttribute | undefined;
    if (!attribute) throw new Error(`simplifiedProp: the model has no ${name}`);
    copy.setAttribute(name, attribute);
  }
  copy.setIndex(model.index);
  const welded = weldGeometry(copy, 1e-4);
  const position = welded.getAttribute('position') as BufferAttribute;
  const normal = welded.getAttribute('normal') as BufferAttribute;
  const colour = welded.getAttribute('color') as BufferAttribute;
  const attributes = new Float32Array(position.count * WEIGHTS.length);
  for (let v = 0; v < position.count; v++) {
    attributes.set([normal.getX(v), normal.getY(v), normal.getZ(v), colour.getX(v), colour.getY(v), colour.getZ(v)], v * WEIGHTS.length);
  }
  const [index] = MeshoptSimplifier.simplifyWithAttributes(
    new Uint32Array(welded.getIndex()!.array as ArrayLike<number>), new Float32Array(position.array as ArrayLike<number>), 3,
    attributes, WEIGHTS.length, WEIGHTS, null, 3, error, ['LockBorder', 'ErrorAbsolute', 'Prune'],
  );
  const out = new BufferGeometry();
  out.setAttribute('position', position);
  out.setAttribute('normal', normal);
  out.setAttribute('color', colour);
  out.setIndex(position.count - 1 >= 65535 ? new Uint32BufferAttribute(index, 1) : new Uint16BufferAttribute(index, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

const trianglesOf = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** The levels' measure, from its own module (`mesh/surfaceOff.ts`): its users here keep reading it from this one. */
export { surfaceOff };

/** Tries at a smaller error when the simplified model strays past its bound (the simplifier's error is an estimate, meshoptimizer README). */
const TIGHTEN = 4;

/** `model` simplified within `bound` as measured (`surfaceOff` both ways), the simplifier's error tightened until it is; null: none within it. */
export function propWithin(model: BufferGeometry, bound: number): BufferGeometry | null {
  let error = bound;
  for (let attempt = 0; attempt < TIGHTEN; attempt++) {
    const simplified = simplifiedProp(model, error);
    const off = Math.max(surfaceOff(model, simplified), surfaceOff(simplified, model));
    if (off <= bound) return simplified;
    error *= (bound / off) * 0.9;
  }
  return null;
}

/** Whether meshoptimizer's simplifier is loaded (its WebAssembly is made asynchronously): `loaded` once it is; a failure to load said once. */
export function simplifierLoading(): { loaded(): boolean } {
  let loaded = false;
  MeshoptSimplifier.ready.then(() => { loaded = true; }, (error: unknown) => {
    // Said, not swallowed: the props are then drawn whole down to their pictures, never a worse shape.
    console.error('[props] meshoptimizer did not load; props are drawn whole down to their pictures', error);
  });
  return { loaded: () => loaded };
}

/** A prop's mid level: a geometry drawn by the mid meshes (`cellInstances.ts` KindMesh.mid), the model's own attributes and index until the
 *  simplified ones are put in it (`make`). Its sphere is the model's (the simplified model keeps a subset of its vertices: it stands inside it). */
export function propMidLevel(model: BufferGeometry, across: number): PropMidLevel {
  if (!model.boundingSphere) model.computeBoundingSphere();
  if (!model.boundingBox) model.computeBoundingBox();
  const level = new BufferGeometry();
  level.name = `${model.name}-mid`;
  for (const name of Object.keys(model.attributes)) level.setAttribute(name, model.attributes[name]!);
  level.setIndex(model.index);
  level.boundingSphere = model.boundingSphere!.clone();
  level.boundingBox = model.boundingBox!.clone();
  let worth = false, done = false;
  return {
    geometry: level,
    ready: () => worth,
    made: () => done,
    make() {
      if (done) return;
      done = true;
      const simplified = propWithin(model, propLevelError(across));
      if (!simplified || trianglesOf(simplified) > trianglesOf(model) * WORTH) return;
      for (const name of Object.keys(level.attributes)) level.deleteAttribute(name);
      for (const name of Object.keys(simplified.attributes)) level.setAttribute(name, simplified.attributes[name]!);
      level.setIndex(simplified.index);
      worth = true;
    },
  };
}
