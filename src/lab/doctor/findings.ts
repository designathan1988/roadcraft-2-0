import { gpuLedger } from '@render/gpuLedger';
import type { Draw, Snapshot } from './measure';
import { timelineFindings } from './timelineFindings';

/** THE DIAGNOSIS'S FINDINGS: the snapshot read as causes - the bottleneck, the passes and layers the GPU spends on, the objects that weigh most, the shadows, the draw calls, the CPU's systems and functions, the hitches, the memory - each with its figures, why it matters, the switch that tests it and where to look. */

type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  readonly id: string;
  readonly area: 'GPU' | 'CPU' | 'Memory' | 'Hitches' | 'Waste' | 'Interface' | 'Work' | 'Checks';
  readonly severity: Severity;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly why: string;
  /** Its estimated cost, ms a frame (sorts the list). */
  readonly ms: number;
  /** What to switch to test it (`EffectsWiring.setMany` values) and how it reads. */
  readonly test?: { readonly label: string; readonly values: Readonly<Record<string, boolean | string>>; readonly back: Readonly<Record<string, boolean | string>> };
  /** A layer of the scene (the frame tab's filter, the inspector's object). */
  readonly layer?: string;
  readonly object?: unknown;
  /** A function of the profile (file:line). */
  readonly where?: string;
  readonly pass?: string;
}

/** A layer of the scene (the capture's `layer`) and the switch that hides it (`effectSwitches.ts`). */
const LAYER_SWITCH: readonly (readonly [RegExp, string, string])[] = [
  [/building-part-cells/, 'bParts', 'building cell parts (windows, railings, awnings, objects)'],
  [/buildings-far-levels|buildings-far/, 'bMasses', 'distant building masses and levels'],
  [/buildings-layer \/ buildings$|buildings-layer$/, 'bDetail', 'detailed building cells (walls)'],
  [/facade/, 'bFacadeLevel', 'building facade level'],
  [/signature/, 'bSignatures', 'signature buildings'],
  [/flags/, 'bFlags', 'flags'],
  [/agent-parts|rigged-citizens|procedural-people/, 'people', 'people and vehicles'],
  [/road-network|road-stand-in|structure/, 'roads', 'roads, overpasses and markings'],
  [/street-furniture|grass/, 'furniture', 'street furniture and grass'],
  [/traffic-signals/, 'signals', 'traffic lights'],
  [/flat-world-ground|terrain/, 'terrain', 'terrain'],
  [/water/, 'water', 'water'],
  [/utilities|signs|barriers|element/, 'props', 'signs, barriers, poles and elements'],
  [/forest|nature|cover|garden|plant/, 'vegetation', 'trees, forests and gardens'],
  [/exhaust/, 'particles', 'particles'],
  [/rain|lightning/, 'weather', 'rain and lightning'],
  [/transit|train|metro/, 'transit', 'trains and metro'],
  [/density/, 'farTraffic', 'distant traffic'],
];
const PASS_SWITCH: Readonly<Record<string, string>> = {
  shadows: 'shadows', gtao: 'ambientOcclusion', canyon: 'canyonLight', bloom: 'bloom', atmosphere: 'atmosphere', smaa: 'smaa', output: 'sharpen',
};

export const layerSwitch = (layer: string): { key: string; label: string } | null => {
  const hit = LAYER_SWITCH.find(([re]) => re.test(layer));
  return hit ? { key: hit[1], label: hit[2] } : null;
};

