import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** THE CODE GRAPH (`scripts/codegraph/index.cjs`, `query.mjs`) over a small sample (`_sample/src/sample.ts`): three's costly calls found by
 *  their resolved types, stored callbacks as deferred edges the frame's walk does not follow, each call's guard, a recursion's heat once. */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SAMPLE = join(ROOT, 'tests', 'codegraph', '_sample');
let dir = '';
let dbFile = '';
let db: InstanceType<typeof DatabaseSync>;

type Row = Record<string, unknown>;
const rows = (sql: string, ...args: (string | number)[]): Row[] => db.prepare(sql).all(...args) as Row[];
const query = (...args: string[]): string => execFileSync(process.execPath, [join(ROOT, 'scripts', 'codegraph', 'query.mjs'), args[0]!, dbFile, ...args.slice(1)], { encoding: 'utf8' });
const facts = (fn: string): string[] => rows("SELECT f.kind || ' ' || f.detail AS d FROM fact f JOIN fn ON fn.id = f.fn WHERE fn.name = ?", fn).map((r) => String(r['d']));
const callsOf = (caller: string, callee: string): Row[] =>
  rows('SELECT c.via, c.guarded FROM call c JOIN fn a ON a.id = c.caller JOIN fn b ON b.id = c.callee WHERE a.name = ? AND b.name = ?', caller, callee);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'codegraph-'));
  dbFile = join(dir, 'sample.db');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'codegraph', 'index.cjs'), SAMPLE, dbFile], { stdio: 'pipe' });
  db = new DatabaseSync(dbFile, { readOnly: true });
}, 60_000);
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the code graph', () => {
  it("marks three's costly calls by their resolved declaration, not by the method's name", () => {
    const got = facts('draw').filter((f) => f.startsWith('gpu'));
    expect(got).toContain('gpu three:render');
    expect(got).toContain('gpu three:compile');
    expect(got).toContain('gpu three:setRenderTarget');
    // one render in the function is three's, the other is ours (Painter.render): only one fact
    expect(got.filter((f) => f === 'gpu three:render')).toHaveLength(1);
  });

  it("tells a material's needsUpdate (a program recompiled) from a texture's (an upload)", () => {
    const got = facts('draw');
    expect(got).toContain('gpu material.needsUpdate=true (program recompiled)');
    expect(got).toContain('gpu texture.needsUpdate=true (upload)');
  });

  it('records stored callbacks as deferred edges, and the walk from a root does not follow them', () => {
    expect(callsOf('cb:setTimeout', 'deferredWork')).toHaveLength(1);
    expect(rows("SELECT COUNT(*) AS n FROM call c JOIN fn b ON b.id = c.callee WHERE b.name IN ('cb:setTimeout', 'thenWork') AND c.via = 'deferred'")[0]!['n']).toBe(2);
    expect(query('path', 'src/sample.ts:draw', 'src/sample.ts:deferredWork')).toMatch(/no chain of calls/);
    expect(query('path', 'src/sample.ts:draw', 'src/sample.ts:later')).toMatch(/draw -> later/);
  });

  it('marks a call guarded under a branch or after an early return, and unguarded otherwise', () => {
    expect(callsOf('draw', 'helper').map((r) => r['guarded'])).toEqual([1]);
    expect(callsOf('draw', 'later').map((r) => r['guarded'])).toEqual([0]);
    expect(callsOf('early', 'helper').map((r) => r['guarded'])).toEqual([1]);
  });

  it("counts a recursion's heat once: the leaf under a cycle is not multiplied by its turns", () => {
    const md = query('hot', 'src/sample.ts:entry');
    const leaf = /## \d+ — leaf \(src\/sample\.ts:\d+\) \(reached under (\d+) loop levels\)/.exec(md);
    expect(leaf).not.toBeNull();
    expect(Number(leaf![1])).toBe(0);
  });
});
