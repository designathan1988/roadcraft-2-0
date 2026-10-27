// THE CODE GRAPH'S PERMANENT RULES (`npm run verify`): the diagnosis's items c, d and e may only fall.
//
//   node scripts/codegraph/rules.mjs [--db reports/codegraph/code.db] [--ceil]
//
// Two counts for each rule, each with its ceiling in `scripts/codegraph/ceilings.json` (the value the day the rule was made):
//  static, from the code as it is now (the index is rebuilt here, ~7 s): what the frame CAN reach -
//   c: functions the frame reaches, outside the upload queue (`drainUploads`), that upload to the GPU;
//   d: functions the frame reaches that walk the scene or recompile a material;
//   e: functions the frame reaches with a loop over a whole-map collection (`doc.nodes`, `doc.segments`, `doc.buildings`, `doc.lotStore`,
//      `doc.poles`, `doc.trees`, `doc.zones`, `doc.people` walked in a for-of, forEach, map or filter);
//  runtime, from the last diagnosis (`reports/codegraph/diagnosis.json`, written by `diagnosis.mjs` after `runtime.mjs` ran the bench path):
//   what DID run during the drag (c, d) and what grew with the map (e). Stale until the runtime layer runs again: the static counts are the
//   ones that move with every change.
// `--ceil`: write today's counts as the ceilings (only when a count fell, or the day a rule is made).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from './graph.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const dbFile = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(ROOT, 'reports', 'codegraph', 'code.db');
const CEILINGS = join(ROOT, 'scripts', 'codegraph', 'ceilings.json');
const DIAGNOSIS = join(ROOT, 'reports', 'codegraph', 'diagnosis.json');

execFileSync(process.execPath, [join(ROOT, 'scripts', 'codegraph', 'index.cjs'), ROOT, dbFile], { stdio: ['ignore', 'ignore', 'pipe'] });
const g = loadGraph(dbFile);
const frame = g.find('src/main.ts:frame');
const reached = new Set(g.reach([frame]).heat.keys());
const underQueue = new Set(g.reach([g.find('src/render/uploads.ts:drainUploads')]).heat.keys());
const UPLOAD = /^(bufferSubData|bufferData|texSubImage2D|texImage2D|texImage3D|texSubImage3D|copyBufferSubData|compressedTex|three:addUpdateRange|three:initTexture|three:copyTextureToTexture|texture\.needsUpdate|attribute\.needsUpdate|version\+\+|.*\.needsUpdate=true$)/;
const withFact = (test) => new Set(g.all('SELECT fn, kind, detail FROM fact').filter(test).map((x) => x.fn));
const uploads = withFact((x) => x.kind === 'gpu' && UPLOAD.test(x.detail));
const walks = withFact((x) => x.kind === 'walk' || /program recompiled/.test(x.detail));
// whole-map loops: the document's collections walked in a function (read from the source text of the function's lines)
const WHOLE_MAP = /\b(?:doc|this\.doc|document)\.(nodes|segments|buildings|lotStore|poles|trees|zones|people|landscape|barriers)\b(?:\.values\(\)|\.keys\(\)|\.entries\(\))?\s*\)?\s*(?:\)|\.forEach|\.map|\.filter|\.reduce)|for\s*\(\s*const\s+[^)]*\s+of\s+(?:this\.)?doc\.(nodes|segments|buildings|lotStore|poles|trees|zones|people|landscape|barriers)\b/;
const sources = new Map();
const lines = (file) => { if (!sources.has(file)) sources.set(file, readFileSync(join(ROOT, file), 'utf8').split('\n')); return sources.get(file); };
const wholeMap = new Set();
for (const id of reached) {
  const f = g.fns.get(id);
  const body = lines(f.file).slice(f.line - 1, f.end).join('\n');
  if (WHOLE_MAP.test(body)) wholeMap.add(id);
}
const count = (set, extra = () => true) => [...set].filter((id) => reached.has(id) && extra(id)).length;
const now = {
  static: { c: count(uploads, (id) => !underQueue.has(id)), d: count(walks), e: wholeMap.size },
  runtime: existsSync(DIAGNOSIS) ? (({ c, d, e }) => ({ c: c.length, d: d.length, e: e.length }))(JSON.parse(readFileSync(DIAGNOSIS, 'utf8'))) : null,
};
if (args.includes('--ceil') || !existsSync(CEILINGS)) {
  writeFileSync(CEILINGS, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`ceilings written: ${JSON.stringify(now)}`);
  process.exit(0);
}
const ceil = JSON.parse(readFileSync(CEILINGS, 'utf8'));
let failed = false;
for (const kind of ['static', 'runtime']) {
  if (!now[kind] || !ceil[kind]) continue;
  for (const rule of ['c', 'd', 'e']) {
    const over = now[kind][rule] > ceil[kind][rule];
    if (over) failed = true;
    console.log(`${over ? 'FAIL' : 'ok  '} ${kind} ${rule}: ${now[kind][rule]} (ceiling ${ceil[kind][rule]})`);
  }
}
if (failed) {
  console.error('a code-graph rule went past its ceiling: the change added an upload outside the queue, a scene walk or recompile on the frame, or whole-map work');
  process.exit(1);
}
