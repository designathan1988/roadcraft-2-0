// Code graph indexer: TypeScript compiler API -> SQLite.
// Tables: fn (every function-like declaration), call (resolved caller -> callee edges), ext (unresolved / library calls),
// fact (cost patterns found in a function: allocations, GPU uploads, scene traversals, sorts, sync GL reads), each with loop depth.
// call.via: 'direct', 'interface' (resolved through an interface member's implementations) or 'deferred' (a callback stored to run later:
// a promise's then, a timer, an idle callback, an event or message handler, a job handed to a queue); the frame's "hot" walk does not
// follow deferred edges. call.guarded / ext.guarded: 1 when the call runs only under a condition of its function (if, ?:, &&, ||, ??,
// ?., a switch case, a catch, a loop's body, or after an early return), 0 when it runs every time the function does.
// GPU facts of three.js are found by the resolved declaration (the library's own types), not by the method's name.
// usage (from the repository's root): node scripts/codegraph/index.cjs . reports/codegraph/code.db
// Needs Node 22.13+ (node:sqlite without a flag) and the project's own `typescript` (node_modules).
const ts = require('typescript');
const path = require('path');
const fs = require('fs');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  console.error(`node:sqlite is not available in Node ${process.version}: use Node 22.13 or newer (or run with --experimental-sqlite on 22.5-22.12).`);
  throw error;
}

const root = path.resolve(process.argv[2]);
const dbFile = path.resolve(process.argv[3]);
const cfgPath = path.join(root, 'tsconfig.json');
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
const options = { ...parsed.options, types: [], noEmit: true, skipLibCheck: true };
// TypeScript gives every path with forward slashes, on Windows too.
const slash = (f) => f.replace(/\\/g, '/');
// Windows paths compare without case (a drive letter may come either way).
const same = (f) => (process.platform === 'win32' ? slash(f).toLowerCase() : slash(f));
const srcDir = `${same(root).replace(/\/$/, '')}/src/`;
const files = parsed.fileNames.filter((f) => same(f).startsWith(srcDir) && (!f.endsWith('.d.ts') || f.endsWith('globals.d.ts')));
if (files.length === 0) throw new Error(`no source file under ${srcDir}: run from the repository's root with "."`);
const fileSet = new Set(files);
const t0 = Date.now();
const program = ts.createProgram(files, options);
const checker = program.getTypeChecker();
console.error(`program: ${files.length} files in ${Date.now() - t0} ms`);

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
const db = new DatabaseSync(dbFile);
db.exec(`
CREATE TABLE fn (id INTEGER PRIMARY KEY, name TEXT, qual TEXT, file TEXT, line INTEGER, end_line INTEGER, loc INTEGER, kind TEXT);
CREATE TABLE call (caller INTEGER, callee INTEGER, line INTEGER, loop INTEGER, via TEXT, guarded INTEGER);
CREATE TABLE ext (caller INTEGER, text TEXT, line INTEGER, loop INTEGER, guarded INTEGER);
CREATE TABLE fact (fn INTEGER, kind TEXT, detail TEXT, line INTEGER, loop INTEGER);
`);
db.exec('BEGIN');
const insFn = db.prepare('INSERT INTO fn VALUES (?,?,?,?,?,?,?,?)');
const insCall = db.prepare('INSERT INTO call VALUES (?,?,?,?,?,?)');
const insExt = db.prepare('INSERT INTO ext VALUES (?,?,?,?,?)');
const insFact = db.prepare('INSERT INTO fact VALUES (?,?,?,?,?)');

const isFnLike = (n) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);
const rel = (f) => slash(path.relative(root, f));
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

/** A readable name for a function-like node, and its owner chain. */
function nameOf(n) {
  if (n.name && ts.isIdentifier(n.name)) return n.name.text;
  if (n.name && (ts.isStringLiteral(n.name) || ts.isPrivateIdentifier(n.name))) return n.name.text;
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  const p = n.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p)) return p.name.getText();
  if (p && ts.isPropertyDeclaration(p)) return p.name.getText();
  if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left.getText().slice(0, 60);
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression.getText();
    return `cb:${callee.length > 40 ? callee.slice(-40) : callee}`;
  }
  return '<anon>';
}
function ownerOf(n) {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p.name ? p.name.text : '<class>';
    if (isFnLike(p)) return nameOf(p);
  }
  return '';
}

