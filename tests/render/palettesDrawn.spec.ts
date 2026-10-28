import { describe, expect, it, vi } from 'vitest';
import type { InstancedMesh, WebGLRenderer } from 'three';
import type { PedView } from '@sim/people/view';
import { perM } from '@world/units';

/** THE PEOPLE'S PALETTES ARE BLENDED FOR THE FIGURES THAT READ THEM (MISSION 1b): a figure drawn as a picture card reads no palette
 *  (`riggedCitizens.ts` emit), so it takes no row of the palette pass, and a body drawn only as cards runs no pass at all. The body's
 *  file, its levels and the palette pass are the game's own; only the file read (a fetch), the clips' bake (a worker and the motion
 *  library) and the gait are stood in for, and the pass's draw is recorded instead of sent to a GPU. */

const { rendered } = vi.hoisted(() => ({ rendered: [] as number[] }));

vi.mock('@render/people/cookedLoad', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { DataTexture } = await import('three');
  const { assemblePerson, decodeCookedPerson } = await import('@render/people/cookedPerson');
  return {
    loadCookedPerson: (id: string) => {
      const bytes = readFileSync(resolve('public/models/citizens/people', `${id}.bin`));
      const { person } = decodeCookedPerson(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      return Promise.resolve({ scene: assemblePerson(person), header: person.header, atlas: new DataTexture(new Uint8Array(4), 1, 1) });
    },
  };
});

vi.mock('@render/bakePool', async (importOriginal) => {
  const real = await importOriginal<typeof import('@render/bakePool')>();
  return { ...real, bakeInWorker: () => Promise.resolve(null) };
});

vi.mock('@render/citizenBake', async (importOriginal) => {
  const real = await importOriginal<typeof import('@render/citizenBake')>();
  const { SkinnedMesh } = await import('three');
  return {
    ...real,
    // One still clip at every index a body plays from, sized to the body's bones (twelve floats a bone, `frames + 2` rows).
    bake: (scene: import('three').Object3D) => {
      let bones = 0;
      scene.traverse((o) => { if (o instanceof SkinnedMesh && bones === 0) bones = o.skeleton.bones.length; });
      const clip: import('@render/citizenBake').ClipFrames = {
        data: new Float32Array(4 * bones * 12), frames: 2, duration: 1, stride: 1, pelvisY: 1, pelvisX: 0, pelvisZ: 0, loop: true,
      };
      const most = Math.max(...Object.values(real.GAIT_AT), ...Object.values(real.RIDER_AT), ...Object.values(real.CARRY_AT).map((at) => at ?? 0));
      return Promise.resolve({ clips: Array.from({ length: most + 1 }, () => clip), helmet: null, stopTilt: { moto: 0, bike: 0 }, deferred: new Map() });
    },
  };
});

vi.mock('@render/citizenGait', async (importOriginal) => {
  const real = await importOriginal<typeof import('@render/citizenGait')>();
  return {
    ...real,
    createGait: () => ({ base: 0 }),
    stepGait: () => {},
    gaitPlays: (_gait: unknown, _clips: unknown, out: { name: string; frame: number; weight: number }[]) => {
      out[0] = { name: 'walk', frame: 0, weight: 1 };
      return 1;
    },
  };
});

vi.mock('@render/people/crowdAnimation', async (importOriginal) => {
  const real = await importOriginal<typeof import('@render/people/crowdAnimation')>();
  return {
    ...real,
    createPalettePass: (...args: Parameters<typeof real.createPalettePass>) => {
      const pass = real.createPalettePass(...args);
      // The pass's draw, recorded: how many palette rows it would blend.
      pass.render = (_renderer, rows) => { rendered.push(rows); };
      return pass;
    },
  };
});

/** A walker standing still, alone. */
const ped = {
  id: 7, gender: 'f', ageClass: 'adult', party: { id: 7, size: 1, archetype: 'solo', hasChild: false }, age: 3,
} as unknown as PedView;

/** A figure left of the origin stands under the card's size on the screen, one right of it well over (`IMPOSTOR_PIXELS` 8). */
const pixels = (x: number): number => (x < 0 ? 4 : 400);
/** A zoom where no face is drawn (`citizenBandAt` band 2): each figure's level by its size on the screen alone. */
const ZOOM = perM(4);
const renderer = {} as WebGLRenderer;

describe('people palettes', () => {
  it('blends a palette row only for the figures at a mesh level, none for a body drawn as cards alone', async () => {
    const { createRiggedCitizens } = await import('@render/riggedCitizens');
    const citizens = createRiggedCitizens();
    // Drawn every frame until the body is in (a load is let go when nobody asks for it two frames running).
    for (let frame = 0; citizens.loadedIndices().length === 0; frame++) {
      if (frame > 2000) throw new Error('the body never loaded');
      citizens.begin(2, ZOOM, pixels);
      citizens.draw(ped, 10, 0, 0, 0, 1);
      await new Promise((done) => setTimeout(done, 0));
    }

    // Two figures far off: cards only.
    citizens.begin(2, ZOOM, pixels);
    citizens.draw(ped, -10, 0, 0, 0, 1);
    citizens.draw(ped, -20, 0, 0, 0, 1);
    rendered.length = 0;
    citizens.renderPalettes(renderer);
    expect(rendered).toEqual([]);

    // Cards and meshes in one body: the pass blends the two mesh figures' rows, and each reads its own.
    citizens.begin(2, ZOOM, pixels);
    citizens.draw(ped, -10, 0, 0, 0, 1);
    citizens.draw(ped, 10, 0, 0, 0, 1);
    citizens.draw(ped, -20, 0, 0, 0, 1);
    citizens.draw(ped, 20, 0, 0, 0, 1);
    rendered.length = 0;
    citizens.renderPalettes(renderer);
    expect(rendered).toEqual([2]);
    citizens.finish();
    const level = citizens.group.children.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh && o.name.startsWith('citizen-')
      && !o.name.endsWith('@card') && (o as InstancedMesh).count > 0);
    expect(level).toHaveLength(1);
    expect(level[0]!.count).toBe(2);
    expect([...(level[0]!.geometry.getAttribute('citizenRow').array as Float32Array).subarray(0, 2)]).toEqual([0, 1]);
    citizens.dispose();
  }, 60_000);
});
