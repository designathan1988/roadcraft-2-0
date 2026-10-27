import { BufferAttribute, BufferGeometry, InterleavedBuffer, Material, Texture } from 'three';
import { textureGpuBytes } from '@render/memoryCounters';
import { lookup, mapOfModule, type DecodedMap } from './code/sourceMap';

/**
 * THE WORK NOBODY SEES, CAUGHT AS IT RUNS (the development build), each by the line of `src/` that asked for it (the served code read back
 * to its TypeScript through the source maps Vite inlines, `code/sourceMap.ts`):
 * - the page's callbacks timed: animation frames, timers, intervals, idle callbacks, every event listener (a worker's or a port's messages
 *   too, the DOM's, the window's) and every Mutation, Resize and Intersection observer;
 * - what is made as the game runs that a menu or a texture could have had ready: WebGL contexts (a second one beside the game's), canvases,
 *   2D drawing contexts, pictures encoded (`toDataURL`, `toBlob`);
 * - what three is asked to do again: a buffer sent again (`BufferAttribute`/`InterleavedBuffer` `needsUpdate`, its bytes), a texture sent
 *   again (`Texture.needsUpdate`, its bytes), a material refreshed or recompiled (`Material.needsUpdate`), a geometry's buffers made
 *   (`BufferGeometry.setAttribute`). Their lines are read only while `deep` is on (a diagnosis measuring: `doctor/measure.ts`): a stack a
 *   call costs, and some are made thousands of times a frame. Counted by kind always.
 * Each window the sites that took time outside the game's own frame are told on the console with their file and line.
 *
 * DO NOT wait for a player to find such work: the Builder's pictures were taken in a second WebGL context, their programs linked in the
 * frame, and the game held at 1 fps while the panel was open - found only by opening the panel with the lab open (2026-10-27).
 *
 * Read with `window.__hiddenWork` (`report()`, `session()`, `contexts()`, `deep(on)`); the lab's diagnosis and every report carry it.
 */

/** How long a window is, ms, and the least a site must take of it to be told (ms of each second). */
const WINDOW_MS = 5000;
const TELL_MS_PER_S = 1;

export type SiteKind =
  | 'frame' | 'timer' | 'interval' | 'idle' | 'event' | 'observer'
  | 'context' | 'canvas' | 'context2d' | 'encode'
  | 'buffer' | 'texture' | 'material' | 'geometry';

/** The kinds that are callbacks timed; the others are things made or asked again, counted (and their bytes). */
const TIMED: readonly SiteKind[] = ['frame', 'timer', 'interval', 'idle', 'event', 'observer', 'encode'];

interface Site {
  readonly kind: SiteKind;
  /** What it is beyond its kind (the event's type, the observer's class, the context's kind). */
  readonly what: string;
  where: string;
  ms: number; calls: number; bytes: number;
  total: number; totalCalls: number; totalBytes: number;
}

/** One site read over a window or the session. */
export interface SiteReading {
  readonly kind: SiteKind;
  readonly what: string;
  readonly where: string;
  readonly msPerSecond: number;
  readonly callsPerSecond: number;
  readonly bytesPerSecond: number;
}

/** A line of the served code: the module's address (with Vite's query), its project path, the line and column. */
export interface Served { readonly url: string; readonly path: string; readonly line: number; readonly column: number }

/** Modules that only wrap what they pass on (this one, the profiler's hooks into three): the line that asked is past them. */
const WRAPPERS: readonly string[] = ['lab/hiddenWork.ts', 'render/profilerHooks.ts'];

/** The first frame of the stack in the project's own sources, past the wrappers' and three's. */
export function servedOf(stack: string | undefined): Served | null {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const m = /(https?:\/\/[^\s()]*?\/src\/([^?:)]+)[^:)]*):(\d+):(\d+)/.exec(line);
    if (m && !WRAPPERS.some((w) => m[2]!.endsWith(w))) return { url: m[1]!, path: `src/${m[2]}`, line: Number(m[3]), column: Number(m[4]) };
  }
  return null;
}

/** Each module's map, fetched once: the served line read back to its source's. DO NOT tell the served line: a site told at `shell.ts:2620`
 *  of a 2093-line file points at nothing. */
