/* global window, performance, document, fetch, getComputedStyle */
// THE ENGINE'S CATALOGUE OF OBJECTS WITH GEOMETRY: every kit's objects and variations built on their own by the engine's own builders and measured
// (triangles, vertices, attributes and their bytes, memory, material and shader, how it is drawn, levels of detail, hidden faces, shadow, bones),
// what depends on the city's layout read from a large test city, the test city's copies of each object and its cost (triangles x copies),
// every group's draw calls, the destruction's peak. Lights and effects of the frame are not objects and are left out; the effects with geometry
// are measured in a section of their own; the editor's previews are listed but kept out of the running game's cost.
//
// `node scripts/model-catalog.mjs [out folder] [--url=http://127.0.0.1:5300] [--seed=7] [--panel=480] [--no-game] [--only=<groups>] [--no-models]
//   [--sweep-zoom=4] [--sweep-elevation=60] [--sweep-wait=1500]` (default folder: `reports/engine-geometry`). `--no-game`: every kit object without opening the game.
// Writes `catalog.csv` and `catalog.json` (sorted by total cost), `images/NNNN-<id>.png` (render + wireframe) and `models/NNNN-<id>.glb` for every row (NNNN the order it was built in),
// `buildings.csv` (every building of the test city built alone and measured), `gaps.md`.
// The page side is `src/lab/catalog/` (kits.ts, people.ts, city.ts, measure.ts, items.ts, run.ts).
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { writeReport } from './model-catalog-report.mjs';
import { KEEP_ARRAYS } from './lib/keepArrays.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const flag = (name, fallback) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(args.find((a) => !a.startsWith('--')) ?? 'reports/engine-geometry');
const url = flag('url', 'http://127.0.0.1:5300/');
const seed = Number(flag('seed', 7));
/** Pixels of each picture of a sheet (render and wireframe side by side). */
const panel = Number(flag('panel', 480));
/** Only the kits, without opening the game: the fast way to photograph every kit object (no buildings, no test city). */
const noGame = flags.includes('--no-game');
/** A pattern of the groups to build (`buildings|vehicles`); every group when absent. */
const only = flag('only', '');
/** No 3D files (they take the most room). */
const noModels = flags.includes('--no-models');
/** Added to what the folder holds (`--append`): nothing let go, the new objects numbered after the last one there. */
const append = flags.includes('--append');
mkdirSync(out, { recursive: true });
// The last run's sheets and models let go, the folders kept (a shell or a viewer may hold one open).
for (const [dir, ext] of [['images', '.png'], ['models', '.glb'], ['rows', '.json']]) {
  mkdirSync(join(out, dir), { recursive: true });
  if (!append) for (const file of readdirSync(join(out, dir))) if (file.endsWith(ext)) rmSync(join(out, dir, file), { force: true });
}
/** The last number in the folder: the next object saved takes the one after. */
const savedBefore = readdirSync(join(out, 'rows')).reduce((most, f) => Math.max(most, Number.parseInt(f, 10) || 0), 0);


let server = null;
if (!(await fetch(url).then((r) => r.ok, () => false))) {
  const { createServer } = await import('vite');
  server = await createServer({ server: { host: '127.0.0.1', port: 5300, strictPort: true } });
  await server.listen();
}

