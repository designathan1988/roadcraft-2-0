import { describe, expect, it, vi } from 'vitest';
import { CompressedTexture, type DataArrayTexture } from 'three';

// The baked surfaces stand in for the cooked ones (`surfaceTextures.ts`): what is tested is the paint array's own texels.
vi.mock('@render/surfaceTextures', async (load) => {
  const real = await load<typeof import('@render/surfaceTextures')>();
  const texture = (): CompressedTexture => {
    const t = new CompressedTexture([{ data: new Uint8Array(4).fill(128), width: 1, height: 1 }], 1, 1);
    return t;
  };
  return { ...real, surfaceTexture: () => texture(), surfaceMaps: () => undefined };
});

import { TERRAIN_HALF, createTerrainSurface } from '@render/terrain';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** THE PAINTED GROUND'S ARRAY GROWN WHILE ITS SMALLER ONE WAITS TO BE SENT (`terrain.ts` growPaint): each array's texels at its own side, the smaller one out of the uploads' queue */

/** The array's sides (`terrain.ts` PAINT_START_RES, PAINT_RES): 4 m and 2 m a texel over the plate of 2,000 m. */
const START = 500, FULL = 1000;

describe('the painted ground grown', () => {
  it('fills an array still to be sent at its own side, not at the side the plate grew to', () => {
    const surface = createTerrainSurface(1, { x: 0, y: 0 }, 0);
    const small = surface.textures()[1] as DataArrayTexture;
    expect(small.image.width).toBe(START);
    // A world opened with its ground already painted: the array grows to its full side at the load, before the first send.
    const doc = new RoadDoc();
    doc.addPaintDab({ kind: 'sand', x: m(10), y: m(-20), radius: m(30), strength: 1 } as never);
    surface.updatePaint(doc as never, false);
    const grown = surface.textures()[1] as DataArrayTexture;
    expect(grown.image.width).toBe(FULL);
    // The smaller array's texels read as three reads them at its send (`stagedTexels.ts`): before, filled at the full side's rows past its end (RangeError).
    expect(() => (small.image as { data: Uint8Array }).data).not.toThrow();
    expect(() => (grown.image as { data: Uint8Array }).data).not.toThrow();
    expect((grown.image as { data: Uint8Array }).data.length).toBe(FULL * FULL * 4 * 3);
    surface.dispose();
  });

  it('holds a painted plate far from the view at the start side, full only near it (`paintDetail`)', () => {
    const surface = createTerrainSurface(1, { x: 0, y: 0 }, 0);
    surface.paintDetail!(false);
    const doc = new RoadDoc();
    doc.addPaintDab({ kind: 'sand', x: m(10), y: m(-20), radius: m(30), strength: 1 } as never);
    surface.updatePaint(doc as never, false);
    const far = surface.textures()[1] as DataArrayTexture;
    expect(far.image.width).toBe(START);
    // The dab laid at the far array's own side: sand under its centre (layer 0, channel 0: the first kind).
    const texels = (far.image as { data: Uint8Array }).data;
    expect(texels.length).toBe(START * START * 4 * 3);
    const cell = (2 * TERRAIN_HALF) / START;
    const x = Math.floor((m(10) + TERRAIN_HALF) / cell), y = Math.floor((m(-20) + TERRAIN_HALF) / cell);
    expect(texels[(y * START + x) * 4]).toBeGreaterThan(200);
    surface.paintDetail!(true);
    const near = surface.textures()[1] as DataArrayTexture;
    expect(near.image.width).toBe(FULL);
    surface.paintDetail!(false);
    expect((surface.textures()[1] as DataArrayTexture).image.width).toBe(START);
    surface.dispose();
  });
});
