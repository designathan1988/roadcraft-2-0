#!/usr/bin/env node
/**
 * Durable ledger and hooks for the reviewing-whole-codebase skill.
 *
 * Everything lives in <project>/.whole-review/ so it survives compaction, /clear and new sessions:
 * - the inventory of files and the line ranges actually returned by the Read tool (recorded by a
 *   PostToolUse hook, so reading is a fact, not a claim);
 * - one note per file that must describe the whole file by line ranges (checked here);
 * - the findings, whose status changes are checked against what the hooks recorded: re-reads during
 *   verification, internet research (WebFetch/WebSearch) made for that file or that finding, edits made
 *   while working on that finding, and the static check;
 * - the phase, and the hooks that block edits before the fix phase, block running, testing or measuring
 *   anything before the application test phase, hold the session while work is open, and put the work
 *   back into context after a compaction;
 * - the application test rounds (screenshots, console errors) driven by browser.mjs.
 *
 * Zero dependencies. Node 18 or later.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STATE_DIR = ".whole-review";
// Marks the hooks this skill installs, whatever folder the skill sits in, so they can be found and removed.
const HOOK_TOKEN = "--whole-review-hook";
const SCRIPT_PATH = fileURLToPath(import.meta.url).replaceAll("\\", "/");
const SKILL_DIR = path.dirname(path.dirname(SCRIPT_PATH)).replaceAll("\\", "/");
const RUN_PREFIX = `node "${SCRIPT_PATH}"`;

// The Read tool shows at most this many characters of one line; longer lines are read with `show`.
const READ_LINE_CHAR_LIMIT = 2000;
// One suggested Read chunk: small enough to stay under the Read size limit and to be noted in one go.
const CHUNK_MAX_LINES = 400;
const CHUNK_MAX_BYTES = 30000;
// `show` prints at most this many characters per call and wraps lines at this width.
const SHOW_MAX_CHARS = 40000;
const SHOW_WRAP = 1000;
// Claude Code caps hook text added to context at 10,000 characters (code.claude.com/docs/en/hooks).
const CONTEXT_BUDGET = 9500;
// A note entry may cover at most this many lines unless it says why the range is uniform.
const NOTE_MAX_SPAN = 120;
// Minimum length of the description of one note entry, and of a summary.
const NOTE_MIN_DESC = 15;
const SUMMARY_MIN = 20;
const SNIFF_BYTES = 8192;
const RUN_LOG_CAP = 1000;

const DEFAULT_SKIP_DIRS = new Set([
  ".git", "node_modules", ".hg", ".svn", "dist", "build", "out", "coverage", ".next", ".nuxt",
  ".cache", ".parcel-cache", ".turbo", "target", "vendor", "__pycache__", ".venv", "venv",
  ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vs", STATE_DIR,
]);
const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock",
  "Pipfile.lock", "composer.lock", "Gemfile.lock", "go.sum", "packages.lock.json", "uv.lock",
]);
// Files that state the contract of the project are read first, then build/config, then the rest.
const FIRST_NAMES = /^(readme|claude|agents|contributing|architecture|design|spec)(\..*)?$/i;
const CONFIG_NAMES = /^(package\.json|tsconfig.*\.json|jsconfig\.json|pyproject\.toml|setup\.(py|cfg)|requirements.*\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle.*|settings\.gradle.*|makefile|cmakelists\.txt|dockerfile|.*\.config\.(js|cjs|mjs|ts)|\.eslintrc.*|\.prettierrc.*|vite\.config\..*|webpack\.config\..*)$/i;

const NOTE_PLACEHOLDER = "<!-- fill -->";
const FINDING_LOOSE = /^###\s+F-\d+/;
const FINDING_HEADING = /^###\s+(F-\d+)\s+[·|]\s+([a-z]+)\s+[·|]\s+(S[1-4])\s+[·|]\s+(.+?)\s+[—–-]+\s+(.+)$/;
const FINDING_STATUSES = new Set(["suspected", "confirmed", "rejected", "fixed", "blocked"]);
const FIELD_LINE = /^(What|Proof|Effect|Fix plan|Check|Rejected because|Blocker|Tried|Fix|Verified by|Source|Fix source|Evidence):\s*(.*)$/;
// Files whose correctness depends on language, library or platform semantics: reading one needs research.
const CODE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|cs|go|rs|java|kt|kts|scala|swift|m|mm|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|py|rb|php|pl|lua|dart|ex|exs|erl|hs|clj|fs|sh|bash|ps1|sql|glsl|wgsl|hlsl|frag|vert|html|css|scss|sass|less)$/i;
// Commands that may run before phase apptest: reading, version queries and the declared static check only.
const ALWAYS_ALLOWED = [
  /^git\s+(status|diff|log|show|ls-files|blame|rev-parse)\b[^;&|<>]*$/,
  /^(ls|dir|pwd)\b[^;&|<>]*$/,
  /^[\w.@/-]+\s+(--version|-v|version)$/,
  /^(npm|pnpm|yarn)\s+(ls|list|view|info|why)\b[^;&|<>]*$/,
  /^(pip|pip3|python -m pip|py -m pip)\s+(show|list|index)\b[^;&|<>]*$/,
  /^(cargo\s+tree|go\s+list|dotnet\s+list)\b[^;&|<>]*$/,
];
const BROWSER_TOOLS = /playwright|puppeteer|chrome|browser|computer-use|selenium/i;

// ---------------------------------------------------------------- helpers

const toPosix = (p) => p.replaceAll("\\", "/");
const now = () => new Date().toISOString();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sha1(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

function lineInfo(text) {
  const lines = text.split("\n");
  const long = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].replace(/\r$/, "").length > READ_LINE_CHAR_LIMIT) long.push(i + 1);
  }
  return { count: lines.length, long, lastEmpty: lines[lines.length - 1] === "" };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function listFlag(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => toPosix(s.trim()).replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
}

function under(rel, prefix) {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r[1] >= r[0]).map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function covers(ranges, a, b) {
  return ranges.some((r) => r[0] <= a && r[1] >= b);
}

function coveredCount(ranges) {
  return ranges.reduce((sum, r) => sum + (r[1] - r[0] + 1), 0);
}

function firstGap(ranges, last, skip = null) {
  // First line in 1..last not covered by the ranges; lines in `skip` (blank lines) need no cover.
  let line = 1;
  for (const r of mergeRanges(ranges)) {
    while (line < r[0] && skip?.has(line)) line += 1;
    if (r[0] > line) return line;
    line = Math.max(line, r[1] + 1);
  }
  while (line <= last && skip?.has(line)) line += 1;
  return line <= last ? line : null;
}

function blankLines(root, rel) {
  const set = new Set();
  try {
    fs.readFileSync(path.join(root, rel), "utf8").split("\n").forEach((l, i) => { if (!l.trim()) set.add(i + 1); });
  } catch {
    // An unreadable file has no known blank lines; every line then needs a description.
  }
  return set;
}

function contiguousEnd(ranges) {
  const merged = mergeRanges(ranges);
  return merged.length && merged[0][0] === 1 ? merged[0][1] : 0;
}

function absPosixRule(dir) {
  // Permission rules use //<absolute posix path>; on Windows C:\x becomes //c/x (code.claude.com/docs/en/permissions).
  const p = toPosix(path.resolve(dir));
  const drive = /^([A-Za-z]):\/(.*)$/.exec(p);
  return drive ? `//${drive[1].toLowerCase()}/${drive[2]}` : `/${p}`;
}

// ---------------------------------------------------------------- research record

function normalizeUrl(url) {
  try {
    const u = new URL(String(url).trim().replace(/[).,;>\]]+$/, ""));
    u.hash = "";
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

function citedUrls(text) {
  return [...String(text ?? "").matchAll(/https?:\/\/[^\s<>"'`]+/g)].map((m) => normalizeUrl(m[0])).filter(Boolean);
}

// Pages actually opened with WebFetch (their own URL and the URL they resolved to) that match `filter`.
function fetchedUrls(state, filter) {
  const out = new Set();
  for (const r of state.research ?? []) {
    if (r.tool !== "WebFetch" || !filter(r)) continue;
    for (const u of [r.url, r.finalUrl]) if (u) out.add(u);
  }
  return out;
}

function researchSince(state, since, filter = () => true) {
  return (state.research ?? []).filter((r) => r.at >= since && filter(r));
}

// ---------------------------------------------------------------- state

function findRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, STATE_DIR, "state.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function paths(root) {
  const dir = path.join(root, STATE_DIR);
  return {
    dir,
    state: path.join(dir, "state.json"),
    inventory: path.join(dir, "INVENTORY.md"),
    index: path.join(dir, "INDEX.md"),
    findings: path.join(dir, "FINDINGS.md"),
    cursor: path.join(dir, "CURSOR.md"),
    report: path.join(dir, "REPORT.md"),
    notes: path.join(dir, "notes"),
    compactions: path.join(dir, "compactions"),
  };
}

function loadState(root) {
  const p = paths(root).state;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (error) {
    fail(`Cannot read ${p}: ${error.message}`);
  }
  return null;
}

function saveState(root, state) {
  const p = paths(root).state;
  const temp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, "utf8");
  fs.renameSync(temp, p);
}

function requireRoot(flags) {
  const start = typeof flags.project === "string" ? flags.project : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findRoot(start);
  if (!root) fail(`No ${STATE_DIR}/state.json found from ${start}. Run "init" first.`);
  return root;
}

function relKey(root, state, filePath) {
  if (!filePath) return null;
  const rel = toPosix(path.relative(root, path.resolve(root, filePath)));
  if (state.files[rel]) return rel;
  if (process.platform === "win32") {
    const lower = rel.toLowerCase();
    for (const key of Object.keys(state.files)) if (key.toLowerCase() === lower) return key;
  }
  return null;
}

function insideProject(root, filePath) {
  const rel = toPosix(path.relative(root, path.resolve(root, filePath)));
  return rel !== "" && !rel.startsWith("../") && rel !== ".." && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------- inventory

function gitFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean).map(toPosix);
  } catch {
    return null;
  }
}

function walkFiles(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!DEFAULT_SKIP_DIRS.has(entry.name)) stack.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

function readRank(rel) {
  const base = path.basename(rel);
  const depth = rel.split("/").length;
  if (FIRST_NAMES.test(base) && depth <= 2) return 0;
  if (CONFIG_NAMES.test(base) && depth <= 2) return 1;
  return 2;
}

function fileEntry(buffer) {
  const info = lineInfo(buffer.toString("utf8"));
  return {
    bytes: buffer.length, sha: sha1(buffer), lines: info.count, lastEmpty: info.lastEmpty, longLines: info.long,
    ranges: [], showRanges: [], verifyReads: [], postEditReads: [], edits: [], status: "unread",
  };
}

function buildInventory(root, scope, flags) {
  const fromGit = gitFiles(root);
  const ownDir = toPosix(path.relative(root, SKILL_DIR));
  const ownInside = ownDir && !ownDir.startsWith("..") && !path.isAbsolute(ownDir);
  const exclude = listFlag(flags.exclude);
  const files = {};
  const list = [...new Set(fromGit ?? walkFiles(root))]
    .filter((rel) => !under(rel, STATE_DIR) && !(ownInside && under(rel, ownDir)))
    .filter((rel) => !scope.length || scope.some((p) => under(rel, p)));
  for (const rel of list) {
    let buffer;
    try {
      if (!fs.statSync(path.join(root, rel)).isFile()) continue;
      buffer = fs.readFileSync(path.join(root, rel));
    } catch {
      continue;
    }
    const entry = fileEntry(buffer);
    if (exclude.some((p) => under(rel, p))) Object.assign(entry, { status: "skipped", reason: "excluded with --exclude at init" });
    else if (buffer.subarray(0, SNIFF_BYTES).includes(0)) Object.assign(entry, { status: "skipped", reason: "binary file" });
    else if (!flags.all && LOCKFILES.has(path.basename(rel))) Object.assign(entry, { status: "skipped", reason: "lockfile (machine-generated); init with --all to read it" });
    else if (buffer.length === 0) Object.assign(entry, { status: "read", lines: 0, reason: "empty file", summary: "(empty file)" });
    files[rel] = entry;
  }
  const order = Object.keys(files).sort((a, b) => readRank(a) - readRank(b) || a.localeCompare(b));
  return { files, order, source: fromGit ? "git ls-files -co --exclude-standard" : "directory walk (dependency and build folders skipped)" };
}

function requiredLastLine(entry) {
  return entry.lastEmpty && entry.lines > 1 ? entry.lines - 1 : entry.lines;
}

function longLinesMissing(entry) {
  return entry.longLines.filter((n) => !entry.showRanges.some((r) => n >= r[0] && n <= r[1]));
}

function fileChanged(root, rel, entry) {
  try {
    return sha1(fs.readFileSync(path.join(root, rel))) !== entry.sha;
  } catch {
    return true;
  }
}

function suggestChunk(root, rel, entry) {
  const last = requiredLastLine(entry);
  const start = firstGap(entry.ranges, last);
  if (start === null) return null;
  const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
  let bytes = 0;
  let end = start;
  for (let n = start; n <= last; n += 1) {
    const next = bytes + Buffer.byteLength(lines[n - 1] ?? "", "utf8") + 1;
    if (n > start && (n - start + 1 > CHUNK_MAX_LINES || next > CHUNK_MAX_BYTES)) break;
    bytes = next;
    end = n;
  }
  return { start, end, limit: end - start + 1 };
}

// ---------------------------------------------------------------- notes

function notePath(root, rel) {
  return path.join(paths(root).notes, `${rel}.md`);
}

function parseNote(text) {
  const sections = {};
  let current = "_head";
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      sections[current] = [];
    } else {
      (sections[current] ??= []).push(line);
    }
  }
  const summaryLine = (sections._head ?? []).find((l) => l.startsWith("Summary:"));
  const structureKey = Object.keys(sections).find((k) => k.startsWith("structure"));
  const entries = [];
  for (const line of structureKey ? sections[structureKey] : []) {
    const m = /^\s*[-*]\s*(?:L|lines?\s*)?(\d+)\s*(?:[-–]\s*L?(\d+))?\s*[:.)\-–—]?\s+(.*)$/i.exec(line);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    entries.push({ a, b, desc: m[3].trim(), uniform: /\(uniform:\s*[^)]{5,}\)/i.test(m[3]) });
  }
  const dependsKey = Object.keys(sections).find((k) => k.startsWith("depends"));
  return {
    summary: summaryLine ? summaryLine.slice("Summary:".length).trim() : "",
    entries,
    depends: dependsKey ? sections[dependsKey].join("\n").trim() : "",
    sections,
  };
}

function readNote(root, rel) {
  try {
    return fs.readFileSync(notePath(root, rel), "utf8");
  } catch {
    return null;
  }
}

function noteProblems(root, rel, entry) {
  const text = readNote(root, rel);
  if (text === null) return [`no note yet: run \`note ${rel}\` and describe the file in ${STATE_DIR}/notes/${rel}.md`];
  const problems = [];
  if (text.includes(NOTE_PLACEHOLDER)) problems.push(`the note still has ${NOTE_PLACEHOLDER} placeholders`);
  const note = parseNote(text);
  if (note.summary.length < SUMMARY_MIN) problems.push(`Summary: must say in at least ${SUMMARY_MIN} characters what the file is for`);
  const last = requiredLastLine(entry);
  const bad = note.entries.filter((e) => e.b < e.a || e.b > entry.lines);
  if (bad.length) problems.push(`Structure entries outside 1-${entry.lines}: ${bad.map((e) => `${e.a}-${e.b}`).join(", ")}`);
  const thin = note.entries.filter((e) => e.desc.replace(/\(uniform:[^)]*\)/i, "").trim().length < NOTE_MIN_DESC && !e.uniform);
  if (thin.length) problems.push(`Structure entries without a real description (min ${NOTE_MIN_DESC} characters): ${thin.slice(0, 8).map((e) => `${e.a}-${e.b}`).join(", ")}`);
  const wide = note.entries.filter((e) => e.b - e.a + 1 > NOTE_MAX_SPAN && !e.uniform);
  if (wide.length) problems.push(`Structure entries wider than ${NOTE_MAX_SPAN} lines must be split by what they hold, or say "(uniform: <why every line is alike>)": ${wide.slice(0, 8).map((e) => `${e.a}-${e.b}`).join(", ")}`);
  const gap = firstGap(note.entries.map((e) => [e.a, e.b]), last, blankLines(root, rel));
  if (gap !== null) problems.push(`the Structure section does not describe line ${gap} (it must cover every non-blank line from 1 to ${last} with "- a-b what these lines hold"; blank lines need no entry)`);
  if (note.depends.replace(NOTE_PLACEHOLDER, "").trim().length < 4) problems.push('the "Depends on / used by" section is empty (write "none" with the reason if so)');
  return problems;
}

function noteTemplate(rel, entry) {
  return [
    `# ${rel}`,
    `Lines: ${entry.lines}`,
    `Summary: ${NOTE_PLACEHOLDER}`,
    "",
    "## Structure (every non-blank line range, 1 to the end, and what it holds)",
    NOTE_PLACEHOLDER,
    "",
    "## Contracts, state and data flow",
    NOTE_PLACEHOLDER,
    "",
    "## Depends on / used by",
    NOTE_PLACEHOLDER,
    "",
    "## Problems found (finding IDs)",
    NOTE_PLACEHOLDER,
    "",
    "## To check in other files",
    NOTE_PLACEHOLDER,
    "",
    "## Sources (pages opened with WebFetch while reading this file, and what each settled)",
    NOTE_PLACEHOLDER,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- findings

function readFindings(root) {
  const p = paths(root).findings;
  const out = { list: [], malformed: [] };
  if (!fs.existsSync(p)) return out;
  let current = null;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (FINDING_LOOSE.test(line)) {
      const m = FINDING_HEADING.exec(line);
      if (!m) {
        out.malformed.push(line);
        current = null;
        continue;
      }
      const loc = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(m[4]);
      current = {
        id: m[1], status: m[2], severity: m[3], file: loc[1], a: loc[2] ? Number(loc[2]) : null,
        b: loc[3] ? Number(loc[3]) : loc[2] ? Number(loc[2]) : null, title: m[5], heading: line.replace(/^###\s+/, ""), fields: {},
      };
      out.list.push(current);
      continue;
    }
    if (!current) continue;
    const field = FIELD_LINE.exec(line);
    if (field) current.fields[field[1]] = `${current.fields[field[1]] ? `${current.fields[field[1]]} ` : ""}${field[2].trim()}`;
  }
  return out;
}

function pathRefs(root, state, text) {
  const refs = [];
  for (const m of String(text ?? "").matchAll(/([\w@./\\-]+\.[\w]+):(\d+)/g)) {
    const rel = relKey(root, state, m[1]);
    if (rel) refs.push({ rel, line: Number(m[2]) });
  }
  return refs;
}

function lastEditAt(entry) {
  return entry.edits.length ? entry.edits[entry.edits.length - 1].at : null;
}

function sourceProblem(state, f, phase, before = null) {
  // The decision must cite pages opened with WebFetch while this finding was the one in hand (`work`),
  // in the phase where the decision is made: research done for this decision, not reused from elsewhere.
  const field = phase === "fix" ? "Fix source" : "Source";
  const cited = citedUrls(f.fields[field]);
  if (!cited.length) return `${f.id}: no "${field}:" line with the URL(s) of the official documentation or other sources read for this ${phase === "fix" ? "fix" : "decision"}`;
  const opened = fetchedUrls(state, (r) => r.finding === f.id && r.phase === phase && (!before || r.at < before));
  if (!cited.some((u) => opened.has(u))) {
    return `${f.id}: none of the "${field}:" URLs was opened with WebFetch while working on ${f.id} in phase ${phase}${before ? " before its first edit" : ""} (run \`work ${f.id}\`, then WebFetch the page; search results alone are not reading)`;
  }
  return null;
}

function findingProblems(root, state, findings) {
  const problems = [];
  const seen = new Set();
  for (const line of findings.malformed) problems.push(`malformed finding heading (use "### F-0001 · status · S2 · path:line — title"): ${line.slice(0, 120)}`);
  const present = new Set(findings.list.map((f) => f.id));
  for (const id of state.seenFindings ?? []) {
    if (!present.has(id)) problems.push(`${id} was in FINDINGS.md and is gone; a finding is never deleted: put it back and reject it with "Rejected because:" (or merge it, citing the other id)`);
  }
  for (const f of findings.list) {
    const tag = f.id;
    if (seen.has(f.id)) problems.push(`${tag} appears twice`);
    seen.add(f.id);
    if (!FINDING_STATUSES.has(f.status)) {
      problems.push(`${tag}: unknown status "${f.status}"`);
      continue;
    }
    if (!f.fields.What) problems.push(`${tag}: missing "What:" line`);
    const rel = relKey(root, state, f.file);
    const entry = rel ? state.files[rel] : null;
    const decided = f.status !== "suspected";
    if (decided && f.status !== "rejected" && !entry) {
      problems.push(`${tag}: a ${f.status} finding must point at the code that causes it ("path:line" of a project file); "${f.file}" is not one (an app-test symptom is traced to its cause before confirming)`);
    }
    const reReadInVerify = () => !entry || (f.a !== null ? covers(entry.verifyReads, f.a, f.b) : entry.verifyReads.length > 0);
    if (f.status === "confirmed" || f.status === "fixed" || f.status === "blocked") {
      if (!f.fields.Proof) problems.push(`${tag}: ${f.status} without a "Proof:" line (the path through the code that shows it)`);
      if (!reReadInVerify()) problems.push(`${tag}: ${rel}${f.a !== null ? `:${f.a}-${f.b}` : ""} was not re-read during phase verify; Read those lines in the current code before confirming`);
    }
    if (f.status === "rejected") {
      if (!f.fields["Rejected because"]) problems.push(`${tag}: rejected without a "Rejected because:" line naming the code that disproves it`);
      if (!reReadInVerify()) problems.push(`${tag}: ${rel}${f.a !== null ? `:${f.a}-${f.b}` : ""} was not re-read during phase verify; Read it before rejecting`);
    }
    if (decided) {
      const sp = sourceProblem(state, f, "verify");
      if (sp) problems.push(sp);
    }
    if (f.status === "blocked") {
      if (!f.fields.Blocker || f.fields.Blocker.length < 20) problems.push(`${tag}: blocked without a precise "Blocker:" line`);
      if (!f.fields.Tried) problems.push(`${tag}: blocked without a "Tried:" line (what was attempted)`);
    }
    if (f.status === "fixed") problems.push(...fixProblems(root, state, f));
  }
  return problems;
}

function findingEdits(state, rel, id) {
  // Edits are attributed to a finding only in phase fix (see onEdit), in whichever fix round they happened.
  return state.files[rel].edits.filter((e) => e.finding === id);
}

function fixProblems(root, state, f) {
  const tag = f.id;
  const problems = [];
  if (!f.fields.Fix) return [`${tag}: fixed without a "Fix:" line naming each changed place as path:line`];
  const refs = pathRefs(root, state, f.fields.Fix);
  if (!refs.length) return [`${tag}: "Fix:" names no changed place as path:line of a project file`];
  const changed = [...new Set(refs.map((r) => r.rel))];
  let latest = "";
  let earliest = "";
  for (const rel of changed) {
    const edits = findingEdits(state, rel, f.id);
    if (!edits.length) problems.push(`${tag}: ${rel} is named in "Fix:" but no Edit/Write of it was recorded while working on ${tag} (\`work ${tag}\`) in phase fix`);
    else {
      if (edits[edits.length - 1].at > latest) latest = edits[edits.length - 1].at;
      if (!earliest || edits[0].at < earliest) earliest = edits[0].at;
    }
  }
  if (earliest) {
    const sp = sourceProblem(state, f, "fix", earliest);
    if (sp) problems.push(sp);
  }
  const verified = f.fields["Verified by"];
  if (!verified) problems.push(`${tag}: fixed without a "Verified by:" line`);
  else if (latest) {
    // Verification is done in the code: the changed lines are read again after the last edit.
    const reread = [...verified.matchAll(/re-?read\s+([\w@./\\-]+\.[\w]+):(\d+)-(\d+)/gi)].filter((m) => {
      const rel = relKey(root, state, m[1]);
      return rel && covers(state.files[rel].postEditReads, Number(m[2]), Number(m[3]));
    }).map((m) => relKey(root, state, m[1]));
    const missing = changed.filter((rel) => !reread.includes(rel));
    if (missing.length) problems.push(`${tag}: "Verified by:" must say "re-read path:a-b" for the changed lines of ${missing.join(", ")}, Read again after the last edit (${latest}); that is not in the record`);
  }
  return problems;
}

function countBy(items, key) {
  const out = {};
  for (const item of items) out[item[key]] = (out[item[key]] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------- derived views and gates

function totals(state) {
  const list = state.order.map((rel) => state.files[rel]);
  const reading = list.filter((e) => e.status !== "skipped");
  return {
    all: list.length,
    toRead: reading.length,
    read: reading.filter((e) => e.status === "read").length,
    skipped: list.length - reading.length,
    lines: reading.reduce((s, e) => s + e.lines, 0),
    linesCovered: reading.reduce((s, e) => s + Math.min(coveredCount(e.ranges), e.lines), 0),
  };
}

function currentFile(state) {
  return state.order.find((rel) => state.files[rel].status === "reading")
    ?? state.order.find((rel) => state.files[rel].status === "unread") ?? null;
}

function writeViews(root, state) {
  const p = paths(root);
  const t = totals(state);
  const inv = [
    `# Inventory: ${t.read} of ${t.toRead} files read, ${t.skipped} skipped, ${t.linesCovered} of ${t.lines} lines covered`,
    `Listed by ${state.inventorySource}${state.scope.length ? `, limited to ${state.scope.join(", ")}` : ""}. Generated by ledger.mjs; do not edit.`,
    "",
  ];
  for (const rel of state.order) {
    const e = state.files[rel];
    const mark = { read: "[x]", skipped: "[-]", reading: "[~]" }[e.status] ?? "[ ]";
    const extra = e.status === "skipped" ? ` skipped: ${e.reason}` : e.status === "reading" ? ` lines covered ${coveredCount(e.ranges)}/${e.lines}` : "";
    inv.push(`- ${mark} ${rel} (${e.lines} lines)${extra}`);
  }
  fs.writeFileSync(p.inventory, `${inv.join("\n")}\n`, "utf8");
  const idx = ["# Index of files read (summary per file; full content in notes/<path>.md)", ""];
  for (const rel of state.order) {
    const e = state.files[rel];
    if (e.status === "read" && e.lines > 0) idx.push(`- ${rel}: ${e.summary ?? ""}`);
  }
  fs.writeFileSync(p.index, `${idx.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------- application test rounds

function currentRound(state) {
  const rounds = state.apptest?.rounds ?? [];
  return rounds.length ? rounds[rounds.length - 1] : null;
}

function roundPath(root, round) {
  return path.join(root, STATE_DIR, "apptest", `round-${round.n}`);
}

function roundLog(root, round) {
  const file = path.join(roundPath(root, round), "log.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function apptestProblems(root, state) {
  const app = state.apptest?.app;
  const round = currentRound(state);
  if (!app) return [`the application is not declared: run \`set-app --start "<command that starts it>" --url <url>\` (or \`set-app --none "<why this project has no UI to test>"\`)`];
  if (!round) return ["no app-test round started: run `phase apptest`"];
  if (app.none) return [];
  const problems = [];
  const log = roundLog(root, round);
  const shots = log.filter((e) => e.kind === "shot");
  const errors = log.filter((e) => e.kind === "error");
  const actions = log.filter((e) => e.kind === "action").map((e) => e.action);
  const dir = roundPath(root, round);
  if (!shots.length) return [`round ${round.n}: no screenshot yet: start Chrome with \`node "${SKILL_DIR}/scripts/browser.mjs" start --url ${app.url}\` and use the app as a person would`];
  for (const [need, kinds] of [["a click", ["click"]], ["keyboard use (type or press)", ["type", "press"]], ["scrolling", ["scroll"]]]) {
    if (!actions.some((a) => kinds.includes(a))) problems.push(`round ${round.n}: no ${need} yet; use the app with every kind of gesture it supports`);
  }
  const viewports = new Set(shots.map((s) => s.viewport));
  if (!app.desktopOnly && !viewports.has("mobile")) problems.push(`round ${round.n}: nothing tested on the mobile viewport (\`browser.mjs viewport mobile\`), or declare why not with \`set-app --desktop-only "<reason>"\``);
  const viewed = new Set(state.apptest.viewed ?? []);
  const unviewed = shots.filter((s) => !viewed.has(s.file));
  if (unviewed.length) problems.push(`round ${round.n}: ${unviewed.length} screenshots not looked at (Read each one): ${unviewed.slice(0, 5).map((s) => s.file).join(", ")}`);
  const analysis = fs.existsSync(path.join(dir, "ANALYSIS.md")) ? fs.readFileSync(path.join(dir, "ANALYSIS.md"), "utf8") : "";
  if (!/^##\s+Scenario\b(?!.*<user task>).*\S.*$/m.test(analysis)) problems.push(`round ${round.n}: ANALYSIS.md has no "## Scenario" section (one per user task exercised; the template line does not count)`);
  const unanalysed = shots.filter((s) => !analysis.includes(path.basename(s.file)));
  if (unanalysed.length) problems.push(`round ${round.n}: ${unanalysed.length} screenshots have no line in ANALYSIS.md saying what they show and what is wrong: ${unanalysed.slice(0, 5).map((s) => path.basename(s.file)).join(", ")}`);
  const untriaged = errors.filter((e) => !new RegExp(`\\b${e.id}\\b`).test(analysis));
  if (untriaged.length) problems.push(`round ${round.n}: ${untriaged.length} console/page/network errors not triaged in ANALYSIS.md (name each id with its cause or finding): ${untriaged.slice(0, 5).map((e) => `${e.id} ${e.type}`).join(", ")}`);
  if (fs.existsSync(path.join(dir, "daemon.json"))) problems.push(`round ${round.n}: Chrome is still open; close it with \`browser.mjs stop\` when the round is done`);
  return problems;
}

function lastProjectEdit(state) {
  return state.order.map((rel) => lastEditAt(state.files[rel])).filter(Boolean).sort().pop() ?? null;
}

function openWork(root, state) {
  // Everything that keeps the current phase from closing, most urgent first.
  const problems = [];
  const findings = readFindings(root);
  if (state.phase === "read") {
    const rel = currentFile(state);
    if (rel) problems.push(`files are still unread (${totals(state).toRead - totals(state).read} left); current: ${rel}`);
    return problems;
  }
  const suspected = findings.list.filter((f) => f.status === "suspected");
  const confirmed = findings.list.filter((f) => f.status === "confirmed");
  if (state.phase !== "apptest" && suspected.length) problems.push(`${suspected.length} findings still suspected (first ${suspected[0].id}: ${suspected[0].file}${suspected[0].a ? `:${suspected[0].a}` : ""}); \`work ${suspected[0].id}\`, research it, re-read its code, then confirm or reject`);
  problems.push(...findingProblems(root, state, findings));
  const lastEdit = lastProjectEdit(state);
  if (state.phase === "fix") {
    if (confirmed.length) problems.push(`${confirmed.length} confirmed findings not fixed (first ${confirmed[0].id}: ${confirmed[0].file}${confirmed[0].a ? `:${confirmed[0].a}` : ""} ${confirmed[0].title}); \`work ${confirmed[0].id}\` and research before editing`);
    if (state.checkCommand && lastEdit && !(state.runs ?? []).some((r) => passed(r) && r.cmd === state.checkCommand && r.at > lastEdit)) {
      problems.push(`the static check "${state.checkCommand}" has not passed since the last edit (${lastEdit}); run it exactly as set`);
    }
  }
  if (state.phase === "apptest") {
    problems.push(...apptestProblems(root, state));
    const round = currentRound(state);
    if (!problems.length && round && lastEdit && round.startedAt < lastEdit) problems.push(`the code changed after round ${round.n} started; start a new round with \`phase apptest\``);
    if (!problems.length && suspected.length) problems.push(`the app test found ${suspected.length} problems (first ${suspected[0].id}); trace each to its code and run \`phase verify\``);
    if (!problems.length && state.mode === "fix" && confirmed.length) problems.push(`${confirmed.length} confirmed findings are not fixed; run \`phase fix\``);
  }
  return problems;
}

function nextAction(root, state) {
  if (state.phase === "done") return "The review is finished; see .whole-review/REPORT.md.";
  if (!state.active) return `The review is paused. Run \`${RUN_PREFIX} resume\` to continue.`;
  if (state.phase === "read") {
    const rel = currentFile(state);
    if (!rel) return `Every file is read. Run \`${RUN_PREFIX} phase verify\`.`;
    const e = state.files[rel];
    const chunk = suggestChunk(root, rel, e);
    if (chunk) return `Read ${rel} with offset ${chunk.start} and limit ${chunk.limit} (lines ${chunk.start}-${chunk.end} of ${e.lines}), research on the internet every library, language or platform behaviour it relies on (WebFetch the official docs), then describe those lines in ${STATE_DIR}/notes/${rel}.md (\`note ${rel}\` creates it).`;
    const missing = longLinesMissing(e);
    if (missing.length) return `${rel}: lines ${missing.slice(0, 10).join(", ")} exceed ${READ_LINE_CHAR_LIMIT} characters; read them with \`${RUN_PREFIX} show ${rel} <a> <b>\`.`;
    const np = noteProblems(root, rel, e);
    if (np.length) return `${rel} is fully read; complete its note: ${np[0]}. Then \`${RUN_PREFIX} done ${rel}\`.`;
    return `Run \`${RUN_PREFIX} done ${rel}\`.`;
  }
  const work = openWork(root, state);
  if (work.length) return `${work[0]}.${work.length > 1 ? ` (${work.length - 1} more open items; \`status\` lists them)` : ""}`;
  if (state.phase === "verify") return state.mode === "fix" ? `Every finding is decided. Run \`${RUN_PREFIX} phase fix\`.` : `Every finding is decided. Run \`${RUN_PREFIX} phase apptest\`.`;
  if (state.phase === "fix") return `The code work is done. Run \`${RUN_PREFIX} phase apptest\` and test the application.`;
  return `The app test round is complete and nothing is open. Run \`${RUN_PREFIX} finish\`.`;
}

// ---------------------------------------------------------------- context restoration

function capped(text, max) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}\n… (cut; Read the file for the rest)` : t;
}

function relatedFiles(root, state, rel) {
  const text = readNote(root, rel) ?? "";
  const note = parseNote(text);
  const out = [];
  for (const m of note.depends.matchAll(/[\w@./\\-]+\.[\w]+/g)) {
    const key = relKey(root, state, m[0]) ?? relKey(root, state, path.join(path.dirname(rel), m[0]));
    if (key && key !== rel && !out.includes(key)) out.push(key);
  }
  return out;
}

function contextText(root, state, reason) {
  const t = totals(state);
  const p = paths(root);
  const findings = readFindings(root);
  const sections = [];
  sections.push([
    `WHOLE-CODEBASE REVIEW IN PROGRESS (${reason}). Restored from ${toPosix(p.dir)} by the reviewing-whole-codebase skill; the files there are the memory of the work.`,
    `Goal: ${state.goal || "(none given)"} · mode ${state.mode} · phase ${state.phase}${state.active ? "" : " · PAUSED"}${state.checkCommand ? ` · static check: ${state.checkCommand}` : ""}${state.work ? ` · working on ${state.work.finding}` : ""}`,
    `Progress: ${t.read} of ${t.toRead} files read (${t.skipped} skipped), ${t.linesCovered} of ${t.lines} lines covered. Findings: ${JSON.stringify(countBy(findings.list, "status"))}.`,
    `NEXT ACTION: ${nextAction(root, state)}`,
  ].join("\n"));
  sections.push([
    "Rules until finish:",
    "- Read every file to its last line with the Read tool, in the chunks given; only ranges recorded by the hook count. Describe each chunk in the file's note before reading the next.",
    "- Facts about files read before this point come from their notes (notes/<path>.md) or a new Read, never from memory.",
    "- Each problem goes into FINDINGS.md at once with path:line, What:, Proof:, Effect:. No code changes before phase fix (a hook blocks them).",
    "- Research on the internet all the time: WebFetch the official docs for every library, language or platform behaviour a file, a decision or a fix relies on, as you meet it; never rely on memory. Each code file note, each decision (Source:) and each fix (Fix source:) must cite pages opened for it; `work F-xxxx` before researching a finding.",
    "- Nothing is run, tested or measured before phase apptest (a hook blocks it); the app is tested in Chrome with browser.mjs (human gestures, screenshots) only after the code work.",
    `- Script: ${RUN_PREFIX} <status|next|note|done|show|skip|work|phase|set-check|set-app|finish>. Browser: node "${SKILL_DIR}/scripts/browser.mjs". Method: ${SKILL_DIR}/SKILL.md, references/method.md, references/app-testing.md.`,
  ].join("\n"));
  let rel = state.phase === "read" ? currentFile(state) : null;
  if (rel) {
    const e = state.files[rel];
    const note = readNote(root, rel);
    sections.push(`Current file ${rel}: lines covered ${JSON.stringify(mergeRanges(e.ranges))} of ${e.lines}.${note ? ` Its note so far:\n${capped(note, 2600)}` : " No note yet."}`);
  } else if (state.phase === "verify" || state.phase === "fix") {
    const wanted = state.phase === "verify" ? "suspected" : "confirmed";
    const focus = findings.list.find((f) => f.status === wanted);
    rel = focus ? relKey(root, state, focus.file) : null;
    const note = rel ? readNote(root, rel) : null;
    if (focus) sections.push(`Finding in hand ${focus.heading}\n${Object.entries(focus.fields).map(([k, v]) => `${k}: ${v}`).join("\n")}${note ? `\nNote of ${rel}:\n${capped(note, 2000)}` : ""}`);
  }
  if (state.phase === "apptest") {
    const round = currentRound(state);
    const ap = apptestProblems(root, state);
    sections.push(`App test round ${round?.n ?? "-"} (${state.apptest?.app?.url ?? "app not declared"}): ${ap.length ? ap.slice(0, 4).join("; ") : "complete"}.${round ? ` Files: ${toPosix(roundPath(root, round))}/ (shots/, log.jsonl, ANALYSIS.md).` : ""}`);
  }
  const cursor = (() => { try { return fs.readFileSync(p.cursor, "utf8"); } catch { return ""; } })();
  if (cursor.trim()) sections.push(`CURSOR.md:\n${capped(cursor, 1400)}`);
  const open = findings.list.filter((f) => f.status === "suspected" || f.status === "confirmed").map((f) => `- ${f.heading}${f.fields.Check ? ` (check: ${f.fields.Check})` : ""}`);
  if (open.length) sections.push(`Open findings (${open.length}; all in FINDINGS.md):\n${capped(open.join("\n"), 2200)}`);
  const related = rel ? relatedFiles(root, state, rel).filter((r) => state.files[r].status === "read") : [];
  const recent = state.order.filter((r) => state.files[r].status === "read" && state.files[r].lines > 0).slice(-12);
  const shown = [...new Set([...related, ...recent])].map((r) => `- ${r}: ${state.files[r].summary ?? ""}`);
  if (shown.length) sections.push(`Files already read that matter now (related to the current file, then the latest; all in INDEX.md):\n${capped(shown.join("\n"), 1800)}`);
  sections.push(`Before the next step, Read in full: ${toPosix(p.cursor)} and ${toPosix(p.findings)}; open INDEX.md and the notes of any file you need.`);
  let text = sections.join("\n\n");
  if (text.length > CONTEXT_BUDGET) text = `${text.slice(0, CONTEXT_BUDGET - 90)}\n… (cut at the hook limit; Read CURSOR.md, FINDINGS.md and INDEX.md)`;
  return text;
}

// ---------------------------------------------------------------- hooks: install

function hookConfig() {
  const handler = [{ type: "command", command: `${RUN_PREFIX} hook ${HOOK_TOKEN}`, timeout: 30 }];
  return {
    SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: handler }],
    PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*", hooks: handler }],
    PostToolUse: [{ matcher: "Read|Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|WebFetch|WebSearch", hooks: handler }],
    PostToolUseFailure: [{ matcher: "Bash|PowerShell", hooks: handler }],
    Stop: [{ hooks: handler }],
    PreCompact: [{ matcher: "manual|auto", hooks: handler }],
    PostCompact: [{ matcher: "manual|auto", hooks: handler }],
  };
}

function permissionRules(root) {
  return [`Edit(${absPosixRule(path.join(root, STATE_DIR))}/**)`, `Bash(${RUN_PREFIX} *)`, `PowerShell(${RUN_PREFIX} *)`];
}

function settingsFile(root) {
  return path.join(root, ".claude", "settings.local.json");
}

function updateSettings(root, state, install) {
  const file = settingsFile(root);
  const backup = `${file}.whole-review.bak`;
  let data = {};
  if (install && state.settingsCreated === undefined) state.settingsCreated = !fs.existsSync(file);
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    try {
      data = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      fail(`${file} is not valid JSON (${error.message}); fix it first. Nothing was changed.`);
    }
    if (install && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(`${file} root must be a JSON object.`);
  data.hooks ??= {};
  const ours = hookConfig();
  for (const event of Object.keys(ours)) {
    const kept = (Array.isArray(data.hooks[event]) ? data.hooks[event] : [])
      .filter((g) => !(g?.hooks ?? []).some((h) => String(h?.command ?? "").includes(HOOK_TOKEN)));
    if (install) data.hooks[event] = [...kept, ...ours[event]];
    else if (kept.length) data.hooks[event] = kept;
    else delete data.hooks[event];
  }
  if (!Object.keys(data.hooks).length) delete data.hooks;
  data.permissions ??= {};
  const allow = Array.isArray(data.permissions.allow) ? data.permissions.allow : [];
  if (install) {
    const added = permissionRules(root).filter((r) => !allow.includes(r));
    data.permissions.allow = [...allow, ...added];
    state.addedPermissions = [...new Set([...(state.addedPermissions ?? []), ...added])];
  } else {
    data.permissions.allow = allow.filter((r) => !(state.addedPermissions ?? []).includes(r));
    state.addedPermissions = [];
  }
  if (!data.permissions.allow.length) delete data.permissions.allow;
  if (!Object.keys(data.permissions).length) delete data.permissions;
  if (!install) {
    fs.rmSync(backup, { force: true });
    if (state.settingsCreated && !Object.keys(data).length) {
      // The file did not exist before the review and nothing else was added to it: leave no trace.
      fs.rmSync(file, { force: true });
      return `${toPosix(file)} (deleted: it was created by this review and is now empty)`;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return toPosix(file);
}

// ---------------------------------------------------------------- lock
// Hooks of tool calls made in parallel run at the same time; every read-modify-write of state.json
// happens under this lock so no update is lost.

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(root, fn) {
  const lock = path.join(root, STATE_DIR, ".lock");
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > 30000) fs.rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`${lock} is held by another ledger process for more than 15 s`);
      else sleepMs(20);
    }
  }
  const release = () => fs.rmSync(lock, { recursive: true, force: true });
  process.once("exit", release);
  try {
    return fn();
  } finally {
    release();
    process.removeListener("exit", release);
  }
}

// ---------------------------------------------------------------- hooks: handlers

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function hookOut(event, text) {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

function findingsPointingAt(root, rel) {
  return readFindings(root).list.filter((f) => (f.status === "suspected" || f.status === "confirmed")
    && (f.fields.Check ?? "").includes(rel) && f.file !== rel);
}

function onRead(root, state, payload) {
  const target = payload.tool_input?.file_path;
  const relAny = target ? toPosix(path.relative(root, path.resolve(root, target))) : "";
  if (under(relAny, `${STATE_DIR}/apptest`) && /\.(png|jpe?g|webp)$/i.test(relAny)) {
    // A screenshot was looked at: record it, so every screenshot of a round must be seen.
    state.apptest ??= { rounds: [] };
    state.apptest.viewed = [...new Set([...(state.apptest.viewed ?? []), relAny])];
    return hookOut("PostToolUse", `[whole-review] Write in ANALYSIS.md, under its scenario, a line for ${path.basename(relAny)}: what the screen shows, and every defect of any kind (function, layout, text, contrast, alignment, feedback, usability); each defect also goes into FINDINGS.md as suspected with "Evidence: ${path.basename(relAny)}".`);
  }
  const rel = relKey(root, state, target);
  if (!rel) return null;
  const entry = state.files[rel];
  if (entry.status === "skipped") return null;
  const file = payload.tool_response?.file;
  const count = Number(file?.numLines ?? 0);
  if (!(count > 0)) {
    return hookOut("PostToolUse", `[whole-review] Read returned no text lines for ${rel} (type ${payload.tool_response?.type ?? "unknown"}); read it with \`${RUN_PREFIX} show ${rel} 1 ${entry.lines}\`.`);
  }
  const start = Number(file.startLine ?? payload.tool_input?.offset ?? 1);
  const range = [start, start + count - 1];
  if (state.phase === "read" && entry.status !== "read" && fileChanged(root, rel, entry)) {
    Object.assign(entry, fileEntry(fs.readFileSync(path.join(root, rel))), { status: "unread" });
  }
  const before = contiguousEnd(entry.ranges);
  entry.ranges = mergeRanges([...entry.ranges, range]);
  entry.firstReadAt ??= now();
  if (state.phase !== "read") entry.verifyReads = mergeRanges([...entry.verifyReads, range]);
  if (entry.edits.length) entry.postEditReads = mergeRanges([...entry.postEditReads, range]);
  if (entry.status === "unread") entry.status = "reading";
  saveState(root, state);
  writeViews(root, state);

  const parts = [];
  if (entry.status === "read") {
    const note = readNote(root, rel);
    if (note) parts.push(`You studied ${rel} before; its note:\n${capped(note, 1500)}`);
  } else if (state.phase === "read") {
    const note = readNote(root, rel);
    const described = note ? contiguousEnd(parseNote(note).entries.map((e) => [e.a, e.b])) : 0;
    parts.push(`${rel}: lines ${JSON.stringify(entry.ranges)} of ${entry.lines} read.`);
    if (before > described) parts.push(`WARNING: the note describes lines 1-${described} but lines 1-${before} were read before this chunk; describe ${described + 1}-${before} now, from the file, before going on.`);
    if (CODE_EXT.test(rel)) parts.push(`Research now, on the internet, the behaviour of every library, language feature and platform API these lines use (WebFetch the official docs for the installed version); do not rely on memory. Cite the pages in the note's "## Sources" section.`);
    parts.push(`Describe lines ${range[0]}-${range[1]} in ${STATE_DIR}/notes/${rel}.md${note ? "" : ` (create it with \`${RUN_PREFIX} note ${rel}\`)`} and put every problem seen in FINDINGS.md.`);
    const chunk = suggestChunk(root, rel, entry);
    if (chunk) parts.push(`Then Read offset ${chunk.start}, limit ${chunk.limit}.`);
    else if (longLinesMissing(entry).length) parts.push(`Lines ${longLinesMissing(entry).slice(0, 10).join(", ")} were cut by Read; use \`${RUN_PREFIX} show ${rel} <a> <b>\`.`);
    else parts.push(`The file is fully read: complete the note (Summary, every line range, contracts, depends on / used by, sources) and run \`${RUN_PREFIX} done ${rel}\`.`);
  }
  const pointing = findingsPointingAt(root, rel).map((f) => `- ${f.heading} (check: ${f.fields.Check})`);
  if (pointing.length) parts.push(`Open findings that ask to check this file:\n${capped(pointing.join("\n"), 1500)}`);
  return hookOut("PostToolUse", parts.length ? `[whole-review] ${parts.join("\n")}` : null);
}

function onEdit(root, state, payload) {
  const target = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  const rel = relKey(root, state, target);
  if (target && path.resolve(root, target) === path.resolve(paths(root).findings)) {
    // Remember every finding id ever written, so a finding cannot disappear instead of being rejected.
    state.seenFindings = [...new Set([...(state.seenFindings ?? []), ...readFindings(root).list.map((f) => f.id)])];
  }
  if (!rel) {
    if (target && insideProject(root, target) && !under(toPosix(path.relative(root, path.resolve(root, target))), STATE_DIR)) {
      const created = toPosix(path.relative(root, path.resolve(root, target)));
      state.createdFiles = [...new Set([...(state.createdFiles ?? []), created])];
    }
    return null;
  }
  const entry = state.files[rel];
  entry.edits = [...entry.edits, { at: now(), finding: state.phase === "fix" ? state.work?.finding ?? null : null }].slice(-80);
  entry.postEditReads = [];
  const users = state.order.filter((r) => r !== rel && (readNote(root, r) ?? "").includes(rel)).slice(0, 15);
  return hookOut("PostToolUse", `[whole-review] ${rel} changed. Re-read the changed lines (Read them again: that is recorded) and update ${STATE_DIR}/notes/${rel}.md where it is now wrong.${users.length ? ` Notes that mention it (check these callers/users): ${users.join(", ")}.` : ""}`);
}

function onResearch(state, payload, tool) {
  // Every page opened and every search made is recorded with the phase, the finding in hand and the
  // file being read, so each citation can be checked against research done for that purpose.
  const entry = { tool, at: now(), phase: state.phase, finding: state.work?.finding ?? null, file: state.phase === "read" ? currentFile(state) : null };
  if (tool === "WebFetch") {
    entry.url = normalizeUrl(payload.tool_input?.url);
    entry.finalUrl = normalizeUrl(payload.tool_response?.url ?? payload.tool_input?.url);
    entry.code = payload.tool_response?.code ?? null;
  } else {
    entry.query = String(payload.tool_input?.query ?? "");
    entry.urls = (payload.tool_response?.results ?? []).flatMap((r) => (Array.isArray(r?.content) ? r.content : [])).map((c) => normalizeUrl(c?.url)).filter(Boolean).slice(0, 20);
  }
  state.research = [...(state.research ?? []), entry].slice(-3000);
}

function onRun(state, payload, ok) {
  const cmd = String(payload.tool_input?.command ?? "").trim();
  if (!cmd || cmd.includes("ledger.mjs")) return;
  const exit = ok ? 0 : Number((/^Exit code (\d+)/.exec(String(payload.error ?? "")) ?? [])[1] ?? -1);
  state.runs = [...(state.runs ?? []), { cmd, ok, exit, at: now(), phase: state.phase, masked: exitMasked(cmd) }].slice(-RUN_LOG_CAP);
}

function exitMasked(cmd) {
  // A pipe reports the exit code of its last command, and `|| true`, `; true` or `; exit 0` hide a failure:
  // such a run says nothing about whether the command before it passed.
  return /(^|[^|])\|(?!\|)/.test(cmd) || /\|\|\s*(true|:|exit\s+0)\b/.test(cmd) || /;\s*(true|exit\s+0)\s*$/.test(cmd);
}

function passed(r) {
  return r.ok && !r.masked;
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[whole-review] ${reason}` } };
}

function onPreEdit(root, state, payload) {
  const target = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!target || !insideProject(root, target)) return null;
  const rel = toPosix(path.relative(root, path.resolve(root, target)));
  if (under(rel, STATE_DIR)) return null;
  if (state.mode === "audit") return deny("This review is in audit mode: project files are not changed. Record the problem in FINDINGS.md instead.");
  if (state.phase !== "fix") {
    return deny(state.phase === "apptest"
      ? "No code changes during the app test. Record each defect in FINDINGS.md (suspected, with Evidence: <screenshot>), then `phase verify` and `phase fix`."
      : `Project files are changed only in phase fix (now: ${state.phase}). Record the problem in FINDINGS.md; it is fixed after every file is read and every finding verified.`);
  }
  const id = state.work?.finding;
  if (!id) return deny("Say which finding this change implements first: `work F-xxxx`, then research it on the internet (WebFetch the official docs), then edit.");
  const f = readFindings(root).list.find((x) => x.id === id);
  if (!f || f.status !== "confirmed") return deny(`${id} is ${f ? f.status : "not in FINDINGS.md"}; only confirmed findings are implemented. Pick a confirmed one with \`work\`.`);
  if (!researchSince(state, state.work.at, (r) => r.tool === "WebFetch" && r.finding === id && r.phase === "fix").length) {
    return deny(`No internet research for ${id} since \`work ${id}\`: WebFetch the official documentation of what this change relies on (API, language rule, platform behaviour), then edit. Never implement from memory.`);
  }
  return null;
}

function stripCd(cmd) {
  // `cd "<dir>" && <command>` is how a session pins the working directory; judge the command after it.
  return cmd.trim().replace(/^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/, "").trim();
}

function onPreRun(root, state, payload) {
  const cmd = stripCd(String(payload.tool_input?.command ?? ""));
  if (!cmd) return null;
  const browserPrefix = `node "${SKILL_DIR}/scripts/browser.mjs"`;
  const single = !/(&&|\|\||;|\||`|\$\()/.test(cmd.replace(/"[^"]*"|'[^']*'/g, ""));
  const ok = (cmd.startsWith(RUN_PREFIX) && single)
    || cmd === `npm install --prefix "${SKILL_DIR}" playwright-core`
    || (single && ALWAYS_ALLOWED.some((re) => re.test(cmd)))
    || (state.checkCommand && cmd === state.checkCommand)
    || (state.phase === "apptest" && single && cmd.startsWith(browserPrefix))
    || (state.phase === "apptest" && state.apptest?.app && [state.apptest.app.start, state.apptest.app.suite].filter(Boolean).includes(cmd));
  if (ok) return null;
  return deny(state.phase === "apptest"
    ? `During the app test only the declared start command, the declared test suite, ${browserPrefix} and the static check run; no measurements or benchmarks. Use the app through the browser.`
    : `Nothing is run, tested or measured before phase apptest: the work is done by reading the code and researching on the internet. Allowed now: the ledger, the static check${state.checkCommand ? ` (${state.checkCommand})` : ""}, git status/diff/log/show, ls, version queries. Command refused: ${cmd.slice(0, 160)}`);
}

function onPreTool(root, state, payload) {
  if (!state.active || state.phase === "done") return null;
  const tool = String(payload.tool_name ?? "");
  if (tool === "Bash" || tool === "PowerShell") return onPreRun(root, state, payload);
  if (tool.startsWith("mcp__")) {
    return BROWSER_TOOLS.test(tool)
      ? deny(`Browser automation tools give robotic gestures; the application is tested only in phase apptest with node "${SKILL_DIR}/scripts/browser.mjs" (human pointer paths, real clicks, drags, typing, screenshots).`)
      : null;
  }
  return onPreEdit(root, state, payload);
}

function onStop(root, state, payload) {
  if (!state.active || state.phase === "done") return null;
  // Background work that will wake the session lets it pause; the app's own server, kept running for the
  // app test, does not count (it never finishes, and would switch this hook off for the whole test).
  const appStart = stripCd(String(state.apptest?.app?.start ?? ""));
  const waiting = (payload.background_tasks ?? []).filter((t) => !(appStart && t?.type === "shell" && stripCd(String(t.command ?? "")) === appStart));
  if (waiting.length) return null;
  if (payload.stop_hook_active && state.lastBlockProgress === state.progress) {
    // Already held once and nothing was done since: let it stop so the session cannot spin forever.
    state.stalledAt = now();
    saveState(root, state);
    return null;
  }
  state.lastBlockProgress = state.progress;
  saveState(root, state);
  return { decision: "block", reason: `[whole-review] The review is not finished. NEXT: ${nextAction(root, state)} (To stop on purpose, the user asks to pause; then run \`${RUN_PREFIX} pause\`.)` };
}

function runHook() {
  const payload = readStdin();
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  if (!root) return;
  withLock(root, () => handleHook(root, payload));
}

function handleHook(root, payload) {
  const state = loadState(root);
  const event = String(payload.hook_event_name ?? "");
  const tool = String(payload.tool_name ?? "");
  let out = null;
  if (event === "SessionStart") {
    if (state.phase !== "done") out = hookOut("SessionStart", contextText(root, state, `session ${payload.source ?? "start"}`));
  } else if (event === "PreToolUse") {
    // The edit, command and browser-tool rules apply to subagents too.
    out = onPreTool(root, state, payload);
  } else if (event === "PostToolUse" || event === "PostToolUseFailure") {
    // Reads, edits, research and commands made inside subagents do not reach the main context: they never count.
    if (payload.agent_id) return;
    state.progress = (state.progress ?? 0) + 1;
    if (tool === "Read") out = onRead(root, state, payload);
    else if (tool === "Bash" || tool === "PowerShell") onRun(state, payload, event === "PostToolUse");
    else if (tool === "WebFetch" || tool === "WebSearch") onResearch(state, payload, tool);
    else out = onEdit(root, state, payload);
    saveState(root, state);
  } else if (event === "Stop") {
    out = onStop(root, state, payload);
  } else if (event === "PreCompact") {
    state.compactions = [...(state.compactions ?? []), { at: now(), trigger: payload.trigger ?? null, next: nextAction(root, state) }];
    saveState(root, state);
    writeViews(root, state);
  } else if (event === "PostCompact") {
    const dir = paths(root).compactions;
    fs.mkdirSync(dir, { recursive: true });
    const n = String((state.compactions ?? []).length).padStart(3, "0");
    fs.writeFileSync(path.join(dir, `${n}-${payload.trigger ?? "unknown"}.md`), `# Compaction ${n} (${now()})\n\n${payload.compact_summary ?? "(no summary in the hook input)"}\n`, "utf8");
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

// ---------------------------------------------------------------- commands

function cmdInit(flags) {
  const root = path.resolve(typeof flags.project === "string" ? flags.project : process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const p = paths(root);
  if (fs.existsSync(p.state) && !flags.force) {
    const old = JSON.parse(fs.readFileSync(p.state, "utf8"));
    if (old.phase !== "done") fail(`A review is already in progress in ${toPosix(p.dir)} (phase ${old.phase}). Continue it with \`status\`, or init with --force to discard it.`);
  }
  if (flags.force && fs.existsSync(p.dir)) fs.rmSync(p.dir, { recursive: true, force: true });
  fs.mkdirSync(p.notes, { recursive: true });
  const scope = listFlag(flags.scope);
  const { files, order, source } = buildInventory(root, scope, flags);
  const state = {
    version: 2, created: now(), root: toPosix(root), scope, goal: typeof flags.goal === "string" ? flags.goal : "",
    mode: flags.mode === "audit" ? "audit" : "fix", phase: "read", active: true, progress: 0,
    checkCommand: typeof flags.check === "string" ? flags.check.trim() : "", phaseStartedAt: { read: now() },
    inventorySource: source, files, order, runs: [], research: [], work: null, createdFiles: [], compactions: [],
    apptest: { app: null, rounds: [], viewed: [] },
  };
  if (!fs.existsSync(p.findings)) {
    fs.writeFileSync(p.findings, [
      "# Findings",
      "",
      "Heading (parsed by ledger.mjs): `### F-NNNN · status · S1-S4 · path:line — short title`, numbered F-0001, F-0002, ...",
      "Statuses: suspected → confirmed | rejected (phase verify); confirmed → fixed | blocked (phase fix). A defect seen in the app test may start as `app:<screen>` and is traced to its code (path:line) before it is confirmed.",
      "Lines: What:, Proof:, Effect:, Fix plan:, Check: (other file to look at), Evidence: (screenshot of an app-test defect), Source: (URLs opened with WebFetch for the decision, in phase verify, after `work F-NNNN`), Rejected because:, Blocker:, Tried:, Fix: (path:line of each change), Fix source: (URLs opened in phase fix for this fix, before editing), Verified by: (re-read path:a-b of the changed lines after the last edit).",
      "",
    ].join("\n"), "utf8");
  }
  if (!fs.existsSync(p.cursor)) fs.writeFileSync(p.cursor, "# Cursor\n\nWhat I am doing now, the next step, and open questions. Keep it short and current.\n", "utf8");
  const settings = flags["no-install"] ? "hooks not installed (--no-install)" : `hooks and permissions for ${STATE_DIR}/ installed in ${updateSettings(root, state, true)}`;
  saveState(root, state);
  writeViews(root, state);
  const t = totals(state);
  process.stdout.write([
    `Review started in ${toPosix(p.dir)} (mode ${state.mode}${scope.length ? `, scope ${scope.join(", ")}` : ""}).`,
    `Files: ${t.all} listed by ${source}; ${t.toRead} to read (${t.lines} lines), ${t.skipped} skipped.`,
    settings,
    state.checkCommand ? `Static check: ${state.checkCommand}` : "No static check set (add the project's type check or linter with `set-check \"<command>\"` if it has one; tests are not run before phase apptest).",
    "Declare the application for the final test with `set-app --start \"<command>\" --url <url>` (or `set-app --none \"<reason>\"`).",
    `NEXT: ${nextAction(root, state)}`,
  ].join("\n") + "\n");
}

function cmdStatus(flags) {
  const root = requireRoot(flags);
  const state = loadState(root);
  writeViews(root, state);
  const t = totals(state);
  const findings = readFindings(root);
  const work = state.phase === "read" ? [] : openWork(root, state);
  const skipped = state.order.filter((rel) => state.files[rel].status === "skipped").map((rel) => `  - ${rel}: ${state.files[rel].reason}`);
  process.stdout.write([
    `Phase ${state.phase} · mode ${state.mode} · ${state.active ? "active" : "paused"}${state.checkCommand ? ` · check: ${state.checkCommand}` : ""}`,
    `Files read ${t.read}/${t.toRead} · skipped ${t.skipped} · lines covered ${t.linesCovered}/${t.lines}`,
    `Findings ${JSON.stringify(countBy(findings.list, "status"))}`,
    work.length ? `Open items:\n${work.slice(0, 30).map((w) => `  - ${w}`).join("\n")}` : "",
    skipped.length ? `Skipped:\n${skipped.join("\n")}` : "",
    `NEXT: ${nextAction(root, state)}`,
  ].filter(Boolean).join("\n") + "\n");
}

function withFile(flags, positional, fn) {
  const root = requireRoot(flags);
  const state = loadState(root);
  const rel = relKey(root, state, positional[0]);
  if (!rel) fail(`Not in the inventory: ${positional[0]}`);
  return fn(root, state, rel, state.files[rel]);
}

function cmdNote(flags, positional) {
  withFile(flags, positional, (root, state, rel, entry) => {
    const file = notePath(root, rel);
    if (fs.existsSync(file)) {
      process.stdout.write(`Note exists: ${toPosix(file)}\n`);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, noteTemplate(rel, entry), "utf8");
    process.stdout.write(`Note created: ${toPosix(file)}. Replace every ${NOTE_PLACEHOLDER}; the Structure section must list every line range from 1 to ${requiredLastLine(entry)} with what it holds.\n`);
  });
}

function cmdDone(flags, positional) {
  withFile(flags, positional, (root, state, rel, entry) => {
    if (entry.status === "skipped") fail(`${rel} is skipped (${entry.reason}).`);
    if (state.phase === "read" && fileChanged(root, rel, entry)) fail(`${rel} changed on disk since it was listed; Read it again (that resets its record).`);
    const gap = firstGap(entry.ranges, requiredLastLine(entry));
    if (gap !== null) fail(`${rel} is not fully read: line ${gap} of ${entry.lines} was never returned by Read. Read from offset ${gap}.`);
    const missing = longLinesMissing(entry);
    if (missing.length) fail(`${rel}: lines ${missing.slice(0, 20).join(", ")} exceed ${READ_LINE_CHAR_LIMIT} characters and were cut by Read; run \`show ${rel} <a> <b>\` over them.`);
    const problems = noteProblems(root, rel, entry);
    if (CODE_EXT.test(rel)) {
      // A code file is understood only with the semantics of what it uses checked on the internet while reading it.
      const opened = fetchedUrls(state, (r) => r.file === rel && r.phase === "read");
      const cited = citedUrls((parseNote(readNote(root, rel) ?? "").sections.sources ?? []).join("\n"));
      if (!cited.some((u) => opened.has(u))) problems.push(`the "## Sources" section must list pages opened with WebFetch while reading this file (official docs of the libraries, language features and APIs it uses); ${opened.size ? `opened for it so far: ${[...opened].slice(0, 5).join(", ")}` : "none opened for it yet"}`);
    }
    if (problems.length) fail(`${rel}: the note is not complete:\n${problems.map((x) => `- ${x}`).join("\n")}`);
    entry.status = "read";
    entry.doneAt = now();
    entry.summary = parseNote(readNote(root, rel)).summary;
    saveState(root, state);
    writeViews(root, state);
    process.stdout.write(`${rel} marked read. NEXT: ${nextAction(root, state)}\n`);
  });
}

function cmdShow(flags, positional) {
  withFile(flags, positional, (root, state, rel, entry) => {
    const lines = fs.readFileSync(path.join(root, rel), "utf8").split("\n");
    const a = Math.max(1, Number(positional[1] ?? 1));
    const b = Math.min(lines.length, Number(positional[2] ?? lines.length));
    let used = 0;
    let last = a - 1;
    const out = [];
    for (let n = a; n <= b; n += 1) {
      const text = lines[n - 1].replace(/\r$/, "");
      const pieces = [];
      for (let i = 0; i < Math.max(text.length, 1); i += SHOW_WRAP) pieces.push(text.slice(i, i + SHOW_WRAP));
      const block = pieces.map((piece, i) => `${i === 0 ? String(n).padStart(6) : "     ↳"}\t${piece}`).join("\n");
      if (used + block.length > SHOW_MAX_CHARS && n > a) break;
      out.push(block);
      used += block.length + 1;
      last = n;
    }
    if (last >= a) {
      entry.ranges = mergeRanges([...entry.ranges, [a, last]]);
      entry.showRanges = mergeRanges([...entry.showRanges, [a, last]]);
      if (state.phase !== "read") entry.verifyReads = mergeRanges([...entry.verifyReads, [a, last]]);
      if (entry.edits.length) entry.postEditReads = mergeRanges([...entry.postEditReads, [a, last]]);
      if (entry.status === "unread") entry.status = "reading";
      state.progress = (state.progress ?? 0) + 1;
      saveState(root, state);
      writeViews(root, state);
    }
    process.stdout.write(`${out.join("\n")}\n`);
    if (last < b) process.stdout.write(`\n[shown ${a}-${last}; continue with: show ${rel} ${last + 1} ${b}]\n`);
  });
}

function cmdSkip(flags, positional) {
  withFile(flags, positional, (root, state, rel, entry) => {
    if (typeof flags.reason !== "string" || flags.reason.trim().length < 15) fail('skip needs --reason "<why this file is not read>" (15+ characters); it goes into the final report.');
    Object.assign(entry, { status: "skipped", reason: flags.reason.trim() });
    saveState(root, state);
    writeViews(root, state);
    process.stdout.write(`${rel} skipped. NEXT: ${nextAction(root, state)}\n`);
  });
}

function cmdSetCheck(flags, positional) {
  // Sets the project check (it does not run it: run the command itself with Bash so the hook records it).
  const root = requireRoot(flags);
  const state = loadState(root);
  const cmd = positional.join(" ").trim();
  if (!cmd) fail('Usage: set-check "<exact command>". This only sets the command; run it yourself with Bash so the hook records the result. The check cannot be removed.');
  if (state.phase === "fix" || state.phase === "done") {
    if (typeof flags.reason !== "string" || flags.reason.trim().length < 15) fail('Changing the project check during phase fix needs --reason "<why the old command is wrong>"; the change goes into the report.');
  }
  state.checkChanges = [...(state.checkChanges ?? []), { at: now(), from: state.checkCommand, to: cmd, phase: state.phase, reason: typeof flags.reason === "string" ? flags.reason.trim() : "" }];
  state.checkCommand = cmd;
  saveState(root, state);
  process.stdout.write(`Project check set to: ${cmd}\nIt must pass after the last edit before finish. Run it with Bash exactly as written.\n`);
}

function cmdPhase(flags, positional) {
  const root = requireRoot(flags);
  const state = loadState(root);
  const target = positional[0];
  const notDone = (what) => {
    const work = openWork(root, state);
    if (work.length) fail(`${what} is not complete:\n${work.slice(0, 20).map((w) => `- ${w}`).join("\n")}`);
  };
  if (target === "verify") {
    if (state.phase === "read") {
      const rel = currentFile(state);
      if (rel) fail(`Not every file is read. NEXT: ${nextAction(root, state)}`);
    } else if (state.phase === "apptest") {
      const ap = apptestProblems(root, state);
      if (ap.length) fail(`The app-test round is not complete:\n${ap.map((w) => `- ${w}`).join("\n")}`);
      if (!readFindings(root).list.some((f) => f.status === "suspected")) fail("No suspected finding to verify; if the round found nothing, run `finish`.");
    } else {
      fail(`phase verify comes after phase read or phase apptest (now ${state.phase}).`);
    }
  } else if (target === "fix") {
    if (state.mode !== "fix") fail("This review is in audit mode; it does not change code.");
    if (state.phase !== "verify") fail(`phase fix comes after phase verify (now ${state.phase}).`);
    notDone("Verification");
  } else if (target === "apptest") {
    const from = state.mode === "fix" ? ["fix", "apptest"] : ["verify", "apptest"];
    if (!from.includes(state.phase)) fail(`phase apptest comes after phase ${from[0]} (now ${state.phase}): the application is tested only when the code work is done.`);
    if (state.phase !== "apptest") notDone(state.phase === "fix" ? "The fix phase" : "Verification");
    if (!state.apptest?.app) fail('Declare the application first: `set-app --start "<command that starts it>" --url <url>` (or `set-app --none "<why there is no UI>"`).');
    const round = currentRound(state);
    if (round && fs.existsSync(path.join(roundPath(root, round), "daemon.json"))) fail(`Chrome is still open for round ${round.n}; run browser.mjs stop first.`);
    const n = (round?.n ?? 0) + 1;
    state.apptest.rounds.push({ n, startedAt: now() });
    fs.mkdirSync(path.join(roundPath(root, { n }), "shots"), { recursive: true });
    fs.writeFileSync(path.join(roundPath(root, { n }), "ANALYSIS.md"), [
      `# App test round ${n}`,
      "",
      "One section per user task, as a real user would do it. Every screenshot gets a line: what it shows and every defect of any kind.",
      "Every console/page/network error (E-n) gets a line with its cause or its finding.",
      "",
      "## Scenario 1: <user task>",
      "",
    ].join("\n"), "utf8");
  } else {
    fail("Usage: phase verify|fix|apptest");
  }
  state.phase = target;
  state.phaseStartedAt[target] = now();
  state.work = null;
  state.progress = (state.progress ?? 0) + 1;
  saveState(root, state);
  process.stdout.write(`Phase ${target}. NEXT: ${nextAction(root, state)}\n`);
}

function cmdWork(flags, positional) {
  // Names the finding in hand: research, re-reads and edits from now on are attributed to it.
  const root = requireRoot(flags);
  const state = loadState(root);
  const id = String(positional[0] ?? "").toUpperCase();
  const f = readFindings(root).list.find((x) => x.id === id);
  if (!f) fail(`No ${id || "finding id"} in FINDINGS.md.`);
  if (state.phase !== "verify" && state.phase !== "fix") fail(`\`work\` is for phase verify or fix (now ${state.phase}).`);
  state.work = { finding: id, at: now(), phase: state.phase };
  state.progress = (state.progress ?? 0) + 1;
  saveState(root, state);
  const todo = state.phase === "verify"
    ? `Re-read ${f.file}${f.a ? `:${f.a}-${f.b}` : ""} and each link of its proof, research on the internet the behaviour it depends on (WebFetch the official docs; cite them in "Source:"), then mark it confirmed or rejected.`
    : `Research on the internet how to fix it correctly (WebFetch the official docs; cite them in "Fix source:"), then edit, re-read the changed lines and their callers, and mark it fixed.`;
  process.stdout.write(`Working on ${f.heading}\n${todo}\n`);
}

function cmdSetApp(flags) {
  const root = requireRoot(flags);
  const state = loadState(root);
  state.apptest ??= { rounds: [], viewed: [] };
  const app = { ...(state.apptest.app ?? {}) };
  if (typeof flags.none === "string") {
    if (flags.none.trim().length < 15) fail('set-app --none needs the reason (15+ characters): why this project has no user interface to test in a browser.');
    Object.assign(app, { none: true, reason: flags.none.trim() });
  } else {
    if (typeof flags.start === "string") app.start = flags.start.trim();
    if (typeof flags.url === "string") app.url = flags.url.trim();
    if (typeof flags.suite === "string") app.suite = flags.suite.trim();
    if (typeof flags["desktop-only"] === "string") {
      if (flags["desktop-only"].trim().length < 15) fail("--desktop-only needs the reason (15+ characters).");
      app.desktopOnly = flags["desktop-only"].trim();
    }
    if (!app.start || !app.url) fail('Usage: set-app --start "<command that starts the app>" --url <url> [--suite "<test suite command>"] [--desktop-only "<reason>"] | set-app --none "<reason>"');
    app.none = false;
  }
  state.apptest.app = app;
  saveState(root, state);
  process.stdout.write(`Application: ${JSON.stringify(app)}\n`);
}

function cmdActive(flags, active) {
  const root = requireRoot(flags);
  const state = loadState(root);
  state.active = active;
  saveState(root, state);
  process.stdout.write(`${active ? "Resumed" : "Paused"}. ${active ? "Edits stay blocked outside phase fix and the Stop hook keeps the work going." : "The Stop and edit hooks stand aside; SessionStart still reports the state."}\n`);
}

function cmdFinish(flags) {
  const root = requireRoot(flags);
  const state = loadState(root);
  if (state.phase !== "apptest") fail(`finish comes after the application test (phase apptest); now phase ${state.phase}. NEXT: ${nextAction(root, state)}`);
  const work = openWork(root, state);
  if (work.length) fail(`Cannot finish:\n${work.slice(0, 30).map((w) => `- ${w}`).join("\n")}`);
  const findings = readFindings(root).list;
  const t = totals(state);
  const skipped = state.order.filter((rel) => state.files[rel].status === "skipped").map((rel) => `- ${rel}: ${state.files[rel].reason}`);
  const uniform = [];
  for (const rel of state.order) {
    const note = readNote(root, rel);
    if (note) for (const e of parseNote(note).entries) if (e.uniform) uniform.push(`- ${rel}:${e.a}-${e.b} ${e.desc}`);
  }
  const outside = state.order.filter((rel) => {
    const e = state.files[rel];
    return e.status === "read" && e.lines > 0 && !e.edits.length && fileChanged(root, rel, e);
  });
  const checkRuns = (state.runs ?? []).filter((r) => r.cmd === state.checkCommand);
  const research = state.research ?? [];
  const fetchedCount = research.filter((r) => r.tool === "WebFetch").length;
  const byPhase = countBy(research.map((r) => ({ p: r.phase })), "p");
  const roundLines = (state.apptest?.rounds ?? []).map((r) => {
    const log = roundLog(root, r);
    const shots = log.filter((e) => e.kind === "shot");
    const errors = log.filter((e) => e.kind === "error");
    const acts = countBy(log.filter((e) => e.kind === "action").map((e) => ({ a: e.action })), "a");
    const vps = [...new Set(shots.map((x) => x.viewport))].join(", ") || "none";
    return `- round ${r.n} (started ${r.startedAt}): ${shots.length} screenshots (${vps}), gestures ${JSON.stringify(acts)}, ${errors.length} console/page/network errors; analysis in ${toPosix(path.relative(root, path.join(roundPath(root, r), "ANALYSIS.md")))}`;
  });
  const report = [
    "# Whole-codebase review report",
    "",
    `Goal: ${state.goal || "(none given)"} · mode ${state.mode} · started ${state.created} · finished ${now()}`,
    `Files listed: ${t.all} (${state.inventorySource}${state.scope.length ? `, scope ${state.scope.join(", ")}` : ""}). Read to the last line, with a note covering every line: ${t.read} of ${t.toRead}. Lines: ${t.linesCovered} of ${t.lines}.`,
    `Compactions during the work: ${(state.compactions ?? []).length}. Commands recorded: ${(state.runs ?? []).length}.`,
    state.checkCommand ? `Project check \`${state.checkCommand}\`: ${checkRuns.length} runs, last ${checkRuns.length ? (checkRuns[checkRuns.length - 1].ok ? "passed" : "failed") : "never run"}.` : "No project check was set.",
    ...(state.checkChanges ?? []).map((c) => `Project check changed in phase ${c.phase} at ${c.at}: \`${c.from || "(none)"}\` -> \`${c.to}\`${c.reason ? ` (${c.reason})` : ""}.`),
    "",
    "## Internet research",
    `${research.length} searches and page reads recorded (${fetchedCount} pages opened with WebFetch); by phase: ${JSON.stringify(byPhase)}.`,
    "",
    "## Application test",
    state.apptest?.app?.none ? `No browser test: ${state.apptest.app.reason}` : (roundLines.join("\n") || "No round."),
    "",
    "## Not read, and why",
    skipped.length ? skipped.join("\n") : "Nothing.",
    "",
    "## Line ranges described as uniform (not described line by line)",
    uniform.length ? uniform.join("\n") : "None.",
    "",
    "## Files changed outside the Edit/Write tools",
    outside.length ? outside.map((r) => `- ${r}`).join("\n") : "None.",
    "",
    "## New files created",
    (state.createdFiles ?? []).length ? state.createdFiles.map((r) => `- ${r}`).join("\n") : "None.",
    "",
    "## Findings by status",
    Object.entries(countBy(findings, "status")).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "No findings.",
    "",
    "## Findings",
    findings.map((f) => `- ${f.heading}${f.fields.Source ? `\n  Source: ${f.fields.Source}` : ""}${f.fields.Evidence ? `\n  Evidence: ${f.fields.Evidence}` : ""}${f.fields.Fix ? `\n  Fix: ${f.fields.Fix}\n  Fix source: ${f.fields["Fix source"] ?? ""}\n  Verified by: ${f.fields["Verified by"] ?? ""}` : ""}${f.fields.Blocker ? `\n  Blocker: ${f.fields.Blocker}` : ""}${f.fields["Rejected because"] ? `\n  Rejected because: ${f.fields["Rejected because"]}` : ""}`).join("\n") || "None.",
    "",
  ].join("\n");
  fs.writeFileSync(paths(root).report, report, "utf8");
  state.phase = "done";
  state.active = false;
  const file = updateSettings(root, state, false);
  saveState(root, state);
  writeViews(root, state);
  process.stdout.write(`${report}\nHooks and permissions removed from ${file}. Report: ${toPosix(paths(root).report)}\n`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  // Commands that change state.json run under the same lock as the hooks.
  const locked = (fn) => withLock(requireRoot(flags), fn);
  switch (command) {
    case "hook": return runHook();
    case "init": return cmdInit(flags);
    case "status": return locked(() => cmdStatus(flags));
    case "next": { const root = requireRoot(flags); process.stdout.write(`${nextAction(root, loadState(root))}\n`); return undefined; }
    case "note": return cmdNote(flags, positional);
    case "done": return locked(() => cmdDone(flags, positional));
    case "show": return locked(() => cmdShow(flags, positional));
    case "skip": return locked(() => cmdSkip(flags, positional));
    case "set-check": return locked(() => cmdSetCheck(flags, positional));
    case "set-app": return locked(() => cmdSetApp(flags));
    case "work": return locked(() => cmdWork(flags, positional));
    case "phase": return locked(() => cmdPhase(flags, positional));
    case "pause": return locked(() => cmdActive(flags, false));
    case "resume": return locked(() => cmdActive(flags, true));
    case "finish": return locked(() => cmdFinish(flags));
    case "install": case "uninstall": {
      const root = requireRoot(flags);
      const state = loadState(root);
      const file = updateSettings(root, state, command === "install");
      saveState(root, state);
      process.stdout.write(`${command === "install" ? "Installed in" : "Removed from"} ${file}\n`);
      return undefined;
    }
    case "context": { const root = requireRoot(flags); process.stdout.write(`${contextText(root, loadState(root), "manual")}\n`); return undefined; }
    default:
      process.stdout.write("Usage: ledger.mjs init [--mode fix|audit] [--goal ...] [--scope a,b] [--exclude a,b] [--check \"cmd\"] [--all] [--force] | status | next | note <file> | done <file> | show <file> [a] [b] | skip <file> --reason ... | set-check <command> | set-app --start <cmd> --url <url> [--suite <cmd>] [--desktop-only <why>] | set-app --none <why> | work F-NNNN | phase verify|fix|apptest | pause | resume | finish | install | uninstall | context | hook\n");
      process.exitCode = command ? 1 : 0;
  }
  return undefined;
}

main();
