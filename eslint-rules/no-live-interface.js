/**
 * NOTHING DRAWN AS THE GAME RUNS THAT COULD HAVE BEEN DRAWN ONCE (DO NOT suppress it inline): a canvas made, a drawing context or a WebGL
 * context asked for, a picture encoded (`toDataURL`, `toBlob`), a renderer made - outside the files `eslint.config.js` names, each with why.
 *
 * The menus show photos taken once (`src/ui/photos.ts`, `scripts/interface-photos.mjs`): the Builder photographed each of its options as it
 * opened, in a second WebGL context beside the game's, the game at 4 frames a second and the walls black (2026-10-27); the road cards, the
 * finishes, the plan shapes and the road classes were each painted on a canvas as their menu opened.
 */
const ENCODE = new Set(['toDataURL', 'toBlob', 'convertToBlob']);
const RENDERERS = new Set(['WebGLRenderer', 'WebGPURenderer', 'OffscreenCanvas']);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'No canvas, drawing context, renderer or encoded picture made as the game runs outside the files allowed with a reason.' },
    schema: [{ type: 'object', properties: { allowed: { type: 'object', additionalProperties: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      live: '{{what}} as the game runs: a menu shows a photo taken once (`src/ui/photos.ts`, `npm run photos`); the game draws in its one context (`render/renderer.ts`). Any other place is named, with why, in `eslint.config.js` no-live-interface.',
    },
  },
  create(context) {
    const allowed = context.options[0]?.allowed ?? {};
    const file = context.filename.replace(/\\/g, '/');
    if (Object.keys(allowed).some((path) => file.endsWith(path))) return {};
    const report = (node, what) => context.report({ node, messageId: 'live', data: { what } });
    return {
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && RENDERERS.has(node.callee.name)) report(node, `A ${node.callee.name} made`);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        const name = callee.property.name;
        // `canvas.getContext(kind)`; a renderer's own `getContext()` hands the context it has.
        if (name === 'getContext' && node.arguments.length > 0) report(node, 'A drawing context asked for');
        else if (ENCODE.has(name)) report(node, `A picture encoded (\`${name}\`)`);
        else if (name === 'createElement' && node.arguments[0]?.type === 'Literal' && node.arguments[0].value === 'canvas') report(node, 'A canvas made');
      },
    };
  },
};
