import { BufferAttribute, BufferGeometry, ShaderChunk, type InstancedBufferAttribute, type MeshPhysicalMaterial, type TypedArray } from 'three';

/** A VEHICLE'S OPAQUE BODY IN ONE DRAW (`agents.ts` drawCar, doors shut): the shell, its second panel (the roof, or a truck's box: its accent),
 *  the trim and the cabin are always drawn together, with the same instance matrix; they differ only in their colour (the paint's, the
 *  panel's, their own) and their material's numbers (paint, trim, cabin). One mesh holds them all, each vertex marked with what it is
 *  (`panel`: KIND), and one material picks, per vertex, the colour and the numbers each part's own material has (`panelPaint`); the shadow is
 *  cast by the shell and the panel only, as before (`casting`: the trim and the cabin cast none).
 *  The vertices are the parts' own numbers, in the parts' own order, the shell's triangles first (three keeps the later of two equal depths,
 *  LessEqualDepth: the trim and the cabin over the shell, as when they were drawn after it), and every value is picked, not mixed: every
 *  vertex is transformed and shaded exactly as it was in its own draw. */

/** What a vertex of a joined body is. */
export const KIND = { body: 0, panel: 1, trim: 2, cabin: 3 } as const;

/** The vertices and index of a body's parts joined (`panelGeometry`). */
export interface JoinedPanels {
  readonly attributes: ReadonlyMap<string, BufferAttribute>;
  readonly index: BufferAttribute;
  /** The index's corners of the body and the panel, its first: the shadow is drawn of these (`agents.ts` onBeforeShadow). */
  readonly casting: number;
}

/** The attributes the parts carry (`vehicleModels.ts`, `vehicleLevels.ts`): all must have the same ones to be joined. */
const NAMES = ['position', 'color', 'normal'] as const;

/** The parts' attribute `name` end to end; undefined when none has it, null when they cannot be joined. */
function joinAttribute(parts: readonly BufferGeometry[], name: string): BufferAttribute | null | undefined {
  const all = parts.map((g) => g.getAttribute(name) as BufferAttribute | undefined);
  if (all.every((a) => !a)) return undefined;
  const first = all[0];
  if (!first || !(first instanceof BufferAttribute)) return null;
  for (const a of all) {
    if (!a || !(a instanceof BufferAttribute) || a.itemSize !== first.itemSize || a.normalized !== first.normalized
      || a.array.constructor !== first.array.constructor) return null;
  }
  const size = all.reduce((n, a) => n + a!.count * a!.itemSize, 0);
  const array = new (first.array.constructor as new (n: number) => TypedArray)(size);
  let at = 0;
  for (const a of all) {
    const length = a!.count * a!.itemSize;
    array.set(a!.array.subarray(0, length), at);
    at += length;
  }
  return new BufferAttribute(array, first.itemSize, first.normalized);
}

/** A geometry's triangles as indices (its own, or 0..n-1 for one drawn unindexed), offset by `base`, into `out` at `at`. */
function indicesInto(geometry: BufferGeometry, base: number, out: Uint32Array, at: number): number {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i++) out[at + i] = index.getX(i) + base;
    return at + index.count;
  }
  const count = geometry.getAttribute('position').count;
  for (let i = 0; i < count; i++) out[at + i] = i + base;
  return at + count;
}

/** Joins a body's parts, each set of parts once: `parts[k]` is the part of KIND k (null: none of it, at that level or on that body). The
 *  same parts give the same object; null when there is nothing, or when their attributes differ (they are then drawn apart). */
