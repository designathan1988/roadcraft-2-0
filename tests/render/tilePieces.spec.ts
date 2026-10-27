import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import type { SceneMaterials } from '@render/materials';
import { type RoadElevation, buildRoadElevation as solve } from '@world/elevation';
import { buildRoadSurfaces, roadSurfaceSteps, type RoadSurfaces, type SurfaceReuse, type TileBundle } from '@render/roadSurfaces';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { marksRoadSection } from '@render/mesh/roadEdges';
import { roadPaint } from '@render/roadPaint';

/** A ROAD TILE KEPT IN ONE SESSION AND READ IN ANOTHER (`mesh/tilePieces.ts`): found by its key whatever order the other counted its slots in, and
 *  drawn there as that session would make it */

/** A stand-in material that reads every attribute a road surface may carry: the bytes cover all of them. */
function readingAll(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ vertexColors: true });
  marksRoadSection(material);
  return material;
}
const stable = new Map<PropertyKey, unknown>();
const materials = new Proxy({}, {
  get: (_target, key) => {
    if (key === 'scale') return new Proxy({}, { get: () => 4 });
    if (!stable.has(key)) stable.set(key, readingAll());
    return stable.get(key);
  },
}) as unknown as SceneMaterials;
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

function bytesOf(root: Object3D): string {
  const hash = createHash('sha256');
  let meshes = 0;
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    meshes++;
    hash.update(object.name);
    for (const name of ['position', 'normal', 'uv', 'color', 'roadSection']) {
      const array = geometry.getAttribute(name).array as Float32Array;
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const index = geometry.getIndex()!.array as Uint32Array;
    hash.update(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
  });
  return `${meshes} ${hash.digest('hex')}`;
}

/** A build stepped through as the renderer runs it, the store's reads answered in a later task. */
async function stepped(net: Network, elevation: RoadElevation, reuse?: SurfaceReuse): Promise<RoadSurfaces> {
  const steps = roadSurfaceSteps(net, elevation, materials, ground, reuse);
  for (;;) {
    const step = steps.next();
    if (step.done) { step.value.adopt(); return step.value; }
    if (step.value === 'wait') await new Promise((done) => setTimeout(done, 0));
  }
}

const fixture = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);

describe('road tiles kept between sessions', () => {
  it('are found again by a session that counted its slots in another order, and drawn as that session makes them', async () => {
    /** The store between the sessions, each value cloned as IndexedDB clones it. */
    const store = new Map<string, TileBundle>();
    const session = (doc: RoadDoc): { net: Network; reuse: SurfaceReuse } => {
      const net = new Network(doc);
      net.rebuild();
      const elevation = solve(net, ground);
      const reuse: SurfaceReuse = {
        tiles: new Map(),
        dependsOn: (minX, minY, maxX, maxY) => elevation.digest(minX, minY, maxX, maxY),
        chunks: new Map(),
        inputs: new SurfaceInputs(),
        stored: {
          has: (key) => store.has(key),
          fetch: (keys) => Promise.resolve(new Map(keys.filter((key) => store.has(key)).map((key) => [key, structuredClone(store.get(key)!)] as const))),
        },
        keep: (key, bundle) => { store.set(key, structuredClone(bundle)); },
      };
      return { net, reuse };
    };

    // The first session: every tile made and kept, its slots counted out as its build first asked them.
    const first = session(fixture());
    const made = await stepped(first.net, solve(first.net, ground), first.reuse);
    expect(made.built).toBeGreaterThan(20);
    expect(store.size).toBe(made.built);
    made.dispose();

    // Another session of the same map: a document of its own, its slots counted out first in the reverse order of its ids.
    const doc = fixture();
    for (const id of [...doc.segments.keys()].sort((p, q) => q - p)) roadPaint.roadSlot(doc, id as SegmentId);
    for (const id of [...doc.nodes.keys()].sort((p, q) => q - p)) roadPaint.nodeSlot(doc, id as NodeId);
    const second = session(doc);
    const elevation = solve(second.net, ground);
    const warm = await stepped(second.net, elevation, second.reuse);
    const fresh = buildRoadSurfaces(second.net, elevation, materials, ground);
    // Every tile found in the store, none made again, and the same bytes as the session makes them itself - its own slots in every vertex.
    expect(warm.built).toBe(0);
    expect(warm.reused).toBe(made.built);
    expect(bytesOf(warm.group)).toBe(bytesOf(fresh.group));
    warm.dispose();
    fresh.dispose();
  });
});
