import { BufferAttribute, BufferGeometry, DataTexture, FloatType, MeshStandardMaterial, RGBAFormat, type Material, type SkinnedMesh } from 'three';
import { CROWD_IDS } from '../../render/citizenCasting';
import { loadCookedPerson } from '../../render/people/cookedLoad';
import { createPersonMaterials } from '../../render/people/personMaterial';
import type { ItemSpec, PieceSpec } from './items';

/** THE PEOPLE AS THE GAME DRAWS THEM: the cast's sixteen bodies (`public/models/citizens/people`, `render/people/cookedPerson.ts`), each with its levels and its atlas. */

type Add = (spec: ItemSpec) => void;

/** The cooked body's one mesh, its levels (the cook's index sets on the same vertices) and its skeleton, lit as the game lits it. */
function personPieces(mesh: SkinnedMesh, material: Material): PieceSpec[] {
  const levels = (mesh.geometry.userData['levels'] as BufferAttribute[] | undefined ?? []).map((index) => {
    const g = new BufferGeometry();
    for (const [n, a] of Object.entries(mesh.geometry.attributes)) g.setAttribute(n, a);
    g.setIndex(index);
    return g;
  });
  return [{ label: mesh.name || 'person', geometry: mesh.geometry, material, levels, bones: mesh.skeleton.bones.length }];
}

/** The cast's people as the game draws them: one cooked body each. */
export async function peopleItems(add: Add): Promise<void> {
  for (const id of CROWD_IDS) {
    try {
      const loaded = await loadCookedPerson(id);
      let mesh: SkinnedMesh | undefined;
      loaded.scene.traverse((o) => { if ((o as SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as SkinnedMesh; });
      if (!mesh) throw new Error('no mesh');
      const palette = { value: new DataTexture(new Float32Array(16), 4, 1, RGBAFormat, FloatType) };
      const materials = createPersonMaterials(loaded.atlas, loaded.header.mesh.alphaTest, { uniform: palette, base: { value: 0 } }, mesh);
      const m = loaded.header.mesh;
      add({
        group: 'People: cast (cooked)', name: id, origin: 'file', source: `public/models/citizens/people/${id}.bin (src/render/people/cookedLoad.ts)`, build: 'skinned',
        pieces: personPieces(mesh, materials.lit), countKey: `cast:${id}`, shadow: 'casts: coarser level for the shadow (castCoarse); the impostor card casts nothing',
        notes: [`levels ${m.levels.map((l) => `${l.count / 3} t (error ${(l.error * 100).toFixed(2)} % of height)`).join(', ')}`,
          `atlas ${loaded.header.atlas.size} px ${loaded.header.atlas.codec}, impostor ${m.impostor.frames} frames of ${m.impostor.width} x ${m.impostor.height} px`,
          `${m.morphs.length} face expressions (sparse)`, 'one material, one atlas, 26 bytes a vertex'],
      });
    } catch (error) {
      add({ group: 'People: cast (cooked)', name: id, origin: 'file', source: `public/models/citizens/people/${id}.bin`, build: 'skinned', pieces: [], notes: [`could not be read: ${String(error)}`] });
    }
  }
  // Materials the catalogue made for the sheets are let go with the page.
  void MeshStandardMaterial;
}
