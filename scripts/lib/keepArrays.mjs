/** Run in the page before any of the game's scripts: the arrays of a geometry are kept when the engine lets them go once on the GPU
 *  (`mesh/gpuOnly.ts`, `roadLod.ts`, `farBlockBatches.ts`, the pole and prop cells set `array` to null), so a lab script can measure, draw and
 *  export them. Only for the lab's runs (`model-catalog.mjs`, `optimization-sheet.mjs`): the page holds more memory than the game does. */
export const KEEP_ARRAYS = `(() => {
  const held = Symbol('catalogue array');
  Object.defineProperty(Object.prototype, 'array', {
    configurable: true,
    get() { return this[held]; },
    set(value) {
      if (value === null && this[held] != null) return;
      this[held] = value;
    },
  });
})();`;
