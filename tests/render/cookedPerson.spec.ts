import { describe, expect, it } from 'vitest';
import { Matrix4, SkinnedMesh, Vector3, type BufferAttribute } from 'three';
import {
  assemblePerson, decodeCookedPerson, lookByte, packCookedPerson, readCookedHeader, VERTEX_LAYOUT, type CookedInput,
} from '@render/people/cookedPerson';
import { REGION_HAIR, REGION_SKIN } from '@render/people/personMaterial';

/** A PERSON COOKED AHEAD AND READ BACK (`cookedPerson.ts`): the file the cook writes is the body the game assembles. */

/** A tiny body: a root, an armature with two bones, one skinned quad in a 2 m box about (0, 1, 0), two levels and one expression. */
function tinyPerson(): CookedInput {
  const scale = 1, offset = [0, 1, 0] as const;
  const q = (metres: number, c: number): number => Math.round(((metres - offset[c]!) / scale) * 32767);
  const position = Int16Array.from([q(-0.5, 0), q(0, 1), q(0, 2), q(0.5, 0), q(0, 1), q(0, 2), q(0.5, 0), q(2, 1), q(0, 2), q(-0.5, 0), q(2, 1), q(0, 2)]);
  const normal = Int8Array.from([0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0]);
  const colour = Uint8Array.from([255, 255, 255, lookByte(REGION_SKIN, 0.5), 255, 255, 255, lookByte(REGION_SKIN, 0.5), 10, 20, 30, lookByte(REGION_HAIR, 0.42), 10, 20, 30, lookByte(REGION_HAIR, 0.42)]);
  const uv = Uint16Array.from([0, 0, 65535, 0, 65535, 65535, 0, 65535]);
  const joints = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const weights = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 200, 55, 0, 0, 255, 0, 0, 0]);
  const bind = new Matrix4().makeTranslation(0, 1, 0);
  return {
    id: 'tiny', height: 2,
    nodes: [
      { name: 'root', kind: 'group', parent: -1, p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] },
      { name: 'Armature', kind: 'group', parent: 0, p: [0, 0, 0], q: [0, 0, 0, 1], s: [0.01, 0.01, 0.01] },
      { name: 'pelvis', kind: 'bone', parent: 1, p: [0, 100, 0], q: [0, 0, 0, 1], s: [1, 1, 1] },
      { name: 'head', kind: 'bone', parent: 2, p: [0, 80, 0], q: [0, 0, 0, 1], s: [1, 1, 1] },
      { name: 'person', kind: 'skinned', parent: 0, p: [...offset], q: [0, 0, 0, 1], s: [scale, scale, scale] },
    ],
    mesh: {
      node: 4, vertexCount: 4, quant: { scale, offset: [...offset] },
      attributes: [position, normal, colour, uv, joints, weights],
      index: Uint16Array.from([0, 1, 2, 0, 2, 3, 0, 1, 2]),
      levels: [{ start: 0, count: 6, error: 0.002 }, { start: 6, count: 3, error: 0.1 }],
      morphs: [{ name: 'smile', vertices: Uint16Array.from([2]), deltas: Int16Array.from([0, 328, 0]) }],
      dictionary: { smile: 0 },
      bones: [2, 3], inverses: [...new Matrix4().elements, ...new Matrix4().makeTranslation(0, -1.8, 0).elements],
      bind: [...bind.elements], bindMode: 'attached',
      faceOrigin: [0, 0.8, 0], faceScale: 0.2, alphaTest: 0.35,
      impostor: { frames: 8, x: 768, y: 512, width: 32, height: 64 },
    },
    atlas: { file: 'tiny.ktx2', size: 1024, codec: 'rgba8' },
  };
}

