import { describe, expect, it } from 'vitest';
import { BatchedMesh, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, DataArrayTexture, DataTexture, Group, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshBasicMaterial, ShaderMaterial, WebGLRenderTarget } from 'three';
import { countMemory, geometryBytesOf, geometryBytesSteps, textureGpuBytes } from '@render/memoryCounters';

/** THE SCENE'S MEMORY, COUNTED (`render/memoryCounters.ts`) */
describe('countMemory', () => {
  it('counts a shared geometry and texture once', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(30), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(12), 1));
    const map = new DataTexture(new Uint8Array(8 * 8 * 4), 8, 8);
    const material = new MeshBasicMaterial({ map });
    const root = new Group();
    root.add(new Mesh(geometry, material), new Mesh(geometry, material));
    const c = countMemory(root);
    expect(c.buffers).toBe(2);
    expect(c.geometryBytes).toBe(30 * 4 + 12 * 2);
    expect(c.geometryCpuBytes).toBe(c.geometryBytes);
    expect(c.textures).toBe(1);
    expect(c.textureBytes).toBe(8 * 8 * 4);
  });

  it('keeps a buffer let go after upload on the GPU, off the CPU', () => {
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(300), 3);
    geometry.setAttribute('position', position);
    const root = new Mesh(geometry, new MeshBasicMaterial());
    // As `mesh/gpuOnly.ts` letGo: the size kept, the array let go.
    (position as unknown as { keptBytes: number }).keptBytes = 300 * 4;
    (position as { array: ArrayLike<number> | null }).array = null;
    const c = countMemory(root);
    expect(c.geometryBytes).toBe(300 * 4);
    expect(c.geometryCpuBytes).toBe(0);
  });

  it('holds nothing for a buffer let go with no size kept (a far road block given back and disposed)', () => {
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(300), 3);
    geometry.setAttribute('position', position);
    (position as { array: ArrayLike<number> | null }).array = null; // as `mesh/roadResidency.ts` giveBackArrays
    const c = countMemory(new Mesh(geometry, new MeshBasicMaterial()));
    expect(c.geometryBytes).toBe(0);
    expect(c.releasedBuffers).toBe(1);
  });

  it("counts an array texture's given levels once, every layer already in each level's array", () => {
    // 4 layers of 8x8 RGBA8 with two levels: 8*8*4*4 and 4*4*4*4 bytes, the layers inside each.
    const layered = new DataArrayTexture(new Uint8Array(8 * 8 * 4 * 4), 8, 8, 4);
    layered.mipmaps = [{ data: new Uint8Array(8 * 8 * 4 * 4), width: 8, height: 8 }, { data: new Uint8Array(4 * 4 * 4 * 4), width: 4, height: 4 }] as never;
    expect(textureGpuBytes(layered)).toBe(8 * 8 * 4 * 4 + 4 * 4 * 4 * 4);
  });

  it("leaves a render target's texture to the targets' count", () => {
    const target = new WebGLRenderTarget(64, 64);
    const material = new ShaderMaterial({ uniforms: { tDiffuse: { value: target.texture } } });
    expect(countMemory(new Mesh(new BufferGeometry(), material)).textures).toBe(0);
  });

  it("counts a texture's mip chain, a canvas emptied after upload, and the uniforms a material was compiled with", () => {
    const mipped = new CanvasTexture({ width: 64, height: 64 } as unknown as HTMLCanvasElement);
    expect(textureGpuBytes(mipped)).toBe(Math.round((64 * 64 * 4 * 4) / 3));
    // `signs.ts`: the size kept before the canvas was emptied.
    const sheet = new CanvasTexture({ width: 0, height: 0 } as unknown as HTMLCanvasElement);
    sheet.userData['uploadedBytes'] = 4096;
    expect(textureGpuBytes(sheet)).toBe(4096);
    // A texture put in by `onBeforeCompile`: in no field of the material, only in what it was compiled with.
    const injected = new DataTexture(new Uint8Array(16 * 16 * 4), 16, 16);
    const material = new MeshBasicMaterial();
    const mesh = new Mesh(new BufferGeometry(), material);
    expect(countMemory(mesh).textures).toBe(0);
    const c = countMemory(mesh, { uniformsOf: (m) => (m === material ? { uLots: { value: injected } } : undefined) });
    expect(c.textures).toBe(1);
    expect(c.textureBytes).toBe(16 * 16 * 4);
  });

  it('counts instance matrices, an interleaved buffer once, and shader uniforms', () => {
    const interleaved = new InterleavedBuffer(new Float32Array(6 * 10), 6);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new InterleavedBufferAttribute(interleaved, 3, 0));
    geometry.setAttribute('normal', new InterleavedBufferAttribute(interleaved, 3, 3));
    const lut = new DataTexture(new Float32Array(4 * 4 * 4), 4, 4);
    const instanced = new InstancedMesh(geometry, new ShaderMaterial({ uniforms: { lut: { value: lut } } }), 5);
    const c = countMemory(instanced);
    expect(c.buffers).toBe(2); // the interleaved buffer, the instance matrices
    expect(c.geometryBytes).toBe(6 * 10 * 4 + 5 * 16 * 4);
    expect(c.textures).toBe(1);
    expect(c.textureBytes).toBe(4 * 4 * 4 * 4);
  });

  it('reads a material many meshes share once, its textures held by the first mesh reaching it', () => {
    const map = new DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
    map.name = 'probe-map';
    const material = new MeshBasicMaterial({ map });
    let reads = 0;
    // A field read each time the material's fields are walked.
    Object.defineProperty(material, 'probe', { enumerable: true, get: () => { reads++; return null; } });
    const root = new Group();
    const meshes = Array.from({ length: 5 }, (_, i) => { const mesh = new Mesh(new BoxGeometry(), material); mesh.name = `holder-${i}`; return mesh; });
    root.add(...meshes);
    const c = countMemory(root);
    expect(reads).toBe(1);
    expect(c.textures).toBe(1);
    expect([...c.textureBytesByName.keys()]).toEqual(['holder-0 :: probe-map']);
    geometryBytesOf(root);
    expect(reads).toBe(2);
  });

  it("gives the governor's geometry bytes as the full count gives them, every kind of buffer", () => {
    const root = new Group();
    // Shared geometry and material, an index.
    const shared = new BufferGeometry();
    shared.setAttribute('position', new BufferAttribute(new Float32Array(30), 3));
    shared.setIndex(new BufferAttribute(new Uint16Array(12), 1));
    const material = new MeshBasicMaterial();
    root.add(new Mesh(shared, material), new Mesh(shared, material));
    // Interleaved, instanced.
    const interleaved = new InterleavedBuffer(new Float32Array(6 * 10), 6);
    const instancedGeometry = new BufferGeometry();
    instancedGeometry.setAttribute('position', new InterleavedBufferAttribute(interleaved, 3, 0));
    instancedGeometry.setAttribute('normal', new InterleavedBufferAttribute(interleaved, 3, 3));
    root.add(new InstancedMesh(instancedGeometry, material, 5));
    // Let go after upload with its size kept, and with none.
    const kept = new BufferGeometry();
    const keptPosition = new BufferAttribute(new Float32Array(300), 3);
    kept.setAttribute('position', keptPosition);
    (keptPosition as unknown as { keptBytes: number }).keptBytes = 300 * 4;
    (keptPosition as { array: ArrayLike<number> | null }).array = null;
    const released = new BufferGeometry();
    const releasedPosition = new BufferAttribute(new Float32Array(90), 3);
    released.setAttribute('position', releasedPosition);
    (releasedPosition as { array: ArrayLike<number> | null }).array = null;
    root.add(new Mesh(kept, material), new Mesh(released, material));
    // A morph target, a batch, a hidden mesh, and a buffer a material holds as a field.
    const morphed = new BoxGeometry();
    morphed.morphAttributes['position'] = [new BufferAttribute(new Float32Array(morphed.getAttribute('position').count * 3), 3)];
    const hidden = new Mesh(morphed, material);
    hidden.visible = false;
    const batched = new BatchedMesh(4, 1_000, 3_000, material);
    batched.addGeometry(new BoxGeometry());
    const holding = new MeshBasicMaterial();
    (holding as unknown as { extra: BufferAttribute }).extra = new BufferAttribute(new Float32Array(16), 4);
    root.add(hidden, batched, new Mesh(new BoxGeometry(), holding));
    const full = countMemory(root);
    expect(full.releasedBuffers).toBe(1);
    expect(geometryBytesOf(root)).toBe(full.geometryBytes);
    // Read a few objects at a time (the governor's slices): the same bytes.
    const steps = geometryBytesSteps(root, 2);
    let slices = 0;
    for (let step = steps.next(); ; step = steps.next(), slices++) {
      if (step.done) { expect(step.value).toBe(full.geometryBytes); break; }
    }
    expect(slices).toBeGreaterThan(2);
  });

  it("shows a BatchedMesh's capacity held on the CPU", () => {
    const batched = new BatchedMesh(10, 10_000, 30_000, new MeshBasicMaterial());
    batched.addGeometry(new BoxGeometry());
    const c = countMemory(batched);
    // position, normal, uv at capacity (three allocates the whole capacity), the index, the matrices texture.
    expect(c.geometryCpuBytes).toBeGreaterThanOrEqual(10_000 * (3 + 3 + 2) * 4 + 30_000 * 2);
    expect(c.textures).toBeGreaterThanOrEqual(1);
    // Who holds it, by name: the culprit of a regression named at once.
    batched.name = 'town-shells';
    const root = new Group();
    root.add(batched, new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    expect(countMemory(root).cpuByName[0]).toEqual(['town-shells', c.geometryCpuBytes]);
  });
});
