import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { createFlatAtlas } from '@render/flatAtlas';

/** THE GROUND FOLLOWS THE DOCUMENT ONLY WHEN IT CHANGED (MISSION 2e): update and updatePaint, asked at every frame, read a still document
 *  once; a change of it is read at the next frame. */

// A plate's surface stands in for the real one (its textures and shaders are not what is tested).
vi.mock('@render/terrain', async (load) => {
  const real = await load<typeof import('@render/terrain')>();
  const { Mesh, MeshStandardMaterial } = await import('three');
  return {
    ...real,
    farLandMaterial: () => ({ material: new MeshStandardMaterial(), dispose: () => {} }),
    createTerrainSurface: () => {
      const material = new MeshStandardMaterial();
      return {
        meshes: [new Mesh()], parts: [], ground: new Mesh(), vergeMaterial: material, meshMaterial: material,
        highest: () => 0, update: () => false, updatePaint: () => {}, setSun: () => {}, setWaterLook: () => {}, lookFrom: () => {},
        ecology: () => null, geologyAt: () => 'granite', gpuBytes: () => 0, textures: () => [], bakeRelief: () => {}, geologyChanges: { version: 0, rectsSince: () => [] },
        dispose: () => {},
      } as unknown as ReturnType<typeof real.createTerrainSurface>;
    },
  };
});
vi.mock('@render/farForest', async (load) => {
  const real = await load<typeof import('@render/farForest')>();
  const { Group } = await import('three');
  return {
    ...real,
    createFarForest: (_slots: number, grid: ConstructorParameters<typeof real.FarWoodsBook>[0], read: ConstructorParameters<typeof real.FarWoodsBook>[1]) =>
      ({ object: new Group(), book: new real.FarWoodsBook(grid, read), update: () => {}, dispose: () => {} }),
  };
});

afterEach(() => vi.restoreAllMocks());

describe('the ground following the document', () => {
  it('reads a still document once, whatever the frames, and a changed one again', () => {
    const atlas = createFlatAtlas(1);
    const doc = new RoadDoc();
    const joins = vi.spyOn(Array.prototype, 'join');
    /** The content's key read (`readContent`): the seven revisions joined. */
    const contentReads = (): number => joins.mock.contexts.filter((list, k) => joins.mock.calls[k]![0] === ':' && (list as unknown[]).length === 7).length;
    const frame = (): void => { atlas.update(doc, false); atlas.updatePaint(doc); };
    frame();
    const first = contentReads();
    expect(first).toBe(1);
    for (let k = 0; k < 30; k++) frame();
    expect(contentReads()).toBe(first);
    // A road drawn: the document read again, once.
    doc.addNode({ x: m(100), y: m(200) });
    frame();
    expect(contentReads()).toBe(first + 1);
    atlas.dispose();
  });
});