const BUDGET_MS = 1000 / 60;
const fmtN = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 1 });
const big = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} M` : n >= 1e3 ? `${(n / 1e3).toLocaleString('en-US', { maximumFractionDigits: 1 })} k` : fmtN(n));
const pct = (x: number): string => `${(x * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`;
const severityOf = (ms: number): Severity => (ms >= 4 ? 'high' : ms >= 1.5 ? 'medium' : ms >= 0.4 ? 'low' : 'info');
const isShadow = (d: Draw): boolean => /shadow|sun|cascade/i.test(`${d.target} ${d.pass}`);
const isQuad = (d: Draw): boolean => /^quad:/.test(d.layer) || d.triangles <= 2;

export interface Verdict { readonly bound: 'GPU' | 'CPU' | 'headroom' | 'no measure'; readonly text: string }

export function verdictOf(s: Snapshot): Verdict {
  const g = s.gpuMs, c = s.cpuMs;
  if (!Number.isFinite(c) && g === null) return { bound: 'no measure', text: 'No frame drawn during the measure: move the camera or let the simulation run and measure again.' };
  const fr = Number.isFinite(s.frameMs) ? `${fmtN(s.frameMs)} ms per frame (${fmtN(1000 / s.frameMs)} fps)` : '';
  if (g !== null && g >= c && g > BUDGET_MS * 0.85) return { bound: 'GPU', text: `GPU-bound: it takes ${fmtN(g)} ms per frame against ${fmtN(c)} ms for the CPU (budget ${fmtN(BUDGET_MS)} ms for 60 fps). ${fr}. What cuts the GPU's work (below, by weight) raises the frame rate; touching the CPU does not.` };
  if (c > (g ?? 0) && c > BUDGET_MS * 0.85) return { bound: 'CPU', text: `CPU-bound: the main thread takes ${fmtN(c)} ms per frame${g !== null ? ` against ${fmtN(g)} ms for the GPU` : ''}. ${fr}. What cuts the CPU's work (below) raises the frame rate.` };
  return { bound: 'headroom', text: `Headroom: GPU ${g === null ? '—' : `${fmtN(g)} ms`}, CPU ${fmtN(c)} ms, within the ${fmtN(BUDGET_MS)} ms budget. ${fr}.` };
}

/** Each layer's share of the frame's draws (the composer's own quads left out). */
export interface LayerShare { readonly layer: string; readonly triangles: number; readonly calls: number; readonly instances: number; readonly shadowTriangles: number; readonly heaviest: Draw | null; readonly programs: number }

export function layersOf(draws: readonly Draw[]): LayerShare[] {
  const rows = new Map<string, { triangles: number; calls: number; instances: number; shadowTriangles: number; heaviest: Draw | null; programs: Set<string> }>();
  for (const d of draws) {
    if (isQuad(d)) continue;
    const r = rows.get(d.layer) ?? { triangles: 0, calls: 0, instances: 0, shadowTriangles: 0, heaviest: null, programs: new Set<string>() };
    r.triangles += d.triangles;
    r.calls += d.calls;
    r.instances += d.instances;
    if (isShadow(d)) r.shadowTriangles += d.triangles;
    else if (!r.heaviest || d.triangles > r.heaviest.triangles) r.heaviest = d;
    r.programs.add(d.program);
    rows.set(d.layer, r);
  }
  return [...rows].map(([layer, r]) => ({ layer, triangles: r.triangles, calls: r.calls, instances: r.instances, shadowTriangles: r.shadowTriangles, heaviest: r.heaviest, programs: r.programs.size }))
    .sort((a, b) => b.triangles - a.triangles);
}

export function findingsOf(s: Snapshot): Finding[] {
  const out: Finding[] = [];
  const v = verdictOf(s);
  const gpuMs = s.gpuMs ?? 0;
  const layers = layersOf(s.draws);
  const totalTris = layers.reduce((a, l) => a + l.triangles, 0) || 1;
  const totalCalls = layers.reduce((a, l) => a + l.calls, 0) || 1;
  const scenePass = s.passes.find((p) => p.pass === 'scene');
  const shadowPass = s.passes.find((p) => p.pass === 'shadows');

  // The passes the GPU spends on.
  for (const p of s.passes) {
    if (p.avg < 0.3 || p.pass === 'scene') continue;
    const key = PASS_SWITCH[p.pass];
    out.push({
      id: `pass.${p.pass}`, area: 'GPU', severity: severityOf(p.avg), pass: p.pass, ms: p.avg,
      title: `Pass "${p.label}": ${fmtN(p.avg)} ms of GPU (${pct(p.share / 100)})`,
      evidence: [`mean ${fmtN(p.avg)} ms, p95 ${fmtN(p.p95)} ms per frame`, `${pct(p.avg / Math.max(gpuMs, 1e-6))} of the frame's GPU time`],
      why: p.pass === 'shadows' ? 'Redrawing the shadow maps draws the scene again from the sun\'s point of view, once per cascade.' : 'A post-processing pass runs over every pixel of the screen: it costs with the resolution, not with the scene.',
      ...(key ? { test: { label: `turn off ${p.label}`, values: { [key]: false }, back: { [key]: true } } } : {}),
    });
  }
  // The scene pass: by layer.
  for (const l of layers) {
    const share = l.triangles / totalTris;
    const callShare = l.calls / totalCalls;
    if (share < 0.08 && callShare < 0.12) continue;
    const est = scenePass ? scenePass.avg * Math.max(share, callShare * 0.5) : gpuMs * share * 0.7;
    const sw = layerSwitch(l.layer);
    out.push({
      id: `layer.${l.layer}`, area: 'GPU', severity: severityOf(est), layer: l.layer, ms: est,
      ...(l.heaviest ? { object: l.heaviest.object } : {}),
      title: `${sw ? sw.label[0]!.toUpperCase() + sw.label.slice(1) : l.layer}: ${pct(share)} of triangles, ${pct(callShare)} of draws`,
      evidence: [
        `layer ${l.layer}`,
        `${big(l.triangles)} triangles in ${fmtN(l.calls)} draws, ${big(l.instances)} instances, ${l.programs} shader programs`,
        ...(l.shadowTriangles ? [`${big(l.shadowTriangles)} of these triangles are shadows (drawn again for each cascade)`] : []),
        ...(l.heaviest ? [`heaviest object: ${l.heaviest.name || '(unnamed)'} — ${big(l.heaviest.triangles)} triangles, ${big(l.heaviest.instances)} instances, material ${l.heaviest.material}`] : []),
        `estimated cost ~${fmtN(est)} ms of GPU (the scene pass's share by the share of triangles and draws)`,
      ],
      why: share >= callShare ? 'Many triangles: vertex processing and rasterization grow with them; a coarser LOD or fewer instances cut them.' : 'Many draw calls: each costs a GPU state change and CPU work; merging meshes or instancing cuts them.',
      ...(sw ? { test: { label: `hide ${sw.label}`, values: { [sw.key]: false }, back: { [sw.key]: true } } } : {}),
    });
  }
  // The shadows, drawn again per cascade.
  const shadowTris = layers.reduce((a, l) => a + l.shadowTriangles, 0);
  if (shadowTris / totalTris > 0.2 || (shadowPass && shadowPass.avg > 1)) {
    out.push({
      id: 'shadows.redraw', area: 'GPU', severity: severityOf(shadowPass?.avg ?? gpuMs * (shadowTris / totalTris) * 0.5), ms: shadowPass?.avg ?? gpuMs * (shadowTris / totalTris) * 0.5,
      title: `Shadows redraw ${pct(shadowTris / totalTris)} of the frame's triangles`,
      evidence: [`${big(shadowTris)} triangles in the shadow maps`, ...(shadowPass ? [`shadow pass ${fmtN(shadowPass.avg)} ms`] : []), ...layers.filter((l) => l.shadowTriangles).slice(0, 3).map((l) => `${l.layer}: ${big(l.shadowTriangles)}`)],
      why: 'Every shadow-casting object is drawn again for each sun cascade that sees it.',
      test: { label: 'buildings without shadows', values: { bShadows: false }, back: { bShadows: true } },
    });
  }
  // Draw calls over the view's budget.
  if (s.drawCalls > 1000) {
    const top = [...layers].sort((a, b) => b.calls - a.calls).slice(0, 3);
    out.push({
      id: 'draws.many', area: 'GPU', severity: s.drawCalls > 1500 ? 'medium' : 'low', ms: (s.drawCalls - 1000) * 0.004,
      title: `${fmtN(s.drawCalls)} draw calls per frame (view budget: 1000)`,
      evidence: top.map((l) => `${l.layer}: ${fmtN(l.calls)} draws`),
      why: 'Every draw call costs CPU (on the main thread and in the driver) and a GPU state change.',
    });
  }
  // The CPU.
  if (s.cpuMs > 6) {
    const [first] = s.systems;
    const systemsMs = s.systems.reduce((a, [, ms]) => a + ms, 0) || 1;
    out.push({
      id: 'cpu.frame', area: 'CPU', severity: severityOf(s.cpuMs - 6), ms: s.cpuMs,
      title: `The CPU takes ${fmtN(s.cpuMs)} ms per frame${first ? `, ${pct(first[1] / systemsMs)} in "${first[0]}"` : ''}`,
      evidence: [
        ...s.systems.slice(0, 3).map(([k, ms]) => `system ${k}: ${fmtN(ms)} ms`),
        ...s.functions.slice(0, 5).map((f) => `function ${f.name || '(anonymous)'} — ${f.where}: ${fmtN(f.selfMs)} ms self, ${fmtN(f.totalMs)} ms with its callees`),
      ],
      why: 'The frame\'s work on the main thread: preparing the scene, choosing levels, syncing people and vehicles, submitting to the GPU. The functions listed are where the CPU spent most time during the measure (sampling profile).',
      ...(s.functions[0] ? { where: s.functions[0].where } : {}),
    });
  }
  for (const f of s.functions.slice(0, 5)) {
    if (f.selfMs < 20) continue;
    out.push({
      id: `fn.${f.where}`, area: 'CPU', severity: 'low', ms: f.selfMs / Math.max(1, s.frames), where: f.where,
      title: `Function ${f.name || '(anonymous)'} in ${f.where}`,
      evidence: [`${fmtN(f.selfMs)} ms self and ${fmtN(f.totalMs)} ms with its callees, in ${fmtN(f.samples)} samples`],
      why: 'One of the game\'s functions where the CPU spent most time during the measure (sampling profile).',
    });
  }
  if (s.hitches > 0) {
    out.push({
      id: 'hitches', area: 'Hitches', severity: s.hitches > 3 ? 'medium' : 'low', ms: s.hitches,
      title: `${s.hitches} hitches (frames over 50 ms) in the measure`,
      evidence: ['see Usage › LoAF and long tasks for the script to blame'],
      why: 'A long frame is a visible stutter, even with a good average.',
    });
  }
  const vram = gpuLedger.bytes();
  if (Number.isFinite(gpuLedger.cap) && vram > gpuLedger.cap * 0.8) {
    out.push({
      id: 'vram', area: 'Memory', severity: 'medium', ms: 0,
      title: `Video memory at ${pct(vram / gpuLedger.cap)} of the cap`,
      evidence: [`${big(vram / 1048576)} MB of ${big(gpuLedger.cap / 1048576)} MB`],
      why: 'Near the cap the game drops building detail; above it the driver swaps memory and hitches.',
    });
  }
  out.push(...hiddenFindings(s), ...wasteFindings(s), ...checkFindings(s), ...suspectFindings(s), ...timelineFindings(s.timeline, 'view still'));
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.ms - a.ms);
  // The bottleneck's side first: GPU causes count only when the GPU sets the pace, CPU ones when the CPU does.
  if (v.bound === 'GPU' || v.bound === 'CPU') {
    const side = v.bound;
    out.sort((a, b) => Number(b.area === side) - Number(a.area === side));
  }
  return out;
}

