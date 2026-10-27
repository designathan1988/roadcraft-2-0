// The code graph loaded from the database `index.cjs` writes, shared by the queries (`query.mjs`), the diagnosis (`diagnosis.mjs`) and the
// permanent rules (`rules.mjs`): the functions, the edges a run follows (resolved calls and the callbacks run on the spot; deferred ones left
// out), the recursions (strongly connected components), what a root reaches and by which chain.
import { DatabaseSync } from 'node:sqlite';

export function loadGraph(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const fns = new Map(all('SELECT id, name, qual, file, line, end_line AS end, loc, kind FROM fn').map((f) => [f.id, f]));
  const label = (id) => { const f = fns.get(id); return `${f.qual} (${f.file}:${f.line})`; };

  /** A function from its name: "file:qual", or a qual unique in the code. */
  function find(spec) {
    const colon = spec.lastIndexOf(':');
    const hasFile = colon > 0 && /\.(ts|tsx|mts|js)$/.test(spec.slice(0, colon));
    const file = hasFile ? spec.slice(0, colon) : null, qual = hasFile ? spec.slice(colon + 1) : spec;
    let rows = file ? all('SELECT id FROM fn WHERE file = ? AND qual = ?', file, qual) : all('SELECT id FROM fn WHERE qual = ?', qual);
    if (!rows.length) rows = file ? all('SELECT id FROM fn WHERE file = ? AND name = ?', file, qual) : all('SELECT id FROM fn WHERE name = ?', qual);
    if (!rows.length) throw new Error(`no function "${spec}" in the graph`);
    if (rows.length > 1) {
      const list = rows.map((r) => `  ${fns.get(r.id).file}:${fns.get(r.id).qual} (line ${fns.get(r.id).line})`).join('\n');
      throw new Error(`"${spec}" names ${rows.length} functions; give one as file:qual:\n${list}`);
    }
    return rows[0].id;
  }

  // The edges: resolved calls, and the callbacks run on the spot (array iteration, scene walks) as calls of the function round them.
  // Handlers, timers, promises and jobs are NOT run on the spot: their edges are 'deferred' and the walk does not follow them.
  const edges = new Map();
  const edge = (from, to, loop, line, via) => { if (!edges.has(from)) edges.set(from, []); edges.get(from).push({ to, loop, line, via }); };
  for (const c of all("SELECT caller, callee, line, loop, via FROM call WHERE via <> 'deferred'")) edge(c.caller, c.callee, c.loop, c.line, c.via);
  const byFile = new Map();
  for (const f of fns.values()) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }
  const ON_THE_SPOT = /\.cb:.*(forEach|map|filter|reduce|some|every|find|findIndex|flatMap|sort|traverse|traverseVisible)$/;
  for (const list of byFile.values()) {
    list.sort((a, b) => a.line - b.line || b.end - a.end);
    const stack = [];
    for (const f of list) {
      while (stack.length && !(stack.at(-1).line <= f.line && f.end <= stack.at(-1).end)) stack.pop();
      if (stack.length && ON_THE_SPOT.test(f.qual)) edge(stack.at(-1).id, f.id, 1, f.line, 'callback');
      stack.push(f);
    }
  }

  /** Strongly connected components of the call graph (Tarjan, iterative): a recursion's functions share one component. */
  function components() {
    const index = new Map(), low = new Map(), comp = new Map(), stack = [], on = new Set();
    let next = 0, count = 0;
    for (const start of fns.keys()) {
      if (index.has(start)) continue;
      const work = [[start, 0]];
      index.set(start, next); low.set(start, next); next++; stack.push(start); on.add(start);
      while (work.length) {
        const top = work.at(-1);
        const [v, i] = top;
        const out = edges.get(v) ?? [];
        if (i < out.length) {
          top[1]++;
          const w = out[i].to;
          if (!index.has(w)) { index.set(w, next); low.set(w, next); next++; stack.push(w); on.add(w); work.push([w, 0]); }
          else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        } else {
          work.pop();
          if (work.length) { const u = work.at(-1)[0]; low.set(u, Math.min(low.get(u), low.get(v))); }
          if (low.get(v) === index.get(v)) {
            let w;
            do { w = stack.pop(); on.delete(w); comp.set(w, count); } while (w !== v);
            count++;
          }
        }
      }
    }
    return comp;
  }
  const comp = components();

  /** Everything reachable from the roots: the deepest loop nesting it is reached under (heat, capped) and the call it was reached by.
   *  `only`: a set of functions the walk may enter (those a run saw running), or null for the whole static graph. */
  function reach(roots, cap = 8, only = null) {
    const heat = new Map(roots.map((r) => [r, 0])), via = new Map(roots.map((r) => [r, null]));
    const work = roots.map((r) => [r, 0]);
    while (work.length) {
      const [f, h] = work.shift();
      if ((heat.get(f) ?? -1) > h) continue;
      for (const e of edges.get(f) ?? []) {
        if (only && !only.has(e.to)) continue;
        // a call inside a recursion (both ends in one component) adds no heat: a cycle counts once
        const nh = comp.get(f) === comp.get(e.to) ? h : Math.min(cap, h + e.loop);
        if ((heat.get(e.to) ?? -1) < nh) { heat.set(e.to, nh); via.set(e.to, { from: f, line: e.line }); work.push([e.to, nh]); }
      }
    }
    return { heat, via };
  }
  const chain = (id, via, most = 14) => {
    const out = [];
    for (let f = id; f !== null && f !== undefined && out.length < most; f = via.get(f)?.from) out.push(fns.get(f).qual);
    return out.reverse().join(' -> ');
  };
  return { db, all, fns, label, find, edges, comp, reach, chain };
}
