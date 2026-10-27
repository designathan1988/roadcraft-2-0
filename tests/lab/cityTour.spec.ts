import { describe, expect, it } from 'vitest';
import { tourStops } from '@/lab/doctor/tour';

describe('the city tour', () => {
  it('stops over the whole city: the whole map twice, nine districts, five streets seen low, the edge, every one inside the bounds', () => {
    const b = { minX: -5000, minY: -4000, maxX: 5000, maxY: 6000, fitZoom: 0.09 };
    const stops = tourStops(b, 0.3, 0.9);
    expect(stops).toHaveLength(17);
    expect(stops.filter((s) => s.label.startsWith('district'))).toHaveLength(9);
    expect(stops.filter((s) => s.label.startsWith('street')).every((s) => s.zoom === 28 && s.elevation < 0.9)).toBe(true);
    expect(stops[0]!.zoom).toBe(0.09);
    for (const s of stops) {
      expect(s.x).toBeGreaterThanOrEqual(b.minX);
      expect(s.x).toBeLessThanOrEqual(b.maxX);
      expect(s.y).toBeGreaterThanOrEqual(b.minY);
      expect(s.y).toBeLessThanOrEqual(b.maxY);
    }
    // Turned: not every stop looks the same way.
    expect(new Set(stops.map((s) => s.azimuth.toFixed(2))).size).toBeGreaterThan(3);
  });
});
