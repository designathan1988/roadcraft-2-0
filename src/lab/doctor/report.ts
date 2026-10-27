import { formatBuildStamp } from '@ui/buildStamp';
import type { LabContext } from '../labTypes';
import { listServer, postToServer, saveDesktop, serverUrl } from '../recorder/deliver';
import { layersOf, verdictOf, type Finding } from './findings';
import type { AbResult, Snapshot } from './measure';
import type { TourResult } from './tour';

/**
 * THE DIAGNOSIS KEPT: every measure written as a report (`lab-reports/diag-<date>.json` and `.md` by the dev server, the desktop app's data
 * folder by the app, `recorder/deliver.ts`), the moment it is made, and held against the one before it: what is new, what is gone, what grew.
 * DO NOT leave a diagnosis on the screen only: the causes were lost at every reload, and nothing told whether a fix took (2026-10-27).
 * The JSON carries every section of the lab (`LabContext.collectReport`); the Markdown is written to be read.
 */

const FORMAT = 'roadcraft-lab-diagnosis/1';

/** A finding as kept: its object (a 3D object) left out. */
export type KeptFinding = Omit<Finding, 'object'> & { readonly result?: AbResult | string };

export interface DiagnosisReport {
  readonly stamp: string;
  readonly json: Record<string, unknown>;
  readonly md: string;
  readonly summary: string;
  /** Against the report before it: new, gone and grown causes; null when there was none. */
  readonly against: Comparison | null;
  /** Where it was written (null: not there). */
  server: string | null;
  desktop: string | null;
}

interface Comparison {
  readonly stamp: string;
  readonly added: readonly KeptFinding[];
  readonly gone: readonly KeptFinding[];
  readonly grown: readonly { readonly finding: KeptFinding; readonly was: number }[];
}

