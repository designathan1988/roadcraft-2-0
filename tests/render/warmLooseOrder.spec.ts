import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, type Scene, type WebGLRenderer } from 'three';

import { drainWarm, warmLooseAhead, warmPending } from '@render/uploads';

/** THE LOOSE MESHES WAITING TO GO UP SORTED ONLY WHEN SOMETHING MOVED (MISSION 1f): with the same ranks and no mesh come, the queue keeps its
 *  order frame after frame, the largest error still sent first. */

/** A renderer that only takes what it is asked to draw. */
const renderer = { render: (_scene: Scene) => {}, getRenderTarget: () => null, setRenderTarget: () => {} } as unknown as WebGLRenderer;

/** A mesh whose buffers fill a frame's upload alone (over 4 MiB). */
function big(): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(3 * 400_000), 3));
  return new Mesh(g, new MeshBasicMaterial());
}

afterEach(() => vi.restoreAllMocks());

describe('the loose meshes waiting to go up', () => {
  it('are sorted when one comes or a rank moves, not at every frame, and go largest error first', async () => {
    drainWarm(renderer);
    const meshes = [big(), big(), big(), big(), big(), big()];
    const errors = new Map(meshes.map((mesh, i) => [mesh, [3, 9, 1, 7, 5, 2][i]!] as const));
    const sorts = vi.spyOn(Array.prototype, 'sort');
    const ranked = (): number => sorts.mock.calls.filter(([compare]) => compare !== undefined && /\.rank - \w\.rank/.test(String(compare))).length;
    const sent: number[] = [];
    for (const mesh of meshes) void warmLooseAhead([mesh], () => errors.get(mesh)!)?.then(() => { sent.push(errors.get(mesh)!); });
    // One a frame (each over the frame's upload): the first frame sorts, the next ones do not while nothing moves.
    drainWarm(renderer);
    drainWarm(renderer);
    drainWarm(renderer);
    expect(ranked()).toBe(1);
    // A rank moved: sorted once more.
    errors.set(meshes[0]!, 100);
    drainWarm(renderer);
    expect(ranked()).toBe(2);
    while (warmPending()) drainWarm(renderer);
    // Each settles through its programs' promise and its batch's: a task later, all have.
    await new Promise((settled) => setTimeout(settled, 0));
    expect(sent).toEqual([9, 7, 5, 100, 2, 1]);
  });
});
