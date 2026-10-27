import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';

/** The derived data kept in the player's browser (`src/core/derivedCache.ts`). `holds`: files its maker reaches that hold, file or draw what it
 *  makes and never shape it (a cache of the view's cells, the pictures drawn of its models): left out of its fingerprint with all they import.
 *  DO NOT leave out a file whose code changes what is kept. */
const DERIVED = [
  // The kit's models and their levels (`parts.ts`): its far pictures are taken of them at draw time, never kept (`partPictures.ts`).
  { entry: 'src/render/buildings/parts.ts', also: [] as string[], holds: ['src/render/buildings/partPictures.ts'], define: '__BUILDING_KIT_HASH__' },
  // The conflict zones of each pair of movements (`world/conflictPoints.ts`, kept by `main.ts`).
  { entry: 'src/world/conflictPoints.ts', also: [] as string[], holds: [] as string[], define: '__CONFLICT_ZONES_HASH__' },
  // The road surfaces' tiles (`render/roadSurfaces.ts`, kept by `renderer.ts`): their inputs held round the view cell by cell (`viewCells.ts`), as made.
  { entry: 'src/render/roadSurfaces.ts', also: [] as string[], holds: ['src/world/viewCells.ts'], define: '__ROAD_TILES_HASH__' },
  // A plate's ecosystem and a far plate's woods (`world/ecology.ts`, `render/farWoods.ts`, kept by `ecologyKept.ts`).
  { entry: 'src/world/ecology.ts', also: [] as string[], holds: [] as string[], define: '__ECOLOGY_HASH__' },
  { entry: 'src/render/farWoods.ts', also: [] as string[], holds: [] as string[], define: '__FAR_WOODS_HASH__' },
  // A generated city of a seed, prepared (`cityGen.worker.ts`, kept by `main.ts` cityData).
  { entry: 'src/cityGen.worker.ts', also: [] as string[], holds: [] as string[], define: '__CITY_GEN_HASH__' },
  // A cell's masses and far level as its job makes them (`cellWork.ts`, kept by `cellPool.ts`).
  { entry: 'src/render/buildings/cellWork.ts', also: [] as string[], holds: [] as string[], define: '__CELL_WORK_HASH__' },
] as const;
/** The path aliases of `tsconfig.json`. */
const ALIASES: readonly [string, string][] = [
  ['@core/', 'src/core/'], ['@world/', 'src/world/'], ['@sim/', 'src/sim/'], ['@render/', 'src/render/'],
  ['@view/', 'src/view/'], ['@editor/', 'src/editor/'], ['@ui/', 'src/ui/'], ['@people/', 'src/people/'],
  // `tsconfig.json` and `vite.config.ts` also map `@/` to `src/`: a file reached only through it is code the bake runs too.
  ['@/', 'src/'],
];

/** Every source file `entry` runs, transitively: static imports and exports; never `holds` (`DERIVED`) nor what only they import. */
export function importClosure(root: string, entry: string, holds: readonly string[] = []): string[] {
  const held = new Set(holds.map((file) => path.join(root, file)));
  const resolve = (from: string, spec: string): string | null => {
    const alias = ALIASES.find(([key]) => spec.startsWith(key));
    const base = alias ? path.join(root, alias[1], spec.slice(alias[0].length))
      : spec.startsWith('.') ? path.join(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file) || held.has(file)) return;
    // A file deleted while the server runs (the watcher's event) is no longer part of any closure.
    if (!fs.existsSync(file)) return;
    seen.add(file);
    if (!file.endsWith('.ts')) return;
    const text = fs.readFileSync(file, 'utf8');
    // DO NOT leave out an import for its effect alone (`import './x'`): what it runs is part of the bake as much as what is imported by name.
    const refs = /^\s*(?:import|export)\s+(?!type\b)[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
    for (const m of text.matchAll(refs)) {
      const found = resolve(file, (m[1] ?? m[2] ?? m[3] ?? m[4])!);
      if (found) visit(found);
    }
  };
  visit(path.join(root, entry));
  return [...seen].sort();
}
const DIR = 'cooked';