const mb = (bytes: number): string => `${(bytes / 1048576).toLocaleString('en-US', { maximumFractionDigits: bytes >= 104857600 ? 0 : 2 })} MB`;
/** The game's own frame: its time is the frame's, never hidden (`main.ts` watchHiddenWork). */
const FRAME_SITE = /src\/frameLoop\.ts:/;
const TIMED_KINDS: readonly string[] = ['frame', 'timer', 'interval', 'idle', 'event', 'observer'];

/** The page's work outside the frame, what is made as it runs, and what three is asked again, each by its line (`hiddenWork.ts`). */
function hiddenFindings(s: Snapshot): Finding[] {
  const out: Finding[] = [];
  if (!s.hidden) {
    out.push({ id: 'work.unwatched', area: 'Work', severity: 'info', ms: 0, title: 'The hidden-work watch is not installed', evidence: ['window.__hiddenWork missing: the development build installs it (main.ts)'], why: 'Without it the page\'s timers, listeners, observers and three\'s requests are not seen by line.' });
    return out;
  }
  const perFrame = (perSecond: number): number => perSecond / Math.max(1, 1000 / Math.max(1, s.frameMs || 16.7));
  for (const r of s.hidden) {
    const at = r.where.replace(/ \(served\)$/, '');
    const inSrc = r.where.startsWith('src/');
    if (TIMED_KINDS.includes(r.kind) && !FRAME_SITE.test(r.where) && r.msPerSecond >= 1) {
      const ms = perFrame(r.msPerSecond);
      const label = r.kind === 'event' ? `"${r.what}" listener` : r.kind === 'observer' ? `${r.what} callback` : `${r.kind} callback`;
      out.push({
        id: `work.${r.kind}.${r.what}.${at}`, area: 'Work', severity: r.msPerSecond >= 50 ? 'high' : r.msPerSecond >= 10 ? 'medium' : 'low', ms, ...(inSrc ? { where: at } : {}),
        title: `${label} at ${at}: ${fmtN(r.msPerSecond)} ms of every second`,
        evidence: [`${fmtN(r.callsPerSecond)} calls a second, ${fmtN(r.msPerSecond / Math.max(r.callsPerSecond, 1e-9))} ms a call`, `about ${fmtN(ms)} ms of each frame, outside the game's own frame`],
        why: 'Work the page does beside the frame: it holds the main thread as the frame does, and nothing of it shows in the frame\'s systems.',
      });
    }
    if (r.kind === 'context' || r.kind === 'canvas' || r.kind === 'context2d' || r.kind === 'encode') {
      const calls = r.callsPerSecond * s.hiddenSeconds;
      if (calls < 1 && r.msPerSecond < 0.5) continue;
      const what = r.kind === 'context' ? 'A WebGL context made' : r.kind === 'canvas' ? 'A canvas made' : r.kind === 'context2d' ? 'A 2D drawing context asked for' : `A picture encoded (${r.what})`;
      out.push({
        id: `made.${r.kind}.${r.what}.${at}`, area: 'Interface', severity: r.kind === 'context' ? 'high' : 'medium', ms: perFrame(r.msPerSecond), ...(inSrc ? { where: at } : {}),
        title: `${what} as the game runs, at ${at}`,
        evidence: [`${fmtN(calls)} times in the ${fmtN(s.hiddenSeconds)} s measured${r.msPerSecond ? `, ${fmtN(r.msPerSecond)} ms a second` : ''}`],
        why: 'Drawn while the game runs what could have been drawn once: a menu shows a photo taken beforehand (src/ui/photos.ts), a texture is read from a file; a second WebGL context shares the GPU with the game and holds its own copy of every texture.',
      });
    }
    if (r.kind === 'buffer' || r.kind === 'texture' || r.kind === 'geometry') {
      const mbs = r.bytesPerSecond / 1048576;
      if (mbs < 1 && r.callsPerSecond < 200) continue;
      const label = r.kind === 'buffer' ? 'Buffers sent to the GPU again' : r.kind === 'texture' ? 'Textures sent to the GPU again' : 'Geometry buffers made';
      out.push({
        id: `asked.${r.kind}.${r.what}.${at}`, area: 'Waste', severity: mbs >= 50 ? 'high' : mbs >= 5 || r.callsPerSecond >= 2000 ? 'medium' : 'low', ms: mbs / 10, ...(inSrc ? { where: at } : {}),
        title: `${label}: ${mb(r.bytesPerSecond)} a second (${r.what}) from ${at}`,
        evidence: [`${fmtN(r.callsPerSecond)} a second, ${mb(r.bytesPerSecond / Math.max(r.callsPerSecond, 1e-9))} each`],
        why: r.kind === 'geometry' ? 'Geometry built as the game runs: its arrays made, filled and uploaded; a model kept and instanced costs nothing per frame.' : 'Every byte sent again crosses to the GPU in the frame (bufferSubData / texSubImage); data that does not change should be sent once.',
      });
    }
    if (r.kind === 'material' && r.callsPerSecond >= 5) {
      out.push({
        id: `asked.material.${r.what}.${at}`, area: 'Waste', severity: r.callsPerSecond >= 60 ? 'medium' : 'low', ms: r.callsPerSecond / 100, ...(inSrc ? { where: at } : {}),
        title: `Material "${r.what}" marked for update ${fmtN(r.callsPerSecond)} times a second, from ${at}`,
        evidence: ['material.needsUpdate = true'],
        why: 'Each one makes three check the material\'s program again (and recompile it when its key moved): a uniform changes without it.',
      });
    }
  }
  if (s.contexts.length > 1) {
    out.push({ id: 'made.contexts', area: 'Interface', severity: 'high', ms: 0, title: `${s.contexts.length} WebGL contexts alive`, evidence: s.contexts.map((c) => `made at ${c}`), why: 'Every context beyond the game\'s shares the GPU\'s one thread with it and holds its own copy of every texture it draws.' });
  }
  return out;
}

