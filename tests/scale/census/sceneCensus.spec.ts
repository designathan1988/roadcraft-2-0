import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installNullPage, primeCookedSurfaces } from '../../support/nullGpu';
import { HEIGHT, STREET, WIDTH, openSmallCity, setView, settle } from '../../support/sceneHarness';

/**
 * THE SCENE AS THE GAME WOULD DRAW IT, WITHOUT OPENING THE GAME: the real scene renderer (`createSceneRenderer`) on a GPU that draws
 * nothing (`tests/support/nullGpu.ts`: three's own WebGLRenderer on a null WebGL2 context), the small city of seed 7 opened as the menu
 * opens it (`main.ts` openCity: `restoreInto`, `beginLoad`, frames until the curtain comes down, `opening:shown`), then the two views
 * the game's photographs are taken from (`scripts/look/verify.json`: the district over the centre, the street) settled, and what each
 * would draw counted: every visible mesh, instanced mesh (its count), batched mesh (its visible instances), points and line, by name
 * with its digits taken out, and the draws and triangles three issued for the frame (`renderer.info.render`: the colour pass, the
 * shadows and the post chain, after three's own frustum culling). No GPU, no browser, no worker (their jobs run on the page's thread).
 * A layer that stops drawing shows here as a count that fell; a change made on purpose updates the numbers in the same commit, and says why.
 */

let page: { restore(): void };
beforeAll(() => {
  page = installNullPage(WIDTH, HEIGHT, process.cwd());
  primeCookedSurfaces(process.cwd());
});
afterAll(() => page.restore());

