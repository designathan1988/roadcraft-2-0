/**
 * THE WORK NOBODY SEES, CAUGHT AS IT RUNS (the development build): every animation-frame callback, timer and interval of the page timed
 * by the line of `src/` that asked for it, and every WebGL context made, by the line that made it; each window the sites that took time
 * outside the game's own frame (`main.ts` frame) told on the console with their file and line, as a context beyond the game's.
 *
 * DO NOT wait for a player to find such work: the Builder's pictures were taken in a second WebGL context, their programs linked in the
 * frame, and the game held at 1 fps while the panel was open - found only by opening the panel with the lab open (2026-10-27).
 *
 * Read with `window.__hiddenWork.report()`; nothing of it is in a player's build.
 */

/** How long a window is, ms, and the least a site must take of it to be told (ms of each second). */
const WINDOW_MS = 5000;
const TELL_MS_PER_S = 1;

interface Site { readonly kind: 'frame' | 'timer' | 'interval' | 'context'; where: string; ms: number; calls: number; total: number; totalCalls: number }

/** A line of the served code: the module's address (with Vite's query), its project path, the line. */
interface Served { readonly url: string; readonly path: string; readonly line: number }

/** The first frame of the stack in the project's own sources, past this module's. */
function servedOf(stack: string | undefined): Served | null {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const m = /(https?:\/\/[^\s()]*?\/src\/([^?:)]+)[^:)]*):(\d+)/.exec(line);
    if (m && !m[2]!.endsWith('lab/hiddenWork.ts')) return { url: m[1]!, path: `src/${m[2]}`, line: Number(m[3]) };
  }
  return null;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Of each served line, the source line (1-based) its first mapping comes from, 0 for none (the source map's `mappings`, base64 VLQ:
 *  https://sourcemaps.info/spec.html - the source line is the third field, relative to the one before across the whole file). */
export function sourceLinesOf(mappings: string): Int32Array {
  const rows = mappings.split(';');
  const out = new Int32Array(rows.length + 1);
  let sourceLine = 0;
  rows.forEach((row, at) => {
    let first = true;
    for (const segment of row.split(',')) {
      if (!segment) continue;
      const fields: number[] = [];
      let value = 0, shift = 0;
      for (const ch of segment) {
        const digit = BASE64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0; shift = 0;
      }
      if (fields.length < 4) continue;
      sourceLine += fields[2]!;
      if (first) { out[at + 1] = sourceLine + 1; first = false; }
    }
  });
  return out;
}

/** Each module's served lines to its source's: Vite serves the code transformed, and its lines are not the source's (DO NOT tell them:
 *  a site told at `shell.ts:2620` of a 2093-line file points at nothing). Read from the inline source map the server appends. */
function sourceLineReader(): (served: Served) => Promise<number | null> {
  const sourceLines = new Map<string, Promise<Int32Array | null>>();
  return (served) => {
    const url = served.url.replace(/[?&]t=\d+/, '');
    let lines = sourceLines.get(url);
    if (!lines) {
      lines = fetch(served.url).then((r) => r.text()).then((text) => {
        const m = /sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(text);
        return m ? sourceLinesOf((JSON.parse(atob(m[1]!)) as { mappings: string }).mappings) : null;
      }).catch((error: unknown) => { console.warn(`[hidden work] the source map of ${served.path} could not be read`, error); return null; });
      sourceLines.set(url, lines);
    }
    return lines.then((l) => (l && l[served.line] ? l[served.line]! : null));
  };
}

export interface HiddenWork {
  /** The sites over the last window, most time first: what each costs a second, how often it ran. */
  report(): { kind: string; where: string; msPerSecond: number; callsPerSecond: number }[];
  /** The WebGL contexts made, by the line that made each. */
  contexts(): readonly string[];
}

/** Installs the watch, once; `frameSite`: the game's own frame (its time is the frame's, never hidden). */
export function watchHiddenWork(frameSite: RegExp): HiddenWork {
  const sites = new Map<string, Site>();
  const sourceLine = sourceLineReader();
  /** Each context made, by the line that made it: one let go (a probe's, `loseContext`) is no longer counted. */
  const contexts: { where: string; gl: WebGLRenderingContext | WebGL2RenderingContext }[] = [];
  const live = (): string[] => contexts.filter((c) => !c.gl.isContextLost()).map((c) => c.where);
  const site = (kind: Site['kind'], stack: string | undefined): Site => {
    const served = servedOf(stack);
    const key = `${kind} ${served ? `${served.url}:${served.line}` : '(outside src)'}`;
    let s = sites.get(key);
    if (!s) {
      sites.set(key, s = { kind, where: served ? `${served.path}:${served.line} (served)` : '(outside src)', ms: 0, calls: 0, total: 0, totalCalls: 0 });
      const told = s;
      if (served) void sourceLine(served).then((line) => { if (line) told.where = `${served.path}:${line}`; });
    }
    return s;
  };
  const timed = <A extends unknown[]>(s: Site, fn: (...args: A) => unknown) => (...args: A): unknown => {
    const t0 = performance.now();
    try { return fn(...args); } finally { const dt = performance.now() - t0; s.ms += dt; s.calls++; s.total += dt; s.totalCalls++; }
  };

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => raf(timed(site('frame', new Error().stack), callback));
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    timeout(typeof handler === 'function' ? timed(site('timer', new Error().stack), handler as (...a: unknown[]) => unknown) : handler, ms, ...rest)) as typeof window.setTimeout;
  const interval = window.setInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    interval(typeof handler === 'function' ? timed(site('interval', new Error().stack), handler as (...a: unknown[]) => unknown) : handler, ms, ...rest)) as typeof window.setInterval;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
    const made = (getContext as (this: HTMLCanvasElement, id: string, ...r: unknown[]) => RenderingContext | null).call(this, id, ...rest);
    if (made && (id === 'webgl2' || id === 'webgl') && !contexts.some((c) => c.gl === made)) {
      const s = site('context', new Error().stack);
      s.calls++;
      contexts.push({ get where() { return s.where; }, gl: made as WebGL2RenderingContext });
      const now = live();
      if (now.length > 1) console.warn(`[hidden work] WebGL context ${now.length} live, made at ${s.where} (each one shares the GPU's thread with the game's)`);
    }
    return made;
  } as typeof HTMLCanvasElement.prototype.getContext;

  /** When the window began: a page held up runs its interval late, and its seconds are the ones that passed (DO NOT divide by `WINDOW_MS`). */
  let began = performance.now();
  const report = (seconds: number): ReturnType<HiddenWork['report']> => [...sites.values()]
    .map((s) => ({ kind: s.kind, where: s.where, msPerSecond: s.ms / seconds, callsPerSecond: s.calls / seconds }))
    .sort((a, b) => b.msPerSecond - a.msPerSecond);
  let last: ReturnType<HiddenWork['report']> = [];
  interval(() => {
    const now = performance.now();
    const seconds = Math.max(1e-3, (now - began) / 1000);
    began = now;
    last = report(seconds);
    const told = last.filter((r) => r.kind !== 'context' && !frameSite.test(r.where) && r.msPerSecond >= TELL_MS_PER_S);
    if (told.length) {
      console.warn(`[hidden work] outside the game's frame, the last ${seconds.toFixed(1)} s:\n${told.map((r) =>
        `  ${r.msPerSecond.toFixed(1)} ms/s, ${r.callsPerSecond.toFixed(1)} calls/s - ${r.kind} at ${r.where}`).join('\n')}`);
    }
    for (const s of sites.values()) { s.ms = 0; s.calls = 0; }
  }, WINDOW_MS);
  const api: HiddenWork = { report: () => last, contexts: live };
  Object.assign(window, { __hiddenWork: api });
  return api;
}
