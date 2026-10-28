import type { LabContext } from '../labTypes';
import { sceneSign, settle, type Cancel } from '../tests/measure';
import { findingsOf, verdictOf, type Finding } from './findings';
import { recordGpuTimeline, type GpuTimeline } from './gpuTimeline';
import { timelineFindings } from './timelineFindings';
import { snapshot, type Snapshot } from './measure';

/**
 * THE CITY TOUR: the diagnosis measured at every kind of view a player takes - the whole city from above and turned, districts over the
 * whole map at their zoom and a few bearings, streets seen low from several sides, the city's edge - each stop settled first (nothing
 * waiting to land, the frames steady: `tests/measure.ts` settle), then measured whole (`measure.ts` snapshot: the passes, one frame's draws,
 * the CPU, the hidden work, the waste). Every cause found anywhere is kept with the stops it was seen at and its worst weight.
 * DO NOT judge the game from one view: a district at one zoom showed none of the far masses' cost the whole city pays (2026-10-27).
 */

/** The probes the tour drives (`main.ts` `__roadcraft`). */
interface TourProbe {
  bounds(): { minX: number; minY: number; maxX: number; maxY: number; fitZoom: number };
  setView(at: { x: number; y: number; zoom: number; azimuth: number; elevation: number }): void;
  view(): { azimuth: number; elevation: number };
  camera: { x: number; y: number; zoom: number };
}

export interface TourStop {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly azimuth: number;
  readonly elevation: number;
}

/** One moment of a scene loading: what was still to land, what was drawn, and the photo taken then. */
interface LoadSample {
  readonly ms: number;
  readonly notLanded: number;
  readonly triangles: number;
  readonly draws: number;
  readonly photo: string | null;
}

/** How a stop's scene came in: the photo before it was asked, a photo a second while it loaded, the one once it settled. */
interface LoadTimeline {
  readonly before: string | null;
  readonly samples: readonly LoadSample[];
  readonly after: string | null;
  /** From the camera's move to the first frame with nothing left to land, ms; null when it never came in the wait. */
  readonly landedMs: number | null;
  /** The GPU's timeline from the camera's move on (`gpuTimeline.ts`): what the frames of the move waited on, every draw timed. */
  readonly timeline: GpuTimeline | null;
}

export interface TourResult {
  readonly folder: string;
  readonly stops: readonly { readonly stop: TourStop; readonly snap: Snapshot; readonly findings: readonly Finding[]; readonly settleMs: number; readonly unsettled: boolean; readonly load: LoadTimeline }[];
  /** Every cause seen, its worst weight, and where. */
  readonly causes: readonly { readonly finding: Finding; readonly stops: readonly string[] }[];
  readonly ms: number;
  readonly cancelled: boolean;
}

/** The standard zooms (`scripts/look/views.json`): a district, a street. */
const DISTRICT_ZOOM = 2.5;
const STREET_ZOOM = 28;
const TURN = Math.PI / 2;
/** How long a move's frames are timed draw by draw from the camera's move, ms. */
const LOAD_TIMELINE_MS = 6000;

/** The stops over the city's bounds: the whole, a 3×3 grid of districts, five streets, the edge. */
export function tourStops(b: { minX: number; minY: number; maxX: number; maxY: number; fitZoom: number }, azimuth: number, elevation: number): TourStop[] {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const at = (fx: number, fy: number): { x: number; y: number } => ({ x: b.minX + w * fx, y: b.minY + h * fy });
  const stops: TourStop[] = [
    { label: 'whole city', x: cx, y: cy, zoom: b.fitZoom, azimuth, elevation },
    { label: 'whole city, turned and lower', x: cx, y: cy, zoom: b.fitZoom * 1.6, azimuth: azimuth + TURN, elevation: Math.max(0.35, elevation * 0.7) },
  ];
  let k = 0;
  for (const fy of [0.2, 0.5, 0.8]) {
    for (const fx of [0.2, 0.5, 0.8]) {
      const p = at(fx, fy);
      stops.push({ label: `district ${Math.round(fx * 10)}-${Math.round(fy * 10)}`, ...p, zoom: DISTRICT_ZOOM, azimuth: azimuth + (k++ % 4) * TURN / 2, elevation });
    }
  }
  for (const [fx, fy, turn] of [[0.5, 0.5, 0], [0.3, 0.3, 1], [0.7, 0.3, 2], [0.3, 0.7, 3], [0.7, 0.7, 0.5]] as const) {
    stops.push({ label: `street ${Math.round(fx * 10)}-${Math.round(fy * 10)}`, ...at(fx, fy), zoom: STREET_ZOOM, azimuth: azimuth + turn * TURN, elevation: 0.3 });
  }
  stops.push({ label: 'the edge, looking in', ...at(0.02, 0.02), zoom: DISTRICT_ZOOM / 2, azimuth: azimuth + TURN / 2, elevation });
  return stops;
}

/** Photos of the game's canvas as it is drawn (the next frame's, taken in its own frame callback so its picture is still there), at the
 *  canvas's own resolution, PNG, written by the dev server into `lab-reports/shots/<folder>/` (`scripts/vite/labReports.ts`). DO NOT shrink
 *  them nor compress them lossily: at 1280 px JPEG a facade's windows and a road's markings could not be told apart (the owner, 2026-10-27).
 *  DO NOT encode them with `toDataURL` in the frame: the PNG of a full-resolution canvas was encoded on the main thread inside the game's
 *  frame, hundreds of ms a photo, and its base64 and JSON copies (~20 MB a photo) filled the heap; the tour then measured its own photos
 *  as the game's long frames and collections (2026-10-27). `toBlob` encodes off the frame; the bytes are posted as they are. Null where none
 *  could be written. */
