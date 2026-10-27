/** A RECORD TABLE'S ROWS COPIED INTO ANOTHER WITHOUT DECODING THEM (`recordTable.ts` TableWriter.copyRows): the tags of its stream, a table copied from, and the walk of its bytes. */

export const T_NULL = 0, T_FALSE = 1, T_TRUE = 2, T_U8 = 3, T_I32 = 4, T_F64 = 5, T_STR = 6, T_ARR = 7, T_OBJ = 8, T_NODE = 9;

/** Where a table's sections start (`recordTable.ts` Layout), as a copy reads them. */
export interface CopyLayout {
  readonly rows: number;
  readonly strings: number;
  readonly units: number;
  readonly shapes: number;
  readonly keys: number;
  readonly nodes: number;
  readonly stream: number;
  readonly rootAt: number;
  readonly nodeAt: number;
  readonly strStart: number;
  readonly shapeStart: number;
  readonly shapeKeys: number;
  readonly strUnits: number;
  readonly streamAt: number;
}

/** The table a copy writes into: its stream, its shared members' places, and its ids of a string and of an object's keys (given as first met). */
export interface CopyTarget {
  readonly stream: { bytes: Uint8Array; length: number; room(n: number): void };
  readonly nodeAt: number[];
  stringId(s: string): number;
  shapeId(keys: readonly string[]): number;
}

/** A table rows are copied from: its stream, its strings and shapes decoded as met, and what of it the copying table already holds (its strings', shapes' and shared members' ids there). */
export class CopySource {
  /** Its stream's bytes. */
  readonly bytes: Uint8Array;
  readonly rootAt: Uint32Array;
  readonly nodeAt: Uint32Array;
  /** How many values each shape's object holds (its keys). */
  readonly shapeLength: Uint32Array;
  private readonly strStart: Uint32Array;
  private readonly strUnits: Uint16Array;
  private readonly shapeStart: Uint32Array;
  private readonly shapeKeys: Uint32Array;
  private readonly stringList: (string | undefined)[];
  private readonly shapeList: (string[] | undefined)[];
  /** This source's id of each kind to the copying table's (-1: not met yet). */
  readonly stringIds: Int32Array;
  readonly shapeIds: Int32Array;
  readonly nodeIds: Int32Array;

  /** `record`: a row's record decoded (a source without box columns, its box worked out of it). */
  constructor(buffer: ArrayBufferLike, at: CopyLayout, readonly record: (row: number) => unknown) {
    this.bytes = new Uint8Array(buffer, at.streamAt, at.stream);
    this.rootAt = new Uint32Array(buffer, at.rootAt, at.rows);
    this.nodeAt = new Uint32Array(buffer, at.nodeAt, at.nodes);
    this.strStart = new Uint32Array(buffer, at.strStart, at.strings + 1);
    this.strUnits = new Uint16Array(buffer, at.strUnits, at.units);
    this.shapeStart = new Uint32Array(buffer, at.shapeStart, at.shapes + 1);
    this.shapeKeys = new Uint32Array(buffer, at.shapeKeys, at.keys);
    this.stringList = new Array<string | undefined>(at.strings).fill(undefined);
    this.shapeList = new Array<string[] | undefined>(at.shapes).fill(undefined);
    this.shapeLength = new Uint32Array(at.shapes);
    for (let i = 0; i < at.shapes; i++) this.shapeLength[i] = this.shapeStart[i + 1]! - this.shapeStart[i]!;
    this.stringIds = new Int32Array(at.strings).fill(-1);
    this.shapeIds = new Int32Array(at.shapes).fill(-1);
    this.nodeIds = new Int32Array(at.nodes).fill(-1);
  }

  string(id: number): string {
    let s = this.stringList[id];
    if (s === undefined) {
      const a = this.strStart[id]!, b = this.strStart[id + 1]!;
      s = '';
      for (let i = a; i < b; i += 4096) s += String.fromCharCode(...this.strUnits.subarray(i, Math.min(b, i + 4096)));
      this.stringList[id] = s;
    }
    return s;
  }

