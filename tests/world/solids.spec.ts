import { describe, expect, it } from 'vitest';
import { createSolids, solidsOf } from '@world/solids';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import type { PoleId } from '@world/ids';

/** THE SOLIDS A BODY MEETS (`world/solids.ts`): worked out by cell as queries reach them, let go where the diary says */
const span = m(600);
const at = (rng: { float(): number }) => ({ x: rng.float() * span, y: rng.float() * span });
const pick = <T>(list: readonly T[], rng: { float(): number }): T | undefined => list[Math.floor(rng.float() * list.length)];
const random = (seed: number) => ({ s: seed, float() { this.s = (this.s * 16807) % 2147483647; return this.s / 2147483647; } });

const edits = [
  (doc: RoadDoc, rng: { float(): number }) => { doc.addPole(at(rng)); },
  (doc: RoadDoc, rng: { float(): number }) => { const id = pick([...doc.poles.keys()], rng); if (id !== undefined) doc.removePole(id as PoleId); },
  (doc: RoadDoc, rng: { float(): number }) => { doc.addLandscape(rng.float() < 0.5 ? 'bench' : 'lamp', at(rng)); },
  (doc: RoadDoc, rng: { float(): number }) => { const id = pick([...doc.landscape.keys()], rng); if (id !== undefined) doc.removeLandscape(id); },
  (doc: RoadDoc, rng: { float(): number }) => { const a = at(rng); doc.addBarrier('wall', [a, { x: a.x + m(12), y: a.y + m(3) }, { x: a.x + m(20), y: a.y - m(4) }]); },
  (doc: RoadDoc, rng: { float(): number }) => { const id = pick([...doc.barriers.keys()], rng); if (id !== undefined) doc.removeBarrier(id); },
];

const shape = (list: readonly { box: readonly number[] }[]): string[] => list.map((s) => s.box.join(',')).sort();

describe('the solids', () => {
  it('kept from the diary are the solids made from nothing, at every step', () => {
    const doc = new RoadDoc();
    const rng = random(0x501d);
    const kept = solidsOf(doc);
    for (let step = 0; step < 120; step++) {
      edits[Math.floor(rng.float() * edits.length)]!(doc, rng);
      solidsOf(doc);
      const fresh = createSolids();
      fresh.refresh(doc);
      for (let q = 0; q < 6; q++) {
        const p = at(rng);
        expect(shape(kept.near(p.x, p.y, m(20))), `step ${step} query ${q}`).toEqual(shape(fresh.solids.near(p.x, p.y, m(20))));
      }
    }
  });

  it('are looked up the same as the solids made from nothing', () => {
    const doc = new RoadDoc();
    const kept = solidsOf(doc);
    const rng = random(7);
    for (let i = 0; i < 200; i++) edits[i % edits.length]!(doc, rng);
    solidsOf(doc);
    const fresh = createSolids();
    fresh.refresh(doc);
    for (let i = 0; i < 100; i++) {
      const p = at(rng);
      expect(shape(kept.near(p.x, p.y, m(20))), `query ${i}`).toEqual(shape(fresh.solids.near(p.x, p.y, m(20))));
    }
  });

  /** A map of `count` poles 10 m apart, fifty to a row. */
  const poles = (count: number): RoadDoc => {
    const doc = new RoadDoc();
    for (let i = 0; i < count; i++) doc.addPole({ x: (i % 50) * m(10), y: Math.floor(i / 50) * m(10) });
    return doc;
  };

  it('works out only the cells a query reaches, however large the map (MISSION.md item 5)', () => {
    /** The same 100 poles round the query, and `far` more kilometres away. */
    const first = (far: number): { computes: number; cells: number } => {
      const doc = poles(100);
      for (let i = 0; i < far; i++) doc.addPole({ x: m(5000) + (i % 100) * m(10), y: Math.floor(i / 100) * m(10) });
      const solids = solidsOf(doc);
      solids.near(m(3), m(3), m(2));
      return { ...solids.work };
    };
    const small = first(0), large = first(5000);
    expect(small.computes).toBeGreaterThan(0);
    expect(large).toEqual(small);
  });

  it('works out again the items an edit touched near a query, however many there are', () => {
    const work = (count: number): number => {
      const doc = poles(count);
      const solids = solidsOf(doc);
      solids.near(m(3), m(3), m(2));
      const before = solids.work.computes;
      doc.addLandscape('bench', { x: m(3), y: m(3) });
      solidsOf(doc).near(m(3), m(3), m(2));
      return solids.work.computes - before;
    };
    expect(work(100)).toBe(1);
    expect(work(1600)).toBe(1);
  });
});
