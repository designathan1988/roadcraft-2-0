import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SAVE_TILE, type SavedTables, TiledSaves } from '@editor/chunkedSave';
import { RecordTable } from '@world/buildings/recordTable';
import { type PartStore, writeBatch } from '@editor/saveStore';
import { CELL } from '@world/cells';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { TILE } from '@world/tiles';

/**
 * A MAP SAVED ON THE TILES OF 1,024 m (manifest 6) OPENS, AND IS SAVED NEXT ON THE TILES OF 1,000 m (manifest 8, `chunkedSave.ts`)
 *
 * `tests/fixtures/save-v6-head.json` was written by HEAD db9da0c7's own code (its `TiledSaves`, `tiles.ts` and `doc.ts`, run from `git archive HEAD`):
 * the parking town and four tiles of 1,024 m loaded into it, their records' ids handed out as HEAD hands them ((tile key + 1) x 2^20), saved in the
 * squares of its tiles (1,024 m) and cells (256 m); `document` is HEAD's own `toJSON()` of that map, gzip and base64; `blobs` every key it stored.
 */
interface HeadSave { readonly head: string; readonly tile: number; readonly cell: number; readonly savedAt: number; readonly document: string; readonly blobs: Readonly<Record<string, string>> }
const fixture = JSON.parse(readFileSync('tests/fixtures/save-v6-head.json', 'utf8')) as HeadSave;
const headDocument = JSON.parse(gunzipSync(Buffer.from(fixture.document, 'base64')).toString('utf8')) as SerializedDoc;

type MemoryStore = PartStore & { readonly blobs: Map<string, Blob>; writes: string[][] };
/** The fixture's blobs in an IndexedDB stand-in that counts what each write touched. */
function headStore(): MemoryStore {
  const blobs = new Map<string, Blob>(Object.entries(fixture.blobs).map(([k, b64]) => [k, new Blob([Buffer.from(b64, 'base64')])]));
  const store: MemoryStore = {
    blobs,
    writes: [],
    async get(keys) { return keys.map((k) => blobs.get(k) ?? null); },
    async write(put, remove) {
      for (const [k, b] of put) blobs.set(k, b);
      for (const k of remove) blobs.delete(k);
      store.writes.push(put.map(([k]) => k));
      return true;
    },
    writer: { write: (batch) => writeBatch(store, batch) },
  };
  return store;
}

/** A map in the file's form with its keyed lists by id (the order of a map's records by id means nothing; a list's order does). */
function canonical(json: SerializedDoc): unknown {
  const byId = (list: readonly unknown[] | undefined): unknown[] => [...(list ?? [])].sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
  return {
    ...json, nodes: byId(json.nodes), segments: byId(json.segments), poles: byId(json.poles), poleSpans: byId(json.poleSpans),
    landscape: byId(json.landscape), barriers: byId(json.barriers), buildings: byId(json.buildings), lots: byId(json.lots),
  };
}
const asHeadSaved = canonical(RoadDoc.fromJSON(headDocument).toJSON());
const square = (x: number, y: number, side: number): string => `${Math.floor(x / side)},${Math.floor(y / side)}`;
/** The ids a map's keyed records carry, in its document and in its tables (a map read back keeps the kinds in tables there, `SavedTables`), sorted. */
const idsOf = (json: SerializedDoc, tables: SavedTables = {}): number[] =>
  [json.nodes, json.segments, json.poles, json.poleSpans, json.landscape, json.barriers, json.buildings, json.lots]
    .flatMap((list) => (list ?? []).map((r) => (r as { id: number }).id))
    .concat(Object.values(tables).flatMap((buffer) => [...new RecordTable(buffer).ids]))
    .sort((a, b) => a - b);

