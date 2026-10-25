import { FINISHES } from '@world/buildings/materials';
import { surfaceTexels } from '../mesh/textureBaker';
import { detailTexels } from './detailRecipes';
import { FINISH_LAYER_SIZE, LOOKS, finishTiles } from './finishRecipes';
import { ROAD_COLOUR_LAYERS, ROAD_DETAIL_LAYERS, ROAD_LAYER_SIZE, ROAD_RELIEF_LAYERS, roadRecipes } from './roadRecipes';
import { terrainRecipes } from './terrainRecipes';

/** Every texture the game bakes, run at build time by `scripts/vite/surface-bake-plugin.ts` (never during play) and loaded by `surfaceBakeClient.ts` */

/** How the texels are read (`scripts/vite/ktx2.ts` `TextureUse`). */
type TextureUse = 'color' | 'normal' | 'data';

interface BakedTexture {
  /** Its name in the game (`surfaceTextures.ts`): `<surface>:map`, `:normal`, `:rough`, or an array's own (`road-surfaces:map`, `road-details`). */
  readonly name: string;
  readonly use: TextureUse;
  readonly size: number;
  /** RGBA texels, rows top first as a canvas holds them: one per layer, more than one for a texture array. */
  readonly layers: readonly Uint8Array[];
  /** Alpha-tested (0..1): its mipmaps keep the share of texels that pass (`ktx2.ts` `mipChain`). */
  readonly alphaRef?: number;
  /** Each layer's own use for its mipmaps where an array holds several (a normal map's layers beside a roughness map's): the file's `use` else. */
  readonly layerUses?: readonly TextureUse[];
}

/** A square of texels repeated `tiles` times each way: its mip chain is its own chain repeated, level by level (a 2 x 2 box never straddles two copies). */
export function tiledTexels(texels: Uint8Array, size: number, tiles: number): Uint8Array {
  if (tiles === 1) return texels;
  const row = size * 4;
  const out = new Uint8Array(texels.length * tiles * tiles);
  for (let y = 0; y < size * tiles; y++) {
    const source = texels.subarray((y % size) * row, ((y % size) + 1) * row);
    for (let t = 0; t < tiles; t++) out.set(source, (y * tiles + t) * row);
  }
  return out;
}

/** The finishes as one texture array per map, a layer per finish in `FINISHES` order (`buildings/finishes.ts`): a cell's shells in one draw. */
function* finishArrays(): Generator<BakedTexture> {
  const layers = FINISHES.map((finish) => {
    const look = LOOKS[finish];
    const texels = surfaceTexels({
      size: look.size, worldSize: look.worldSize, relief: look.relief, shade: look.shade(look.size), ...(look.metallic ? { metallic: true } : {}),
    });
    // A smaller finish repeated in its layer: the same texels a metre, its uv scaled by as much (`finishes.ts` `finishLookTable`).
    const tiles = finishTiles(finish);
    return { map: tiledTexels(texels.map, look.size, tiles), normal: tiledTexels(texels.normal, look.size, tiles), rough: tiledTexels(texels.rough, look.size, tiles) };
  });
  yield { name: 'building-finishes:map', use: 'color', size: FINISH_LAYER_SIZE, layers: layers.map((l) => l.map) };
  yield { name: 'building-finishes:normal', use: 'normal', size: FINISH_LAYER_SIZE, layers: layers.map((l) => l.normal) };
  yield { name: 'building-finishes:rough', use: 'data', size: FINISH_LAYER_SIZE, layers: layers.map((l) => l.rough) };
}

/**
 * The street surfaces as one material reads them (`bake/roadRecipes.ts` ROAD_COLOUR_LAYERS, `mesh/roadEdges.ts` applyRoadSurface): their colours in
 * one array, their normals and roughness in another, each smaller surface repeated in its layer (`tiledTexels`); the footway's colour, and its
 * normal and roughness as two layers, at its own size; and the close-zoom layer's families as one array, their colours then their normals. The
 * structures' concrete reads the deck's layers and the concrete family's (`mesh/roadEdges.ts` applyRoadLayers).
 */