export function createPanelJoiner(): (parts: readonly (BufferGeometry | null)[]) => JoinedPanels | null {
  const made = new Map<string, JoinedPanels | null>();
  /** The joined vertices of parts over the same vertices (their own position attributes), shared by every set of their triangles: a level
   *  over a part's own vertices joins them once. */
  const verticesMade = new Map<string, ReadonlyMap<string, BufferAttribute> | null>();
  const ids = new WeakMap<object, number>();
  let next = 0;
  const idOf = (o: object): number => { let id = ids.get(o); if (id === undefined) { id = next++; ids.set(o, id); } return id; };
  return (parts) => {
    const key = parts.map((g) => (g ? idOf(g) : -1)).join(',');
    const cached = made.get(key);
    if (cached !== undefined) return cached;
    const present = parts.flatMap((g, kind) => (g ? [{ g, kind }] : []));
    let joined: JoinedPanels | null = null;
    if (present.length > 0) {
      const vertexKey = present.map((p) => `${p.kind}:${idOf(p.g.getAttribute('position'))}`).join(',');
      let attributes = verticesMade.get(vertexKey);
      if (attributes === undefined) {
        const own = new Map<string, BufferAttribute>();
        let joinable = true;
        for (const name of NAMES) {
          const a = joinAttribute(present.map((p) => p.g), name);
          if (a === null) { joinable = false; break; }
          if (a) own.set(name, a);
        }
        if (joinable && own.has('position')) {
          const mark = new Float32Array(present.reduce((n, p) => n + p.g.getAttribute('position').count, 0));
          let base = 0;
          for (const p of present) { const count = p.g.getAttribute('position').count; mark.fill(p.kind, base, base + count); base += count; }
          own.set('panel', new BufferAttribute(mark, 1));
          attributes = own;
        } else attributes = null;
        verticesMade.set(vertexKey, attributes);
      }
      if (attributes) {
        const corners = present.reduce((n, p) => n + (p.g.getIndex()?.count ?? p.g.getAttribute('position').count), 0);
        const index = new Uint32Array(corners);
        let base = 0, at = 0, casting = 0;
        for (const p of present) {
          at = indicesInto(p.g, base, index, at);
          if (p.kind <= KIND.panel) casting = at;
          base += p.g.getAttribute('position').count;
        }
        joined = { attributes, index: new BufferAttribute(index, 1), casting };
      }
    }
    made.set(key, joined);
    return joined;
  };
}

/** A geometry of its own over joined vertices, with this mesh's panel colours (an instanced attribute is a mesh's own). */
export function panelGeometry(joined: JoinedPanels, panelColor: InstancedBufferAttribute): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of joined.attributes) geometry.setAttribute(name, attribute);
  geometry.setIndex(joined.index);
  geometry.setAttribute('panelColor', panelColor);
  return geometry;
}

/** A part's material numbers, as its own material has them (`agents.ts` trim, cabin). */
export interface PartLook { readonly roughness: number; readonly metalness: number; readonly envMapIntensity: number }

/** A GLSL float, never written as an integer. */
const glsl = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** The body paint for a joined body: the paint's numbers on the shell and the panel (the panel's colour from the instance's `panelColor`
 *  instead of `instanceColor`), the trim's and the cabin's own numbers on theirs (`trimLook`, `cabinLook`), and no clearcoat there. The paint
 *  is a MeshPhysicalMaterial and the trim and cabin MeshStandardMaterials: without clearcoat the two are the same shading (three r186
 *  lights_physical_fragment: at the default ior 1.5 the physical specular colour is ((1.5 - 1) / (1.5 + 1))^2 = 0.04 and its F90 1.0, the
 *  standard's 0.04 and 1.0; meshphysical's clearcoat term is weighed by material.clearcoat, here 0). The trim and the cabin are untinted (their
 *  instance colour is white, `agents.ts` tintAt). */
export function panelPaint(paint: MeshPhysicalMaterial, trimLook: PartLook, cabinLook: PartLook): MeshPhysicalMaterial {
  const material = paint.clone();
  material.name = 'vehicle-body-paint';
  const pick = (paintValue: string, trimValue: number, cabinValue: number): string =>
    `( vKind < 1.5 ? ${paintValue} : vKind < 2.5 ? ${glsl(trimValue)} : ${glsl(cabinValue)} )`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float panel;\nattribute vec3 panelColor;\nvarying float vKind;')
      // three's color_vertex for vertex colours and instance colours, the instance's colour picked by the mark
      .replace('#include <color_vertex>', [
        'vColor = vec4( 1.0 );',
        'vColor.rgb *= color;',
        'vColor.rgb *= panel < 0.5 ? instanceColor.rgb : panel < 1.5 ? panelColor : vec3( 1.0 );',
        'vKind = panel;',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vKind;')
      // The environment's light read by three's own chunk, weighed by each part's own intensity.
      .replace('#include <envmap_physical_pars_fragment>', `#define kindEnvMapIntensity ${pick('envMapIntensity', trimLook.envMapIntensity, cabinLook.envMapIntensity)}\n`
        + ShaderChunk.envmap_physical_pars_fragment.replaceAll('envMapIntensity', 'kindEnvMapIntensity'))
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = ${pick('roughnessFactor', trimLook.roughness, cabinLook.roughness)};`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = ${pick('metalnessFactor', trimLook.metalness, cabinLook.metalness)};`)
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= vKind < 1.5 ? 1.0 : 0.0;\n#endif');
  };
  material.customProgramCacheKey = () => 'vehicle-body-paint';
  return material;
}
