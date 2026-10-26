import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, type Mesh, PMREMGenerator, Scene, type ShaderMaterial } from 'three';
import { createEnvironment } from '@render/environment';
import { ListeningCanvas, nullRenderer } from '../support/nullGpu';

/** THE SKY'S REFLECTION AFTER A LOST CONTEXT (`environment.ts`): the prefiltered map drawn anew when the context is back, the scene given it. */

afterEach(() => { vi.restoreAllMocks(); });

describe('the sky\'s reflection', () => {
  it('is drawn anew after the context is restored, and the scene reads the new one', () => {
    const canvas = new ListeningCanvas(64, 64);
    const renderer = nullRenderer({ canvas: canvas as unknown as HTMLCanvasElement });
    const scene = new Scene();
    const environment = createEnvironment(scene, renderer, { shadows: false, shadowMapSize: 512 });
    const first = environment.environmentMap();
    expect(scene.environment).toBe(first);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    const second = environment.environmentMap();
    expect(second).not.toBe(first);
    expect(scene.environment).toBe(second);
    // Switched off by the effects panel at the restore: the new one taken when it is switched back on, not the lost one.
    scene.environment = null;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(scene.environment).toBeNull();
    expect(environment.environmentMap()).not.toBe(second);
    environment.dispose();
    renderer.dispose();
  });

  it('is drawn again from the day sky it was made with, whatever the hour of the restore', () => {
    const zeniths: Color[] = [];
    const fromScene = PMREMGenerator.prototype.fromScene;
    vi.spyOn(PMREMGenerator.prototype, 'fromScene').mockImplementation(function (this: PMREMGenerator, probeScene, ...rest) {
      const probe = probeScene.children[0] as Mesh;
      zeniths.push(((probe.material as ShaderMaterial).uniforms['uZenith']!.value as Color).clone());
      return fromScene.call(this, probeScene, ...rest);
    });
    const canvas = new ListeningCanvas(64, 64);
    const renderer = nullRenderer({ canvas: canvas as unknown as HTMLCanvasElement });
    const environment = createEnvironment(new Scene(), renderer, { shadows: false, shadowMapSize: 512 });
    // Dawn (the audit's restore at 06:34): the drawn sky's zenith darker than the day's.
    environment.setTimeOfDay(6 * 60 + 34);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(zeniths).toHaveLength(2);
    expect(zeniths[1]!.equals(zeniths[0]!)).toBe(true);
    expect(zeniths[0]!.equals(new Color(0x4d7fc4))).toBe(true);
    environment.dispose();
    renderer.dispose();
  });
});
