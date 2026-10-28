#!/usr/bin/env node
// Builds a sample project in a temporary folder and checks every ledger command, gate and hook
// by feeding the hooks the same JSON Claude Code sends (code.claude.com/docs/en/hooks).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LEDGER = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "scripts", "ledger.mjs");
const SKILL_DIR = path.dirname(path.dirname(LEDGER)).replaceAll("\\", "/");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "whole-review-test-"));
const results = [];
const W = path.join(root, ".whole-review");

function run(args, { expectFail = false } = {}) {
  const r = spawnSync(process.execPath, [LEDGER, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  if (!expectFail && r.status !== 0) throw new Error(`ledger ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  if (expectFail && r.status === 0) throw new Error(`ledger ${args.join(" ")} should have failed: ${r.stdout}`);
  return r;
}

function hook(payload) {
  const r = spawnSync(process.execPath, [LEDGER, "hook", "--whole-review-hook"], {
    cwd: root, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: root, ...payload }), env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  if (r.status !== 0) throw new Error(`hook failed: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const ctx = (out) => out?.hookSpecificOutput?.additionalContext ?? "";
const decision = (out) => out?.hookSpecificOutput?.permissionDecision ?? "allow";
const state = () => JSON.parse(fs.readFileSync(path.join(W, "state.json"), "utf8"));
const abs = (rel) => path.join(root, rel);
const pause = () => new Promise((r) => setTimeout(r, 15));

function read(rel, startLine, numLines, extra = {}) {
  return hook({
    hook_event_name: "PostToolUse", tool_name: "Read", ...extra,
    tool_input: { file_path: abs(rel), offset: startLine, limit: numLines },
    tool_response: { type: "text", file: { filePath: abs(rel), content: "...", numLines, startLine, totalLines: 0 } },
  });
}
const viewImage = (rel) => hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: abs(rel) }, tool_response: { type: "image" } });
const fetchPage = (url, extra = {}) => hook({ hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url, prompt: "x" }, tool_response: { bytes: 10, code: 200, codeText: "OK", result: "...", durationMs: 5, url }, ...extra });
const search = (query, urls) => hook({ hook_event_name: "PostToolUse", tool_name: "WebSearch", tool_input: { query }, tool_response: { query, results: [{ tool_use_id: "t", content: urls.map((url) => ({ title: "t", url })) }] } });
const edit = (rel) => hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: abs(rel), old_string: "a", new_string: "b" }, tool_response: {} });
const preEdit = (rel, extra = {}) => hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: abs(rel) }, ...extra });
const preBash = (command, extra = {}) => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
const bashOk = (command) => hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false } });

function writeNote(rel, structure, { summary = `Summary line long enough for ${rel}`, sources = [] } = {}) {
  fs.mkdirSync(path.dirname(path.join(W, "notes", `${rel}.md`)), { recursive: true });
  fs.writeFileSync(path.join(W, "notes", `${rel}.md`), [
    `# ${rel}`, "Lines: x", `Summary: ${summary}`, "",
    "## Structure (every line range)", ...structure, "",
    "## Contracts, state and data flow", "- none beyond the structure", "",
    "## Depends on / used by", "- uses: src/a.ts", "",
    "## Problems found (finding IDs)", "- none", "",
    "## To check in other files", "- none", "",
    "## Sources", ...(sources.length ? sources.map((u) => `- ${u} settles the semantics used here`) : ["- none"]), "",
  ].join("\n"));
}

const findingsFile = () => path.join(W, "FINDINGS.md");
function setFindings(blocks) {
  const head = fs.readFileSync(findingsFile(), "utf8").split("\n### ")[0].trimEnd();
  fs.writeFileSync(findingsFile(), `${head}\n\n${blocks.join("\n\n")}\n`);
}

