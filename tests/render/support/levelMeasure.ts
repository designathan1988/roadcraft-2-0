import type { BufferGeometry } from 'three';

import { geometrySoup, surfaceError } from '@/lab/optimization/surfaceError';

/** A soup without its triangles without area (they draw nothing; `vehicleHidden.ts` takes them out of every part drawn). */
function drawnSoup(soup: Float32Array): Float32Array {
  const out: number[] = [];
  for (let t = 0; t < soup.length; t += 9) {
    const u = [soup[t + 3]! - soup[t]!, soup[t + 4]! - soup[t + 1]!, soup[t + 5]! - soup[t + 2]!];
    const v = [soup[t + 6]! - soup[t]!, soup[t + 7]! - soup[t + 1]!, soup[t + 8]! - soup[t + 2]!];
    if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) === 0) continue;
    for (let k = 0; k < 9; k++) out.push(soup[t + k]!);
  }
  return new Float32Array(out);
}

/** A level against its part where it is first drawn (`limit`, its error, is half a pixel there), in pixels: the dense two-sided distance
 *  (`surfaceError`): the farthest point of the part from the level, and of the level from the part. */
export interface LevelPixels { readonly forward: number; readonly backward: number }

export function levelPixels(part: BufferGeometry, level: BufferGeometry, limit: number): LevelPixels {
  const pixels = 0.5 / limit;
  const base = drawnSoup(geometrySoup(part)), drawn = drawnSoup(geometrySoup(level));
  const e = surfaceError(base, drawn);
  // Nothing drawn against something drawn: as far as the part reaches.
  if (!e) return { forward: base.length && !drawn.length ? Infinity : 0, backward: drawn.length && !base.length ? Infinity : 0 };
  return { forward: e.forward.max * pixels, backward: e.backward.max * pixels };
}

/** Whether a level's measure is within its bound: half a pixel both ways. */
export const withinBounds = (m: LevelPixels): boolean => m.forward <= 0.5 && m.backward <= 0.5;
