// THE OPTIMISATION SHEETS: every object of a builder group built by the engine's own builder, alone, on a page that never starts the game
// (the catalogue's `--no-game` page), drawn from four sides rendered and as a hidden-line wireframe, with its full measures.
//
// `node scripts/optimization-sheet.mjs before <folder> --only=<builder groups> [--match=<key pattern>] [--panel=300] [--distance=<m>] [--radius=<m>]`
//   before a change: each object's views, measures and triangles under `<folder>/<object>/before.*`.
// `node scripts/optimization-sheet.mjs after <folder> --only=<builder groups> [--match=<key pattern>] [--panel=300] [--distance=<m>]`
//   after it: the same, measured against `before` (two-sided Hausdorff distance, silhouette overlap per view), the sheet `<folder>/<object>.png`
//   (before and after side by side), `<folder>/metrics.json` and `<folder>/summary.md`.
// `--only` is a pattern of the builder groups of `src/lab/catalog/run.ts` catalogueKits (`vehicles`, `roads, structures, poles`...); `--distance`
// the nearest distance the object is seen at in the game, where its error is put in pixels (else the sheet's own camera distance).
// `node scripts/optimization-sheet.mjs inventory <file.json>`: every object every builder group makes, measured, nothing drawn.
// The page side is `src/lab/optimization/sheet.ts`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { KEEP_ARRAYS } from './lib/keepArrays.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const flag = (name, fallback) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const [stage, folderArg] = args.filter((a) => !a.startsWith('--'));
if (!['before', 'after', 'inventory'].includes(stage) || !folderArg) {
  console.error('usage: node scripts/optimization-sheet.mjs before|after <folder> --only=<builder groups> [--match=<key pattern>] [--panel=300] [--distance=<m>]');
  process.exit(2);
}
const folder = resolve(folderArg);
const only = flag('only', '');
const match = new RegExp(flag('match', ''), 'i');
const panel = Number(flag('panel', 300));
const distance = flag('distance', '') === '' ? null : Number(flag('distance', ''));
const url = flag('url', 'http://127.0.0.1:5300/');
/** Only this many metres round the object's centre in view (a road layout's junction), else the whole object. */
const crop = flag('radius', '') === '' ? null : Number(flag('radius', ''));
/** The point the view is centred on (x,y,z, metres), else the object's centre; with it, before and after are both seen from there. */
const at = flag('at', '') === '' ? null : flag('at', '').split(',').map(Number);
if (stage !== 'inventory') mkdirSync(folder, { recursive: true });

