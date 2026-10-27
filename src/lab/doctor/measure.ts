import { hiddenWork, type SiteReading } from '../hiddenWork';
import type { LabContext, LabSample } from '../labTypes';
import { scanWaste, type Waste } from './waste';
import { recordGpuTimeline, type GpuTimeline } from './gpuTimeline';

/** THE DIAGNOSIS'S MEASURES: one snapshot of where the frame goes (the GPU's passes, one frame's every draw, the CPU's systems and functions), and the quick A/B of one change (off, measured, back on, measured), from the other areas' probes. */

interface PassTime { readonly pass: string; readonly label: string; readonly avg: number; readonly p95: number; readonly share: number }
export interface Draw {
  readonly object: unknown; readonly name: string; readonly layer: string; readonly kind: string; readonly material: string; readonly program: string;
  readonly triangles: number; readonly calls: number; readonly instances: number; readonly pass: string; readonly target: string;
}
interface ProfileFn { readonly name: string; readonly where: string; readonly category: string; readonly selfMs: number; readonly totalMs: number; readonly samples: number }

export interface Snapshot {
  readonly at: number;
  /** Medians over the measuring window, ms. */
  readonly frameMs: number;
  readonly cpuMs: number;
  /** The sum of the passes' averages (the frame's GPU time), or the frame timer's median; null with no timer. */
  readonly gpuMs: number | null;
  readonly frames: number;
  readonly passes: readonly PassTime[];
  readonly draws: readonly Draw[];
  readonly systems: readonly (readonly [string, number])[];
  readonly functions: readonly ProfileFn[];
  /** The library's and the browser's own functions that took the most (three's render, WebGL's calls, the collector): where the game's "drawing" goes inside three. DO NOT leave them out: the 9 ms a frame of three's render at a street read as nobody's (2026-10-27). */
  readonly libraryFunctions: readonly ProfileFn[];
  readonly drawCalls: number;
  readonly triangles: number;
  readonly hitches: number;
  /** What the scene spends for nothing on the screen (`waste.ts`); null when no frame was captured. */
  readonly waste: Waste | null;
  /** The page's callbacks and what three was asked again during the measure, by line (`hiddenWork.ts`); null without the watch. */
  readonly hidden: readonly SiteReading[] | null;
  readonly hiddenSeconds: number;
  /** The resources' checks (`resources/diagnostics.ts`). */
  readonly checks: readonly Check[];
  /** The CPU profile's suspects over the session (`code/analysis.ts`). */
  readonly suspects: readonly Suspect[];
  /** WebGL contexts alive, by the line that made each. */
  readonly contexts: readonly string[];
  /** The GPU's timeline with the view still: every draw timed, the work outside the frame, the uploads, the formats, the waits (`gpuTimeline.ts`); null without the timer. */
  readonly timeline: GpuTimeline | null;
}

interface Check { readonly id: string; readonly title: string; readonly verdict: string; readonly value: string; readonly why: string }
interface Suspect { readonly kind: string; readonly name: string; readonly where: string; readonly value: number; readonly detail: string }

interface GpuProbe {
  passTiming(on: boolean): void;
  passes(): PassTime[];
  capture(): Promise<{ records: readonly Draw[] }>;
  lab?: { passTiming: boolean };
}
interface CodeProbe { start(live?: boolean): void; functions(view?: string): ProfileFn[]; suspects(view?: string): Suspect[]; status(): { running: boolean } }

const gpuProbe = (): GpuProbe | null => (window as unknown as { __labGpu?: GpuProbe }).__labGpu ?? null;
const codeProbe = (): CodeProbe | null => (window as unknown as { __labCode?: CodeProbe }).__labCode ?? null;

const median = (values: readonly number[]): number => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });

/** The frames drawn for `ms`, every frame asked for (the game draws on demand: a still view would give none). */
async function framesFor(ctx: LabContext, ms: number): Promise<{ samples: LabSample[]; gpu: number[] }> {
  const samples: LabSample[] = [];
  const ring = ctx.scene.gpu.samples;
  const pushed = ring.pushed;
  const stop = ctx.onFrame((s) => { samples.push(s); ctx.requestDraw(); });
  ctx.requestDraw();
  await wait(ms);
  stop();
  const fresh = Math.min(ring.pushed - pushed, ring.size);
  const gpu: number[] = [];
  for (let back = 0; back < fresh; back++) gpu.push(ring.newest(back));
  return { samples, gpu };
}

