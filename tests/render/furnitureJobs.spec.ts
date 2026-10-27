import { describe, expect, it } from 'vitest';

import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { snapLandscape, type LandscapeKind } from '@world/landscape';
import { m } from '@world/units';
import type { Pack } from '@render/cellInstances';
import { serve as serveFurniture, type FurnitureCellReply } from '@render/furnitureCell.worker';
import { unpackPlaces } from '@render/furniturePlace';
import { createSceneryKit } from '@render/scenery';
import { sceneryPictures } from '@render/plantImpostors';
import { type FurnitureSource, furnitureAbout, furnitureAskOf, furnitureStores, placementOf, propLadder } from '@render/streetFurnitureLayer';

/** THE STREET FURNITURE PLACED OFF THE PAGE (`furnitureCell.worker.ts`): with the roads round it solved in the job, the same things as placed on the page */

const span = m(500);
const kit = createSceneryKit();
const KINDS: readonly LandscapeKind[] = ['lamp', 'bench', 'bin', 'tree', 'shrub', 'hydrant', 'postbox', 'phone', 'drain', 'meadow'];

/** A town of crossing roads, its items put where the tool puts them (on a footway), its network and heights as the renderer keeps them. */
function town(): FurnitureSource {
  const doc = new RoadDoc();
  const rng = new Rng(7);
  for (let i = 0; i < 8; i++) {
    const a = doc.addNode({ x: rng.float() * span, y: rng.float() * span });
    const b = doc.addNode({ x: a.x + (rng.float() - 0.5) * m(220), y: a.y + (rng.float() - 0.5) * m(220) });
    doc.addSegment(a.id, b.id, 1 + Math.floor(rng.float() * 3));
  }
  const net = new Network(doc);
  net.rebuild();
  for (let i = 0; i < 160; i++) {
    const kind = KINDS[Math.floor(rng.float() * KINDS.length)]!;
    const at = { x: rng.float() * span, y: rng.float() * span };
    const snap = snapLandscape(net, doc.landscape.values(), kind, at, m(30));
    doc.addLandscape(kind, snap.ok ? snap.at : at, rng.float() < 0.3 ? { planted: Math.floor(rng.float() * 2000) } : {});
  }
  return { changes: doc.changes, net, elevation: buildRoadElevation(net, () => 0), groundAt: () => 0 };
}

/** Each kind's instances as text, sorted: what the runs draw, whatever the order they were placed in. */
const rowsOf = (packs: ReadonlyMap<number, Pack>): Record<number, string[]> => Object.fromEntries([...packs].map(([kind, p]) => {
  const rows: string[] = [];
  for (let i = 0; i < p.count; i++) rows.push([...p.data.subarray(i * 8, i * 8 + 8), ...(p.colours ? p.colours.subarray(i * 3, i * 3 + 3) : [])].join(','));
  return [kind, rows.sort()];
}));

describe('the street furniture placed off the page', () => {
  it('places what the page places, its roads solved in the job', () => {
    const source = town();
    const ladder = propLadder(kit);
    const stores = furnitureStores(kit, sceneryPictures(kit), ladder);
    const now = 1500;
    for (const rect of [[0, 0, span, span], [m(120), m(80), m(260), m(300)]] as const) {
      const onPage = furnitureAbout(source, stores, kit.lens, now, rect);
      // As a thread of the page and as a job process's (every item copied): the same.
      for (const shared of [true, false]) {
        const ask = furnitureAskOf(source, rect, kit.lens, true, null, undefined, shared)!;
        let reply: FurnitureCellReply | null = null;
        const scope = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (message: unknown) => { reply = message as FurnitureCellReply; } };
        serveFurniture(scope);
        scope.onmessage!({ data: ask.data } as MessageEvent);
        const answer = reply as FurnitureCellReply | null;
        if (!answer || 'error' in answer) throw new Error(answer ? answer.error : 'no answer');
        const offPage = placementOf(unpackPlaces(answer.places), stores, now);
        expect(offPage.growing).toBe(onPage.growing);
        const page = rowsOf(onPage.packs);
        expect(Object.values(page).flat().length).toBeGreaterThan(10);
        expect(rowsOf(offPage.packs)).toEqual(page);
      }
    }
  });
});
