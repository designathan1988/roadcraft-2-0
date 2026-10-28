import { BufferGeometry, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { SurfaceGrid, keysOf, withinError } from './levelError';
import { weldGeometry } from './mesh/weld';
import { WATER_DEPTH_ATTRIBUTE, WATER_FLOW_ATTRIBUTE } from './water';
import { m } from '@world/units';

/**
 * A PLATE'S WATER BY ITS SIZE ON THE SCREEN (MISSION.md 3b): the water's own mesh welded (the same triangles over shared corners) and
 * simplified by meshoptimizer into coarser levels of itself, the way the water runs and its depth weighed with its place
 * (`simplifyWithAttributes`). A level is kept only where the Hausdorff test of the levels proves it within its error both ways
 * (`levelError.ts`: meshoptimizer's error is its own estimate), the shore with it, and drawn where that error spans under a pixel
 * (`waterLevelFor`). DO NOT lock the shore (`LockBorder`): its contour of a vertex a metre was every level's floor (a lake of 40 m stopped at
 * 392 triangles at every error), where the shore within the error is all a pixel shows. DO NOT draw a plate's water whole at every distance:
 * a lake of 40 m was 4,624 triangles a few pixels across far off (the model audit).
 */

/** The errors the coarser levels are asked at, world units: from half a metre (a street's view) to the whole map's. */
const WATER_ERRORS = [m(0.5), m(1), m(2), m(4), m(8), m(16)];
/** A level is kept only where it draws a quarter fewer triangles than the one before it. */
const FEWER = 0.75;
/** The flow's two components and the depth weighed with the place (meshoptimizer: about 1 for a unit attribute; the depth, in world units, less). */
const WEIGHTS = [1, 1, 0.25];

export interface WaterLevels {
  /** The finest first (the mesh as made, welded), then each coarser over the same corners, its own index alone. */
  readonly geometries: readonly BufferGeometry[];
  /** Each one's error, world units: how far it may stand off the finest, proved. */
  readonly errors: readonly number[];
}

/** The water's levels from its mesh as made (non-indexed, `terrain.ts` unifiedWaterGeometry); the simplifier loaded (`MeshoptSimplifier.ready`). */
export function waterLevels(source: BufferGeometry): WaterLevels {
  const welded = weldGeometry(source);
  welded.computeBoundingBox();
  welded.computeBoundingSphere();
  const position = welded.getAttribute('position'), index = welded.getIndex();
  const flow = welded.getAttribute(WATER_FLOW_ATTRIBUTE), depth = welded.getAttribute(WATER_DEPTH_ATTRIBUTE);
  if (!index || position.count === 0 || !flow || !depth) return { geometries: [welded], errors: [0] };
  const positions = Float32Array.from(position.array as ArrayLike<number>);
  const attributes = new Float32Array(position.count * WEIGHTS.length);
  for (let v = 0; v < position.count; v++) {
    attributes[v * 3] = flow.getX(v);
    attributes[v * 3 + 1] = flow.getY(v);
    attributes[v * 3 + 2] = depth.getX(v);
  }
  const whole = Uint32Array.from(index.array as ArrayLike<number>);
  const grid = new SurfaceGrid(positions, whole, WATER_ERRORS[0]! * 2);
  const keys = keysOf(whole);
  const geometries: BufferGeometry[] = [welded], errors: number[] = [0];
  let was = whole.length / 3;
  for (const error of WATER_ERRORS) {
    const [kept] = MeshoptSimplifier.simplifyWithAttributes(whole, positions, 3, attributes, WEIGHTS.length, WEIGHTS, null, 3, error, ['ErrorAbsolute']);
    if (kept.length === 0 || kept.length / 3 > was * FEWER) continue;
    if (!withinError(positions, whole, grid, kept, error, keys)) continue;
    const level = new BufferGeometry();
    for (const name of Object.keys(welded.attributes)) level.setAttribute(name, welded.getAttribute(name));
    level.setIndex(position.count > 0xffff ? new Uint32BufferAttribute(kept, 1) : new Uint16BufferAttribute(kept, 1));
    level.boundingBox = welded.boundingBox!.clone();
    level.boundingSphere = welded.boundingSphere!.clone();
    geometries.push(level);
    errors.push(error);
    was = kept.length / 3;
  }
  return { geometries, errors };
}

/** The coarsest level whose error spans at most a pixel where a pixel spans `metresPerPixel` world units. */
export function waterLevelFor(levels: WaterLevels, metresPerPixel: number): number {
  let level = 0;
  for (let k = 1; k < levels.errors.length; k++) if (levels.errors[k]! <= metresPerPixel) level = k;
  return level;
}
