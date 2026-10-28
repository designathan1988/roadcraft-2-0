import { BoxGeometry, type DataTexture, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, type Camera, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { GpuBatchedMesh } from '@render/buildings/gpuBatchedMesh';

/** THE BATCHES' DRAW LISTS AND STORAGE (MISSION 1d): each camera keeps its own multi-draw list, listed and sent again only when the batch
 *  or its view changed; a geometry added goes into the room a deleted one left. No WebGL context here: the batch keeps three's arrays,
 *  and its listing is three's own (r186 `BatchedMesh.onBeforeRender`). */

/** three's draw list as the renderer reads it right after `onBeforeRender` (WebGLRenderer setProgram and renderBufferDirect). */
type Listed = { _indirectTexture: DataTexture; _multiDrawCount: number };

const renderer = {} as WebGLRenderer;

function batchOf(instances: number, maxVertices: number, maxIndices: number): GpuBatchedMesh {
  const mesh = new GpuBatchedMesh(instances, maxVertices, maxIndices, new MeshBasicMaterial());
  mesh.updateMatrixWorld();
  return mesh;
}

/** The batch listed for `camera` as a pass draws it: the texture the draw reads, its version (each version an upload) and the draws. */
function draw(mesh: GpuBatchedMesh, camera: Camera): { texture: DataTexture; version: number; count: number } {
  mesh.onBeforeRender(renderer, null, camera, mesh.geometry, mesh.material as MeshBasicMaterial, null);
  const listed = mesh as unknown as Listed;
  return { texture: listed._indirectTexture, version: listed._indirectTexture.version, count: listed._multiDrawCount };
}

describe('GpuBatchedMesh draw lists', () => {
  it('lists each camera once and sends nothing again while neither the batch nor the view changes', () => {
    const mesh = batchOf(8, 64, 128);
    const box = new BoxGeometry();
    const id = mesh.addGeometry(box);
    mesh.addInstance(id);
    const second = mesh.addInstance(id);
    const eye = new PerspectiveCamera(50, 1, 0.1, 100);
    eye.position.set(0, 0, 5);
    eye.updateMatrixWorld();
    const sun = new OrthographicCamera(-5, 5, 5, -5, 0.1, 50);
    sun.position.set(0, 10, 0);
    sun.lookAt(0, 0, 0);
    sun.updateMatrixWorld();

    const eyeFirst = draw(mesh, eye);
    const sunFirst = draw(mesh, sun);
    expect(eyeFirst.count).toBe(2);
    expect(sunFirst.count).toBe(2);
    expect(sunFirst.texture).not.toBe(eyeFirst.texture);
    // The colour pass and a cascade, frame after frame: the same lists drawn, no texture sent again.
    for (let frame = 0; frame < 3; frame++) {
      const e = draw(mesh, eye), s = draw(mesh, sun);
      expect(e.texture).toBe(eyeFirst.texture);
      expect(e.version).toBe(eyeFirst.version);
      expect(e.count).toBe(2);
      expect(s.texture).toBe(sunFirst.texture);
      expect(s.version).toBe(sunFirst.version);
    }

    // An instance hidden: every camera's list made again, once.
    mesh.setVisibleAt(second, false);
    const hidden = draw(mesh, eye);
    expect(hidden.count).toBe(1);
    expect(hidden.version).toBeGreaterThan(eyeFirst.version);
    expect(draw(mesh, sun).count).toBe(1);
    expect(draw(mesh, eye).version).toBe(hidden.version);

    // The camera moved: its list made again; the cascade's stands.
    const sunBefore = draw(mesh, sun).version;
    eye.position.set(0, 0, 6);
    eye.updateMatrixWorld();
    expect(draw(mesh, eye).version).toBeGreaterThan(hidden.version);
    expect(draw(mesh, sun).version).toBe(sunBefore);

    // Turned away: listed again, nothing drawn.
    eye.position.set(0, 0, 500);
    eye.lookAt(0, 0, 1000);
    eye.updateMatrixWorld();
    expect(draw(mesh, eye).count).toBe(0);
    mesh.dispose();
    box.dispose();
  });

  it('puts a geometry into the room a deleted one left, without growing', () => {
    const box = new BoxGeometry();
    const vertices = box.getAttribute('position').count, indices = box.getIndex()!.count;
    // Room for three boxes exactly.
    const mesh = batchOf(8, vertices * 3, indices * 3);
    const ids = [mesh.addGeometry(box), mesh.addGeometry(box), mesh.addGeometry(box)];
    for (const id of ids) mesh.addInstance(id);
    expect(mesh.unusedVertexCount).toBe(0);
    expect(mesh.fits(vertices, indices)).toBe(false);

    mesh.deleteGeometry(ids[1]!);
    expect(mesh.fits(vertices, indices)).toBe(true);
    const again = mesh.addGeometry(box);
    const range = mesh.getGeometryRangeAt(again)!;
    expect(range.vertexStart).toBe(vertices);
    expect(range.indexStart).toBe(indices);
    expect(mesh.unusedVertexCount).toBe(0);
    expect(mesh.fits(vertices, indices)).toBe(false);

    // Two neighbours let go: one room of both, taken by a geometry reserving both.
    mesh.deleteGeometry(ids[0]!);
    mesh.deleteGeometry(again);
    expect(mesh.fits(vertices * 2, indices * 2)).toBe(true);
    const both = mesh.addGeometry(box, vertices * 2, indices * 2);
    expect(mesh.getGeometryRangeAt(both)!.vertexStart).toBe(0);
    mesh.addInstance(both);
    const eye = new PerspectiveCamera(50, 1, 0.1, 100);
    eye.position.set(0, 0, 5);
    eye.updateMatrixWorld();
    // Drawn: the box in the room it took and the last one standing.
    expect(draw(mesh, eye).count).toBe(2);
    mesh.dispose();
    box.dispose();
  });
});
