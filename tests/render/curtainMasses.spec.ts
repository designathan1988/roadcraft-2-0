import { FACADE_BYTES } from '@render/buildings/cellArrays';
import { describe, expect, it } from 'vitest';
import { ShaderLib, UniformsUtils, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';

import { Rng } from '@core/rng';
import { instantiate } from '@world/buildings/blueprints';
import { madeToMeasure } from '@world/buildings/procedural';
import type { Building, BuildingId } from '@world/buildings/types';
import { FINISHES } from '@world/buildings/materials';
import { m } from '@world/units';
import { type MassShells, emitProgram, massShells } from '@render/buildings/buildingMesh';
import { cellMass } from '@render/buildings/cellArrays';
import { cellMesh } from '@render/buildings/massCells';
import { createShellMaterial, finishFar } from '@render/buildings/finishes';
import { createBuildingKit } from '@render/buildings/kit';
import { CELL_DETAIL, TILE_DETAIL, massFloor } from '@render/buildings/massing';

/** THE GLASS TOWERS FROM AFAR: a curtain wall's masses keep the windows the detail cuts in it and its storeys' spandrels between them, laid as the
 *  facade level lays them (`buildingMesh.ts` massShells: its runs of bays, their openings the detail's, their wall the glass finish drawn by the
 *  shells' far look), and a tile keeps the plant on its roofs (`massing.ts` TILE_DETAIL). */

const flat = (): number => 0;
/** The study's towers on the large lot (40 x 36 m): the office of the glass style (its walls the 'glass' finish) and the block of flats in ceramic. */
function tower(use: 'commercial' | 'residential', seed: number): Building {
  const made = madeToMeasure(use, 'high', { W: m(40), D: m(36) }, new Rng(seed));
  return { ...instantiate(made.body, { x: 0, y: 0 }, 0), id: 1 as BuildingId } as Building;
}
const massesAt = (b: Building, detail = CELL_DETAIL): MassShells => {
  const program = emitProgram(b, flat, undefined, flat, { near: false, far: false }, { floor: massFloor(b, flat) ?? null });
  const chunk = massShells(program, detail);
  if (!chunk) throw new Error('the tower has no masses');
  return chunk;
};
/** Each run vertex's opening (shares of its bay across, and of its storey up) and its wall's finish (`FINISHES`), as the facade level's shader reads them. */
function walls(chunk: MassShells): { a0: number; a1: number; sill: number; head: number; finish: string }[] {
  const out: { a0: number; a1: number; sill: number; head: number; finish: string }[] = [];
  for (const run of Object.values(chunk.runs ?? {})) {
    if (!run) continue;
    for (let v = 0; v < run.position.length / 3; v++) {
      const o = run.opening, at = v * FACADE_BYTES;
      out.push({ a0: o[at]! / 255, a1: o[at + 1]! / 255, sill: o[at + 2]! / 255, head: o[at + 3]! / 255, finish: FINISHES[run.paint[v * 4 + 3]! % 256]! });
    }
  }
  return out;
}
const topOf = (chunk: MassShells): number => {
  let top = -Infinity;
  for (const f of [...Object.values(chunk.shells), ...Object.values(chunk.runs ?? {})]) if (f) for (let i = 1; i < f.position.length; i += 3) top = Math.max(top, f.position[i]!);
  return top;
};

describe('a glass tower from afar', () => {
  it("keeps its curtain wall's windows in its masses as the facade level's runs, their opening the detail's, their wall glass", () => {
    const glass = walls(massesAt(tower('commercial', 1))).filter((w) => w.finish === 'glass');
    expect(glass.length).toBeGreaterThan(0);
    // Its storeys' wide windows (`architecture.ts` glass: 92 to 94 % of the bay, 78 to 82 % of the storey over a 0.25 m sill), not one pane.
    const storeys = glass.filter((w) => w.a1 - w.a0 > 0.85);
    expect(storeys.length).toBeGreaterThan(glass.length / 2);
    for (const w of storeys) {
      expect(w.a1 - w.a0).toBeLessThan(0.96);
      expect(w.sill).toBeGreaterThan(0);
      expect(w.head).toBeLessThan(1);
      expect(w.head - w.sill).toBeGreaterThan(0.7);
    }
  });

  it('lays every other wall in its own finish, no glass', () => {
    const masonry = walls(massesAt(tower('residential', 1)));
    expect(masonry.length).toBeGreaterThan(0);
    for (const w of masonry) expect(w.finish).not.toBe('glass');
  });

  it("draws its glass walls by the facade level's material, its other faces by the shells'", () => {
    const kit = createBuildingKit();
    const mesh = cellMesh(cellMass([massesAt(tower('commercial', 1))])!, kit);
    expect(mesh.material).toEqual([kit.shellMaterial, kit.facade]);
    expect(mesh.geometry.groups.some((g) => g.materialIndex === 1 && g.count > 0)).toBe(true);
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