function photographer(ctx: LabContext, folder: string): (name: string) => Promise<string | null> {
  return (name) => new Promise((done) => {
    const stop = ctx.onFrame(() => {
      stop();
      const source = ctx.scene.gl.domElement;
      if (!source.width) { done(null); return; }
      source.toBlob((blob) => {
        if (!blob) { console.warn('lab tour: the canvas gave no picture'); done(null); return; }
        const query = new URLSearchParams({ folder, name });
        void fetch(`/__lab/shot?${query.toString()}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob })
          .then((r) => (r.ok ? r.json() as Promise<{ file: string }> : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((r) => done(r.file), (error: unknown) => { console.warn('lab tour: photo not written', error); done(null); });
      }, 'image/png');
    });
    ctx.requestDraw();
  });
}

/** The scene at `stop` settled, a photo a second meanwhile, the time it took to land (`LoadTimeline`). */
async function loadAt(ctx: LabContext, probe: TourProbe, stop: TourStop, shoot: (name: string) => Promise<string | null>, tag: string, cancel: Cancel): Promise<{ load: LoadTimeline; settleMs: number; unsettled: boolean }> {
  const before = await shoot(`${tag}-0-before`);
  const t0 = performance.now();
  probe.setView(stop);
  // The move's frames timed draw by draw while the scene comes in: where a move's slow frames go (the owner's camera, 2026-10-27).
  const timing = recordGpuTimeline(ctx, LOAD_TIMELINE_MS).catch((error: unknown) => { console.error('lab tour: the GPU timeline failed', error); return null; });
  const samples: LoadSample[] = [];
  let landedMs: number | null = null;
  let done = false;
  const settling = settle(ctx, cancel, 1500, 25_000).finally(() => { done = true; });
  // A photo a second while it loads (the first at once): what the player sees as the scene comes in.
  for (let k = 0; !done && k < 30; k++) {
    const sign = sceneSign(ctx);
    const ms = performance.now() - t0;
    if (landedMs === null && sign.notLanded === 0 && k > 0) landedMs = ms;
    const photo = await shoot(`${tag}-1-load-${String(Math.round(ms)).padStart(6, '0')}ms`);
    const stats = ctx.scene.stats;
    samples.push({ ms, notLanded: sign.notLanded, triangles: stats.drawnTriangles, draws: stats.drawCalls, photo });
    await new Promise<void>((next) => { window.setTimeout(next, 1000); });
  }
  const s = await settling;
  if (landedMs === null && sceneSign(ctx).notLanded === 0) landedMs = performance.now() - t0;
  const after = await shoot(`${tag}-2-after`);
  const timeline = await timing;
  return { load: { before, samples, after, landedMs, timeline }, settleMs: s.ms, unsettled: s.unsettled };
}

export async function runTour(ctx: LabContext, cancel: Cancel, progress: (text: string) => void): Promise<TourResult> {
  const t0 = performance.now();
  const probe = (window as unknown as { __roadcraft?: Partial<TourProbe> }).__roadcraft;
  if (!probe?.bounds || !probe.setView || !probe.view || !probe.camera) throw new Error('the city tour needs the game\'s probes (__roadcraft.bounds, setView, view, camera): the development build has them');
  const view = probe.view();
  const home = { x: probe.camera.x, y: probe.camera.y, zoom: probe.camera.zoom, azimuth: view.azimuth, elevation: view.elevation };
  const stops = tourStops(probe.bounds(), view.azimuth, view.elevation);
  const folder = `tour-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`;
  const shoot = photographer(ctx, folder);
  const out: TourResult['stops'][number][] = [];
  let cancelled = false;
  ctx.emit('doctor.tour', `city tour: ${stops.length} stops`, { stops: stops.map((s) => s.label) });
  try {
    for (const [i, stop] of stops.entries()) {
      if (cancel.stopped) { cancelled = true; break; }
      const tag = `${i + 1}/${stops.length} ${stop.label}`;
      progress(`${tag}: going there, a photo a second while it loads`);
      const loaded = await loadAt(ctx, probe as TourProbe, stop, shoot, String(i + 1).padStart(2, '0'), cancel);
      progress(`${tag}: measuring`);
      const snap = await snapshot(ctx, (text) => progress(`${tag}: ${text}`));
      const findings = [...findingsOf(snap), ...timelineFindings(loaded.load.timeline, `moving to ${stop.label}`).map((f) => ({ ...f, id: `move.${f.id}` }))];
      out.push({ stop, snap, findings, settleMs: loaded.settleMs, unsettled: loaded.unsettled, load: loaded.load });
      ctx.emit('doctor.tour.stop', `${tag}: ${verdictOf(snap).bound}, ${findings.length} causes`, { stop: stop.label, frameMs: snap.frameMs, gpuMs: snap.gpuMs, cpuMs: snap.cpuMs });
    }
  } catch (error) {
    if (!cancel.stopped) throw error;
    cancelled = true;
  } finally {
    probe.setView(home);
  }
  const causes = new Map<string, { finding: Finding; stops: string[] }>();
  for (const r of out) {
    for (const f of r.findings) {
      const known = causes.get(f.id);
      if (!known) causes.set(f.id, { finding: f, stops: [r.stop.label] });
      else { known.stops.push(r.stop.label); if (f.ms > known.finding.ms) known.finding = f; }
    }
  }
  const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;
  return {
    folder,
    stops: out,
    causes: [...causes.values()].sort((a, b) => rank[a.finding.severity] - rank[b.finding.severity] || b.finding.ms - a.finding.ms),
    ms: performance.now() - t0,
    cancelled,
  };
}
