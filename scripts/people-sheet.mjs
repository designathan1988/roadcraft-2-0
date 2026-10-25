// THE PEOPLE'S SHEETS: each cooked person of a folder (`<id>.bin` and its atlas) drawn by the game's own reader and material on the
// development server's page (`src/lab/peopleSheet.ts`): every level of detail rendered and as wireframe, body and head, and the impostor.
// The files are handed to the page from the folder given, whatever checkout they come from: the same sheet draws a commit's people and another's.
//
// `node scripts/people-sheet.mjs <people folder> <out folder> --url=http://127.0.0.1:<port>/ [--ids=female-child-casual,male-child-casual] [--yaw=<degrees>]`
//   (`--yaw`: the view's angle off the front, 0 the front, 25 by default; `--views=<json file>`: single pictures instead, see below)
//   writes `<out>/<id>.png`, `<out>/sheets.json` (the numbers) and `<out>/summary.md` (a table: triangles a level, vertices, bytes).
// `node scripts/people-sheet.mjs compare <before out> <after out> <out folder> --url=... [--map=<json>]`
//   (`--map`: a JSON file of before id -> after id, for bodies renamed between the two)
//   writes `<out>/<id>-before-after.png`: the two sheets one above the other, labelled, and `<out>/comparison.md`.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const plain = args.filter((a) => !a.startsWith('--'));
const url = (flag('url') ?? 'http://127.0.0.1:5300/').replace(/\/?$/, '/');
const compare = plain[0] === 'compare';

