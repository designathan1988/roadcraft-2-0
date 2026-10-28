import {
  type BufferAttribute, type BufferGeometry, type Camera, type InterleavedBufferAttribute, type Material, Matrix4, type Object3D, type OrthographicCamera,
  type PerspectiveCamera, Sphere, type Texture, Vector3,
} from 'three';
import { textureGpuBytes } from '@render/memoryCounters';
import type { LabContext } from '../labTypes';
import type { Draw } from './measure';

/**
 * THE WORK AND THE MEMORY THAT BUY NOTHING ON THE SCREEN, found by watching the scene over a few frames (the diagnosis's last stage,
 * `measure.ts`): what is sent to the GPU again with the same content, what is moved by its matrix every frame and never moves, what is
 * worked on while hidden, what is held on the GPU and not drawn, what is held twice, the models drawn with more triangles than the pixels
 * they cover (a level of detail missing: Nanite's own target is about one triangle a pixel, Karis, "Nanite", SIGGRAPH 2021,
 * https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf), and draws too small to be worth a call.
 * Each with its object, its layer and its bytes or triangles: the finding names it (`findings.ts`).
 */

/** Frames watched for what changes. */
const FRAMES = 24;
/** Above this many triangles for each pixel an object covers, its model is finer than the screen can show. */
const DENSE = 1;
/** A draw of fewer triangles than this is a call spent on almost nothing. */
const TINY = 32;
/** Arrays above this are not hashed for copies (a few hundred milliseconds of hashing kept). */
const HASH_MOST = 32 * 1048576;

type Attr = BufferAttribute | InterleavedBufferAttribute;

/** Something sent to the GPU again in the frames watched. */
interface Resend {
  readonly kind: 'buffer' | 'texture';
  readonly name: string;
  readonly holder: string;
  readonly layer: string;
  /** Frames it was sent in, of `frames`. */
  readonly sends: number;
  readonly bytes: number;
  /** Sent with the content it already had (two sends hashed alike); null when it was sent once. */
  readonly same: boolean | null;
  readonly hidden: boolean;
}

interface LayerCount { readonly layer: string; readonly objects: number }
interface Held { readonly kind: 'geometry' | 'texture'; readonly name: string; readonly holder: string; readonly layer: string; readonly bytes: number; readonly why: 'hidden' | 'not drawn' }
interface Copies { readonly kind: 'geometry' | 'texture'; readonly names: readonly string[]; readonly copies: number; readonly bytes: number; readonly wasted: number }
interface Dense {
  readonly name: string; readonly layer: string; readonly kind: string;
  readonly triangles: number; readonly instances: number;
  /** Its radius on the screen, px (an instanced model's median instance). */
  readonly radiusPx: number;
  readonly trianglesPerPixel: number;
  /** Triangles past one a pixel, times its instances. */
  readonly excess: number;
  readonly shadow: boolean;
}

/** A banded rung (`farLadders.ts`): every instance sent, those outside its band of sizes thrown away in the vertex shader. */
interface Thrown { readonly name: string; readonly layer: string; readonly instances: number; readonly thrown: number; readonly triangles: number }

export interface Waste {
  readonly frames: number;
  readonly resends: readonly Resend[];
  /** Objects whose matrix three works out every frame (`matrixAutoUpdate`) and that did not move in the frames watched. */
  readonly stillMatrices: readonly LayerCount[];
  readonly stillMatrixObjects: number;
  readonly held: readonly Held[];
  readonly copies: readonly Copies[];
  readonly dense: readonly Dense[];
  /** The banded rungs' instances shaded and thrown away: their vertices worked for nothing. */
  readonly thrown: readonly Thrown[];
  readonly tiny: readonly { readonly layer: string; readonly draws: number; readonly triangles: number }[];
}

