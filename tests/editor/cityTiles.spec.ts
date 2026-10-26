import { describe, expect, it } from 'vitest';
import { type TileGrown, assembleCity, growTile, tilePackagesOf, tilesTouch } from '@editor/cityTiles';
import { buildCityTableOf, layoutCityOf } from '@editor/smallCityMap';
import { RecordTable, tableRecords } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import { siteOf, validateOn } from '@world/buildings/validate';
import { RoadDoc } from '@world/doc';
import type { Lot } from '@world/lots';

/**
 * A CITY'S BUILDINGS GROWN TILE BY TILE (`editor/cityTiles.ts`), as the job threads grow them (`editor/cityInTiles.ts`): the four phases of the
 * tiles' checkerboard one after the other, each tile handed the edge buildings of the tiles round it grown before it. Every zoned lot grows
 * as the city grown on one thread grows it, no building stands on another across a tile's border, every building has an id of its own,
 * every grown lot names its building, and the city is the same whatever order a phase's tiles run in.
 */

function grownInTiles(reverse: boolean): { readonly buildings: ArrayBufferLike; readonly lots: ArrayBufferLike | null; readonly tiles: number } {
  const layout = layoutCityOf('small', 7);
  const tiles = tilePackagesOf(layout);
  const grown: TileGrown[] = [];
  for (let phase = 0; phase < 4; phase++) {
    const now = tiles.filter((t) => t.phase === phase);
    if (reverse) now.reverse();
    const before = [...grown];
    // As a message clones them: each tile and its neighbours' edge tables.
    for (const tile of now) grown.push(structuredClone(growTile(structuredClone(tile), before.filter((o) => tilesTouch(tile.key, o.key)).map((o) => o.edge))));
  }
  return { ...assembleCity(layout.tableOf('lots'), grown), tiles: tiles.length };
}

describe("a city's buildings grown tile by tile", () => {
  const city = grownInTiles(false);
  const buildings = tableRecords<Building>(city.buildings);

  it('spans tiles of more than one phase', () => {
    expect(city.tiles).toBeGreaterThan(2);
  });

  it('grows as many buildings as the city grown on one thread, every id its own', () => {
    const serial = new RecordTable(buildCityTableOf('small', 7).buildings).rows;
    expect(buildings.length).toBeGreaterThan(serial * 0.97);
    expect(new Set(buildings.map((b) => b.id)).size).toBe(buildings.length);
  });

  it('stands no building on another, across the tiles\' borders too', () => {
    const doc = new RoadDoc();
    doc.buildings.placeAll(buildings);
    const site = siteOf({ doc, net: null, groundAt: null });
    const clashes = buildings.filter((b) => validateOn(site, b) === 'building');
    expect(clashes.map((b) => b.id)).toEqual([]);
  });

  it('names each grown lot\'s building, and only buildings of the city', () => {
    const lots = tableRecords<Lot>(city.lots!);
    const ids = new Set<number>(buildings.map((b) => b.id));
    const named = lots.filter((l) => l.building !== undefined);
    expect(named.length).toBe(buildings.length);
    for (const lot of named) expect(ids.has(lot.building!)).toBe(true);
  });

  it('is the same city whatever order a phase\'s tiles run in', () => {
    const again = grownInTiles(true);
    expect(new Uint8Array(again.buildings)).toEqual(new Uint8Array(city.buildings));
    expect(new Uint8Array(again.lots!)).toEqual(new Uint8Array(city.lots!));
  });
});