/** The fingerprint of a derived kind (`DERIVED`): its maker's import closure and the files it also reads. */
/** A source's code alone: its tokens, without comments, spaces or line ends (TypeScript's own scanner). DO NOT hash the raw text: a comment
 *  translated into English changed the generator's fingerprint, the shipped cities were refused, and every opening grew its city again
 *  in front of the player (2026-10-21). What the code does is what the fingerprint stands for. */
function codeOf(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) tokens.push(scanner.getTokenText());
  return tokens.join(' ');
}

function derivedHash(root: string, entry: string, also: readonly string[] = [], holds: readonly string[] = []): string {
  const hash = createHash('sha256');
  for (const file of importClosure(root, entry, holds)) {
    if (!fs.existsSync(file)) continue;
    hash.update(path.relative(root, file).replace(/\\/g, '/'));
    hash.update(codeOf(fs.readFileSync(file, 'utf8')));
  }
  for (const file of also) {
    const at = path.join(root, file);
    if (fs.existsSync(at)) hash.update(fs.readFileSync(at, 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex').slice(0, 16);
}

/** The city generator's fingerprint (`__CITY_GEN_HASH__`): what the shipped cities are stamped with (`scripts/cook-cities.mjs`, read by name through Vite's `ssrLoadModule`).
 *  @public */
export function cityGenHash(root: string): string {
  return derivedHash(root, 'src/cityGen.worker.ts');
}

/** The shipped cities' folder (`src/editor/cookedCities.ts`), copied whole into the build. */
const CITIES_DIR = 'cities';

export function cookPlugin(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  const derived =(): Map<string, string> => new Map(DERIVED.map((d) => [d.define, derivedHash(root, d.entry, d.also, d.holds)]));
  let derivedHashes = new Map<string, string>();
  let building = false;
  /** The build is a server-side bundle (the desktop's job host): nothing to copy beside it. */
  let serverSide = false;
  let checked = false;
  return {
    name: 'roadcraft-cook',
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
      derivedHashes = derived();
      return {
        define: Object.fromEntries([...derivedHashes].map(([name, value]) => [name, JSON.stringify(value)])),
      };
    },
    buildStart() {
      if (!building || checked) return;
      checked = true;
      // The shipped cities of another generator are not read (each grown in front of the player again): said, not refused.
      try {
        const cities = JSON.parse(fs.readFileSync(path.join(root, DIR, CITIES_DIR, 'manifest.json'), 'utf8')) as { hash?: string };
        if (cities.hash !== cityGenHash(root)) this.warn(`The shipped cities in ${DIR}/${CITIES_DIR} were grown by another generator: run \`npm run cook:cities\` (the first new cities are grown in front of the player until then).`);
      } catch { this.warn(`No shipped cities in ${DIR}/${CITIES_DIR}: run \`npm run cook:cities\`.`); }
    },
    configResolved(resolved) {
      outDir = path.resolve(resolved.root, resolved.build.outDir);
      building = resolved.command === 'build';
      // DO NOT copy the shipped cities into a server-side build (`desktop-jobs.config.ts`): the job host reads none of them.
      serverSide = Boolean(resolved.build.ssr);
    },
    configureServer(server) {
      // A change to how a derived kind is made changes its fingerprint: the server restarts with the new one
      const watched = DERIVED.flatMap((d) => importClosure(root, d.entry, d.holds));
      server.watcher.on('change', (file) => {
        if (!watched.some((w) => path.resolve(file).startsWith(path.resolve(w)))) return;
        const nowDerived = derived();
        if ([...nowDerived].some(([name, value]) => derivedHashes.get(name) !== value)) void server.restart();
      });
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (req.method === 'GET' && url.startsWith('/cooked/')) {
          const file = path.join(root, DIR, path.normalize(url.slice('/cooked/'.length)).replace(/^(\.\.[/\\])+/, ''));
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(file).pipe(res);
            return;
          }
          res.statusCode = 404; res.end(); return;
        }
        next();
      });
    },
    closeBundle() {
      if (serverSide) return;
      const citiesFrom = path.join(root, DIR, CITIES_DIR);
      if (fs.existsSync(citiesFrom)) {
        const to = path.join(outDir, DIR, CITIES_DIR);
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(citiesFrom)) fs.copyFileSync(path.join(citiesFrom, name), path.join(to, name));
      }
    },
  };
}