const n = (v: number | null | undefined, d = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d }));
const mb = (bytes: number): string => `${n(bytes / 1048576, 2)} MB`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function gpuName(ctx: LabContext): string {
  const gl = ctx.scene.gl.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

function compare(findings: readonly KeptFinding[], previous: { stamp: string; findings: readonly KeptFinding[] } | null): Comparison | null {
  if (!previous) return null;
  const before = new Map(previous.findings.map((f) => [f.id, f]));
  const now = new Map(findings.map((f) => [f.id, f]));
  return {
    stamp: previous.stamp,
    added: findings.filter((f) => !before.has(f.id)),
    gone: previous.findings.filter((f) => !now.has(f.id)),
    grown: findings.filter((f) => before.has(f.id) && f.ms > before.get(f.id)!.ms * 1.2 && f.ms - before.get(f.id)!.ms > 0.1).map((f) => ({ finding: f, was: before.get(f.id)!.ms })),
  };
}

/** The report of a measure, held against `previous`. */
export function diagnosisReport(ctx: LabContext, snap: Snapshot, findings: readonly Finding[], results: ReadonlyMap<string, AbResult | string>,
  previous: { stamp: string; findings: readonly KeptFinding[] } | null, again?: string): DiagnosisReport {
  const date = new Date();
  // Written again under its own name when a test adds its result.
  const stamp = again ?? `diag-${date.toISOString().slice(0, 19).replace(/:/g, '-')}`;
  const kept: KeptFinding[] = findings.map(({ object: _object, ...f }) => {
    const r = results.get(f.id);
    return r && r !== 'measuring' ? { ...f, result: r } : f;
  });
  const against = compare(kept, previous);
  const verdict = verdictOf(snap);
  const camera = ctx.scene.viewport;
  const canvas = ctx.scene.gl.domElement;
  const meta = {
    format: FORMAT, date: date.toISOString(), build: formatBuildStamp(), url: location.href, gpu: gpuName(ctx), gpuTimer: ctx.scene.gpu.supported,
    screen: { width: screen.width, height: screen.height, devicePixelRatio: window.devicePixelRatio, canvas: [canvas.width, canvas.height] },
    camera: { kind: camera.kind, x: camera.centre.x, y: camera.centre.y, zoom: camera.zoom, azimuth: camera.azimuth, elevation: camera.elevation },
    quality: ctx.quality.level(), userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency,
    vehicles: ctx.sim.vehicles.size, people: ctx.sim.pedViews.length,
  };
  const layers = layersOf(snap.draws).slice(0, 25).map(({ heaviest: _h, ...l }) => l);
  const { draws: _draws, ...measured } = snap;
  const json: Record<string, unknown> = {
    meta, verdict, findings: kept, against, measured: { ...measured, layers }, settings: ctx.effects.snapshot(), sections: ctx.collectReport(),
    events: ctx.events().slice(-300),
  };

  const md: string[] = [];
  md.push('# Diagnosis — Roadcraft', '');
  md.push(`Made by the debug lab (F7, Diagnosis) at ${meta.date}. Format \`${FORMAT}\`; the sibling JSON (\`${stamp}.json\`) holds every section of the lab.`, '');
  md.push('## Context', '');
  md.push(`- Build ${meta.build} · ${meta.url}`);
  md.push(`- GPU ${meta.gpu} · GPU timer ${meta.gpuTimer ? 'yes' : 'no'} · quality ${meta.quality} · canvas ${canvas.width}×${canvas.height} @${window.devicePixelRatio}`);
  md.push(`- Camera ${camera.kind} at (${n(camera.centre.x, 0)}, ${n(camera.centre.y, 0)}), zoom ${n(camera.zoom, 3)} · ${meta.vehicles} vehicles · ${meta.people} people`);
  md.push(`- Frame ${n(snap.frameMs)} ms (${n(1000 / snap.frameMs, 0)} fps) · CPU ${n(snap.cpuMs)} ms · GPU ${n(snap.gpuMs)} ms · ${n(snap.drawCalls, 0)} draws · ${n(snap.triangles, 0)} triangles · ${snap.hitches} hitches in ${snap.frames} frames`, '');
  md.push(`**${verdict.bound === 'GPU' ? 'GPU-bound' : verdict.bound === 'CPU' ? 'CPU-bound' : verdict.bound === 'headroom' ? 'Headroom' : 'No measure'}.** ${verdict.text}`, '');
  if (against) {
    md.push(`## Against the report before (${against.stamp})`, '');
    md.push(`- New causes (${against.added.length}): ${against.added.map((f) => f.title).join('; ') || 'none'}`);
    md.push(`- Gone (${against.gone.length}): ${against.gone.map((f) => f.title).join('; ') || 'none'}`);
    md.push(`- Grown (${against.grown.length}): ${against.grown.map((g) => `${g.finding.title} (${n(g.was, 2)} → ${n(g.finding.ms, 2)})`).join('; ') || 'none'}`, '');
  }
  md.push(`## Causes, by weight (${kept.length})`, '');
  kept.forEach((f, i) => {
    md.push(`### ${i + 1}. [${f.severity}] ${f.area}: ${f.title}`, '');
    for (const e of f.evidence) md.push(`- ${e}`);
    md.push(`- Why: ${f.why}`);
    if (f.where) md.push(`- Code: \`${f.where}\``);
    if (f.layer) md.push(`- Layer: \`${f.layer}\``);
    if (f.test) md.push(`- Test: ${f.test.label} (\`${JSON.stringify(f.test.values)}\`)`);
    if (f.result) md.push(`- A/B: ${typeof f.result === 'string' ? f.result : `GPU ${n(f.result.gpuA, 2)} → ${n(f.result.gpuB, 2)} ms, CPU ${n(f.result.cpuA, 2)} → ${n(f.result.cpuB, 2)} ms, draws ${n(f.result.drawsA, 0)} → ${n(f.result.drawsB, 0)}, triangles ${n(f.result.trisA, 0)} → ${n(f.result.trisB, 0)}`}`);
    md.push('');
  });
  if (snap.passes.length) {
    md.push('## GPU by pass', '', '| pass | avg ms | p95 ms | share |', '|---|---|---|---|');
    for (const p of snap.passes) md.push(`| ${p.label} | ${n(p.avg, 2)} | ${n(p.p95, 2)} | ${n(p.share, 0)}% |`);
    md.push('');
  }
  if (layers.length) {
    md.push('## Draws by layer (one frame)', '', '| layer | triangles | draws | instances | shadow triangles | programs |', '|---|---|---|---|---|---|');
    for (const l of layers) md.push(`| ${cell(l.layer)} | ${n(l.triangles, 0)} | ${n(l.calls, 0)} | ${n(l.instances, 0)} | ${n(l.shadowTriangles, 0)} | ${l.programs} |`);
    md.push('');
  }
  if (snap.systems.length) md.push('## CPU by frame system', '', ...snap.systems.map(([k, ms]) => `- ${k}: ${n(ms, 2)} ms`), '');
  if (snap.functions.length) {
    md.push('## Functions (CPU profile)', '', '| function | where | self ms | total ms |', '|---|---|---|---|');
    for (const f of snap.functions) md.push(`| ${cell(f.name || '(anonymous)')} | ${cell(f.where)} | ${n(f.selfMs)} | ${n(f.totalMs)} |`);
    md.push('');
  }
  const w = snap.waste;
  if (w) {
    md.push(`## What buys nothing on the screen (${w.frames} frames watched)`, '');
    md.push(`- Matrices worked out every frame for objects that never moved: ${n(w.stillMatrixObjects, 0)} (${w.stillMatrices.slice(0, 5).map((l) => `${l.layer} ${l.objects}`).join(', ') || '—'})`);
    md.push(`- Held on the GPU by hidden objects: ${mb(w.held.filter((h) => h.why === 'hidden').reduce((a, h) => a + h.bytes, 0))}; by objects not drawn this frame: ${mb(w.held.filter((h) => h.why === 'not drawn').reduce((a, h) => a + h.bytes, 0))}`, '');
    if (w.resends.length) {
      md.push('### Sent to the GPU again', '', '| kind | name | holder | layer | sends | bytes | same content | hidden |', '|---|---|---|---|---|---|---|---|');
      for (const r of w.resends.slice(0, 40)) md.push(`| ${r.kind} | ${cell(r.name)} | ${cell(r.holder)} | ${cell(r.layer)} | ${r.sends}/${w.frames} | ${mb(r.bytes)} | ${r.same === null ? '—' : r.same ? 'yes' : 'no'} | ${r.hidden ? 'yes' : ''} |`);
      md.push('');
    }
    if (w.copies.length) {
      md.push('### Held twice', '', '| kind | copies | each | wasted | names |', '|---|---|---|---|---|');
      for (const c of w.copies.slice(0, 25)) md.push(`| ${c.kind} | ${c.copies} | ${mb(c.bytes)} | ${mb(c.wasted)} | ${cell(c.names.join(', '))} |`);
      md.push('');
    }
    if (w.dense.length) {
      md.push('### Finer than the pixels they cover', '', '| model | layer | triangles | instances | radius px | triangles a pixel | excess | shadow |', '|---|---|---|---|---|---|---|---|');
      for (const d of w.dense.slice(0, 30)) md.push(`| ${cell(d.name)} | ${cell(d.layer)} | ${n(d.triangles, 0)} | ${n(d.instances, 0)} | ${n(d.radiusPx)} | ${n(d.trianglesPerPixel, 2)} | ${n(d.excess, 0)} | ${d.shadow ? 'yes' : ''} |`);
      md.push('');
    }
    if (w.tiny.length) md.push('### Tiny draws', '', ...w.tiny.map((t) => `- ${t.layer}: ${t.draws} draws, ${n(t.triangles, 0)} triangles`), '');
  }
  if (snap.hidden) {
    md.push(`## The page's work and three's requests, by line (${n(snap.hiddenSeconds)} s measured)`, '', '| kind | what | where | ms/s | calls/s | MB/s |', '|---|---|---|---|---|---|');
    for (const r of snap.hidden.slice(0, 60)) md.push(`| ${r.kind} | ${cell(r.what)} | ${cell(r.where)} | ${n(r.msPerSecond, 2)} | ${n(r.callsPerSecond, 1)} | ${n(r.bytesPerSecond / 1048576, 2)} |`);
    md.push('', `WebGL contexts alive: ${snap.contexts.join(', ') || '—'}`, '');
  }
  if (snap.checks.length) {
    md.push('## Checks', '', '| verdict | check | reading |', '|---|---|---|');
    for (const c of snap.checks) md.push(`| ${c.verdict} | ${cell(c.title)} | ${cell(c.value)} |`);
    md.push('');
  }
  if (snap.suspects.length) md.push('## CPU profile suspects', '', ...snap.suspects.slice(0, 30).map((x) => `- **${x.kind}** ${x.name || '(anonymous)'} in ${x.where}: ${x.detail}`), '');

  const top = kept.filter((f) => f.severity === 'high' || f.severity === 'medium').slice(0, 3).map((f) => f.title);
  const summary = `${verdict.bound}, ${kept.length} causes${top.length ? `: ${top.join('; ')}` : ''}${against ? ` · against ${against.stamp}: ${against.added.length} new, ${against.gone.length} gone` : ''}`;
  return { stamp, json, md: md.join('\n'), summary, against, server: null, desktop: null };
}

/** The report written where it can be (the dev server, the desktop app): its places told. */
export async function keep(report: DiagnosisReport): Promise<DiagnosisReport> {
  const json = JSON.stringify(report.json);
  const [server, desktop] = await Promise.all([postToServer(report.stamp, json, report.md), saveDesktop(report.stamp, json, report.md)]);
  report.server = server;
  report.desktop = desktop;
  return report;
}

/** The newest diagnosis the dev server keeps, its findings to compare with; null when none. */
export async function lastKept(): Promise<{ stamp: string; findings: KeptFinding[] } | null> {
  const files = (await listServer()).filter((f) => /^diag-.*\.json$/.test(f.name));
  const newest = files[0];
  if (!newest) return null;
  try {
    const r = await fetch(serverUrl(newest.name), { cache: 'no-store' });
    if (!r.ok) return null;
    const body = (await r.json()) as { findings?: KeptFinding[] };
    return { stamp: newest.name.replace(/\.json$/, ''), findings: body.findings ?? [] };
  } catch (error) {
    console.warn('lab doctor: the last diagnosis could not be read', error);
    return null;
  }
}

/** The city tour as a report (`tour.ts`): each stop's figures, and every cause with where it was seen. */
export function tourReport(ctx: LabContext, tour: TourResult): DiagnosisReport {
  const date = new Date();
  const stamp = `tour-${date.toISOString().slice(0, 19).replace(/:/g, '-')}`;
  const strip = ({ object: _o, ...f }: Finding): KeptFinding => f;
  const meta = { format: 'roadcraft-lab-tour/1', date: date.toISOString(), build: formatBuildStamp(), url: location.href, gpu: gpuName(ctx), quality: ctx.quality.level(), minutes: tour.ms / 60000, cancelled: tour.cancelled };
  const stops = tour.stops.map((r) => {
    const { draws: _d, ...measured } = r.snap;
    return { stop: r.stop, settleMs: r.settleMs, unsettled: r.unsettled, verdict: verdictOf(r.snap), measured: { ...measured, layers: layersOf(r.snap.draws).slice(0, 15).map(({ heaviest: _h, ...l }) => l) }, findings: r.findings.map(strip) };
  });
  const causes = tour.causes.map((c) => ({ ...strip(c.finding), seenAt: c.stops }));
  const json: Record<string, unknown> = { meta, stops, causes, settings: ctx.effects.snapshot(), sections: ctx.collectReport() };
  const md: string[] = ['# City tour — Roadcraft', ''];
  md.push(`Made by the debug lab (F7, Diagnosis › City tour) at ${meta.date}: ${tour.stops.length} stops in ${n(meta.minutes)} min${tour.cancelled ? ' (stopped before the end)' : ''}. GPU ${meta.gpu} · quality ${meta.quality} · build ${meta.build}. The JSON (\`${stamp}.json\`) holds every stop's measure whole.`, '');
  md.push('## The stops', '', '| stop | zoom | bearing° | tilt° | frame ms | fps | CPU ms | GPU ms | draws | triangles | bound | causes | settled |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of tour.stops) {
    const s = r.snap, v = verdictOf(s);
    md.push(`| ${r.stop.label} | ${n(r.stop.zoom, 3)} | ${n((r.stop.azimuth * 180) / Math.PI, 0)} | ${n((r.stop.elevation * 180) / Math.PI, 0)} | ${n(s.frameMs)} | ${n(1000 / s.frameMs, 0)} | ${n(s.cpuMs)} | ${n(s.gpuMs)} | ${n(s.drawCalls, 0)} | ${n(s.triangles, 0)} | ${v.bound} | ${r.findings.length} | ${r.unsettled ? `no (${n(r.settleMs / 1000)} s)` : `${n(r.settleMs / 1000)} s`} |`);
  }
  md.push('', `## Every cause, by weight (${causes.length})`, '');
  causes.forEach((c, i) => {
    md.push(`### ${i + 1}. [${c.severity}] ${c.area}: ${c.title}`, '');
    md.push(`- Seen at ${c.seenAt.length} of ${tour.stops.length} stops: ${c.seenAt.join(', ')}`);
    for (const e of c.evidence) md.push(`- ${e}`);
    md.push(`- Why: ${c.why}`);
    if (c.where) md.push(`- Code: \`${c.where}\``);
    if (c.layer) md.push(`- Layer: \`${c.layer}\``);
    md.push('');
  });
  for (const r of tour.stops) {
    md.push(`## Stop: ${r.stop.label}`, '');
    if (r.snap.passes.length) md.push(`- GPU by pass: ${r.snap.passes.map((p) => `${p.label} ${n(p.avg, 2)} ms`).join(', ')}`);
    md.push(`- Layers: ${layersOf(r.snap.draws).slice(0, 6).map((l) => `${l.layer} ${n(l.triangles / 1000, 0)} k tri / ${l.calls} draws`).join(', ')}`);
    md.push(`- Top causes: ${r.findings.slice(0, 6).map((f) => `[${f.severity}] ${f.title}`).join('; ') || 'none'}`, '');
  }
  const worst = [...tour.stops].sort((a, b) => b.snap.frameMs - a.snap.frameMs)[0];
  const summary = `${tour.stops.length} stops; worst ${worst ? `${worst.stop.label} ${n(worst.snap.frameMs)} ms` : '—'}; ${causes.length} causes (${causes.filter((c) => c.severity === 'high').length} high)`;
  return { stamp, json, md: md.join('\n'), summary, against: null, server: null, desktop: null };
}