const ids = new Map(); // node -> id
let nextId = 1;
const fnNodes = [];
for (const sf of program.getSourceFiles()) {
  if (!fileSet.has(sf.fileName)) continue;
  const visit = (n) => {
    if (isFnLike(n) && n.body) {
      const id = nextId++;
      ids.set(n, id);
      fnNodes.push(n);
      const name = nameOf(n), owner = ownerOf(n);
      const l0 = lineOf(sf, n.getStart(sf)), l1 = lineOf(sf, n.end);
      insFn.run(id, name, owner ? `${owner}.${name}` : name, rel(sf.fileName), l0, l1, l1 - l0 + 1, ts.SyntaxKind[n.kind]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
console.error(`functions: ${fnNodes.length}`);

/** Implementations of interface/type members: object literals typed by an interface, classes implementing one. member decl -> fn ids */
const impls = new Map();
const addImpl = (memberDecl, fnId) => { if (!impls.has(memberDecl)) impls.set(memberDecl, new Set()); impls.get(memberDecl).add(fnId); };
const fnIdOfValue = (v) => {
  if (!v) return null;
  if (isFnLike(v)) return ids.get(v) ?? null;
  return null;
};
for (const sf of program.getSourceFiles()) {
  if (!fileSet.has(sf.fileName)) continue;
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      const ctx = checker.getContextualType(n);
      if (ctx) {
        for (const prop of n.properties) {
          const pname = prop.name && prop.name.getText ? prop.name.getText() : null;
          if (!pname) continue;
          const fid = ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) ? ids.get(prop) : ts.isPropertyAssignment(prop) ? fnIdOfValue(prop.initializer) : null;
          if (!fid) continue;
          const types = ctx.isUnion() ? ctx.types : [ctx];
          for (const t of types) {
            const member = t.getProperty(pname);
            for (const d of member?.declarations ?? []) addImpl(d, fid);
          }
        }
      }
    }
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      const t = checker.getTypeAtLocation(n);
      const bases = [];
      for (const h of n.heritageClauses ?? []) for (const e of h.types) bases.push(checker.getTypeAtLocation(e));
      for (const m of n.members) {
        if (!(ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) || !m.name || !ids.get(m)) continue;
        const pname = m.name.getText();
        for (const b of bases) for (const d of b.getProperty(pname)?.declarations ?? []) addImpl(d, ids.get(m));
      }
      void t;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
console.error(`interface members with implementations: ${impls.size}`);

/** three.js's own declarations (its types package or its sources). */
const THREE_DECL = /\/node_modules\/(@types\/three|three)\//;
/** The function ids a callee expression resolves to, and whether it is three.js's own. */
function resolve(expr) {
  const at = ts.isPropertyAccessExpression(expr) ? expr.name : ts.isElementAccessExpression(expr) ? expr.argumentExpression : expr;
  let sym = checker.getSymbolAtLocation(at);
  if (!sym) return { ids: [], via: null, three: false };
  if (sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* unresolved alias */ } }
  const out = new Set();
  let via = 'direct';
  const three = (sym.declarations ?? []).some((d) => THREE_DECL.test(slash(d.getSourceFile().fileName)));
  for (const d of sym.declarations ?? []) {
    if (ids.has(d)) out.add(ids.get(d));
    else if ((ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer && ids.has(d.initializer)) out.add(ids.get(d.initializer));
    if (impls.has(d)) { for (const i of impls.get(d)) out.add(i); via = 'interface'; }
  }
  return { ids: [...out], via, three };
}

const ITER = new Set(['forEach', 'map', 'filter', 'reduce', 'some', 'every', 'find', 'findIndex', 'flatMap', 'sort']);
/** Loop depth of a node inside its function: syntactic loops and array-iteration callbacks. */
function loopDepth(n, fn) {
  let d = 0;
  for (let p = n.parent; p && p !== fn; p = p.parent) {
    if (ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) d++;
    if (isFnLike(p) && p.parent && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression) && ITER.has(p.parent.expression.name.text)) d++;
  }
  return d;
}

// WebGL's own uploads, matched by name (their names are WebGL2RenderingContext's alone).
const GPU_CALLS = new Set(['bufferSubData', 'bufferData', 'texSubImage2D', 'texImage2D', 'texImage3D', 'texSubImage3D', 'copyBufferSubData', 'compressedTexImage2D', 'compressedTexSubImage2D']);
// three.js calls that cost GPU work or a program compile, matched only when the call resolves to three's declaration.
const THREE_GPU_CALLS = new Set(['render', 'compile', 'compileAsync', 'initTexture', 'initRenderTarget', 'setRenderTarget', 'readRenderTargetPixels', 'readRenderTargetPixelsAsync', 'copyTextureToTexture', 'copyFramebufferToTexture', 'addUpdateRange']);

// Callbacks stored to run later: handed to these calls, assigned to an on* handler, or a member of an object literal handed to a queue.
const DEFER_CALLS = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'requestIdleCallback', 'requestAnimationFrame', 'queueMicrotask', 'addEventListener']);
const QUEUE_CALL = /^(submit|submitJob|enqueue|schedule|post|postJob|request|queue|defer|later|idle|whenIdle)/i;
const calleeName = (e) => (ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : '');
/** Whether a function node is a stored callback (see above). */
function storedCallback(n) {
  let p = n.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  if (p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(n)) {
    const name = calleeName(p.expression);
    return DEFER_CALLS.has(name) || QUEUE_CALL.test(name);
  }
  if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n && ts.isPropertyAccessExpression(p.left)) return /^on[a-z]+$/.test(p.left.name.text);
  // a member of an object literal handed to a queue: { run() {...}, failed: () => ... }
  const member = ts.isMethodDeclaration(n) ? n : p && ts.isPropertyAssignment(p) && p.initializer === n ? p : null;
  if (member && member.parent && ts.isObjectLiteralExpression(member.parent)) {
    let q = member.parent.parent;
    while (q && ts.isParenthesizedExpression(q)) q = q.parent;
    if (q && ts.isCallExpression(q) && q.arguments.includes(member.parent)) return QUEUE_CALL.test(calleeName(q.expression));
  }
  return false;
}
const storedIds = new Set();
for (const n of fnNodes) if (storedCallback(n)) storedIds.add(ids.get(n));

