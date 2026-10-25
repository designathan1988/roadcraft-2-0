import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BufferAttribute, BufferGeometry } from 'three';

import { readElementModel, type ElementGltf, type ElementPartData } from '@render/elements';

/** THE GROUND COVER'S MODELS AS THE GAME READS THEM (`elements.ts` readElementModel), against the files they were made from (welded, reordered
 *  and compressed losslessly with meshoptimizer, EXT_meshopt_compression): the source's triangles corner for corner. */

const FOLDER = 'public/models/elements';
/** The commit whose files are the source (Quaternius's, before they were compressed). */
const SOURCE = 'db9da0c7';

const names = readdirSync(FOLDER).filter((f) => f.endsWith('.gltf')).map((f) => f.slice(0, -'.gltf'.length)).sort();

const bytesOf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
/** A model read with the game's reader from files `read` gives. */
async function modelFrom(name: string, read: (file: string) => Buffer): Promise<ElementPartData[]> {
  const json = JSON.parse(read(`${name}.gltf`).toString('utf8')) as ElementGltf;
  return readElementModel(json, json.buffers.map((b) => (b.uri ? bytesOf(read(b.uri)) : null)));
}

/** Each triangle a geometry draws as its corners' attributes (position, normal, uv, colour), from its first corner in order: sorted. */
function triangles(g: BufferGeometry): string[] {
  const streams = ['position', 'normal', 'uv', 'color'].map((n) => g.getAttribute(n) as BufferAttribute | undefined).filter((a): a is BufferAttribute => a !== undefined);
  const corner = (v: number): string => streams.map((a) => Array.from(a.array.slice(v * a.itemSize, (v + 1) * a.itemSize)).join(',')).join('|');
  const index = g.index!;
  const out: string[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const c = [corner(index.getX(t)), corner(index.getX(t + 1)), corner(index.getX(t + 2))];
    const first = c.indexOf([...c].sort()[0]!);
    out.push([c[first], c[(first + 1) % 3], c[(first + 2) % 3]].join(';'));
  }
  return out.sort();
}

describe('the ground cover models as the game reads them', () => {
  /** Every model as the game reads it now, and as its source was: read once for the tests. */
  const now = new Map<string, ElementPartData[]>(), was = new Map<string, ElementPartData[]>();
  beforeAll(async () => {
    for (const name of names) {
      now.set(name, await modelFrom(name, (file) => readFileSync(`${FOLDER}/${file}`)));
      was.set(name, await modelFrom(name, (file) => execFileSync('git', ['show', `${SOURCE}:${FOLDER}/${file}`], { maxBuffer: 1 << 26 })));
    }
  });

  it('reads every file compressed (EXT_meshopt_compression), its indices kept in 16 bits', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const json = JSON.parse(readFileSync(`${FOLDER}/${name}.gltf`, 'utf8')) as ElementGltf & { extensionsRequired?: string[] };
      expect(json.extensionsRequired, name).toEqual(['EXT_meshopt_compression']);
      for (const part of now.get(name)!) expect(part.geometry.index!.array, name).toBeInstanceOf(Uint16Array);
    }
  });

  it('draws the source\'s triangles, corner for corner, with the same materials', () => {
    for (const name of names) {
      const parts = now.get(name)!, before = was.get(name)!;
      expect(parts.length, name).toBe(before.length);
      parts.forEach((part, k) => {
        expect(triangles(part.geometry), `${name} part ${k}`).toEqual(triangles(before[k]!.geometry));
        expect([part.texture, part.mask, part.colours]).toEqual([before[k]!.texture, before[k]!.mask, before[k]!.colours]);
      });
    }
  });
});
