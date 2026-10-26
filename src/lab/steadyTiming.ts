import { type Camera, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, type WebGLRenderer, WebGLRenderTarget } from 'three';
import { createPassTimer } from './gpu/passTimer';

/**
 * THE LAB SHEETS' GPU TIMING: a frame's scene pass timed with the GPU kept at work, its variants interleaved in one page.
 * - THE GPU NEVER IDLE: before each block of passes timed, a load of plain arithmetic (`LOAD_MS` of the GPU's, next to none of the CPU's) is
 *   drawn into a target of its own. The GPU stays at its working clocks, and it is still on the load while the block is sent: the block's passes
 *   wait queued and run back to back. DO NOT time a fixed 10 passes and wait for the next frame: a light frame (0.45 ms) left the GPU idle three
 *   quarters of every 16.7 ms, its clocks fell and rose between and within runs, and identical frames timed 0.146 and 0.626 ms (the part sheets,
 *   gate 3, 2026-10-25); the GPU changes its clocks as it runs, which "can vary performance, introducing errors in measurements" (NVIDIA,
 *   "Advanced API Performance: SetStablePowerState", https://developer.nvidia.com/blog/advanced-api-performance-setstablepowerstate). Nor time
 *   long blocks or each pass alone with nothing ahead: a query's time is the GPU's from its begin to its end, idle or not, and once the GPU
 *   caught up with the CPU sending a light pass (the tower: 0.67 ms of GPU) it timed the CPU's pace - 0.91 ms a pass in blocks of 15, up to
 *   2.2 ms a pass timed alone (2026-10-25).
 * - A BLOCK HOLDS what the CPU sends in `BLOCK_CPU_MS`, under the load's time: measured once warm, for each variant.
 * - THE VARIANTS OF A FRAME (what it shows set by each one's `apply`) ARE SAMPLED IN TURN, one round after another, the order turned each round:
 *   each sees the GPU as the others do. A frame's identical copy timed beside it (`timeFrame`'s check) tells the spread of the method itself.
 * - Each block its own TIME_ELAPSED query (`gpu/passTimer.ts`), a disjoint round thrown away; the samples' wall-clock window kept, for the GPU's
 *   clocks logged beside the run (`nvidia-smi`, read only, by the sheets' scripts).
 */

/** GPU ms of the load drawn before each block. */
const LOAD_MS = 8;
/** CPU ms the passes of a block take to send, at most: under the load's time, so the GPU is never waiting for them. */
const BLOCK_CPU_MS = 4;
/** Passes a block holds at most. */
const MOST_PASSES = 60;
/** Wall-clock ms the variants are drawn in turn, each after a load, before they are measured. */
const WARM_MS = 1000;
/** Samples taken of each variant. */
const SAMPLES = 30;

/** A variant of a frame: what it shows set by `apply`, the scene then drawn as it stands. */
interface TimingVariant {
  readonly name: string;
  apply(): void;
}

/** A variant's scene pass, ms a pass: its median and its 10th and 90th centiles over its samples, each sample a block of `passes` passes;
 *  `window`, the samples' wall-clock span (ms since the epoch), for the GPU's clocks logged beside it. */
export interface SteadyTiming {
  readonly supported: boolean;
  readonly label: string;
  readonly samples: number;
  readonly passes: number;
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
  readonly window: { readonly start: number; readonly end: number };
}

const nextFrame = (): Promise<void> => new Promise((done) => { requestAnimationFrame(() => done()); });