/** Whether a node runs only under a condition of its function: a branch, a short circuit, a case, a catch, a loop's body, or after an early return. */
function guardedIn(n, fn) {
  for (let c = n, p = n.parent; p && c !== fn; c = p, p = p.parent) {
    if (ts.isIfStatement(p) && c !== p.expression) return 1;
    if (ts.isConditionalExpression(p) && c !== p.condition) return 1;
    if (ts.isBinaryExpression(p) && c === p.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(p.operatorToken.kind)) return 1;
    if (ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isCatchClause(p)) return 1;
    if ((ts.isCallExpression(p) || ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.questionDotToken && c !== p.expression) return 1;
    if ((ts.isWhileStatement(p) || ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p)) && c === p.statement) return 1;
    // an earlier statement of the same block that can leave the function or the loop (return, throw, break, continue under a branch)
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      for (const s of p.statements) {
        if (s === c) break;
        if (leavesEarly(s)) return 1;
      }
    }
  }
  return 0;
}
/** A statement holding a return, throw, break or continue under a branch (not inside a nested function). */
function leavesEarly(s) {
  let found = false;
  const visit = (n, branched) => {
    if (found || (isFnLike(n) && n !== s)) return;
    if (branched && (ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n))) { found = true; return; }
    const b = branched || ts.isIfStatement(n) || ts.isSwitchStatement(n) || ts.isTryStatement(n);
    ts.forEachChild(n, (k) => visit(k, b));
  };
  visit(s, false);
  return found;
}
/** Whether an expression's type is a three.js material (recompiles its program on needsUpdate) or texture (uploads). */
const isMaterialType = (t) => (t.isUnion() ? t.types.some(isMaterialType) : !!t.getProperty('isMaterial'));
const isTextureType = (t) => (t.isUnion() ? t.types.some(isTextureType) : !!t.getProperty('isTexture'));
const isAttributeType = (t) => (t.isUnion() ? t.types.some(isAttributeType) : !!(t.getProperty('isBufferAttribute') || t.getProperty('isInterleavedBuffer') || t.getProperty('isInterleavedBufferAttribute')));
const SYNC_CALLS = new Set(['getParameter', 'readPixels', 'getBufferSubData', 'getError', 'getProgramInfoLog', 'getShaderInfoLog', 'getProgramParameter', 'getQueryParameter', 'clientWaitSync', 'finish']);
const WALK_CALLS = new Set(['traverse', 'traverseVisible', 'traverseAncestors', 'updateMatrixWorld', 'updateWorldMatrix', 'computeBoundingBox', 'computeBoundingSphere', 'setFromObject']);
const ALLOC_NEW = /^(Map|Set|WeakMap|Array|Float32Array|Float64Array|Uint8Array|Uint16Array|Uint32Array|Int8Array|Int16Array|Int32Array|Vector2|Vector3|Vector4|Matrix3|Matrix4|Box3|Sphere|Color|Quaternion|Euler|Frustum|Plane|Ray|Object)$/;
const THREE_HEAVY_NEW = /(Material|Geometry|BufferAttribute|InterleavedBuffer|Texture|RenderTarget|Mesh|InstancedMesh|BatchedMesh|Group)$/;

