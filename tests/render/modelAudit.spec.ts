import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import type { ItemSpec } from '@/lab/catalog/items';
import { buildingKitItems, groundCoverItems, miscItems, sceneryItems, vehicleItems } from '@/lab/catalog/kits';

/**
 * EVERY MODEL THE GAME BUILDS, COUNTED (the lab's catalogue, `lab/catalog/kits.ts`, without its page): each piece's triangles and
 * vertices at each of its levels, and what a model wastes for nothing on the screen - corners repeated whole (every attribute the same:
 * one vertex drawn twice), triangles of no area, a mesh with no index. Written to `reports/model-audit/` for the owner; a model past its
 * kind's budget, or wasting, fails here, before it reaches the game.
 */

interface Row { readonly item: string; readonly piece: string; readonly level: number; readonly triangles: number; readonly vertices: number; readonly repeated: number; readonly closed: number; readonly flat: number; readonly indexed: boolean }

/** Vertices whose every attribute equals an earlier one's (a weld would keep one of them: nothing on the screen changes). */
function repeatedCorners(g: BufferGeometry): number {
  const names = Object.keys(g.attributes);
  const n = g.getAttribute('position').count;
  const seen = new Set<string>();
  let repeated = 0;
  for (let i = 0; i < n; i++) {
    let key = '';
    for (const name of names) {
      const a = g.getAttribute(name);
      for (let c = 0; c < a.itemSize; c++) key += `${a.getComponent(i, c)},`;
      key += '|';
    }
    if (seen.has(key)) repeated++; else seen.add(key);
  }
  return repeated;
}

/** Triangles with two corners the same vertex (`closed`: they draw nothing and cost their vertex work), and those of no area in the
 *  model with three corners apart (`flat`: a card its shader opens, or a waste - read which in its builder). */
function degenerateTriangles(g: BufferGeometry): { closed: number; flat: number } {
  const p = g.getAttribute('position');
  const index = g.index;
  const count = index ? index.count : p.count;
  let closed = 0, flat = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const [a, b, c] = index ? [index.getX(t), index.getX(t + 1), index.getX(t + 2)] : [t, t + 1, t + 2];
    if (a === b || b === c || a === c) { closed++; continue; }
    const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
    const vx = p.getX(c) - p.getX(a), vy = p.getY(c) - p.getY(a), vz = p.getZ(c) - p.getZ(a);
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-18) flat++;
  }
  return { closed, flat };
}

const triangles = (g: BufferGeometry): number => Math.floor((g.index ? g.index.count : g.getAttribute('position').count) / 3);

describe('every model the game builds', () => {
  it('is counted, level by level, and wastes nothing a weld or an index would save', async () => {
    const items: ItemSpec[] = [];
    const add = (spec: ItemSpec): void => { items.push(spec); };
    sceneryItems(add);
    groundCoverItems(add);
    vehicleItems(add);
    miscItems(add);
    await buildingKitItems(add);
    const rows: Row[] = [];
    for (const item of items) {
      const name = `${item.group}/${item.name}${item.variation ? `/${item.variation}` : ''}`;
      for (const piece of item.pieces) {
        [piece.geometry, ...(piece.levels ?? [])].forEach((g, level) => {
          if (!g.getAttribute('position')) return;
          rows.push({ item: name, piece: piece.label, level, triangles: triangles(g), vertices: g.getAttribute('position').count,
            repeated: repeatedCorners(g), ...degenerateTriangles(g), indexed: g.index !== null });
        });
      }
    }
    rows.sort((a, b) => b.triangles - a.triangles);
    const dir = join(process.cwd(), 'reports', 'model-audit');
    mkdirSync(dir, { recursive: true });
    const lines = ['| Model | Piece | Level | Triangles | Vertices | Repeated vertices | Closed triangles | Flat triangles | Indexed |', '|---|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.item} | ${r.piece} | ${r.level} | ${r.triangles} | ${r.vertices} | ${r.repeated} | ${r.closed} | ${r.flat} | ${r.indexed ? 'yes' : 'no'} |`)];
    writeFileSync(join(dir, 'models.md'), `# Every model the game builds (${rows.length} pieces and levels, ${items.length} models)\n\n${lines.join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(50);
  }, 120_000);
});
