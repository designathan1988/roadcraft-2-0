import {
  Bone, Box3, BufferAttribute, BufferGeometry, Group, Matrix4, type Object3D, Skeleton, SkinnedMesh, Sphere, Vector3,
} from 'three';

/**
 * A PERSON OF THE CAST, AS THE GAME READS THEM (`public/models/citizens/people/<id>.bin`, ready files): one skinned mesh a body, its clothes,
 * shoes, hair, brows, lashes and eyes fused into it, one texture atlas (`<id>.ktx2`), its levels of detail in one index buffer on the
 * same vertices, its face's few expressions as sparse moves, a strip of pictures for the impostor drawn far off.
 *
 * DO NOT read a cooked person on the page: `decodeCookedPerson` runs in a worker (`bakePool.ts` uncookInWorker) and the arrays move here.
 */

/** Format version written in every file. */
const COOKED_VERSION = 3;

/** An array in the file: its kind, where, and how long. */
interface BufferRef { readonly kind: ArrayKind; readonly at: number; readonly length: number }
type ArrayKind = 'f32' | 'u32' | 'u16' | 'i16' | 'u8' | 'i8';

/** The vertex attributes of a cooked body, in the file's order, and their layout: 26 bytes a vertex (KHR_mesh_quantization). */
export const VERTEX_LAYOUT = [
  /** Position in the body's quantisation box, `quant.scale` wide about `quant.offset`: signed 16 bits, normalised. */
  { name: 'position', itemSize: 3, kind: 'i16', normalized: true },
  /** The normal as signed bytes, normalised; the fourth component is padding. */
  { name: 'normal', itemSize: 4, kind: 'i8', normalized: true },
  /** The vertex's own colour (white where the atlas holds it), and in the fourth byte the region (bits 6-7: 0 cloth, 1 skin, 2 hair, 3 eye) and roughness (bits 0-5, 0..63). */
  { name: 'personColor', itemSize: 4, kind: 'u8', normalized: true },
  /** Where in the atlas: unsigned 16 bits, normalised. */
  { name: 'uv', itemSize: 2, kind: 'u16', normalized: true },
  { name: 'skinIndex', itemSize: 4, kind: 'u8', normalized: false },
  /** The four weights, normalised bytes that sum to one. */
  { name: 'skinWeight', itemSize: 4, kind: 'u8', normalized: true },
] as const;

/** The most triangles each level holds in the cast's files: near, then the coarser mesh, drawn down to the impostor. The near levels are
 *  3,894 to 5,000 (5,000 the cap they were simplified to: under 4,000 the shirts opened on the skin and the hair tore, the sheets of
 *  2026-10-25), the coarser ones 1,312 to 2,458 (the cap 2,504: below ~1,800 the hair cards and the clothes' locked edges do not go). A
 *  300-triangle far shell in vertex colours was dropped: faceless, it stood in for every person up to ~37 px tall (the sheets, 2026-10-24). */
export const LEVEL_TRIANGLES = [5000, 2504] as const;

/** A level's triangles in the shared index buffer, and its error as a share of the body's height (what the level is chosen by): the largest
 *  distance, measured both ways at the rest pose, between the level's surface and the body's near mesh before it was simplified. */
interface CookedLevel { readonly start: number; readonly count: number; readonly error: number }

/** A face expression: the vertices it moves and their moves, in the position's quantised units. */
interface CookedMorph { readonly name: string; readonly vertices: BufferRef; readonly deltas: BufferRef }