for (const fn of fnNodes) {
  const id = ids.get(fn);
  const sf = fn.getSourceFile();
  const visit = (n) => {
    if (n !== fn && isFnLike(n)) {
      // a closure made inside: an allocation per run of the outer function
      insFact.run(id, 'closure', '', lineOf(sf, n.getStart(sf)), loopDepth(n, fn));
      return; // its own body is its own function
    }
    const line = () => lineOf(sf, n.getStart(sf));
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const e = n.expression;
      const loop = loopDepth(n, fn);
      if (ts.isNewExpression(n)) {
        const cname = e.getText().split('.').pop();
        if (ALLOC_NEW.test(cname)) insFact.run(id, 'alloc', `new ${cname}`, line(), loop);
        else if (THREE_HEAVY_NEW.test(cname)) insFact.run(id, 'gpu-object', `new ${cname}`, line(), loop);
      }
      const r = resolve(e);
      const guarded = guardedIn(n, fn);
      if (r.ids.length) for (const callee of r.ids) insCall.run(id, callee, line(), loop, storedIds.has(callee) ? 'deferred' : r.via, guarded);
      else insExt.run(id, e.getText().replace(/\s+/g, ' ').slice(0, 80), line(), loop, guarded);
      const member = calleeName(e);
      if (GPU_CALLS.has(member)) insFact.run(id, 'gpu', member, line(), loop);
      if (r.three && THREE_GPU_CALLS.has(member)) insFact.run(id, 'gpu', `three:${member}`, line(), loop);
      // a stored callback made here: an edge to it that the frame's walk does not follow
      for (const a of n.arguments ?? []) if (isFnLike(a) && storedIds.has(ids.get(a))) insCall.run(id, ids.get(a), lineOf(sf, a.getStart(sf)), loop, 'deferred', guarded);
      if (SYNC_CALLS.has(member) && (member !== 'finish' || /\bgl\b|context/i.test(e.getText()))) insFact.run(id, 'gl-sync', member, line(), loop);
      if (WALK_CALLS.has(member)) insFact.run(id, 'walk', member, line(), loop);
      if (member === 'sort') insFact.run(id, 'sort', e.getText().slice(0, 60), line(), loop);
      if (['map', 'filter', 'slice', 'concat', 'flatMap', 'flat', 'entries', 'keys', 'values', 'from', 'stringify', 'split', 'join'].includes(member) && ts.isPropertyAccessExpression(e)) {
        const obj = e.expression.getText();
        if (!(member === 'from' && obj !== 'Array') && !(['keys', 'values', 'entries'].includes(member) && obj !== 'Object')) insFact.run(id, 'alloc', `.${member}()`, line(), loop);
      }
    }
    if (ts.isArrayLiteralExpression(n)) insFact.run(id, 'alloc', n.elements.some(ts.isSpreadElement) ? '[...spread]' : '[]', line(), loopDepth(n, fn));
    if (ts.isObjectLiteralExpression(n)) insFact.run(id, 'alloc', n.properties.some(ts.isSpreadAssignment) ? '{...spread}' : '{}', line(), loopDepth(n, fn));
    if (ts.isTemplateExpression(n)) insFact.run(id, 'string', 'template', line(), loopDepth(n, fn));
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
      const prop = n.left.name.text;
      if ((prop === 'needsUpdate' || prop === 'needsPMREMUpdate') && n.right.kind === ts.SyntaxKind.TrueKeyword) {
        const t = checker.getTypeAtLocation(n.left.expression);
        const what = isMaterialType(t) ? 'material.needsUpdate=true (program recompiled)' : isTextureType(t) ? 'texture.needsUpdate=true (upload)' : isAttributeType(t) ? 'attribute.needsUpdate=true (upload)' : `${n.left.expression.getText().slice(-40)}.needsUpdate=true`;
        insFact.run(id, 'gpu', what, line(), loopDepth(n, fn));
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isFnLike(n.right) && storedIds.has(ids.get(n.right))) {
      insCall.run(id, ids.get(n.right), line(), loopDepth(n, fn), 'deferred', guardedIn(n, fn));
    }
    if (ts.isPostfixUnaryExpression(n) && ts.isPropertyAccessExpression(n.operand) && n.operand.name.text === 'version') insFact.run(id, 'gpu', 'version++', line(), loopDepth(n, fn));
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
}
db.exec('COMMIT');
db.exec(`CREATE INDEX call_caller ON call(caller); CREATE INDEX call_callee ON call(callee); CREATE INDEX fact_fn ON fact(fn); CREATE INDEX ext_caller ON ext(caller); CREATE INDEX fn_name ON fn(name);`);
const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
console.error(`done in ${Date.now() - t0} ms: fn ${count('fn')}, call ${count('call')}, ext ${count('ext')}, fact ${count('fact')}`);
