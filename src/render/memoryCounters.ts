import { LinearMipmapLinearFilter, LinearMipmapNearestFilter, NearestMipmapLinearFilter, NearestMipmapNearestFilter, type BufferAttribute, type InterleavedBuffer, type Object3D, type Texture } from 'three';

/** What the scene holds in memory, counted from the scene itself, in bytes */
export interface MemoryCounters {
  /** Distinct vertex and index buffers in the scene (an interleaved buffer once). */
  readonly buffers: number;
  /** Size of those buffers: what the GPU holds for them once drawn. */
  readonly geometryBytes: number;
  /** The part still held by a JavaScript array (not let go after upload, `mesh/gpuOnly.ts`). */
  readonly geometryCpuBytes: number;
  /** Buffers whose array was let go with no size kept (`mesh/roadResidency.ts` gives a far block's back and disposes it): not counted as held anywhere. */
  readonly releasedBuffers: number;
  /** Who holds `geometryCpuBytes`: the objects' names (the type when unnamed), most first, the first `TOP` of them. */
  readonly cpuByName: readonly (readonly [name: string, bytes: number])[];
  /** `geometryBytes` by every holder's name, for the plan's levels (`core/perfBudget.ts` `memoryGroup`). */
  readonly bytesByName: ReadonlyMap<string, number>;
  /** Distinct textures reachable from the scene's objects and materials, and the uniforms the renderer compiled them with. */
  readonly textures: number;
  /** Their bytes on the GPU, every level of the mip chain: a data texture's array (what is uploaded), a compressed chain's levels, an image at 4 bytes a texel (uploaded as RGBA8). */
  readonly textureBytes: number;
  /** `textureBytes` by holder: the first object reaching each texture and the texture's own name (`holder :: texture`), digits kept. */
  readonly textureBytesByName: ReadonlyMap<string, number>;
}

type Attribute = BufferAttribute & { readonly isInterleavedBufferAttribute?: boolean; readonly data?: InterleavedBuffer };

export interface CountOptions {
  /** The uniforms a material was compiled with (`renderer.properties.get(material).uniforms`): the textures `onBeforeCompile` puts there are in no field of the material (`uLots`, `uDetailMap`: report TST-09). */
  readonly uniformsOf?: (material: object) => Record<string, { value: unknown }> | undefined;
}

/** A buffer as the scene holds it: an interleaved attribute is a view into a buffer other attributes share, counted once. */
type Owner = { readonly array: (ArrayLike<number> & { byteLength?: number }) | null; readonly keptBytes?: number; readonly isGLBufferAttribute?: boolean };
const ownerOf = (a: Attribute): Owner => (a.isInterleavedBufferAttribute && a.data ? a.data : a) as unknown as Owner;
const isAttribute = (value: unknown): value is Attribute =>
  (value as Attribute | null)?.isBufferAttribute === true || (value as Attribute | null)?.isInterleavedBufferAttribute === true;

/** A buffer's bytes on the GPU: its array's; the size kept when its array was let go after upload (`gpuOnly.ts`) or never held
 *  (`GLBufferAttribute`, the shell batches' `gpuBatchedMesh.ts`); -1 when it was let go with no size kept. DO NOT guess a buffer let go
 *  without its size at 4 bytes an item: `roadResidency.ts` lets a far block's go AND disposes it - nothing held anywhere, and it was counted
 *  as GPU memory (report TST-09). */
function bufferBytes(owner: Owner): number {
  const kept = owner.keptBytes;
  if (owner.isGLBufferAttribute || !owner.array) return kept ?? -1;
  return owner.array.byteLength ?? owner.array.length * 4;
}

/** Calls `object` with every object under `root`, shown or not (a hidden mesh holds its memory all the same), and `material` with each of
 *  their materials the first time one is reached, with the object it was reached from: a material many meshes share is read once. */
