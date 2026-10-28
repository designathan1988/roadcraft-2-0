#!/usr/bin/env node
/**
 * Human-gesture Chrome driver for the application test phase of the reviewing-whole-codebase skill.
 *
 * A background daemon keeps one Google Chrome page open through Playwright; each CLI call sends it one
 * gesture. Pointer paths follow the WindMouse model (gravity toward the target plus random wind, so the
 * path is curved, uneven and slows down near the target; https://windmouse.readthedocs.io/en/latest/algorithm.html),
 * with movement time from Fitts's law and an occasional overshoot and correction for far targets (the
 * approach of ghost-cursor, https://www.npmjs.com/package/ghost-cursor). Clicks dwell before pressing and hold
 * the button for a human time; drags pass the drag threshold, travel slower, settle before release; typing
 * has uneven per-key delays and pauses; scrolling sends uneven wheel steps.
 *
 * After every gesture a high-resolution screenshot is saved (device scale factor 2 on desktop, 3 on mobile;
 * page.screenshot scale "device", https://playwright.dev/docs/api/class-page) and console errors, page
 * errors, failed requests and HTTP errors are logged with ids, all under .whole-review/apptest/round-N/.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = path.dirname(path.dirname(SCRIPT));
const STATE_DIR = ".whole-review";
const VIEWPORTS = {
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

// ---------------------------------------------------------------- shared helpers

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function findRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, STATE_DIR, "state.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function projectRoot() {
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) fail(`No ${STATE_DIR}/state.json found; start the review with ledger.mjs init first.`);
  return root;
}

function roundDir(root) {
  const state = JSON.parse(fs.readFileSync(path.join(root, STATE_DIR, "state.json"), "utf8"));
  const rounds = state.apptest?.rounds ?? [];
  if (state.phase !== "apptest" || !rounds.length) fail("The browser is used only in phase apptest (run `ledger.mjs phase apptest` after the code work is done).");
  return path.join(root, STATE_DIR, "apptest", `round-${rounds[rounds.length - 1].n}`);
}

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
function gauss() {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function logNormalDelay(medianMs, spread = 0.35) {
  return medianMs * Math.exp(gauss() * spread);
}

// ---------------------------------------------------------------- human motion

// WindMouse path from (x0, y0) to (xd, yd): returns the list of integer points visited.
function windMouse(x0, y0, xd, yd, { G0 = 9, W0 = 3, M0 = 15, D0 = 12 } = {}) {
  const pts = [];
  let x = x0;
  let y = y0;
  let vx = 0;
  let vy = 0;
  let wx = 0;
  let wy = 0;
  let M = M0;
  let guard = 0;
  while (Math.hypot(xd - x, yd - y) >= 1 && guard < 5000) {
    guard += 1;
    const d = Math.hypot(xd - x, yd - y);
    const w = Math.min(W0, d);
    if (d >= D0) {
      wx = wx / Math.sqrt(3) + ((2 * Math.random() - 1) * w) / Math.sqrt(5);
      wy = wy / Math.sqrt(3) + ((2 * Math.random() - 1) * w) / Math.sqrt(5);
    } else {
      wx /= Math.sqrt(3);
      wy /= Math.sqrt(3);
      M = M < 3 ? Math.random() * 3 + 3 : M / Math.sqrt(5);
    }
    vx += wx + (G0 * (xd - x)) / d;
    vy += wy + (G0 * (yd - y)) / d;
    const vmag = Math.hypot(vx, vy);
    if (vmag > M) {
      const clip = M / 2 + (Math.random() * M) / 2;
      vx = (vx / vmag) * clip;
      vy = (vy / vmag) * clip;
    }
    x += vx;
    y += vy;
    const p = [Math.round(x), Math.round(y)];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  pts.push([Math.round(xd), Math.round(yd)]);
  return pts;
}

// Fitts's law movement time in ms: a + b * log2(D / W + 1), with per-person variation.
function fittsTime(distance, width) {
  return rand(90, 160) + rand(120, 190) * Math.log2(distance / Math.max(width, 4) + 1);
}

async function travel(page, pos, to, { width = 24, slow = 1 } = {}) {
  const distance = Math.hypot(to[0] - pos.x, to[1] - pos.y);
  if (distance < 1) return;
  const legs = [];
  if (distance > 350 && Math.random() < 0.55) {
    // Overshoot past the target, then come back: what people do on long, fast movements.
    const ux = (to[0] - pos.x) / distance;
    const uy = (to[1] - pos.y) / distance;
    const over = distance * rand(0.03, 0.08);
    const side = rand(-1, 1) * over * 0.6;
    legs.push({ target: [to[0] + ux * over - uy * side, to[1] + uy * over + ux * side], opts: { M0: 18 }, share: 0.85 });
    legs.push({ target: to, opts: { G0: 7, W0: 1.5, M0: 6 }, share: 0.15, pause: rand(60, 180) });
  } else {
    legs.push({ target: to, opts: distance < 60 ? { M0: 6, W0: 2 } : {}, share: 1 });
  }
  const total = fittsTime(distance, width) * slow;
  for (const leg of legs) {
    if (leg.pause) await sleep(leg.pause);
    const pts = windMouse(pos.x, pos.y, leg.target[0], leg.target[1], leg.opts);
    const per = (total * leg.share) / pts.length;
    const hesitateAt = Math.random() < 0.12 ? Math.floor(pts.length * rand(0.3, 0.7)) : -1;
    for (let i = 0; i < pts.length; i += 1) {
      await page.mouse.move(pts[i][0], pts[i][1]);
      pos.x = pts[i][0];
      pos.y = pts[i][1];
      if (i === hesitateAt) await sleep(rand(90, 280));
      await sleep(per * rand(0.6, 1.4));
    }
  }
}

// A point inside a box, near its centre but never exactly on it (people aim, they do not compute centres).
function aimPoint(box) {
  const gx = Math.max(-0.42, Math.min(0.42, gauss() * 0.16));
  const gy = Math.max(-0.38, Math.min(0.38, gauss() * 0.14));
  return [box.x + box.width * (0.5 + gx), box.y + box.height * (0.5 + gy)];
}

// ---------------------------------------------------------------- daemon

async function loadPlaywright(root) {
  const tries = [path.join(root, "package.json"), path.join(SKILL_DIR, "package.json"), path.join(SKILL_DIR, "scripts", "package.json")];
  for (const from of tries) {
    const req = createRequire(from);
    for (const name of ["playwright-core", "playwright"]) {
      try {
        return req(name);
      } catch {
        // try the next location
      }
    }
  }
  fail(`Playwright was not found in the project or in ${SKILL_DIR}. Install it once in the skill folder: npm install --prefix "${SKILL_DIR}" playwright-core`);
  return null;
}

async function daemon(root, dir, opts) {
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  const logFile = path.join(dir, "log.jsonl");
  const log = (entry) => fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const pw = await loadPlaywright(root);
  const browser = await pw.chromium.launch({ channel: "chrome", headless: !opts.headed });
  let viewportName = opts.viewport;
  let context;
  let page;
  const pos = { x: 0, y: 0 };
  let shotCount = fs.readdirSync(path.join(dir, "shots")).length;
  let errorCount = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('"kind":"error"')).length : 0;
  let pending = [];

  function watch(p) {
    const record = (type, text) => {
      errorCount += 1;
      const entry = { kind: "error", id: `E-${errorCount}`, type, text: String(text).slice(0, 2000), url: p.url(), viewport: viewportName };
      log(entry);
      pending.push(entry);
    };
    p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") record(`console.${m.type()}`, m.text()); });
    p.on("pageerror", (e) => record("pageerror", e?.stack || e?.message || e));
    p.on("requestfailed", (r) => record("requestfailed", `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`));
    p.on("response", (r) => { if (r.status() >= 400) record("http", `${r.status()} ${r.request().method()} ${r.url()}`); });
  }

  async function open(name, url) {
    if (context) await context.close();
    context = await browser.newContext({ ...VIEWPORTS[name] });
    page = await context.newPage();
    watch(page);
    viewportName = name;
    const vp = VIEWPORTS[name].viewport;
    pos.x = Math.round(vp.width * rand(0.3, 0.7));
    pos.y = Math.round(vp.height * rand(0.3, 0.7));
    if (url) await page.goto(url, { waitUntil: "load" });
    await page.mouse.move(pos.x, pos.y);
  }

  async function shot(label, { full = false, clip = null } = {}) {
    shotCount += 1;
    const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "shot";
    const file = path.join(dir, "shots", `${String(shotCount).padStart(3, "0")}-${viewportName}-${slug}.png`);
    await sleep(rand(250, 450)); // let transitions settle as a person's eye would
    await page.screenshot({ path: file, fullPage: full, clip: clip ?? undefined, scale: "device", caret: "initial" });
    const rel = path.relative(root, file).replaceAll("\\", "/");
    log({ kind: "shot", file: rel, label, viewport: viewportName, full, url: page.url() });
    return rel;
  }

  async function locate(target) {
    const at = /^@(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(target);
    if (at) return { x: Number(at[1]) - 2, y: Number(at[2]) - 2, width: 4, height: 4 };
    const loc = page.locator(target).first();
    await loc.waitFor({ state: "attached", timeout: 8000 });
    let box = await loc.boundingBox();
    const vh = page.viewportSize().height;
    for (let i = 0; i < 25 && box && (box.y < 0 || box.y + box.height > vh); i += 1) {
      // Bring it into view with the wheel, as a person scrolls, never with a programmatic jump.
      const dir = box.y < 0 ? -1 : 1;
      for (let k = 0; k < Math.ceil(rand(2, 5)); k += 1) {
        await page.mouse.wheel(0, dir * rand(70, 140));
        await sleep(rand(16, 70));
      }
      await sleep(rand(120, 300));
      box = await loc.boundingBox();
    }
    if (!box) throw new Error(`"${target}" has no box on screen (hidden, detached or zero size)`);
    return box;
  }

  const actions = {
    async goto({ url }) {
      await page.goto(url, { waitUntil: "load" });
      return { shot: await shot(`goto ${new URL(page.url()).pathname}`) };
    },
    async viewport({ name }) {
      if (!VIEWPORTS[name]) throw new Error(`viewport must be ${Object.keys(VIEWPORTS).join(" or ")}`);
      await open(name, page?.url());
      return { shot: await shot(`viewport ${name}`) };
    },
    async move({ target }) {
      const box = await locate(target);
      await travel(page, pos, aimPoint(box), { width: Math.min(box.width, box.height) });
      return {};
    },
    async hover({ target }) {
      const box = await locate(target);
      await travel(page, pos, aimPoint(box), { width: Math.min(box.width, box.height) });
      await sleep(rand(600, 1400));
      return { shot: await shot(`hover ${target}`) };
    },
    async click({ target, button = "left", count = 1 }) {
      const box = await locate(target);
      if (VIEWPORTS[viewportName].hasTouch && button === "left") {
        const [x, y] = aimPoint(box);
        await sleep(logNormalDelay(350));
        for (let i = 0; i < count; i += 1) {
          await page.touchscreen.tap(x, y);
          if (i + 1 < count) await sleep(rand(90, 160));
        }
        pos.x = Math.round(x);
        pos.y = Math.round(y);
      } else {
        await travel(page, pos, aimPoint(box), { width: Math.min(box.width, box.height) });
        await sleep(logNormalDelay(180, 0.5)); // dwell before pressing
        for (let i = 0; i < count; i += 1) {
          await page.mouse.down({ button, clickCount: i + 1 });
          await sleep(rand(55, 140));
          if (Math.random() < 0.3) await page.mouse.move(pos.x + Math.round(rand(-1, 1)), pos.y + Math.round(rand(-1, 1)));
          await page.mouse.up({ button, clickCount: i + 1 });
          if (i + 1 < count) await sleep(rand(80, 150));
        }
      }
      return { shot: await shot(`${count > 1 ? "double " : ""}${button === "right" ? "right " : ""}click ${target}`) };
    },
    async drag({ from, to }) {
      const a = await locate(from);
      await travel(page, pos, aimPoint(a), { width: Math.min(a.width, a.height) });
      await sleep(logNormalDelay(220, 0.4));
      await page.mouse.down();
      await sleep(rand(110, 260));
      for (let i = 0; i < 3; i += 1) {
        // Pass the drag threshold with a few small, uneven moves.
        pos.x += Math.round(rand(1, 4));
        pos.y += Math.round(rand(-2, 3));
        await page.mouse.move(pos.x, pos.y);
        await sleep(rand(16, 45));
      }
      const b = await locate(to);
      await travel(page, pos, aimPoint(b), { width: Math.min(b.width, b.height), slow: rand(1.6, 2.4) });
      for (let i = 0; i < 2; i += 1) {
        await sleep(rand(60, 140));
        await page.mouse.move(pos.x + Math.round(rand(-2, 2)), pos.y + Math.round(rand(-2, 2)));
      }
      await sleep(rand(150, 380)); // settle over the drop target before letting go
      await page.mouse.up();
      return { shot: await shot(`drag ${from} to ${to}`) };
    },
    async type({ target, text }) {
      if (target) await actions.click({ target });
      let sinceThink = 0;
      for (const ch of String(text)) {
        await page.keyboard.type(ch);
        sinceThink += 1;
        let d = logNormalDelay(125, 0.45);
        if (/[\s.,;:!?]/.test(ch)) d += rand(80, 300);
        if (sinceThink > rand(10, 22)) {
          d += rand(350, 900);
          sinceThink = 0;
        }
        await sleep(d);
      }
      return { shot: await shot(`type ${String(text).slice(0, 20)}`) };
    },
    async press({ keys }) {
      for (const combo of String(keys).split(/\s+/).filter(Boolean)) {
        const parts = combo.split("+");
        for (const k of parts.slice(0, -1)) {
          await page.keyboard.down(k);
          await sleep(rand(40, 110));
        }
        await page.keyboard.down(parts[parts.length - 1]);
        await sleep(rand(45, 120));
        await page.keyboard.up(parts[parts.length - 1]);
        for (const k of parts.slice(0, -1).reverse()) {
          await sleep(rand(20, 70));
          await page.keyboard.up(k);
        }
        await sleep(logNormalDelay(260, 0.5));
      }
      return { shot: await shot(`press ${keys}`) };
    },
    async scroll({ dy, dx = 0, at }) {
      if (at) {
        const box = await locate(at);
        await travel(page, pos, aimPoint(box), { width: Math.min(box.width, box.height) });
      }
      let left = Number(dy);
      let leftX = Number(dx);
      while (Math.abs(left) > 1 || Math.abs(leftX) > 1) {
        const burst = Math.ceil(rand(2, 6));
        for (let i = 0; i < burst && (Math.abs(left) > 1 || Math.abs(leftX) > 1); i += 1) {
          const sy = Math.sign(left) * Math.min(Math.abs(left), rand(60, 140));
          const sx = Math.sign(leftX) * Math.min(Math.abs(leftX), rand(40, 100));
          await page.mouse.wheel(sx, sy);
          left -= sy;
          leftX -= sx;
          await sleep(rand(14, 60) * (1 + i * 0.25));
        }
        await sleep(rand(180, 520)); // look at what scrolled into view
      }
      return { shot: await shot(`scroll ${dy}`) };
    },
    async shot({ label, full }) {
      return { shot: await shot(label || "look", { full: Boolean(full) }) };
    },
    async zoom({ target, label }) {
      const box = await locate(target);
      const pad = 24;
      const vp = page.viewportSize();
      const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(vp.width, box.width + 2 * pad), height: Math.min(vp.height, box.height + 2 * pad) };
      return { shot: await shot(`zoom ${label || target}`, { clip }) };
    },
    async state() {
      return { url: page.url(), title: await page.title(), viewport: viewportName, mouse: { ...pos }, errors: errorCount, shots: shotCount };
    },
  };

  await open(viewportName, opts.url);
  const firstShot = await shot("start");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      let out;
      try {
        const msg = JSON.parse(body || "{}");
        if (msg.action === "stop") {
          res.end(JSON.stringify({ ok: true, stopped: true }));
          log({ kind: "stop" });
          await browser.close();
          server.close();
          fs.rmSync(path.join(dir, "daemon.json"), { force: true });
          process.exit(0);
        }
        const fn = actions[msg.action];
        if (!fn) throw new Error(`unknown action ${msg.action}`);
        pending = [];
        const result = await fn(msg.args ?? {});
        log({ kind: "action", action: msg.action, args: msg.args ?? {}, shot: result.shot ?? null, viewport: viewportName });
        out = { ok: true, ...result, errors: pending };
      } catch (error) {
        out = { ok: false, error: String(error?.message ?? error), errors: pending };
        try {
          out.shot = await shot("after failed action");
        } catch {
          // the page itself may be gone; the error above says why
        }
        log({ kind: "action-failed", error: out.error });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({ port: server.address().port, pid: process.pid, firstShot }));
  });
}

// ---------------------------------------------------------------- CLI

async function send(dir, action, args) {
  const file = path.join(dir, "daemon.json");
  if (!fs.existsSync(file)) fail("The browser is not running; run `browser.mjs start --url <app url>` first.");
  const { port } = JSON.parse(fs.readFileSync(file, "utf8"));
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify({ action, args }) });
  return res.json();
}

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[argv[i].slice(2)] = next;
        i += 1;
      } else flags[argv[i].slice(2)] = true;
    } else pos.push(argv[i]);
  }
  return { pos, flags };
}

function report(out) {
  if (!out.ok) process.stdout.write(`FAILED: ${out.error}\n`);
  if (out.shot) process.stdout.write(`Screenshot: ${out.shot}  (Read it now and describe it in ANALYSIS.md)\n`);
  for (const e of out.errors ?? []) process.stdout.write(`${e.id} ${e.type}: ${e.text.split("\n")[0].slice(0, 300)}\n`);
  for (const [k, v] of Object.entries(out)) if (!["ok", "shot", "errors", "error"].includes(k)) process.stdout.write(`${k}: ${JSON.stringify(v)}\n`);
  if (!out.ok) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  if (command === "daemon") {
    const root = flags.root;
    return daemon(root, flags.dir, { url: flags.url, viewport: flags.viewport || "desktop", headed: Boolean(flags.headed) });
  }
  const root = projectRoot();
  const dir = roundDir(root);
  if (command === "start") {
    if (!flags.url) fail("Usage: browser.mjs start --url <app url> [--viewport desktop|mobile] [--headed]");
    if (fs.existsSync(path.join(dir, "daemon.json"))) fail("The browser is already running; use it, or `stop` first.");
    fs.mkdirSync(dir, { recursive: true });
    const out = fs.openSync(path.join(dir, "daemon.out"), "a");
    const child = spawn(process.execPath, [SCRIPT, "daemon", "--root", root, "--dir", dir, "--url", flags.url, "--viewport", flags.viewport || "desktop", ...(flags.headed ? ["--headed"] : [])], {
      detached: true, stdio: ["ignore", out, out], windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 300; i += 1) {
      if (fs.existsSync(path.join(dir, "daemon.json"))) {
        const info = JSON.parse(fs.readFileSync(path.join(dir, "daemon.json"), "utf8"));
        process.stdout.write(`Chrome is open on ${flags.url} (${flags.viewport || "desktop"}).\nScreenshot: ${info.firstShot}  (Read it now and describe it in ANALYSIS.md)\n`);
        return undefined;
      }
      await sleep(100);
    }
    fail(`Chrome did not start in 30 s; see ${path.join(dir, "daemon.out")}`);
  }
  const map = {
    goto: () => ({ url: pos[0] }),
    viewport: () => ({ name: pos[0] }),
    move: () => ({ target: pos[0] }),
    hover: () => ({ target: pos[0] }),
    click: () => ({ target: pos[0], button: flags.right ? "right" : "left", count: flags.double ? 2 : 1 }),
    drag: () => ({ from: pos[0], to: pos[1] }),
    type: () => ({ target: flags.into, text: pos.join(" ") }),
    press: () => ({ keys: pos.join(" ") }),
    scroll: () => ({ dy: Number(pos[0] ?? 400), dx: Number(flags.x ?? 0), at: flags.at }),
    shot: () => ({ label: pos.join(" "), full: Boolean(flags.full) }),
    zoom: () => ({ target: pos[0], label: pos.slice(1).join(" ") }),
    state: () => ({}),
    stop: () => ({}),
  };
  if (!map[command]) {
    process.stdout.write([
      "Usage: browser.mjs <command>   (targets: a Playwright selector such as 'role=button[name=\"Add\"]', 'text=Checkout', '#id', or @x,y)",
      "  start --url <url> [--viewport desktop|mobile] [--headed]   open Chrome (1920x1080 @2x, or 390x844 @3x touch)",
      "  goto <url> | viewport desktop|mobile | move <t> | hover <t> | click <t> [--double] [--right]",
      "  drag <from> <to> | type <text...> [--into <t>] | press <keys, e.g. Tab Enter Control+A>",
      "  scroll <dy> [--x <dx>] [--at <t>] | shot <label> [--full] | zoom <t> <label> | state | stop",
    ].join("\n") + "\n");
    process.exitCode = command ? 1 : 0;
    return undefined;
  }
  const out = await send(dir, command, map[command]());
  report(out);
  return undefined;
}

main();
