// Queries over the code graph built by index.cjs (Node 22.13+, no other dependency).
//
//   node scripts/codegraph/query.mjs hot     <db> <root> [--top 50] [--out reports/codegraph/hot.md]
//        what the root reaches (each frame, for the frame's root), ranked by the costly work it does, each with its chain of calls
//   node scripts/codegraph/query.mjs path    <db> <from> <to>      one chain of calls from one function to another
//   node scripts/codegraph/query.mjs callers <db> <fn>             who calls a function (one level)
//   node scripts/codegraph/query.mjs callees <db> <fn>             what a function calls (one level), resolved and not
//   node scripts/codegraph/query.mjs facts   <db> <fn>             the costly patterns found in a function
//   node scripts/codegraph/query.mjs sql     <db> "<select ...>"   any read-only query
//
// A function is named "file:qualified name" (src/main.ts:frame, src/render/renderer.ts:createSceneRenderer.draw) or by its
// qualified name alone when that is unique. The static graph says what CAN run; what DOES run comes from the runtime layer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadGraph } from './graph.mjs';

const [command, dbFile, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
const plain = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
if (!command || !dbFile) { console.error('usage: query.mjs <hot|path|callers|callees|facts|sql> <db> ...'); process.exit(2); }
const { all, label, find, reach, chain } = loadGraph(dbFile);

const WEIGHT = { gpu: 5, 'gl-sync': 8, walk: 4, 'gpu-object': 6, sort: 3, alloc: 1, closure: 1, string: 1 };

switch (command) {
  case 'hot': {
    const root = find(plain[0] ?? 'src/main.ts:frame');
    const top = Number(flag('top', '50'));
    const { heat, via } = reach([root]);
    const rows = [];
    for (const [f, h] of heat) {
      let score = 0; const hits = [];
      for (const x of all('SELECT kind, detail, line, loop FROM fact WHERE fn = ?', f)) {
        const depth = h + x.loop;
        // One allocation a run is noise; inside loops, and in functions called from loops, it multiplies.
        if (['alloc', 'closure', 'string'].includes(x.kind) && depth === 0) continue;
        const s = (WEIGHT[x.kind] ?? 0) * 4 ** Math.min(3, depth);
        if (s) { score += s; hits.push({ s, ...x, depth }); }
      }
      if (score) rows.push({ f, score, hits: hits.sort((a, b) => b.s - a.s).slice(0, 6) });
    }
    rows.sort((a, b) => b.score - a.score);
    const md = [`# What ${label(root)} can reach, ranked by costly work`, '',
      `${heat.size} functions reachable (static: what CAN run; join the runtime layer for what DOES).`, ''];
    for (const r of rows.slice(0, top)) {
      md.push(`## ${r.score} — ${label(r.f)} (reached under ${heat.get(r.f)} loop levels)`);
      md.push(`chain: ${chain(r.f, via)}`);
      for (const x of r.hits) md.push(`- ${x.kind} ${x.detail} at line ${x.line} (loop depth ${x.depth})`);
      md.push('');
    }
    const out = flag('out');
    if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, md.join('\n')); console.log(`written ${out}`); }
    else console.log(md.join('\n'));
    break;
  }
  case 'path': {
    const from = find(plain[0]), to = find(plain[1]);
    const { via } = reach([from], 0);
    console.log(via.has(to) ? chain(to, via, 64) : `no chain of calls from ${label(from)} to ${label(to)} in the graph`);
    break;
  }
  case 'callers': {
    const id = find(plain[0]);
    for (const c of all('SELECT caller, line, loop, via FROM call WHERE callee = ?', id)) console.log(`${label(c.caller)} line ${c.line}${c.loop ? ` (in a loop x${c.loop})` : ''}${c.via === 'interface' ? ' [through an interface]' : ''}`);
    break;
  }
  case 'callees': {
    const id = find(plain[0]);
    for (const c of all('SELECT callee, line, loop FROM call WHERE caller = ? ORDER BY line', id)) console.log(`line ${c.line}${c.loop ? ` loop x${c.loop}` : ''}: ${label(c.callee)}`);
    for (const c of all('SELECT text, line, loop FROM ext WHERE caller = ? ORDER BY line', id)) console.log(`line ${c.line}${c.loop ? ` loop x${c.loop}` : ''}: ${c.text} [not resolved: library or callback]`);
    break;
  }
  case 'facts': {
    const id = find(plain[0]);
    for (const x of all('SELECT kind, detail, line, loop FROM fact WHERE fn = ? ORDER BY line', id)) console.log(`line ${x.line} ${x.kind} ${x.detail}${x.loop ? ` (loop x${x.loop})` : ''}`);
    break;
  }
  case 'sql': {
    if (!/^\s*(select|with)\b/i.test(plain[0] ?? '')) throw new Error('sql takes a SELECT');
    console.table(all(plain[0]));
    break;
  }
  default:
    console.error(`unknown command ${command}`); process.exit(2);
}
