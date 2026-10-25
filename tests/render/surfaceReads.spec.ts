import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { SceneMaterials } from '@render/materials';
import { buildRoadSurfaces } from '@render/roadSurfaces';
import { marksRoadSection } from '@render/mesh/roadEdges';

/** A stand-in material that reads every attribute a road surface may carry: the digests cover all of them. */
function readingAll(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ vertexColors: true });
  marksRoadSection(material);
  return material;
}

/** DO NOT update these digests to make a change pass: a different digest is a different road on screen. */
/** Set again for eight tiles a mesh (27029a71, `CHUNK` 4 -> 8): the meshes regrouped, every triangle of every surface the same as before, attribute for attribute (checked 2026-10-20). */
/** Set again for the roads built piece by piece as the owner's road tool builds them (`roads/pieceMesh.ts`): no verge, every corner curved, the
 *  paint drawn by the carriageway's shader, 500 m blocks from the origin. Each layout of the lab's catalogue looked at against the build before,
 *  on the optimisation sheets and drawn with the game's own materials and baked textures (2026-10-25). The mesh counts here are this stand-in
 *  material's (one material a surface): with the game's one road material the grid fixture draws 12 meshes where it drew 43. */
const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : readingAll(),
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

describe('road surface reads', () => {
  for (const [name, make, plain] of [
    ['the grid and bends fixture',
      () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document),
      '46 539df7eb07c5c6d4cb8ef3824c79452ba11d7ac2e6261ae791e01e23fc557127'],
    ['a generated city',
      () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small', radius: 640 })),
      '64 b982fcbf04692268006aa89848923bbcd4bc9a45a61317b23d50bcbb3b7108f5'],
  ] as const) it(`build ${name} byte for byte as before`, () => {
    const net = new Network(make());
    net.rebuild();
    const elevation = buildRoadElevation(net, ground);
    const own = buildRoadSurfaces(net, elevation, materials, ground);
    expect(bytesOf(own.group)).toBe(plain);
    // Built again, the same bytes (the verge drawn on the terrain's material, once the second digest here, went with the verge: the terrain meets
    // the footway's outer edge, `terrainSeams.ts`).
    const again = buildRoadSurfaces(net, elevation, materials, ground);
    expect(bytesOf(again.group)).toBe(bytesOf(own.group));
    // Remembered only while a tile is read: the same point asked afterwards is searched again, and agrees.
    expect(elevation.at(10.5, 20.25)).toBe(elevation.remembering!(() => elevation.at(10.5, 20.25)));
  });
});
