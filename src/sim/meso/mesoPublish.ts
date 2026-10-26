import { m } from '@world/units';
import type { MesoModel } from './model';
import { MESO_INSIDE, MESO_ONE_WAY, MESO_PRESENT, ML, type MesoDelta, MesoDeltaBuilder } from './memory';
import { grown } from './slots';

/** WHAT THE PAGE IS SENT OF THE MESO (`meso.ts` publish): the links whose drawn numbers changed since they were last sent, a slot at a time (`MesoDelta`). */

/** The serial of a slot's line wraps here: a Float32 holds it whole (`memory.ts` ML.shape). */
const SHAPE_WRAP = (1 << 24) - 1;
/** A link's speed is sent again when it moved by more than this share (the far cars' pace: a few percent is not seen). */
const SPEED_STEP = 0.1;
/** Numbers kept a slot of what the page was last sent (`sent`): its rounded count and queue, speed, length, lanes, flags. */
const SENT = 6;

/** The links as the publisher reads them, by slot (`Meso`'s tables): the model, each slot's link, whether its road is one-way, its line, and whether the page has not had its line. */
export interface PublishedLinks {
  readonly model: MesoModel;
  readonly linkAt: Float64Array;
  readonly oneWay: Uint8Array;
  readonly lines: Float32Array;
  readonly dirty: Uint8Array;
}

export class MesoPublisher {
  /** The page's delta under way, what each slot was last sent as, and whether the next publish is whole. */
  private readonly out = new MesoDeltaBuilder();
  private sent = new Float32Array(0);
  private wholeDue = true;
  private shapeSerial = 0;
  /** `flowInto`'s numbers. */
  private readonly flow = { count: 0, queued: 0, speed: 0 };

  /** Room for slots below `n`. */
  reserve(n: number): void {
    if (n * SENT > this.sent.length) this.sent = grown(this.sent, n * SENT);
  }

  /** Everything forgotten (another map): the next publish is whole. */
  reset(): void {
    this.sent = new Float32Array(0);
    this.wholeDue = true;
  }

  /** The page's copy of the links is new (its first window, or it lost deltas): the next publish sends every link. */
  requestWhole(): void {
    this.wholeDue = true;
  }

  /** The links changed since the last call, for the page (null: nothing new). */
  takeDelta(): MesoDelta | null {
    return this.out.take();
  }

  /** A publish begins: whole when one is due (every link sent again). */
  begin(): void {
    if (!this.wholeDue) return;
    this.wholeDue = false;
    this.out.startWhole();
    this.sent.fill(0);
  }

  /** A publish ended: the step's head. */
  end(slots: number, time: number, windowX: number, windowY: number, windowR: number): void {
    this.out.end(slots, time, windowX, windowY, windowR);
  }

  /** The links in [`from`, `to`) whose drawn numbers changed since they were last sent, appended to the delta (`MesoDelta`). */
  publishIn(from: number, to: number, links: PublishedLinks): void {
    const { model, linkAt, oneWay, lines, dirty } = links, sent = this.sent, out = this.out;
    for (let slot = from; slot < to; slot++) {
      const o = slot * SENT;
      if (!model.has(slot)) {
        // Gone since it was sent: sent once more, as no link.
        if (sent[o + 5] !== 0) {
          const at = out.push(slot, Number.NaN), r = out.recordsNow;
          r.fill(0, at, at + ML.shape + 1);
          sent[o + 5] = 0;
        }
        continue;
      }
      const flow = this.flow;
      model.flowInto(slot, flow);
      const flags = MESO_PRESENT | (model.isInside(slot) ? MESO_INSIDE : 0) | (oneWay[slot] ? MESO_ONE_WAY : 0);
      const count = Math.round(flow.count), queued = Math.round(flow.queued), length = model.lengthAt(slot), lanes = model.lanesAt(slot);
      const line = dirty[slot] === 1 || sent[o + 5] === 0;
      const was = sent[o + 2]!;
      if (!line && sent[o + 5] === flags && sent[o] === count && sent[o + 1] === queued && sent[o + 3] === Math.fround(length) && sent[o + 4] === lanes
        && Math.abs(flow.speed - was) <= SPEED_STEP * Math.max(was, m(1))) continue;
      sent[o] = count; sent[o + 1] = queued; sent[o + 2] = flow.speed; sent[o + 3] = length; sent[o + 4] = lanes; sent[o + 5] = flags;
      const at = out.push(slot, linkAt[slot]!), r = out.recordsNow;
      r[at + ML.count] = flow.count;
      r[at + ML.queued] = flow.queued;
      r[at + ML.speed] = flow.speed;
      r[at + ML.length] = length;
      r[at + ML.lanes] = lanes;
      r[at + ML.flags] = flags;
      for (let k = 0; k < 6; k++) r[at + ML.ax + k] = lines[slot * 6 + k]!;
      if (line) {
        this.shapeSerial = (this.shapeSerial % SHAPE_WRAP) + 1;
        r[at + ML.shape] = this.shapeSerial;
        dirty[slot] = 0;
      } else {
        r[at + ML.shape] = 0;
      }
    }
  }
}
