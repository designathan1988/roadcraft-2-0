import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { PICTURE_WIND, createPlantImpostors, takeWaitingPictures } from '@render/plantImpostors';
import { ListeningCanvas, nullRenderer } from '../support/nullGpu';

/** A PICTURE SET AFTER A LOST CONTEXT (`plantImpostors.ts`, `contextRestored.ts`): taken once, and again once the context is back. */

describe('a picture set', () => {
  it('is taken once, and taken again after the context is restored', () => {
    const canvas = new ListeningCanvas(64, 64);
    const renderer = nullRenderer({ canvas: canvas as unknown as HTMLCanvasElement });
    let takes = 0;
    const init = renderer.initRenderTarget.bind(renderer);
    // A take makes its atlas's storage (`bake`: initRenderTarget before the pictures are copied onto it).
    renderer.initRenderTarget = (target) => { takes++; init(target); };
    const plants = createPlantImpostors([{ body: new BoxGeometry(1, 2, 1), cards: null, cardsCast: false }], PICTURE_WIND, 'scenery');
    takeWaitingPictures(renderer);
    expect(plants.ready()).toBe(true);
    expect(takes).toBe(1);
    takeWaitingPictures(renderer);
    expect(takes).toBe(1);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    takeWaitingPictures(renderer);
    expect(takes).toBe(2);
    plants.dispose();
    // Let go: a restore no longer asks it again.
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    takeWaitingPictures(renderer);
    expect(takes).toBe(2);
    renderer.dispose();
  });
});