function eachHolder(root: Object3D, object: (o: Object3D) => void, material: (m: object, holder: Object3D) => void): void {
  const seen = new Set<object>();
  const once = (m: object, holder: Object3D): void => {
    if (seen.has(m)) return;
    seen.add(m);
    material(m, holder);
  };
  root.traverse((o) => {
    object(o);
    const m = (o as { material?: object | object[] }).material;
    if (Array.isArray(m)) for (const one of m) once(one as object, o);
    else if (m) once(m, o);
  });
}

/** The buffers of an object's geometry: its attributes, its index and its morph targets. */
function geometryBuffers(o: Object3D, add: (a: Attribute) => void): void {
  const geometry = (o as { geometry?: { attributes: Record<string, Attribute>; index: Attribute | null; morphAttributes: Record<string, Attribute[]> } }).geometry;
  if (!geometry) return;
  for (const a of Object.values(geometry.attributes)) add(a);
  if (geometry.index) add(geometry.index);
  for (const list of Object.values(geometry.morphAttributes)) for (const a of list) add(a);
}

/** The scene's geometry on the GPU, bytes (`MemoryCounters.geometryBytes`) and nothing else: what the tier's governor reads of the
 *  scene every second (`renderer.ts` governGeometry), with none of the names, the textures and the uniforms the full count works out. */
