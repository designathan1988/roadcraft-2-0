import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, PerspectiveCamera } from 'three';
import { cellDiagonal } from '@world/groundPatch';
import { LandLevels } from '@render/terrainLevels';
import { LandLod } from '@render/terrainLod';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_SEGMENTS } from '@render/terrainGrid';

/** A PLATE'S PATCHES CHOSEN AGAIN ONLY WHEN THE VIEW OR THE LAND CHANGED (MISSION 2e): every shown plate is asked at every frame; a still camera
 *  over still land walks no patch tree, and keeps the patches it had; a moved camera or land measured again is selected anew. */

const seg = TERRAIN_SEGMENTS, n = seg + 1;

afterEach(() => vi.restoreAllMocks());

describe('the patches of a still view', () => {
  it('are not chosen again until the camera, the screen or the levels move', () => {
    const heights = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[i + j * n] = 20 * Math.sin(i * 0.011) * Math.cos(j * 0.009);
    const flip = new Uint8Array(seg * seg);
    for (let cy = 0; cy < seg; cy++) for (let cx = 0; cx < seg; cx++) {
      flip[cx + cy * seg] = cellDiagonal(heights[cx + cy * n]!, heights[cx + (cy + 1) * n]!, heights[cx + 1 + (cy + 1) * n]!, heights[cx + 1 + cy * n]!);
    }
    const levels = new LandLevels(seg);
    levels.markAll();
    levels.measure(heights, flip);
    const lod = new LandLod(levels, { seg, cell: TERRAIN_CELL, half: TERRAIN_HALF }, { x: 0, y: 0 }, { west: true, east: true, north: true, south: true });
    const camera = new PerspectiveCamera(50, 16 / 9, 1, 100_000);
    camera.position.set(0, 300, 600);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const first = lod.select(camera, 1080);
    expect(first).toBeGreaterThan(0);
    const patches = Array.from(lod.geometry.getAttribute('aLodPatch').array as Float32Array);
    // The nodes' boxes measured against the eye: none while the view stands.
    const boxes = vi.spyOn(Box3.prototype, 'distanceToPoint');
    for (let frame = 0; frame < 30; frame++) expect(lod.select(camera, 1080)).toBe(first);
    expect(boxes).not.toHaveBeenCalled();
    expect(lod.geometry.instanceCount).toBe(first);
    expect(Array.from(lod.geometry.getAttribute('aLodPatch').array as Float32Array)).toEqual(patches);
    // The land measured again: chosen anew.
    levels.markAll();
    levels.measure(heights, flip);
    lod.select(camera, 1080);
    expect(boxes).toHaveBeenCalled();
    boxes.mockClear();
    // The camera moved: chosen anew, the patches it asks.
    camera.position.set(400, 120, 200);
    camera.lookAt(400, 0, 0);
    camera.updateMatrixWorld();
    lod.select(camera, 1080);
    expect(boxes).toHaveBeenCalled();
    boxes.mockClear();
    // Another screen height: chosen anew.
    lod.select(camera, 720);
    expect(boxes).toHaveBeenCalled();
  });
});