/** A folder name for an object: its stable key (no triangle count) in plain characters. */
const slugOf = (key) => key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
const step = (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

let server = null;
if (!(await fetch(url).then((r) => r.ok, () => false))) {
  const { createServer } = await import('vite');
  // On the url's own port, watching no file (https://vite.dev/config/server-options, `server.watch`: null): another session editing the tree
  // reloaded the page of a dev server it shared and lost the sheet half way.
  server = await createServer({ server: { host: '127.0.0.1', port: Number(new URL(url).port || 5300), strictPort: true, watch: null } });
  await server.listen();
}
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const summary = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  await page.addInitScript(KEEP_ARRAYS);
  // `--linear`: the shaded views drawn as the game draws its scene, blended in linear light before the tone mapping (`sheet.ts` renderShaded).
  if (flags.includes('--linear')) await page.addInitScript(() => { window.__sheetLinear = true; });
  // A static file of the dev server: the same origin, so the engine's modules load, but the game itself never starts.
  await page.goto(`${url}public/models/citizens/LICENSE-ANIMATIONS.txt`);
  const call = (path, fn, ...rest) => page.evaluate(async ([p, f, params]) => (await import(p))[f](...params), [path, fn, rest]);
  await call('/src/lab/catalog/run.ts', 'catalogueSurfaces');
  // The road surfaces' own programs, compiled as the game compiles them (the sheets draw them with plain materials, `items.ts` sheetMaterial, so
  // nothing else here would): the run stops on any error or warning in a shader's or a program's log.
  const shaders = await page.evaluate(async () => {
    const source = await (await fetch('/src/render/materials.ts')).text();
    const threeAt = /from "(\/node_modules\/\.vite\/deps\/three\.js[^"]*)"/.exec(source)?.[1];
    if (!threeAt) return [{ name: 'three', problem: 'the module three is served from was not found in materials.ts' }];
    const THREE = await import(threeAt);
    const { createMaterials } = await import('/src/render/materials.ts');
    const { roadSheetMaterial } = await import('/src/render/mesh/roadEdges.ts');
    const materials = createMaterials(16);
    const renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas') });
    renderer.debug.checkShaderErrors = true;
    const geometry = new THREE.BufferGeometry();
    const attribute = (size) => new THREE.BufferAttribute(new Float32Array(3 * size).fill(0.5), size);
    // The section as a block carries it: the three numbers a tile has and its surface's code (`surfaceTiles.ts` SECTION_SIZE).
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3], ['roadSection', 4]]) geometry.setAttribute(name, attribute(size));
    const scene = new THREE.Scene();
    scene.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.HemisphereLight(0xffffff, 0x444444, 1));
    // Every road surface's one material (`mesh/roadEdges.ts` applyRoadSurface) and the one the sheets draw it with (`items.ts` sheetMaterial): each
    // must make its own program, found by its key, linked with no log; a program no road material asked for is a problem too.
    const expected = [['road surfaces', materials.road], ['road surfaces on a sheet', roadSheetMaterial()]];
    for (const [name, material] of expected) { const mesh = new THREE.Mesh(geometry, material); mesh.name = name; scene.add(mesh); }
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const keys = expected.map(([name, material]) => [name, material.customProgramCacheKey()]);
    const asked = (p) => keys.find(([, key]) => p.cacheKey.includes(key))?.[0] ?? null;
    const out = keys.filter(([, key]) => !renderer.info.programs.some((p) => p.cacheKey.includes(key))).map(([name]) => ({ name, problem: 'no program made' }));
    out.push(...renderer.info.programs.filter((p) => !asked(p)).map((p) => ({ name: p.name, problem: `a program no road material asked for (${p.cacheKey.slice(0, 160)})` })));
    out.push(...renderer.info.programs.filter((p) => asked(p)).map((p) => {
      // Each shader's log with the line it names, so a warning is read where it is (`0:215` the shader's line 215).
      const named = (s) => (gl.getShaderInfoLog(s) ?? '').trim().split('\n').filter((l) => l).map((l) => {
        const at = /^\w+: 0:(\d+):/.exec(l), lines = (gl.getShaderSource(s) ?? '').split('\n');
        return at ? `${l} [${(lines[Number(at[1]) - 1] ?? '').trim()}]` : l;
      }).join(' | ');
      const logs = [gl.getProgramInfoLog(p.program) ?? '', ...(gl.getAttachedShaders(p.program) ?? []).map(named)].map((l) => l.trim()).filter((l) => l);
      const linked = gl.getProgramParameter(p.program, gl.LINK_STATUS);
      return { name: asked(p), problem: !linked ? `not linked: ${logs.join(' | ')}` : logs.length ? logs.join(' | ') : null };
    }));
    renderer.dispose();
    return out;
  });
  for (const s of shaders) step(`shader ${s.name}: ${s.problem ?? 'compiled, no log'}`);
  if (shaders.some((s) => s.problem)) throw new Error('a road surface\'s program did not compile clean (above)');
  if (stage === 'inventory') {
    const inventory = await call('/src/lab/optimization/sheet.ts', 'optimizationInventory');
    writeFileSync(folder, JSON.stringify(inventory, null, 1));
    step(`inventory: ${inventory.rows.length} objects, ${inventory.gaps.length} gaps`);
  }
  const objects = stage === 'inventory' ? [] : (await call('/src/lab/optimization/sheet.ts', 'optimizationBuild', only)).filter((o) => match.test(o.key));
  step(`${objects.length} objects in "${only}"${flag('match', '') ? ` matching /${flag('match', '')}/` : ''}`);
  const used = new Map();
  for (const { id, key } of objects) {
    let slug = slugOf(key);
    used.set(slug, (used.get(slug) ?? 0) + 1);
    if (used.get(slug) > 1) slug = `${slug}-${used.get(slug)}`;
    const dir = join(folder, slug);
    mkdirSync(dir, { recursive: true });
    let before = null;
    if (stage === 'after') {
      if (!existsSync(join(dir, 'before.json'))) { step(`no "before" for ${key}: skipped`); summary.push({ key, slug, missing: true }); continue; }
      const saved = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8'));
      before = { ...saved, soup: readFileSync(join(dir, 'before.tri')).toString('base64'), block: readFileSync(join(dir, 'before.png')).toString('base64') };
    }
    const shot = await page.evaluate(async ([i, p, b, d, c, a]) => {
      const sheet = await import('/src/lab/optimization/sheet.ts');
      return sheet.optimizationCapture(i, p, b, d, c, a);
    }, [id, panel, before, distance, crop, at]);
    writeFileSync(join(dir, `${stage}.png`), Buffer.from(shot.block, 'base64'));
    writeFileSync(join(dir, `${stage}.tri`), Buffer.from(shot.soup, 'base64'));
    const record = { id, key, metrics: shot.metrics, framing: shot.framing, levelErrors: shot.levelErrors, distance: shot.distance, error: shot.error ?? null, overlap: shot.overlap ?? null };
    writeFileSync(join(dir, `${stage}.json`), JSON.stringify(record, null, 1));
    if (shot.sheet) {
      writeFileSync(join(folder, `${slug}.png`), Buffer.from(shot.sheet, 'base64'));
      summary.push({ key, slug, before: before.metrics, after: shot.metrics, error: shot.error, overlap: shot.overlap, distance: shot.distance });
    }
    step(`${stage}: ${key}`);
  }
} finally {
  await browser.close();
  await server?.close();
}