/** The load: one full-screen draw of a loop of arithmetic into a 512-texel target of its own, its length `loops`. */
function createLoad(renderer: WebGLRenderer): { draw(loops: number): void; dispose(): void } {
  const target = new WebGLRenderTarget(512, 512, { depthBuffer: false });
  const material = new ShaderMaterial({
    uniforms: { uLoops: { value: 1 } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform int uLoops;
void main() {
  float a = gl_FragCoord.x * 0.001 + gl_FragCoord.y * 0.0007;
  for (int i = 0; i < uLoops; i++) a = fract(sin(a * 12.9898 + float(i) * 0.37) * 43758.5453);
  gl_FragColor = vec4(a);
}`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const camera = new OrthographicCamera();
  return {
    draw(loops) {
      material.uniforms['uLoops']!.value = loops;
      const was = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(was);
    },
    dispose() {
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}

/** The variants of one frame timed in turn (see the file's head). */
async function timeVariants(renderer: WebGLRenderer, scene: Scene, camera: Camera, variants: readonly TimingVariant[]): Promise<Map<string, SteadyTiming>> {
  // The GPU drawing, as the driver names it (`WEBGL_debug_renderer_info`).
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const label = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const timer = createPassTimer(renderer, SAMPLES * 4, 1024);
  const out = new Map<string, SteadyTiming>();
  if (!timer.supported) {
    const now = Date.now();
    for (const v of variants) out.set(v.name, { supported: false, label, samples: 0, passes: 0, median: Number.NaN, p10: Number.NaN, p90: Number.NaN, window: { start: now, end: now } });
    return out;
  }
  const load = createLoad(renderer);
  const render = (count: number): void => { for (let k = 0; k < count; k++) renderer.render(scene, camera); };
  /** One round of segments measured: `segments` drawn, the frame ended, its times once read (a disjoint one thrown away: null). */
  const measure = async (segments: () => void): Promise<ReadonlyMap<string, number> | null> => {
    timer.reset();
    segments();
    timer.frameEnded();
    for (let i = 0; i < 120 && timer.frames.length < 1; i++) { await nextFrame(); timer.poll(); }
    return timer.frames[0] ?? null;
  };
  // The load's length for `LOAD_MS`: its time measured and its loops scaled, three times.
  let loops = 256;
  for (let k = 0; k < 3; k++) {
    const times = await measure(() => { timer.push('load'); load.draw(loops); timer.pop(); });
    const ms = times?.get('load') ?? Number.NaN;
    if (Number.isFinite(ms) && ms > 0) loops = Math.max(1, Math.round((loops * LOAD_MS) / ms));
  }
  // The GPU at work before anything is measured: the variants drawn in turn, each after a load.
  for (const until = performance.now() + WARM_MS; performance.now() < until;) {
    for (const v of variants) { load.draw(loops); v.apply(); render(3); }
    await nextFrame();
  }
  // Each variant's block: the passes the CPU sends in `BLOCK_CPU_MS`, timed while warm.
  const passes = new Map<string, number>();
  for (const v of variants) {
    v.apply();
    load.draw(loops);
    const sent = performance.now();
    render(5);
    const cpu = (performance.now() - sent) / 5;
    passes.set(v.name, Math.min(MOST_PASSES, Math.max(1, Math.floor(BLOCK_CPU_MS / Math.max(cpu, 1e-3)))));
  }
  timer.reset();
  const start = Date.now();
  for (let r = 0; r < SAMPLES; r++) {
    const order = r % 2 === 0 ? variants : [...variants].reverse();
    for (const v of order) {
      load.draw(loops);
      v.apply();
      timer.push(v.name);
      render(passes.get(v.name)!);
      timer.pop();
    }
    timer.frameEnded();
    timer.poll();
    await nextFrame();
  }
  const end = Date.now();
  for (let i = 0; i < 240 && timer.frames.length < SAMPLES; i++) { await nextFrame(); timer.poll(); }
  for (const v of variants) {
    const n = passes.get(v.name)!;
    const times = timer.frames.map((f) => f.get(v.name)).filter((ms): ms is number => ms !== undefined).map((ms) => ms / n).sort((a, b) => a - b);
    const centile = (q: number): number => (times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))]! : Number.NaN);
    out.set(v.name, { supported: true, label, samples: times.length, passes: n, median: centile(0.5), p10: centile(0.1), p90: centile(0.9), window: { start, end } });
  }
  load.dispose();
  timer.dispose();
  return out;
}

/** One frame timed beside an identical copy of itself (the method's own spread): the frame's timing and the copy's. */
export async function timeFrame(renderer: WebGLRenderer, scene: Scene, camera: Camera): Promise<{ readonly gpu: SteadyTiming; readonly check: SteadyTiming }> {
  const timed = await timeVariants(renderer, scene, camera, [{ name: 'frame', apply() {} }, { name: 'check', apply() {} }]);
  return { gpu: timed.get('frame')!, check: timed.get('check')! };
}
