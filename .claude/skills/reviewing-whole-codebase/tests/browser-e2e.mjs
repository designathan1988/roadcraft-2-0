#!/usr/bin/env node
// Drives real Google Chrome through browser.mjs on an instrumented page and checks that the gestures
// arrive as a person's would: many uneven pointer moves on a curved path, a pause before each press,
// real drags, uneven key timing, uneven wheel steps, and high-resolution screenshots after each gesture.
// Needs Google Chrome and Playwright (from the project, the skill folder, or NODE_PATH).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BROWSER = path.join(SKILL, "scripts", "browser.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "whole-review-browser-"));
const W = path.join(root, ".whole-review");
fs.mkdirSync(path.join(W, "apptest", "round-1", "shots"), { recursive: true });
fs.writeFileSync(path.join(W, "state.json"), JSON.stringify({ phase: "apptest", apptest: { rounds: [{ n: 1, startedAt: new Date().toISOString() }] } }));

const page = path.join(root, "app.html");
fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><title>{}</title>
<style>
  body { font: 18px system-ui; margin: 40px; }
  #add { position: absolute; left: 1500px; top: 760px; padding: 14px 28px; }
  #name { position: absolute; left: 200px; top: 200px; width: 360px; font-size: 18px; }
  .item { width: 220px; padding: 12px; margin: 6px; background: #dde; user-select: none; cursor: grab; }
  #zone { position: absolute; left: 900px; top: 300px; width: 300px; height: 200px; border: 3px dashed #888; }
  #tall { height: 3000px; }
</style></head><body>
<input id="name" placeholder="Name">
<button id="add">Add</button>
<div id="zone">drop here</div>
<div class="item" id="card">Card</div>
<div id="tall"></div>
<script>
  const s = { moves: 0, seg: [], clicks: [], dwell: [], keys: [], wheels: [], dropped: false, maxDev: 0, value: "" };
  let lastMove = 0, downAt = 0, dragging = false;
  const pub = () => { s.value = document.getElementById("name").value; document.title = JSON.stringify({ ...s, seg: s.seg.length }); };
  addEventListener("mousemove", (e) => { s.moves++; lastMove = performance.now(); s.seg.push([e.clientX, e.clientY]); if (dragging) { const c = document.getElementById("card"); c.style.position = "absolute"; c.style.left = (e.pageX - 40) + "px"; c.style.top = (e.pageY - 20) + "px"; } pub(); });
  addEventListener("mousedown", (e) => { downAt = performance.now(); s.dwell.push(Math.round(downAt - lastMove)); if (e.target.id === "card") dragging = true;
    const [a, b] = [s.seg[0], s.seg[s.seg.length - 1]];
    if (a && b) { const L = Math.hypot(b[0]-a[0], b[1]-a[1]) || 1; for (const p of s.seg) { const d = Math.abs((b[0]-a[0])*(a[1]-p[1]) - (a[0]-p[0])*(b[1]-a[1])) / L; if (d > s.maxDev) s.maxDev = Math.round(d); } }
    s.seg = []; pub(); });
  addEventListener("mouseup", (e) => { s.clicks.push({ x: e.clientX, y: e.clientY, held: Math.round(performance.now() - downAt), target: e.target.id });
    if (dragging) { const z = document.getElementById("zone").getBoundingClientRect(); s.dropped = e.clientX > z.left && e.clientX < z.right && e.clientY > z.top && e.clientY < z.bottom; dragging = false; } pub(); });
  let lastKey = 0; addEventListener("keydown", () => { const t = performance.now(); if (lastKey) s.keys.push(Math.round(t - lastKey)); lastKey = t; pub(); });
  addEventListener("wheel", (e) => { s.wheels.push(Math.round(e.deltaY)); pub(); });
  addEventListener("input", pub); // keydown fires before the character is in the field
  pub();
</script></body></html>`);

const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
function b(...args) {
  const r = spawnSync(process.execPath, [BROWSER, ...args], { cwd: root, env, encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`browser.mjs ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
}
const stats = () => JSON.parse(JSON.parse(/title: (".*")/.exec(b("state"))[1]));

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push(`ok   ${name}`);
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message.split("\n")[0]}`);
  }
};

let started = false;
try {
  const out = b("start", "--url", pathToFileURL(page).href);
  started = true;
  check("start opens Chrome and takes the first screenshot", () => assert.match(out, /Screenshot: \.whole-review\/apptest\/round-1\/shots\/001-desktop-start\.png/));

  b("click", "#add");
  let s = stats();
  check("the pointer travels with many moves to the button and presses it", () => {
    assert.ok(s.moves >= 25, `moves ${s.moves}`);
    assert.equal(s.clicks[0].target, "add");
  });
  check("the path is curved, not a straight line", () => assert.ok(s.maxDev >= 3, `max deviation ${s.maxDev}px`));
  check("it pauses over the target before pressing, and holds the button a human time", () => {
    assert.ok(s.dwell[0] >= 30, `dwell ${s.dwell[0]} ms`);
    assert.ok(s.clicks[0].held >= 40 && s.clicks[0].held <= 400, `held ${s.clicks[0].held} ms`);
  });
  check("it does not hit the exact centre every time", () => {
    b("click", "#add");
    b("click", "#add");
    const pts = stats().clicks.map((c) => `${c.x},${c.y}`);
    assert.ok(new Set(pts).size >= 2, `click points ${pts.join(" ")}`);
  });

  b("type", "Hello", "world", "--into", "#name");
  s = stats();
  check("typing goes into the field with uneven per-key timing", () => {
    assert.equal(s.value, "Hello world");
    const gaps = s.keys.slice(-10);
    const mean = gaps.reduce((a, x) => a + x, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, x) => a + (x - mean) ** 2, 0) / gaps.length);
    assert.ok(mean >= 60, `mean gap ${mean}`);
    assert.ok(sd >= 15, `gap spread ${sd}`);
  });

  b("drag", "#card", "#zone");
  check("a drag picks the card up, carries it and drops it on the zone", () => assert.equal(stats().dropped, true));

  b("press", "Tab", "Shift+Tab");
  b("scroll", "900");
  s = stats();
  check("scrolling sends several uneven wheel steps", () => {
    assert.ok(s.wheels.length >= 5, `wheels ${s.wheels.length}`);
    assert.ok(new Set(s.wheels.map((d) => Math.abs(d))).size >= 3, `steps ${s.wheels.join(",")}`);
  });

  b("viewport", "mobile");
  b("click", "#name");
  b("zoom", "#name", "name field");

  const log = fs.readFileSync(path.join(W, "apptest", "round-1", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const shots = log.filter((e) => e.kind === "shot");
  check("every gesture leaves a screenshot in the log", () => assert.ok(shots.length >= 12, `${shots.length} shots`));
  const png = (file) => {
    const buf = fs.readFileSync(path.join(root, file));
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  check("desktop screenshots are high resolution (1920x1080 at scale 2)", () => {
    const d = png(shots.find((x) => x.viewport === "desktop").file);
    assert.deepEqual(d, { w: 3840, h: 2160 });
  });
  check("mobile screenshots are 390x844 at scale 3", () => {
    const m = png(shots.find((x) => x.viewport === "mobile" && !x.label.startsWith("zoom")).file);
    assert.deepEqual(m, { w: 1170, h: 2532 });
  });
  fs.writeFileSync(path.join(root, "shots.txt"), shots.map((x) => x.file).join("\n"));
  console.log(`screenshots in ${path.join(W, "apptest", "round-1", "shots")}`);
} catch (error) {
  checks.push(`FAIL run: ${error.message.split("\n").slice(0, 4).join(" | ")}`);
} finally {
  if (started) b("stop");
}
console.log(checks.join("\n"));
const failed = checks.filter((c) => c.startsWith("FAIL")).length;
console.log(`\n${checks.length - failed} of ${checks.length} passed (project folder kept for inspection: ${root})`);
process.exitCode = failed ? 1 : 0;
