import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BoxGeometry, BufferAttribute, type BufferGeometry, DataUtils, InstancedMesh, type Material, MeshStandardMaterial, RGBAFormat, ShaderLib,
  UnsignedByteType, type Vector2,
} from 'three';
import { HYSTERESIS } from '@render/cellInstances';
import { PICTURE_PX, PICTURE_WIND, createImpostors, createPlantImpostors, stillLook } from '@render/plantImpostors';
import { THIN_BAR_SCALE } from '@render/impostorBake';
import type { CellArrays } from '@render/buildings/cellArrays';
import { THIN_PROPS } from '@render/buildings/facadeProps';
import { FarPartBatch } from '@render/buildings/farParts';
import { type BuildingKit, PART_ERROR_PX, PART_KINDS, type PartKind, createBuildingKit } from '@render/buildings/kit';
import { PartCell, type PartView } from '@render/buildings/partCells';
import { fileParts, partBandings } from '@render/buildings/partFiling';
import { PICTURE_ORDER } from '@render/buildings/partPictures';
import { POSE_FLOATS } from '@render/buildings/partPose';
import { SHELL_PARTS } from '@render/buildings/shellParts';
import { SUN_CASCADES, cascadedSunChunks } from '@render/sunCascades';

/** THE SMALL PROPS' FAR PICTURES (`partPictures.ts`, `kit.ts` PICTURED): every part kind whose coarsest model is over 24 triangles is drawn as its
 *  octahedral picture once it spans under `PICTURE_PX`, by the near cells and the facade level's batch alike, its shadow its model's. */

/** The kinds made of bars, and the shell's parts: never pictured (their cards and top faces are their far levels). */
const BARS: readonly PartKind[] = ['frame', 'railing', 'roofRailing', 'brise', 'louvre', 'glassRail'];

let kit: BuildingKit;
beforeAll(async () => {
  kit = createBuildingKit();
  await kit.levelsReady;
});

/** Whether the pictures count as taken: they are taken by a renderer (`takeWaitingPictures`), none here (`propImpostors.spec.ts` does the same). */
function taken(on: boolean): void {
  for (const picture of kit.pictures.of.values()) picture.ready = () => on;
}

const pictured = (): PartKind[] => PART_KINDS.filter((kind) => kit.screen[kind].levels.at(-1)!.picture !== undefined);
const acrossOf = (kind: PartKind): number => Math.hypot(...kit.screen[kind].extent);

/** `count` instances of `kind` at one point of cell 0,0, scaled `scale` (three's world: y up, z the map's -y). */
function partsOf(kinds: readonly PartKind[], scale: readonly [number, number, number], count = 40): CellArrays {
  const one = (): NonNullable<CellArrays['parts'][PartKind]> => {
    const poses = new Float32Array(count * POSE_FLOATS);
    for (let i = 0; i < count; i++) poses.set([10, 5, -10, 1, 0, ...scale], i * POSE_FLOATS);
    return { count, poses, instanceColor: new Uint16Array(count * 3).fill(DataUtils.toHalfFloat(1)), bounds: new Float64Array([8, 0, -12, 12, 10, -8, 10, 5, -10, 4]) };
  };
  return { shells: [], parts: Object.fromEntries(kinds.map((kind) => [kind, one()])), furniture: {} };
}
const cellOf = (kinds: readonly PartKind[], scale: readonly [number, number, number] = [1, 1, 1]): PartCell =>
  new PartCell('0,0', fileParts('0,0', [['0,0', partsOf(kinds, scale)]], partBandings(kit.screen)), kit);
/** A view where every metre spans `px` pixels (`orthoPx`), with shadows of `texel`. */
const viewAt = (px: number, texel = Infinity): PartView => ({ x: 10, y: 10, z: 5, pxAtMetre: 1000, orthoPx: px, shadowTexel: texel });
const shown = (cell: PartCell): InstancedMesh[] => cell.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh && o.visible && o.userData['shadowOnly'] !== true);
const casterOf = (cell: PartCell): InstancedMesh | undefined => cell.group.children.find((o): o is InstancedMesh => o instanceof InstancedMesh && o.userData['shadowOnly'] === true);
/** The kit's level a mesh draws: its posed copy shares the level's model (`partPose.ts` posedCopy). */
const levelOf = (kind: PartKind, mesh: InstancedMesh): number =>
  kit.screen[kind].levels.findIndex((level) => level.geometry.getAttribute('position') === mesh.geometry.getAttribute('position'));