describe('a map saved on the tiles of 1,024 m (manifest 6, HEAD db9da0c7)', () => {
  it('is HEAD\'s: its squares those of 1,024 m and 256 m, its tiles\' records ids of HEAD\'s ranges', () => {
    expect([fixture.head, fixture.tile, fixture.cell]).toEqual(['db9da0c7', 1024, 256]);
    const keys = Object.keys(fixture.blobs);
    expect(keys).toContain('map:regions');
    expect(keys.every((k) => k.startsWith('map:R:') || k.startsWith('map:RW:') || k.startsWith('map:RG:') || k === 'map:regions')).toBe(true);
    // The four tiles' records: ids of HEAD's tiles ((key + 1) x 2^20, under 2^52 + 2^20), none of today's (from 2^52 + 2^20, `world/tiles.ts`).
    const tiled = idsOf(headDocument).filter((id) => id >= 2 ** 20);
    expect(tiled.length).toBe(40);
    for (const id of tiled) expect(id < 2 ** 52 + 2 ** 20).toBe(true);
  });

  it('opens whole as it was, every record and every id as HEAD saved them, the manifest 6 kept for an older build', async () => {
    const store = headStore();
    const read = await new TiledSaves(store, 'map').read();
    expect(read).not.toBeNull();
    expect(read!.savedAt).toBe(4242);
    expect(read!.settings).toEqual({ camera: 9 });
    // Read as a format before now: its keys handed on, so the next save writes the map whole on the squares of now.
    expect([...read!.layout.old!].sort()).toEqual(Object.keys(fixture.blobs).sort());
    expect(canonical(RoadDoc.fromJSON(read!.document, { tables: read!.tables }).toJSON())).toEqual(asHeadSaved);
    expect(idsOf(read!.document, read!.tables)).toEqual(idsOf(headDocument));
  });

  it('is saved next as manifest 8 on the tiles of 1,000 m and the cells of 250 m, every record filed again, the manifest 6 left as it was', async () => {
    const store = headStore();
    const saves = new TiledSaves(store, 'map');
    const read = await saves.read();
    const doc = RoadDoc.fromJSON(read!.document, { tables: read!.tables });
    saves.adopt(doc, read!.layout);
    const before = new Map(store.blobs);
    expect(await saves.save(doc, { camera: 10 }, 5353)).toBe(true);
    // The player's map of an older build left as it was: every blob of the manifest 6 the same blob.
    for (const [k, blob] of before) expect(store.blobs.get(k), k).toBe(blob);
    // What was written: the regions of now alone.
    const written = store.writes.at(-1)!;
    expect(written.every((k) => k.startsWith('map:R8:') || k.startsWith('map:RW8:') || k.startsWith('map:RG8:') || k === 'map:regions8')).toBe(true);
    expect(written.at(-1)).toBe('map:regions8');
    // Every record in the square of now its place says: a road's node by the tile of 1,000 m, a building by the cell of 250 m.
    expect([SAVE_TILE, CELL]).toEqual([TILE, 250]);
    const squares = (layer: string): string[] => written.filter((k) => k.startsWith(`map:R8:${layer}:`)).map((k) => k.slice(`map:R8:${layer}:`.length)).sort();
    const unique = (list: readonly string[]): string[] => [...new Set(list)].sort();
    expect(squares('nodes')).toEqual(unique([...doc.nodes.values()].map((n) => square(n.x, n.y, SAVE_TILE))));
    expect(squares('buildings')).toEqual(unique([...doc.buildings.all()].map((b) => square(b.x, b.y, CELL))));
    expect(squares('trees')).toEqual(unique(doc.trees.map((t) => square(t.x, t.y, SAVE_TILE))));
    // The map read again is manifest 8's, as it was: every id as HEAD saved it.
    const again = await new TiledSaves(store, 'map').read();
    expect(again!.layout.old).toBeNull();
    expect(again!.savedAt).toBe(5353);
    expect(canonical(RoadDoc.fromJSON(again!.document, { tables: again!.tables }).toJSON())).toEqual(asHeadSaved);
    expect(idsOf(again!.document, again!.tables)).toEqual(idsOf(headDocument));
  });

  it('opens from manifest 8 once saved, and writes then only the square an edit reached', async () => {
    const store = headStore();
    const first = new TiledSaves(store, 'map');
    const read = await first.read();
    const migrated = RoadDoc.fromJSON(read!.document, { tables: read!.tables });
    first.adopt(migrated, read!.layout);
    await first.save(migrated, {}, 6000);
    const reader = new TiledSaves(store, 'map');
    const opened = await reader.read();
    expect(opened!.layout.old).toBeNull();
    const doc = RoadDoc.fromJSON(opened!.document, { tables: opened!.tables });
    reader.adopt(doc, opened!.layout);
    const one = [...doc.buildings.all()][7]!;
    doc.buildings.put({ ...one, decay: 0.4 });
    await reader.save(doc, {}, 7000);
    const at = square(one.x, one.y, CELL);
    expect(store.writes.at(-1)).toEqual([`map:R8:buildings:${at}`, `map:RW8:${at}`, 'map:regions8']);
  });
});
