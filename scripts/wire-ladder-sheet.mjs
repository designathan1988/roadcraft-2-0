// THE WIRES' LADDER SHEETS: two lines of poles strung with wires from a few metres to the horizon, drawn by the game's own pole layer with its
// own lights and shadow at the screen's own size (1920 x 1080, a 35° view), from the street and from the air, on the development server's page
// (`src/lab/wireLadderSheet.ts`); the page draws whatever checkout serves it: one tree's frames against another's.
//
// `node scripts/wire-ladder-sheet.mjs shoot <out folder> --url=http://127.0.0.1:<port>/`
//   writes `<out>/<view>.png` and `<out>/frames.json` (three's draws and triangles, the wires' meshes and triangles, each span's middle).
// `node scripts/wire-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...`
//   writes `<out>/<view>.png`: before and after side by side, their difference, and the spans at the sizes a wire's drawing changes at
//   enlarged 8 times (`src/lab/propLadderSheet.ts` propLadderCompare); `<out>/metrics.json`, `<out>/summary.md`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = args.filter((a) => !a.startsWith('--'));
const url = (flag('url') ?? 'http://127.0.0.1:5300/').replace(/\/?$/, '/');
const mode = plain[0];
if (mode !== 'shoot' && mode !== 'compare') {
  console.error('usage: wire-ladder-sheet.mjs shoot <out> --url=... | compare <before out> <after out> <out> --url=...');
  process.exit(2);
}
/** Pixels a metre spans where a wire's drawing changes (its 6.3 cm drawn width: 4 px, 1.5 px, a pixel, half, an eighth, a 32nd) and between. */
const SIZES = [63, 24, 16, 8, 4, 2, 1, 0.5];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`page: ${m.text()}`); });
  // An empty page of the server's origin: the game's modules load, the game does not start.
  await page.route(`${url}__wires/sheet.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>wire ladder sheet</title><body></body>' }));
  await page.goto(`${url}__wires/sheet.html`);
  if (mode === 'shoot') {
    if (!plain[1]) throw new Error('usage: wire-ladder-sheet.mjs shoot <out folder> --url=...');
    const out = resolve(plain[1]);
    mkdirSync(out, { recursive: true });
    const frames = await page.evaluate(async (module) => (await import(module)).wireLadderFrames(), '/src/lab/wireLadderSheet.ts');
    const numbers = [];
    for (const f of frames) {
      writeFileSync(join(out, `${f.name}.png`), Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'));
      const { png: _png, ...rest } = f;
      void _png;
      numbers.push(rest);
      console.log(`${f.name}: three drew ${f.triangles} triangles in ${f.drawCalls} draws; wires ${f.wireTriangles} triangles in ${f.wires.length} meshes${f.wireAreaTriangles === undefined ? '' : `, ${f.wireAreaTriangles} of them with an area (worked out)`}`);
    }
    writeFileSync(join(out, 'frames.json'), JSON.stringify({ url, made: new Date().toISOString(), frames: numbers }, null, 1));
    console.log(`-> ${out}`);
  } else {
    const [, beforeArg, afterArg, outArg] = plain;
    if (!beforeArg || !afterArg || !outArg) throw new Error('usage: wire-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...');
    const before = resolve(beforeArg), after = resolve(afterArg), out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    const framesOf = (dir) => new Map(JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')).frames.map((f) => [f.name, f]));
    const a = framesOf(before), b = framesOf(after);
    const rows = [];
    for (const name of [...a.keys()].filter((n) => b.has(n))) {
      const fa = a.get(name), fb = b.get(name);
      const png = (dir) => `data:image/png;base64,${readFileSync(join(dir, `${name}.png`)).toString('base64')}`;
      // The span nearest each size, by a metre's pixels at its middle.
      const crops = SIZES.map((size) => {
        let best = null;
        for (const p of fb.props) if (!best || Math.abs(Math.log(p.px / size)) < Math.abs(Math.log(best.px / size))) best = p;
        return best ? { x: best.x, y: best.y, size, label: `${name}: a span at ${best.distance.toFixed(0)} m, ${best.px.toFixed(1)} px a metre` } : null;
      }).filter((c, i, list) => c && list.findIndex((d) => d && d.x === c.x && d.y === c.y) === i);
      const result = await page.evaluate(async ([module, x, y, c]) => (await import(module)).propLadderCompare(x, y, c), ['/src/lab/propLadderSheet.ts', png(before), png(after), crops]);
      writeFileSync(join(out, `${name}.png`), Buffer.from(result.sheet.slice(result.sheet.indexOf(',') + 1), 'base64'));
      const { sheet: _sheet, ...numbers } = result;
      void _sheet;
      rows.push({ name, before: { triangles: fa.triangles, drawCalls: fa.drawCalls, wireTriangles: fa.wireTriangles }, after: { triangles: fb.triangles, drawCalls: fb.drawCalls, wireTriangles: fb.wireTriangles }, ...numbers });
      console.log(`${name}: wires ${fa.wireTriangles} -> ${fb.wireTriangles} triangles; all ${fa.triangles} -> ${fb.triangles}; pixels over 8/255 ${(numbers.changed8 * 100).toFixed(3)} %, largest ${numbers.largest}`);
    }
    writeFileSync(join(out, 'metrics.json'), JSON.stringify(rows, null, 1));
    const lines = ['| View | Wire triangles | All triangles | Draws | Pixels over 8/255 | Pixels over 32/255 | Largest | Mean | Sheet |', '|---|---|---|---|---|---|---|---|---|'];
    for (const r of rows) {
      lines.push(`| ${r.name} | ${r.before.wireTriangles} → ${r.after.wireTriangles} | ${r.before.triangles} → ${r.after.triangles} | ${r.before.drawCalls} → ${r.after.drawCalls} | ${(r.changed8 * 100).toFixed(3)} % | ${(r.changed32 * 100).toFixed(3)} % | ${r.largest} | ${r.mean.toFixed(3)} | [sheet](${r.name}.png) |`);
    }
    writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
    console.log(`-> ${out}`);
  }
} finally {
  await browser.close();
}
