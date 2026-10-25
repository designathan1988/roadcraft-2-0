import { RepeatWrapping, type CompressedTexture } from 'three';
import { forgetOtherDerived } from './derivedCache';
import { createKtx2Reader } from './ktx2Texture';
import { primeSurfaceTextures, refillSurfaceTexels } from './surfaceTextures';

/** The procedural surfaces, baked at build time into KTX2 files (`scripts/vite/surface-bake-plugin.ts`) and read here once, while the town is built: nothing is baked during play */

interface ManifestEntry {
  readonly name: string;
  readonly file: string;
  readonly use: 'color' | 'normal' | 'data';
}

interface Manifest {
  readonly hash: string;
  readonly codec: 'rgba8' | 'uastc';
  readonly textures: readonly ManifestEntry[];
}

interface SurfaceBakeResult {
  readonly manifest: Manifest;
  readonly textures: ReadonlyMap<string, CompressedTexture>;
}

declare const __SURFACE_BAKE_HASH__: string | undefined;
/** The fingerprint of the recipes' code (`surface-bake-plugin.ts`): a new bake is a new URL, never an old file from the cache */
const BAKE_HASH = typeof __SURFACE_BAKE_HASH__ !== 'undefined' ? __SURFACE_BAKE_HASH__ : 'none';
const FOLDER = `${import.meta.env.BASE_URL}cooked/surfaces/`;

/** Reads the named files (`ktx2Texture.ts`); the reader's transcoding workers are let go once they are done. */
async function readFiles(manifest: Manifest, entries: readonly ManifestEntry[]): Promise<Map<string, CompressedTexture>> {
  const reader = createKtx2Reader();
  try {
    const textures = await Promise.all(entries.map(async (entry) => {
      const response = await fetch(`${FOLDER}${entry.file}?v=${manifest.hash}`);
      if (!response.ok) throw new Error(`Baked surface ${entry.file}: HTTP ${response.status}`);
      const texture = await reader.read(await response.arrayBuffer(), manifest.codec, entry.use);
      // As the canvas bakes were: repeating
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.name = entry.name;
      texture.needsUpdate = true;
      return [entry.name, texture] as const;
    }));
    return new Map(textures);
  } finally {
    reader.dispose();
  }
}

/** Reads every baked surface while the main thread builds the town. */
export async function startSurfaceBake(): Promise<SurfaceBakeResult> {
  // The texels the old in-game bake kept in IndexedDB (some 70 MB a build) are no longer read: let go.
  forgetOtherDerived('surface', 'ktx2');
  const response = await fetch(`${FOLDER}manifest.json?v=${BAKE_HASH}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`No baked surfaces at ${FOLDER} (HTTP ${response.status}): the surface-bake plugin did not run`);
  const manifest = (await response.json()) as Manifest;
  if (manifest.hash !== BAKE_HASH && BAKE_HASH !== 'none') throw new Error(`The baked surfaces are ${manifest.hash}, this build's recipes ${BAKE_HASH}`);
  return { manifest, textures: await readFiles(manifest, manifest.textures) };
}

/** Install the textures before the first material is made; a texture whose texels were let go reads its file again when it must be uploaded anew. */
export function primeSurfaceBake(result: SurfaceBakeResult): void {
  primeSurfaceTextures(result.textures, (names) => {
    const entries = result.manifest.textures.filter((entry) => names.includes(entry.name));
    void readFiles(result.manifest, entries).then(refillSurfaceTexels, (error: unknown) => {
      console.error('Baked surfaces could not be read again', error);
    });
  });
}
