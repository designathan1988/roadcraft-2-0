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

interface Site { readonly kind: 'frame' | 'timer' | 'interval' | 'context'; readonly where: string; ms: number; calls: number; total: number; totalCalls: number }

/** The first frame of the stack in the project's own sources (`src/…:line`), past this module's. */
function siteOf(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const m = /\/src\/([^?:)]+)[^:)]*:(\d+)/.exec(line);
    if (m && !m[1]!.endsWith('lab/hiddenWork.ts')) return `src/${m[1]}:${m[2]}`;
  }
  return '(outside src)';
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
  const contexts: string[] = [];
  const site = (kind: Site['kind'], where: string): Site => {
    const key = `${kind} ${where}`;
    let s = sites.get(key);
    if (!s) sites.set(key, s = { kind, where, ms: 0, calls: 0, total: 0, totalCalls: 0 });
    return s;
  };
  const timed = <A extends unknown[]>(s: Site, fn: (...args: A) => unknown) => (...args: A): unknown => {
    const t0 = performance.now();
    try { return fn(...args); } finally { const dt = performance.now() - t0; s.ms += dt; s.calls++; s.total += dt; s.totalCalls++; }
  };

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => raf(timed(site('frame', siteOf(new Error().stack)), callback));
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    timeout(typeof handler === 'function' ? timed(site('timer', siteOf(new Error().stack)), handler as (...a: unknown[]) => unknown) : handler, ms, ...rest)) as typeof window.setTimeout;
  const interval = window.setInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    interval(typeof handler === 'function' ? timed(site('interval', siteOf(new Error().stack)), handler as (...a: unknown[]) => unknown) : handler, ms, ...rest)) as typeof window.setInterval;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
    const made = (getContext as (this: HTMLCanvasElement, id: string, ...r: unknown[]) => RenderingContext | null).call(this, id, ...rest);
    if (made && (id === 'webgl2' || id === 'webgl') && !contexts.includes(siteOf(new Error().stack))) {
      const where = siteOf(new Error().stack);
      contexts.push(where);
      site('context', where).calls++;
      if (contexts.length > 1) console.warn(`[hidden work] WebGL context ${contexts.length} made at ${where} (each one shares the GPU's thread with the game's)`);
    }
    return made;
  } as typeof HTMLCanvasElement.prototype.getContext;

  const report = (): ReturnType<HiddenWork['report']> => [...sites.values()]
    .map((s) => ({ kind: s.kind, where: s.where, msPerSecond: s.ms / (WINDOW_MS / 1000), callsPerSecond: s.calls / (WINDOW_MS / 1000) }))
    .sort((a, b) => b.msPerSecond - a.msPerSecond);
  let last: ReturnType<HiddenWork['report']> = [];
  interval(() => {
    last = report();
    const told = last.filter((r) => r.kind !== 'context' && !frameSite.test(r.where) && r.msPerSecond >= TELL_MS_PER_S);
    if (told.length) {
      console.warn(`[hidden work] outside the game's frame, the last ${WINDOW_MS / 1000} s:\n${told.map((r) =>
        `  ${r.msPerSecond.toFixed(1)} ms/s, ${r.callsPerSecond.toFixed(1)} calls/s - ${r.kind} at ${r.where}`).join('\n')}`);
    }
    for (const s of sites.values()) { s.ms = 0; s.calls = 0; }
  }, WINDOW_MS);
  const api: HiddenWork = { report: () => last, contexts: () => contexts };
  Object.assign(window, { __hiddenWork: api });
  return api;
}
