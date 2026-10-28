import { describe, expect, it } from 'vitest';

import { createBuildingLayer } from '@render/buildings/layer';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { CELL } from '@world/cells';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** THE LEVELS MADE AHEAD OF THE VIEW (MISSION.md 3a, `massCells.ts` AHEAD): a far cell the view is about to bring near has its level made and
 *  kept hidden, so the frame it comes near draws that level, never its masses while the level is made. */

const flat = (): number => 0;
// 2,400 px a metre at a metre away: the masses' 1.5 m reach the 2 px of a near cell at 1,800 m, and 1.5 times their pixels now at 2,700 m.
const PX = 2400;
const EYE_Y = CELL / 2, EYE_Z = m(300);

/** One building in the tenth cell east of the origin: its masses span 1.6 px from an eye over the origin (far, 2.4 px at 1.5 times), 2 px from one at 500 m. */
function town(): RoadDoc {
  const doc = new RoadDoc();
  const bp = BLUEPRINTS[0]!;
  doc.buildings.add({ ...JSON.parse(JSON.stringify(bp.body)), x: 9 * CELL + CELL / 2, y: CELL / 2, rotation: 0 } as Omit<Building, 'id'>);
  return doc;
}

function frame(layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc, eyeX: number): void {
  layer.update(doc, flat, 'g');
  layer.levelOfDetail(eyeX, EYE_Y, EYE_Z, PX, null);
  layer.cullDetails(eyeX, EYE_Y, EYE_Z, PX, null, m(1));
}

describe('a far cell the view is about to bring near', () => {
  it('has its level made while it is far, hidden, and draws it the very frame it comes near', () => {
    const doc = town();
    const layer = createBuildingLayer();
    // Far, and settled: its masses stand for it, and no level of it is shown.
    for (let k = 0; k < 200; k++) frame(layer, doc, 0);
    expect(layer.pending).toBe(false);
    const far = layer.levels();
    expect(far.chosenFar).toBe(1);
    expect(far.shownNone).toBe(1);
    // The eye comes 500 m nearer: the cell comes near at its facade level, and it is drawn at once, nothing waited for.
    frame(layer, doc, m(500));
    const near = layer.levels();
    expect(near.chosenFacade).toBe(1);
    expect(near.shownFacade).toBe(1);
    expect(near.notLanded).toBe(0);
    // No cell of the view waits for its level (the choice itself is confirmed by the next frame, as after any move).
    expect(layer.viewPending).toBe(false);
    layer.dispose();
  });

  it('keeps its level only while it is ahead: let go once the view leaves it', () => {
    const doc = town();
    const layer = createBuildingLayer();
    for (let k = 0; k < 200; k++) frame(layer, doc, 0);
    // Ahead: its level resident, hidden.
    expect(layer.levels().shownNone).toBe(1);
    expect(layer.levels().residentBytes).toBeGreaterThan(0);
    // The eye goes 3 km west: no longer ahead, the level made for it let go.
    for (let k = 0; k < 50; k++) frame(layer, doc, -m(3000));
    expect(layer.levels().residentBytes).toBe(0);
    layer.dispose();
  });
});
