import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { DEFAULT_WEATHER, readWeather, windVector } from '@world/weather';

describe('the map’s weather', () => {
  it('is kept in the map, in range, and moves its revision only on a change', () => {
    const doc = new RoadDoc();
    const before = doc.weatherRevision;
    doc.setWeather({ rain: 0 });
    expect(doc.weatherRevision).toBe(before);
    doc.setWeather({ rain: 2, wind: 12, windDirection: 400, lightning: 6 });
    expect(doc.weather).toMatchObject({ rain: 1, wind: 12, windDirection: 0, lightning: 6 });
    const loaded = RoadDoc.fromJSON(doc.toJSON());
    expect(loaded.weather).toEqual(doc.weather);
    expect(RoadDoc.fromJSON(new RoadDoc().toJSON()).weather).toEqual(DEFAULT_WEATHER);
    expect(readWeather({ wind: -3 }).wind).toBe(0);
  });

  it('blows the way it is set', () => {
    const east = windVector({ ...DEFAULT_WEATHER, wind: 10, windDirection: 0 }, 2);
    expect(east.x).toBeCloseTo(20);
    expect(east.y).toBeCloseTo(0);
  });
});