function sourceLineReader(): (served: Served) => Promise<number | null> {
  const maps = new Map<string, Promise<DecodedMap | null>>();
  return (served) => {
    const url = served.url.replace(/[?&]t=\d+/, '');
    let map = maps.get(url);
    if (!map) {
      map = fetch(served.url).then((r) => r.text()).then((text) => mapOfModule(text, served.url))
        .catch((error: unknown) => { console.warn(`[hidden work] the source map of ${served.path} could not be read`, error); return null; });
      maps.set(url, map);
    }
    return map.then((m) => (m ? lookup(m, served.line - 1, served.column - 1)?.line ?? null : null));
  };
}

export interface HiddenWork {
  /** The sites over the last window, most time first. */
  report(): readonly SiteReading[];
  /** The sites since the watch began (or `reset`). */
  session(): readonly SiteReading[];
  /** The WebGL contexts alive, by the line that made each. */
  contexts(): readonly string[];
  /** Lines read for three's requests (buffers, textures, materials, geometries) while on. */
  deep(on: boolean): void;
  readonly deepOn: boolean;
  reset(): void;
}

type Listener = EventListenerOrEventListenerObject;

/** Installs the watch, once; `frameSite`: the game's own frame (its time is the frame's, never hidden). */
export function watchHiddenWork(frameSite: RegExp): HiddenWork {
  const sites = new Map<string, Site>();
  const sourceLine = sourceLineReader();
  const startedAt = { t: performance.now() };
  let deepOn = false;
  /** Each context made, by the line that made it: one let go (a probe's, `loseContext`) is no longer counted. */
  const contexts: { where: string; gl: WebGLRenderingContext | WebGL2RenderingContext }[] = [];
  const live = (): string[] => contexts.filter((c) => !c.gl.isContextLost()).map((c) => c.where);

  const site = (kind: SiteKind, what: string, stack: string | undefined): Site => {
    const served = servedOf(stack);
    const key = `${kind} ${what} ${served ? `${served.url}:${served.line}` : '(outside src)'}`;
    let s = sites.get(key);
    if (!s) {
      sites.set(key, s = { kind, what, where: served ? `${served.path}:${served.line} (served)` : '(outside src)', ms: 0, calls: 0, bytes: 0, total: 0, totalCalls: 0, totalBytes: 0 });
      const told = s;
      if (served) void sourceLine(served).then((line) => { if (line) told.where = `${served.path}:${line}`; });
    }
    return s;
  };
  /** A request of three's counted: by its line while deep, under its kind alone otherwise; the site it was counted at, per holder (`resent`). */
  const askedAt = new WeakMap<object, { site: Site; bytes: number }>();
  const counted = (kind: SiteKind, what: string, bytes: number, holder?: object): void => {
    const s = deepOn ? site(kind, what, new Error().stack) : site(kind, what, undefined);
    s.calls++; s.totalCalls++; s.bytes += bytes; s.totalBytes += bytes;
    if (holder) askedAt.set(holder, { site: s, bytes });
  };
  /** Sent by its ranges after all (three r186 uploads `updateRanges` alone and then clears them, `WebGLTextures`/`WebGLAttributes`): the
   *  whole counted when it was asked is put back to the ranges' bytes. DO NOT count a ranged send whole: the road paint's 8 MB table, a few
   *  texels sent at a time, read as 6.3 GB a second (the lab's own report, 2026-10-27). */
  const ranged = (holder: object, perElement: number, ranges: readonly { count: number }[]): void => {
    const asked = askedAt.get(holder);
    if (!asked || !ranges.length) return;
    const bytes = ranges.reduce((sum, r) => sum + r.count, 0) * perElement;
    const d = bytes - asked.bytes;
    asked.site.bytes += d; asked.site.totalBytes += d;
    askedAt.delete(holder);
  };
  const made = (kind: SiteKind, what: string): Site => {
    const s = site(kind, what, new Error().stack);
    s.calls++; s.totalCalls++;
    return s;
  };
  const timed = <A extends unknown[], R>(s: Site, fn: (...args: A) => R) => function (this: unknown, ...args: A): R {
    const t0 = performance.now();
    try { return fn.apply(this, args); } finally { const dt = performance.now() - t0; s.ms += dt; s.calls++; s.total += dt; s.totalCalls++; }
  };

  // ---- the callbacks
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => raf(timed(site('frame', '', new Error().stack), callback));
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    timeout(typeof handler === 'function' ? timed(site('timer', '', new Error().stack), handler as (...a: unknown[]) => unknown) : handler, ms, ...rest)) as typeof window.setTimeout;
  const interval = window.setInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
    interval(typeof handler === 'function' ? timed(site('interval', '', new Error().stack), handler as (...a: unknown[]) => unknown) : handler, ms, ...rest)) as typeof window.setInterval;
  if (typeof window.requestIdleCallback === 'function') {
    const idle = window.requestIdleCallback.bind(window);
    window.requestIdleCallback = (callback: IdleRequestCallback, options?: IdleRequestOptions): number => idle(timed(site('idle', '', new Error().stack), callback), options);
  }
  // Every listener, wrapped where it is added (its line read once then), unwrapped where it is removed.
  const wrappers = new WeakMap<object, Map<string, EventListener>>();
  const capture = (options: boolean | AddEventListenerOptions | EventListenerOptions | undefined): boolean => (typeof options === 'boolean' ? options : !!options?.capture);
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) {
    if (!listener) return add.call(this, type, listener, options);
    const key = `${type}|${capture(options)}`;
    let byType = wrappers.get(listener);
    const known = byType?.get(key);
    if (known) return add.call(this, type, known, options);
    const s = site('event', type, new Error().stack);
    const call = typeof listener === 'function' ? listener : (e: Event) => listener.handleEvent(e);
    const wrapped = timed(s, call) as EventListener;
    if (!byType) wrappers.set(listener, byType = new Map());
    byType.set(key, wrapped);
    return add.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: Listener | null, options?: boolean | EventListenerOptions) {
    const wrapped = listener ? wrappers.get(listener)?.get(`${type}|${capture(options)}`) : undefined;
    return remove.call(this, type, wrapped ?? listener, options);
  };
  // `worker.onmessage = …`: an event handler attribute, not a listener.
  for (const proto of [Worker.prototype, MessagePort.prototype] as object[]) {
    const d = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    if (!d?.set || !d.get) continue;
    const { get, set } = d;
    Object.defineProperty(proto, 'onmessage', {
      configurable: true,
      enumerable: d.enumerable ?? false,
      get(this: unknown) { return get.call(this); },
      set(this: unknown, handler: ((e: MessageEvent) => unknown) | null) {
        set.call(this, handler ? timed(site('event', 'message', new Error().stack), handler) : handler);
      },
    });
  }
  for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver'] as const) {
    const Original = (window as unknown as Record<string, new (callback: (...a: unknown[]) => void, options?: unknown) => object>)[name];
    if (!Original) continue;
    const Watched = class extends Original {
      constructor(callback: (...a: unknown[]) => void, options?: unknown) { super(timed(site('observer', name, new Error().stack), callback), options); }
    };
    Object.defineProperty(Watched, 'name', { value: name });
    (window as unknown as Record<string, unknown>)[name] = Watched;
  }

  // ---- what is made as it runs
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
    if (tag.toLowerCase() === 'canvas') made('canvas', 'canvas');
    return createElement.call(this, tag, options);
  } as typeof Document.prototype.createElement;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
    const context = (getContext as (this: HTMLCanvasElement, id: string, ...r: unknown[]) => RenderingContext | null).call(this, id, ...rest);
    if (context && (id === 'webgl2' || id === 'webgl') && !contexts.some((c) => c.gl === context)) {
      const s = made('context', id);
      contexts.push({ get where() { return s.where; }, gl: context as WebGL2RenderingContext });
      const now = live();
      if (now.length > 1) console.warn(`[hidden work] WebGL context ${now.length} live, made at ${s.where} (each one shares the GPU's thread with the game's)`);
    } else if (context && id === '2d') made('context2d', id);
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;
  const encoders: readonly (readonly [object, string])[] = [[HTMLCanvasElement.prototype, 'toDataURL'], [HTMLCanvasElement.prototype, 'toBlob'],
    ...(typeof OffscreenCanvas !== 'undefined' ? [[OffscreenCanvas.prototype, 'convertToBlob'] as const] : [])];
  for (const [proto, name] of encoders) {
    const original = (proto as Record<string, (...a: unknown[]) => unknown>)[name]!;
    (proto as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      return timed(site('encode', name, new Error().stack), original).apply(this, args);
    };
  }

  // ---- three asked to do again (`needsUpdate`, three r186: a setter on each class's prototype bumping `version`)
  const watchSetter = (proto: object, take: (holder: never) => void): void => {
    const d = Object.getOwnPropertyDescriptor(proto, 'needsUpdate');
    if (!d?.set) return;
    const set = d.set;
    Object.defineProperty(proto, 'needsUpdate', {
      configurable: true,
      enumerable: d.enumerable ?? false,
      ...(d.get ? { get: d.get } : {}),
      set(this: never, value: boolean) {
        if (value === true) take(this);
        set.call(this, value);
      },
    });
  };
  const arrayBytes = (holder: { array?: ArrayLike<number> & { byteLength?: number } | null; updateRanges?: readonly { count: number }[] }): number => {
    const array = holder.array;
    if (!array) return 0;
    const per = array.byteLength !== undefined && array.length ? array.byteLength / array.length : 4;
    const ranged = holder.updateRanges?.reduce((sum, r) => sum + r.count, 0) ?? 0;
    return ranged > 0 ? ranged * per : array.byteLength ?? array.length * 4;
  };
  watchSetter(BufferAttribute.prototype, (a: BufferAttribute) => counted('buffer', a.name || 'attribute', arrayBytes(a as never), a));
  watchSetter(InterleavedBuffer.prototype, (b: InterleavedBuffer) => counted('buffer', 'interleaved', arrayBytes(b as never), b));
  watchSetter(Texture.prototype, (t: Texture) => counted('texture', t.name || t.constructor.name, textureGpuBytes(t), t));
  for (const proto of [BufferAttribute.prototype, InterleavedBuffer.prototype, Texture.prototype] as object[]) {
    const clear = (proto as { clearUpdateRanges(): void }).clearUpdateRanges;
    (proto as { clearUpdateRanges(): void }).clearUpdateRanges = function (this: { updateRanges: { count: number }[]; array?: { BYTES_PER_ELEMENT?: number }; image?: { data?: { BYTES_PER_ELEMENT?: number } } }) {
      ranged(this, (this.array ?? this.image?.data)?.BYTES_PER_ELEMENT ?? 4, this.updateRanges);
      clear.call(this);
    };
  }
  watchSetter(Material.prototype, (m: Material) => counted('material', m.name || m.type, 0));
  const setAttribute = BufferGeometry.prototype.setAttribute;
  BufferGeometry.prototype.setAttribute = function (this: BufferGeometry, name: string, attribute: Parameters<BufferGeometry['setAttribute']>[1]) {
    counted('geometry', name, arrayBytes(attribute as never));
    return setAttribute.call(this, name, attribute);
  } as typeof BufferGeometry.prototype.setAttribute;

  // ---- the readings
  const read = (seconds: number, whole: boolean): SiteReading[] => [...sites.values()]
    .filter((s) => (whole ? s.totalCalls : s.calls) > 0)
    .map((s) => ({
      kind: s.kind, what: s.what, where: s.where,
      msPerSecond: (whole ? s.total : s.ms) / seconds, callsPerSecond: (whole ? s.totalCalls : s.calls) / seconds, bytesPerSecond: (whole ? s.totalBytes : s.bytes) / seconds,
    }))
    .sort((a, b) => b.msPerSecond - a.msPerSecond || b.bytesPerSecond - a.bytesPerSecond || b.callsPerSecond - a.callsPerSecond);
  /** When the window began: a page held up runs its interval late, and its seconds are the ones that passed (DO NOT divide by `WINDOW_MS`). */
  let began = performance.now();
  let last: SiteReading[] = [];
  interval(() => {
    const now = performance.now();
    const seconds = Math.max(1e-3, (now - began) / 1000);
    began = now;
    last = read(seconds, false);
    const told = last.filter((r) => TIMED.includes(r.kind) && !frameSite.test(r.where) && r.msPerSecond >= TELL_MS_PER_S);
    if (told.length) {
      console.warn(`[hidden work] outside the game's frame, the last ${seconds.toFixed(1)} s:\n${told.map((r) =>
        `  ${r.msPerSecond.toFixed(1)} ms/s, ${r.callsPerSecond.toFixed(1)} calls/s - ${r.kind}${r.what ? ` ${r.what}` : ''} at ${r.where}`).join('\n')}`);
    }
    for (const s of sites.values()) { s.ms = 0; s.calls = 0; s.bytes = 0; }
  }, WINDOW_MS);
  const api: HiddenWork = {
    report: () => last,
    session: () => read(Math.max(1e-3, (performance.now() - startedAt.t) / 1000), true),
    contexts: live,
    deep(on) { deepOn = on; },
    get deepOn() { return deepOn; },
    reset() {
      startedAt.t = performance.now();
      for (const s of sites.values()) { s.total = 0; s.totalCalls = 0; s.totalBytes = 0; }
    },
  };
  Object.assign(window, { __hiddenWork: api });
  return api;
}

/** The watch, where the page installed it (`main.ts`, the development build); null in a player's build. */
export const hiddenWork = (): HiddenWork | null => (window as unknown as { __hiddenWork?: HiddenWork }).__hiddenWork ?? null;
