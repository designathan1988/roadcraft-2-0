import { describe, expect, it } from 'vitest';
import { ShaderLib, UniformsUtils, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { createFacadeMaterial } from '@render/buildings/facadeLevel';
import { createShellMaterial } from '@render/buildings/finishes';

/** THE FAR LEVELS' COVER KEEPS THE WALL'S MATERIAL (`facadeLevel.ts` facadeColour): the share of a bay its slabs and balconies cover is drawn
 *  in their colour, with the wall's roughness, metal and sky reflection, so the shares the material weighs still make the whole pixel. */

/** The facade level's fragment shader as its material patches three's standard program (its own patch, then the shell's). */
function facadeFragment(): string {
  const shell = createShellMaterial({ far: true });
  const material = createFacadeMaterial(shell, {
    glass: shell.clone(), glassDark: shell.clone(), door: shell.clone(), shutter: shell.clone(), frame: shell.clone(),
  }, { roomsAwake: { value: 0 }, massingNight: { value: 0 } });
  const shader = {
    vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader,
    uniforms: UniformsUtils.clone(ShaderLib.standard.uniforms), defines: {},
  } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, null as unknown as WebGLRenderer);
  return shader.fragmentShader;
}

describe('the far levels\' cover', () => {
  const source = facadeFragment();
  const mix = 'diffuseColor.rgb = mix(diffuseColor.rgb, vFacadeCover.rgb, facadeCovered);';
  const coverAt = source.indexOf(mix);

  it('is mixed into the colour once', () => {
    expect(coverAt).toBeGreaterThan(0);
    expect(source.indexOf('vFacadeCover.rgb', coverAt + mix.length)).toBe(-1);
  });

  it('takes nothing from the shares the roughness, the metal and the sky reflection are weighed by', () => {
    // Every statement after the cover's mix: none writes the wall's share (it weighs the roughness, metal, normal and sky below).
    const after = source.slice(coverAt).replace(/\/\/[^\n]*/g, '');
    expect(after).not.toMatch(/\bfacadeWall\s*(?:[*+/-]?=)(?!=)/);
    // Those weights are the wall's, the frame's, the glass's and the solid's shares: the wall's being one less the others (the whole pixel).
    expect(source).toMatch(/facadeWall\s*=\s*1\.0\s*-\s*facadeFrame\s*-\s*facadeGlass\s*-\s*facadeSolid;/);
    for (const weighed of ['roughnessFactor = roughnessFactor * facadeWall', 'metalnessFactor = metalnessFactor * facadeWall', 'radiance *= facadeWall']) {
      expect(after.includes(weighed), weighed).toBe(true);
    }
  });
});