/** Where the impostor's frames are in the atlas: `frames` yaw views in a row, each `width` x `height` texels, from (`x`, `y`) (texel rows from the top). */
export interface CookedImpostor { readonly frames: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

interface CookedMesh {
  /** The scene node the mesh is. */
  readonly node: number;
  readonly vertexCount: number;
  /** The quantisation box: a position's bytes, normalised to -1..1, times `scale` plus `offset` is metres in the mesh's frame. */
  readonly quant: { readonly scale: number; readonly offset: readonly [number, number, number] };
  readonly attributes: readonly BufferRef[];
  /** Every level's triangles, one after the other. */
  readonly index: BufferRef;
  readonly levels: readonly CookedLevel[];
  readonly morphs: readonly CookedMorph[];
  readonly dictionary: Readonly<Record<string, number>>;
  readonly bones: readonly number[];
  /** Full precision (the skeleton works in doubles): 16 numbers a bone. */
  readonly inverses: readonly number[];
  readonly bind: readonly number[];
  readonly bindMode: string;
  /** Where the face is in the mesh's frame, for the face's shaders (`faceExpression.ts`). */
  readonly faceOrigin: readonly [number, number, number];
  readonly faceScale: number;
  /** The alpha a texel must pass to be drawn: the hair's cards. */
  readonly alphaTest: number;
  readonly impostor: CookedImpostor;
}

interface CookedNode {
  readonly name: string;
  readonly kind: 'bone' | 'skinned' | 'group' | 'node';
  readonly parent: number;
  readonly p: readonly number[];
  readonly q: readonly number[];
  readonly s: readonly number[];
}

export interface CookedHeader {
  readonly version: typeof COOKED_VERSION;
  readonly id: string;
  /** Standing height in the bind posture, metres. */
  readonly height: number;
  readonly nodes: readonly CookedNode[];
  readonly mesh: CookedMesh;
  /** The atlas beside the file, its side in texels, and whether it is UASTC or RGBA8. */
  readonly atlas: { readonly file: string; readonly size: number; readonly codec: 'uastc' | 'rgba8' };
}

type Typed = Float32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;
const KINDS: Record<ArrayKind, { new (buffer: ArrayBuffer, at: number, length: number): Typed; BYTES_PER_ELEMENT: number }> = {
  f32: Float32Array, u32: Uint32Array, u16: Uint16Array, i16: Int16Array, u8: Uint8Array, i8: Int8Array,
};
const kindOf = (a: Typed): ArrayKind =>
  a instanceof Float32Array ? 'f32' : a instanceof Uint32Array ? 'u32' : a instanceof Uint16Array ? 'u16'
    : a instanceof Int16Array ? 'i16' : a instanceof Int8Array ? 'i8' : 'u8';

// ------------------------------------------------------------------ writing

/** What is handed in to be written: a body's arrays, its levels, its face's moves, its skeleton. */
export interface CookedInput {
  readonly id: string;
  readonly height: number;
  readonly nodes: readonly CookedNode[];
  readonly mesh: Omit<CookedMesh, 'attributes' | 'index' | 'morphs'> & {
    readonly attributes: readonly Typed[];
    readonly index: Uint16Array;
    readonly morphs: readonly { readonly name: string; readonly vertices: Uint16Array; readonly deltas: Int16Array }[];
  };
  readonly atlas: CookedHeader['atlas'];
}

/** The file: a header, then the arrays, each 4-aligned. */
export function packCookedPerson(input: CookedInput): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const put = (array: Typed): BufferRef => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const padded = (bytes.byteLength + 3) & ~3;
    const copy = new Uint8Array(padded);
    copy.set(bytes);
    const ref: BufferRef = { kind: kindOf(array), at: size, length: array.length };
    chunks.push(copy);
    size += padded;
    return ref;
  };
  if (input.mesh.attributes.length !== VERTEX_LAYOUT.length) throw new Error(`cooked person: ${input.mesh.attributes.length} attributes, ${VERTEX_LAYOUT.length} expected`);
  input.mesh.attributes.forEach((a, i) => {
    const layout = VERTEX_LAYOUT[i]!;
    if (kindOf(a) !== layout.kind) throw new Error(`cooked person: ${layout.name} is ${kindOf(a)}, ${layout.kind} expected`);
    if (a.length !== input.mesh.vertexCount * layout.itemSize) throw new Error(`cooked person: ${layout.name} holds ${a.length} values for ${input.mesh.vertexCount} vertices`);
  });
  const mesh: CookedMesh = {
    ...input.mesh,
    attributes: input.mesh.attributes.map(put),
    index: put(input.mesh.index),
    morphs: input.mesh.morphs.map((m) => ({ name: m.name, vertices: put(m.vertices), deltas: put(m.deltas) })),
  };
  const header: CookedHeader = { version: COOKED_VERSION, id: input.id, height: input.height, nodes: input.nodes, mesh, atlas: input.atlas };
  const text = new TextEncoder().encode(JSON.stringify(header));
  const headerPadded = (text.byteLength + 3) & ~3;
  const out = new Uint8Array(4 + headerPadded + size);
  new DataView(out.buffer).setUint32(0, text.byteLength, true);
  out.set(text, 4);
  let offset = 4 + headerPadded;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out.buffer;
}