describe('a person cooked ahead and read back', () => {
  it('writes the header and every array in the vertex layout, refusing a layout that is not the file\'s', () => {
    const input = tinyPerson();
    const bin = packCookedPerson(input);
    const header = readCookedHeader(bin);
    expect(header.version).toBe(3);
    expect(header.id).toBe('tiny');
    expect(header.mesh.attributes.map((a) => a.kind)).toEqual(VERTEX_LAYOUT.map((l) => l.kind));
    expect(header.mesh.levels).toEqual(input.mesh.levels);
    expect(header.atlas).toEqual(input.atlas);
    expect(() => packCookedPerson({ ...input, mesh: { ...input.mesh, attributes: input.mesh.attributes.slice(1) } })).toThrow(/attributes/);
    expect(() => packCookedPerson({ ...input, mesh: { ...input.mesh, attributes: [new Float32Array(12), ...input.mesh.attributes.slice(1)] } })).toThrow(/position is f32/);
  });

  it('is read in a worker and put together on the page: every array it keeps moved, the morph made whole, the bounds widened by it', () => {
    const input = tinyPerson();
    const { person, transfer } = decodeCookedPerson(packCookedPerson(input));
    const moved = new Set(transfer);
    for (const array of [...person.attributes, person.index, ...person.morphs]) expect(moved.has(array.buffer as ArrayBuffer)).toBe(true);
    expect(moved.size).toBe(person.attributes.length + 1 + person.morphs.length);
    expect(Array.from(person.attributes[0]!)).toEqual(Array.from(input.mesh.attributes[0]!));
    expect(Array.from(person.index)).toEqual(Array.from(input.mesh.index));
    // The sparse move at vertex 2 is dense now: 328 quantised units of y, nothing else.
    const smile = person.morphs[0]!;
    expect(smile.length).toBe(12);
    expect(Array.from(smile)).toEqual([0, 0, 0, 0, 0, 0, 0, 328, 0, 0, 0, 0]);
    // The box is the vertices' (-0.5..0.5 of the quantised frame in x, 0..1 in y) grown where a vertex moves: vertex 2, at (0.5, 1), by 328 / 32767.
    const reach = 328 / 32767;
    expect(person.bounds[0]).toBeCloseTo(-0.5, 4);
    expect(person.bounds[3]).toBeCloseTo(0.5 + reach, 4);
    expect(person.bounds[4]).toBeCloseTo(1 + reach, 4);
    expect(person.bounds[9]).toBeGreaterThan(Math.hypot(0.5, 0.5));
  });

  it('assembles the body in its quantised frame, dequantised by its node, its levels on the geometry and its skeleton bound', () => {
    const input = tinyPerson();
    const scene = assemblePerson(decodeCookedPerson(packCookedPerson(input)).person);
    let mesh: SkinnedMesh | undefined;
    scene.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
    expect(mesh).toBeDefined();
    expect(mesh!.position.toArray()).toEqual([0, 1, 0]);
    expect(mesh!.scale.toArray()).toEqual([1, 1, 1]);
    const g = mesh!.geometry;
    expect(Object.keys(g.attributes).sort()).toEqual(VERTEX_LAYOUT.map((l) => l.name).sort());
    // Positions as the shader reads them: normalised shorts, metres once the node's matrix is applied.
    const position = g.getAttribute('position') as BufferAttribute;
    expect(position.normalized).toBe(true);
    expect(position.getX(0)).toBeCloseTo(-0.5, 3);
    mesh!.updateMatrixWorld(true);
    expect(new Vector3(position.getX(2), position.getY(2), position.getZ(2)).applyMatrix4(mesh!.matrixWorld).y).toBeCloseTo(2, 3);
    const levels = g.userData['levels'] as BufferAttribute[];
    expect(levels.map((l) => l.count)).toEqual([6, 3]);
    expect(g.userData['levelErrors']).toEqual([0.002, 0.1]);
    expect(g.index!.count).toBe(6);
    expect(g.morphTargetsRelative).toBe(true);
    expect(g.morphAttributes['position']![0]!.name).toBe('smile');
    expect(mesh!.morphTargetDictionary).toEqual({ smile: 0 });
    expect(mesh!.skeleton.bones.map((b) => b.name)).toEqual(['pelvis', 'head']);
    expect(mesh!.skeleton.boneInverses[1]!.elements[13]).toBe(-1.8);
    expect(mesh!.bindMatrix.elements).toEqual(input.mesh.bind);
    expect(g.boundingBox).not.toBeNull();
    expect(g.boundingSphere!.radius).toBeGreaterThan(0.5);
  });

  it('packs a vertex\'s region and roughness in one byte, as the shader unpacks them', () => {
    const region = (byte: number): number => Math.floor((byte / 255) * 255 / 64 + 0.5 / 64);
    const roughness = (byte: number): number => (((byte / 255) * 255 + 0.5) % 64) / 63;
    for (const r of [0, 1, 2, 3] as const) for (const rough of [0, 0.06, 0.42, 0.5, 0.82, 0.9, 1]) {
      const byte = lookByte(r, rough);
      expect(region(byte)).toBe(r);
      expect(Math.abs(roughness(byte) - rough)).toBeLessThanOrEqual(1 / 63 + 1e-9);
    }
  });
});