async function test(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message.split("\n").slice(0, 6).join(" | ")}`);
  }
}

// Reads a code file whole, researches it while reading, writes its note, and marks it done.
function studyCode(rel, lines, structure) {
  run(["note", rel]);
  read(rel, 1, lines);
  const url = `https://docs.example.org/${rel.replace(/\W+/g, "-")}`;
  fetchPage(url);
  writeNote(rel, structure, { sources: [url] });
  run(["done", rel]);
}

// ---- sample project ----
fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
fs.writeFileSync(abs("README.md"), "# Sample\nSpec: add returns the sum.\n");
fs.writeFileSync(abs("src/a.ts"), "export function add(a, b) {\n  return a - b;\n}\n");
fs.writeFileSync(abs("src/deep/big.txt"), `${Array.from({ length: 900 }, (_, i) => `row ${i + 1}`).join("\n")}\n`);
fs.writeFileSync(abs("src/long.js"), `const x = 1;\nconst s = "${"y".repeat(2500)}";\nconst z = 3;\n`);
fs.writeFileSync(abs("logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
fs.writeFileSync(abs("package-lock.json"), "{}\n");
fs.writeFileSync(abs("empty.md"), "");
fs.writeFileSync(abs("ignored.log"), "x\n");
fs.writeFileSync(abs(".gitignore"), "*.log\n");
fs.mkdirSync(abs(".claude"));
fs.writeFileSync(abs(".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }, null, 2));
execFileSync("git", ["init", "-q"], { cwd: root });

await test("init: git listing, instruction files first, binaries and lockfiles skipped, hooks and permissions installed", () => {
  const out = run(["init", "--mode", "fix", "--goal", "read all and fix", "--check", "npx tsc --noEmit"]).stdout;
  const s = state();
  assert.equal(s.order[0], "README.md");
  // .claude/settings.local.json is git-ignored by Claude Code itself, so git does not list it.
  assert.deepEqual([...s.order].filter((r) => r !== ".claude/settings.local.json").sort(), [".gitignore", "README.md", "empty.md", "logo.png", "package-lock.json", "src/a.ts", "src/deep/big.txt", "src/long.js"].sort());
  assert.equal(s.files["logo.png"].status, "skipped");
  assert.equal(s.files["src/deep/big.txt"].lines, 901);
  assert.deepEqual(s.files["src/long.js"].longLines, [2]);
  const settings = JSON.parse(fs.readFileSync(abs(".claude/settings.local.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(ls)"));
  assert.ok(settings.permissions.allow.some((r) => r.startsWith("Edit(//") && r.endsWith("/.whole-review/**)")));
  assert.equal(settings.hooks.Stop.length, 2);
  assert.match(settings.hooks.PostToolUse[0].matcher, /WebFetch\|WebSearch/);
  assert.match(settings.hooks.PreToolUse[0].matcher, /Bash\|PowerShell\|mcp__\.\*/);
  assert.match(out, /NEXT: Read README\.md with offset 1 and limit 2/);
  assert.match(out, /set-app --start/);
  if (s.order.includes(".claude/settings.local.json")) run(["skip", ".claude/settings.local.json", "--reason", "local tool settings written by this review"]);
});

await test("init refuses to discard a review in progress; install is idempotent", () => {
  run(["init"], { expectFail: true });
  run(["install"]);
  run(["install"]);
  const settings = JSON.parse(fs.readFileSync(abs(".claude/settings.local.json"), "utf8"));
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.Stop.length, 2);
});

await test("edits to project files are denied before phase fix, also for subagents; notes are allowed", () => {
  assert.equal(decision(preEdit("src/a.ts")), "deny");
  assert.equal(decision(preEdit("src/new-file.ts", { agent_id: "sub1" })), "deny");
  assert.equal(decision(preEdit(".whole-review/notes/src/a.ts.md")), "allow");
});

await test("nothing is run, tested or measured before phase apptest; reading commands and the static check are allowed", () => {
  for (const c of ["npm test", "node --test", "node src/a.ts", "npx vitest run", "npm run bench", "git status && rm -rf x", "git status | tail", "python app.py", "curl http://localhost:3000"]) {
    assert.equal(decision(preBash(c)), "deny", c);
  }
  for (const c of [`node "${SKILL_DIR}/scripts/ledger.mjs" status`, "git status", "git diff src/a.ts", "node --version", "npm ls three", "npx tsc --noEmit", `cd "${root}" && git log -3`, "ls src"]) {
    assert.equal(decision(preBash(c)), "allow", c);
  }
  assert.equal(decision(preBash("npm test", { agent_id: "sub1" })), "deny", "subagents too");
});

await test("browser automation MCP tools are denied (robotic gestures); other MCP tools are not", () => {
  for (const t of ["mcp__playwright__browser_click", "mcp__claude-in-chrome__computer", "mcp__Claude_Browser__navigate", "mcp__computer-use__left_click"]) {
    assert.equal(decision(hook({ hook_event_name: "PreToolUse", tool_name: t, tool_input: {} })), "deny", t);
  }
  assert.equal(decision(hook({ hook_event_name: "PreToolUse", tool_name: "mcp__github__get_issue", tool_input: {} })), "allow");
});

await test("reads by a subagent and reads outside the inventory do not count", () => {
  read("src/a.ts", 1, 4, { agent_id: "sub1" });
  assert.deepEqual(state().files["src/a.ts"].ranges, []);
  assert.equal(hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: path.join(os.tmpdir(), "x.txt") }, tool_response: { type: "text", file: { numLines: 3, startLine: 1 } } }), null);
});

await test("chunked reading is recorded; the hook asks for the note and the next chunk", () => {
  run(["note", "src/deep/big.txt"]);
  const out = ctx(read("src/deep/big.txt", 1, 400));
  assert.match(out, /lines \[\[1,400\]\] of 901/);
  assert.match(out, /offset 401, limit 400/);
  assert.doesNotMatch(out, /Research now/, "a data file is not code");
});

await test("the hook warns when the note falls behind; done refuses a gap", () => {
  assert.match(ctx(read("src/deep/big.txt", 401, 400)), /WARNING: the note describes lines 1-0 but lines 1-400 were read/);
  assert.match(run(["done", "src/deep/big.txt"], { expectFail: true }).stderr, /line 801 of 901 was never returned/);
});

await test("done refuses a note that does not describe every line range", () => {
  read("src/deep/big.txt", 801, 100);
  writeNote("src/deep/big.txt", ["- 1-400 (uniform: every line is `row N` with N rising by one)", "- 401-800 (uniform: same pattern continues)"]);
  assert.match(run(["done", "src/deep/big.txt"], { expectFail: true }).stderr, /does not describe line 801/);
  writeNote("src/deep/big.txt", ["- 1-400 rows", "- 401-900 (uniform: every line is `row N` with N rising by one)"]);
  const r = run(["done", "src/deep/big.txt"], { expectFail: true });
  assert.match(r.stderr, /wider than 120 lines/);
  assert.match(r.stderr, /without a real description/);
  writeNote("src/deep/big.txt", ["- L1-L400 (uniform: every line is `row N`, N from 1 to 400)", "- 401-900 (uniform: every line is `row N`, N from 401 to 900)"]);
  run(["done", "src/deep/big.txt"]);
});

await test("a code file needs internet research opened while reading it, cited in its note", () => {
  run(["note", "src/long.js"]);
  assert.match(ctx(read("src/long.js", 1, 4)), /Research now, on the internet/);
  run(["show", "src/long.js", "2", "2"]);
  const structure = ["- 1 const x = 1, a small numeric constant", "- 2 const s, a 2500-character string of y used as filler", "- 3 const z = 3, another small numeric constant"];
  writeNote("src/long.js", structure);
  assert.match(run(["done", "src/long.js"], { expectFail: true }).stderr, /none opened for it yet/);
  search("javascript const declaration", ["https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/const"]);
  writeNote("src/long.js", structure, { sources: ["https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/const"] });
  assert.match(run(["done", "src/long.js"], { expectFail: true }).stderr, /must list pages opened with WebFetch/, "a search result alone is not reading");
  fetchPage("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/const#description");
  run(["done", "src/long.js"]);
  const r = state().research.find((x) => x.tool === "WebFetch");
  assert.equal(r.file, "src/long.js");
  assert.equal(r.phase, "read");
});

await test("lines over 2000 characters need show", () => {
  assert.deepEqual(state().files["src/long.js"].showRanges, [[2, 2]]);
});

await test("a file changed on disk while being read must be read again", () => {
  run(["note", "README.md"]);
  read("README.md", 1, 2);
  fs.appendFileSync(abs("README.md"), "More spec text.\n");
  assert.match(run(["done", "README.md"], { expectFail: true }).stderr, /changed on disk/);
  read("README.md", 1, 4);
  writeNote("README.md", ["- 1 title line naming the sample project", "- 2-3 the specification: add returns the sum of its arguments"]);
  run(["done", "README.md"]);
});

await test("Stop holds the session while files are unread and lets go when nothing moved", () => {
  const first = hook({ hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(first.decision, "block");
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: true }), null);
  bashOk("git status");
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: true }).decision, "block");
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: [{ id: "t" }] }), null);
});

