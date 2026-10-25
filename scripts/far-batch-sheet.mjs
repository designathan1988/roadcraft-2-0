/* global document, Image */
// THE FAR BATCH'S SHEETS: the study's tower's facade cell as the town draws it from afar - its shell and the town's far batch of parts
// (`src/render/buildings/farParts.ts`) - with the game's own materials, on the development server's page (`src/lab/farBatchSheet.ts`), at the
// screen's own size (1920 x 1080, a 35° view) from each distance asked. The page draws whatever checkout serves it: one tree's frames against
// another's.
//
// `node scripts/far-batch-sheet.mjs shoot <out folder> --url=http://127.0.0.1:<port>/ [--distances=150,300,600,1200]`
//   writes `<out>/<distance>.png` (each frame) and `<out>/frames.json` (what the batch said it draws, three's draws and triangles of it).
// `node scripts/far-batch-sheet.mjs compare <before out> <after out> <out folder> --url=...`
//   writes `<out>/<distance>.png`: the two frames side by side, their difference pixel by pixel (the largest of the three channels' differences,
//   as red), and the window that changed most and the tower's middle each enlarged 8 times, nearest pixel, before and after; `<out>/metrics.json`
//   and `<out>/summary.md` (the share of pixels changed by more than 8 and 32 of 255, the largest and mean difference, the triangles).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = args.filter((a) => !a.startsWith('--'));
const url = (flag('url') ?? 'http://127.0.0.1:5300/').replace(/\/?$/, '/');
const mode = plain[0];
if (mode !== 'shoot' && mode !== 'compare') {
  console.error('usage: far-batch-sheet.mjs shoot <out> --url=... [--distances=...] | compare <before out> <after out> <out> --url=...');
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`page: ${m.text()}`); });
  // An empty page of the server's origin: the game's modules load, the game does not start.
  await page.route(`${url}__farbatch/sheet.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>far batch sheet</title><body></body>' }));
  await page.goto(`${url}__farbatch/sheet.html`);
  if (mode === 'shoot') {
    const out = resolve(plain[1] ?? '');
    if (!plain[1]) throw new Error('usage: far-batch-sheet.mjs shoot <out folder> --url=...');
    mkdirSync(out, { recursive: true });
    const distances = (flag('distances') ?? '150,300,600,1200').split(',').map(Number);
    const frames = await page.evaluate(async ([module, list]) => (await import(module)).farBatchFrames(list), ['/src/lab/farBatchSheet.ts', distances]);
    const numbers = [];
    for (const f of frames) {
      writeFileSync(join(out, `${f.distance}.png`), Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'));
      const { png: _png, ...rest } = f;
      void _png;
      numbers.push(rest);
      console.log(`${f.distance} m: the batch says ${f.batchTriangles} triangles of the cell; three drew ${f.triangles} triangles in ${f.drawCalls} draws`);
    }
    writeFileSync(join(out, 'frames.json'), JSON.stringify({ url, made: new Date().toISOString(), frames: numbers }, null, 1));
    console.log(`-> ${out}`);
  } else {
    const [, beforeArg, afterArg, outArg] = plain;
    if (!beforeArg || !afterArg || !outArg) throw new Error('usage: far-batch-sheet.mjs compare <before out> <after out> <out folder> --url=...');
    const before = resolve(beforeArg), after = resolve(afterArg), out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    const framesOf = (dir) => new Map(JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')).frames.map((f) => [f.distance, f]));
    const a = framesOf(before), b = framesOf(after);
    const rows = [];
    for (const distance of [...a.keys()].filter((d) => b.has(d))) {
      const fa = a.get(distance), fb = b.get(distance);
      const result = await page.evaluate(async ([x, y, centre, labels]) => {
        const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
        const [ia, ib] = await Promise.all([load(x), load(y)]);
        const w = ia.width, h = ia.height;
        const pixels = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
        const pa = pixels(ia), pb = pixels(ib);
        // Each pixel's difference: the largest of its three channels'.
        const diff = new Uint8Array(w * h);
        let over8 = 0, over32 = 0, most = 0, sum = 0;
        for (let i = 0; i < w * h; i++) {
          const d = Math.max(Math.abs(pa[i * 4] - pb[i * 4]), Math.abs(pa[i * 4 + 1] - pb[i * 4 + 1]), Math.abs(pa[i * 4 + 2] - pb[i * 4 + 2]));
          diff[i] = d; sum += d; if (d > 8) over8++; if (d > 32) over32++; if (d > most) most = d;
        }
        // The window that changed most (its sum of differences), by the summed-area table.
        const cw = 120, ch = 68;
        const table = new Float64Array((w + 1) * (h + 1));
        for (let y0 = 0; y0 < h; y0++) for (let x0 = 0; x0 < w; x0++) table[(y0 + 1) * (w + 1) + x0 + 1] = diff[y0 * w + x0] + table[y0 * (w + 1) + x0 + 1] + table[(y0 + 1) * (w + 1) + x0] - table[y0 * (w + 1) + x0];
        let best = -1, bx = 0, by = 0;
        for (let y0 = 0; y0 + ch <= h; y0 += 4) for (let x0 = 0; x0 + cw <= w; x0 += 4) {
          const s = table[(y0 + ch) * (w + 1) + x0 + cw] - table[y0 * (w + 1) + x0 + cw] - table[(y0 + ch) * (w + 1) + x0] + table[y0 * (w + 1) + x0];
          if (s > best) { best = s; bx = x0; by = y0; }
        }
        const cx = Math.min(Math.max(centre[0] - cw / 2, 0), w - cw), cy = Math.min(Math.max(centre[1] - ch / 2, 0), h - ch);
        // The sheet: the frames at half size, the difference, and the two windows enlarged 8 times.
        const half = [w / 2, h / 2], band = 30, zoom = 8;
        const sheet = document.createElement('canvas');
        sheet.width = w; sheet.height = band * 4 + half[1] * 2 + ch * zoom * 2;
        const g = sheet.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, sheet.width, sheet.height);
        g.fillStyle = '#111111'; g.font = 'bold 18px sans-serif';
        let top = 0;
        g.fillText(`BEFORE ${labels[0]}`, 8, top + 21); g.fillText(`AFTER ${labels[1]}`, half[0] + 8, top + 21); top += band;
        g.drawImage(ia, 0, top, half[0], half[1]); g.drawImage(ib, half[0], top, half[0], half[1]); top += half[1];
        const heat = document.createElement('canvas'); heat.width = w; heat.height = h;
        const hg = heat.getContext('2d'); const hd = hg.createImageData(w, h);
        for (let i = 0; i < w * h; i++) { const d = Math.min(255, diff[i] * 4); hd.data[i * 4] = 255; hd.data[i * 4 + 1] = 255 - d; hd.data[i * 4 + 2] = 255 - d; hd.data[i * 4 + 3] = 255; }
        hg.putImageData(hd, 0, 0);
        g.fillText(`difference (x4, red): ${(over8 / (w * h) * 100).toFixed(3)} % of pixels over 8/255, ${(over32 / (w * h) * 100).toFixed(3)} % over 32/255, largest ${most}, mean ${(sum / (w * h)).toFixed(3)}`, 8, top + 21); top += band;
        g.drawImage(heat, 0, top, half[0], half[1]);
        g.strokeStyle = '#0060ff'; g.lineWidth = 2;
        g.strokeRect(bx / 2, top + by / 2, cw / 2, ch / 2); g.strokeRect(cx / 2, top + cy / 2, cw / 2, ch / 2);
        top += half[1];
        g.imageSmoothingEnabled = false;
        g.fillText(`where it changed most (${bx}, ${by}), 8x: before | after`, 8, top + 21); top += band;
        g.drawImage(ia, bx, by, cw, ch, 0, top, cw * zoom, ch * zoom); g.drawImage(ib, bx, by, cw, ch, half[0], top, cw * zoom, ch * zoom); top += ch * zoom;
        g.fillText(`the tower's middle (${cx}, ${cy}), 8x: before | after`, 8, top + 21); top += band;
        g.drawImage(ia, cx, cy, cw, ch, 0, top, cw * zoom, ch * zoom); g.drawImage(ib, cx, cy, cw, ch, half[0], top, cw * zoom, ch * zoom);
        return { png: sheet.toDataURL('image/png'), over8: over8 / (w * h), over32: over32 / (w * h), most, mean: sum / (w * h), worst: [bx, by], centre: [cx, cy] };
      }, [`data:image/png;base64,${readFileSync(join(before, `${distance}.png`)).toString('base64')}`, `data:image/png;base64,${readFileSync(join(after, `${distance}.png`)).toString('base64')}`,
        fb.centre, [`${distance} m: ${fa.triangles} triangles in ${fa.drawCalls} draws of the batch`, `${distance} m: ${fb.triangles} triangles in ${fb.drawCalls} draws of the batch`]]);
      writeFileSync(join(out, `${distance}.png`), Buffer.from(result.png.slice(result.png.indexOf(',') + 1), 'base64'));
      const { png: _png, ...numbers } = result;
      void _png;
      rows.push({ distance, before: { batchTriangles: fa.batchTriangles, triangles: fa.triangles, drawCalls: fa.drawCalls }, after: { batchTriangles: fb.batchTriangles, triangles: fb.triangles, drawCalls: fb.drawCalls }, ...numbers });
      console.log(`${distance} m: ${(numbers.over8 * 100).toFixed(3)} % of pixels over 8/255, largest ${numbers.most}; triangles ${fa.triangles} -> ${fb.triangles}`);
    }
    writeFileSync(join(out, 'metrics.json'), JSON.stringify({ before, after, rows }, null, 1));
    const lines = ['# The far batch before and after', '', `Before: ${before}`, `After: ${after}`, '',
      '| Distance | three\'s triangles of the batch | draws | the batch\'s own count of the cell | pixels over 8/255 | over 32/255 | largest | mean |', '|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.distance} m | ${r.before.triangles} -> ${r.after.triangles} | ${r.before.drawCalls} -> ${r.after.drawCalls} | ${r.before.batchTriangles} -> ${r.after.batchTriangles} | ${(r.over8 * 100).toFixed(3)} % | ${(r.over32 * 100).toFixed(3)} % | ${r.most} | ${r.mean.toFixed(3)} |`)];
    writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
    console.log(`-> ${out}`);
  }
} finally {
  await browser.close();
}