const nameOf = (o: { name?: string; type?: unknown; uuid?: string }): string => o.name || (typeof o.type === 'string' ? o.type : '') || o.uuid?.slice(0, 8) || '(unnamed)';
const layerOf = (object: Object3D): string => {
  const chain: Object3D[] = [];
  for (let at: Object3D | null = object; at && at.parent; at = at.parent) chain.unshift(at);
  const named = (o: Object3D): string => o.name || o.type;
  return chain.length >= 3 ? `${named(chain[0]!)} / ${named(chain[1]!)}` : chain[0] ? named(chain[0]) : '(scene)';
};
const shown = (object: Object3D): boolean => { for (let o: Object3D | null = object; o; o = o.parent) if (!o.visible) return false; return true; };

/** The array behind an attribute (its interleaved buffer's), null when it went to the GPU alone (`mesh/gpuOnly.ts`). */
const arrayOf = (a: Attr): (ArrayLike<number> & { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number }) | null => {
  const inter = a as InterleavedBufferAttribute;
  return ((inter.isInterleavedBufferAttribute ? inter.data.array : (a as BufferAttribute).array) ?? null) as never;
};
const versionOf = (a: Attr): number => ((a as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as InterleavedBufferAttribute).data.version : (a as BufferAttribute).version);

/** FNV-1a over an array's bytes, four at a time: two contents told apart. */
function hashOf(array: ArrayLike<number> & { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number }): number {
  if (!array.buffer || array.byteLength === undefined) return -1;
  const words = new Uint32Array(array.buffer, array.byteOffset ?? 0, Math.floor(array.byteLength / 4));
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) { h ^= words[i]!; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const texturesOf = (material: Material): Texture[] => {
  const out: Texture[] = [];
  for (const v of Object.values(material)) if ((v as Texture | null)?.isTexture) out.push(v as Texture);
  const uniforms = (material as { uniforms?: Record<string, { value: unknown }> }).uniforms;
  for (const u of Object.values(uniforms ?? {})) if ((u?.value as Texture | null)?.isTexture) out.push(u.value as Texture);
  return out;
};
const materialsOf = (o: Object3D): Material[] => { const m = (o as { material?: Material | Material[] }).material; return Array.isArray(m) ? m : m ? [m] : []; };

/** An object's size on the screen: its bounding sphere's radius, px, seen from `camera` on a `height`-px view (null: none to read). */
function radiusPx(sphere: Sphere, camera: Camera, height: number): number | null {
  const centre = sphere.center, r = sphere.radius;
  if (!Number.isFinite(r) || r <= 0) return null;
  const ortho = (camera as OrthographicCamera).isOrthographicCamera;
  if (ortho) {
    const c = camera as OrthographicCamera;
    return (r * height * c.zoom) / Math.max(1e-9, c.top - c.bottom);
  }
  const p = camera as PerspectiveCamera;
  const camPos = new Vector3().setFromMatrixPosition(p.matrixWorld);
  const d = Math.max(1e-3, centre.distanceTo(camPos) - r);
  return (r / (d * Math.tan(((p.fov ?? 50) * Math.PI) / 360))) * (height / 2);
}

/** The scene watched `FRAMES` frames (every frame asked for), then read: the frames' captured draws (`draws`, one frame's) say what is drawn. */
export async function scanWaste(ctx: LabContext, draws: readonly Draw[], progress: (text: string) => void): Promise<Waste> {
  const scene = ctx.scene.scene;
  // ---- what changes, frame by frame
  interface Track { readonly attr: Attr | null; readonly texture: Texture | null; readonly object: Object3D; version: number; sends: number; lastHash: number | null; same: boolean | null }
  const tracks = new Map<object, Track>();
  const matrices = new Map<Object3D, Float64Array>();
  const moved = new Set<Object3D>();
  const look = (first: boolean): void => {
    scene.traverse((o) => {
      if (o.matrixAutoUpdate && o.parent) {
        const known = matrices.get(o);
        const e = o.matrixWorld.elements;
        if (!known) matrices.set(o, Float64Array.from(e));
        else if (!moved.has(o)) for (let i = 0; i < 16; i++) if (known[i] !== e[i]) { moved.add(o); break; }
      }
      const geometry = (o as { geometry?: BufferGeometry }).geometry;
      const attrs: Attr[] = geometry ? [...Object.values(geometry.attributes) as Attr[], ...(geometry.index ? [geometry.index] : [])] : [];
      const inst = o as { instanceMatrix?: BufferAttribute; instanceColor?: BufferAttribute | null };
      if (inst.instanceMatrix) attrs.push(inst.instanceMatrix);
      if (inst.instanceColor) attrs.push(inst.instanceColor);
      for (const a of attrs) {
        const key = (a as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as InterleavedBufferAttribute).data : a;
        const v = versionOf(a);
        const t = tracks.get(key);
        if (!t) { tracks.set(key, { attr: a, texture: null, object: o, version: v, sends: 0, lastHash: null, same: null }); continue; }
        if (first || v === t.version) continue;
        t.version = v;
        t.sends++;
        const array = arrayOf(a);
        if (array && (array.byteLength ?? 0) <= HASH_MOST) {
          const h = hashOf(array);
          if (t.lastHash !== null) t.same = (t.same ?? true) && h === t.lastHash;
          t.lastHash = h;
        }
      }
      for (const m of materialsOf(o)) {
        for (const tex of texturesOf(m)) {
          const t = tracks.get(tex);
          if (!t) { tracks.set(tex, { attr: null, texture: tex, object: o, version: tex.version, sends: 0, lastHash: null, same: null }); continue; }
          if (first || tex.version === t.version) continue;
          t.version = tex.version;
          t.sends++;
        }
      }
    });
  };
  look(true);
  await new Promise<void>((done) => {
    let n = 0;
    const stop = ctx.onFrame(() => {
      look(false);
      if (++n >= FRAMES) { stop(); done(); return; }
      progress(`watching what changes: frame ${n} of ${FRAMES}`);
      ctx.requestDraw();
    });
    ctx.requestDraw();
  });

  const resends: Resend[] = [];
  for (const t of tracks.values()) {
    if (t.sends === 0) continue;
    if (t.attr) {
      const array = arrayOf(t.attr);
      resends.push({ kind: 'buffer', name: t.attr.name || 'attribute', holder: nameOf(t.object), layer: layerOf(t.object), sends: t.sends, bytes: array?.byteLength ?? 0, same: t.same, hidden: !shown(t.object) });
    } else if (t.texture) {
      resends.push({ kind: 'texture', name: nameOf(t.texture), holder: nameOf(t.object), layer: layerOf(t.object), sends: t.sends, bytes: textureGpuBytes(t.texture), same: null, hidden: !shown(t.object) });
    }
  }
  resends.sort((a, b) => b.sends * b.bytes - a.sends * a.bytes);

  // ---- matrices worked out every frame for objects that stand still
  const still = new Map<string, number>();
  let stillCount = 0;
  for (const o of matrices.keys()) {
    if (moved.has(o) || o.children.length > 0 && !(o as { isMesh?: boolean }).isMesh) continue;
    stillCount++;
    const layer = layerOf(o);
    still.set(layer, (still.get(layer) ?? 0) + 1);
  }

  // ---- held on the GPU and not drawn this frame; held twice
  progress('reading what is held and what is drawn');
  const drawnObjects = new Set(draws.map((d) => d.object as Object3D));
  const drawnGeometries = new Set<object>();
  const drawnTextures = new Set<Texture>();
  for (const o of drawnObjects) {
    const g = (o as { geometry?: object }).geometry;
    if (g) drawnGeometries.add(g);
    for (const m of materialsOf(o)) for (const t of texturesOf(m)) drawnTextures.add(t);
  }
  const props = ctx.scene.gl.properties as unknown as { has(o: object): boolean; get(o: object): unknown };
  const held: Held[] = [];
  const seenGeometry = new Set<object>();
  const seenTexture = new Set<Texture>();
  const byHash = new Map<string, { names: string[]; geometries: Set<object>; bytes: number }>();
  const textureSources = new Map<unknown, { names: string[]; textures: Set<Texture>; bytes: number }>();
  scene.traverse((o) => {
    const g = (o as { geometry?: BufferGeometry }).geometry;
    if (g && !seenGeometry.has(g)) {
      seenGeometry.add(g);
      let bytes = 0, cpu = true;
      const parts: string[] = [];
      for (const a of [...Object.values(g.attributes) as Attr[], ...(g.index ? [g.index] : [])]) {
        const array = arrayOf(a);
        if (!array) { cpu = false; bytes += (a as { keptBytes?: number }).keptBytes ?? 0; continue; }
        bytes += array.byteLength ?? 0;
        if ((array.byteLength ?? 0) <= HASH_MOST) parts.push(`${a.name}:${array.length}:${hashOf(array)}`);
      }
      if (!drawnGeometries.has(g) && props.has(g)) held.push({ kind: 'geometry', name: g.name || '(unnamed)', holder: nameOf(o), layer: layerOf(o), bytes, why: shown(o) ? 'not drawn' : 'hidden' });
      // A copy: the same arrays, byte for byte, in another geometry (a buffer shared is one, not a copy).
      if (cpu && parts.length && bytes > 1024) {
        const key = parts.sort().join('|');
        const c = byHash.get(key) ?? { names: [], geometries: new Set<object>(), bytes };
        if (!c.geometries.has(g)) { c.geometries.add(g); c.names.push(`${nameOf(o)} (${g.name || 'geometry'})`); }
        byHash.set(key, c);
      }
    }
    for (const m of materialsOf(o)) {
      for (const t of texturesOf(m)) {
        if (seenTexture.has(t) || (t as { isRenderTargetTexture?: boolean }).isRenderTargetTexture) continue;
        seenTexture.add(t);
        const bytes = textureGpuBytes(t);
        if (!drawnTextures.has(t) && props.has(t)) held.push({ kind: 'texture', name: nameOf(t), holder: nameOf(o), layer: layerOf(o), bytes, why: shown(o) ? 'not drawn' : 'hidden' });
        // A copy: another texture over the same picture (its image or its file), not sharing its `source`.
        const image = (t.source as { data?: unknown } | undefined)?.data as { src?: string; currentSrc?: string } | null | undefined;
        const ident = image ? image.currentSrc || image.src || image : null;
        if (!ident) continue;
        const c = textureSources.get(ident) ?? { names: [], textures: new Set<Texture>(), bytes };
        const sources = new Set([...c.textures].map((x) => x.source));
        if (!sources.has(t.source)) { c.textures.add(t); c.names.push(nameOf(t)); }
        textureSources.set(ident, c);
      }
    }
  });
  held.sort((a, b) => b.bytes - a.bytes);
  const copies: Copies[] = [];
  for (const c of byHash.values()) if (c.geometries.size > 1) copies.push({ kind: 'geometry', names: c.names.slice(0, 8), copies: c.geometries.size, bytes: c.bytes, wasted: c.bytes * (c.geometries.size - 1) });
  for (const c of textureSources.values()) if (c.textures.size > 1) copies.push({ kind: 'texture', names: c.names.slice(0, 8), copies: c.textures.size, bytes: c.bytes, wasted: c.bytes * (c.textures.size - 1) });
  copies.sort((a, b) => b.wasted - a.wasted);

  // ---- models finer than the pixels they cover; draws too small for their call
  progress('weighing the triangles against the pixels');
  const camera = ctx.scene.viewCamera();
  camera.updateMatrixWorld();
  const height = ctx.scene.gl.domElement.height;
  const sphere = new Sphere();
  const m4 = new Matrix4();
  const dense = new Map<string, Dense>();
  const thrown = new Map<string, Thrown>();
  /** A banded material's band, px across (`farLadders.ts` uBand: least, most), from the uniforms three compiled it with; null when not banded. */
  const bandOf = (material: unknown): { lo: number; hi: number } | null => {
    const m = (Array.isArray(material) ? material[0] : material) as Material | undefined;
    if (!m || !props.has(m)) return null;
    const u = (props.get(m) as { uniforms?: Record<string, { value: { x: number; y: number } }> }).uniforms?.['uBand']?.value;
    return u ? { lo: u.x, hi: u.y } : null;
  };
  const tiny = new Map<string, { draws: number; triangles: number }>();
  for (const d of draws) {
    if (/^quad:/.test(d.layer) || d.triangles <= 0) continue;
    const o = d.object as Object3D;
    const g = (o as { geometry?: BufferGeometry }).geometry;
    const shadow = /shadow/i.test(`${d.pass} ${d.target}`);
    if (!shadow && d.triangles < TINY && d.instances <= 1) {
      const t = tiny.get(d.layer) ?? { draws: 0, triangles: 0 };
      t.draws++; t.triangles += d.triangles;
      tiny.set(d.layer, t);
    }
    if (!g) continue;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingSphere) continue;
    const instances = Math.max(1, d.instances);
    const per = d.triangles / instances;
    let r: number | null;
    let drawnInstances = instances;
    const inst = o as { isInstancedMesh?: boolean; instanceMatrix?: BufferAttribute; getMatrixAt?(i: number, m: Matrix4): Matrix4; count?: number };
    if (inst.isInstancedMesh && inst.instanceMatrix?.array && inst.getMatrixAt) {
      // The median instance's size: a sample of up to 256 of them; on a banded rung, of those its band draws (the rest are thrown away).
      const band = bandOf((o as { material?: unknown }).material);
      const radii: number[] = [];
      let sampled = 0;
      const step = Math.max(1, Math.floor((inst.count ?? 0) / 256));
      for (let i = 0; i < (inst.count ?? 0); i += step) {
        inst.getMatrixAt(i, m4);
        sphere.copy(g.boundingSphere).applyMatrix4(m4.premultiply(o.matrixWorld));
        const px = radiusPx(sphere, camera, height);
        if (px === null) continue;
        sampled++;
        if (band && (2 * px < band.lo || 2 * px >= band.hi)) continue;
        radii.push(px);
      }
      if (band && sampled) {
        drawnInstances = Math.round((instances * radii.length) / sampled);
        const out = instances - drawnInstances;
        if (out > 0) {
          const key = `${d.layer}|${d.name}`;
          const t = thrown.get(key) ?? { name: d.name, layer: d.layer, instances: 0, thrown: 0, triangles: 0 };
          thrown.set(key, { ...t, instances: t.instances + instances, thrown: t.thrown + out, triangles: t.triangles + out * per });
        }
      }
      radii.sort((a, b) => a - b);
      r = radii.length ? radii[radii.length >> 1]! : null;
    } else {
      sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
      r = radiusPx(sphere, camera, height);
    }
    if (r === null) continue;
    const area = Math.max(1, Math.PI * r * r);
    const density = per / area;
    if (density <= DENSE || per < 64) continue;
    const key = `${d.layer}|${d.name}|${shadow}`;
    const excess = Math.max(0, per - area) * drawnInstances;
    const known = dense.get(key);
    if (drawnInstances > 0 && (!known || known.excess < excess)) dense.set(key, { name: d.name, layer: d.layer, kind: d.kind, triangles: per, instances: drawnInstances, radiusPx: r, trianglesPerPixel: density, excess, shadow });
  }
  return {
    frames: FRAMES,
    resends,
    stillMatrices: [...still].map(([layer, objects]) => ({ layer, objects })).sort((a, b) => b.objects - a.objects),
    stillMatrixObjects: stillCount,
    held,
    copies,
    dense: [...dense.values()].sort((a, b) => b.excess - a.excess),
    thrown: [...thrown.values()].sort((a, b) => b.triangles - a.triangles),
    tiny: [...tiny].map(([layer, t]) => ({ layer, ...t })).filter((t) => t.draws >= 50).sort((a, b) => b.draws - a.draws),
  };
}
