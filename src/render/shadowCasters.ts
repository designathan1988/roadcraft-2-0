import type { BufferGeometry, InstancedBufferGeometry, InstancedMesh, Mesh } from 'three';

/** CASTERS BY SIZE AND BY CASCADE: a mesh drawn into a sun cascade only when it holds instances and its widest thing reaches a texel there (`sunCascades.ts`). */

/** A mesh that casts as its maker says (`casts`), into the cascades where `radius` (world units, its widest thing drawn) is at least a texel: under that, its shadow is a smudge PCF spreads away, as a mover's (`sunCascades.ts` drawnIn). */
export interface SizedCaster {
  readonly mesh: Mesh;
  readonly casts: boolean;
  radius(): number;
  /** Texels its radius must span to cast (1 when none): a small thing's shadow narrower than that is a smudge PCF spreads away. */
  readonly texels?: number;
  /** Its instances drawn in the colour pass and into the cascades, when they differ (`cellInstances.ts`: what stands off the frame under a cascade casts and is not drawn): `count` set to each for its passes. */
  readonly counts?: { colour(): number; shadow(): number };
  /** The same for a mesh whose instances are its geometry's (`InstancedBufferGeometry.instanceCount`, the poles' wires): drawn into the
   *  cascades alone when its colour is 0 (`poleStores.ts` WireStore). */
  readonly instances?: { colour(): number; shadow(): number };
  /** Its shape in a cascade of `texel` and in the colour pass, when the camera chooses the colour's (`poleLayer.ts`): the cascade's by its texel alone, so the shadow does not follow the camera's level. */
  readonly levels?: { shadow(texel: number): BufferGeometry; colour(): BufferGeometry };
  /** Drawn into the cascades alone, none of it in the colour pass (`poleStores.ts`): hidden between the passes and shown for a cascade's pass
   *  where it casts, as a building part's caster (`partCells.ts` castInto). Its maker keeps it hidden and says in `userData.shadowOnly` whether
   *  it holds anything (the casters' signature reads it hidden then, `renderer.ts` casterChanges). DO NOT leave it visible with no instance in
   *  colour: three still set up its program and uniforms in every colour pass - 46 of the 278 draws of a frame drew nothing (audit P46). */
  readonly shadowOnly?: boolean;
}

const casters = new Set<SizedCaster>();

/** The texel of the cascade being drawn (world units), 0 between the passes: a uniform for a depth material whose geometry merges parts of
 *  different sizes, each leaving the cascade where it would have as a mesh of its own (`signals.ts` frame). */
export const casterTexel = { value: 0 };

/** `caster` chosen at each cascade from now on; the function returned takes it off (its mesh disposed). Its mesh knows it (`userData.sizedCaster`):
 *  the casters' signature reads what it casts, not what the colour pass draws (`castShadowKey`). */
export function castBySize(caster: SizedCaster): () => void {
  casters.add(caster);
  caster.mesh.userData['sizedCaster'] = caster;
  return () => {
    casters.delete(caster);
    if (caster.mesh.userData['sizedCaster'] === caster) delete caster.mesh.userData['sizedCaster'];
  };
}

/** Each caster's `castShadow` for a cascade of `texel` world units; null: back to what its maker set, between the shadow passes (what the programs compiled ahead look at, `uploads.ts` shadowStandIns). */
export function castCastersInto(texel: number | null): void {
  casterTexel.value = texel ?? 0;
  for (const c of casters) {
    const instanced = c.mesh as InstancedMesh;
    if (c.counts) instanced.count = texel === null ? c.counts.colour() : c.counts.shadow();
    if (c.instances) (c.mesh.geometry as InstancedBufferGeometry).instanceCount = texel === null ? c.instances.colour() : c.instances.shadow();
    if (c.levels) c.mesh.geometry = texel === null ? c.levels.colour() : c.levels.shadow(texel);
    if (texel === null) {
      c.mesh.castShadow = c.casts;
      if (c.shadowOnly) c.mesh.visible = false;
      continue;
    }
    const holds = !instanced.isInstancedMesh || instanced.count > 0;
    c.mesh.castShadow = c.casts && holds && c.radius() >= texel * (c.texels ?? 1);
    if (c.shadowOnly) {
      const drawn = !c.instances || (c.mesh.geometry as InstancedBufferGeometry).instanceCount > 0;
      c.mesh.visible = c.mesh.castShadow && drawn && c.mesh.userData['shadowOnly'] === true;
    }
  }
}

/** What a mesh casts as the casters' signature reads it between the passes (`renderer.ts` casterChanges): its instances in the cascades, and
 *  whether its shape there is the texel's alone (then none of the colour's level is read). Null: a mesh as it stands. */
export function castShadowKey(mesh: Mesh): { readonly count: number | null; readonly byTexel: boolean } | null {
  const c = mesh.userData['sizedCaster'] as SizedCaster | undefined;
  if (!c) return null;
  return { count: c.counts ? c.counts.shadow() : c.instances ? c.instances.shadow() : null, byTexel: c.levels !== undefined };
}
