import { describe, expect, it } from 'vitest';
import { transferCopy } from '@render/derivedWriterLane';

/** A WRITE HANDED TO THE DERIVED CACHE'S WRITER (`derivedWriterLane.ts` transferCopy): the value as it is, its arrays copies the writer may take */
describe('a value copied for the writer', () => {
  it('holds the same numbers in arrays of its own, every one of them handed over and none of the page\'s', () => {
    const shared = new Float32Array([1, 2, 3, 4]);
    const value = {
      kind: 'mass', count: 3, floors: [1, null, 2],
      parts: [{ positions: shared.subarray(1, 3), index: new Uint32Array([0, 1, 2]) }],
      tiles: new Map([['a', new Uint8Array([7, 8])]]),
      raw: new ArrayBuffer(8),
    };
    const transfer: Transferable[] = [];
    const copy = transferCopy(value, transfer);
    expect(copy).toEqual(value);
    expect(copy.parts[0]!.positions).toBeInstanceOf(Float32Array);
    expect([...copy.parts[0]!.positions]).toEqual([2, 3]);
    // Its own buffers: the subarray's copy holds its two elements alone, not the four of the buffer it stood in.
    expect(copy.parts[0]!.positions.buffer.byteLength).toBe(8);
    expect(copy.parts[0]!.positions.buffer).not.toBe(shared.buffer);
    expect(copy.tiles.get('a')!.buffer).not.toBe(value.tiles.get('a')!.buffer);
    expect(copy.raw).not.toBe(value.raw);
    // Every copy handed over, none of the page's own.
    expect(transfer.length).toBe(4);
    for (const buffer of [shared.buffer, value.parts[0]!.index.buffer, value.tiles.get('a')!.buffer, value.raw]) expect(transfer).not.toContain(buffer);
    // The page's arrays as they were after the copy is changed.
    copy.parts[0]!.positions[0] = 99;
    expect(shared[1]).toBe(2);
  });
});
