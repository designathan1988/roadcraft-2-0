import { describe, expect, it, vi } from 'vitest';
import { type Material, ShaderLib, Texture, UniformsUtils, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { createMaterials } from '@render/materials';
import { ROAD_CODE, ROAD_WEAR } from '@render/mesh/roadEdges';
import { type WearField, applyRoadWear } from '@render/wear';

/** The baked textures as plain ones (not in Node): a texture is a uniform, nothing of the source nor the key. */
vi.mock('@render/surfaceTextures', async (actual) => ({
  ...(await actual<typeof import('@render/surfaceTextures')>()),
  surfaceTexture: () => new Texture(),
}));

/** THE ROADS' SURFACES THAT DRAW FROM THE SAME SOURCE SHARE ONE PROGRAM (r186 `WebGLPrograms.getProgramCacheKey`: the material's kind, its parameters and `customProgramCacheKey`; each material still runs its own `onBeforeCompile` and keeps its own uniforms, `WebGLRenderer.getProgram`) */

/** A material's source and uniforms as three hands them to its patches, then as they come out. */
function compiled(material: Material): { vertex: string; fragment: string; uniforms: Record<string, { value: unknown }> } {
  const shader = {
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
    uniforms: UniformsUtils.clone(ShaderLib.standard.uniforms),
  } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader, uniforms: shader.uniforms as Record<string, { value: unknown }> };
}

describe("the roads' programs", () => {
  const m = createMaterials(1);
  // The wear the renderer puts on the carriageway and the footway (`renderer.ts`): on the one road material, by the surface's code.
  const wear = { texture: new Texture(), window: { value: null } } as unknown as WearField;
  applyRoadWear(m.road, wear, ROAD_WEAR);
  const roads = { asphalt: m.asphalt, asphaltRaised: m.asphaltRaised, footway: m.footway, kerb: m.kerb, verge: m.verge, deck: m.deck, parapet: m.parapet };

  it('key a surface by what its source is, never by its name: one program for every road surface, the parapet its own', () => {
    const key = (x: Material): string => x.customProgramCacheKey();
    // Every road surface (the carriageway, its raised crossings, the footway, the kerb, the verge, the deck's edge): one material, one source, one key.
    const kerb = compiled(m.kerb);
    for (const other of [m.asphalt, m.asphaltRaised, m.footway, m.verge, m.deck]) {
      const out = compiled(other);
      expect(out.vertex).toBe(kerb.vertex);
      expect(out.fragment).toBe(kerb.fragment);
      expect(key(other)).toBe(key(m.kerb));
      // Each surface's own close-zoom layer and numbers: its row of the look table, by the code its vertices carry (`mesh/roadEdges.ts`).
      expect(out.uniforms['uRoadDetails']).toBeDefined();
      expect(out.uniforms['uRoadLooks']).toBeDefined();
    }
    // The macro tile of each surface's close-zoom layer (row B, z): the verge's not the kerb's.
    const macroTile = (code: number): number => (kerb.uniforms['uRoadLooks']!.value as Float32Array)[code * 12 + 6]!;
    expect(macroTile(ROAD_CODE.planting)).not.toBe(macroTile(ROAD_CODE.kerb));
    // A source that differs keeps its own key: the roads' one material, and the parapet without the road's surfaces, lots and wear.
    const distinct = new Set(Object.values(roads).map(key));
    expect(distinct.size).toBe(2);
    expect(key(m.parapet)).not.toBe(key(m.road));
    // And the same key never stands for two sources.
    const byKey = new Map<string, string>();
    for (const material of Object.values(roads)) {
      const out = compiled(material);
      const source = out.vertex + out.fragment;
      const known = byKey.get(key(material));
      if (known !== undefined) expect(source).toBe(known); else byKey.set(key(material), source);
    }
  });
});
