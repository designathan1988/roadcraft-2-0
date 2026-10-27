// THE CAMERA BENCH: the 10 km city of a fixed seed, the fixed camera path (`scripts/lib/cameraPath.mjs`: district pan, street pan, zoom in,
// zoom out, orbit, back to the whole map), the same window size, the window visible; numbers per segment, written as JSON.
//
//   node scripts/bench-camera.mjs <out.json> [--city large|small] [--loop <minutes>] [--shared-gpu] [--shared-machine]
//
// Per segment: the frame's own CPU time measured inside the game's loop (`main.ts` benchFrames: input to overlay, not the interval between
// animation frames), p50/p95/p99/max and the frames past 33 and 50 ms; the GPU's time a frame (the game's timer queries, `__gpu`); the long
// tasks; draws and triangles a frame; the bytes uploaded to the GPU a frame and the programs linked (`glCounter`); the GPU's load and clocks
// meanwhile (`gpu-clocks.mjs`, nvidia-smi read only: a page paced at the GPU's speed shows the GPU busy); after a zoom, the seconds
// until every building level has landed. At the end: the JS heap and the GPU's geometries. `--loop`: the path again and again for that many
// minutes, the heap and geometries after each lap (the acceptance's stability check).
// THE TOOL CHECKS ITSELF: the frames a second can never pass what the median interval allows (frames / seconds <= 1.1 x 1000 / median
// interval), and the intervals must add up to the segment's time (within 10 %); a segment where either fails is marked `inconsistent` and the
// run fails (the "1355 frames in 8 s, median 16.7 ms" of 2026-10-27 was 169 frames a second at a 60 Hz refresh: impossible, the tool was
// wrong). DO NOT ask the mean rate to equal the median: frames of 16.7 ms broken by stalls of 160 ms are real, and their mean is not their median.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clocksDuring, startClockLog } from './gpu-clocks.mjs';
import { glCounter, openPathCity, PATH, runSegment } from './lib/cameraPath.mjs';

const args = process.argv.slice(2);
const out = args.find((a, i) => !a.startsWith('--') && !['--city', '--loop'].includes(args[i - 1]));
const city = args.includes('--city') ? args[args.indexOf('--city') + 1] : 'large';
const loopMinutes = args.includes('--loop') ? Number(args[args.indexOf('--loop') + 1]) : 0;
if (!out) { console.error('usage: bench-camera.mjs <out.json> [--city large|small] [--loop <minutes>]'); process.exit(2); }

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return { p50: round(pct(s, 0.5)), p95: round(pct(s, 0.95)), p99: round(pct(s, 0.99)), max: round(s.at(-1) ?? null), n: s.length };
};

/** One segment run and measured. */
async function measureSegment(page, frame, segment) {
  await page.evaluate(() => { window.__gpu(true); window.__bench.start(); window.__segLongFrom = performance.now(); });
  const wallStart = Date.now();
  const run = await runSegment(page, frame, segment);
  const wall = { start: wallStart, end: Date.now() };
  const [raw, gpu, longTasks] = await page.evaluate(() => [window.__bench.stop(), window.__gpu(), window.__longTasks.filter(([t]) => t >= window.__segLongFrom)]);
  const frames = [];
  for (let i = 0; i < raw.length; i += 6) frames.push({ end: raw[i], cpu: raw[i + 1], draws: raw[i + 2], tris: raw[i + 3], bytes: raw[i + 4], programs: raw[i + 5] });
  const seconds = (run.end - run.start) / 1000;
  const intervals = frames.slice(1).map((f, i) => f.end - frames[i].end);
  const intervalP50 = pct([...intervals].sort((a, b) => a - b), 0.5);
  const fps = frames.length / seconds;
  const summed = intervals.reduce((a, v) => a + v, 0) / 1000;
  const consistent = intervalP50 > 0 && fps <= 1.1 * (1000 / intervalP50) && Math.abs(summed - seconds) / seconds <= 0.1;
  const bytes = frames.slice(1).map((f, i) => f.bytes - frames[i].bytes);
  const cpu = frames.map((f) => f.cpu);
  // after a zoom: the first sample from which every level stays landed
  let landedS = null;
  for (let i = run.landing.length - 1; i >= 0 && run.landing[i][1] === 0; i--) landedS = run.landing[i][0] / 1000;
  return {
    name: segment.name, seconds: round(seconds), frames: frames.length, fps: round(fps, 1), intervalP50: round(intervalP50), intervalsS: round(summed), consistent,
    cpu: { ...stats(cpu), over33: cpu.filter((v) => v > 33).length, over50: cpu.filter((v) => v > 50).length },
    interval: { ...stats(intervals), over33: intervals.filter((v) => v > 33).length, over50: intervals.filter((v) => v > 50).length },
    gpu: { p50: gpu.p50, p95: gpu.p95, p99: gpu.p99, max: gpu.max, n: gpu.n, supported: gpu.supported },
    longTasks: { count: longTasks.length, ms: round(longTasks.reduce((a, [, d]) => a + d, 0)), max: round(Math.max(0, ...longTasks.map(([, d]) => d))) },
    draws: { mean: round(frames.reduce((a, f) => a + f.draws, 0) / Math.max(1, frames.length), 0), max: Math.max(0, ...frames.map((f) => f.draws)) },
    triangles: { mean: round(frames.reduce((a, f) => a + f.tris, 0) / Math.max(1, frames.length), 0), max: Math.max(0, ...frames.map((f) => f.tris)) },
    uploadBytes: { perFrame: stats(bytes), total: frames.length ? frames.at(-1).bytes - frames[0].bytes : 0 },
    programsLinked: frames.length ? frames.at(-1).programs - frames[0].programs : 0,
    gpuClocks: clocksDuring(log.rows, wall),
    landedS: segment.name.endsWith('-settle') ? landedS : undefined,
  };
}

