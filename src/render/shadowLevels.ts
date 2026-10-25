import { BufferAttribute, BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { surfaceOff } from './mesh/surfaceOff';

/**
 * A CASTER'S SHAPES FOR THE SUN'S CASCADES: its model, then lighter ones, each drawn into a cascade whose texel is wider than the farthest it
 * strays from the model (`cellInstances.ts`, as `poleLayer.ts` draws its parts by texel). A shadow is a depth compared texel by texel and
 * spread by the filter: a shape off by under a texel throws the same shadow. DO NOT let the near cascade draw every plant and prop under its
 * cover at its full model: a frame that redrew the cascades held 4.24 M triangles of gardens, against 68-105 k in the colour pass (the F7
 * audit, M6, 2026-10-25).
 * Each lighter shape is the model's positions welded and simplified by meshoptimizer at an absolute error (its README, "Simplification":
 * `ErrorAbsolute`, `Prune`), measured both ways against the model (`surfaceOff`) and kept only within the error it was asked at: that
 * measure is its error. Its normals are made again from its own faces; the depth pass reads its positions alone.
 */

/** A shape a caster may be drawn with in a cascade, and how far (model units) its surface strays from the model's, at most. */
export interface ShadowShape {
  readonly geometry: BufferGeometry;
  readonly error: number;
}

/** A model's shapes for the cascades, finest first: the model itself (error 0), then the lighter ones as they are made (off the frame's path). */
export interface ShadowLadder {
  readonly shapes: readonly ShadowShape[];
  /** Settles once the lighter shapes are in `shapes`, or once making them failed (logged). */
  readonly ready: Promise<void>;
}

/** Whether the cascades draw the lighter shapes (the lab's "Optimisations", `optimizations.ts` shadowShapes: the game as it draws, on); off,
 *  every caster's model in every cascade, the shadow as it was before them. */
export const shadowShapes = { byTexel: true };

/** The errors the lighter shapes are asked at, as shares of the model's radius; one is kept only if it draws a quarter fewer triangles. */
const SHADOW_ERRORS = [0.02, 0.05, 0.1, 0.2];
const FEWER = 0.75;
/** Tries at a smaller error while a shape strays farther than the error it was asked at (meshoptimizer's error is its own estimate). */
const TIGHTEN = 4;
/** A model with fewer triangles than this keeps its one shape: nothing worth a lighter one. */
const LEAST_TRIANGLES = 24;

const trianglesOf = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** Where a model keeps its ladder: one a model, whoever draws it (a garden's tree and a street's are the same model). */
const LADDER = 'shadowLadder';

/** The model's shapes for the cascades: itself at once, its lighter shapes once made. Held by the model, and let go with it: its lighter
 *  shapes disposed when it is (three's `dispose` event), and one landing after that disposed as it lands. */
export function shadowLadderOf(model: BufferGeometry): ShadowLadder {
  const held = model.userData[LADDER] as ShadowLadder | undefined;
  if (held) return held;
  const shapes: ShadowShape[] = [{ geometry: model, error: 0 }];
  let gone = false;
  model.addEventListener('dispose', () => {
    gone = true;
    for (const shape of shapes.splice(1)) shape.geometry.dispose();
  });
  const ready = trianglesOf(model) < LEAST_TRIANGLES ? Promise.resolve() : lighterShapes(model).then(
    (lighter) => { if (gone) for (const shape of lighter) shape.geometry.dispose(); else shapes.push(...lighter); },
    (error: unknown) => { console.error('Shadow shapes failed', model.name, error); },
  );
  const ladder: ShadowLadder = { shapes, ready };
  model.userData[LADDER] = ladder;
  return ladder;
}

/** The lighter shapes of a model, coarser and coarser, each within the error it was asked at. */
async function lighterShapes(model: BufferGeometry): Promise<ShadowShape[]> {
  await MeshoptSimplifier.ready;
  // Its positions alone, welded where they meet (a faceted model's corners are one corner each face).
  const plain = new BufferGeometry();
  plain.setAttribute('position', model.getAttribute('position').clone());
  if (model.index) plain.setIndex(model.index.clone());
  const welded = mergeVertices(plain, 1e-4);
  plain.dispose();
  if (!welded.index) { welded.dispose(); return []; }
  const positions = Float32Array.from(welded.getAttribute('position').array as ArrayLike<number>);
  const indices = Uint32Array.from(welded.index.array as ArrayLike<number>);
  welded.computeBoundingSphere();
  const radius = welded.boundingSphere!.radius;
  const out: ShadowShape[] = [];
  let was = trianglesOf(model);
  for (const share of SHADOW_ERRORS) {
    const error = share * radius;
    let shape: BufferGeometry | null = null, measured = 0;
    for (let attempt = 0, target = error; attempt < TIGHTEN && !shape; attempt++) {
      const [kept] = MeshoptSimplifier.simplify(indices, positions, 3, 3, target, ['ErrorAbsolute', 'Prune']);
      if (kept.length === 0 || kept.length / 3 > was * FEWER) break;
      const g = compacted(positions, kept);
      const off = Math.max(surfaceOff(welded, g), surfaceOff(g, welded));
      if (off <= error) { shape = g; measured = off; } else { g.dispose(); target *= (error / off) * 0.9; }
    }
    if (!shape) continue;
    shape.name = `${model.name}-shadow`;
    shape.computeVertexNormals();
    shape.boundingSphere = model.boundingSphere;
    shape.boundingBox = model.boundingBox;
    out.push({ geometry: shape, error: measured });
    was = trianglesOf(shape);
  }
  welded.dispose();
  return out;
}

/** `kept` (an index over `positions`) as a geometry of its own: the corners it uses alone, renumbered in its order. */
function compacted(positions: Float32Array, kept: Uint32Array): BufferGeometry {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  let used = 0;
  for (const v of kept) if (remap[v] === -1) remap[v] = used++;
  const array = new Float32Array(used * 3);
  for (let v = 0; v < remap.length; v++) {
    const to = remap[v]!;
    if (to >= 0) { array[to * 3] = positions[v * 3]!; array[to * 3 + 1] = positions[v * 3 + 1]!; array[to * 3 + 2] = positions[v * 3 + 2]!; }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(array, 3));
  g.setIndex(new BufferAttribute(used > 65535 ? Uint32Array.from(kept, (v) => remap[v]!) : Uint16Array.from(kept, (v) => remap[v]!), 1));
  return g;
}