await test("SessionStart after compaction restores progress, the current file's note, the cursor and the research rule", () => {
  run(["note", ".gitignore"]);
  read(".gitignore", 1, 1);
  fs.writeFileSync(path.join(W, "notes", ".gitignore.md"), fs.readFileSync(path.join(W, "notes", ".gitignore.md"), "utf8").replace("<!-- fill -->", "- 1 ignores log files MARKER-NOTE-42"));
  fs.writeFileSync(path.join(W, "CURSOR.md"), "# Cursor\n\nMARKER-CURSOR-7731\n");
  const text = ctx(hook({ hook_event_name: "SessionStart", source: "compact" }));
  assert.ok(text.length <= 10000, `length ${text.length}`);
  assert.match(text, /Current file \.gitignore/);
  assert.match(text, /MARKER-NOTE-42/);
  assert.match(text, /MARKER-CURSOR-7731/);
  assert.match(text, /Research on the internet all the time/);
  assert.match(text, /Nothing is run, tested or measured before phase apptest/);
});

await test("PreCompact logs the compaction; PostCompact saves its summary", () => {
  hook({ hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null });
  hook({ hook_event_name: "PostCompact", trigger: "auto", compact_summary: "SUMMARY TEXT" });
  assert.equal(state().compactions.length, 1);
  const saved = fs.readdirSync(path.join(W, "compactions"));
  assert.match(fs.readFileSync(path.join(W, "compactions", saved[0]), "utf8"), /SUMMARY TEXT/);
});

