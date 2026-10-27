import { describe, expect, it } from 'vitest';
import { servedOf } from '@/lab/hiddenWork';

describe('the hidden-work watch finds the line of src/ that asked', () => {
  it('takes the first frame in src/, past its own module, with the line and column served', () => {
    const stack = [
      'Error',
      '    at site (http://127.0.0.1:5300/src/lab/hiddenWork.ts?t=1:120:18)',
      '    at http://127.0.0.1:5300/node_modules/.vite/deps/three.js?v=abc:900:3',
      '    at fitDrawer (http://127.0.0.1:5300/src/ui/v2/shell.ts?t=17:2620:11)',
      '    at main (http://127.0.0.1:5300/src/main.ts:10:2)',
    ].join('\n');
    expect(servedOf(stack)).toEqual({ url: 'http://127.0.0.1:5300/src/ui/v2/shell.ts?t=17', path: 'src/ui/v2/shell.ts', line: 2620, column: 11 });
  });
  it('names no line when the stack never enters src/', () => {
    expect(servedOf('Error\n    at http://127.0.0.1:5300/node_modules/three.js:1:1')).toBeNull();
  });
});
