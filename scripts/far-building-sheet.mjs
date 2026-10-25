// THE FAR BUILDINGS' SHEETS: a glass tower and a masonry tower drawn by every level of the building layer (the detail, the facade level, the
// masses of a cell, a tile and a plate, the base) from the Home view's angle at several distances, and a district of towers by its masses and
// facade level from the V0 and V5 eyes, timed; drawn by the game's own levels and environment at the screen's own size on the development
// server's page (`src/lab/farBuildingSheet.ts`): the page draws whatever checkout serves it, one tree's sheet against another's.
//
// `node scripts/far-building-sheet.mjs shoot <out folder> --url=http://127.0.0.1:<port>/ [--no-district] [--no-towers]`
//   writes `<out>/towers/<tower>-<level>-<distance>.png` (each tower's crop), `<out>/<frame>.png` (the district's frames), `<out>/towers.png`
//   (the towers' levels side by side, a row a distance, each face's mean colour under its crop), `<out>/sheet.json` (the numbers: each district
//   frame timed beside an identical copy, `src/lab/steadyTiming.ts`, with the GPU's clocks meanwhile) and `<out>/clocks.csv` (`nvidia-smi`, read only).
// `node scripts/far-building-sheet.mjs compare <out folder> <label>=<shoot folder> <label>=<shoot folder> ... --url=...`
//   writes `<out>/compare-<distance>.png`: each level of each tower in each folder side by side, enlarged, and its difference from the first
//   folder's (`diffImage`); `<out>/compare.json` and `<out>/summary.md` (triangles, draws, the faces' mean colours, the district's GPU time).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { clocksDuring, startClockLog } from './gpu-clocks.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = args.filter((a) => !a.startsWith('--'));
const url = (flag('url') ?? 'http://127.0.0.1:5300/').replace(/\/?$/, '/');
const mode = plain[0];
if (!['shoot', 'compare'].includes(mode)) {
  console.error('usage: far-building-sheet.mjs shoot <out> --url=... [--no-district] [--no-towers] | compare <out> <label>=<shoot> ... --url=...');
  process.exit(2);
}
const MODULE = '/src/lab/farBuildingSheet.ts';
const LEVELS = ['L0', 'L1', 'cell', 'tile', 'plate', 'base'];
const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
const writePng = (file, png) => writeFileSync(file, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
const rgb = (c) => `${c[0]},${c[1]},${c[2]}`;
/** A crop's enlargement on a sheet: whole times, to about 240 pixels tall. */
const scaleOf = (h) => Math.max(1, Math.min(8, Math.round(240 / Math.max(1, h))));
const swatches = (t) => [['+x', t.faces.x], ['+z', t.faces.z], ['roof', t.faces.roof]].map(([label, f]) => ({ rgb: f.rgb, label: `${label} ${rgb(f.rgb)}` }));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/\[vite\]|WebSocket|Vite server/.test(m.text())) console.error(`page: ${m.text()}`); });
  // An empty page of the server's origin: the game's modules load, the game does not start.
  await page.route(`${url}__far/sheet.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>far building sheet</title><body></body>' }));
  await page.goto(`${url}__far/sheet.html`);
  const compose = (heading, rows) => page.evaluate(async ([module, h, r]) => (await import(module)).composeSheet(h, r), [MODULE, heading, rows]);
  if (mode === 'shoot') {
    if (!plain[1]) throw new Error('usage: far-building-sheet.mjs shoot <out folder> --url=...');
    const out = resolve(plain[1]);
    mkdirSync(join(out, 'towers'), { recursive: true });
    const clocks = startClockLog(join(out, 'clocks.csv'));
    const sheet = await page.evaluate(async ([module, district, towers]) => (await import(module)).farBuildingSheet(district, towers), [MODULE, !args.includes('--no-district'), !args.includes('--no-towers')]);
    const towers = sheet.towers.map(({ png, ...rest }) => {
      const file = `${rest.tower}-${rest.level}-${rest.distance}.png`;
      writePng(join(out, 'towers', file), png);
      return { ...rest, file };
    });
    const logged = await clocks.stop();
    const districts = sheet.districts.map(({ png, ...rest }) => {
      writePng(join(out, `${rest.name}.png`), png);
      const clock = clocksDuring(logged, { start: rest.gpu.window.start, end: rest.gpuCheck.window.end });
      const ms = (g) => `${g.median.toFixed(3)} (p10 ${g.p10.toFixed(3)}, p90 ${g.p90.toFixed(3)}; ${g.samples} x ${g.passes} passes)`;
      const core = clock.core ? `core ${clock.core.min}-${clock.core.max} MHz, memory ${clock.memory.min}-${clock.memory.max} MHz, ${clock.pstates.join('/')}, load ${clock.load.min}-${clock.load.max} %` : 'no clock log';
      console.log(`${rest.name}: ${rest.triangles} triangles in ${rest.drawCalls} draws; scene pass ${ms(rest.gpu)}, its copy ${ms(rest.gpuCheck)}; ${core}`);
      return { ...rest, clocks: clock };
    });
    for (const t of towers) console.log(`${t.tower} ${t.level} at ${t.distance} m: ${t.triangles} triangles in ${t.drawCalls} draws; +x ${rgb(t.faces.x.rgb)} (${t.faces.x.pixels} px), +z ${rgb(t.faces.z.rgb)} (${t.faces.z.pixels} px), roof ${rgb(t.faces.roof.rgb)} (${t.faces.roof.pixels} px)`);
    writeFileSync(join(out, 'sheet.json'), JSON.stringify({ url, made: new Date().toISOString(), towers, districts }, null, 1));
    // The towers' sheet: a row a tower and distance, its levels side by side.
    const rows = [];
    for (const name of [...new Set(towers.map((t) => t.tower))]) {
      for (const distance of [...new Set(towers.map((t) => t.distance))]) {
        const shots = LEVELS.map((level) => towers.find((t) => t.tower === name && t.level === level && t.distance === distance)).filter(Boolean);
        const scale = scaleOf(Math.max(...shots.map((t) => t.crop.h)));
        const p = shots[0].pxPerMetre;
        rows.push({
          title: `${name} tower at ${distance} m (${p.x.toFixed(2)} / ${p.z.toFixed(2)} px a metre across, ${p.up.toFixed(2)} up; crops x${scale})`,
          cells: shots.map((t) => ({ png: dataUrl(join(out, 'towers', t.file)), scale, caption: `${t.level}: ${t.triangles} tri, ${t.drawCalls} draws`, swatches: swatches(t) })),
        });
      }
    }
    if (rows.length) writePng(join(out, 'towers.png'), await compose(`Far buildings by level (${url})`, rows));
    console.log(`-> ${out}`);
  } else {
    const out = resolve(plain[1] ?? '');
    const sets = plain.slice(2).map((a) => { const at = a.indexOf('='); return { label: a.slice(0, at), dir: resolve(a.slice(at + 1)) }; });
    if (!plain[1] || sets.length < 2) throw new Error('usage: far-building-sheet.mjs compare <out folder> <label>=<shoot folder> <label>=<shoot folder> ... --url=...');
    mkdirSync(out, { recursive: true });
    for (const s of sets) s.sheet = JSON.parse(readFileSync(join(s.dir, 'sheet.json'), 'utf8'));
    const first = sets[0];
    const report = [];
    for (const distance of [...new Set(first.sheet.towers.map((t) => t.distance))]) {
      const rows = [];
      for (const name of [...new Set(first.sheet.towers.map((t) => t.tower))]) {
        for (const level of LEVELS) {
          const shots = sets.map((s) => s.sheet.towers.find((t) => t.tower === name && t.level === level && t.distance === distance));
          if (shots.some((t) => !t)) continue;
          const scale = scaleOf(shots[0].crop.h);
          const cells = sets.map((s, k) => ({ png: dataUrl(join(s.dir, 'towers', shots[k].file)), scale, caption: `${s.label}: ${shots[k].triangles} tri, ${shots[k].drawCalls} draws`, swatches: swatches(shots[k]) }));
          for (const [k, s] of sets.entries()) {
            if (k === 0) continue;
            const d = await page.evaluate(async ([module, a, b]) => (await import(module)).diffImage(a, b, 4), [MODULE, dataUrl(join(first.dir, 'towers', shots[0].file)), dataUrl(join(s.dir, 'towers', shots[k].file))]);
            cells.push({ png: d.png, scale, caption: `${s.label}-${first.label}: ${(d.changed8 * 100).toFixed(1)}% >8, max ${d.largest}` });
            report.push({ distance, tower: name, level, versus: `${s.label} - ${first.label}`, changed8: d.changed8, changed32: d.changed32, largest: d.largest,
              triangles: [shots[0].triangles, shots[k].triangles], draws: [shots[0].drawCalls, shots[k].drawCalls], faces: [shots[0].faces, shots[k].faces] });
          }
          rows.push({ title: `${name} ${level} at ${distance} m (crops x${scale})`, cells });
        }
      }
      writePng(join(out, `compare-${distance}.png`), await compose(`Far buildings at ${distance} m: ${sets.map((s) => s.label).join(' | ')}`, rows));
    }
    writeFileSync(join(out, 'compare.json'), JSON.stringify(report, null, 1));
    const lines = ['| Tower | Level | Distance m | Versus | Pixels > 8/255 | Largest | Triangles | Draws | Mean +x | Mean +z | Mean roof |', '|---|---|---|---|---|---|---|---|---|---|---|'];
    for (const r of report) {
      const f = (k) => `${rgb(r.faces[0][k].rgb)} -> ${rgb(r.faces[1][k].rgb)}`;
      lines.push(`| ${r.tower} | ${r.level} | ${r.distance} | ${r.versus} | ${(r.changed8 * 100).toFixed(2)} % | ${r.largest} | ${r.triangles[0]} -> ${r.triangles[1]} | ${r.draws[0]} -> ${r.draws[1]} | ${f('x')} | ${f('z')} | ${f('roof')} |`);
    }
    lines.push('', `| Frame | ${sets.map((s) => `${s.label} triangles / draws`).join(' | ')} | ${sets.map((s) => `${s.label} GPU ms median (p10-p90)`).join(' | ')} |`);
    lines.push(`|---|${sets.map(() => '---|').join('')}${sets.map(() => '---|').join('')}`);
    for (const frame of first.sheet.districts) {
      const of = sets.map((s) => s.sheet.districts.find((d) => d.name === frame.name));
      lines.push(`| ${frame.name} | ${of.map((d) => (d ? `${d.triangles} / ${d.drawCalls}` : '-')).join(' | ')} | ${of.map((d) => (d ? `${d.gpu.median.toFixed(3)} (${d.gpu.p10.toFixed(3)}-${d.gpu.p90.toFixed(3)})` : '-')).join(' | ')} |`);
    }
    writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
    console.log(`-> ${out}`);
  }
} finally {
  await browser.close();
}
