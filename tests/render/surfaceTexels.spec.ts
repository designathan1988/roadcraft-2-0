import { describe, expect, it } from 'vitest';
import { CompressedArrayTexture, RGBAFormat, UnsignedByteType, type CompressedPixelFormat } from 'three';
import { disposeSurfaceTextures, primeSurfaceTextures, refillSurfaceTexels, surfaceTexture, whenTexelsRefilled } from '@render/surfaceTextures';

/** THE BAKED SURFACES' TEXELS (`surfaceTextures.ts`): let go once on the GPU, never sent while they are gone, read back and sent anew. */

const levels = (): { data: Uint8Array; width: number; height: number }[] =>
  [4, 2, 1].map((side) => ({ data: new Uint8Array(side * side * 2 * 4).fill(7), width: side, height: side }));
const array = (): CompressedArrayTexture =>
  new CompressedArrayTexture(levels(), 4, 4, 2, RGBAFormat as unknown as CompressedPixelFormat, UnsignedByteType);

describe('the baked surfaces\' texels', () => {
  it('are not sent while let go (three r186 Source.dataReady), and are sent again once read back', () => {
    const texture = array();
    const asked: string[][] = [];
    let redrawn = 0;
    primeSurfaceTextures(new Map([['road-details', texture]]), (names) => asked.push([...names]));
    whenTexelsRefilled(() => { redrawn++; });
    // Uploaded: three calls `onUpdate` after the send; the texels go, the source no longer ready.
    texture.onUpdate!(texture);
    expect(texture.mipmaps.every((level) => level.data === null)).toBe(true);
    expect(texture.source.dataReady).toBe(false);
    // Wanted at a finer anisotropy while gone: read again, not sent with none.
    const version = texture.version;
    surfaceTexture('road-details', 16);
    expect(asked).toEqual([['road-details']]);
    expect(texture.version).toBe(version);
    // Read back: its own texels, ready, sent anew.
    refillSurfaceTexels(new Map([['road-details', array()]]));
    expect(texture.mipmaps.every((level) => level.data instanceof Uint8Array)).toBe(true);
    expect(texture.source.dataReady).toBe(true);
    expect(texture.version).toBe(version + 1);
    // The scene drawn again with them (it draws on demand), once; a read for nothing wanted asks no frame.
    expect(redrawn).toBe(1);
    refillSurfaceTexels(new Map([['road-details', array()]]));
    expect(redrawn).toBe(1);
    disposeSurfaceTextures();
  });
});