describe('scene census', () => {
  it('the small city of seed 7 draws what it drew before, district and street', async () => {
    const city = await openSmallCity();
    expect(performance.getEntriesByName('opening:shown').length).toBeGreaterThan(0);
    const district = (await settle(city)).census;
    setView(city.scene, STREET);
    const street = (await settle(city)).census;
    city.scene.dispose();
    // 2026-10-25, against db9da0c7's own counts (the numbers here were already behind it): the district 258 -> 253 draws and 4,910,890 ->
    // 4,017,696 triangles, the street 374 -> 363 and 4,132,945 -> 3,837,968. The roads' far blocks one surface each (asphalt to planting),
    // no verge and no marking meshes (the lines in the shader of the carriageway); the street props on the tool's ladder (`propLevels.ts`:
    // the street's lamps drawn as their simplified model, a rung's far cells named after it); the terrain's ground, rim and seams on the four
    // plates about the origin (`bounds.ts`); a few building parts filed in other cells of 250 m.
    expect({ district, street }).toMatchInlineSnapshot(`
      {
        "district": {
          "byName": {
            "asphalt+footway+curb-ramp+median-paved+kerb+median-kerb+median-planting-far": {
              "drawn": 16,
              "objects": 16,
            },
            "benches-far-far-cells": {
              "drawn": 876,
              "objects": 4,
            },
            "building-acUnit": {
              "drawn": 3588,
              "objects": 1,
            },
            "building-airer": {
              "drawn": 132,
              "objects": 1,
            },
            "building-awning": {
              "drawn": 5132,
              "objects": 1,
            },
            "building-bike": {
              "drawn": 36,
              "objects": 1,
            },
            "building-brise": {
              "drawn": 10278,
              "objects": 1,
            },
            "building-bush": {
              "drawn": 749,
              "objects": 1,
            },
            "building-chair": {
              "drawn": 1257,
              "objects": 1,
            },
            "building-concrete": {
              "drawn": 83539,
              "objects": 1,
            },
            "building-dish": {
              "drawn": 1376,
              "objects": 1,
            },
            "building-fin": {
              "drawn": 34623,
              "objects": 1,
            },
            "building-foliage": {
              "drawn": 801,
              "objects": 1,
            },
            "building-frame": {
              "drawn": 5712,
              "objects": 1,
            },
            "building-glass": {
              "drawn": 1141,
              "objects": 18,
            },
            "building-glassDark": {
              "drawn": 354,
              "objects": 14,
            },
            "building-glassRail": {
              "drawn": 7214,
              "objects": 1,
            },
            "building-lamp": {
              "drawn": 4894,
              "objects": 1,
            },
            "building-lotBox": {
              "drawn": 146312,
              "objects": 49,
            },
            "building-lotRail": {
              "drawn": 23714,
              "objects": 19,
            },
            "building-lotSides": {
              "drawn": 69869,
              "objects": 33,
            },
            "building-lotSlab": {
              "drawn": 7102,
              "objects": 19,
            },
            "building-lounger": {
              "drawn": 346,
              "objects": 1,
            },
            "building-louvre": {
              "drawn": 6214,
              "objects": 1,
            },
            "building-massing": {
              "drawn": 17,
              "objects": 17,
            },
            "building-pot": {
              "drawn": 1550,
              "objects": 1,
            },
            "building-roofRailing": {
              "drawn": 10359,
              "objects": 1,
            },
            "building-shell-batch-detail": {
              "drawn": 0,
              "objects": 1,
            },
            "building-shell-batch-detailRuns": {
              "drawn": 0,
              "objects": 1,
            },
            "building-shell-batch-facade": {
              "drawn": 69,
              "objects": 1,
            },
            "building-shell-batch-runs": {
              "drawn": 68,
              "objects": 1,
            },
            "building-table": {
              "drawn": 291,
              "objects": 1,
            },
            "building-wash": {
              "drawn": 1636,
              "objects": 1,
            },
            "building-water": {
              "drawn": 138,
              "objects": 13,
            },
            "exhaust": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-far": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-slab": {
              "drawn": 1,
              "objects": 1,
            },
            "gardens-far-cells": {
              "drawn": 34274,
              "objects": 4,
            },
            "hydrants-far-far-cells": {
              "drawn": 294,
              "objects": 4,
            },
            "nature-tree-cypress-": {
              "drawn": 7,
              "objects": 2,
            },
            "nature-tree-cypress--cards": {
              "drawn": 7,
              "objects": 2,
            },
            "nature-tree-oak-": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-oak--cards": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-palm-": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-palm--cards": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-palm--far": {
              "drawn": 1,
              "objects": 1,
            },
            "road-far-blocks": {
              "drawn": 16,
              "objects": 1,
            },
            "sign-plates": {
              "drawn": 2,
              "objects": 2,
            },
            "sign-posts": {
              "drawn": 190,
              "objects": 1,
            },
            "sky": {
              "drawn": 1,
              "objects": 1,
            },
            "street-bins-far-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-beams-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-lamps-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-pools-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-lights-mid-mid-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-lights-shadow-far-cells": {
              "drawn": 0,
              "objects": 4,
            },
            "terrain-ground": {
              "drawn": 4,
              "objects": 4,
            },
            "terrain-rim": {
              "drawn": 4,
              "objects": 4,
            },
            "terrain-seams": {
              "drawn": 4,
              "objects": 4,
            },
            "utility-arms": {
              "drawn": 797,
              "objects": 4,
            },
            "utility-braces": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-caps": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-insulators": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-lamp-arms": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-lamp-beams": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-heads": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-lamp-lenses": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-lamp-pools": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-poles": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-transformers": {
              "drawn": 159,
              "objects": 4,
            },
            "utility-wires": {
              "drawn": 4,
              "objects": 4,
            },
          },
          "drawn": 471782,
          "draws": 253,
          "lines": 0,
          "objects": 339,
          "points": 4000,
          "triangles": 4017696,
        },
        "street": {
          "byName": {
            "asphalt+footway+curb-ramp+median-paved+kerb+median-kerb+median-planting": {
              "drawn": 2,
              "objects": 2,
            },
            "asphalt+footway+curb-ramp+median-paved+kerb+median-kerb+median-planting-far": {
              "drawn": 14,
              "objects": 14,
            },
            "benches": {
              "drawn": 0,
              "objects": 1,
            },
            "benches-far": {
              "drawn": 60,
              "objects": 1,
            },
            "benches-far-far-cells": {
              "drawn": 876,
              "objects": 4,
            },
            "building-acUnit": {
              "drawn": 2953,
              "objects": 11,
            },
            "building-airer": {
              "drawn": 100,
              "objects": 10,
            },
            "building-awning": {
              "drawn": 4038,
              "objects": 11,
            },
            "building-bike": {
              "drawn": 31,
              "objects": 8,
            },
            "building-brise": {
              "drawn": 9064,
              "objects": 11,
            },
            "building-bush": {
              "drawn": 553,
              "objects": 11,
            },
            "building-chair": {
              "drawn": 924,
              "objects": 11,
            },
            "building-concrete": {
              "drawn": 67714,
              "objects": 21,
            },
            "building-dish": {
              "drawn": 1258,
              "objects": 11,
            },
            "building-door": {
              "drawn": 2133,
              "objects": 11,
            },
            "building-fin": {
              "drawn": 22821,
              "objects": 14,
            },
            "building-foliage": {
              "drawn": 597,
              "objects": 11,
            },
            "building-frame": {
              "drawn": 11093,
              "objects": 22,
            },
            "building-glass": {
              "drawn": 91997,
              "objects": 11,
            },
            "building-glassDark": {
              "drawn": 14447,
              "objects": 11,
            },
            "building-glassRail": {
              "drawn": 4324,
              "objects": 11,
            },
            "building-lamp": {
              "drawn": 3453,
              "objects": 11,
            },
            "building-lotBox": {
              "drawn": 122449,
              "objects": 40,
            },
            "building-lotRail": {
              "drawn": 18080,
              "objects": 11,
            },
            "building-lotSides": {
              "drawn": 47044,
              "objects": 21,
            },
            "building-lotSlab": {
              "drawn": 4683,
              "objects": 11,
            },
            "building-lounger": {
              "drawn": 237,
              "objects": 11,
            },
            "building-louvre": {
              "drawn": 4486,
              "objects": 11,
            },
            "building-massing": {
              "drawn": 25,
              "objects": 25,
            },
            "building-pot": {
              "drawn": 1150,
              "objects": 11,
            },
            "building-railing": {
              "drawn": 1292,
              "objects": 13,
            },
            "building-roofRailing": {
              "drawn": 1502,
              "objects": 8,
            },
            "building-shell-batch-detail": {
              "drawn": 52,
              "objects": 1,
            },
            "building-shell-batch-detailRuns": {
              "drawn": 44,
              "objects": 1,
            },
            "building-shell-batch-facade": {
              "drawn": 0,
              "objects": 1,
            },
            "building-shell-batch-runs": {
              "drawn": 0,
              "objects": 1,
            },
            "building-shutter": {
              "drawn": 4830,
              "objects": 11,
            },
            "building-table": {
              "drawn": 221,
              "objects": 11,
            },
            "building-wash": {
              "drawn": 1098,
              "objects": 11,
            },
            "building-water": {
              "drawn": 70,
              "objects": 7,
            },
            "exhaust": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-far": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-slab": {
              "drawn": 1,
              "objects": 1,
            },
            "garden-bushes-bush": {
              "drawn": 0,
              "objects": 1,
            },
            "garden-bushes-bush-cards": {
              "drawn": 0,
              "objects": 1,
            },
            "garden-bushes-bush-far": {
              "drawn": 2,
              "objects": 1,
            },
            "garden-bushes-bushFlowering": {
              "drawn": 0,
              "objects": 1,
            },
            "garden-bushes-bushFlowering-cards": {
              "drawn": 0,
              "objects": 1,
            },
            "garden-bushes-bushFlowering-far": {
              "drawn": 28,
              "objects": 1,
            },
            "garden-bushes-hedge": {
              "drawn": 0,
              "objects": 1,
            },
            "garden-bushes-hedge-cards": {
              "drawn": 0,
              "objects": 1,
            },
            "garden-trees-broadleaf": {
              "drawn": 121,
              "objects": 1,
            },
            "garden-trees-broadleaf-cards": {
              "drawn": 121,
              "objects": 1,
            },
            "garden-trees-broadleafTall": {
              "drawn": 3,
              "objects": 1,
            },
            "garden-trees-broadleafTall-cards": {
              "drawn": 3,
              "objects": 1,
            },
            "garden-trees-broadleafTall-far": {
              "drawn": 48,
              "objects": 1,
            },
            "garden-trees-conifer": {
              "drawn": 13,
              "objects": 1,
            },
            "garden-trees-conifer-cards": {
              "drawn": 13,
              "objects": 1,
            },
            "garden-trees-conifer-far": {
              "drawn": 29,
              "objects": 1,
            },
            "garden-trees-ipePink": {
              "drawn": 24,
              "objects": 1,
            },
            "garden-trees-ipePink-cards": {
              "drawn": 24,
              "objects": 1,
            },
            "garden-trees-ipeYellow": {
              "drawn": 33,
              "objects": 1,
            },
            "garden-trees-ipeYellow-cards": {
              "drawn": 33,
              "objects": 1,
            },
            "gardens-far-cells": {
              "drawn": 34274,
              "objects": 4,
            },
            "hydrants": {
              "drawn": 0,
              "objects": 1,
            },
            "hydrants-far": {
              "drawn": 21,
              "objects": 1,
            },
            "hydrants-far-far-cells": {
              "drawn": 294,
              "objects": 4,
            },
            "nature-tree-cypress-": {
              "drawn": 0,
              "objects": 2,
            },
            "nature-tree-cypress--cards": {
              "drawn": 0,
              "objects": 2,
            },
            "nature-tree-oak-": {
              "drawn": 0,
              "objects": 2,
            },
            "nature-tree-oak--cards": {
              "drawn": 0,
              "objects": 2,
            },
            "nature-tree-palm-": {
              "drawn": 0,
              "objects": 2,
            },
            "nature-tree-palm--cards": {
              "drawn": 0,
              "objects": 2,
            },
            "road-far-blocks": {
              "drawn": 14,
              "objects": 1,
            },
            "sign-plates": {
              "drawn": 2,
              "objects": 2,
            },
            "sign-posts": {
              "drawn": 64,
              "objects": 1,
            },
            "sky": {
              "drawn": 1,
              "objects": 1,
            },
            "street-bins": {
              "drawn": 0,
              "objects": 1,
            },
            "street-bins-far": {
              "drawn": 59,
              "objects": 1,
            },
            "street-bins-far-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-beams": {
              "drawn": 71,
              "objects": 1,
            },
            "street-light-beams-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-lamps": {
              "drawn": 58,
              "objects": 1,
            },
            "street-light-lamps-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-pools": {
              "drawn": 76,
              "objects": 1,
            },
            "street-light-pools-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-lights": {
              "drawn": 0,
              "objects": 1,
            },
            "street-lights-mid": {
              "drawn": 64,
              "objects": 1,
            },
            "street-lights-mid-mid-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-lights-shadow-far-cells": {
              "drawn": 0,
              "objects": 4,
            },
            "terrain-ground": {
              "drawn": 4,
              "objects": 4,
            },
            "terrain-rim": {
              "drawn": 4,
              "objects": 4,
            },
            "terrain-seams": {
              "drawn": 4,
              "objects": 4,
            },
            "utility-arms": {
              "drawn": 797,
              "objects": 4,
            },
            "utility-braces": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-caps": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-insulators": {
              "drawn": 0,
              "objects": 4,
            },
            "utility-lamp-arms": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-beams": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-heads": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-lenses": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-pools": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-poles": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-transformers": {
              "drawn": 159,
              "objects": 4,
            },
            "utility-wires": {
              "drawn": 4,
              "objects": 4,
            },
          },
          "drawn": 491955,
          "draws": 363,
          "lines": 0,
          "objects": 576,
          "points": 4000,
          "triangles": 3837968,
        },
      }
    `);
  }, 60_000);
});
