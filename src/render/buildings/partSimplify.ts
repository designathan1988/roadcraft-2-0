import { BufferAttribute, BufferGeometry } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { weldGeometry } from '../mesh/weld';
import { surfaceOff } from '../mesh/surfaceOff';

/** THE BUILDING PARTS' SIMPLER LEVELS (`kit.ts` SIMPLIFIED): a prop welded, simplified by meshoptimizer at each error and kept only where it
 *  is measured within it. */

/** A simpler level of a part (`kit.ts` PartLevel): its geometry, its triangles, and its two-sided distance from the finest (`measured`), that
 *  distance its error along every axis. */
export interface SimplerLevel {
  readonly geometry: BufferGeometry;
  readonly triangles: number;
  readonly error: readonly [number, number, number];
  readonly measured: number;
}

/** The errors a part's simpler levels are asked at, metres (meshoptimizer's absolute error); one is kept only if it draws a quarter fewer triangles. */
// And 15 cm: at the district's view a metre spans a few pixels, and the coarsest at 6 cm still drew a chair in ~95 triangles, a dish in ~150,
// the building parts 9.3 M triangles of the frame's 20 (`npm run diagnose`, 2026-10-22); a level is taken only where its error is under a pixel.
const SIMPLIFIED_ERRORS = [0.01, 0.025, 0.06, 0.15];
const FEWER = 0.75;

export const trianglesOf = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** Tries at a smaller error while a level strays farther than the error it was asked at (meshoptimizer's error is its own estimate). */
const TIGHTEN = 4;

/** The coarser levels of a prop: welded, then simplified at each error with its normals and tones weighed in (meshoptimizer README,
 *  `simplifyWithAttributes`), each measured against the finest both ways (`surfaceOff`, the distance the sheets measure a level by) and kept
 *  only within the error it was asked at, that distance its error. DO NOT take meshoptimizer's own error for it: a prune or a fold lay 5x past
 *  it (a balcony plant's leaves at 12 cm asked at 2.5 cm, 2026-10-24), and a plant collapsed to a triangle was drawn as its level. */
export async function simplerLevels(source: BufferGeometry, finest: number): Promise<SimplerLevel[]> {
  await MeshoptSimplifier.ready;
  const welded = weldGeometry(source.clone(), 1e-4);
  const index = welded.getIndex(), position = welded.getAttribute('position'), normal = welded.getAttribute('normal'), colour = welded.getAttribute('color');
  if (!index || !normal) return [];
  const count = position.count;
  const positions = new Float32Array(count * 3), attributes = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.getX(i); positions[i * 3 + 1] = position.getY(i); positions[i * 3 + 2] = position.getZ(i);
    attributes[i * 6] = normal.getX(i); attributes[i * 6 + 1] = normal.getY(i); attributes[i * 6 + 2] = normal.getZ(i);
    attributes[i * 6 + 3] = colour ? colour.getX(i) : 1; attributes[i * 6 + 4] = colour ? colour.getY(i) : 1; attributes[i * 6 + 5] = colour ? colour.getZ(i) : 1;
  }
  const indices = Uint32Array.from(index.array as ArrayLike<number>);
  const out: SimplerLevel[] = [];
  let was = finest;
  for (const error of SIMPLIFIED_ERRORS) {
    let level: BufferGeometry | null = null, measured = 0;
    for (let attempt = 0, target = error; attempt < TIGHTEN && !level; attempt++) {
      // Pruned: a piece smaller than the error (a spoke) goes whole, and is measured gone.
      const [kept] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, 6, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], null, 3, target, ['ErrorAbsolute', 'Prune']);
      if (kept.length === 0 || kept.length / 3 > was * FEWER) break;
      const g = compacted(welded, kept);
      const off = Math.max(surfaceOff(welded, g), surfaceOff(g, welded));
      if (off <= error) { level = g; measured = off; } else { g.dispose(); target *= (error / off) * 0.9; }
    }
    if (!level) continue;
    level.computeBoundingBox();
    level.computeBoundingSphere();
    out.push({ geometry: level, triangles: trianglesOf(level), error: [measured, measured, measured], measured });
    was = trianglesOf(level);
  }
  welded.dispose();
  return out;
}

/** `kept` (an index over `welded`) as a geometry of its own: the corners it uses alone, renumbered in its order. DO NOT clone the welded
 *  buffers for each level: every level held every corner of the finest (a balcony plant's 14,832 bytes became 57,516). */
function compacted(welded: BufferGeometry, kept: Uint32Array): BufferGeometry {
  const remap = new Int32Array(welded.getAttribute('position').count).fill(-1);
  let used = 0;
  for (const v of kept) if (remap[v] === -1) remap[v] = used++;
  const g = new BufferGeometry();
  for (const [name, attribute] of Object.entries(welded.attributes)) {
    const size = attribute.itemSize, array = new Float32Array(used * size);
    for (let v = 0; v < remap.length; v++) if (remap[v]! >= 0) for (let q = 0; q < size; q++) array[remap[v]! * size + q] = attribute.getComponent(v, q);
    g.setAttribute(name, new BufferAttribute(array, size, attribute.normalized));
  }
  g.setIndex(new BufferAttribute(used > 65535 ? Uint32Array.from(kept, (v) => remap[v]!) : Uint16Array.from(kept, (v) => remap[v]!), 1));
  return g;
}
