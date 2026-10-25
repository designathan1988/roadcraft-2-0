import { describe, expect, it } from 'vitest';

import cast from '@people/cast.json';
import { FORMER_BODY_IDS, normalizePerson } from '@people/spec';
import { RoadDoc } from '@world/doc';
import { isSerializedDoc } from '@editor/persistence';

const rowOf = (id: string): { id: string; wardrobe: string; ageBand: string; gender: string } => cast.find((c) => c.id === id)!;

describe('people saved with the city', () => {
  it('come back from a save exactly as they were', () => {
    const doc = new RoadDoc();
    doc.savePerson({ id: doc.nextPersonId(), name: 'Ana', mood: 0.4, model: cast[0]!.id });
    doc.savePerson({ id: doc.nextPersonId(), name: 'Bruno', model: cast[9]!.id });
    expect(doc.people.length).toBe(2);
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    expect(isSerializedDoc(json)).toBe(true);
    const back = RoadDoc.fromJSON(json);
    expect(back.people).toEqual(doc.people);
    expect(back.people[0]!.name).toBe('Ana');
  });

  it('leave a city without people serialised as before', () => {
    expect('people' in new RoadDoc().toJSON()).toBe(false);
  });

  it('are brought into range when read from outside, and junk is dropped', () => {
    const p = normalizePerson({ id: 3, name: 'x'.repeat(200), mood: 9, model: 'nobody', look: { skin: -5 } })!;
    expect(p.name.length).toBe(40);
    expect(p.mood).toBe(1);
    // A body outside the cast is not kept: the person is drawn as one of the cast.
    expect(cast.some((c) => c.id === p.model)).toBe(true);
    expect(Object.keys(p).sort()).toEqual(['id', 'model', 'mood', 'name']);
    expect(normalizePerson({ id: 'one' })).toBeNull();
    expect(normalizePerson(null)).toBeNull();
    expect(isSerializedDoc({ version: 1, nodes: [], segments: [], people: 'nobody' })).toBe(false);
  });

  it('saved with a former body id, open as that same body under its name now', () => {
    expect(Object.keys(FORMER_BODY_IDS)).toHaveLength(cast.length);
    expect(new Set(Object.values(FORMER_BODY_IDS))).toEqual(new Set(cast.map((c) => c.id)));
    for (const [former, now] of Object.entries(FORMER_BODY_IDS)) {
      expect(former).not.toBe(now);
      expect(normalizePerson({ id: 7, name: 'Old save', mood: 0.2, model: former })).toEqual({ id: 7, name: 'Old save', mood: 0.2, model: now });
    }
    // The body each former id named: its sex, age band and wardrobe (the cast's rows before the rename).
    expect(rowOf(normalizePerson({ id: 1, model: 'mh_08' })!.model)).toMatchObject({ gender: 'f', ageBand: 'child', wardrobe: 'sport-casual' });
    expect(rowOf(normalizePerson({ id: 2, model: 'mh_51' })!.model)).toMatchObject({ gender: 'm', ageBand: 'adult', wardrobe: 'business' });
    // A body id of today's cast is kept as it is; one no cast ever had falls back to the nearest body.
    expect(normalizePerson({ id: 3, model: cast[5]!.id })!.model).toBe(cast[5]!.id);
    expect(cast.some((c) => c.id === normalizePerson({ id: 4, model: 'mh_99' })!.model)).toBe(true);
  });

  it('saved with the old Person Creator sliders and garments, open as the body of the cast nearest them', () => {
    // The Person Creator's records: the sex and age sliders (age 0.5 is 25 years, 0.1875 is 11) and the outfit's name.
    const man = normalizePerson({ id: 1, name: 'Old save', body: { gender: 0.95, age: 0.62 }, look: { outfit: 'male_elegantsuit01', skin: 0xd9a47f } })!;
    expect(rowOf(man.model)).toMatchObject({ gender: 'm', ageBand: 'adult', wardrobe: 'business' });
    const girl = normalizePerson({ id: 2, name: 'Old save', body: { gender: 0.05, age: 0.1875 }, look: { outfit: 'female_sportsuit01' } })!;
    expect(rowOf(girl.model)).toMatchObject({ gender: 'f', ageBand: 'child', wardrobe: 'sport-casual' });
    const elder = normalizePerson({ id: 3, name: 'Old save', body: { gender: 0.1, age: 0.9 }, look: {} })!;
    expect(rowOf(elder.model)).toMatchObject({ gender: 'f', ageBand: 'senior' });
    // A save from before people carried any body opens too.
    expect(cast.some((c) => c.id === normalizePerson({ id: 4, name: 'Bare' })!.model)).toBe(true);
  });

  it('can be undone like any other edit', () => {
    const doc = new RoadDoc();
    const before = doc.clone();
    doc.savePerson({ id: 1, name: 'Ana', model: cast[0]!.id });
    expect(doc.peopleRevision).toBe(1);
    doc.replaceWith(before);
    expect(doc.people.length).toBe(0);
    expect(doc.peopleRevision).toBe(2);
  });

  it('are drawn from a cast of both sexes, every age band, children never in a suit', () => {
    for (const gender of ['f', 'm']) for (const band of ['child', 'young', 'adult', 'senior']) {
      expect(cast.some((c) => c.gender === gender && c.ageBand === band)).toBe(true);
    }
    expect(cast.filter((c) => c.ageBand === 'child').every((c) => c.wardrobe === 'casual' || c.wardrobe === 'sport-casual')).toBe(true);
  });
});