await test("phase verify is refused while a file is unread; skip needs a reason", () => {
  run(["phase", "verify"], { expectFail: true });
  run(["skip", "src/a.ts"], { expectFail: true });
});

await test("reading a file with an open finding that asks to check it shows that finding", () => {
  writeNote(".gitignore", ["- 1 ignores *.log files so logs stay out of git"]);
  run(["done", ".gitignore"]);
  setFindings(["### F-0001 · suspected · S2 · README.md:2 — spec says sum\nWhat: add must return a+b.\nProof: README.md:2 states it.\nEffect: wrong totals.\nCheck: src/a.ts"]);
  run(["note", "src/a.ts"]);
  assert.match(ctx(read("src/a.ts", 1, 4)), /Open findings that ask to check this file/);
  const url = "https://www.typescriptlang.org/docs/handbook/2/functions.html";
  fetchPage(url);
  writeNote("src/a.ts", ["- 1-3 add(a, b) returns a - b, which contradicts the README spec (F-0002)"], { sources: [url] });
  run(["done", "src/a.ts"]);
});

await test("verify: a decision needs its lines re-read and its own research (work, WebFetch, Source)", () => {
  run(["phase", "verify"]);
  setFindings([
    "### F-0001 · rejected · S2 · README.md:2 — spec says sum\nWhat: duplicate of F-0002.\nRejected because: same cause as F-0002 at src/a.ts:2.",
    "### F-0002 · confirmed · S1 · src/a.ts:2 — add subtracts\nWhat: add returns a - b.\nProof: src/a.ts:2 returns a - b; README.md:2 requires the sum.\nEffect: every caller gets the wrong value.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction",
  ]);
  let r = run(["phase", "fix"], { expectFail: true });
  assert.match(r.stderr, /F-0001: README\.md:2-2 was not re-read during phase verify/);
  assert.match(r.stderr, /F-0001: no "Source:" line/);
  assert.match(r.stderr, /F-0002: none of the "Source:" URLs was opened with WebFetch while working on F-0002 in phase verify/);
  run(["work", "F-0002"]);
  read("src/a.ts", 1, 3);
  fetchPage("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction");
  run(["work", "F-0001"]);
  read("README.md", 1, 3);
  fetchPage("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction");
  setFindings([
    "### F-0001 · rejected · S2 · README.md:2 — spec says sum\nWhat: duplicate of F-0002.\nRejected because: same cause as F-0002 at src/a.ts:2.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction",
    "### F-0002 · confirmed · S1 · src/a.ts:2 — add subtracts\nWhat: add returns a - b.\nProof: src/a.ts:2 returns a - b; README.md:2 requires the sum.\nEffect: every caller gets the wrong value.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction",
  ]);
  r = run(["phase", "fix"]);
  assert.match(r.stdout, /Phase fix/);
});

