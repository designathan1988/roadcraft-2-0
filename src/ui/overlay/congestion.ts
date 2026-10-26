import type { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc, RoadSegment } from '@world/doc';
import type { Network } from '@world/network';
import { tilesMeeting } from '@world/networkWindow';
import type { SegmentId } from '@world/ids';
import { roadProfile } from '@world/roadTypes';
import { m } from '@world/units';

/** THE CONGESTION MAP (Layers > Congestion): each road in view coloured by how full its lanes are, green free, red jammed. Read off the document's roads and their centrelines (`RoadDoc.tileRoads`, `Network.polylines`): every road in view, whether the page's network holds it or not (`Network.scope`: the tiles near the view alone). */

/** A vehicle as the map reads it: the road its lane is on (undefined on a junction's connector or off the road). */
interface Moving { readonly segment: SegmentId | undefined }

/** Road a queued car takes up, its length and the gap to the next, m (HCM jam density: some 130 cars a lane-km). */
const CAR_SPACE = m(7.5);
/** Free, busy, slowing, jammed: share of the lanes' length taken at each colour's start. */
const STOPS: readonly (readonly [number, string])[] = [[0, '#57d06b'], [0.25, '#f3c33b'], [0.45, '#f07a2b'], [0.65, '#e5372f']];

/** The colour of a road whose lanes are `occupancy` full. */
export function congestionColour(occupancy: number): string {
  let colour = STOPS[0]![1];
  for (const [from, c] of STOPS) if (occupancy >= from) colour = c;
  return colour;
}

/** A road's profile and centreline as the map reads them. */
const roadOf = (net: Network, segment: RoadSegment): { width: number; lanes: number; line: Polyline } => {
  const road = roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking);
  return { width: road.width, lanes: road.lanes, line: net.polylines.get(net.doc, segment.id) };
};

/** Each road's occupancy: the length its vehicles take over the length of its travel lanes (a few cars waiting at a light leave a long street free). */
export function roadOccupancy(net: Network, vehicles: Iterable<Moving>): Map<SegmentId, number> {
  const count = new Map<SegmentId, number>();
  for (const car of vehicles) if (car.segment !== undefined) count.set(car.segment, (count.get(car.segment) ?? 0) + 1);
  const out = new Map<SegmentId, number>();
  for (const [id, n] of count) {
    const segment = net.doc.segment(id);
    if (!segment) continue;
    const road = roadOf(net, segment);
    const lanes = Math.max(1, road.lanes) * Math.max(1, road.line.length);
    out.set(id, Math.min(1, (n * CAR_SPACE) / lanes));
  }
  return out;
}

/** A road's line as the map draws it: the middle, the middle moved across by the road's width, then each point of the band (x, y). */
const sampled = new WeakMap<Polyline, Float64Array>();

/** The points of a road's band, sampled once: a road changed is a new centreline (`Network.polylines`), so DO NOT sample it again each frame. */
function bandOf(line: Polyline, width: number): Float64Array {
  let band = sampled.get(line);
  if (band) return band;
  const steps = Math.max(2, Math.min(48, Math.ceil(line.length / 12)));
  band = new Float64Array(4 + 2 * (steps + 1));
  const mid = line.sampleAt(line.length / 2);
  band[0] = mid.p.x; band[1] = mid.p.y;
  band[2] = mid.p.x + mid.n.x * width; band[3] = mid.p.y + mid.n.y * width;
  const frame = line.sampleAt(0);
  for (let k = 0; k <= steps; k++) {
    line.sampleAtInto((k / steps) * line.length, frame);
    band[4 + 2 * k] = frame.p.x; band[5 + 2 * k] = frame.p.y;
  }
  sampled.set(line, band);
  return band;
}

/** The roads of the document whose tiles meet `view`, in id order. */
function roadsInView(doc: RoadDoc, view: readonly [number, number, number, number]): RoadSegment[] {
  const out: RoadSegment[] = [];
  for (const tile of tilesMeeting(view)) {
    for (const id of doc.tileRoads(tile).segments) {
      const segment = doc.segment(id as SegmentId);
      if (segment) out.push(segment);
    }
  }
  return out.sort((p, q) => p.id - q.id);
}

/** The congestion map drawn on the editor's overlay: the roads of the tiles meeting `view` (a world box), as bands as wide as their carriageway. */
export function drawCongestion(ctx: CanvasRenderingContext2D, net: Network, vehicles: Iterable<Moving>,
  view: readonly [number, number, number, number], at: (p: Vec2) => Vec2): void {
  const occupancy = roadOccupancy(net, vehicles);
  const point = { x: 0, y: 0 };
  const atPoint = (band: Float64Array, i: number): Vec2 => { point.x = band[i]!; point.y = band[i + 1]!; return at(point); };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const segment of roadsInView(net.doc, view)) {
    const road = roadOf(net, segment);
    const band = bandOf(road.line, road.width);
    const a = atPoint(band, 0), b = atPoint(band, 2);
    const width = Math.max(3, Math.hypot(b.x - a.x, b.y - a.y) * 0.7);
    ctx.strokeStyle = congestionColour(occupancy.get(segment.id) ?? 0);
    ctx.lineWidth = width;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    for (let i = 4; i < band.length; i += 2) {
      const p = atPoint(band, i);
      if (i === 4) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