/** Where the frame goes now: the passes timed for a while, one frame captured, the CPU sampled meanwhile. */
export async function snapshot(ctx: LabContext, progress: (text: string) => void): Promise<Snapshot> {
  const gpu = gpuProbe();
  const code = codeProbe();
  // The page's own work timed and three's requests read by their lines while the measure runs (`hiddenWork.ts`), then put back.
  const watch = hiddenWork();
  const wasDeep = watch?.deepOn ?? false;
  watch?.reset();
  watch?.deep(true);
  const watchedFrom = performance.now();
  // Sampling only while asked (its tab open, or here): started for the measure if it was not running, stopped after.
  const wasRunning = code?.status().running ?? false;
  // The frame measured first, with nothing of the lab's measuring running (the CPU profile and the per-pass queries cost time themselves).
  gpu?.passTiming(false);
  progress('measuring the frames…');
  const plain = await framesFor(ctx, 2000);
  if (code && !wasRunning) code.start(true);
  let passes: PassTime[] = [];
  if (gpu && ctx.scene.gpu.supported) {
    progress('measuring every GPU pass…');
    gpu.passTiming(true);
    await framesFor(ctx, 2500);
    passes = gpu.passes().filter((p) => p.avg > 0);
    gpu.passTiming(false);
  }
  progress('timing every draw on the GPU…');
  let timeline: GpuTimeline | null = null;
  try { timeline = await recordGpuTimeline(ctx, 3000); } catch (error) { console.error('lab doctor: the GPU timeline failed', error); }
  let draws: readonly Draw[] = [];
  if (gpu) {
    progress('capturing a frame…');
    try { draws = (await gpu.capture()).records; } catch (error) { console.warn('lab doctor: capture failed', error); }
  }
  // The profile's window closes a few seconds after it began: its functions read once it has.
  if (code) {
    for (let t = 0; t < 5000 && !code.functions('session').some((f) => f.category === 'game'); t += 500) {
      progress('reading the CPU profile…');
      await framesFor(ctx, 500);
    }
  }
  if (code && !wasRunning) code.start(false);
  // What the scene spends for nothing on the screen, against the frame just captured.
  let waste: Waste | null = null;
  if (draws.length) {
    try { waste = await scanWaste(ctx, draws, progress); } catch (error) { console.error('lab doctor: the waste scan failed', error); }
  }
  const hidden = watch ? watch.session() : null;
  const hiddenSeconds = (performance.now() - watchedFrom) / 1000;
  watch?.deep(wasDeep);
  const resources = (window as unknown as { __labResources?: { diagnostics(): Check[] } }).__labResources;
  let checks: Check[] = [];
  try { checks = resources?.diagnostics() ?? []; } catch (error) { console.error('lab doctor: the checks failed', error); }
  let suspects: Suspect[] = [];
  try { suspects = code?.suspects('session') ?? []; } catch (error) { console.error('lab doctor: the profile suspects failed', error); }
  const systems = new Map<string, number[]>();
  for (const s of plain.samples) for (const [k, v] of s.systems) (systems.get(k) ?? systems.set(k, []).get(k)!).push(v);
  const passSum = passes.reduce((a, p) => a + p.avg, 0);
  return {
    at: performance.now(),
    frameMs: median(plain.samples.map((s) => s.intervalMs).filter((v) => v > 0)),
    cpuMs: median(plain.samples.map((s) => s.cpuMs)),
    gpuMs: passSum > 0 ? passSum : plain.gpu.length ? median(plain.gpu) : null,
    frames: plain.samples.length,
    passes,
    draws,
    systems: [...systems].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => b[1] - a[1]),
    functions: code ? code.functions('session').filter((f) => f.category === 'game').sort((a, b) => b.selfMs - a.selfMs).slice(0, 12) : [],
    libraryFunctions: code ? code.functions('session').filter((f) => f.category !== 'game' && f.category !== 'lab').sort((a, b) => b.selfMs - a.selfMs).slice(0, 16) : [],
    drawCalls: median(plain.samples.map((s) => s.drawCalls)),
    triangles: median(plain.samples.map((s) => s.triangles)),
    hitches: plain.samples.filter((s) => s.intervalMs > 50).length,
    waste, hidden, hiddenSeconds, checks, suspects,
    contexts: watch?.contexts() ?? [],
    timeline,
  };
}

export interface AbResult {
  readonly gpuA: number | null; readonly gpuB: number | null;
  readonly cpuA: number; readonly cpuB: number;
  readonly drawsA: number; readonly drawsB: number;
  readonly trisA: number; readonly trisB: number;
  /** How far the two A windows differ: under it a delta is noise. */
  readonly noiseGpu: number;
  readonly noiseCpu: number;
}

/** The frames drawn until no shader program has been made for 600 ms (a change compiles them), at most 6 s. */
async function settled(ctx: LabContext): Promise<void> {
  const programs = (): number => ctx.scene.gl.info.programs?.length ?? 0;
  let count = programs(), still = 0;
  for (let t = 0; t < 6000 && still < 600; t += 200) {
    await framesFor(ctx, 200);
    const now = programs();
    still = now === count ? still + 200 : 0;
    count = now;
  }
  await framesFor(ctx, 400);
}

/** A, change, B, back, A again: B against the mean of the two A (Δ under their gap is noise). */
export async function quickAb(ctx: LabContext, change: () => void, back: () => void, progress: (text: string) => void): Promise<AbResult> {
  gpuProbe()?.passTiming(false);
  const read = async (ms: number): Promise<{ gpu: number | null; cpu: number; draws: number; tris: number }> => {
    const f = await framesFor(ctx, ms);
    return { gpu: f.gpu.length ? median(f.gpu) : null, cpu: median(f.samples.map((s) => s.cpuMs)), draws: median(f.samples.map((s) => s.drawCalls)), tris: median(f.samples.map((s) => s.triangles)) };
  };
  progress('settling…');
  await framesFor(ctx, 700);
  progress('measuring before…');
  const a1 = await read(1500);
  change();
  progress('applied: compiling and settling…');
  await settled(ctx);
  progress('measuring after…');
  const b = await read(1500);
  back();
  progress('undone: compiling and settling…');
  await settled(ctx);
  progress('measuring again…');
  const a2 = await read(1500);
  const mean = (x: number | null, y: number | null): number | null => (x === null || y === null ? x ?? y : (x + y) / 2);
  return {
    gpuA: mean(a1.gpu, a2.gpu), gpuB: b.gpu,
    cpuA: (a1.cpu + a2.cpu) / 2, cpuB: b.cpu,
    drawsA: (a1.draws + a2.draws) / 2, drawsB: b.draws,
    trisA: (a1.tris + a2.tris) / 2, trisB: b.tris,
    noiseGpu: a1.gpu !== null && a2.gpu !== null ? Math.abs(a1.gpu - a2.gpu) : 0,
    noiseCpu: Math.abs(a1.cpu - a2.cpu),
  };
}
