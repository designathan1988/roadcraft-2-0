import type { Object3D, WebGLRenderer } from 'three';
import type { LabContext } from '../labTypes';

/**
 * THE GPU'S TIMELINE WHILE THE GAME RUNS (the diagnosis's deep watch): every draw timed on the GPU and on the page (a TIME_ELAPSED query
 * round each of three's `renderBufferDirect`, the clock round it), every `renderer.render` filed by the line that asked it and by whether
 * the game's frame asked it (between its frame timer's `begin` and `end`, `renderer.ts`) or something outside it did (a bake, a palette,
 * a warm-up), every byte sent to the GPU by the line that sent it, every vertex format the driver has to convert, every call that makes
 * the page wait on the GPU, every resize of the drawing buffer. From them: whether the GPU is saturated, what each slow frame waited on,
 * the draws a stall lands on, the heaviest draws.
 * WHY: on 2026-10-27 the camera's 100-200 ms frames after a zoom were found only by hand (the main thread 82 % idle, the GPU's queue
 * behind, a stall landing on a random draw each slow frame, the clouds a third of every frame); the passes' averages and one frame's
 * capture showed none of it. DO NOT leave the diagnosis without these.
 * Khronos EXT_disjoint_timer_query_webgl2: one TIME_ELAPSED query active at a time (so per draw only, the renders summed from their draws),
 * results frames later (`QUERY_RESULT_AVAILABLE`), all undefined once `GPU_DISJOINT_EXT` reads true (thrown away). The game's own frame
 * timer is paused meanwhile (`GpuTimer.pause`). https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/
 * ANGLE on D3D11 converts 3-component 8- and 16-bit vertex formats: https://github.com/Microsoft/angle/wiki/Getting-Good-Performance-From-ANGLE
 */

interface TimerExtension { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number }

export interface Spread { readonly p50: number; readonly p95: number; readonly max: number }
/** A frame of the game as it went: from the last frame to it, its own work on the page, its draws' GPU time and their page time. */
export interface TimelineFrame { readonly intervalMs: number; readonly cpuMs: number; readonly gpuMs: number; readonly drawCpuMs: number; readonly draws: number; readonly waitedOn: 'gpu' | 'cpu' | 'neither' }
/** A draw that held the GPU far longer than its kind does: the queue was behind, or it is that heavy. */
export interface Stall { readonly draw: string; readonly gpuMs: number; readonly cpuMs: number; readonly typicalMs: number }
export interface DrawTotal { readonly draw: string; readonly gpuMsPerFrame: number; readonly maxMs: number; readonly calls: number }
export interface RenderCaller { readonly caller: string; readonly inFrame: boolean; readonly target: string; readonly calls: number; readonly gpuMs: number; readonly cpuMs: number; readonly maxGpuMs: number }
export interface UploadCaller { readonly caller: string; readonly call: string; readonly calls: number; readonly mb: number; readonly maxMb: number }
export interface Format { readonly format: string; readonly converted: boolean; readonly binds: number; readonly draws: readonly string[] }
export interface SyncCall { readonly call: string; readonly caller: string; readonly calls: number; readonly ms: number }
/** A shader program made while the game ran, by the draw that asked it (three makes it at a material's first draw): a compile the frame waited on. */
/** The page's own work in the frames it made late: a long frame's scripts by function and line (W3C Long Animation Frames, `PerformanceScriptTiming`), the game's timed steps (`core/hitch.ts`, `hitch:` measures). https://w3c.github.io/long-animation-frames/ */
export interface PageWork { readonly what: string; readonly where: string; readonly calls: number; readonly ms: number; readonly maxMs: number }
/** A function of the page's CPU profile during the watch (JS Self-Profiling API): its own time and its time with what it called. */
export interface CpuFunction { readonly name: string; readonly where: string; readonly selfMs: number; readonly totalMs: number }
export interface ProgramMade { readonly draw: string; readonly caller: string; readonly programs: number }

