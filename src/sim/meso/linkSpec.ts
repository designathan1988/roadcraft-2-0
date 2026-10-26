import type { NodeId } from '@world/ids';
import type { RoadSegment } from '@world/doc';
import { allowsDirection, linkCentre } from '@world/lanelets';
import { segmentPolyline } from '@world/geometry';
import { roadProfile, travelLanes } from '@world/roadTypes';
import { laneUse } from '@world/roadSection';
import { TUNNELS_DRAWN } from '@world/structures';
import type { SimWorld } from '../world';

/** A MESO LINK AS THE DOCUMENT GIVES IT (`meso.ts` relink): a directed road's lanes, trimmed length, speed and stop line, read as the lane graph builds the road's lanes from them (`lanelets.ts` buildSegmentLinks) - DO NOT read them off the lane graph, which holds the window's roads alone. */

/** A directed road's link as the document gives it (`MesoLinkSpec` but its exit): none when the road carries nothing that way. */
export interface LinkSpec {
  readonly from: NodeId;
  readonly to: NodeId;
  /** The lanes the meso counts: a bus lane is the buses' (`laneUse`), as the lane graph's bus lanes were left out. */
  readonly lanes: number;
  /** The road's centre between its stop lines (`linkCentre`): the links' span. */
  readonly length: number;
  readonly vFree: number;
  readonly controlled: boolean;
}

/** What the document makes of a road one way (`lanelets.ts` buildSegmentLinks reads the same): its lanes but the buses', its trimmed length, its speed, whether it runs into a stop line. */
export function linkSpec(w: SimWorld, seg: RoadSegment, forward: boolean): LinkSpec | null {
  // A tunnel with no geometry carries no traffic.
  if (seg.structure === 'tunnel' && !TUNNELS_DRAWN) return null;
  if (!allowsDirection(seg.direction, forward)) return null;
  const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
  const lpd = travelLanes(rt, seg.direction);
  let lanes = 0;
  for (let lane = 0; lane < lpd; lane++) if (laneUse(seg.section, forward, lane) !== 'bus') lanes++;
  if (!lanes) return null;
  const from = forward ? seg.a : seg.b, to = forward ? seg.b : seg.a;
  // Its length between its stop lines where the network holds the road (the micro window's); its line's whole length elsewhere, the network holding no trims there (DO NOT read the network for a road outside the window: its polylines filled with the map's).
  const length = w.net.holds(seg.id) ? linkCentre(w.doc, w.net, seg, from, to).centre.length : segmentPolyline(w.doc, seg).length;
  return { from, to, lanes, length, vFree: rt.speedLimit, controlled: w.doc.degree(to) >= 3 || w.doc.node(to)?.crossing !== undefined };
}
