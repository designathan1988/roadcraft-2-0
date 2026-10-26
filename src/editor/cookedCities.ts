import type { SerializedDoc } from '@world/doc';
import { CITY_TABLES, type CityTable } from './preparedCity';

/** THE CITIES SHIPPED WITH THE GAME: the first new city of each size, grown at build time by the game's own generator (`scripts/cook-cities.mjs`) and read here instead of grown in front of the player, while the next ones are grown ahead (`main.ts` cityAhead) */

/** The seed each size's shipped city is grown from: the player's first new city of that size. */
export const COOKED_CITY_SEEDS = { large: 7, small: 7 } as const;
export type CookedKind = keyof typeof COOKED_CITY_SEEDS;

/** Where they are kept beside the game (`cook-plugin.ts` copies the folder into the build). Read by name by `scripts/cook-cities.mjs` (Vite's `ssrLoadModule`).
 *  @public */
export const COOKED_CITIES_DIR = 'cities';

/** What `cook-cities.mjs` writes: the generator's fingerprint it grew them with (`__CITY_GEN_HASH__`), each city's files: its data, its buildings' table, and the other kinds' tables (`CITY_TABLES`; cities cooked before 2026-10-26 have those records in their data). */
interface CookedCitiesManifest {
  readonly hash: string;
  readonly cities: Partial<Record<CookedKind, { readonly seed: number; readonly data: string; readonly table: string } & Partial<Record<CityTable, string>>>>;
}

/** A shipped city as the page opens it: its document without buildings, its buildings' table (`prepareCity`), and the other kinds' tables where cooked (null: those records in its data). */
export interface CookedCity extends Readonly<Record<CityTable, ArrayBuffer | null>> {
  readonly data: SerializedDoc;
  readonly buildings: ArrayBuffer;
}

/** A gzip file's bytes undone (DecompressionStream, every browser the game runs in). */
async function gunzipped(response: Response): Promise<ArrayBuffer> {
  if (!response.body || typeof DecompressionStream === 'undefined') throw new Error('no gzip stream');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

let manifest: Promise<CookedCitiesManifest | null> | null = null;

/** The shipped city of `kind` grown from `seed` by this build's generator (`hash`), or null: another seed, another generator (the city grown here then), or none shipped. */
export async function readCookedCity(base: string, hash: string | null, kind: CookedKind, seed: number): Promise<CookedCity | null> {
  if (!hash || COOKED_CITY_SEEDS[kind] !== seed) return null;
  const folder = `${base}cooked/${COOKED_CITIES_DIR}/`;
  manifest ??= fetch(`${folder}manifest.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() as Promise<CookedCitiesManifest> : null), () => null);
  const known = await manifest;
  const entry = known?.cities[kind];
  // DO NOT open a city grown by another generator: the same seed grows another city now, and what the game grows later would not match it.
  if (!known || known.hash !== hash || !entry || entry.seed !== seed) return null;
  try {
    const file = (name: string | undefined): Promise<ArrayBuffer | null> => (name ? fetch(`${folder}${name}?v=${hash}`).then(gunzipped) : Promise.resolve(null));
    const [data, table, ...beside] = await Promise.all([file(entry.data), file(entry.table), ...CITY_TABLES.map((name) => file(entry[name]))]);
    const tables = {} as Record<CityTable, ArrayBuffer | null>;
    CITY_TABLES.forEach((name, i) => { tables[name] = beside[i] ?? null; });
    return { data: JSON.parse(new TextDecoder().decode(data!)) as SerializedDoc, buildings: table!, ...tables };
  } catch (error) {
    console.warn('[cities] the shipped city could not be read; it is grown here', error);
    return null;
  }
}