export interface GpuTimeline {
  readonly seconds: number;
  readonly frames: readonly TimelineFrame[];
  readonly gpu: Spread;
  readonly interval: Spread;
  /** The display's frame, ms (the median interval of the frames that kept up, at least 1000/240). */
  readonly vsyncMs: number;
  /** Frames over 1.5 frames of the display, and of them how many waited on the GPU (its draws took longer than the page's work). */
  readonly late: number;
  readonly lateOnGpu: number;
  /** The share of the time the GPU was drawing the game's frames and the work outside them. */
  readonly gpuBusy: number;
  readonly stalls: readonly Stall[];
  readonly heaviest: readonly DrawTotal[];
  readonly renders: readonly RenderCaller[];
  readonly uploads: readonly UploadCaller[];
  readonly formats: readonly Format[];
  readonly sync: readonly SyncCall[];
  readonly resizes: readonly { readonly caller: string; readonly calls: number }[];
  /** The page's work in its long frames, by script, and the game's timed steps, by name (`PageWork`). */
  readonly pageWork: readonly PageWork[];
  /** The CPU profile of the watch, by own time and by time with callees (`CpuFunction`); empty where the API is not allowed. */
  readonly cpuSelf: readonly CpuFunction[];
  readonly cpuTotal: readonly CpuFunction[];
  readonly steps: readonly PageWork[];
  /** The shader programs made during the watch, by the draw that asked each (`ProgramMade`). */
  readonly programs: readonly ProgramMade[];
  /** Results lost: queries not answered in time, frames disjoint. */
  readonly lost: number;
}