describe('the small props\' far pictures', () => {
  it('picture every part kind whose coarsest model is over 24 triangles, as its last level of 2 triangles, and no other kind', () => {
    const over = PART_KINDS.filter((kind) => !SHELL_PARTS.has(kind) && !BARS.includes(kind) && kit.screen[kind].levels.filter((level) => !level.picture).at(-1)!.triangles > 24);
    expect(pictured()).toEqual(over);
    expect(pictured()).toEqual(['acUnit', 'foliage', 'bush', 'chair', 'table', 'airer', 'dish', 'lounger', 'bike']);
    for (const kind of PART_KINDS) {
      const levels = kit.screen[kind].levels;
      // Only the last level is a picture.
      expect(levels.slice(0, -1).some((level) => level.picture), kind).toBe(false);
      if (!levels.at(-1)!.picture) continue;
      const picture = levels.at(-1)!;
      expect(picture.triangles).toBe(2);
      // Its error its diagonal's share of `PART_ERROR_PX` in `PICTURE_PX`: under `PART_ERROR_PX` exactly where it spans under `PICTURE_PX`.
      expect(picture.picture!.across).toBeCloseTo(acrossOf(kind), 6);
      for (const e of picture.error) expect(e).toBeCloseTo((acrossOf(kind) * PART_ERROR_PX) / PICTURE_PX, 9);
    }
  });

  for (const scale of [[1, 1, 1], [1.2, 0.8, 1.2]] as const) {
    it(`draw a part as its picture under ${PICTURE_PX} px and never at or over it, by its largest scale (${scale.join(' x ')})`, () => {
      taken(true);
      for (const kind of pictured()) {
        const cell = cellOf([kind], scale);
        const picture = kit.screen[kind].levels.length - 1;
        const material = kit.screen[kind].levels[picture]!.picture!.material;
        // The pixels a metre spans where the part's largest extent times its diagonal spans `px`: the picture's own measure.
        const at = (px: number): number => { cell.choose(viewAt(px / (acrossOf(kind) * Math.max(...scale)))); return levelOf(kind, shown(cell)[0]!); };
        // Over the bound: its model. Under it from the model: its model until it is under the bound narrowed by `COARSEN` (0.85).
        expect(at(49), kind).toBeLessThan(picture);
        expect(at(45), kind).toBeLessThan(picture);
        expect(at(40), kind).toBe(picture);
        expect(shown(cell)[0]!.material, kind).toBe(material);
        // First of the blended things: under a balcony's glass, as its model is.
        expect(shown(cell)[0]!.renderOrder, kind).toBe(PICTURE_ORDER);
        // Held to the bound, its model at it.
        expect(at(47.9), kind).toBe(picture);
        expect(at(48.1), kind).toBeLessThan(picture);
        expect(shown(cell)[0]!.material, kind).toBe(kit.material[kind]);
        expect(shown(cell)[0]!.renderOrder, kind).toBe(0);
        expect(at(2), kind).toBe(picture);
        expect(cell.triangles).toBe(40 * 2);
        // Left out where its model was, as before the pictures: under 0.85 px across its diagonal (`COARSEN`), back from a whole one.
        const diagonal = Math.hypot(...kit.screen[kind].extent.map((e, k) => e * scale[k]!));
        const across = (px: number): number => { cell.choose(viewAt(px / diagonal)); return shown(cell).length; };
        expect(across(0.9), kind).toBe(1);
        expect(levelOf(kind, shown(cell)[0]!), kind).toBe(picture);
        expect(across(0.8), kind).toBe(0);
        expect(across(0.95), kind).toBe(0);
        expect(across(1.05), kind).toBe(1);
        expect(levelOf(kind, shown(cell)[0]!), kind).toBe(picture);
        cell.dispose();
      }
    });
  }

  it('draw their models until the pictures are taken', () => {
    taken(false);
    for (const kind of pictured()) {
      const cell = cellOf([kind]);
      cell.choose(viewAt(10 / acrossOf(kind)));
      expect(levelOf(kind, shown(cell)[0]!), kind).toBe(kit.screen[kind].levels.length - 2);
      cell.dispose();
    }
    taken(true);
  });

  it('cast as before the pictures at every texel, by the coarsest model, never by a picture nor by the runs', () => {
    const texels = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3];
    for (const kind of pictured().filter((k) => kit.castsShadow.has(k))) {
      const casting = (on: boolean): (readonly [boolean, boolean, number])[] => {
        taken(on);
        const cell = cellOf([kind]);
        cell.choose(viewAt(20 / acrossOf(kind), 0.01));
        const out = texels.map((texel) => {
          cell.castInto(texel);
          const caster = casterOf(cell)!;
          return [caster.visible, caster.castShadow, levelOf(kind, caster)] as const;
        });
        expect(shown(cell).every((mesh) => !mesh.castShadow), kind).toBe(true);
        cell.dispose();
        return out;
      };
      const before = casting(false), after = casting(true);
      expect(after, kind).toEqual(before);
      // Some texel cast, and none by the picture.
      expect(after.some(([visible]) => visible), kind).toBe(true);
      for (const [visible, , level] of after) if (visible) expect(level, kind).toBeLessThan(kit.screen[kind].levels.length - 1);
    }
  });

  it('draw a faded cell\'s props by their models with the faded material, their pictures back once shown again', () => {
    taken(true);
    for (const kind of pictured()) {
      const cell = cellOf([kind]);
      const picture = kit.screen[kind].levels.length - 1;
      cell.choose(viewAt(10 / acrossOf(kind)));
      expect(levelOf(kind, shown(cell)[0]!)).toBe(picture);
      cell.setFaded(true);
      expect(levelOf(kind, shown(cell)[0]!), kind).toBe(picture - 1);
      expect(shown(cell)[0]!.material, kind).toBe(kit.dimParts);
      cell.choose(viewAt(10 / acrossOf(kind)));
      cell.choose(viewAt(5 / acrossOf(kind)));
      expect(levelOf(kind, shown(cell)[0]!), kind).toBeLessThan(picture);
      expect(shown(cell)[0]!.material, kind).toBe(kit.dimParts);
      cell.setFaded(false);
      cell.choose(viewAt(5 / acrossOf(kind)));
      expect(levelOf(kind, shown(cell)[0]!), kind).toBe(picture);
      expect(shown(cell)[0]!.material, kind).toBe(kit.screen[kind].levels[picture]!.picture!.material);
      cell.dispose();
    }
  });

  it('are drawn by the facade level\'s batch under the same bound, their shadows cast by their models\' levels as before', () => {
    const kinds = pictured();
    /** The batch with every pictured kind in cell 0,0, looked at so a kind's diagonal spans `px` (`orthoPx`: every cell alike). */
    const batchOf = (): { batch: FarPartBatch; cell: PartCell } => {
      const cell = cellOf(kinds);
      const batch = new FarPartBatch(kit);
      batch.sync(new Map([['0,0', cell]]), () => true);
      return { batch, cell };
    };
    const meshOf = (batch: FarPartBatch, name: string): InstancedMesh | undefined => batch.group.children.find((o): o is InstancedMesh => o.name === name);
    const look = (batch: FarPartBatch, kind: PartKind, px: number): void => batch.view(0, 0, 0, 1000, px / acrossOf(kind));
    for (const kind of kinds) {
      // Without the pictures: the levels the batch drew before them, at each size.
      taken(false);
      const plain = batchOf();
      const sizes = [60, 47, 40, 30, 47, 49, 30];
      const before = sizes.map((px) => { look(plain.batch, kind, px); return levelOf(kind, meshOf(plain.batch, `building-${kind}`)!); });
      plain.batch.dispose(); plain.cell.dispose();
      taken(true);
      const { batch, cell } = batchOf();
      const mesh = meshOf(batch, `building-${kind}`)!;
      const casts = kit.castsShadow.has(kind);
      let held = false;
      sizes.forEach((px, k) => {
        look(batch, kind, px);
        const picture = levelOf(kind, mesh) === kit.screen[kind].levels.length - 1;
        // Entered under `PICTURE_PX` narrowed by the band (`HYSTERESIS`), held up to it.
        held = held ? px < PICTURE_PX : px < PICTURE_PX / (1 + HYSTERESIS);
        expect(picture, `${kind} at ${px} px`).toBe(held);
        expect(mesh.material, `${kind} at ${px} px`).toBe(picture ? kit.screen[kind].levels.at(-1)!.picture!.material : kit.material[kind]);
        expect(mesh.renderOrder, `${kind} at ${px} px`).toBe(picture ? PICTURE_ORDER : 0);
        if (!picture) expect(levelOf(kind, mesh), `${kind} at ${px} px`).toBe(before[k]);
        // A picture casts nothing; its model's level, the one drawn before the pictures, casts by its caster in the near cascades' passes alone.
        expect(mesh.castShadow, `${kind} at ${px} px`).toBe(casts && !picture);
        const caster = meshOf(batch, `building-${kind}-caster`);
        if (!casts) { expect(caster).toBeUndefined(); return; }
        if (!picture) { expect(caster?.castShadow ?? false).toBe(false); return; }
        expect(levelOf(kind, caster!), `${kind} at ${px} px`).toBe(before[k]);
        expect(caster!.castShadow).toBe(true);
        expect(caster!.count).toBe(mesh.count);
        batch.castShadow(true, false);
        expect(caster!.visible).toBe(true);
        batch.castShadow(true, true);
        expect(caster!.visible).toBe(false);
        batch.castShadow(false);
        expect(caster!.visible).toBe(false);
        batch.castShadow(true, true);
      });
      // Faded: its model's level, the faded material.
      look(batch, kind, 10);
      batch.setFaded(true);
      expect(levelOf(kind, mesh), kind).toBeLessThan(kit.screen[kind].levels.length - 1);
      expect(mesh.material, kind).toBe(kit.dimParts);
      batch.setFaded(false);
      look(batch, kind, 10);
      expect(levelOf(kind, mesh), kind).toBe(kit.screen[kind].levels.length - 1);
      expect(batch.trianglesOf('0,0')).toBeGreaterThan(0);
      batch.dispose();
      cell.dispose();
    }
  });

  it('tone a thin prop\'s picture by its mesh\'s own bar and tone behind, after its instance\'s colour as its mesh does', () => {
    const fragment = (material: Material): { source: string; uniforms: Record<string, { value: unknown }> } => {
      const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, defines: {} };
      material.onBeforeCompile(shader as never, null as never);
      return { source: shader.fragmentShader, uniforms: shader.uniforms };
    };
    const rows: string[] = [];
    for (const [kind, bar, behind] of THIN_PROPS) {
      const picture = kit.pictures.of.get(kind)!;
      const drawn = fragment(picture.material);
      // The tone after three's `color_fragment` (the instance's colour in), as `prefilterThinParts` tones the mesh.
      expect(drawn.source.indexOf('thinTone(diffuseColor.rgb, partThin.x')).toBeGreaterThan(drawn.source.indexOf('#include <color_fragment>'));
      expect(drawn.uniforms['uHasThin']!.value).toBe(0);
      const block = picture.quad.getAttribute('aBlock') as BufferAttribute;
      const blocks = drawn.uniforms['uBlocks']!.value as Vector2;
      const thin = (drawn.uniforms['uPartThin']!.value as Vector2[])[block.getX(0) + block.getY(0) * blocks.x]!;
      // The mesh's own numbers, as its material holds them.
      const near = fragment(kit.material[kind]).uniforms;
      expect([thin.x, thin.y]).toEqual([near['thinBar']!.value, near['thinBehind']!.value]);
      // What the third picture of a still set holds for it instead: its bar and tone in 8 bits.
      const stored = (Math.round((255 * bar) / THIN_BAR_SCALE) / 255) * THIN_BAR_SCALE, under = Math.round(255 * behind) / 255;
      rows.push(`${kind}: bar ${thin.x} (a third picture: ${stored.toFixed(5)}), behind ${thin.y} (${under.toFixed(5)})`);
    }
    console.log(`the thin props' tones by uniform, their mesh's:\n${rows.join('\n')}`);
  });

  it('read the sun\'s shadow at the model\'s surface, not on the quad: three\'s own coordinate moved, then the game\'s cascades\'', () => {
    const fragment = (): string => {
      const shader = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, defines: {} };
      kit.pictures.of.get('bush')!.material.onBeforeCompile(shader as never, null as never);
      return shader.fragmentShader;
    };
    expect(fragment()).toContain('( vDirectionalShadowCoord[ i ] + directionalShadowMatrix[ i ] * vec4( pictureSunShift, 0.0 ) )');
    // The game's renderer's chunks (`environment.ts` sunShadowChunks): each cascade's coordinate worked out at the fragment.
    cascadedSunChunks();
    const cascaded = fragment();
    expect(cascaded).toContain('vSunCascadeWorld + pictureSunShift + pictureSunNormal * normalBias');
    expect(cascaded).toContain(`NUM_DIR_LIGHT_SHADOWS != ${SUN_CASCADES}`);
  });

  it('hold their pictures in under 12 MB: frames of PICTURE_PX texels, their finest level alone, two RGBA8 targets a set (measured)', () => {
    let bytes = 0;
    const rows: string[] = [];
    for (const texture of kit.pictures.textures) {
      const image = texture.image as { width: number; height: number };
      expect(texture.format).toBe(RGBAFormat);
      expect(texture.type).toBe(UnsignedByteType);
      expect(texture.generateMipmaps).toBe(false);
      bytes += image.width * image.height * 4;
      rows.push(`${image.width} x ${image.height} RGBA8 = ${image.width * image.height * 4} B`);
    }
    console.log(`the pictures' atlases (${kit.pictures.textures.length} targets):\n${rows.join('\n')}\ntotal ${bytes} B`);
    expect(new Set([...kit.pictures.of.values()].map((p) => p.material)).size * 2).toBe(kit.pictures.textures.length);
    expect(bytes).toBeLessThan(12_000_000);
  });
});

