import { describe, expect, it } from 'vitest';
import { interfacePhoto } from '@/ui/photos';
import { shippedOptions } from '@/lab/interfacePhotos';
import { photoIds } from '@/lab/builderPhotos';
import { BLUEPRINTS } from '@world/buildings/blueprints';

/** Every option a menu shows that the game ships has its photo taken once (`npm run photos`): nothing of a menu is drawn as it opens. */
describe('the interface photos', () => {
  it('hold every shipped option of the finishes, plan shapes, road classes and road catalogue', () => {
    for (const [shelf, ids] of Object.entries(shippedOptions())) {
      expect(ids.filter((id) => !interfacePhoto(shelf as never, id)).map((id) => `${shelf}/${id}`)).toEqual([]);
    }
  });
  it('hold every model, town building and lot of the Builder', () => {
    // Each builds a building: none may be without its photo (a part such as "delete" builds nothing and keeps its glyph).
    const keys = new Set(BLUEPRINTS.map((b) => b.key));
    const models = photoIds().filter((id) => id.startsWith('city:') || id.startsWith('lot:') || keys.has(id));
    expect(models.filter((id) => !interfacePhoto('builder', id))).toEqual([]);
    expect(models.length).toBeGreaterThan(80);
  });
});
