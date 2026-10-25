import { describe, expect, it } from 'vitest';
import { type Material, ShaderLib, UniformsUtils, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';

import { Rng } from '@core/rng';
import { instantiate } from '@world/buildings/blueprints';
import { madeToMeasure } from '@world/buildings/procedural';
import type { Building, BuildingId } from '@world/buildings/types';
import { FINISHES } from '@world/buildings/materials';
import { m } from '@world/units';
import { emitProgram } from '@render/buildings/buildingMesh';
import { createShellMaterial, finishFar } from '@render/buildings/finishes';
import { createBuildingKit } from '@render/buildings/kit';
import { CELL_DETAIL, CURTAIN_WALL, type MassingChunk, TILE_DETAIL, massFloor, massOf } from '@render/buildings/massing';

/** THE GLASS TOWERS FROM AFAR: a curtain wall's masses keep the windows the detail cuts in it and its storeys' spandrels between them, drawn in
 *  the glass finish's own look from afar (`massingMaterial.ts`), and a tile keeps the plant on its roofs (`massing.ts` TILE_DETAIL). */

const flat = (): number => 0;
/** The study's towers on the large lot (40 x 36 m): the office of the glass style (its walls the 'glass' finish) and the block of flats in ceramic. */
function tower(use: 'commercial' | 'residential', seed: number): Building {
  const made = madeToMeasure(use, 'high', { W: m(40), D: m(36) }, new Rng(seed));
  return { ...instantiate(made.body, { x: 0, y: 0 }, 0), id: 1 as BuildingId } as Building;
}
const massesAt = (b: Building, detail = CELL_DETAIL): MassingChunk => {
  const program = emitProgram(b, flat, undefined, flat, { near: false, far: false }, { floor: massFloor(b, flat) ?? null });
  const chunk = massOf(program, detail);
  if (!chunk) throw new Error('the tower has no masses');
  return chunk;
};
/** Each wall vertex's glass share and its window's sill and head (`massing.ts` windowCode): the vertices of a face that carries a facade. */
function walls(chunk: MassingChunk): { share: number; sill: number; head: number }[] {
  const out: { share: number; sill: number; head: number }[] = [];
  for (let v = 0; v < chunk.window.length; v++) {
    if (!(chunk.facade[v * 4 + 1]! > 0)) continue;
    const code = chunk.window[v]!;
    out.push({ share: chunk.glazing[v * 2]!, sill: Math.floor(code / 32) / 31, head: (code % 32) / 31 });
  }
  return out;
}
const topOf = (chunk: MassingChunk): number => { let top = -Infinity; for (let i = 1; i < chunk.position.length; i += 3) top = Math.max(top, chunk.position[i]!); return top; };

function compiled(material: Material): string {
  const shader = {
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
    uniforms: UniformsUtils.clone(ShaderLib.standard.uniforms),
  } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as WebGLRenderer);
  return shader.fragmentShader;
}

describe('a glass tower from afar', () => {
  it("keeps its curtain wall's windows in its masses, their share over CURTAIN_WALL, their sill and head the detail's", () => {
    const glass = walls(massesAt(tower('commercial', 1)));
    expect(glass.length).toBeGreaterThan(0);
    for (const w of glass) {
      expect(w.share).toBeGreaterThanOrEqual(CURTAIN_WALL);
      expect(w.share).toBeLessThan(CURTAIN_WALL + 1);
    }
    // Its storeys' wide windows (`architecture.ts` glass: 92 to 94 % of the bay, 78 to 82 % of the storey over a 0.25 m sill), not one pane.
    const storeys = glass.filter((w) => w.share - CURTAIN_WALL > 0.85);
    expect(storeys.length).toBeGreaterThan(glass.length / 2);
    for (const w of storeys) {
      expect(w.share - CURTAIN_WALL).toBeLessThan(0.95);
      expect(w.sill).toBeGreaterThan(0);
      expect(w.head).toBeLessThan(1);
      expect(w.head - w.sill).toBeGreaterThan(0.7);
    }
  });

  it("leaves every other wall's share under CURTAIN_WALL", () => {
    const masonry = walls(massesAt(tower('residential', 1)));
    expect(masonry.length).toBeGreaterThan(0);
    for (const w of masonry) expect(w.share).toBeLessThan(CURTAIN_WALL);
  });

  it("draws the spandrels in the glass finish's look from afar: its metal, its gloss and its sky", () => {
    const kit = createBuildingKit();
    const fragment = compiled(kit.massing);
    const look = finishFar().glass;
    expect(fragment).toContain(`metalnessFactor = mix(metalnessFactor, ${look.metal.toFixed(5)}, massCurtain * (1.0 - massGlass));`);
    expect(fragment).toContain(`roughnessFactor = mix(mix(roughnessFactor, ${look.rough.toFixed(5)}, massCurtain), 0.06, massGlass);`);
    expect(fragment).toContain('radiance *= mix(1.0, ');
    kit.dispose();
  });

  it("gives the facade level's far shell the glass's metal its tones carry", () => {
    const material = createShellMaterial({ far: true });
    const shader = { vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, uniforms: UniformsUtils.clone(ShaderLib.standard.uniforms) } as unknown as WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as WebGLRenderer);
    const looks = (shader.uniforms['shellLooks'] as { value: Float32Array }).value;
    const glass = FINISHES.indexOf('glass') * 8;
    // Metal read from its tones (`FAR_FINISH`: the metalness times `shellFar.y`, the glass's metal from afar), not left at 0.
    expect(looks[glass + 2]).toBe(1);
    expect(looks[glass + 4]).toBe(1);
    expect(finishFar().glass.metal).toBeGreaterThan(0.5);
    material.dispose();
  });

  it('keeps the plant on its roof at the tile: its machine rooms stand as high as at the cell', () => {
    const b = tower('commercial', 1);
    const cell = massesAt(b, CELL_DETAIL), tile = massesAt(b, TILE_DETAIL);
    expect(topOf(tile)).toBeCloseTo(topOf(cell), 6);
    // What it still leaves out stays under the far level's own error.
    expect(tile.error).toBeLessThanOrEqual(TILE_DETAIL.drop);
  });
});
