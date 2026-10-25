import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { VEHICLE_ERROR_PIXELS } from './quality';
import { lodPool } from './people/lodPool';
import { LEVEL_ERRORS, partLevelArrays, type ArrayOf, type PartArrays, type PartLevels, type Weld } from './partLevelsWork';

/** An attribute from the numbers sent back. */
const attributeOf = (a: ArrayOf): BufferAttribute => new BufferAttribute(a.array, a.itemSize, a.normalized);

export { LEVEL_ERRORS, type Weld } from './partLevelsWork';
/** A level is drawn only while its error on the screen is under this: the swap is not seen (meshoptimizer README, `ErrorAbsolute`). */
export const ERROR_PIXELS = VEHICLE_ERROR_PIXELS;
/** Levels of a part: 0 is the model's own geometry, `i + 1` the one within `LEVEL_ERRORS[i]`. */
export const LEVELS = LEVEL_ERRORS.length + 1;
/** A coarser level is a draw of its own only where it sheds at least this many triangles a vehicle: each level is a draw for every body
 *  style (glass, trim and cabin at a street's distances), and a few triangles a car never paid for one. A car's glazing went 1008, 42, 24,
 *  14, 8, 2: five draws for 40 triangles (2026-10-20). The finer level is drawn instead, never a worse shape. */
export const SHED = 64;

const trianglesOf = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** The coarsest level whose error stays under `ERROR_PIXELS` for a part drawn at `pixelsPerUnit` (pixels a unit of its own geometry). */
export function levelFor(pixelsPerUnit: number): number {
  let level = 0;
  while (level < LEVEL_ERRORS.length && LEVEL_ERRORS[level]! * pixelsPerUnit <= ERROR_PIXELS) level++;
  return level;
}

/** A key for what a part's levels are made of, number by number: its positions, colours and index, what it is, what it is seen past. */
function keyOf(part: PartArrays, weld: Weld): string {
  // FNV-1a over the numbers' bits, two ways (32 bits each: a collision of both is not met among a few hundred parts).
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const mix = (a: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }): void => {
    const words = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
    for (let i = 0; i < words.length; i++) { h1 = Math.imul(h1 ^ words[i]!, 0x01000193); h2 = Math.imul(h2 ^ words[i]!, 0x9e3779b1) ^ (h2 >>> 15); }
    h1 = Math.imul(h1 ^ a.byteLength, 0x01000193);
  };
  for (const a of [part.position.array, part.color?.array, part.normal?.array, part.index, part.occluders]) if (a) mix(a as Float32Array);
  return `${weld}:${part.position.array.length}:${part.index?.length ?? 0}:${part.occluders?.length ?? 0}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/** A copy of an attribute's numbers, to be moved to the worker (the part keeps its own). */
const copyOf = (geometry: BufferGeometry, name: string): ArrayOf | null => {
  const a = geometry.getAttribute(name) as BufferAttribute | undefined;
  return a ? { array: a.array.slice(), itemSize: a.itemSize, normalized: a.normalized } : null;
};

/** THE VEHICLES' PARTS' LEVELS, each made once for whoever owns this (`agents.ts`'s vehicle meshes; a sheet's run, `vehicleLevelItems.ts`): by
 *  what they were made from (`keyOf`), so the same part made again (another body style) takes the levels already made. */
export class PartLevelMaker {
  private readonly made = new Map<string, Promise<PartLevels>>();

  /** The levels of `source` (0 is `source` itself): welded, simplified and measured in the levels' worker (`partLevelsWork.ts`), the page
   *  only putting the geometries together. `copies`: how many a vehicle draws (a car's four tyres), for what a level sheds a vehicle (`SHED`).
   *  `occluders`: the vehicle's opaque triangles in its frame (`vehicleSeen.ts` soupOf), for a part that casts no shadow: its levels are of
   *  what is seen of it. */
  async levels(source: BufferGeometry, weld: Weld, copies = 1, occluders: Float64Array | null = null): Promise<BufferGeometry[]> {
    try {
      await MeshoptSimplifier.ready;
    } catch (error) {
      // Said, not swallowed: the part is then drawn whole at every size.
      console.error('[vehicles] meshoptimizer did not load; parts are drawn unsimplified', error);
      return [source];
    }
    const index = source.getIndex();
    const part: PartArrays = {
      position: copyOf(source, 'position')!, color: copyOf(source, 'color'), normal: copyOf(source, 'normal'),
      index: index ? (index.array as Uint32Array | Uint16Array).slice() : null, occluders,
    };
    // The same part, made again, takes the levels already made.
    const key = keyOf(part, weld);
    let making = this.made.get(key);
    if (!making) {
      const pool = lodPool();
      making = pool ? pool.part(part, weld) : Promise.resolve(partLevelArrays(part, weld));
      this.made.set(key, making);
    }
    const levelsMade: PartLevels = await making;
    const levels: BufferGeometry[] = [source];
    for (const l of levelsMade.levels) {
      if (l === 'same') { levels.push(levels[levels.length - 1]!); continue; }
      const level = new BufferGeometry();
      level.setAttribute('position', attributeOf(l.position));
      level.setAttribute('color', attributeOf(l.color));
      level.setAttribute('normal', attributeOf(l.normal));
      level.setIndex(new BufferAttribute(l.index, 1));
      level.boundingSphere = new Sphere(new Vector3(l.sphere[0], l.sphere[1], l.sphere[2]), l.sphere[3]);
      levels.push(level);
    }
    // A level that sheds too little a vehicle is the finer one again: one draw fewer for every body style.
    let finer = trianglesOf(source);
    for (let k = 1; k < levels.length; k++) {
      const level = levels[k]!, before = levels[k - 1]!;
      if (level === before) continue;
      if ((finer - trianglesOf(level)) * copies < SHED) { levels[k] = before; continue; }
      finer = trianglesOf(level);
    }
    return levels;
  }
}
