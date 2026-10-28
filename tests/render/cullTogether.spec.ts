import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Frustum, Matrix4, MeshBasicMaterial, PerspectiveCamera, Vector3, type InstancedMesh } from 'three';
import { Rng } from '@core/rng';
import { type CellInstances, type KeptFrustum, type KindSpec, type Pack, createCellInstances, cullTogether, posesOf, setShadowSun } from '@render/cellInstances';
import { NEVER_NEAR, YAW_POSE } from '@render/instanceRuns';
import { m } from '@world/units';

/** ONE WALK OF THE VIEW FOR EVERY LAYER (`cellInstances.ts` cullTogether): what each layer draws is what its own walk drew. */

const STRIDE = YAW_POSE.stride;

function kinds(): KindSpec[] {
  const box = new BoxGeometry(1, 2, 1);
  box.computeBoundingSphere();
  const near = new MeshBasicMaterial(), far = new MeshBasicMaterial();
  return [
    // A kind with a far level and a least size: the ladder and its hysteresis.
    { tinted: true, levels: { reach: 1, far: 12, least: 2 }, meshes: [
      { name: 'tall', geometry: box, material: near, castShadow: true, receiveShadow: false, cards: false, far: false },
      { name: 'tall-far', geometry: box, material: far, castShadow: false, receiveShadow: false, cards: false, far: true },
    ] },
    // A kind drawn at every size.
    { tinted: false, meshes: [{ name: 'plain', geometry: box, material: near, castShadow: true, receiveShadow: false, cards: false, far: false }] },
  ];
}

/** `count` things of each kind round (cx, cz), scattered over `spread`. */
function packs(rng: Rng, spread: number, count: number): Map<number, Pack> {
  const out = new Map<number, Pack>();
  for (let kind = 0; kind < 2; kind++) {
    const data = new Float32Array(count * STRIDE), colours = new Float32Array(count * 3), scales = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = 0.5 + rng.float() * 8;
      data.set([(rng.float() - 0.5) * spread, rng.float() * m(20), (rng.float() - 0.5) * spread, rng.float() * 6, s, s, s, NEVER_NEAR], i * STRIDE);
      colours.set([rng.float(), rng.float(), rng.float()], i * 3);
      scales[i] = s;
    }
    out.set(kind, { data, colours, scales, count });
  }
  return out;
}

/** Each mesh's drawn count and the poses and tints it draws, in their positions. */
function drawn(layer: CellInstances): string[] {
  return (layer.meshes as InstancedMesh[]).map((mesh) => {
    const poses = Array.from((posesOf(mesh).buffer.array as Float32Array).subarray(0, mesh.count * STRIDE));
    const tints = mesh.instanceColor ? Array.from((mesh.instanceColor.array as Float32Array).subarray(0, mesh.count * 3)) : [];
    return `${mesh.name}:${mesh.count}:${mesh.visible}|${poses.join(',')}|${tints.join(',')}`;
  });
}

describe('cull together', () => {
  it('draws in every layer exactly what each layer culled alone draws, view after view', () => {
    const spread = m(4000);
    // Three layers of different margins (none, a street's, the sun's reach), twice: one twin culled alone, one together.
    const margins = [0, m(60), m(250)];
    const make = (): { layers: CellInstances[]; keys: object[][] } => ({ layers: margins.map((margin) => createCellInstances(kinds(), YAW_POSE, margin)), keys: margins.map(() => []) });
    const alone = make(), joint = make();
    const fill = (seed: number, round: number): void => {
      for (const twin of [alone, joint]) {
        const rng = new Rng(seed);
        twin.layers.forEach((layer, l) => {
          // Things come; past the first round half of those placed go (dead slots, then a repack: the shared tree made again).
          const removed = round === 0 ? [] : twin.keys[l]!.filter((_, i) => i % 2 === 0);
          twin.keys[l] = twin.keys[l]!.filter((key) => !removed.includes(key));
          const added = Array.from({ length: 12 }, () => ({ key: {}, packs: packs(rng, spread, 40) }));
          for (const a of added) twin.keys[l]!.push(a.key);
          layer.update({ removed, added });
        });
      }
    };
    const rng = new Rng(11);
    const views: { frustum: KeptFrustum; view: Matrix4 }[] = [];
    let at = new Vector3(0, m(30), 0);
    for (let v = 0; v < 40; v++) {
      // A flight: small steps (hysteresis held) and jumps, now and then a sun cascade's cover kept.
      at = v % 9 === 0 ? new Vector3((rng.float() - 0.5) * spread, m(5) + rng.float() * m(800), (rng.float() - 0.5) * spread)
        : at.clone().add(new Vector3((rng.float() - 0.5) * m(40), (rng.float() - 0.5) * m(10), (rng.float() - 0.5) * m(40)));
      const camera = new PerspectiveCamera(40 + rng.float() * 30, 1.6, 1, m(3000));
      camera.position.copy(at);
      camera.lookAt(at.x + (rng.float() - 0.5) * m(500), 0, at.z + (rng.float() - 0.5) * m(500));
      camera.updateMatrixWorld();
      const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const frustum = new Frustum().setFromProjectionMatrix(view) as KeptFrustum;
      if (v % 3 === 1) {
        frustum.keep = new Box3(new Vector3(at.x - m(300), -m(100), at.z - m(300)), new Vector3(at.x + m(300), m(200), at.z + m(300)));
        frustum.keepTexel = m(0.3);
      }
      views.push({ frustum, view });
    }
    let compared = 0;
    for (let round = 0; round < 3; round++) {
      fill(100 + round, round);
      setShadowSun(Math.cos(round), 1.5, Math.sin(round));
      for (const { frustum, view } of views) {
        for (const layer of alone.layers) layer.cull(frustum, view);
        cullTogether(() => { for (const layer of joint.layers) layer.cull(frustum, view); });
        alone.layers.forEach((layer, l) => {
          const a = drawn(layer), b = drawn(joint.layers[l]!);
          expect(b).toEqual(a);
          compared += a.length;
        });
      }
    }
    // The views drew something (the comparison is not of empty meshes).
    expect(compared).toBeGreaterThan(0);
    expect(alone.layers.some((layer) => (layer.meshes as InstancedMesh[]).some((mesh) => mesh.count > 0))).toBe(true);
    for (const layer of [...alone.layers, ...joint.layers]) layer.dispose();
  });

  it('walks a layer culled by another view inside alone, and refuses a walk inside a walk', () => {
    const layer = createCellInstances(kinds(), YAW_POSE, 0);
    layer.update({ removed: [], added: [{ key: {}, packs: packs(new Rng(3), m(200), 30) }] });
    const view = new Matrix4().makeOrthographic(-m(500), m(500), m(500), -m(500), -m(500), m(500));
    const frustum = new Frustum().setFromProjectionMatrix(view);
    const other = new Matrix4().makeOrthographic(-m(100), m(100), m(100), -m(100), -m(500), m(500));
    const twin = createCellInstances(kinds(), YAW_POSE, 0);
    twin.update({ removed: [], added: [{ key: {}, packs: packs(new Rng(3), m(200), 30) }] });
    cullTogether(() => {
      layer.cull(frustum, view);
      // Another view: walked at once by its own tree.
      twin.cull(new Frustum().setFromProjectionMatrix(other), other);
      expect((twin.meshes as InstancedMesh[]).some((mesh) => mesh.count > 0)).toBe(true);
    });
    expect((layer.meshes as InstancedMesh[]).some((mesh) => mesh.count > 0)).toBe(true);
    expect(() => cullTogether(() => cullTogether(() => {}))).toThrow();
    layer.dispose();
    twin.dispose();
  });
});
