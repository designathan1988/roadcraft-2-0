import type { LabContext } from '../labTypes';
import { settle, type Cancel } from '../tests/measure';
import { findingsOf, verdictOf, type Finding } from './findings';
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

export interface TourResult {
  readonly stops: readonly { readonly stop: TourStop; readonly snap: Snapshot; readonly findings: readonly Finding[]; readonly settleMs: number; readonly unsettled: boolean }[];
  /** Every cause seen, its worst weight, and where. */
  readonly causes: readonly { readonly finding: Finding; readonly stops: readonly string[] }[];
  readonly ms: number;
  readonly cancelled: boolean;
}

/** The standard zooms (`scripts/look/views.json`): a district, a street. */
const DISTRICT_ZOOM = 2.5;
const STREET_ZOOM = 28;
const TURN = Math.PI / 2;

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

export async function runTour(ctx: LabContext, cancel: Cancel, progress: (text: string) => void): Promise<TourResult> {
  const t0 = performance.now();
  const probe = (window as unknown as { __roadcraft?: Partial<TourProbe> }).__roadcraft;
  if (!probe?.bounds || !probe.setView || !probe.view || !probe.camera) throw new Error('the city tour needs the game\'s probes (__roadcraft.bounds, setView, view, camera): the development build has them');
  const view = probe.view();
  const home = { x: probe.camera.x, y: probe.camera.y, zoom: probe.camera.zoom, azimuth: view.azimuth, elevation: view.elevation };
  const stops = tourStops(probe.bounds(), view.azimuth, view.elevation);
  const out: TourResult['stops'][number][] = [];
  let cancelled = false;
  ctx.emit('doctor.tour', `city tour: ${stops.length} stops`, { stops: stops.map((s) => s.label) });
  try {
    for (const [i, stop] of stops.entries()) {
      if (cancel.stopped) { cancelled = true; break; }
      const tag = `${i + 1}/${stops.length} ${stop.label}`;
      progress(`${tag}: going there and settling`);
      probe.setView(stop);
      const s = await settle(ctx, cancel, 1500, 25_000);
      progress(`${tag}: measuring`);
      const snap = await snapshot(ctx, (text) => progress(`${tag}: ${text}`));
      const findings = findingsOf(snap);
      out.push({ stop, snap, findings, settleMs: s.ms, unsettled: s.unsettled });
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
    stops: out,
    causes: [...causes.values()].sort((a, b) => rank[a.finding.severity] - rank[b.finding.severity] || b.finding.ms - a.finding.ms),
    ms: performance.now() - t0,
    cancelled,
  };
}
