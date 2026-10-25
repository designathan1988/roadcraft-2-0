// THE GROUND COVER'S LADDER SHEETS: a strip of one kind of element laid as the brush lays it, from under the eye to the horizon, drawn by the
// game's own element layer with its own files, textures, lights and shadows at the screen's own size (1920 x 1080, a 35° view), on the
// development server's page (`src/lab/elementLadderSheet.ts`); the page draws whatever checkout serves it: one tree's frames against another's.
//
// `node scripts/element-ladder-sheet.mjs shoot <out folder> --url=http://127.0.0.1:<port>/ [--kinds=grass,fern,...]`
//   writes `<out>/<kind>.png` and `<out>/frames.json` (three's draws and triangles, the layer's meshes drawn, the elements nearest each size).
// `node scripts/element-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...`
//   writes `<out>/<kind>.png`: before and after side by side, their difference pixel by pixel, and the elements at the sizes the levels change
//   at enlarged 8 times (`src/lab/propLadderSheet.ts` propLadderCompare, the street props' own comparison); `<out>/metrics.json`, `<out>/summary.md`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = args.filter((a) => !a.startsWith('--'));
const url = (flag('url') ?? 'http://127.0.0.1:5316/').replace(/\/?$/, '/');
const mode = plain[0];
if (mode !== 'shoot' && mode !== 'compare') {
  console.error('usage: element-ladder-sheet.mjs shoot <out> --url=... [--kinds=...] | compare <before out> <after out> <out> --url=...');
  process.exit(2);
}
const KINDS = (flag('kinds') ?? 'grass,tallGrass,fern,clover,flowers,scrub,mushrooms,stones,pebbles,gravel,leaves').split(',');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`page: ${m.text()}`); });
  // An empty page of the server's origin: the game's modules load, the game does not start.
  await page.route(`${url}__elements/sheet.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>element ladder sheet</title><body></body>' }));
  await page.goto(`${url}__elements/sheet.html`);
  if (mode === 'shoot') {
    if (!plain[1]) throw new Error('usage: element-ladder-sheet.mjs shoot <out folder> --url=...');
    const out = resolve(plain[1]);
    mkdirSync(out, { recursive: true });
    const frames = await page.evaluate(async ([module, kinds]) => (await import(module)).elementLadderFrames(kinds), ['/src/lab/elementLadderSheet.ts', KINDS]);
    const numbers = [];
    for (const f of frames) {
      writeFileSync(join(out, `${f.name}.png`), Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'));
      const { png: _png, ...rest } = f;
      void _png;
      numbers.push(rest);
      console.log(`${f.name}: ${f.elements} elements; three drew ${f.triangles} triangles in ${f.drawCalls} draws`);
    }
    writeFileSync(join(out, 'frames.json'), JSON.stringify({ url, frames: numbers }, null, 1));
    console.log(`-> ${out}`);
  } else {
    const [, beforeArg, afterArg, outArg] = plain;
    if (!beforeArg || !afterArg || !outArg) throw new Error('usage: element-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...');
    const before = resolve(beforeArg), after = resolve(afterArg), out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    const framesOf = (dir) => new Map(JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')).frames.map((f) => [f.name, f]));
    const a = framesOf(before), b = framesOf(after);
    const rows = [];
    for (const name of [...a.keys()].filter((n) => b.has(n))) {
      const fa = a.get(name), fb = b.get(name);
      const png = (dir) => `data:image/png;base64,${readFileSync(join(dir, `${name}.png`)).toString('base64')}`;
      const crops = fb.crops.filter((c, i, list) => list.findIndex((d) => d.x === c.x && d.y === c.y) === i)
        .map((c) => ({ x: c.x, y: c.y, size: c.px, label: `${name} at ${c.distance.toFixed(1)} m, ${c.px.toFixed(1)} px` }));
      const result = await page.evaluate(async ([module, x, y, c]) => (await import(module)).propLadderCompare(x, y, c), ['/src/lab/propLadderSheet.ts', png(before), png(after), crops]);
      writeFileSync(join(out, `${name}.png`), Buffer.from(result.sheet.slice(result.sheet.indexOf(',') + 1), 'base64'));
      const { sheet: _sheet, ...numbers } = result;
      void _sheet;
      rows.push({ name, before: { triangles: fa.triangles, drawCalls: fa.drawCalls, meshes: fa.meshes }, after: { triangles: fb.triangles, drawCalls: fb.drawCalls, meshes: fb.meshes }, ...numbers });
      console.log(`${name}: triangles ${fa.triangles} -> ${fb.triangles}, draws ${fa.drawCalls} -> ${fb.drawCalls}; pixels over 8/255 ${(numbers.changed8 * 100).toFixed(3)} %, over 32/255 ${(numbers.changed32 * 100).toFixed(3)} %, largest ${numbers.largest}`);
    }
    writeFileSync(join(out, 'metrics.json'), JSON.stringify(rows, null, 1));
    const lines = ['| Frame | Triangles | Draws | Pixels over 8/255 | Pixels over 32/255 | Largest | Mean | Sheet |', '|---|---|---|---|---|---|---|---|'];
    for (const r of rows) {
      lines.push(`| ${r.name} | ${r.before.triangles} → ${r.after.triangles} | ${r.before.drawCalls} → ${r.after.drawCalls} | ${(r.changed8 * 100).toFixed(3)} % | ${(r.changed32 * 100).toFixed(3)} % | ${r.largest} | ${r.mean.toFixed(3)} | [sheet](${r.name}.png) |`);
    }
    writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
    console.log(`-> ${out}`);
  }
} finally {
  await browser.close();
}
