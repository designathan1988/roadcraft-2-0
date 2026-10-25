// THE BUILDING PARTS' LADDER SHEETS: a row of each small prop from a few metres to where it is under a pixel, the study's tower from its corners
// (its condensers on their walls, its plants on their balconies), and a district of nine towers at the detail and the facade level, drawn by the
// game's own part cells, batch, shells and materials at the screen's own size (1920 x 1080, a 35° view), on the development server's page
// (`src/lab/partLadderSheet.ts`); the page draws whatever checkout serves it: one tree's frames against another's.
//
// `node scripts/part-ladder-sheet.mjs shoot <out folder> --url=http://127.0.0.1:<port>/ [--kinds=acUnit,chair,...] [--no-town]`
//   writes `<out>/<frame>.png` and `<out>/frames.json` (three's draws and triangles of the frame and of the parts alone, the scene pass's GPU
//   time, where each part stands on the frame and its diagonal there in pixels).
// `node scripts/part-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...`
//   writes `<out>/<frame>.png`: before and after side by side, their difference pixel by pixel (the largest channel's, as red), and the parts
//   at the sizes the levels change at (a ladder) or the parts marked (the tower) enlarged 8 times, nearest pixel (`src/lab/propLadderSheet.ts`
//   propLadderCompare); `<out>/metrics.json` and `<out>/summary.md`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = args.filter((a) => !a.startsWith('--'));
const url = (flag('url') ?? 'http://127.0.0.1:5300/').replace(/\/?$/, '/');
const mode = plain[0];
if (!['shoot', 'compare'].includes(mode)) {
  console.error('usage: part-ladder-sheet.mjs shoot <out> --url=... [--kinds=...] [--no-town] | compare <before out> <after out> <out> --url=...');
  process.exit(2);
}
const KINDS = (flag('kinds') ?? 'acUnit,foliage,bush,chair,table,airer,dish,lounger,bike').split(',');
/** The sizes a ladder's levels change at (the picture under 48 px, entered under 40.8: `partCells.ts` levelAt) and round them: a part nearest each is enlarged. */
const SIZES = [96, 60, 48, 44, 40, 32, 24, 16, 8, 4, 2, 1.2];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  // The page's own errors; not the development server's reload socket, which a page served this way has none of.
  page.on('console', (m) => { if (m.type() === 'error' && !/\[vite\]|WebSocket|Vite server/.test(m.text())) console.error(`page: ${m.text()}`); });
  // An empty page of the server's origin: the game's modules load, the game does not start.
  await page.route(`${url}__parts/sheet.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>part ladder sheet</title><body></body>' }));
  await page.goto(`${url}__parts/sheet.html`);
  if (mode === 'shoot') {
    if (!plain[1]) throw new Error('usage: part-ladder-sheet.mjs shoot <out folder> --url=...');
    const out = resolve(plain[1]);
    mkdirSync(out, { recursive: true });
    const frames = await page.evaluate(async ([module, kinds, town]) => (await import(module)).partSheetFrames(kinds, town), ['/src/lab/partLadderSheet.ts', KINDS, !args.includes('--no-town')]);
    const numbers = [];
    for (const f of frames) {
      writeFileSync(join(out, `${f.name}.png`), Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'));
      const { png: _png, ...rest } = f;
      void _png;
      numbers.push(rest);
      console.log(`${f.name}: ${f.triangles} triangles in ${f.drawCalls} draws, the parts ${f.partTriangles} in ${f.partDraws}; scene pass ${f.gpu.median.toFixed(3)} ms (${f.gpu.samples} samples, ${f.gpu.label})`);
    }
    writeFileSync(join(out, 'frames.json'), JSON.stringify({ url, made: new Date().toISOString(), frames: numbers }, null, 1));
    console.log(`-> ${out}`);
  } else {
    const [, beforeArg, afterArg, outArg] = plain;
    if (!beforeArg || !afterArg || !outArg) throw new Error('usage: part-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...');
    const before = resolve(beforeArg), after = resolve(afterArg), out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    const framesOf = (dir) => new Map(JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')).frames.map((f) => [f.name, f]));
    const a = framesOf(before), b = framesOf(after);
    const rows = [];
    for (const name of [...a.keys()].filter((n) => b.has(n))) {
      const fa = a.get(name), fb = b.get(name);
      const png = (dir) => `data:image/png;base64,${readFileSync(join(dir, `${name}.png`)).toString('base64')}`;
      const label = (p) => `${p.label} at ${p.distance.toFixed(0)} m, ${p.px.toFixed(1)} px`;
      // A ladder: the part nearest each size; the tower: the parts it marked.
      const crops = KINDS.includes(name)
        ? SIZES.map((size) => {
          let best = null;
          for (const p of fb.props) if (!best || Math.abs(Math.log(p.px / size)) < Math.abs(Math.log(best.px / size))) best = p;
          return best ? { x: best.x, y: best.y, size, label: label(best) } : null;
        }).filter((c, i, list) => c && list.findIndex((d) => d && d.x === c.x && d.y === c.y) === i)
        : fb.props.map((p) => ({ x: p.x, y: p.y, size: p.px, label: label(p) }));
      const result = await page.evaluate(async ([module, x, y, c]) => (await import(module)).propLadderCompare(x, y, c), ['/src/lab/propLadderSheet.ts', png(before), png(after), crops]);
      writeFileSync(join(out, `${name}.png`), Buffer.from(result.sheet.slice(result.sheet.indexOf(',') + 1), 'base64'));
      const { sheet: _sheet, ...numbers } = result;
      void _sheet;
      const keep = (f) => ({ triangles: f.triangles, drawCalls: f.drawCalls, partTriangles: f.partTriangles, partDraws: f.partDraws, gpu: f.gpu, meshes: f.meshes });
      rows.push({ name, before: keep(fa), after: keep(fb), ...numbers });
      console.log(`${name}: parts' triangles ${fa.partTriangles} -> ${fb.partTriangles}, scene ${fa.triangles} -> ${fb.triangles}; scene pass ${fa.gpu.median.toFixed(3)} -> ${fb.gpu.median.toFixed(3)} ms; pixels over 8/255 ${(numbers.changed8 * 100).toFixed(3)} %, largest ${numbers.largest}`);
    }
    writeFileSync(join(out, 'metrics.json'), JSON.stringify(rows, null, 1));
    const ms = (g) => `${g.median.toFixed(3)} (${g.p10.toFixed(3)}–${g.p90.toFixed(3)})`;
    const lines = [
      '| Frame | Parts\' triangles | Parts\' draws | Scene triangles | Scene draws | Scene pass GPU ms, median (p10–p90) | Pixels over 8/255 | Pixels over 32/255 | Largest | Sheet |',
      '|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const r of rows) {
      lines.push(`| ${r.name} | ${r.before.partTriangles} → ${r.after.partTriangles} | ${r.before.partDraws} → ${r.after.partDraws} | ${r.before.triangles} → ${r.after.triangles} | ${r.before.drawCalls} → ${r.after.drawCalls} | ${ms(r.before.gpu)} → ${ms(r.after.gpu)} | ${(r.changed8 * 100).toFixed(3)} % | ${(r.changed32 * 100).toFixed(3)} % | ${r.largest} | [sheet](${r.name}.png) |`);
    }
    writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
    console.log(`-> ${out}`);
  }
} finally {
  await browser.close();
}
