import { describe, expect, it } from 'vitest';
import { findingsOf } from '@/lab/doctor/findings';
import type { Snapshot } from '@/lab/doctor/measure';

/** A measure with nothing in it but what a case puts there. */
const base = (over: Partial<Snapshot>): Snapshot => ({
  at: 0, frameMs: 16.7, cpuMs: 4, gpuMs: 8, frames: 120, passes: [], draws: [], systems: [], functions: [], libraryFunctions: [], timeline: null, drawCalls: 300, triangles: 1e6, hitches: 0,
  waste: null, hidden: [], hiddenSeconds: 10, checks: [], suspects: [], contexts: ['src/render/renderer.ts:462'], ...over,
});

describe('the diagnosis names what buys nothing on the screen', () => {
  it('tells a listener working beside the frame, a canvas made as the game runs and buffers sent again, each by its line', () => {
    const found = findingsOf(base({
      hidden: [
        { kind: 'event', what: 'pointermove', where: 'src/ui/v2/shell.ts:900', msPerSecond: 20, callsPerSecond: 60, bytesPerSecond: 0 },
        { kind: 'frame', what: '', where: 'src/frameLoop.ts:30', msPerSecond: 700, callsPerSecond: 60, bytesPerSecond: 0 },
        { kind: 'canvas', what: 'canvas', where: 'src/ui/roads/profileSwatch.ts:17', msPerSecond: 0, callsPerSecond: 0.3, bytesPerSecond: 0 },
        { kind: 'buffer', what: 'position', where: 'src/render/agents.ts:1829', msPerSecond: 0, callsPerSecond: 600, bytesPerSecond: 80 * 1048576 },
      ],
    }));
    const ids = found.map((f) => f.id);
    expect(ids).toContain('work.event.pointermove.src/ui/v2/shell.ts:900');
    expect(found.find((f) => f.id.startsWith('work.event'))!.where).toBe('src/ui/v2/shell.ts:900');
    // The game's own frame is never hidden work.
    expect(ids.some((id) => id.includes('frameLoop'))).toBe(false);
    expect(found.find((f) => f.id.startsWith('made.canvas'))!.area).toBe('Interface');
    expect(found.find((f) => f.id.startsWith('asked.buffer'))!.severity).toBe('high');
  });

  it('tells a second WebGL context alive', () => {
    const found = findingsOf(base({ contexts: ['src/render/renderer.ts:462', 'src/render/buildings/referenceModel.ts:86'] }));
    expect(found.find((f) => f.id === 'made.contexts')!.severity).toBe('high');
  });

  it('weighs the waste scan: the same bytes sent again, copies, models finer than their pixels, still matrices', () => {
    const found = findingsOf(base({
      waste: {
        frames: 24,
        resends: [{ kind: 'buffer', name: 'instanceMatrix', holder: 'cars', layer: 'world / agent-parts', sends: 24, bytes: 2 * 1048576, same: true, hidden: false }],
        stillMatrices: [{ layer: 'world / signs', objects: 6000 }], stillMatrixObjects: 6000,
        held: [],
        copies: [{ kind: 'geometry', names: ['a', 'b'], copies: 3, bytes: 20 * 1048576, wasted: 40 * 1048576 }],
        dense: [{ name: 'car-body', layer: 'world / agent-parts', kind: 'InstancedMesh', triangles: 20000, instances: 200, radiusPx: 4, trianglesPerPixel: 400, excess: 3.9e6, shadow: false }],
        thrown: [],
        tiny: [],
      },
    }));
    const of = (prefix: string) => found.find((f) => f.id.startsWith(prefix))!;
    expect(of('resend.').severity).toBe('high');
    expect(of('copies.geometry').severity).toBe('high');
    expect(of('dense.').severity).toBe('high');
    expect(of('dense.').layer).toBe('world / agent-parts');
    expect(of('matrices.still').severity).toBe('medium');
  });

  it('nothing to tell, nothing told: a quiet measure gives no waste, work or interface cause', () => {
    const found = findingsOf(base({}));
    expect(found.filter((f) => ['Waste', 'Work', 'Interface'].includes(f.area))).toEqual([]);
  });
});