/** A material's program as its patches make it of three's own template: its sources, its key and its flags, hashed. */
function fingerprint(material: Material, template: { vertexShader: string; fragmentShader: string }): string {
  const shader = { uniforms: {}, vertexShader: template.vertexShader, fragmentShader: template.fragmentShader, defines: {} };
  material.onBeforeCompile(shader as never, null as never);
  const flags = [material.transparent, material.depthWrite, material.alphaToCoverage, material.side, material.shadowSide].join(',');
  return createHash('sha256').update(shader.vertexShader).update('\0').update(shader.fragmentShader).update('\0').update(material.customProgramCacheKey()).update('\0').update(flags).digest('hex');
}

describe('the other pictures\' programs', () => {
  it('are as they were before the building parts\' pictures: the street props\', the ground cover\'s and the plants\' sources, keys and flags', () => {
    const g: BufferGeometry = new BoxGeometry(1, 1, 1);
    g.setAttribute('color', new BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3));
    const near = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
    const part = { geometry: g, normals: 'vertex' as const, side: near.side, casts: true, material: near };
    const props = createImpostors([{ parts: [part], measure: 1 }], { ...stillLook(near), band: [1.5, 16] }, 'props');
    const cover = createImpostors([{ parts: [part], measure: 1 }], { ...stillLook(near), perMip: true, ordered: true }, 'ground-cover');
    const plants = createPlantImpostors([{ body: g, cards: null, cardsCast: false }], PICTURE_WIND, 'scenery');
    // Hashed at fa0bb68f (HEAD before the building parts' pictures), the same way.
    expect([fingerprint(props.material, ShaderLib.standard), fingerprint(props.depth, ShaderLib.depth)]).toEqual([
      '9910a4403477f3e66348b4a46cbc1158b95c00092ec886e260b3e543b3754217', 'db6328a96b8dae0a22430b8c90f7f4c39ffaf8ca740cac92b791149138ed2e93']);
    expect([fingerprint(cover.material, ShaderLib.standard), fingerprint(cover.depth, ShaderLib.depth)]).toEqual([
      '0e0d69b11ccba9162b9fbe888e022e089abffb2eedd253203bb10f2384794321', 'db6328a96b8dae0a22430b8c90f7f4c39ffaf8ca740cac92b791149138ed2e93']);
    expect([fingerprint(plants.material, ShaderLib.standard), fingerprint(plants.depth, ShaderLib.depth)]).toEqual([
      '4f12bc7e059469b01f6121079685a7d7663703493b92cdff2a575cc8e0c739e2', 'd2106e2dd5fbabe7f8553f418bb2a6b811685b2650afd73cf9be201e6aff6f63']);
    for (const set of [props, cover, plants]) set.dispose();
  });
});