/** A cooked file's header (`cookedPerson.ts` packCookedPerson): four bytes of length, then JSON. */
function headerOf(path) {
  const bytes = readFileSync(path);
  const length = bytes.readUInt32LE(0);
  return JSON.parse(bytes.toString('utf8', 4, 4 + length));
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`page: ${m.text()}`); });
  // An empty page of the server's origin: the game's modules load, the game does not start.
  await page.route(`${url}__people/sheet.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>people sheet</title><body></body>' }));
  if (!compare) {
    const [folderArg, outArg] = plain;
    if (!folderArg || !outArg) throw new Error('usage: people-sheet.mjs <cooked people folder> <out folder> --url=...');
    const folder = resolve(folderArg), out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    await page.route(`${url}__people/files/**`, (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
      route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(join(folder, name)) });
    });
    await page.goto(`${url}__people/sheet.html`);
    const wanted = flag('ids')?.split(',');
    const ids = readdirSync(folder).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4)).filter((id) => !wanted || wanted.includes(id)).sort();
    const rows = [];
    // `--views=<json file>`: a list of `PersonView`s (`src/lab/peopleSheet.ts`: name, level, kind, yaw, pose, width, height, metresTall,
    // face), each drawn on its own and written as `<out>/<id>-<name>.png`, instead of the sheet.
    const viewsFile = flag('views');
    if (viewsFile) {
      const views = JSON.parse(readFileSync(resolve(viewsFile), 'utf8'));
      for (const id of ids) {
        const header = headerOf(join(folder, `${id}.bin`));
        const pngs = await page.evaluate(async ([module, bin, atlas, list]) => (await import(module)).personViews(bin, atlas, list),
          ['/src/lab/peopleSheet.ts', `/__people/files/${id}.bin`, `/__people/files/${header.atlas.file}`, views]);
        pngs.forEach((png, k) => writeFileSync(join(out, `${id}-${views[k].name}.png`), Buffer.from(png.slice(png.indexOf(',') + 1), 'base64')));
        console.log(`${id}: ${pngs.length} views`);
      }
      console.log(`-> ${out}`);
      await browser.close();
      process.exit(0);
    }
    for (const id of ids) {
      const header = headerOf(join(folder, `${id}.bin`));
      const result = await page.evaluate(async ([module, bin, atlas, yaw]) => (await import(module)).peopleSheet(bin, atlas, yaw),
        ['/src/lab/peopleSheet.ts', `/__people/files/${id}.bin`, `/__people/files/${header.atlas.file}`, Number(flag('yaw') ?? 25)]);
      writeFileSync(join(out, `${id}.png`), Buffer.from(result.png.slice(result.png.indexOf(',') + 1), 'base64'));
      const { png: _png, ...numbers } = result;
      void _png;
      rows.push({ ...numbers, binBytes: statSync(join(folder, `${id}.bin`)).size, atlasBytes: statSync(join(folder, header.atlas.file)).size });
      console.log(`${id}: ${result.levels.map((l) => l.triangles).join(' / ')} triangles, ${result.vertices} vertices`);
    }
    writeFileSync(join(out, 'sheets.json'), JSON.stringify({ folder, url, made: new Date().toISOString(), rows }, null, 1));
    const levels = Math.max(...rows.map((r) => r.levels.length));
    const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
    const lines = [
      `# People sheets: ${folder}`, '',
      `Columns of each sheet: ${Array.from({ length: levels }, (_, k) => `L${k}`).join(', ')}, impostor. Rows: rendered body, wireframe body, rendered head, wireframe head (the impostor's head rows: its strip of frames).`, '',
      `| Person | ${Array.from({ length: levels }, (_, k) => `L${k} triangles`).join(' | ')} | L0 error (% of height) | vertices | impostor | file bytes | atlas bytes |`,
      `|---|${'---|'.repeat(levels)}---|---|---|---|---|`,
      ...rows.map((r) => `| ${r.id} | ${Array.from({ length: levels }, (_, k) => r.levels[k]?.triangles ?? '').join(' | ')} | ${(r.levels[0].error * 100).toFixed(2)} | ${r.vertices} | ${r.impostor.frames} frames ${r.impostor.width}x${r.impostor.height} | ${r.binBytes} | ${r.atlasBytes} |`),
      `| **Total** | ${Array.from({ length: levels }, (_, k) => `**${sum((r) => r.levels[k]?.triangles ?? 0)}**`).join(' | ')} | | **${sum((r) => r.vertices)}** | | **${sum((r) => r.binBytes)}** | **${sum((r) => r.atlasBytes)}** |`,
    ];
    writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
    console.log(`-> ${out}`);
  } else {
    const [, beforeArg, afterArg, outArg] = plain;
    if (!beforeArg || !afterArg || !outArg) throw new Error('usage: people-sheet.mjs compare <before out> <after out> <out folder> --url=...');
    const before = resolve(beforeArg), after = resolve(afterArg), out = resolve(outArg);
    mkdirSync(out, { recursive: true });
    await page.goto(`${url}__people/sheet.html`);
    const rowsOf = (dir) => new Map(JSON.parse(readFileSync(join(dir, 'sheets.json'), 'utf8')).rows.map((r) => [r.id, r]));
    const a = rowsOf(before), b = rowsOf(after);
    const renamed = flag('map') ? JSON.parse(readFileSync(resolve(flag('map')), 'utf8')) : {};
    const afterId = (id) => renamed[id] ?? id;
    const lines = ['# People before and after', '', `Before: ${before}`, `After: ${after}`, '',
      '| Person | before L0 / L1 / L2 / L3 | after L0 / L1 / L2 / L3 | before vertices | after vertices |', '|---|---|---|---|---|'];
    for (const id of [...a.keys()].filter((k) => b.has(afterId(k))).sort()) {
      const label = (r) => `${r.levels.map((l) => l.triangles).join(' / ')} triangles, ${r.vertices} vertices`;
      const png = await page.evaluate(async ([top, bottom, topLabel, bottomLabel]) => {
        const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
        const [x, y] = await Promise.all([load(top), load(bottom)]);
        const band = 34;
        const c = document.createElement('canvas');
        c.width = Math.max(x.width, y.width);
        c.height = x.height + y.height + band * 2;
        const g = c.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#111'; g.font = 'bold 20px sans-serif';
        g.fillText(topLabel, 10, 24); g.drawImage(x, 0, band);
        g.fillText(bottomLabel, 10, band + x.height + 24); g.drawImage(y, 0, band * 2 + x.height);
        return c.toDataURL('image/png');
      }, [`data:image/png;base64,${readFileSync(join(before, `${id}.png`)).toString('base64')}`, `data:image/png;base64,${readFileSync(join(after, `${afterId(id)}.png`)).toString('base64')}`,
        `BEFORE ${id}: ${label(a.get(id))}`, `AFTER ${afterId(id)}: ${label(b.get(afterId(id)))}`]);
      writeFileSync(join(out, `${afterId(id)}-before-after.png`), Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
      lines.push(`| ${afterId(id)} | ${a.get(id).levels.map((l) => l.triangles).join(' / ')} | ${b.get(afterId(id)).levels.map((l) => l.triangles).join(' / ')} | ${a.get(id).vertices} | ${b.get(afterId(id)).vertices} |`);
    }
    writeFileSync(join(out, 'comparison.md'), `${lines.join('\n')}\n`);
    console.log(`-> ${out}`);
  }
} finally {
  await browser.close();
}
