/** DO NOT suppress it inline. */
const RIBBON_WALKS = new Set(['values', 'keys', 'entries', 'forEach']);
/**
 * The document's collections of the whole map (`RoadDoc`): walking one is work as large as the map, on whatever thread it runs. DO NOT
 * leave them out of the rule: the power lines' ends were looked for over `doc.poles` at every opening of the 10 km city, on the page, and
 * the rule (then about the buildings and the ribbons alone) let it through (2026-10-27).
 */
const DOC_MAPS = new Set(['poles', 'poleSpans', 'segments', 'nodes', 'landscape', 'lots', 'barriers', 'buildings']);
/** Of `buildings`, the walks of every building (`BuildingStore`); the others are lookups. */
const BUILDING_WALKS = new Set(['all', 'values', 'keys', 'entries', 'forEach', 'eachSummarised', 'each']);

const named = (node, name) => node && node.type === 'MemberExpression' && !node.computed
  && node.property.type === 'Identifier' && node.property.name === name;

/** Whether `node` is the document: `doc`, `….doc`, `this.doc`. */
const isDoc = (node) => node && ((node.type === 'Identifier' && node.name === 'doc')
  || (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'doc'));

/** The document's whole-map collection `node` is (`doc.poles`), or null. */
const docMap = (node) => (node && node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
  && DOC_MAPS.has(node.property.name) && isDoc(node.object) ? node.property.name : null);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Every record of a kind of the map walked only in a function marked @rebuild.' },
    schema: [],
    messages: {
      walk: 'Walks {{what}} of the whole map outside a `@rebuild`: find what is near by an index, what changed by the diary.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    /** Whether the function holding `node` is marked: its doc comment, or a comment in it before the walk. */
    const marked = (node) => {
      for (let fn = node.parent; fn; fn = fn.parent) {
        if (fn.type !== 'FunctionDeclaration' && fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') continue;
        const holder = fn.parent && (fn.parent.type === 'MethodDefinition' || fn.parent.type === 'Property' || fn.parent.type === 'VariableDeclarator') ? fn.parent : fn;
        const leading = [...source.getCommentsBefore(holder), ...source.getCommentsBefore(holder.parent?.type === 'VariableDeclaration' || holder.parent?.type === 'ExportNamedDeclaration' ? holder.parent : holder)];
        if (leading.some((c) => c.value.includes('@rebuild'))) return true;
        if (source.getCommentsInside(fn).some((c) => c.value.includes('@rebuild') && c.range[0] < node.range[0])) return true;
      }
      return false;
    };
    const report = (node, what) => { if (!marked(node)) context.report({ node, messageId: 'walk', data: { what } }); };
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        const method = callee.property.name;
        if (method === 'all' && named(callee.object, 'buildings')) { report(node, 'every building'); return; }
        if (RIBBON_WALKS.has(method) && named(callee.object, 'ribbons')) { report(node, 'every road'); return; }
        const map = docMap(callee.object);
        if (!map) return;
        if (map === 'buildings' ? BUILDING_WALKS.has(method) : RIBBON_WALKS.has(method)) report(node, `every record of doc.${map}`);
      },
      ForOfStatement(node) {
        if (named(node.right, 'ribbons')) { report(node.right, 'every road'); return; }
        const map = docMap(node.right);
        if (map) report(node.right, `every record of doc.${map}`);
      },
    };
  },
};