export function geometryBytesOf(root: Object3D): number {
  const steps = geometryBytesSteps(root, Infinity);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * `geometryBytesOf` a share of the scene at a time: it yields after each `every` objects, and returns the bytes once every object under
 * `root` was read (the objects in `traverse`'s order, each material once). What the governor reads a slice a frame (`renderer.ts`): DO NOT
 * read the whole scene in one frame for it - the 10 km city's 2,500 to 3,600 objects took 5-11 ms, a frame of every second (2026-10-27).
 */
export function* geometryBytesSteps(root: Object3D, every: number): Generator<void, number, void> {
  const buffers = new Set<object>();
  const materials = new Set<object>();
  let bytes = 0;
  const add = (a: Attribute): void => {
    const owner = ownerOf(a);
    if (buffers.has(owner)) return;
    buffers.add(owner);
    bytes += Math.max(0, bufferBytes(owner));
  };
  // The buffers an object or a material holds as its own fields (an instanced mesh's matrices).
  const fields = (holder: object): void => { for (const value of Object.values(holder)) if (isAttribute(value)) add(value); };
  const material = (m: object): void => {
    if (materials.has(m)) return;
    materials.add(m);
    fields(m);
  };
  // Pre-order, as `traverse`: an object, then its children in their order.
  const stack: Object3D[] = [root];
  let read = 0;
  while (stack.length) {
    const o = stack.pop()!;
    fields(o);
    geometryBuffers(o, add);
    const m = (o as { material?: object | object[] }).material;
    if (Array.isArray(m)) for (const one of m) material(one as object);
    else if (m) material(m);
    for (let i = o.children.length - 1; i >= 0; i--) stack.push(o.children[i]!);
    if (++read % every === 0) yield;
  }
  return bytes;
}

/** Counts every object under `root`, shown or not: a hidden mesh holds its memory all the same. */
export function countMemory(root: Object3D, options: CountOptions = {}): MemoryCounters {
  const buffers = new Set<object>();
  const textures = new Set<Texture>();
  /** The holder each texture was first reached from. */
  const textureHolder = new Map<Texture, string>();
  let geometryBytes = 0;
  let geometryCpuBytes = 0;
  let releasedBuffers = 0;
  const cpuByName = new Map<string, number>();
  const bytesByName = new Map<string, number>();
  let holder = '';

  const addBuffer = (a: Attribute): void => {
    const owner = ownerOf(a);
    if (buffers.has(owner)) return;
    buffers.add(owner);
    const bytes = bufferBytes(owner);
    if (bytes < 0) { releasedBuffers++; return; }
    geometryBytes += bytes;
    bytesByName.set(holder, (bytesByName.get(holder) ?? 0) + bytes);
    // Let go after upload with its size kept (`gpuOnly.ts`), or never held (`GLBufferAttribute`): on the GPU, off the CPU.
    if (owner.array && !owner.isGLBufferAttribute) {
      geometryCpuBytes += bytes;
      cpuByName.set(holder, (cpuByName.get(holder) ?? 0) + bytes);
    }
  };
  const addTexture = (value: unknown): void => {
    // DO NOT count a render target's texture here: it is in the targets' bytes (`targetBytes.ts`), and the post chain's uniforms counted 68 MB of them twice.
    if ((value as Texture | null)?.isTexture && !(value as Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture && !textures.has(value as Texture)) {
      textures.add(value as Texture);
      textureHolder.set(value as Texture, holder);
    }
  };
  /** Textures a material or an object holds as its own fields (maps, a BatchedMesh's matrices), and buffers. */
  const scanFields = (fields: object): void => {
    for (const value of Object.values(fields)) {
      addTexture(value);
      if (isAttribute(value)) addBuffer(value);
    }
  };

  eachHolder(root, (object) => {
    holder = object.name || object.type;
    scanFields(object);
    geometryBuffers(object, addBuffer);
  }, (m, reached) => {
    holder = reached.name || reached.type;
    scanFields(m);
    const uniforms = (m as { uniforms?: Record<string, { value: unknown }> }).uniforms;
    if (uniforms) for (const u of Object.values(uniforms)) addTexture(u?.value);
    const compiled = options.uniformsOf?.(m);
    if (compiled) for (const u of Object.values(compiled)) addTexture(u?.value);
  });

  let textureBytes = 0;
  const textureBytesByName = new Map<string, number>();
  for (const t of textures) {
    const bytes = textureGpuBytes(t);
    textureBytes += bytes;
    const key = `${textureHolder.get(t) ?? ''} :: ${t.name || t.type}`;
    textureBytesByName.set(key, (textureBytesByName.get(key) ?? 0) + bytes);
  }
  const top = [...cpuByName].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  return { buffers: buffers.size, geometryBytes, geometryCpuBytes, releasedBuffers, cpuByName: top, bytesByName, textures: textures.size, textureBytes, textureBytesByName };
}

const TOP = 10;

/** Whether a minification filter samples a mip chain. */
const mipmapped = (filter: number): boolean => filter === NearestMipmapNearestFilter || filter === NearestMipmapLinearFilter || filter === LinearMipmapNearestFilter || filter === LinearMipmapLinearFilter;

/** A texture's bytes on the GPU, every level of its chain */
export function textureGpuBytes(t: Texture): number {
  // A canvas let go after its upload (`signs.ts` sheets): its size as uploaded, kept before the canvas was emptied.
  const uploaded = (t.userData as { uploadedBytes?: number } | undefined)?.uploadedBytes;
  if (uploaded !== undefined) return uploaded;
  // Levels given (compressed, KTX2): each level's own bytes, every layer of an array texture already in them.
  const levels = t.mipmaps as readonly { data?: { byteLength?: number }; width?: number; height?: number }[] | undefined;
  if (levels?.length) {
    let bytes = 0;
    for (const level of levels) bytes += level?.data?.byteLength ?? levelBytes(t, level?.width ?? 0, level?.height ?? 0) * depthOf(t);
    // DO NOT multiply a level's array by the layers: it holds them all (the buildings' finishes, 13 layers, counted 236 MB for 18).
    return bytes;
  }
  const image = t.image as { width?: number; height?: number; depth?: number; data?: { byteLength?: number } } | null;
  if (!image) return 0;
  // Data: its array is what is uploaded, whole (every layer of a 3D or array texture already in it).
  const base = image.data?.byteLength ?? levelBytes(t, image.width ?? 0, image.height ?? 0) * depthOf(t);
  // A chain the GPU makes (`generateMipmaps` with a mipmap filter): the levels below add a third.
  return t.generateMipmaps && mipmapped(t.minFilter) ? Math.round((base * 4) / 3) : base;
}

/** One level's bytes with no array to read: an image (a canvas, a bitmap) goes up as RGBA8, 4 bytes a texel. */
const levelBytes = (_t: Texture, width: number, height: number): number => width * height * 4;

const depthOf = (t: Texture): number => (t.image as { depth?: number } | null)?.depth ?? 1;