await test("fix: an edit needs `work` on a confirmed finding and research for it first", () => {
  assert.match(preEdit("src/a.ts").hookSpecificOutput.permissionDecisionReason, /work F-xxxx/);
  run(["work", "F-0001"]);
  assert.match(preEdit("src/a.ts").hookSpecificOutput.permissionDecisionReason, /only confirmed findings are implemented/);
  run(["work", "F-0002"]);
  assert.match(preEdit("src/a.ts").hookSpecificOutput.permissionDecisionReason, /No internet research for F-0002/);
  search("javascript addition operator", ["https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Addition"]);
  assert.equal(decision(preEdit("src/a.ts")), "deny", "a search alone is not reading");
  fetchPage("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Addition");
  assert.equal(decision(preEdit("src/a.ts")), "allow");
});

await test("fix: fixed needs the edit under work, Fix source opened before it, a re-read after it, and the static check", async () => {
  const head = "### F-0002 · fixed · S1 · src/a.ts:2 — add subtracts\nWhat: add returns a - b.\nProof: src/a.ts:2 returns a - b; README.md:2 requires the sum.\nEffect: every caller gets the wrong value.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction";
  const keep = "### F-0001 · rejected · S2 · README.md:2 — spec says sum\nWhat: duplicate of F-0002.\nRejected because: same cause as F-0002 at src/a.ts:2.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction";
  setFindings([keep, `${head}\nFix: src/a.ts:2 returns a + b\nFix source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Addition\nVerified by: re-read src/a.ts:1-3`]);
  let r = run(["phase", "apptest"], { expectFail: true });
  assert.match(r.stderr, /no Edit\/Write of it was recorded while working on F-0002/);
  await pause();
  edit("src/a.ts");
  await pause();
  r = run(["phase", "apptest"], { expectFail: true });
  assert.match(r.stderr, /"Verified by:" must say "re-read path:a-b" for the changed lines of src\/a\.ts/);
  assert.match(r.stderr, /static check "npx tsc --noEmit" has not passed since the last edit/);
  read("src/a.ts", 1, 3);
  bashOk("npx tsc --noEmit | tail -1");
  r = run(["phase", "apptest"], { expectFail: true });
  assert.match(r.stderr, /static check .* has not passed/, "a piped run does not count");
  bashOk("npx tsc --noEmit");
  r = run(["phase", "apptest"], { expectFail: true });
  assert.match(r.stderr, /Declare the application first/);
});