// ------------------------------------------------------------------ reading

/** A cooked person read: the header, the mesh's arrays each in a buffer of its own (movable to the page), the morphs made whole. */
export interface DecodedPerson {
  readonly header: CookedHeader;
  readonly attributes: readonly Typed[];
  readonly index: Uint16Array;
  /** Each expression over every vertex (three's morph attributes are dense), in the position's quantised units. */
  readonly morphs: readonly Int16Array[];
  /** Box min and max, then the sphere's centre and radius, in the mesh's quantised frame. */
  readonly bounds: readonly number[];
}

/** The header alone (the cook's checks, the tests): what the file says of itself. */
export function readCookedHeader(buffer: ArrayBuffer): CookedHeader {
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as CookedHeader;
  if (header.version !== COOKED_VERSION) throw new Error(`Cooked person ${header.id ?? '?'}: version ${String(header.version)}, ${COOKED_VERSION} expected`);
  return header;
}

export function decodeCookedPerson(buffer: ArrayBuffer): { person: DecodedPerson; transfer: ArrayBuffer[] } {
  const headerLength = new DataView(buffer).getUint32(0, true);
  const header = readCookedHeader(buffer);
  const base = 4 + ((headerLength + 3) & ~3);
  const transfer: ArrayBuffer[] = [];
  const get = (ref: BufferRef, kept = true): Typed => {
    const Kind = KINDS[ref.kind];
    // A copy of its own, 4-aligned: the views are handed to WebGL as they are.
    const bytes = buffer.slice(base + ref.at, base + ref.at + ref.length * Kind.BYTES_PER_ELEMENT);
    if (kept) transfer.push(bytes);
    return new Kind(bytes, 0, ref.length);
  };
  const m = header.mesh;
  const attributes = m.attributes.map((ref) => get(ref));
  const index = get(m.index) as Uint16Array;
  const position = attributes[0] as Int16Array;
  const morphs = m.morphs.map((morph) => {
    const full = new Int16Array(m.vertexCount * 3);
    const vertices = get(morph.vertices, false), deltas = get(morph.deltas, false);
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i]!;
      full[v * 3] = deltas[i * 3]!; full[v * 3 + 1] = deltas[i * 3 + 1]!; full[v * 3 + 2] = deltas[i * 3 + 2]!;
    }
    transfer.push(full.buffer);
    return full;
  });
  // The bounds in the quantised frame (-1..1 units): widened by the face's moves, as three would widen them.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const norm = 1 / 32767;
  for (let v = 0; v < m.vertexCount; v++) {
    let reach = 0;
    for (const morph of morphs) reach = Math.max(reach, Math.abs(morph[v * 3]!), Math.abs(morph[v * 3 + 1]!), Math.abs(morph[v * 3 + 2]!));
    const x = position[v * 3]! * norm, y = position[v * 3 + 1]! * norm, z = position[v * 3 + 2]! * norm, r = reach * norm;
    if (x - r < minX) minX = x - r; if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r; if (y + r > maxY) maxY = y + r;
    if (z - r < minZ) minZ = z - r; if (z + r > maxZ) maxZ = z + r;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let radius = 0;
  for (let v = 0; v < m.vertexCount; v++) {
    const d = Math.hypot(position[v * 3]! * norm - cx, position[v * 3 + 1]! * norm - cy, position[v * 3 + 2]! * norm - cz);
    if (d > radius) radius = d;
  }
  // The face's moves added once more on the radius: the sphere stays round what the morphs can reach.
  let reach = 0;
  for (const morph of morphs) for (let i = 0; i < morph.length; i++) reach = Math.max(reach, Math.abs(morph[i]!));
  // THE POSITION DRAWN FOUR WIDE (w 0, never read: the shader's `position` is a vec3), the file's three: D3D11 has no three-component 16-bit
  // format and ANGLE converts one on the CPU (ANGLE wiki, "Getting Good Performance From ANGLE": SHORT with 3 components, use 4). DO NOT
  // draw the file's array as it is: every level of every body is SHORT x3 (the move reports' vertex formats, 2026-10-27). Widened here, off the page.
  const drawn = new Int16Array(m.vertexCount * 4);
  for (let v = 0; v < m.vertexCount; v++) {
    drawn[v * 4] = position[v * 3]!; drawn[v * 4 + 1] = position[v * 3 + 1]!; drawn[v * 4 + 2] = position[v * 3 + 2]!;
  }
  transfer[transfer.indexOf(position.buffer as ArrayBuffer)] = drawn.buffer;
  const drawnAttributes = [drawn, ...attributes.slice(1)];
  return {
    person: { header, attributes: drawnAttributes, index, morphs, bounds: [minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz, radius + reach * norm] },
    transfer,
  };
}

