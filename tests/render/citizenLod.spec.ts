import { describe, expect, it } from 'vitest';
import { IMPOSTOR_PIXELS } from '@render/people/personImpostor';
import { LEVEL_TRIANGLES } from '@render/people/cookedPerson';
import { citizenBandAt, citizenLevelFor, citizenLevelOf, citizenLevelOfFigure } from '@render/riggedCitizens';
import { m, perM } from '@world/units';

/** The level a body is drawn at: by its own levels' errors (shares of its height, measured into its file) and its size on the screen. */

/** A body's levels as its file holds them: each coarser one a larger error. */
const ERRORS = [0.005, 0.025];

describe('the level a body is drawn at', () => {
  it('has one error per mesh level of the file, and the card past them', () => {
    expect(ERRORS.length).toBe(LEVEL_TRIANGLES.length);
    expect(citizenLevelOf(ERRORS, 1)).toBe(ERRORS.length);
  });

  it('is the coarsest whose error stays under a pixel, the card under a few pixels', () => {
    for (let pixels = 2; pixels < 4000; pixels *= 1.07) {
      const level = citizenLevelOf(ERRORS, pixels);
      if (pixels < IMPOSTOR_PIXELS) { expect(level).toBe(ERRORS.length); continue; }
      expect(level).toBeLessThan(ERRORS.length);
      if (level > 0) expect(ERRORS[level]! * pixels).toBeLessThanOrEqual(1);
      if (level < ERRORS.length - 1) expect(ERRORS[level + 1]! * pixels).toBeGreaterThan(1);
    }
  });

  it('of one figure is the level of the zoom that draws a body its size on the screen', () => {
    for (const ratio of [1, 1.5, 2]) for (let zoom = 0.1; zoom < 80; zoom *= 1.07) {
      expect(citizenLevelOfFigure(ERRORS, zoom * m(1.9) * ratio, ratio, zoom)).toBe(citizenLevelFor(ERRORS, zoom));
    }
  });

  it('of a figure far off in a view that shows faces is its own size\'s, the whole body only where it stands as tall as a face is drawn', () => {
    // A street view (40 px a metre at its point): the figures near it show their faces, those down the street are a few pixels tall.
    const zoom = perM(40);
    expect(citizenBandAt(zoom)).toBe(0);
    for (const ratio of [1, 2]) {
      for (let css = 1; css < 400; css *= 1.07) {
        const level = citizenLevelOfFigure(ERRORS, css * ratio, ratio, zoom);
        if (css >= m(1.9) * perM(20)) expect(level).toBe(0);
        else expect(level).toBe(citizenLevelOf(ERRORS, css));
      }
    }
    // Two pixels tall: its card, never its whole body (MISSION.md 3b).
    expect(citizenLevelOfFigure(ERRORS, 2, 1, zoom)).toBe(ERRORS.length);
  });

  it('never gets finer as the figure shrinks', () => {
    let last = 0;
    for (let pixels = 4000; pixels > 1; pixels /= 1.05) {
      const level = citizenLevelOf(ERRORS, pixels);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });

  it('keeps the whole body wherever the face is drawn', () => {
    for (let zoom = 0.1; zoom < 80; zoom *= 1.07) {
      if (citizenBandAt(zoom) === 0) expect(citizenLevelFor(ERRORS, zoom)).toBe(0);
      else expect(citizenLevelFor(ERRORS, zoom)).toBe(citizenLevelOf(ERRORS, m(1.9) * zoom));
    }
  });

  it('keeps what a body does at the zooms it always switched at', () => {
    // Pixels a metre: 75, 20 and 19.75, 5 and 4.75, 3 and 2.75.
    expect([75, 20, 19.75, 5, 4.75, 3, 2.75].map((pxPerM) => citizenBandAt(perM(pxPerM)))).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
});