/** What the scene spends for nothing on the screen (`waste.ts`). */
function wasteFindings(s: Snapshot): Finding[] {
  const w = s.waste;
  if (!w) return [];
  const out: Finding[] = [];
  for (const r of w.resends.filter((x) => x.same === true || x.hidden).slice(0, 12)) {
    const perFrame = (r.bytes * r.sends) / w.frames;
    out.push({
      id: `resend.${r.layer}.${r.holder}.${r.name}`, area: 'Waste', severity: perFrame >= 1048576 ? 'high' : perFrame >= 65536 ? 'medium' : 'low', ms: perFrame / 1048576, layer: r.layer,
      title: `${r.kind === 'texture' ? 'Texture' : 'Buffer'} "${r.name}" of ${r.holder} ${r.hidden ? 'sent again while hidden' : 'sent again with the same content'}`,
      evidence: [`layer ${r.layer}`, `${r.sends} of ${w.frames} frames, ${mb(r.bytes)} each (about ${mb(perFrame)} a frame)`],
      why: r.hidden ? 'Worked on and uploaded while nothing of it is drawn.' : 'The same bytes crossed to the GPU again: the array was marked changed (needsUpdate) without changing.',
    });
  }
  const streamed = w.resends.filter((x) => x.same !== true && !x.hidden && x.sends >= w.frames - 2 && x.bytes >= 4 * 1048576);
  for (const r of streamed.slice(0, 6)) {
    out.push({
      id: `stream.${r.layer}.${r.holder}.${r.name}`, area: 'Waste', severity: 'medium', ms: r.bytes / 1048576, layer: r.layer,
      title: `${r.holder}: ${mb(r.bytes)} of "${r.name}" sent every frame`,
      evidence: [`layer ${r.layer}`, `${r.sends} of ${w.frames} frames`],
      why: 'A whole buffer uploaded each frame: only its changed range (updateRanges) or a texture the shader reads would send less.',
    });
  }
  if (w.stillMatrixObjects >= 500) {
    out.push({
      id: 'matrices.still', area: 'Waste', severity: w.stillMatrixObjects >= 5000 ? 'medium' : 'low', ms: w.stillMatrixObjects / 20000,
      title: `${big(w.stillMatrixObjects)} objects that never moved have their matrix worked out every frame`,
      evidence: w.stillMatrices.slice(0, 5).map((l) => `${l.layer}: ${big(l.objects)}`),
      why: 'three walks every object with matrixAutoUpdate on, each frame (updateMatrixWorld); one that stands still needs it once (matrixAutoUpdate = false, updateMatrix when it moves).',
    });
  }
  for (const why of ['hidden', 'not drawn'] as const) {
    const list = w.held.filter((h) => h.why === why);
    const bytes = list.reduce((a, h) => a + h.bytes, 0);
    if (bytes < 64 * 1048576) continue;
    out.push({
      id: `held.${why}`, area: 'Memory', severity: bytes >= 512 * 1048576 ? 'medium' : 'low', ms: 0,
      title: `${mb(bytes)} on the GPU ${why === 'hidden' ? 'held by hidden objects' : 'held by objects not drawn in this frame'}`,
      evidence: list.slice(0, 6).map((h) => `${h.kind} ${h.name} (${h.holder}, ${h.layer}): ${mb(h.bytes)}`),
      why: why === 'hidden' ? 'Video memory kept for what is not shown: let it go and build it again when it is (or keep it on purpose, said so in its code).' : 'Out of the view or culled: residency is a choice; past the budget it pushes out what is seen.',
    });
  }
  for (const c of w.copies.filter((x) => x.wasted >= 256 * 1024).slice(0, 10)) {
    out.push({
      id: `copies.${c.kind}.${c.names[0] ?? ''}`, area: 'Memory', severity: c.wasted >= 32 * 1048576 ? 'high' : c.wasted >= 4 * 1048576 ? 'medium' : 'low', ms: 0,
      title: `${c.copies} copies of the same ${c.kind} (${mb(c.bytes)} each): ${mb(c.wasted)} held twice`,
      evidence: c.names.slice(0, 6),
      why: c.kind === 'geometry' ? 'The same arrays, byte for byte, in separate geometries: one geometry shared (or instanced) holds them once.' : 'The same picture in separate textures: one texture shared holds it once.',
    });
  }
  for (const d of w.dense.slice(0, 15)) {
    out.push({
      id: `dense.${d.layer}.${d.name}.${d.shadow}`, area: 'GPU', severity: d.excess >= 1e6 ? 'high' : d.excess >= 1e5 ? 'medium' : 'low', ms: d.excess / 2e6, layer: d.layer,
      title: `${d.name}: ${big(d.triangles)} triangles over ${fmtN(d.radiusPx)} px${d.shadow ? ' (in the shadow maps)' : ''}, ${fmtN(d.trianglesPerPixel)} triangles a pixel`,
      evidence: [`layer ${d.layer} · ${d.kind}`, `${big(d.instances)} instances · ${big(d.excess)} triangles past one a pixel`],
      why: 'A model drawn finer than the pixels it covers: a coarser level of detail (or an impostor) at that size draws the same picture for less.',
    });
  }
  const thrownTriangles = w.thrown.reduce((sum, t) => sum + t.triangles, 0);
  if (thrownTriangles >= 50_000) {
    out.push({
      id: 'thrown.band', area: 'Waste', severity: thrownTriangles >= 1e6 ? 'medium' : 'low', ms: thrownTriangles / 4e6,
      title: `${big(thrownTriangles)} triangles of banded rungs shaded and thrown away`,
      evidence: w.thrown.slice(0, 6).map((t) => `${t.name} (${t.layer}): ${big(t.thrown)} of ${big(t.instances)} instances outside its band, ${big(t.triangles)} triangles`),
      why: 'A far rung sends every instance of its block and its vertex shader drops those outside its band of sizes (farLadders.ts): their vertices are worked for nothing; instances sorted into their rung on the CPU would send only what is drawn.',
    });
  }
  for (const t of w.tiny.filter((x) => x.draws >= 200).slice(0, 5)) {
    out.push({
      id: `tiny.${t.layer}`, area: 'GPU', severity: t.draws >= 1000 ? 'medium' : 'low', ms: t.draws * 0.004, layer: t.layer,
      title: `${fmtN(t.draws)} draws of under 32 triangles in ${t.layer}`,
      evidence: [`${big(t.triangles)} triangles in all`],
      why: 'A call for almost nothing: merged or instanced, they are one draw.',
    });
  }
  return out;
}

