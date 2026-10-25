import { describe, expect, it } from 'vitest';
import { BoxGeometry, Float32BufferAttribute, InstancedMesh, MeshBasicMaterial, type Camera, type Group, type Scene, type WebGLRenderer } from 'three';
import { dropFaceShapesOnceDrawn, keepPartOnGpu, partArrays } from '@render/riggedCitizens';
import { countMemory } from '@render/memoryCounters';
import { BufferAttribute as Attribute, Group as Holder, InstancedBufferAttribute } from 'three';

/** The people's memory on the page: a cooked body's face shapes let go once three holds its own, its vertices once on the GPU */

describe("the people's memory", () => {
  it("lets a cooked body's face shapes go after its first draw, keeping whatever ran after a draw", () => {
    const geometry = new BoxGeometry();
    const count = geometry.getAttribute('position').count;
    geometry.morphAttributes['position'] = [new Float32BufferAttribute(new Float32Array(count * 3), 3), new Float32BufferAttribute(new Float32Array(count * 3), 3)];
    const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), 1);
    let after = 0;
    mesh.onAfterRender = () => { after++; };
    dropFaceShapesOnceDrawn(mesh);
    expect(geometry.morphAttributes['position']!.every((a) => a.array.length === count * 3)).toBe(true);
    const draw = (): void => mesh.onAfterRender({} as WebGLRenderer, {} as Scene, {} as Camera, geometry, mesh.material, {} as Group);
    draw();
    expect(geometry.morphAttributes['position']!.every((a) => a.array.length === 0)).toBe(true);
    // The shapes' number, which three's morph texture is kept by, the same.
    expect(geometry.morphAttributes['position']!.length).toBe(2);
    draw();
    expect(after).toBe(2);
  });

  it("lets a cooked body's vertices go once on the GPU, keeps the rows rewritten each frame, and reads them back for a restored context", async () => {
    const geometry = new BoxGeometry(1, 1, 1, 8, 8, 8);
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new Attribute(new Uint16Array(count * 4), 4));
    const coarse = new Attribute(new Uint32Array([0, 1, 2]), 1);
    const own = partArrays(geometry, [coarse]);
    // The figures' rows come after (`load`): not in what is let go.
    const rows = new InstancedBufferAttribute(new Float32Array(16), 1);
    geometry.setAttribute('citizenRow', rows);
    const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), 1);
    const holder = new Holder().add(mesh);
    const before = countMemory(holder).geometryCpuBytes;
    const positions = Array.from(geometry.getAttribute('position').array as Float32Array);
    let asked = 0;
    keepPartOnGpu(mesh, own, async () => { asked++; return { position: Float32Array.from(positions), normal: new Float32Array(count * 3), uv: new Float32Array(count * 2), skinIndex: new Uint16Array(count * 4), index: new Uint16Array(geometry.index!.count), lod1: new Uint32Array([0, 1, 2]) }; });
    // three uploads each (`WebGLAttributes.updateBuffer` calls the attribute's upload callback).
    for (const attribute of Object.values(own)) attribute.onUploadCallback();
    rows.onUploadCallback();
    for (const attribute of Object.values(own)) expect(attribute.array).toBeNull();
    expect(rows.array).not.toBeNull();
    const after = countMemory(holder).geometryCpuBytes;
    expect(after).toBe(rows.array.byteLength + mesh.instanceMatrix.array.byteLength);
    expect(before - after).toBeGreaterThan(count * 4 * 3);
    // A context restored: the arrays read back, sent again.
    const version = (geometry.getAttribute('position') as Attribute).version;
    (mesh.userData['refillArrays'] as () => void)();
    await Promise.resolve(); await Promise.resolve();
    expect(asked).toBe(1);
    expect(Array.from(geometry.getAttribute('position').array as Float32Array)).toEqual(positions);
    expect((geometry.getAttribute('position') as Attribute).version).toBeGreaterThan(version);
    expect(coarse.array).not.toBeNull();
  });
});