if (stage === 'after') {
  writeFileSync(join(folder, 'metrics.json'), JSON.stringify(summary, null, 1));
  const pct = (a, b) => (a ? `${Math.round((1 - b / a) * 100)} %` : '');
  const mm = (m) => (m === undefined || m === null ? 'n/a' : `${(m * 1000).toFixed(1)} mm`);
  const lines = ['| Object | Triangles | Vertices | Geometry bytes | Bytes/vertex | Surface moved (max) | Least silhouette overlap | Sheet |', '|---|---|---|---|---|---|---|---|'];
  for (const s of summary) {
    if (s.missing) { lines.push(`| ${s.key} | no "before" | | | | | | |`); continue; }
    const b = s.before, a = s.after;
    lines.push(`| ${s.key} | ${b.triangles} → ${a.triangles} (${pct(b.triangles, a.triangles)}) | ${b.vertices} → ${a.vertices} (${pct(b.vertices, a.vertices)}) | ${b.geometryBytes} → ${a.geometryBytes} (${pct(b.geometryBytes, a.geometryBytes)}) | ${b.bytesPerVertex} → ${a.bytesPerVertex} | ${mm(s.error?.max)}${s.error?.at ? ` at (${s.error.at.map((v) => v.toFixed(1)).join(', ')})` : ''} | ${s.overlap ? `${(Math.min(...s.overlap) * 100).toFixed(2)} %` : 'n/a'} | [sheet](${s.slug}.png) |`);
  }
  writeFileSync(join(folder, 'summary.md'), `${lines.join('\n')}\n`);
}
if (stage !== 'inventory') step(`-> ${folder}`);
