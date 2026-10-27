import { describe, expect, it } from 'vitest';

import { TableItems } from '@world/buildings/items';
import { encodeRecords } from '@world/buildings/recordTable';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { dataOf } from '@world/docBinary';
import type { LandscapeItem } from '@world/landscape';
import { m } from '@world/units';

/** THE STREET NAMES IN USE COUNTED OVER A MAP'S LANDSCAPING TABLE (`RoadDoc.countStreetNames`): from the rows' fields, no item decoded */

describe('the street names in use', () => {
  it('are counted from the table rows by their fields, the records written over it as themselves, none decoded', () => {
    const made = new RoadDoc();
    made.addLandscape('streetname', { x: m(10), y: 0 }, { text: 'Rua A' });
    made.addLandscape('streetname', { x: m(50), y: 0 }, { text: 'Rua A' });
    made.addLandscape('streetname', { x: m(90), y: 0 }, { text: 'Rua B' });
    made.addLandscape('bench', { x: m(20), y: m(5) });
    made.addLandscape('bin', { x: m(30), y: m(5) });
    const items = [...made.landscape.values()];
    const base = encodeRecords(items).buffer;
    const doc = RoadDoc.fromJSON(dataOf(made.image()) as unknown as SerializedDoc, {
      repair: false, sections: { landscape: { base, gone: new Float64Array(0), replaced: null, added: null } },
    });
    // A plate written over the table, and one added.
    doc.addLandscape('streetname', { x: m(130), y: 0 }, { text: 'Rua C' });
    const counts = Object.fromEntries(doc.streetNamesInUse);
    expect(counts).toEqual({ 'Rua A': 2, 'Rua B': 1, 'Rua C': 1 });
    const table = (doc.landscape as TableItems<number, LandscapeItem>).table!;
    expect(table.size).toBe(5);
    expect(table.held()).toBe(0);
  });
});