await test("fix source opened only after the edit does not count", () => {
  const s = state();
  const fixSrc = s.research.filter((x) => x.finding === "F-0002" && x.phase === "fix" && x.tool === "WebFetch");
  const firstEdit = s.files["src/a.ts"].edits.find((e) => e.finding === "F-0002").at;
  assert.ok(fixSrc.some((x) => x.at < firstEdit), "the research was before the edit in this run");
});

await test("set-app: start and url required; the app test round is created with its ANALYSIS.md", () => {
  run(["set-app", "--start", "npm run dev"], { expectFail: true });
  run(["set-app", "--start", "npm run dev", "--url", "http://localhost:5173", "--suite", "npm test"]);
  const r = run(["phase", "apptest"]);
  assert.match(r.stdout, /Phase apptest/);
  assert.ok(fs.existsSync(path.join(W, "apptest", "round-1", "ANALYSIS.md")));
  assert.match(r.stdout, /no screenshot yet/);
});

await test("the app's own server running in the background does not let the session stop", () => {
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: [{ id: "s", type: "shell", status: "running", command: "npm run dev" }] }).decision, "block");
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: [{ id: "b", type: "shell", status: "running", command: "npm run build" }] }), null);
});

await test("apptest: the start command, the suite and browser.mjs run; benchmarks and other commands do not; no edits", () => {
  for (const c of ["npm run dev", "npm test", `node "${SKILL_DIR}/scripts/browser.mjs" click "text=Add"`]) assert.equal(decision(preBash(c)), "allow", c);
  for (const c of ["npm run bench", "node perf.js", "lighthouse http://localhost:5173"]) assert.equal(decision(preBash(c)), "deny", c);
  assert.match(preEdit("src/a.ts").hookSpecificOutput.permissionDecisionReason, /No code changes during the app test/);
});

function writeLog(entries) {
  const dir = path.join(W, "apptest", "round-1");
  fs.writeFileSync(path.join(dir, "log.jsonl"), entries.map((e) => JSON.stringify({ at: new Date().toISOString(), ...e })).join("\n") + "\n");
}

await test("apptest gates: every gesture kind, mobile, every shot seen and analysed, every error triaged, Chrome closed", () => {
  const shot = (n, vp) => ({ kind: "shot", file: `.whole-review/apptest/round-1/shots/00${n}-${vp}-x.png`, viewport: vp });
  writeLog([shot(1, "desktop"), { kind: "action", action: "click" }, shot(2, "desktop"), { kind: "error", id: "E-1", type: "pageerror", text: "boom" }]);
  fs.writeFileSync(path.join(W, "apptest", "round-1", "daemon.json"), "{}");
  let r = run(["status"]);
  for (const re of [/no keyboard use/, /no scrolling yet/, /nothing tested on the mobile viewport/, /2 screenshots not looked at/, /no "## Scenario" section/, /2 screenshots have no line in ANALYSIS\.md/, /1 console\/page\/network errors not triaged/, /Chrome is still open/]) assert.match(r.stdout, re);
  writeLog([shot(1, "desktop"), { kind: "action", action: "click" }, shot(2, "desktop"), { kind: "action", action: "press" }, { kind: "action", action: "scroll" }, shot(3, "mobile"), { kind: "error", id: "E-1", type: "pageerror", text: "boom" }]);
  for (const n of [1, 2]) viewImage(`.whole-review/apptest/round-1/shots/00${n}-desktop-x.png`);
  assert.match(ctx(viewImage(".whole-review/apptest/round-1/shots/003-mobile-x.png")), /Write in ANALYSIS\.md/);
  fs.rmSync(path.join(W, "apptest", "round-1", "daemon.json"));
  fs.writeFileSync(path.join(W, "apptest", "round-1", "ANALYSIS.md"), "# Round 1\n\n## Scenario 1: add a product\n- 001-desktop-x.png: cart page, empty state readable\n- 002-desktop-x.png: product added, total wrong (F-0003)\n- 003-mobile-x.png: layout fits\n- E-1 pageerror: thrown by the total formatter (F-0003)\n");
  setFindings([
    "### F-0001 · rejected · S2 · README.md:2 — spec says sum\nWhat: duplicate of F-0002.\nRejected because: same cause as F-0002 at src/a.ts:2.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Subtraction",
    fs.readFileSync(findingsFile(), "utf8").split("\n### ").find((b) => b.startsWith("F-0002")).replace(/^/, "### ").trim(),
    "### F-0003 · suspected · S2 · app:cart — total shows NaN after adding\nWhat: the cart total reads NaN.\nEvidence: 002-desktop-x.png",
  ]);
  r = run(["status"]);
  assert.match(r.stdout, /the app test found 1 problems \(first F-0003\)/);
});

