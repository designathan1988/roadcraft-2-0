// THE CODE GRAPH'S RUNTIME LAYER: what DOES run on the camera bench's fixed path (`scripts/lib/cameraPath.mjs`), joined to the static graph.
//
//   node scripts/codegraph/runtime.mjs <db> [--city large|small] [--shared-gpu] [--shared-machine]
//
// Opens the city through `scripts/lib/measureCity.mjs` (Playwright, the development server, a visible window) and runs the path twice:
//  B, time: the CPU profile (Chrome DevTools Protocol Profiler.start/stop, one profile a segment), self and total ms of every function;
//  A, counts: precise coverage with call counts (Profiler.startPreciseCoverage({callCount: true, detailed: true}), taken at every segment's
//     end: taking it resets the counters), the exact calls of every function in each segment.
// B and A are two openings of the city, never one: precise coverage keeps V8 from optimising the code it counts, so a run under it is slower,
// and it must start before the page's code runs to count everything.
// Every generated position is taken back to its TypeScript source through the source map the development server serves with the module
// (@jridgewell/trace-mapping), and to the function of the static graph holding it (the innermost `fn` whose lines hold the position).
// Written into the same database: table `runtime` (city, round, segment, fn, name, file, line, calls, self_ms, total_ms) and table `segment`
// (city, segment, frames, ms), so the queries (`diagnosis.mjs`) join what runs to the static chains and cost patterns.
// Docs: https://chromedevtools.github.io/devtools-protocol/tot/Profiler/ (startPreciseCoverage, takePreciseCoverage, start, stop),
// https://playwright.dev/docs/api/class-cdpsession, https://v8.dev/blog/javascript-code-coverage (call counts, best-effort vs precise).
import { DatabaseSync } from 'node:sqlite';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { glCounter, openPathCity, PATH, runSegment } from '../lib/cameraPath.mjs';

const args = process.argv.slice(2);
const dbFile = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--city');
const city = args.includes('--city') ? args[args.indexOf('--city') + 1] : 'large';
if (!dbFile) { console.error('usage: runtime.mjs <db> [--city large|small]'); process.exit(2); }

