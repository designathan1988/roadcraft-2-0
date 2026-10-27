// THE DIAGNOSIS: the static code graph joined to what ran on the camera bench's path (`runtime.mjs`), the questions the mission asks of it.
//
//   node scripts/codegraph/diagnosis.mjs <db> [--out reports/codegraph/diagnosis.md]
//
//  a) the 50 functions with the most time during the drag (the pan and orbit segments), a frame;
//  b) the functions called more than 1000 times a frame, with the memory they make in loops;
//  c) every GPU upload that ran during the drag outside the upload queue (`render/uploads.ts` drainUploads);
//  d) everything that walks the scene or recompiles a material during the drag;
//  e) everything on the main thread whose cost grows with the map, not the view: the same path on the small city and on the 10 km city.
// Each line: the chain of calls from the frame (through functions that ran), the cost patterns of the function, the run's numbers.
// Also writes `<out>.json` (the items of c, d and e by function), which the permanent rules (`rules.mjs`) count.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DRAG_SEGMENTS } from '../lib/cameraPath.mjs';
import { loadGraph } from './graph.mjs';

const args = process.argv.slice(2);
const dbFile = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'reports/codegraph/diagnosis.md';
if (!dbFile) { console.error('usage: diagnosis.mjs <db> [--out file.md]'); process.exit(2); }
const g = loadGraph(dbFile);
const { all, fns } = g;
const hasRuntime = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime'").length > 0;
if (!hasRuntime) { console.error('no runtime table: run scripts/codegraph/runtime.mjs first'); process.exit(2); }

