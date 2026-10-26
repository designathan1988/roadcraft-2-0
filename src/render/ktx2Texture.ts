import {
  CompressedArrayTexture, CompressedTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, SRGBColorSpace,
  UnsignedByteType, type CompressedPixelFormat, type WebGLRenderer,
} from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { KHR_SUPERCOMPRESSION_ZSTD, read, type KTX2Container } from 'three/examples/jsm/libs/ktx-parse.module.js';
import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js';

/** KTX2 FILES AS THE GAME READS THEM (`scripts/vite/ktx2.ts` writes them): the baked surfaces, the people's atlases. RGBA8 levels as they are, UASTC transcoded by three's loader to what the GPU takes. */

export type Ktx2Codec = 'rgba8' | 'uastc';
type Ktx2Use = 'color' | 'normal' | 'data';

/** Basis Universal's transcoder from three's addons, served by the surface-bake plugin at a fixed path (Vite's prebundled three cannot find it beside the loader). */
const TRANSCODER = `${import.meta.env.BASE_URL}basis/`;

/** Each level's texels of an uncompressed file (`rgba8`), Zstandard undone. */
async function rawLevels(container: KTX2Container, zstd: () => Promise<ZSTDDecoder>): Promise<Uint8Array[]> {
  if (container.supercompressionScheme !== KHR_SUPERCOMPRESSION_ZSTD) return container.levels.map((level) => level.levelData);
  const decoder = await zstd();
  return container.levels.map((level) => decoder.decode(level.levelData, level.uncompressedByteLength));
}

/** An RGBA8 file as a texture of its own mip levels: three uploads an RGBA "compressed" texture level by level (WebGLTextures, `texSubImage2D`/`3D`), which a DataArrayTexture cannot. */
async function rgbaTexture(buffer: ArrayBuffer, zstd: () => Promise<ZSTDDecoder>): Promise<CompressedTexture> {
  const container = read(new Uint8Array(buffer));
  const levels = await rawLevels(container, zstd);
  const width = container.pixelWidth, height = container.pixelHeight;
  const mipmaps = levels.map((data, i) => ({ data, width: Math.max(1, width >> i), height: Math.max(1, height >> i) }));
  const format = RGBAFormat as unknown as CompressedPixelFormat;
  return container.layerCount > 1
    ? new CompressedArrayTexture(mipmaps, width, height, container.layerCount, format, UnsignedByteType)
    : new CompressedTexture(mipmaps, width, height, format, UnsignedByteType);
}

/** What the GPU can take a UASTC file as (BC7, ASTC, ETC2...), asked of a throwaway WebGL2 context: the game's renderer may not exist yet. */
function transcodeTargets(loader: KTX2Loader): KTX2Loader {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { powerPreference: 'high-performance' });
  const names = new Set(gl?.getSupportedExtensions() ?? []);
  // `detectSupport` reads only `extensions.has` and, for ASTC, `extensions.get(...).getSupportedProfiles()` (three r186)
  const extensions = { has: (name: string): boolean => names.has(name), get: (name: string): unknown => gl?.getExtension(name) ?? null };
  loader.detectSupport({ extensions } as unknown as WebGLRenderer);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return loader;
}

/** The readers a batch shares: a UASTC loader (its transcoding workers), a Zstandard decoder; made on the first file that needs them. */
export interface Ktx2Reader {
  read(buffer: ArrayBuffer, codec: Ktx2Codec, use: Ktx2Use): Promise<CompressedTexture>;
  /** The workers let go. */
  dispose(): void;
}

export function createKtx2Reader(): Ktx2Reader {
  let loader: KTX2Loader | null = null;
  let decoder: Promise<ZSTDDecoder> | null = null;
  const zstd = (): Promise<ZSTDDecoder> => (decoder ??= (async () => {
    const made = new ZSTDDecoder();
    await made.init();
    return made;
  })());
  return {
    async read(buffer, codec, use) {
      let texture: CompressedTexture;
      if (codec === 'uastc') {
        loader ??= transcodeTargets(new KTX2Loader().setTranscoderPath(TRANSCODER));
        const made = loader;
        texture = await new Promise<CompressedTexture>((resolve, reject) => made.parse(buffer, resolve, reject));
      } else {
        texture = await rgbaTexture(buffer, zstd);
      }
      texture.colorSpace = use === 'color' ? SRGBColorSpace : NoColorSpace;
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    },
    dispose() {
      loader?.dispose();
      loader = null;
      decoder = null;
    },
  };
}