const TYPE_NAMES: Readonly<Record<number, string>> = { 5120: 'BYTE', 5121: 'UBYTE', 5122: 'SHORT', 5123: 'USHORT', 5124: 'INT', 5125: 'UINT', 5126: 'FLOAT', 5131: 'HALF' };
/** Bytes a component, by type; components a texel, by format (RED, RG, RGB, RGBA, their integer forms, depth, luminance, alpha). */
const TYPE_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5124: 4, 5125: 4, 5126: 4, 5131: 2, 36193: 2 };
const COMPONENTS: Readonly<Record<number, number>> = { 6403: 1, 33319: 2, 6407: 3, 6408: 4, 36244: 1, 33320: 2, 36248: 3, 36249: 4, 6402: 1, 6409: 1, 6410: 2, 6406: 1 };
/** One or two bytes a component. */
const SMALL_TYPES: readonly number[] = Object.freeze([5120, 5121, 5122, 5123, 5131]);
/** The calls that make the page wait for the GPU process to answer (a round trip, every command before them flushed). */
const SYNC_CALLS = ['readPixels', 'getBufferSubData', 'getError', 'finish', 'clientWaitSync', 'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'checkFramebufferStatus', 'getSyncParameter'] as const;
const UPLOAD_CALLS = ['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D', 'copyBufferSubData', 'texStorage2D', 'texStorage3D'] as const;
/** How long the GPU answers are waited for after the watch, ms. */
const ANSWER_WAIT_MS = 3000;
/** A draw over this many times its kind's median, and at least this long, is a stall. */
const STALL_TIMES = 8;
const STALL_MS = 25;

const spreadOf = (values: readonly number[]): Spread => {
  if (!values.length) return { p50: 0, p95: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  return { p50: s[s.length >> 1]!, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!, max: s[s.length - 1]! };
};

/** The first line of the game's own code that asked (the stack's frames in `src/`, the lab's and this file's left out). */
function callerOf(): string {
  const lines = (new Error().stack ?? '').split('\n');
  for (const line of lines) {
    if (!line.includes('/src/') || line.includes('/src/lab/') || line.includes('node_modules')) continue;
    const m = /\/(src\/[^?:)]+)(?:\?[^:)]*)?:(\d+)/.exec(line);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return '(outside src)';
}

/** A draw named by its object, its nearest named ancestor and its material. */
function drawName(object: Object3D, material: { name?: string; type?: string }): string {
  let parent = object.parent;
  while (parent && !parent.name) parent = parent.parent;
  return `${object.name || object.type}${parent ? ` < ${parent.name}` : ''} [${material.name || material.type || '?'}]`;
}

/** A JS Self-Profiling trace (https://wicg.github.io/js-self-profiling/). */
interface Trace {
  readonly frames: readonly { readonly name: string; readonly resourceId?: number; readonly line?: number }[];
  readonly stacks: readonly { readonly frameId: number; readonly parentId?: number }[];
  readonly samples: readonly { readonly timestamp: number; readonly stackId?: number }[];
  readonly resources: readonly string[];
}
type ProfilerCtor = new (o: { sampleInterval: number; maxBufferSize: number }) => { stop(): Promise<Trace> };

/** A trace summed by function: own time (the top of each sample's stack) and time with callees (every function once a sample); the lab's own left out. */
function cpuOf(trace: Trace | null): { cpuSelf: CpuFunction[]; cpuTotal: CpuFunction[] } {
  if (!trace || trace.samples.length < 2) return { cpuSelf: [], cpuTotal: [] };
  const whereOf = (f: { readonly resourceId?: number; readonly line?: number }): string => {
    const url = f.resourceId === undefined ? '' : (trace.resources[f.resourceId] ?? '').replace(/^https?:[/][/][^/]+[/]/, '').replace(/[?].*$/, '');
    return url ? `${url}:${f.line ?? 0}` : '(native)';
  };
  const byKey = new Map<string, { name: string; where: string; selfMs: number; totalMs: number }>();
  const entry = (frameId: number): { name: string; where: string; selfMs: number; totalMs: number } => {
    const f = trace.frames[frameId]!;
    const where = whereOf(f), key = `${f.name}|${where}`;
    let e = byKey.get(key);
    if (!e) byKey.set(key, e = { name: f.name || '(anonymous)', where, selfMs: 0, totalMs: 0 });
    return e;
  };
  for (let i = 0; i < trace.samples.length - 1; i++) {
    const s = trace.samples[i]!, dt = trace.samples[i + 1]!.timestamp - s.timestamp;
    if (s.stackId === undefined) continue;
    let stack = trace.stacks[s.stackId];
    if (stack) entry(stack.frameId).selfMs += dt;
    const seen = new Set<object>();
    while (stack) {
      const e = entry(stack.frameId);
      if (!seen.has(e)) { seen.add(e); e.totalMs += dt; }
      stack = stack.parentId === undefined ? undefined : trace.stacks[stack.parentId];
    }
  }
  const all = [...byKey.values()].filter((f) => !f.where.includes('src/lab/'));
  return { cpuSelf: [...all].sort((a, b) => b.selfMs - a.selfMs).slice(0, 30), cpuTotal: [...all].sort((a, b) => b.totalMs - a.totalMs).slice(0, 40) };
}

/** The GPU's timeline recorded for `ms` (`GpuTimeline`); null where the timer extension is missing. Everything put back as it was after. */
export async function recordGpuTimeline(ctx: LabContext, ms: number): Promise<GpuTimeline | null> {
  const renderer = ctx.scene.gl as WebGLRenderer & { renderBufferDirect: (...a: unknown[]) => void; render: (...a: unknown[]) => void; setDrawingBufferSize: (...a: unknown[]) => void; setSize: (...a: unknown[]) => void };
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
  if (!ext) return null;
  // The callers named past three's own frames: V8 keeps ten frames of a stack by default, and three's upload path took them all ("(outside src)" for 18 GB of uploads, 2026-10-27).
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const frameTimer = ctx.scene.gpu as unknown as { begin(): void; end(): void; pause(on: boolean): void; readonly paused: boolean };
  const wasPaused = frameTimer.paused;
  frameTimer.pause(true);
  gl.getParameter(ext.GPU_DISJOINT_EXT);

  interface DrawQuery { readonly query: WebGLQuery; readonly draw: string; readonly cpu: number; readonly frame: number; readonly render: number }
  const queries: DrawQuery[] = [];
  const renderCalls: { caller: string; inFrame: boolean; target: string; cpu: number }[] = [];
  const uploads = new Map<string, { calls: number; mb: number; maxMb: number }>();
  const formats = new Map<string, { converted: boolean; binds: number; draws: Set<string> }>();
  const sync = new Map<string, { calls: number; ms: number }>();
  const resizes = new Map<string, number>();
  const programsMade = new Map<string, number>();
  const frames: { intervalMs: number; cpuMs: number }[] = [];
  let inFrame = false, frame = 0, renderNo = -1, drawing: string | null = null, lost = 0;

  // The game's frame: what its frame timer brackets (`renderer.ts`: begin, post.render, end).
  const begin = frameTimer.begin, end = frameTimer.end;
  frameTimer.begin = function () { inFrame = true; begin.call(frameTimer); };
  frameTimer.end = function () { end.call(frameTimer); inFrame = false; frame++; };
  const stopFrames = ctx.onFrame((s) => { frames.push({ intervalMs: s.intervalMs, cpuMs: s.cpuMs }); });
  // The page's work in its long frames, and the game's timed steps.
  const scripts = new Map<string, { what: string; where: string; calls: number; ms: number; maxMs: number }>();
  const steps = new Map<string, { what: string; where: string; calls: number; ms: number; maxMs: number }>();
  const add = (into: typeof scripts, what: string, where: string, ms: number): void => {
    const key = `${what}|${where}`;
    const w = into.get(key) ?? { what, where, calls: 0, ms: 0, maxMs: 0 };
    w.calls++; w.ms += ms; w.maxMs = Math.max(w.maxMs, ms);
    into.set(key, w);
  };
  interface ScriptTiming { readonly duration: number; readonly invoker?: string; readonly sourceFunctionName?: string; readonly sourceURL?: string; readonly sourceCharPosition?: number }
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, read: (entry: PerformanceEntry) => void): void => {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    const o = new PerformanceObserver((list) => { for (const entry of list.getEntries()) read(entry); });
    o.observe({ type, buffered: false });
    observers.push(o);
  };
  observe('long-animation-frame', (entry) => {
    for (const s of (entry as unknown as { scripts?: readonly ScriptTiming[] }).scripts ?? []) {
      const url = (s.sourceURL ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
      add(scripts, s.sourceFunctionName || s.invoker || '(anonymous)', `${url || '(no source)'}${s.sourceCharPosition !== undefined && s.sourceCharPosition >= 0 ? ` @${s.sourceCharPosition}` : ''}`, s.duration);
    }
  });
  // The page's CPU sampled meanwhile (JS Self-Profiling API; the dev server sends Document-Policy: js-profiling): what the late frames' page time went on.
  const Profiler = (globalThis as { Profiler?: ProfilerCtor }).Profiler;
  let profiler: { stop(): Promise<Trace> } | null = null;
  try { profiler = Profiler ? new Profiler({ sampleInterval: 1, maxBufferSize: ms + 2000 }) : null; } catch (error) { console.warn('lab doctor: no CPU profile for the timeline', error); }
  observe('measure', (entry) => { if (entry.name.startsWith('hitch:')) add(steps, entry.name.slice(6), '', entry.duration); });

  const render = renderer.render;
  renderer.render = function (...args: unknown[]) {
    renderNo++;
    const t0 = performance.now();
    const target = renderer.getRenderTarget();
    const call = { caller: callerOf(), inFrame, target: target ? `${target.width}x${target.height}` : 'screen', cpu: 0 };
    renderCalls.push(call);
    try { render.apply(renderer, args); } finally { call.cpu = performance.now() - t0; }
  };
  const direct = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function (...args: unknown[]) {
    const object = args[4] as Object3D, material = args[3] as { name?: string; type?: string };
    const name = drawName(object, material);
    const query = gl.createQuery();
    const t0 = performance.now();
    drawing = name;
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    try { direct.apply(renderer, args); } finally {
      if (query) gl.endQuery(ext.TIME_ELAPSED_EXT);
      drawing = null;
      if (query) queries.push({ query, draw: name, cpu: performance.now() - t0, frame: inFrame ? frame : -1, render: renderNo });
    }
  };
  const drawingBuffer = renderer.setDrawingBufferSize, setSize = renderer.setSize;
  renderer.setDrawingBufferSize = function (...args: unknown[]) { const c = callerOf(); resizes.set(c, (resizes.get(c) ?? 0) + 1); drawingBuffer.apply(renderer, args); };
  renderer.setSize = function (...args: unknown[]) { const c = callerOf(); resizes.set(c, (resizes.get(c) ?? 0) + 1); setSize.apply(renderer, args); };

  // The context's own calls: what goes up, what waits, what the driver converts.
  const own = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
  const restore: (() => void)[] = [];
  const wrap = (name: string, around: (call: (...a: unknown[]) => unknown, args: unknown[]) => unknown): void => {
    const original = own[name];
    if (typeof original !== 'function') return;
    const bound = original.bind(gl);
    own[name] = (...args: unknown[]) => around(bound, args);
    restore.push(() => { delete own[name]; });
  };
  const bytesOf = (value: unknown): number => {
    if (typeof value === 'number') return value;
    const v = value as { byteLength?: number; width?: number; height?: number } | null;
    if (v?.byteLength !== undefined) return v.byteLength;
    return v?.width && v.height ? v.width * v.height * 4 : 0;
  };
  for (const name of UPLOAD_CALLS) {
    wrap(name, (call, args) => {
      // The bytes sent: a texture's region by its size, format and type (a row of a large source sends the row, not the source: the source's
      // size counted made 18 GB of a move's row updates, 2026-10-27); a buffer's by its length argument where given
      // (bufferSubData(target, offset, src, srcOffset, length) sends `length` elements), else its data's.
      let bytes = 0;
      if (name === 'texSubImage2D' || name === 'texSubImage3D') {
        const deep = name === 'texSubImage3D';
        const w = Number(args[4]), h = Number(args[5]), d = deep ? Number(args[6]) : 1;
        const format = Number(args[deep ? 8 : 6]), type = Number(args[deep ? 9 : 7]);
        bytes = w * h * d * (COMPONENTS[format] ?? 4) * (TYPE_BYTES[type] ?? 1);
      } else if (name === 'bufferData') bytes = typeof args[1] === 'number' ? args[1] : bytesOf(args[1]);
      else if (name === 'bufferSubData') {
        const data = args[2] as { BYTES_PER_ELEMENT?: number } | null;
        const each = data?.BYTES_PER_ELEMENT ?? 1;
        bytes = args[4] !== undefined ? Number(args[4]) * each : bytesOf(data) - Number(args[3] ?? 0) * each;
      } else if (name === 'copyBufferSubData') bytes = Number(args[4]) || 0;
      else if (!name.startsWith('texStorage')) for (const a of args) if (a && typeof a === 'object') bytes = Math.max(bytes, bytesOf(a));
      // A texture told by its size and type (what names it at the GL level): texSubImage2D(target, level, x, y, width, height, format, type, ...), texSubImage3D with a depth after the height.
      const dims = name === 'texSubImage2D' ? ` ${Number(args[4])}x${Number(args[5])} ${TYPE_NAMES[Number(args[7])] ?? args[7]}`
        : name === 'texSubImage3D' ? ` ${Number(args[5])}x${Number(args[6])}x${Number(args[7])} ${TYPE_NAMES[Number(args[9])] ?? args[9]}` : '';
      const key = `${name}${dims} | ${callerOf()}`;
      const u = uploads.get(key) ?? { calls: 0, mb: 0, maxMb: 0 };
      u.calls++; u.mb += bytes / 2 ** 20; u.maxMb = Math.max(u.maxMb, bytes / 2 ** 20);
      uploads.set(key, u);
      return call(...args);
    });
  }
  for (const name of SYNC_CALLS) {
    wrap(name, (call, args) => {
      const t0 = performance.now();
      try { return call(...args); } finally {
        const key = `${name} | ${callerOf()}`;
        const s = sync.get(key) ?? { calls: 0, ms: 0 };
        s.calls++; s.ms += performance.now() - t0;
        sync.set(key, s);
      }
    });
  }
  const recordFormat = (size: number, type: number, normalized: boolean, integer: boolean): void => {
    const key = `${TYPE_NAMES[type] ?? type} x${size}${normalized ? ' normalized' : ''}${integer ? ' (integer)' : ''}`;
    const f = formats.get(key) ?? { converted: size === 3 && SMALL_TYPES.includes(type), binds: 0, draws: new Set<string>() };
    f.binds++;
    if (drawing && f.draws.size < 6) f.draws.add(drawing);
    formats.set(key, f);
  };
  wrap('createProgram', (call, args) => { const key = `${drawing ?? '(no draw)'} | ${callerOf()}`; programsMade.set(key, (programsMade.get(key) ?? 0) + 1); return call(...args); });
  wrap('vertexAttribPointer', (call, args) => { recordFormat(Number(args[1]), Number(args[2]), Boolean(args[3]), false); return call(...args); });
  wrap('vertexAttribIPointer', (call, args) => { recordFormat(Number(args[1]), Number(args[2]), false, true); return call(...args); });

  ctx.requestDraw();
  const t0 = performance.now();
  const keepDrawing = ctx.onFrame(() => ctx.requestDraw());
  await new Promise<void>((done) => { window.setTimeout(done, ms); });
  const seconds = (performance.now() - t0) / 1000;
  keepDrawing();
  stopFrames();
  for (const o of observers) o.disconnect();
  const trace = profiler ? await profiler.stop().catch((error: unknown) => { console.warn('lab doctor: the CPU profile was lost', error); return null; }) : null;
  // Everything put back before the answers are read: the game runs as it did.
  renderer.render = render;
  renderer.renderBufferDirect = direct;
  renderer.setDrawingBufferSize = drawingBuffer;
  renderer.setSize = setSize;
  for (const undo of restore) undo();
  frameTimer.begin = begin;
  frameTimer.end = end;
  Error.stackTraceLimit = stackLimit;

  // The GPU's answers, as they come (never before control is back to the browser).
  const gpuOf = new Map<DrawQuery, number>();
  const until = performance.now() + ANSWER_WAIT_MS;
  while (gpuOf.size + lost < queries.length && performance.now() < until) {
    await new Promise<void>((next) => { requestAnimationFrame(() => next()); });
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const q of queries) if (!gpuOf.has(q)) { gl.deleteQuery(q.query); lost++; gpuOf.set(q, -1); }
      break;
    }
    for (const q of queries) {
      if (gpuOf.has(q) || !gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      gpuOf.set(q, (gl.getQueryParameter(q.query, gl.QUERY_RESULT) as number) / 1e6);
      gl.deleteQuery(q.query);
    }
  }
  for (const q of queries) if (!gpuOf.has(q)) { gl.deleteQuery(q.query); lost++; }
  frameTimer.pause(wasPaused);

  // The game's frames: their draws' GPU and page time, against what the page saw of them.
  const perFrame = new Map<number, { gpu: number; cpu: number; draws: number }>();
  const byDraw = new Map<string, number[]>();
  const perRender = new Map<number, number>();
  let gpuTotal = 0;
  for (const q of queries) {
    const g = gpuOf.get(q);
    if (g === undefined || g < 0) continue;
    gpuTotal += g;
    perRender.set(q.render, (perRender.get(q.render) ?? 0) + g);
    (byDraw.get(q.draw) ?? byDraw.set(q.draw, []).get(q.draw)!).push(g);
    if (q.frame < 0) continue;
    const f = perFrame.get(q.frame) ?? { gpu: 0, cpu: 0, draws: 0 };
    f.gpu += g; f.cpu += q.cpu; f.draws++;
    perFrame.set(q.frame, f);
  }
  const gameFrames = [...perFrame.keys()].sort((a, b) => a - b).map((k) => perFrame.get(k)!);
  const intervals = frames.map((f) => f.intervalMs).filter((v) => v > 0);
  const vsyncMs = Math.max(1000 / 240, spreadOf(intervals).p50 || 1000 / 60);
  // The page's frames and the GPU's lined up from the newest (the first few of either may have no match).
  const n = Math.min(gameFrames.length, frames.length);
  const timeline: TimelineFrame[] = [];
  for (let k = 0; k < n; k++) {
    const g = gameFrames[gameFrames.length - n + k]!, p = frames[frames.length - n + k]!;
    const late = p.intervalMs > 1.5 * vsyncMs;
    timeline.push({ intervalMs: p.intervalMs, cpuMs: p.cpuMs, gpuMs: g.gpu, drawCpuMs: g.cpu, draws: g.draws, waitedOn: !late ? 'neither' : g.gpu > p.cpuMs ? 'gpu' : 'cpu' });
  }
  const typical = new Map<string, number>();
  for (const [draw, list] of byDraw) typical.set(draw, spreadOf(list).p50);
  const stalls: Stall[] = [];
  for (const q of queries) {
    const g = gpuOf.get(q);
    if (g === undefined || g < STALL_MS) continue;
    const t = typical.get(q.draw) ?? 0;
    if (g > STALL_TIMES * Math.max(t, 0.5)) stalls.push({ draw: q.draw, gpuMs: g, cpuMs: q.cpu, typicalMs: t });
  }
  stalls.sort((a, b) => b.gpuMs - a.gpuMs);
  const frameCount = Math.max(1, gameFrames.length);
  const heaviest = [...byDraw].map(([draw, list]) => ({ draw, gpuMsPerFrame: list.reduce((a, b) => a + b, 0) / frameCount, maxMs: spreadOf(list).max, calls: list.length }))
    .sort((a, b) => b.gpuMsPerFrame - a.gpuMsPerFrame).slice(0, 25);
  const renders = new Map<string, { caller: string; inFrame: boolean; target: string; calls: number; gpuMs: number; cpuMs: number; maxGpuMs: number }>();
  renderCalls.forEach((c, i) => {
    const key = `${c.caller}|${c.inFrame}|${c.target}`;
    const r = renders.get(key) ?? { caller: c.caller, inFrame: c.inFrame, target: c.target, calls: 0, gpuMs: 0, cpuMs: 0, maxGpuMs: 0 };
    const g = perRender.get(i) ?? 0;
    r.calls++; r.gpuMs += g; r.cpuMs += c.cpu; r.maxGpuMs = Math.max(r.maxGpuMs, g);
    renders.set(key, r);
  });
  return {
    seconds,
    frames: timeline,
    gpu: spreadOf(timeline.map((f) => f.gpuMs)),
    interval: spreadOf(intervals),
    vsyncMs,
    late: timeline.filter((f) => f.waitedOn !== 'neither').length,
    lateOnGpu: timeline.filter((f) => f.waitedOn === 'gpu').length,
    gpuBusy: seconds > 0 ? gpuTotal / 1000 / seconds : 0,
    stalls: stalls.slice(0, 20),
    heaviest,
    renders: [...renders.values()].sort((a, b) => b.gpuMs - a.gpuMs).slice(0, 30),
    uploads: [...uploads].map(([key, u]) => { const [call, caller] = key.split(' | ') as [string, string]; return { caller, call, ...u }; }).sort((a, b) => b.mb - a.mb).slice(0, 25),
    formats: [...formats].map(([format, f]) => ({ format, converted: f.converted, binds: f.binds, draws: [...f.draws] })).sort((a, b) => Number(b.converted) - Number(a.converted) || b.binds - a.binds),
    sync: [...sync].map(([key, s]) => { const [call, caller] = key.split(' | ') as [string, string]; return { call, caller, ...s }; }).sort((a, b) => b.ms - a.ms).slice(0, 20),
    resizes: [...resizes].map(([caller, calls]) => ({ caller, calls })),
    ...cpuOf(trace),
    pageWork: [...scripts.values()].sort((a, b) => b.ms - a.ms).slice(0, 20),
    steps: [...steps.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, 20),
    programs: [...programsMade].map(([key, programs]) => { const [draw, caller] = key.split(' | ') as [string, string]; return { draw, caller, programs }; }).sort((a, b) => b.programs - a.programs).slice(0, 30),
    lost,
  };
}