function* roadArrays(): Generator<BakedTexture> {
  const texels = new Map(roadRecipes().map(({ key, recipe }) => [key, surfaceTexels(recipe)] as const));
  const of = (key: string): ReturnType<typeof surfaceTexels> => texels.get(key)!;
  const size = ROAD_LAYER_SIZE;
  const tiled = (key: string, pick: (t: ReturnType<typeof surfaceTexels>) => Uint8Array): Uint8Array => tiledTexels(pick(of(key)), of(key).size, size / of(key).size);
  yield { name: 'road-surfaces:map', use: 'color', size, layers: ROAD_COLOUR_LAYERS.map((key) => tiled(key, (t) => t.map)) };
  yield {
    name: 'road-surfaces:relief', use: 'data', size,
    layers: [...ROAD_RELIEF_LAYERS.map((key) => tiled(key, (t) => t.normal)), ...ROAD_RELIEF_LAYERS.map((key) => tiled(key, (t) => t.rough))],
    layerUses: [...ROAD_RELIEF_LAYERS.map((): TextureUse => 'normal'), ...ROAD_RELIEF_LAYERS.map((): TextureUse => 'data')],
  };
  const footway = of('footway');
  yield { name: 'road-footway:map', use: 'color', size: footway.size, layers: [footway.map] };
  yield { name: 'road-footway:relief', use: 'data', size: footway.size, layers: [footway.normal, footway.rough], layerUses: ['normal', 'data'] };
  const details = ROAD_DETAIL_LAYERS.map((kind) => detailTexels(kind));
  yield {
    name: 'road-details', use: 'data', size: details[0]!.size, layers: [...details.map((d) => d.map), ...details.map((d) => d.normal)],
    layerUses: [...details.map((): TextureUse => 'data'), ...details.map((): TextureUse => 'normal')],
  };
}

/** One texture at a time, so the build holds one recipe's texels at once (the finishes' arrays: their layers). */
export function* bakeCatalogue(): Generator<BakedTexture> {
  // The street surfaces in the road material's arrays (`roadArrays`), the structures' concrete too (`mesh/roadEdges.ts` applyRoadLayers). DO NOT
  // bake a surface's own maps besides: no material reads them, the same texels twice in the download and on the GPU.
  yield* roadArrays();
  yield* finishArrays();
  // The land reads the grass's colour and relief (`terrain.ts` `terrainBakes`)
  const land = terrainRecipes();
  const grass = surfaceTexels(land.grass);
  yield { name: 'terrain-grass:map', use: 'color', size: grass.size, layers: [grass.map] };
  yield { name: 'terrain-grass:normal', use: 'normal', size: grass.size, layers: [grass.normal] };
  const grassDetail = detailTexels('grass');
  const soilDetail = detailTexels('soil');
  // DO NOT give the land a texture unit per family: its program ran out of the 16 a fragment shader has
  const rocks = land.rocks.map(surfaceTexels);
  const dirt = surfaceTexels(land.dirt);
  const size = grassDetail.size;
  yield {
    name: 'terrain-land:map', use: 'color', size,
    layers: [srgbEncoded(grassDetail.map), srgbEncoded(soilDetail.map), ...rocks.map((rock) => resized(rock.map, rock.size, size)), resized(dirt.map, dirt.size, size)],
  };
  yield {
    name: 'terrain-land:normal', use: 'normal', size,
    layers: [grassDetail.normal, soilDetail.normal, ...rocks.map((rock) => resized(rock.normal, rock.size, size))],
  };
}

/** Linear bytes (data) as sRGB-encoded ones: kept in a colour array, they read back as themselves (IEC 61966-2-1). */
function srgbEncoded(texels: Uint8Array): Uint8Array {
  const table = Uint8Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  });
  // Alpha is never decoded.
  return texels.map((v, k) => ((k & 3) === 3 ? v : table[v]!));
}

/** Texels of a `from`-sided square at `to` texels a side, bilinear between texel centres, wrapping as the texture repeats (unchanged when equal). */
function resized(texels: Uint8Array, from: number, to: number): Uint8Array {
  if (from === to) return texels;
  const out = new Uint8Array(to * to * 4);
  for (let y = 0; y < to; y++) {
    const sy = ((y + 0.5) * from) / to - 0.5;
    const y0 = Math.floor(sy), fy = sy - y0;
    const ya = ((y0 % from) + from) % from, yb = (ya + 1) % from;
    for (let x = 0; x < to; x++) {
      const sx = ((x + 0.5) * from) / to - 0.5;
      const x0 = Math.floor(sx), fx = sx - x0;
      const xa = ((x0 % from) + from) % from, xb = (xa + 1) % from;
      for (let c = 0; c < 4; c++) {
        const top = texels[(ya * from + xa) * 4 + c]! * (1 - fx) + texels[(ya * from + xb) * 4 + c]! * fx;
        const bottom = texels[(yb * from + xa) * 4 + c]! * (1 - fx) + texels[(yb * from + xb) * 4 + c]! * fx;
        out[(y * to + x) * 4 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}