const run = await openPathCity({ city, init: glCounter });
mkdirSync(dirname(out), { recursive: true });
/** The GPU's clocks and load logged for the whole path; each segment reads its own window of it. */
const log = startClockLog(out.replace(/\.json$/, '-clocks.csv'));
const { browser, page, frame } = run;
console.log(`${run.city}: opened in ${run.openedS.toFixed(0)} s; settled in ${run.settled.seconds} s${run.settled.unsettled ? ' (NOT SETTLED)' : ''}`);
const result = { city: run.city, viewport: '1920x1080', at: new Date().toISOString(), openedS: round(run.openedS, 1), settled: run.settled, gpuLabel: await page.evaluate(() => window.__gpu().label), quality: await page.evaluate(() => window.__state().now.quality), segments: [], laps: [] };
try {
  for (const segment of PATH) {
    const m = await measureSegment(page, frame, segment);
    result.segments.push(m);
    console.log(`${m.name}: ${m.frames} frames in ${m.seconds} s (${m.fps} fps, median interval ${m.intervalP50} ms${m.consistent ? '' : ' INCONSISTENT'}); GPU load ${m.gpuClocks?.load ? `${m.gpuClocks.load.min}-${m.gpuClocks.load.max} %` : '?'}; CPU p50 ${m.cpu.p50} p99 ${m.cpu.p99} max ${m.cpu.max}, >50 ms ${m.cpu.over50}; GPU p95 ${m.gpu.p95}; draws ${m.draws.mean}, tris ${m.triangles.mean}; ${(m.uploadBytes.total / 1e6).toFixed(1)} MB up, ${m.programsLinked} programs${m.landedS !== undefined ? `; landed ${m.landedS ?? 'never'} s` : ''}`);
  }
  const end = await page.evaluate(() => window.__roadcraft.usage());
  result.end = { heapMB: end.heapMB, geometries: end.geometries, textures: end.textures, programs: end.programs };
  if (loopMinutes > 0) {
    const until = Date.now() + loopMinutes * 60_000;
    for (let lap = 1; Date.now() < until; lap++) {
      for (const segment of PATH) await runSegment(page, frame, segment);
      const u = await page.evaluate(() => window.__roadcraft.usage());
      result.laps.push({ lap, minutes: round((loopMinutes * 60_000 - (until - Date.now())) / 60_000), heapMB: u.heapMB, geometries: u.geometries, textures: u.textures });
      console.log(`lap ${lap}: heap ${u.heapMB} MB, geometries ${u.geometries}`);
    }
  }
} finally {
  await log.stop();
  await browser.close();
}
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
const bad = result.segments.filter((s) => !s.consistent);
console.log(`written ${out}`);
if (bad.length) { console.error(`THE TOOL IS WRONG: frames a second and the median interval disagree in ${bad.map((s) => s.name).join(', ')}`); process.exit(1); }