await test("an app-test defect is traced to its code before it is confirmed", () => {
  run(["phase", "verify"]);
  run(["work", "F-0003"]);
  read("src/a.ts", 1, 3);
  fetchPage("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/NaN");
  const block = (loc) => `### F-0003 · confirmed · S2 · ${loc} — total shows NaN after adding\nWhat: the cart total reads NaN.\nEvidence: 002-desktop-x.png\nProof: src/a.ts:2 returns NaN for strings.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/NaN`;
  const others = fs.readFileSync(findingsFile(), "utf8").split("\n### ").filter((b) => /^F-000[12]/.test(b)).map((b) => `### ${b.trim()}`);
  setFindings([...others, block("app:cart")]);
  assert.match(run(["phase", "fix"], { expectFail: true }).stderr, /must point at the code that causes it/);
  setFindings([...others, block("src/a.ts:2")]);
  run(["phase", "fix"]);
});

await test("after a new fix the app is tested in a new round; finish needs that round complete", async () => {
  run(["work", "F-0003"]);
  fetchPage("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number");
  await pause();
  edit("src/a.ts");
  await pause();
  read("src/a.ts", 1, 3);
  bashOk("npx tsc --noEmit");
  const others = fs.readFileSync(findingsFile(), "utf8").split("\n### ").filter((b) => /^F-000[12]/.test(b)).map((b) => `### ${b.trim()}`);
  setFindings([...others, "### F-0003 · fixed · S2 · src/a.ts:2 — total shows NaN after adding\nWhat: the cart total reads NaN.\nEvidence: 002-desktop-x.png\nProof: src/a.ts:2 returns NaN for strings.\nSource: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/NaN\nFix: src/a.ts:2 converts with Number\nFix source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number\nVerified by: re-read src/a.ts:1-3"]);
  run(["finish"], { expectFail: true });
  run(["phase", "apptest"]);
  assert.match(run(["finish"], { expectFail: true }).stderr, /round 2: no screenshot yet/);
  const dir = path.join(W, "apptest", "round-2");
  const shots = [["001", "desktop"], ["002", "mobile"]];
  fs.writeFileSync(path.join(dir, "log.jsonl"), [
    ...shots.map(([n, vp]) => ({ kind: "shot", file: `.whole-review/apptest/round-2/shots/${n}-${vp}-x.png`, viewport: vp })),
    { kind: "action", action: "click" }, { kind: "action", action: "type" }, { kind: "action", action: "scroll" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [n, vp] of shots) viewImage(`.whole-review/apptest/round-2/shots/${n}-${vp}-x.png`);
  fs.writeFileSync(path.join(dir, "ANALYSIS.md"), "# Round 2\n\n## Scenario 1: add a product\n- 001-desktop-x.png: total correct\n- 002-mobile-x.png: total correct on mobile\n");
  const r = run(["finish"]);
  assert.match(r.stdout, /round 2 .*2 screenshots \(desktop, mobile\)/);
  assert.match(r.stdout, /pages opened with WebFetch/);
  assert.match(r.stdout, /Fix source: https:\/\/developer\.mozilla\.org/);
});

await test("finish removed only our hooks and permissions; SessionStart is silent afterwards", () => {
  const settings = JSON.parse(fs.readFileSync(abs(".claude/settings.local.json"), "utf8"));
  assert.ok(!JSON.stringify(settings).includes("ledger.mjs"));
  assert.deepEqual(settings.permissions.allow, ["Bash(ls)"]);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(hook({ hook_event_name: "SessionStart", source: "startup" }), null);
});

await test("scope: a review of a sub-folder keeps its state at the project root; audit mode never edits", () => {
  run(["init", "--force", "--mode", "audit", "--scope", "src/deep", "--no-install"]);
  assert.deepEqual(state().order, ["src/deep/big.txt"]);
  read("src/deep/big.txt", 1, 10);
  assert.deepEqual(state().files["src/deep/big.txt"].ranges, [[1, 10]]);
  assert.equal(decision(preEdit("src/a.ts")), "deny");
});

await test("parallel hooks do not lose each other's updates (file lock)", async () => {
  run(["init", "--force", "--mode", "audit", "--scope", "src/deep", "--no-install"]);
  const one = (a) => new Promise((resolve) => {
    const p = spawn(process.execPath, [LEDGER, "hook"], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    p.on("close", resolve);
    p.stdin.end(JSON.stringify({ session_id: "s1", cwd: root, hook_event_name: "PostToolUse", tool_name: "Read",
      tool_input: { file_path: abs("src/deep/big.txt"), offset: a, limit: 10 },
      tool_response: { type: "text", file: { numLines: 10, startLine: a } } }));
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) => one(1 + i * 20)));
  assert.equal(state().files["src/deep/big.txt"].ranges.length, 12);
  assert.equal(state().progress, 12);
});

await test("set-check: empty refused; changing it in phase fix needs a reason", () => {
  run(["set-check"], { expectFail: true });
  run(["set-check", "npx", "eslint", "."]);
  assert.equal(state().checkCommand, "npx eslint .");
});

await test("blank lines need no note entry, code lines do", () => {
  fs.writeFileSync(abs("src/gaps.txt"), "alpha line\n\n\nbeta line\n\ngamma line\n");
  run(["init", "--force", "--mode", "audit", "--scope", "src/gaps.txt", "--no-install"]);
  run(["note", "src/gaps.txt"]);
  read("src/gaps.txt", 1, 7);
  writeNote("src/gaps.txt", ["- 1 alpha line, the first data record", "- 4 beta line, the second data record"]);
  assert.match(run(["done", "src/gaps.txt"], { expectFail: true }).stderr, /does not describe line 6/);
  writeNote("src/gaps.txt", ["- 1 alpha line, the first data record", "- 4 beta line, the second data record", "- 6 gamma line, the third data record"]);
  run(["done", "src/gaps.txt"]);
});

await test("a finding deleted from FINDINGS.md instead of rejected is reported", () => {
  setFindings(["### F-0001 · suspected · S2 · src/gaps.txt:1 — one\nWhat: x", "### F-0002 · suspected · S2 · src/gaps.txt:4 — two\nWhat: y"]);
  hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: findingsFile() }, tool_response: {} });
  setFindings(["### F-0001 · suspected · S2 · src/gaps.txt:1 — one\nWhat: x"]);
  hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: findingsFile() }, tool_response: {} });
  run(["phase", "verify"]);
  assert.match(run(["status"]).stdout, /F-0002 was in FINDINGS\.md and is gone/);
});

await test("malformed finding headings are reported, not ignored", () => {
  setFindings(["### F-0001 - confirmed - src/a.ts:1 - wrong format"]);
  assert.match(run(["status"]).stdout, /malformed finding heading/);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exitCode = failed ? 1 : 0;