/** The sweep: the whole test city looked at view after view on a grid, at this zoom and elevation (degrees), each view held this long (ms) for its cells to stream in. */
const sweepZoom = Number(flag('sweep-zoom', 4));
const sweepElevation = Number(flag('sweep-elevation', 60));
const sweepWait = Number(flag('sweep-wait', 1500));
/** Where the camera looks from in the test city, far to near, so that every layer and level is drawn once (the sweep then covers the whole map). */
const VIEWS = [
  [0, 0, 0.17, 45, 48], [0, 0, 0.6, 0, 60], [0, 0, 1.2, 30, 38], [0, 0, 2.5, 0, 89], [0, 0, 4, 20, 40],
  [150, 0, 7, 20, 30], [150, 0, 12, 20, 25], [-500, 300, 6, 0, 45], [900, 900, 3.5, 0, 50], [-600, -400, 9, 120, 30],
];
const RUN = '/src/lab/catalog/run.ts';
const call = (page, name, ...rest) => page.evaluate(async ([path, fn, params]) => (await import(path))[fn](...params), [RUN, name, rest]);
const step = (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
let result;
let sweep = null;
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  await page.addInitScript(KEEP_ARRAYS);
  // Read by `run.ts` saveRow as it writes each object.
  await page.addInitScript(([p, n]) => { window.__cataloguePanel = p; window.__catalogueNoModels = n; }, [panel, noModels]);
  // The page hands each object's files to the script as it saves them (`run.ts` saveRow): its picture, its 3D file, its numbers; the report written again at each.
  await page.exposeFunction('__catalogueWrite', (file, base64, append) => {
    const path = join(out, file);
    if (append) appendFileSync(path, Buffer.from(base64, 'base64')); else writeFileSync(path, Buffer.from(base64, 'base64'));
    if (file.startsWith('rows/')) {
      const count = writeReport(out, 'in progress');
      if (count % 10 === 0) step(`saved: ${count} objects`);
    }
  });
  if (noGame) {
    // A static file of the dev server: the same origin, so the game's modules load, but the game itself does not start.
    await page.goto(`${url}public/models/citizens/LICENSE-ANIMATIONS.txt`);
    step(`surfaces read: ${await call(page, 'catalogueSurfaces')}`);
  } else {
    await page.goto(url);
    await page.waitForFunction(() => performance.getEntriesByName('opening:shown').length > 0, null, { timeout: 180000, polling: 250 });
  }
  step(`kits: ${await call(page, 'catalogueKits', only, savedBefore)} items`);
  if (!noGame) {
    await page.evaluate((s) => { performance.clearMarks(); return window.__roadcraft.generateCity({ seed: s, size: 'large' }); }, seed);
    await page.waitForFunction(() => performance.getEntriesByName('city:applied').length > 0 && performance.getEntriesByName('opening:shown').length > 0, null, { timeout: 600000, polling: 250 });
    await page.waitForFunction(() => { const c = document.getElementById('loading-curtain'); return !!c && getComputedStyle(c).display === 'none'; }, null, { timeout: 300000, polling: 250 });
    await page.waitForTimeout(2000);
    step(`test city objects: ${await call(page, 'catalogueCityObjects')} items`);
    for (const view of VIEWS) {
      await call(page, 'catalogueView', ...view);
      await page.waitForTimeout(3500);
      step(`view ${view.join(' ')}: ${await call(page, 'catalogueLook')} layer kinds`);
    }
    // The whole map on a grid: each view's ground (cast from the game's camera) overlapping the next by a tenth.
    const extent = await call(page, 'catalogueExtent', sweepZoom, sweepElevation);
    const stepX = extent.spanX * 0.9, stepY = extent.spanY * 0.9;
    const columns = Math.max(1, Math.ceil((extent.maxX - extent.minX) / stepX)), lines = Math.max(1, Math.ceil((extent.maxY - extent.minY) / stepY));
    step(`sweep: ${columns} x ${lines} views over ${Math.round(extent.maxX - extent.minX)} x ${Math.round(extent.maxY - extent.minY)} m (each ${Math.round(extent.spanX)} x ${Math.round(extent.spanY)} m)`);
    sweep = { ...extent, zoom: sweepZoom, elevation: sweepElevation, wait: sweepWait, columns, lines };
    for (let j = 0; j < lines; j++) {
      for (let i = 0; i < columns; i++) {
        // Back and forth, so the camera never jumps across the map between two views.
        const col = j % 2 === 0 ? i : columns - 1 - i;
        await call(page, 'catalogueView', extent.minX + stepX * (col + 0.5), extent.minY + stepY * (j + 0.5), sweepZoom, 0, sweepElevation);
        await page.waitForTimeout(sweepWait);
        const kinds = await call(page, 'catalogueLook');
        if ((j * columns + i + 1) % 20 === 0) step(`sweep: ${j * columns + i + 1} of ${columns * lines} views, ${kinds} layer kinds`);
      }
    }
    await call(page, 'catalogueView', ...VIEWS[3]);
    await page.waitForTimeout(3000);
    step(`finish: ${await call(page, 'catalogueFinish')} items`);
  }
  result = await call(page, 'catalogueResult');
  if (noGame) result.gaps.push('Run without the game (--no-game): no copies, costs (triangles x copies), draw calls or destruction peak: those are counted in a generated city.');
  result.rows.sort((a, b) => b.totalTriangles - a.totalTriangles || b.triangles - a.triangles);
  // Each object was saved as it was made (`run.ts` saveRow): its picture, 3D file and numbers are in the folder already.
} finally {
  await browser.close();
  await server?.close();
}

// ---- the outputs: CSV and JSON by total cost, the gaps.
const rows = result.rows;
const kb = (b) => Math.round(b / 1024);
const COLUMNS = [
  ['rank', (r, i) => i + 1], ['group', (r) => r.group], ['name', (r) => r.name], ['variation', (r) => r.variation], ['origin', (r) => r.origin], ['source', (r) => r.source],
  ['build', (r) => r.build], ['triangles', (r) => r.triangles], ['vertices', (r) => r.vertices], ['bytes_per_vertex', (r) => r.bytesPerVertex], ['attributes', (r) => r.attributes],
  ['geometry_kb', (r) => kb(r.geometryBytes)], ['texture_kb', (r) => kb(r.textureBytes)], ['other_kb', (r) => kb(r.extraBytes)], ['total_kb', (r) => kb(r.totalBytes)],
  ['materials', (r) => r.materials], ['shader', (r) => r.shader], ['shader_motion', (r) => r.motion],
  ['lod_triangles', (r) => r.levels.map((l) => `L${l.level}:${l.triangles}`).join(' ')], ['solids', (r) => r.solids], ['hidden_triangles', (r) => (r.hiddenTriangles === null ? 'n/a' : r.hiddenTriangles)],
  ['shadow', (r) => r.shadow], ['bones', (r) => r.bones || ''], ['morph_targets', (r) => r.morphTargets || ''], ['floors', (r) => r.floors || ''], ['triangles_per_floor', (r) => r.trianglesPerFloor || ''],
  ['instances', (r) => r.instances], ['instances_from', (r) => r.instancesFrom], ['total_triangles', (r) => r.totalTriangles],
  ['editor_preview', (r) => (r.preview ? 'yes' : '')], ['effect', (r) => (r.effect ? 'yes' : '')], ['scene_copy', (r) => (r.sceneCopy ? 'yes' : '')],
  ['textures', (r) => r.textures.join(' | ')], ['sheet', (r) => r.sheet], ['model', (r) => r.model], ['notes', (r) => r.notes.join('; ')],
];
const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
writeFileSync(join(out, 'catalog.csv'), [COLUMNS.map(([h]) => h).join(','), ...rows.map((r, i) => COLUMNS.map(([, f]) => cell(f(r, i))).join(','))].join('\n'));

