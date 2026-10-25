import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataTexture, FloatType, Matrix4, RGBAFormat, ShaderLib, Texture, type Material, type Mesh, type SkinnedMesh } from 'three';
import { createAgentMeshes } from '@render/agents';
import { PartLevelMaker } from '@render/vehicleLevels';
import { createPersonMaterials } from '@render/people/personMaterial';
import { personProgramStandIns } from '@render/riggedCitizens';
import { programKeys } from './programKeys';

/** The shader programs the people's and vehicles' meshes ask three for: one per shader, never two keys for the same text nor one key for two texts */

/** A material's program as three would build it: its key and its shader text. */
function shaded(material: Material & { onBeforeCompile: (shader: never, renderer: never) => void; customProgramCacheKey: () => string }, lib: keyof typeof ShaderLib): { key: string; text: string } {
  const source = ShaderLib[lib]!;
  const shader = { vertexShader: source.vertexShader, fragmentShader: source.fragmentShader, uniforms: {} as Record<string, { value: unknown }> };
  material.onBeforeCompile(shader as never, null as never);
  return { key: material.customProgramCacheKey(), text: shader.vertexShader + shader.fragmentShader };
}

/** Every body's levels, made once for the file's meshes (the page makes them once too, `createAgentMeshes`). */
const levels = new PartLevelMaker();

describe('the programs of the agents', () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it("vehicles: the meshes of every body and part ask 11 programs of three (the 10th the body joined with its roof, `vehiclePanels.ts`; the 11th the glazing that lowers its windows, `vehicleWindows.ts`)", () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0, undefined, levels);
    expect(programKeys(agents.meshes).size).toBe(11);
    agents.dispose();
  });

  it('vehicles: a body joined with its roof is drawn where the shells were, before the lamps and the trim (three sorts the opaque by material id)', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0, undefined, levels);
    const meshes = agents.meshes.filter((o): o is Mesh => (o as Mesh).isMesh === true);
    const id = (pattern: RegExp): number => (meshes.find((o) => pattern.test(o.name))!.material as Material & { id: number }).id;
    expect(id(/^car-sedan-sedan-body$/)).toBe(id(/^car-sedan-sedan-shell$/) + 1);
    expect(id(/^vehicle-lamps$/)).toBeGreaterThan(id(/^car-sedan-sedan-body$/));
    expect(id(/^car-sedan-sedan-trim$/)).toBeGreaterThan(id(/^car-sedan-sedan-body$/));
    agents.dispose();
  });

  it('cooked people: every body is one lit program and one depth program, whatever its atlas, its cut or its bones', () => {
    const palette = { uniform: { value: new DataTexture(new Float32Array(16), 4, 1, RGBAFormat, FloatType) }, base: { value: 0 } };
    const body = (): SkinnedMesh => ({ bindMatrix: new Matrix4(), bindMatrixInverse: new Matrix4() } as unknown as SkinnedMesh);
    const bodies = [[new Texture(), 0.35], [new Texture(), 0.5], [new Texture(), 0.35]] as const;
    const lit = bodies.map(([atlas, cut]) => shaded(createPersonMaterials(atlas, cut, palette, body()).lit, 'physical'));
    const depth = bodies.map(([atlas, cut]) => shaded(createPersonMaterials(atlas, cut, palette, body()).depth, 'depth'));
    expect(new Set(lit.map((s) => s.key))).toEqual(new Set(['person-v3']));
    expect(new Set(lit.map((s) => s.text)).size).toBe(1);
    expect(new Set(depth.map((s) => s.key))).toEqual(new Set(['person-depth-v3']));
    expect(new Set(depth.map((s) => s.text)).size).toBe(1);
    expect(lit[0]!.text).not.toBe(depth[0]!.text);
  });

  it('cooked people: the stand-ins the shader catalogue compiles ahead are those three programs, lit, cast, and the card', () => {
    const { lit, shadow } = personProgramStandIns();
    const keys = new Set<string>();
    for (const group of [lit, shadow]) group.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) keys.add(material.customProgramCacheKey());
      if (mesh.customDepthMaterial) keys.add(mesh.customDepthMaterial.customProgramCacheKey());
    });
    expect([...keys].sort()).toEqual(['person-depth-v3', 'person-impostor-v3', 'person-v3']);
  });
});