/** The resources' checks that are not right (`resources/diagnostics.ts`). */
function checkFindings(s: Snapshot): Finding[] {
  return s.checks.filter((c) => c.verdict === 'problem' || c.verdict === 'warning').map((c): Finding => ({
    id: `check.${c.id}`, area: 'Checks', severity: c.verdict === 'problem' ? 'medium' : 'low', ms: 0,
    title: `${c.title}: ${c.value}`, evidence: [c.value], why: c.why,
  }));
}

/** The CPU profile's suspects (`code/analysis.ts`). */
function suspectFindings(s: Snapshot): Finding[] {
  const out: Finding[] = [];
  for (const x of s.suspects) {
    if (x.kind === 'product rebuilt without change') {
      out.push({ id: `idle.${x.name}`, area: 'Waste', severity: 'medium', ms: x.value / 1000, title: `Engine product "${x.name}" rebuilt with nothing changed`, evidence: [x.detail, `${fmtN(x.value)} ms spent`], why: 'Computed again with the same inputs: its result was already there.' });
    } else if (x.kind === 'hot path' || x.kind === 'hot leaf' || x.kind === 'costly library call') {
      if (out.filter((f) => f.area === 'CPU').length >= 8) continue;
      out.push({ id: `suspect.${x.kind}.${x.where}`, area: 'CPU', severity: 'low', ms: x.value / 1000, where: x.where, title: `${x.kind}: ${x.name || '(anonymous)'} in ${x.where}`, evidence: [x.detail], why: 'Where the CPU profile spent its time during the measure.' });
    } else if (x.kind === 'garbage collection') {
      const share = Number(/([\d.]+)%/.exec(x.detail)?.[1] ?? 0);
      if (share >= 5) out.push({ id: 'gc', area: 'CPU', severity: 'low', ms: x.value / 1000, title: `Garbage collection: ${x.detail}`, evidence: [`${fmtN(x.value)} ms`], why: 'Objects made and dropped every frame: the collector pauses the page to take them back.' });
    }
  }
  return out;
}
