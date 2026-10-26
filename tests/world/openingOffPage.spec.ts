import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { preparedCity } from '@editor/preparedCity';
import { RoadDoc, type SerializedDoc, savedNode, savedSegment } from '@world/doc';
import { tableIn } from '@world/buildings/recordTable';
import { Network } from '@world/network';
import { roadsOfTiles, tilesMeeting } from '@world/networkWindow';
import { networkWork } from '@world/rebuildWork';
import { rampsMeeting, rampsOfNode, walkingRise } from '@world/curbRamps';
import { bakeRoads } from '../../src/roadBake.worker';
import { networkLines } from './support/roadDigest';

/**
 * A CITY'S OPENING OFF THE PAGE (`roadBake.worker.ts`, `world/networkWindow.ts`, `curbRamps.ts`): the cooked small city's tiles each solved
 * as a job thread solves one (its roads and those at their ends alone), each bake cloned as a message clones it, and the page's own build,
 * holding those tiles' roads (`Network.scope`), taking them - every junction and ribbon the same, number for number, as the page solving
 * the whole map alone (`networkLines`: every level of every junction, every ribbon's centrelines and outlines), none solved again. And the
 * dropped kerbs worked out region by region as they are asked (a walker's point, a cell's rectangle): the same ramps and the same walking
 * heights as every ramp of the map worked out first.
 */

function opened(): { doc: RoadDoc; data: SerializedDoc; table: ArrayBufferLike } {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL('small-7.json.gz', dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL('small-7.table.gz', dir)));
  const table = tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const doc = new RoadDoc();
  const city = preparedCity(data, table);
  doc.replaceFromJSON(city.data, { repair: false, buildingTable: table, whole: true });
  return { doc, data: city.data, table };
}

/** The tiles the whole small city lies in: what it opens with. */
function cityTiles(doc: RoadDoc): number[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of doc.nodes.values()) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  return [...tilesMeeting([minX, minY, maxX, maxY])];
}

describe('a city opened off the page', () => {
  it("takes the network job threads solved tile by tile, the same as the page's own of the whole map", () => {
    const { doc } = opened();
    const alone = new Network(doc);
    alone.rebuild({ full: true });
    const tiles = cityTiles(doc);
    expect(tiles.length).toBeGreaterThan(1);
    const taken = new Network(doc);
    taken.scope = roadsOfTiles(doc, tiles);
    expect(taken.scope.size).toBe(doc.segments.size);
    // Each tile asked as the window asks it (`NetworkWindow` askOf): its roads and those at their ends, its own junctions and ribbons solved.
    for (const tile of tiles) {
      const scope = roadsOfTiles(doc, [tile]);
      if (!scope.size) continue;
      const inside = [...doc.tileRoads(tile).segments].filter((id) => doc.segment(id as never));
      const nodes = new Set<number>(), bakeNodes = new Set<number>();
      for (const id of scope) { const s = doc.segment(id)!; nodes.add(s.a); nodes.add(s.b); }
      for (const id of inside) { const s = doc.segment(id as never)!; bakeNodes.add(s.a); bakeNodes.add(s.b); }
      const ask = {
        nodes: [...nodes].sort((p, q) => p - q).map((id) => savedNode(doc.node(id as never)!)),
        segments: [...scope].sort((p, q) => p - q).map((id) => savedSegment(doc.segment(id)!)),
        markingStyle: doc.markingStyle, scope: [...scope].sort((p, q) => p - q),
        bakeNodes: [...bakeNodes].sort((p, q) => p - q) as never[], bakeSegments: [...scope].sort((p, q) => p - q), at: [0, 0] as const,
      };
      taken.offerBake(structuredClone(bakeRoads(ask)));
    }
    const before = { ...networkWork };
    taken.rebuild({ full: true });
    expect(networkLines(taken)).toEqual(networkLines(alone));
    // Every junction taken as solved there, none built again on the page.
    expect(networkWork.taken - before.taken).toBeGreaterThan(0);
    expect(networkWork.built - before.built).toBe(0);
  });

  it('works the dropped kerbs out region by region, the same as all at once', () => {
    const { doc } = opened();
    const whole = new Network(doc);
    whole.rebuild();
    const ramps = [...doc.nodes.keys()].flatMap((id) => [...rampsOfNode(whole, id)]);
    expect(ramps.length).toBeGreaterThan(100);
    const lazy = new Network(doc);
    lazy.rebuild();
    for (const r of ramps) {
      expect(walkingRise(lazy, r.x + r.tx * 0.3, r.y + r.ty * 0.3, true, r.structure)).toBe(walkingRise(whole, r.x + r.tx * 0.3, r.y + r.ty * 0.3, true, r.structure));
      expect(walkingRise(lazy, r.x, r.y, false, r.structure)).toBe(walkingRise(whole, r.x, r.y, false, r.structure));
    }
    const near = (net: Network): number[] => ramps.map((r) => rampsMeeting(net, [r.x - 1, r.y - 1, r.x + 1, r.y + 1]).size);
    const fresh = new Network(doc);
    fresh.rebuild();
    expect(near(fresh)).toEqual(near(whole));
  });
});