/** The scene read back: bones, one skinned mesh in its quantisation frame (its node scaled and placed to dequantise), its levels as index attributes on `userData.levels`. */
export function assemblePerson(person: DecodedPerson): Group {
  const { header, attributes, index, morphs, bounds } = person;
  const m = header.mesh;
  const built: Object3D[] = header.nodes.map((n, at) => {
    let o: Object3D;
    if (n.kind === 'bone') o = new Bone();
    else if (n.kind === 'skinned' && at === m.node) {
      const g = new BufferGeometry();
      // Each as wide as the decode drew it (the position four, `decodeCookedPerson`).
      VERTEX_LAYOUT.forEach((layout, k) => g.setAttribute(layout.name, new BufferAttribute(attributes[k]!, attributes[k]!.length / m.vertexCount, layout.normalized)));
      // The nearest level is the geometry's own index; the coarser ones views on the same buffer (`userData.levels`).
      const first = m.levels[0]!;
      g.setIndex(new BufferAttribute(index.subarray(first.start, first.start + first.count), 1));
      g.userData['levels'] = m.levels.map((level) => new BufferAttribute(index.subarray(level.start, level.start + level.count), 1));
      g.userData['levelErrors'] = m.levels.map((level) => level.error);
      if (morphs.length) {
        g.morphAttributes['position'] = morphs.map((full, k) => {
          const attribute = new BufferAttribute(full, 3, true);
          attribute.name = m.morphs[k]!.name;
          return attribute;
        });
        g.morphTargetsRelative = true;
      }
      g.userData['faceOrigin'] = new Vector3().fromArray(m.faceOrigin);
      g.userData['faceScale'] = m.faceScale;
      const b = bounds;
      g.boundingBox = new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
      g.boundingSphere = new Sphere(new Vector3(b[6], b[7], b[8]), b[9]);
      // No material here: the game gives every body the one person material (`personMaterial.ts`).
      const mesh = new SkinnedMesh(g);
      if (morphs.length) {
        mesh.morphTargetInfluences = morphs.map(() => 0);
        mesh.morphTargetDictionary = { ...m.dictionary };
      }
      o = mesh;
    } else o = new Group();
    o.name = n.name;
    o.position.fromArray(n.p);
    o.quaternion.fromArray(n.q);
    o.scale.fromArray(n.s);
    return o;
  });
  header.nodes.forEach((n, i) => { if (n.parent >= 0) built[n.parent]!.add(built[i]!); });
  const root = built[0]!;
  const mesh = built[m.node] as SkinnedMesh;
  // Dequantised by the node itself: the vertices stay bytes, the matrix puts them in metres (uniform, so the normals keep their angles).
  mesh.position.fromArray(m.quant.offset);
  mesh.scale.setScalar(m.quant.scale);
  root.updateMatrixWorld(true);
  const bones = m.bones.map((b) => built[b] as Bone);
  const inverses = bones.map((_, k) => new Matrix4().fromArray(m.inverses, k * 16));
  mesh.bindMode = m.bindMode as SkinnedMesh['bindMode'];
  mesh.bind(new Skeleton(bones, inverses), new Matrix4().fromArray(m.bind));
  if (!(root as Group).isGroup) {
    const wrap = new Group();
    wrap.add(root);
    return wrap;
  }
  return root as Group;
}

/** The region and roughness byte of `personColor` (`VERTEX_LAYOUT`): the shaders decode the same. */
export const lookByte = (region: 0 | 1 | 2 | 3, roughness: number): number =>
  (region << 6) | Math.round(Math.min(1, Math.max(0, roughness)) * 63);
