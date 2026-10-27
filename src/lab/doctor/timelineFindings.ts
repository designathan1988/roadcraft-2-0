import type { Finding } from './findings';
import type { GpuTimeline } from './gpuTimeline';

/** THE GPU TIMELINE READ AS CAUSES (`gpuTimeline.ts`): a GPU saturated, the frames that waited on it, the stalls and where they land, the
 *  heaviest draws, the GPU's work outside the game's frame by the line that asked it, the uploads, the vertex formats the driver converts,
 *  the calls that make the page wait, the drawing buffer resized. `where`: the moment it was recorded ('still', 'loading <stop>'). */

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 1 });
const sev = (ms: number): Finding['severity'] => (ms >= 4 ? 'high' : ms >= 1.5 ? 'medium' : ms >= 0.4 ? 'low' : 'info');

export function timelineFindings(t: GpuTimeline | null, where: string): Finding[] {
  if (!t) return [{ id: 'timeline.none', area: 'GPU', severity: 'info', ms: 0, title: 'The GPU timeline could not be recorded', evidence: ['EXT_disjoint_timer_query_webgl2 missing'], why: 'Without the timer no draw can be timed on the GPU.' }];
  const out: Finding[] = [];
  const budget = t.vsyncMs;
  if (t.gpuBusy >= 0.7 || t.gpu.p50 > budget * 0.85) {
    out.push({
      id: 'timeline.saturated', area: 'GPU', severity: t.gpu.p50 > budget ? 'high' : 'medium', ms: Math.max(0, t.gpu.p50 - budget * 0.5),
      title: `The GPU is saturated (${where}): ${fmt(t.gpu.p50)} ms of GPU a frame (p95 ${fmt(t.gpu.p95)}, max ${fmt(t.gpu.max)}) against a display frame of ${fmt(budget)} ms; busy ${fmt(t.gpuBusy * 100)}% of the time`,
      evidence: [`frames: interval p50 ${fmt(t.interval.p50)} ms, p95 ${fmt(t.interval.p95)} ms, max ${fmt(t.interval.max)} ms`, ...t.heaviest.slice(0, 6).map((d) => `${fmt(d.gpuMsPerFrame)} ms a frame: ${d.draw}`)],
      why: 'Every frame waits for the GPU to finish the one before: past its budget the frames slow down and new content queues behind them. The heaviest draws are what to cut first.',
    });
  }
  if (t.late > 0) {
    out.push({
      id: 'timeline.late', area: 'Hitches', severity: t.lateOnGpu >= t.late / 2 && t.late >= 3 ? 'high' : 'medium', ms: t.late / Math.max(1, t.frames.length) * 10,
      title: `${t.late} late frames (${where}), ${t.lateOnGpu} of them waiting on the GPU`,
      evidence: t.frames.filter((f) => f.waitedOn !== 'neither').sort((a, b) => b.intervalMs - a.intervalMs).slice(0, 8)
        .map((f) => `${fmt(f.intervalMs)} ms frame: page ${fmt(f.cpuMs)} ms, GPU ${fmt(f.gpuMs)} ms over ${f.draws} draws (page time in them ${fmt(f.drawCpuMs)} ms) - waited on the ${f.waitedOn.toUpperCase()}`),
      why: 'A frame later than one and a half display frames is a visible stutter. Waiting on the GPU: the page had its work done and the GPU had not; waiting on the CPU: the page\'s own work was longer.',
    });
  }
  if (t.stalls.length) {
    out.push({
      id: 'timeline.stalls', area: 'GPU', severity: t.stalls[0]!.gpuMs >= 100 ? 'high' : 'medium', ms: t.stalls.reduce((a, s) => a + s.gpuMs, 0) / Math.max(1, t.frames.length),
      title: `${t.stalls.length} draws held the GPU far past their kind (${where}), the worst ${fmt(t.stalls[0]!.gpuMs)} ms`,
      evidence: t.stalls.slice(0, 8).map((s) => `${fmt(s.gpuMs)} ms (usually ${fmt(s.typicalMs)} ms, page ${fmt(s.cpuMs)} ms): ${s.draw}`),
      why: 'A draw far longer than its kind with no page time in it is where the GPU\'s queue was behind, not what is heavy: the work before it (the frame\'s own, or work outside the frame below) is the cause. With page time in it, the draw waited on the page (a compile, an upload).',
    });
  }
  const onCpu = t.frames.filter((f) => f.waitedOn === 'cpu').length;
  if (onCpu > 0 && (t.pageWork.length || t.steps.length)) {
    const ms = t.pageWork.reduce((a, w) => a + w.ms, 0) / Math.max(1, t.frames.length);
    out.push({
      id: 'timeline.page', area: 'CPU', severity: onCpu >= 3 ? 'high' : 'medium', ms,
      title: `The page's work behind ${onCpu} late frames (${where})`,
      evidence: [...t.steps.filter((s) => s.maxMs >= 8).slice(0, 6).map((s) => `step ${s.what}: max ${fmt(s.maxMs)} ms, ${fmt(s.ms)} ms in ${s.calls}`),
        ...t.pageWork.slice(0, 8).map((w) => `${fmt(w.ms)} ms (max ${fmt(w.maxMs)}) in ${w.calls} long frames: ${w.what} ${w.where}`)],
      why: 'A frame the page made late: the scripts that ran in its long animation frames and the timed steps of the game (its hitch marks) say what held it.',
      ...(t.pageWork[0] ? { where: t.pageWork[0].where } : {}),
    });
  }
  const outside = t.renders.filter((r) => !r.inFrame && r.gpuMs > 0);
  if (outside.length) {
    const ms = outside.reduce((a, r) => a + r.gpuMs, 0) / Math.max(1, t.frames.length);
    out.push({
      id: 'timeline.outside', area: 'GPU', severity: sev(ms), ms,
      title: `GPU work outside the game's frame (${where}): ${fmt(ms)} ms of GPU a frame, ${outside.reduce((a, r) => a + r.calls, 0)} renders`,
      evidence: outside.slice(0, 8).map((r) => `${fmt(r.gpuMs)} ms GPU in ${r.calls} renders (max ${fmt(r.maxGpuMs)}), ${fmt(r.cpuMs)} ms page, into ${r.target}: ${r.caller}`),
      why: 'Bakes, palettes and warm-ups drawn beside the frame share the GPU with it: their time is the frames\' time.',
      where: outside[0]!.caller,
    });
  }
  const bigUploads = t.uploads.filter((u) => u.mb >= 1);
  if (bigUploads.length) {
    const mbPerSecond = bigUploads.reduce((a, u) => a + u.mb, 0) / Math.max(0.1, t.seconds);
    out.push({
      id: 'timeline.uploads', area: 'GPU', severity: mbPerSecond >= 64 ? 'high' : mbPerSecond >= 16 ? 'medium' : 'low', ms: mbPerSecond / 64,
      title: `${fmt(mbPerSecond)} MB a second sent to the GPU (${where})`,
      evidence: bigUploads.slice(0, 8).map((u) => `${fmt(u.mb)} MB in ${u.calls} ${u.call} (largest ${fmt(u.maxMb)} MB): ${u.caller}`),
      why: 'What goes up is copied by the GPU process and the driver; a large buffer or texture sent again whole for a small change costs its whole size.',
      where: bigUploads[0]!.caller,
    });
  }
  const converted = t.formats.filter((f) => f.converted);
  if (converted.length) {
    out.push({
      id: 'timeline.formats', area: 'GPU', severity: 'medium', ms: converted.reduce((a, f) => a + f.binds, 0) / 1000,
      title: `${converted.length} vertex formats the driver converts (${where})`,
      evidence: converted.map((f) => `${f.format}: ${f.binds} binds, e.g. ${f.draws.slice(0, 3).join('; ') || '(no draw named)'}`),
      why: 'ANGLE on Direct3D 11 has no 3-component 8- or 16-bit vertex format: the buffer is converted to 4 components, a copy of its whole size (https://github.com/Microsoft/angle/wiki/Getting-Good-Performance-From-ANGLE). Pad them to 4.',
    });
  }
  const waits = t.sync.filter((s) => s.calls > 0);
  if (waits.length) {
    const ms = waits.reduce((a, s) => a + s.ms, 0) / Math.max(1, t.frames.length);
    out.push({
      id: 'timeline.sync', area: 'CPU', severity: sev(ms), ms,
      title: `Calls that make the page wait on the GPU (${where}): ${fmt(ms)} ms a frame`,
      evidence: waits.slice(0, 8).map((s) => `${s.call} ${s.calls}× (${fmt(s.ms)} ms): ${s.caller}`),
      why: 'Each one flushes every command before it and waits for the GPU process\'s answer: the page stands still meanwhile.',
      where: waits[0]!.caller,
    });
  }
  const made = t.programs.reduce((a, p) => a + p.programs, 0);
  if (made > 0) {
    const compileWait = t.sync.filter((s) => s.call === 'getProgramInfoLog' || s.call === 'getProgramParameter' || s.call === 'getShaderParameter').reduce((a, s) => a + s.ms, 0);
    out.push({
      id: 'timeline.programs', area: 'Hitches', severity: made >= 5 || compileWait >= 100 ? 'high' : 'medium', ms: compileWait / Math.max(1, t.frames.length),
      title: `${made} shader programs compiled while the game ran (${where}), ${fmt(compileWait)} ms of the page waiting on them`,
      evidence: t.programs.slice(0, 10).map((p) => `${p.programs}× for ${p.draw} (${p.caller})`),
      why: 'three makes a program at the first draw of a material, and drops it once no material uses it: a material made again for each cell that comes, or one whose defines change, compiles again in the frame, and the frame waits for the driver (ANGLE turns each into HLSL and compiles it). Share the materials, keep their programs, build them ahead.',
    });
  }
  if (t.resizes.length) {
    out.push({
      id: 'timeline.resizes', area: 'GPU', severity: 'medium', ms: 1,
      title: `The drawing buffer resized ${t.resizes.reduce((a, r) => a + r.calls, 0)} times (${where})`,
      evidence: t.resizes.map((r) => `${r.calls}× ${r.caller}`),
      why: 'A resize makes every screen-sized target again (the scene\'s, the passes\'): a frame of allocations and the GPU\'s caches lost.',
    });
  }
  if (t.lost > 0) out.push({ id: 'timeline.lost', area: 'GPU', severity: 'info', ms: 0, title: `${t.lost} draw timings lost (${where})`, evidence: ['answers not in within 3 s, or the GPU disjoint'], why: 'The figures above leave those draws out.' });
  return out;
}
