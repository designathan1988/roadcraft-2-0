// THE STREET PROPS' LADDER SHEETS: a straight street with one kind of prop on its footway from a few metres to the horizon, drawn by the
// game's own street furniture layer with its own materials, lights and shadows, at the screen's own size (1920 x 1080, a 35° view), on the
// development server's page (`src/lab/propLadderSheet.ts`); the page draws whatever checkout serves it: one tree's frames against another's.
//
// `node scripts/prop-ladder-sheet.mjs shoot <out folder> --url=http://127.0.0.1:<port>/ [--kinds=bench,bin,...] [--reference]`
//   (`--reference`: every prop drawn by its model at every size, `src/lab/propLadderReference.ts`: the yardstick a ladder is measured against)
//   writes `<out>/<kind>.png` (each frame, and `all.png` with every kind) and `<out>/frames.json` (three's draws and triangles, the layer's
//   meshes drawn, where each prop stands on the frame and how many pixels a metre of it spans there).
// `node scripts/prop-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...`
//   writes `<out>/<kind>.png`: before and after side by side, their difference pixel by pixel (the largest channel's, as red), and the props
//   at the sizes the levels change at enlarged 8 times, nearest pixel, before, after and their difference; `<out>/metrics.json` and
//   `<out>/summary.md` (the share of pixels changed by more than 8 and 32 of 255, the largest and mean difference, the triangles and draws).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = args.filter((a) => !a.startsWith('--'));
const url = (flag('url') ?? 'http://127.0.0.1:5314/').replace(/\/?$/, '/');
const mode = plain[0];
if (!['shoot', 'compare', 'atlas', 'closeups', 'diagnose', 'holes'].includes(mode)) {
  console.error('usage: prop-ladder-sheet.mjs shoot <out> --url=... [--kinds=...] | compare <before out> <after out> <out> --url=...');
  process.exit(2);
}
const KINDS = (flag('kinds') ?? 'bench,bin,hydrant,postbox,phone,drain,lamp,tree').split(',');
/** The sizes the ladder's levels change at (`propLevels.ts`: 48, 16, 1.5 px) and between them: a prop nearest each is enlarged. */
const SIZES = [96, 48, 40, 24, 16, 12, 8, 4, 2, 1.5];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`page: ${m.text()}`); });
  // An empty page of the server's origin: the game's modules load, the game does not start.
  await page.route(`${url}__props/sheet.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>prop ladder sheet</title><body></body>' }));
  await page.goto(`${url}__props/sheet.html`);
  if (mode === 'holes') {
    // Every prop's model alone, close, from eight sides, below and inside, over magenta (`src/lab/propHoleSheet.ts`): `<out>/holes.png`.
    const out = resolve(plain[1] ?? '');
    mkdirSync(out, { recursive: true });
    const only = flag('kinds') ? flag('kinds').split(',') : [];
    const audit = await page.evaluate(async ([module, list]) => (await import(module)).propHoleAudit(list), ['/src/lab/propHoleSheet.ts', only]);
    writeFileSync(join(out, 'holes.png'), Buffer.from(audit.png.slice(audit.png.indexOf(',') + 1), 'base64'));
    writeFileSync(join(out, 'holes.txt'), audit.rows.join('\n'));
    console.log(audit.rows.join('\n'));
    console.log(`-> ${out}`);
  } else if (mode === 'diagnose') {
    // A prop's model and its picture's variants, their mean colours: `<out>/diagnose-<kind>-<px>.png` and the numbers.
    const out = resolve(plain[1] ?? '');
    mkdirSync(out, { recursive: true });
    for (const kind of KINDS) for (const px of (flag('sizes') ?? '96,24').split(',').map(Number)) {
      const d = await page.evaluate(async ([module, k, size]) => (await import(module)).propPictureDiagnosis(k, size), ['/src/lab/propLadderSheet.ts', kind, px]);
      writeFileSync(join(out, `diagnose-${kind}-${px}.png`), Buffer.from(d.png.slice(d.png.indexOf(',') + 1), 'base64'));
      console.log(d.rows.join('\n'));
    }
  } else if (mode === 'closeups') {
    // Each prop alone, its model then its picture, at each size and from three views: `<out>/closeups.png`.
    const out = resolve(plain[1] ?? '');
    mkdirSync(out, { recursive: true });
    const sizes = (flag('sizes') ?? '96,48,16,8').split(',').map(Number);
    const url2 = await page.evaluate(async ([module, list]) => (await import(module)).propPictureCloseups(list), ['/src/lab/propLadderSheet.ts', sizes]);
    writeFileSync(join(out, 'closeups.png'), Buffer.from(url2.slice(url2.indexOf(',') + 1), 'base64'));
    console.log(`-> ${out}`);
  } else if (mode === 'atlas') {
    // The props' pictures as taken: `<out>/atlas-colour.png`, `<out>/atlas-normal.png` (each: the stored values, then the cover in grey).
    const out = resolve(plain[1] ?? '');
    mkdirSync(out, { recursive: true });
    const atlas = await page.evaluate(async (module) => (await import(module)).propPicturesAtlas(), '/src/lab/propLadderSheet.ts');
    for (const name of ['colour', 'normal', 'colourMip3']) writeFileSync(join(out, `atlas-${name}.png`), Buffer.from(atlas[name].slice(atlas[name].indexOf(',') + 1), 'base64'));
    writeFileSync(join(out, 'atlas-modes.txt'), `${atlas.modes.join('\n')}\n`);
    console.log(atlas.modes.join('\n'));
    console.log(`-> ${out}`);
  } else if (mode === 'shoot') {
    if (!plain[1]) throw new Error('usage: prop-ladder-sheet.mjs shoot <out folder> --url=...');
    const out = resolve(plain[1]);
    mkdirSync(out, { recursive: true });
    const frames = await page.evaluate(async ([module, kinds, reference]) => (await import(module)).propLadderFrames(kinds, reference), ['/src/lab/propLadderSheet.ts', KINDS, args.includes('--reference')]);
    const numbers = [];
    for (const f of frames) {
      writeFileSync(join(out, `${f.name}.png`), Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'));
      const { png: _png, ...rest } = f;
      void _png;
      numbers.push(rest);
      console.log(`${f.name}: three drew ${f.triangles} triangles in ${f.drawCalls} draws; ${f.props.length} props`);
    }
    writeFileSync(join(out, 'frames.json'), JSON.stringify({ url, made: new Date().toISOString(), frames: numbers }, null, 1));
    console.log(`-> ${out}`);
  } else {
    const [, beforeArg, afterArg, outArg] = plain;
    if (!beforeArg || !afterArg || !outArg) throw new Error('usage: prop-ladder-sheet.mjs compare <before out> <after out> <out folder> --url=...');
    const before = resolve(beforeArg), after = resolve(afterArg), out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    const framesOf = (dir) => new Map(JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')).frames.map((f) => [f.name, f]));
    const a = framesOf(before), b = framesOf(after);
    const rows = [];
    for (const name of [...a.keys()].filter((n) => b.has(n))) {
      const fa = a.get(name), fb = b.get(name);
      const png = (dir) => `data:image/png;base64,${readFileSync(join(dir, `${name}.png`)).toString('base64')}`;
      // The prop nearest each size (a metre's pixels on the frame times its height: the bench and the bin 1.8 and 1.0 m, read off the frame).
      const crops = SIZES.map((size) => {
        let best = null;
        for (const p of fb.props) if (!best || Math.abs(Math.log(p.px / size)) < Math.abs(Math.log(best.px / size))) best = p;
        return best ? { x: best.x, y: best.y, size, label: `${name} at ${(best.distance).toFixed(0)} m, ${best.px.toFixed(1)} px` } : null;
      }).filter((c, i, list) => c && list.findIndex((d) => d && d.x === c.x && d.y === c.y) === i);
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
