import { describe, expect, it } from 'vitest';
import type { BufferAttribute } from 'three';
import { LandLod } from '@render/terrainLod';
import type { LandLevels } from '@render/terrainLevels';
import { LOD_PATCH } from '@render/terrainLevels';

/** THE GROUND'S PATCH AND RIM MODELS IN A FORMAT D3D11 TAKES AS IT IS (MISSION 1e): ANGLE copies a three-component byte or short attribute to four
 *  components on the CPU (`formatutils11.cpp`: R8G8B8_USCALED VERTEX_CONVERT_BOTH), so no attribute of theirs is a three-wide integer one. */

const SMALL = [Int8Array, Uint8Array, Int16Array, Uint16Array];

describe('terrain patch vertex formats', () => {
  it('lays every corner of the patch and its rim in four bytes, the three the shader reads unchanged', () => {
    const seg = LOD_PATCH * 4;
    const lod = new LandLod({} as LandLevels, { seg, cell: 1, half: seg / 2 }, { x: 0, y: 0 }, { west: true, east: true, north: true, south: true });
    for (const geometry of [lod.geometry, lod.rimGeometry]) {
      for (const [name, attribute] of Object.entries(geometry.attributes) as [string, BufferAttribute][]) {
        if (SMALL.some((Kind) => attribute.array instanceof Kind)) expect(attribute.itemSize, name).not.toBe(3);
      }
    }
    const cells = lod.geometry.getAttribute('position') as BufferAttribute;
    expect(cells.itemSize).toBe(4);
    expect(cells.count).toBe(LOD_PATCH * LOD_PATCH * 4);
    // The corners as before: cell x, cell y, role; the fourth byte 0.
    expect([cells.getX(5), cells.getY(5), cells.getZ(5), cells.getW(5)]).toEqual([1, 0, 1, 0]);
    const rim = lod.rimGeometry.getAttribute('position') as BufferAttribute;
    expect(rim.itemSize).toBe(4);
    expect(rim.count).toBe((LOD_PATCH + 1) * 2);
    expect([rim.getX(3), rim.getY(3), rim.getZ(3), rim.getW(3)]).toEqual([1, 0, 7, 0]);
    lod.dispose();
  });
});
