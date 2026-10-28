import { describe, expect, it } from 'vitest';

import { TiledSaves } from '@editor/chunkedSave';
import { type PartStore, writeBatch } from '@editor/saveStore';
import { MANIFEST_MAGIC, readValueFrame, valueFrame } from '@editor/regionFrames';
import { RoadDoc, type SerializedDoc } from '@world/doc';

/** THE CLOUDS AND THE PAINTED FOG LEFT THE GAME (MISSION.md item 4, 2026-10-28): a map saved with them still opens, without them, and its next save takes their squares away. */

type MemoryStore = PartStore & { readonly blobs: Map<string, Blob> };

function memoryStore(): MemoryStore {
  const blobs = new Map<string, Blob>();
  const store: MemoryStore = {
    blobs,
    async get(keys) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put, remove) {
      for (const [k, b] of put) blobs.set(k, b);
      for (const k of remove) blobs.delete(k);
      return true;
    },
    writer: { write: (batch) => writeBatch(store, batch) },
  };
  return store;
}

const small = (): RoadDoc => RoadDoc.fromJSON({ version: 1, nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }], segments: [{ id: 1, a: 1, b: 2, type: 1, curve: null }] } as never);

const manifestOf = async (store: MemoryStore): Promise<{ squares: Record<string, string[]> }> =>
  readValueFrame(await store.blobs.get('map:regions8')!.arrayBuffer(), MANIFEST_MAGIC) as { squares: Record<string, string[]> };

describe('a map saved with clouds and painted fog', () => {
  it('in JSON opens, its roads whole, and neither is written again', () => {
    const old = {
      ...small().toJSON(),
      clouds: [{ id: 1, x: 0, y: 0, height: 180, size: 150, density: 0.8, yaw: 0 }],
      fog: { dabs: [{ x: 0, y: 0, radius: 40, strength: 0.5, height: 24, speed: 6 }], settings: { density: 1 } },
    } as unknown as SerializedDoc;
    const doc = RoadDoc.fromJSON(old);
    expect(doc.nodes.size).toBe(2);
    expect(doc.segments.size).toBe(1);
    const json = doc.toJSON() as unknown as Record<string, unknown>;
    expect(json['clouds']).toBeUndefined();
    expect(json['fog']).toBeUndefined();
  });

  it('by squares opens, their squares never read, and its next save removes them', async () => {
    const store = memoryStore();
    await new TiledSaves(store, 'map').save(small(), {}, 1);
    // The squares a build before wrote for its clouds and fog, listed in its manifest (their bytes are never read).
    const manifest = await manifestOf(store);
    manifest.squares['fog'] = ['0,0'];
    manifest.squares['clouds'] = ['0,0', '1,0'];
    const junk = (): Blob => new Blob([new Uint8Array([1, 2, 3])]);
    await store.write([
      ['map:regions8', new Blob([valueFrame(MANIFEST_MAGIC, manifest)])],
      ['map:R8:fog:0,0', junk()], ['map:R8:clouds:0,0', junk()], ['map:R8:clouds:1,0', junk()],
    ], []);

    const saves = new TiledSaves(store, 'map');
    const read = await saves.read();
    expect(read).not.toBeNull();
    const doc = RoadDoc.fromJSON(read!.document, { repair: false, tables: read!.tables });
    expect(doc.nodes.size).toBe(2);
    expect(doc.segments.size).toBe(1);

    saves.adopt(doc, read!.layout);
    await saves.save(doc, {}, 2);
    expect([...store.blobs.keys()].filter((k) => k.includes(':fog:') || k.includes(':clouds:'))).toEqual([]);
    const after = await manifestOf(store);
    expect(Object.keys(after.squares)).not.toContain('fog');
    expect(Object.keys(after.squares)).not.toContain('clouds');
    // Opened again as it is now.
    const again = await new TiledSaves(store, 'map').read();
    expect(RoadDoc.fromJSON(again!.document, { repair: false, tables: again!.tables }).nodes.size).toBe(2);
  });
});
