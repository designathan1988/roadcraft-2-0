import { describe, expect, it } from 'vitest';
import { sourceLinesOf } from '@/lab/hiddenWork';

describe('the hidden-work watch reads the served code back to its source lines', () => {
  it('maps each served line to the source line of its first segment', () => {
    // Served line 1 from source line 1 (AAAA), served line 2 empty, served line 3 from source line 4 (AAGA: +3), then line 2 (AAEA... -2 is F).
    const lines = sourceLinesOf('AAAA;;AAGA;AAFA');
    expect([...lines]).toEqual([0, 1, 0, 4, 2]);
  });
  it('carries the source line across segments of a line, telling the first', () => {
    // One served line: segments at source lines 1 and 6 (+5 = K); the next line goes on from 6 (+1 = C).
    const lines = sourceLinesOf('AAAA,EAKA;AACA');
    expect([...lines]).toEqual([0, 1, 7]);
  });
});