const r1 = (v) => (v === null || v === undefined ? '—' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
const inList = (list) => list.map((s) => `'${s}'`).join(',');
const DRAG = inList(DRAG_SEGMENTS);

/** Frames of the drag segments of a city. */
const framesOf = (city, segs = DRAG) => all(`SELECT SUM(frames) AS f FROM segment WHERE city = ? AND segment IN (${segs})`, city)[0]?.f ?? 0;
/** Per function (graph id, or file:name outside the graph): ms (round B) and calls (round A) summed over segments. */
function perFn(city, segs = DRAG) {
  const rows = new Map();
  for (const r of all(`SELECT fn, name, file, line, round, SUM(calls) AS calls, SUM(self_ms) AS self, SUM(total_ms) AS total FROM runtime
      WHERE city = ? AND segment IN (${segs}) GROUP BY fn, CASE WHEN fn IS NULL THEN file || ':' || name END, round`, city)) {
    const key = r.fn !== null ? `fn:${r.fn}` : `${r.file}:${r.name}`;
    if (!rows.has(key)) rows.set(key, { key, fn: r.fn, name: r.fn !== null ? fns.get(r.fn)?.qual ?? r.name : r.name, file: r.file, line: r.line, calls: 0, self: 0, total: 0 });
    const row = rows.get(key);
    if (r.round === 'A') row.calls += r.calls ?? 0;
    else { row.self += r.self ?? 0; row.total += r.total ?? 0; }
  }
  return rows;
}
const cities = all('SELECT DISTINCT city FROM segment').map((r) => r.city);
const big = cities.includes('large') ? 'large' : cities[0];
const frames = framesOf(big);
const rows = perFn(big);
const ran = new Set([...rows.values()].filter((r) => r.fn !== null && (r.calls > 0 || r.self > 0)).map((r) => r.fn));
const root = g.find('src/main.ts:frame');
ran.add(root);
// chains through functions that ran in the drag (what DID run), falling back to the static graph for one that ran outside the frame's walk
const live = g.reach([root], 8, ran);
const stat = g.reach([root]);
const chainOf = (fn) => (live.via.has(fn) ? g.chain(fn, live.via) : stat.via.has(fn) ? `${g.chain(fn, stat.via)} (static)` : '(not reached from the frame: a callback, a job or an event)');
const factsOf = (fn, kinds = null) => all(`SELECT kind, detail, line, loop FROM fact WHERE fn = ?${kinds ? ` AND kind IN (${inList(kinds)})` : ''} ORDER BY loop DESC, line`, fn);
const factLine = (fn, kinds) => factsOf(fn, kinds).slice(0, 5).map((x) => `${x.kind} ${x.detail} @${x.line}${x.loop ? ` (loop ${x.loop})` : ''}`).join('; ') || '—';
const where = (r) => `${r.name} (${r.file ?? '?'}${r.line ? `:${r.line}` : ''})`;
const md = [`# Diagnosis: what ran on the bench path, joined to the code graph`, '',
  `City: ${big}. Drag segments (${DRAG_SEGMENTS.join(', ')}): ${frames} frames. Numbers are a frame of the drag: ms from the CPU profile (round B),`,
  `calls from precise coverage (round A, a separate run of the same path). Library functions (three.js, the browser) have no chain in the graph.`, ''];
const json = { city: big, frames, a: [], b: [], c: [], d: [], e: [] };

// a) time
md.push('## a) The 50 functions with the most time during the drag (self ms a frame)', '', '| # | function | self ms/frame | total ms/frame | calls/frame | patterns | chain |', '|---|---|---|---|---|---|---|');
const byTime = [...rows.values()].filter((r) => r.self > 0).sort((x, y) => y.self - x.self).slice(0, 50);
byTime.forEach((r, i) => {
  md.push(`| ${i + 1} | ${where(r)} | ${r1(r.self / frames)} | ${r1(r.total / frames)} | ${r1(r.calls / frames)} | ${r.fn !== null ? factLine(r.fn, ['gpu', 'gl-sync', 'walk', 'gpu-object', 'sort', 'alloc']) : 'library'} | ${r.fn !== null ? chainOf(r.fn) : '—'} |`);
  json.a.push({ name: r.name, file: r.file, selfMs: r.self / frames, totalMs: r.total / frames, calls: r.calls / frames });
});

// b) calls
md.push('', '## b) Functions called more than 1000 times a frame, and the memory they make in loops', '', '| function | calls/frame | self ms/frame | allocations | chain |', '|---|---|---|---|---|');
for (const r of [...rows.values()].filter((x) => x.calls / frames > 1000).sort((x, y) => y.calls - x.calls)) {
  const allocs = r.fn !== null ? factsOf(r.fn, ['alloc', 'closure', 'string']) : [];
  md.push(`| ${where(r)} | ${r1(r.calls / frames)} | ${r1(r.self / frames)} | ${allocs.length ? allocs.slice(0, 5).map((x) => `${x.detail || x.kind} @${x.line}${x.loop ? ` (loop ${x.loop})` : ''}`).join('; ') : 'none found'} | ${r.fn !== null ? chainOf(r.fn) : '—'} |`);
  json.b.push({ name: r.name, file: r.file, calls: r.calls / frames, allocations: allocs.length });
}

// c) uploads outside the queue
const UPLOAD = /^(bufferSubData|bufferData|texSubImage2D|texImage2D|texImage3D|texSubImage3D|copyBufferSubData|compressedTex|three:addUpdateRange|three:initTexture|three:copyTextureToTexture|texture\.needsUpdate|attribute\.needsUpdate|version\+\+|.*\.needsUpdate=true$)/;
const queue = g.find('src/render/uploads.ts:drainUploads');
const underQueue = new Set(g.reach([queue]).heat.keys());
md.push('', '## c) GPU uploads that ran during the drag outside the upload queue (drainUploads)', '', '| function | calls/frame | self ms/frame | uploads | chain |', '|---|---|---|---|---|');
for (const r of [...rows.values()].filter((x) => x.fn !== null && x.calls > 0 && !underQueue.has(x.fn)).sort((x, y) => y.self - x.self)) {
  const ups = factsOf(r.fn, ['gpu']).filter((x) => UPLOAD.test(x.detail));
  if (!ups.length) continue;
  md.push(`| ${where(r)} | ${r1(r.calls / frames)} | ${r1(r.self / frames)} | ${ups.slice(0, 4).map((x) => `${x.detail} @${x.line}`).join('; ')} | ${chainOf(r.fn)} |`);
  json.c.push({ name: r.name, file: r.file, line: r.line, uploads: ups.map((x) => x.detail) });
}
// three's own uploading functions that took time during the drag (what the game's calls above make three do)
const THREE_UPLOAD = /^(uploadTexture|updateBuffer|update|setTexture2D|setTexture3D|setTextureCube|texSubImage2D|texImage2D|bufferSubData|bufferData|texStorage2D|updateRenderTargetMipmap)$/;
const libUploads = [...rows.values()].filter((r) => r.fn === null && /three/.test(r.file ?? '') && THREE_UPLOAD.test(r.name) && r.self > 0).sort((x, y) => y.total - x.total);
if (libUploads.length) md.push('', 'three.js uploading functions during the drag: ' + libUploads.slice(0, 10).map((r) => `${r.name} ${r1(r.total / frames)} ms/frame total`).join('; '));

// d) scene walks and recompiles
md.push('', '## d) Scene walks and material recompiles during the drag', '', '| function | calls/frame | self ms/frame | patterns | chain |', '|---|---|---|---|---|');
for (const r of [...rows.values()].filter((x) => x.fn !== null && x.calls > 0).sort((x, y) => y.self - x.self)) {
  const hits = factsOf(r.fn).filter((x) => x.kind === 'walk' || /program recompiled/.test(x.detail));
  if (!hits.length) continue;
  md.push(`| ${where(r)} | ${r1(r.calls / frames)} | ${r1(r.self / frames)} | ${hits.slice(0, 4).map((x) => `${x.detail} @${x.line}`).join('; ')} | ${chainOf(r.fn)} |`);
  json.d.push({ name: r.name, file: r.file, line: r.line, patterns: hits.map((x) => x.detail) });
}
const THREE_WALK = /^(projectObject|traverse|traverseVisible|updateMatrixWorld|updateWorldMatrix|renderObjects|renderObject|getProgram|setProgram|initMaterial)$/;
const libWalks = [...rows.values()].filter((r) => r.fn === null && /three/.test(r.file ?? '') && THREE_WALK.test(r.name) && r.total > 0).sort((x, y) => y.total - x.total);
if (libWalks.length) md.push('', 'three.js scene walks and program work during the drag: ' + libWalks.map((r) => `${r.name} ${r1(r.total / frames)} ms/frame total, ${r1(r.calls / frames)} calls/frame`).join('; '));

// e) grows with the map
if (cities.includes('small') && cities.includes('large')) {
  const small = perFn('small'), smallFrames = framesOf('small');
  md.push('', '## e) Main-thread cost that grows with the map, not the view (same path: small city vs 10 km city)', '',
    'Kept when the 10 km city costs over 3 times the small city a frame (calls or ms) and the 10 km cost is not negligible (50 calls or 0.1 ms a frame).', '',
    '| function | calls/frame small -> 10 km | ms/frame small -> 10 km | chain |', '|---|---|---|---|');
  for (const r of [...rows.values()].sort((x, y) => y.self - x.self)) {
    const s = small.get(r.key) ?? { calls: 0, self: 0 };
    const cl = r.calls / frames, cs = s.calls / smallFrames, ml = r.self / frames, ms = s.self / smallFrames;
    const callsGrow = cl >= 50 && cl > 3 * Math.max(cs, 1e-9);
    const msGrow = ml >= 0.1 && ml > 3 * Math.max(ms, 1e-9);
    if (!callsGrow && !msGrow) continue;
    md.push(`| ${where(r)} | ${r1(cs)} -> ${r1(cl)} | ${r1(ms)} -> ${r1(ml)} | ${r.fn !== null ? chainOf(r.fn) : '—'} |`);
    json.e.push({ name: r.name, file: r.file, line: r.line, callsSmall: cs, callsLarge: cl, msSmall: ms, msLarge: ml });
  }
} else md.push('', '## e) Grows with the map', '', 'Needs both runs: `runtime.mjs <db> --city small` and `--city large`.');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${md.join('\n')}\n`);
writeFileSync(out.replace(/\.md$/, '.json'), `${JSON.stringify(json, null, 1)}\n`);
console.log(`written ${out}: a ${json.a.length}, b ${json.b.length}, c ${json.c.length}, d ${json.d.length}, e ${json.e.length}`);