  shape(id: number): string[] {
    let keys = this.shapeList[id];
    if (!keys) {
      keys = [];
      for (let i = this.shapeStart[id]!; i < this.shapeStart[id + 1]!; i++) keys.push(this.string(this.shapeKeys[i]!));
      this.shapeList[id] = keys;
    }
    return keys;
  }
}

/** A tag and its 32-bit number written. */
function emitId(target: CopyTarget, tag: number, id: number): void {
  const stream = target.stream;
  stream.room(5);
  const out = stream.bytes;
  let at = stream.length;
  out[at++] = tag;
  out[at++] = id & 0xff; out[at++] = (id >>> 8) & 0xff; out[at++] = (id >>> 16) & 0xff; out[at++] = id >>> 24;
  stream.length = at;
}

/**
 * The value at `start` of the source's stream copied after the target's (`emit`), or passed over (not `emit`); where it ends. ONE WALK OF THE
 * BYTES IN THEIR ORDER: the stream is the values in pre-order, each container telling how many follow (`pending`), so no call a value; the bytes
 * copied as they are but for the ids of the strings, shapes and shared members, renumbered to the target's as first met (the same order, and
 * the same bytes, as a walk a value at a time). A shared member met here first: its body copied where the source has it (behind its mark, or
 * elsewhere: walked from there); met again: its mark, its body passed over. DO NOT walk it a call and a `DataView` read a value, its ids in
 * `Map`s: the join of the 10 km city's squares (`editor/squaresDecode.ts`) and every save's cut of its squares copy hundreds of megabytes.
 */
export function copyValue(source: CopySource, start: number, target: CopyTarget, emit = true): number {
  const src = source.bytes, nodeAt = source.nodeAt, shapeLength = source.shapeLength;
  const stream = target.stream;
  let pos = start;
  let pending = 1;
  while (pending > 0) {
    pending--;
    const tag = src[pos]!;
    if (tag <= T_TRUE) {
      if (emit) { stream.room(1); stream.bytes[stream.length++] = tag; }
      pos += 1;
      continue;
    }
    if (tag === T_U8 || tag === T_I32 || tag === T_F64) {
      const n = tag === T_U8 ? 2 : tag === T_I32 ? 5 : 9;
      if (emit) {
        stream.room(n);
        const out = stream.bytes;
        let at = stream.length;
        for (let i = 0; i < n; i++) out[at++] = src[pos + i]!;
        stream.length = at;
      }
      pos += n;
      continue;
    }
    const id = (src[pos + 1]! | (src[pos + 2]! << 8) | (src[pos + 3]! << 16) | (src[pos + 4]! << 24)) >>> 0;
    pos += 5;
    switch (tag) {
      case T_STR:
        if (emit) {
          let own = source.stringIds[id]!;
          if (own < 0) source.stringIds[id] = own = target.stringId(source.string(id));
          emitId(target, T_STR, own);
        }
        break;
      case T_ARR:
        if (emit) emitId(target, T_ARR, id);
        pending += id;
        break;
      case T_OBJ:
        if (emit) {
          let own = source.shapeIds[id]!;
          if (own < 0) source.shapeIds[id] = own = target.shapeId(source.shape(id));
          emitId(target, T_OBJ, own);
        }
        pending += shapeLength[id]!;
        break;
      case T_NODE: {
        // The source writes a member's body behind its mark where it is first met; elsewhere the mark alone.
        const bodyHere = pos === nodeAt[id];
        if (!emit) { if (bodyHere) pending++; break; }
        const known = source.nodeIds[id]!;
        if (known >= 0) {
          emitId(target, T_NODE, known);
          if (bodyHere) pos = copyValue(source, pos, target, false);
          break;
        }
        const own = target.nodeAt.length;
        source.nodeIds[id] = own;
        target.nodeAt.push(stream.length + 5);
        emitId(target, T_NODE, own);
        // Its body next in these bytes (walked on here), or where the source wrote it.
        if (bodyHere) pending++;
        else copyValue(source, nodeAt[id]!, target);
        break;
      }
      default: throw new Error(`[buildings] a record table holds an unknown tag ${tag}`);
    }
  }
  return pos;
}