const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE IF NOT EXISTS runtime (city TEXT, round TEXT, segment TEXT, fn INTEGER, name TEXT, file TEXT, line INTEGER, calls INTEGER, self_ms REAL, total_ms REAL);
CREATE TABLE IF NOT EXISTS segment (city TEXT, segment TEXT, frames INTEGER, ms REAL);`);
db.prepare('DELETE FROM runtime WHERE city = ?').run(city);
db.prepare('DELETE FROM segment WHERE city = ?').run(city);
const fnRows = db.prepare('SELECT id, file, line, end_line AS end FROM fn').all();
const fnsByFile = new Map();
for (const f of fnRows) { if (!fnsByFile.has(f.file)) fnsByFile.set(f.file, []); fnsByFile.get(f.file).push(f); }
/** The innermost function of the graph holding a source line. */
function fnAt(file, line) {
  let best = null;
  for (const f of fnsByFile.get(file) ?? []) if (f.line <= line && line <= f.end && (!best || f.end - f.line < best.end - best.line)) best = f;
  return best;
}

// The modules' generated code and source maps, fetched once by URL from the development server (the same bytes the page ran).
const scripts = new Map();
async function scriptOf(url) {
  if (scripts.has(url)) return scripts.get(url);
  let entry = null;
  if (/^https?:/.test(url)) {
    const text = await (await fetch(url)).text();
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const m = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(text);
    // inline (the project's modules) or a file beside the module (the prebundled dependencies: three)
    const file = m ? null : /\/\/# sourceMappingURL=(\S+)\s*$/.exec(text);
    const json = m ? Buffer.from(m[1], 'base64').toString('utf8') : file ? await (await fetch(new URL(file[1], url))).text() : null;
    entry = { url, starts, map: json ? new TraceMap(JSON.parse(json)) : null };
  }
  scripts.set(url, entry);
  return entry;
}
/** A generated position (0-based line and column) back to its source: the repository-relative file and 1-based line, or null. */
function original(entry, line, column) {
  if (!entry?.map) return null;
  const o = originalPositionFor(entry.map, { line: line + 1, column });
  if (!o.source) return null;
  // Vite names a module's source relative to the module's own URL ("uploads.ts" for /src/render/uploads.ts).
  const path = decodeURIComponent(new URL(o.source, entry.url).pathname);
  const file = path.replace(/^.*?\/(src|node_modules)\//, '$1/');
  return { file, line: o.line };
}
async function atOffset(url, offset) {
  const entry = await scriptOf(url);
  if (!entry) return null;
  let lo = 0, hi = entry.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (entry.starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return original(entry, lo, offset - entry.starts[lo]);
}

const ins = db.prepare('INSERT INTO runtime VALUES (?,?,?,?,?,?,?,?,?,?)');
/** Rows keyed by the graph's function (or, outside the graph, the source file and name), summed. */
function keyOf(pos, name) {
  const f = pos && pos.file.startsWith('src/') ? fnAt(pos.file, pos.line) : null;
  return f ? { key: `fn:${f.id}`, fn: f.id, name, file: pos.file, line: f.line } : { key: `${pos?.file ?? '?'}:${name}`, fn: null, name, file: pos?.file ?? null, line: pos?.line ?? null };
}

/** Round B: one CPU profile -> self and total ms by function (total counted once a sample however deep a recursion goes). */
async function profileRows(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keys = new Map();
  for (const n of profile.nodes) {
    const cf = n.callFrame;
    const pos = cf.url ? await atOffsetLine(cf.url, cf.lineNumber, cf.columnNumber) : null;
    keys.set(n.id, keyOf(pos, cf.functionName || '(anonymous)'));
  }
  const rows = new Map();
  const row = (k) => { if (!rows.has(k.key)) rows.set(k.key, { ...k, self: 0, total: 0 }); return rows.get(k.key); };
  for (let i = 0; i < profile.samples.length; i++) {
    const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    let id = profile.samples[i];
    const seen = new Set();
    row(keys.get(id)).self += ms;
    while (id !== undefined) {
      const k = keys.get(id);
      if (!seen.has(k.key)) { seen.add(k.key); row(k).total += ms; }
      id = parent.get(id);
    }
  }
  void nodes;
  return rows;
}
async function atOffsetLine(url, line, column) { return original(await scriptOf(url), line, column); }

/** Round A: precise coverage -> calls by function (the function's own range's count). */
async function coverageRows(result) {
  const rows = new Map();
  for (const script of result) {
    if (!script.url || !/^https?:/.test(script.url)) continue;
    for (const f of script.functions) {
      const r = f.ranges[0];
      if (!r || r.count === 0) continue;
      const pos = await atOffset(script.url, r.startOffset);
      const k = keyOf(pos, f.functionName || '(anonymous)');
      if (!rows.has(k.key)) rows.set(k.key, { ...k, calls: 0 });
      rows.get(k.key).calls += r.count;
    }
  }
  return rows;
}

const segIns = db.prepare('INSERT INTO segment VALUES (?,?,?,?)');
// Round B, time: a city opened for it alone.
{
  const run = await openPathCity({ city, init: glCounter });
  const { browser, page, frame } = run;
  console.log(`${run.city}: opened in ${run.openedS.toFixed(0)} s, settled in ${run.settled.seconds} s (round B)`);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    for (const segment of PATH) {
      await page.evaluate(() => window.__bench.start());
      await cdp.send('Profiler.start');
      const s = await runSegment(page, frame, segment);
      const { profile } = await cdp.send('Profiler.stop');
      const frames = (await page.evaluate(() => window.__bench.stop())).length / 6;
      segIns.run(city, segment.name, frames, s.end - s.start);
      db.exec('BEGIN');
      for (const r of (await profileRows(profile)).values()) ins.run(city, 'B', segment.name, r.fn, r.name, r.file, r.line, null, r.self, r.total);
      db.exec('COMMIT');
      console.log(`B ${segment.name}: ${frames} frames in ${((s.end - s.start) / 1000).toFixed(1)} s`);
    }
  } finally {
    await browser.close();
  }
}
// Round A, exact counts: another opening, precise coverage started on the page BEFORE it navigates. Started later, V8 misses the calls
// made inside code it had already optimised and inlined ("coverage data for JavaScript executed before enabling precise code coverage may be
// incomplete", https://chromedevtools.github.io/devtools-protocol/tot/Profiler/#method-startPreciseCoverage): the first run of this layer
// counted none of the frame's own culls.
{
  let cdp = null;
  const run = await openPathCity({
    city, init: glCounter,
    beforeGoto: async (page) => {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    },
  });
  const { browser, page, frame } = run;
  console.log(`${run.city}: opened in ${run.openedS.toFixed(0)} s, settled in ${run.settled.seconds} s (round A)`);
  try {
    await cdp.send('Profiler.takePreciseCoverage');
    for (const segment of PATH) {
      await runSegment(page, frame, segment);
      const { result } = await cdp.send('Profiler.takePreciseCoverage');
      db.exec('BEGIN');
      for (const r of (await coverageRows(result)).values()) ins.run(city, 'A', segment.name, r.fn, r.name, r.file, r.line, r.calls, null, null);
      db.exec('COMMIT');
      console.log(`A ${segment.name}: counted`);
    }
    await cdp.send('Profiler.stopPreciseCoverage');
  } finally {
    await browser.close();
  }
}
console.log(`runtime rows written to ${dbFile} (city ${city})`);
