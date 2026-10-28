import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, InstancedMesh, MeshStandardMaterial, Scene } from 'three';
import { litStandIns } from '@render/shaderCatalogue';
import { shadowStandIns } from '@render/uploads';

/** WHAT COMES AFTER THE OPENING IS COMPILED WITH IT (`renderer.ts` openingWarm): the layers' stand-ins in the scene, hidden, when the
 *  opening's catalogue walks it, so no part, sign or road is first built in a camera move (`lab-reports/move-*.md`, 2026-10-27). */

describe('the opening compiles what comes in after it', () => {
  it('takes a hidden group of stand-ins in the scene into the world family, lit and cast', () => {
    const scene = new Scene();
    const holder = new Group();
    holder.visible = false;
    const part = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 1);
    part.castShadow = true;
    holder.add(part);
    scene.add(holder);
    const lit = litStandIns([scene], false);
    expect(lit.children.some((o) => (o as InstancedMesh).material === part.material)).toBe(true);
    const shadow = shadowStandIns(scene);
    expect(shadow.children.length).toBeGreaterThan(0);
  });

  it('puts the warm sets in the scene before the opening asks its programs', () => {
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    const asked = source.indexOf("openingPrograms = 'asked';");
    expect(asked).toBeGreaterThan(0);
    const block = source.slice(asked, source.indexOf('programs.compile(scene);', asked));
    expect(block).toMatch(/openingWarm\(\)/);
    const warm = /const openingWarm = [^]*?\n {2}\};/.exec(source)?.[0] ?? '';
    for (const set of ['roadWarmSet()', 'blastWarmSet()', 'previewWarmSet()']) expect(warm).toContain(set);
    expect(warm).toMatch(/scene\.add\(holder\)/);
    // Let go only once the opening's programs are built.
    expect(warm).toMatch(/programs\.ready[^]*scene\.remove\(holder\)/);
  });
});