const known = [
  'Clouds: no mesh; drawn by ray marching in the post chain (src/render/postprocess.ts CLOUD_SHADOWS).',
  'Vehicles\' intermediate levels: made at run time by the simplifier (vehicleLevels.ts partLevels, meshoptimizer); the catalogue gives the full model (L0) and the far model.',
  'Pictures: the colours are each material\'s base colour where its look needs the running game (baked surfaces, the engine\'s uniforms); the geometry and every number are the engine\'s.',
  'Editor feedback on the ground (src/render/renderer.ts blink) and the tools\' 2D gizmos (drawn on a canvas over the view): no catalogued mesh.',
];
/** What "hidden triangles" counts: an exact count of this criterion, not an estimate. */
const HIDDEN = 'hidden_triangles: triangles whose centre lies strictly inside (by more than 0.1 mm) another convex solid of the same object (the solids welded by position): closed, every edge shared by exactly two of its triangles, or open along one plane only (a box with no bottom, or no back against a wall), that plane then one of its faces; an open strip (a leaf) hides nothing. Or pressed face to face on another triangle (the same centre, opposite normals). n/a for lines, points and geometry whose arrays could not be read.';
// Each group's total: the running game's (no previews, no effects), the effects', the previews'.
const groups = {};
for (const r of rows) {
  const g = (groups[r.group] ??= { rows: 0, triangles: 0, totalTriangles: 0, bytes: 0, section: r.preview ? 'editor preview' : r.effect ? 'effect' : 'game' });
  g.rows++; g.triangles += r.triangles; g.totalTriangles += r.totalTriangles; g.bytes += r.totalBytes;
}
const json = {
  generated: new Date().toISOString(), seed, views: VIEWS, sweep, hiddenTriangles: HIDDEN, drawCalls: result.drawCalls, destruction: result.destruction, gaps: [...known, ...result.gaps],
  buildings: result.buildings,
  groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].totalTriangles - a[1].totalTriangles)),
  effects: rows.filter((r) => r.effect).map((r) => r.id), editorPreviews: rows.filter((r) => r.preview).map((r) => r.id), rows, scene: result.scene,
};
writeFileSync(join(out, 'catalog.json'), JSON.stringify(json, null, 1));
writeFileSync(join(out, 'gaps.json'), JSON.stringify(json.gaps, null, 1));
// Each row written again under its own name with what the run learnt of it since (its copies, its cost).
for (const r of rows) if (r.sheet || r.model) writeFileSync(join(out, 'rows', `${(r.sheet || r.model).slice(7, -4)}.json`), JSON.stringify(r, null, 1));
writeReport(out, 'finished');
writeFileSync(join(out, 'gaps.md'), ['# What the catalogue could not measure, and why', '', ...json.gaps.map((g) => `- ${g}`), '', '## How hidden triangles are counted', '', HIDDEN].join('\n'));
// Every building of the test city, built alone and measured: what each kind's size bands sum.
writeFileSync(join(out, 'buildings.csv'), ['id,kind,size,floors,triangles,vertices', ...(result.buildings ?? []).map((b) => [b.id, cell(b.kind), b.size, b.floors, b.triangles, b.vertices].join(','))].join('\n'));

const sum = (list, f) => list.reduce((s, r) => s + f(r), 0);
const game = rows.filter((r) => !r.preview && !r.effect);
console.log(`${rows.length} rows (${sum(rows, (r) => (r.preview ? 1 : 0))} editor previews, ${sum(rows, (r) => (r.effect ? 1 : 0))} effects), ${json.gaps.length} gaps, ${rows.filter((r) => r.sheet).length} sheets, ${rows.filter((r) => r.model).length} 3D files, ${result.buildings?.length ?? 0} buildings measured`);
console.log(`running game: ${sum(game, (r) => r.totalTriangles).toLocaleString('en')} triangles over the test city's copies; draw calls ${result.drawCalls?.total ?? '?'}`);
for (const r of rows.slice(0, 10)) console.log(`  ${String(r.totalTriangles).padStart(12)}  ${r.id}`);
console.log(`-> ${out}`);
