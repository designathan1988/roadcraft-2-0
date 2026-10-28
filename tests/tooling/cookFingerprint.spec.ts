import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import FILES from 'virtual:model-urls/citizens/people?ext=bin,ktx2';
import cast from '@people/cast.json';
import { LEVEL_TRIANGLES, readCookedHeader } from '@render/people/cookedPerson';
import { importClosure } from '../../scripts/vite/cook-plugin';

/** A file reached only by an import for its effect, or only through the `@/` alias, is code the bake runs: a change to it must change the fingerprint. */
describe('the import closure follows every way a file is reached', () => {
  it('through an import for its effect alone and through `@/`', () => {
    const root = mkdtempSync(join(tmpdir(), 'cook-closure-'));
    try {
      mkdirSync(join(root, 'src', 'lib'), { recursive: true });
      writeFileSync(join(root, 'src', 'entry.ts'), "import './effect';\nimport { b } from '@/lib/named';\nexport const a = b;\n");
      writeFileSync(join(root, 'src', 'effect.ts'), 'export {};\n');
      writeFileSync(join(root, 'src', 'lib', 'named.ts'), 'export const b = 1;\n');
      const at = root.replace(/\\/g, '/').length + 1;
      const closure = importClosure(root, 'src/entry.ts').map((file) => file.replace(/\\/g, '/').slice(at));
      expect(closure).toEqual(['src/effect.ts', 'src/entry.ts', 'src/lib/named.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The cast's people are ready files served as they are (`people/cookedLoad.ts`): no build step makes, versions or checks them, so the
 *  files themselves must hold every body of the cast, each named by its role and with its levels in budget. */
describe('the ready files of the people', () => {
  const ids = cast.map((c) => c.id);

  it('are every body of the cast and its atlas, and nothing else', () => {
    expect(Object.keys(FILES).sort()).toEqual(ids.flatMap((id) => [`${id}.bin`, `${id}.ktx2`]).sort());
  });

  it('each name their body and its atlas, keep the budgets, and get coarser from level to level', () => {
    for (const id of ids) {
      const bytes = readFileSync(join('public/models/citizens/people', `${id}.bin`));
      const header = readCookedHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      expect(header.id).toBe(id);
      expect(header.atlas.file).toBe(`${id}.ktx2`);
      const levels = header.mesh.levels;
      expect(levels.length, id).toBe(LEVEL_TRIANGLES.length);
      levels.forEach((level, k) => {
        expect(level.count % 3, id).toBe(0);
        expect(level.count / 3, `${id} L${k}`).toBeLessThanOrEqual(LEVEL_TRIANGLES[k]!);
        if (k > 0) expect(level.count, `${id} L${k}`).toBeLessThan(levels[k - 1]!.count);
        // The game draws the coarsest level under a pixel (`riggedCitizens.ts` citizenLevelOf): a level no coarser than the next is never drawn.
        if (k > 0) expect(level.error, `${id} L${k}`).toBeGreaterThan(levels[k - 1]!.error);
      });
    }
  });
});
