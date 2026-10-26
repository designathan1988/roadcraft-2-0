import type { RoadDoc } from './doc';
import type { SegmentId } from './ids';
import { JournalCursor } from './derived';
import { segmentPolyline } from './geometry';

/** THE ROAD LENGTH OF THE WHOLE MAP, from the document's roads (the traffic's and the people's numbers are its density over it, `sim/vehicles/spawn.ts` trafficTarget): kept by the diary's road entries, DO NOT read it off a network that holds the micro window's roads alone (`Network.scope`), nor sum every road of the map at each edit. */

/** Lengths are summed in millionths of a unit, as integers: exact, in whatever order an edit adds and takes them. */
const SCALE = 1e6;

export class DocRoadLength {
  private doc: RoadDoc | null = null;
  private readonly roads = new JournalCursor(['roads']);
  private readonly bySegment = new Map<SegmentId, number>();
  private total = 0;

  of(doc: RoadDoc): number {
    if (this.doc !== doc) { this.doc = doc; this.bySegment.clear(); this.total = 0; }
    const entries = this.roads.read(doc.changes);
    if (entries === null) { this.sumAll(doc); return this.total / SCALE; }
    for (const entry of entries) {
      // An entry that names no node nor road (the map loaded): everything summed again.
      if (!entry.nodes && !entry.segments) { this.sumAll(doc); return this.total / SCALE; }
      // A node moved moves its roads' lengths.
      for (const node of entry.nodes ?? []) for (const id of doc.node(node as never)?.incident ?? []) this.put(doc, id);
      for (const id of entry.segments ?? []) this.put(doc, id as SegmentId);
    }
    return this.total / SCALE;
  }

  /** @rebuild Every road summed again. */
  private sumAll(doc: RoadDoc): void {
    this.bySegment.clear();
    this.total = 0;
    for (const id of doc.segments.keys()) this.put(doc, id);
  }

  private put(doc: RoadDoc, id: SegmentId): void {
    this.total -= this.bySegment.get(id) ?? 0;
    this.bySegment.delete(id);
    const seg = doc.segment(id);
    if (!seg || !doc.node(seg.a) || !doc.node(seg.b)) return;
    const length = Math.round(segmentPolyline(doc, seg).length * SCALE);
    this.bySegment.set(id, length);
    this.total += length;
  }
}
