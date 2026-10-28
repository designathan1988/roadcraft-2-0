import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import noSilentCatch from './eslint-rules/no-silent-catch.js';
import noModuleState from './eslint-rules/no-module-state.js';
import noGlobalRevision from './eslint-rules/no-global-revision.js';
import noWholeMapWalk from './eslint-rules/no-whole-map-walk.js';
import noLogicTimer from './eslint-rules/no-logic-timer.js';
import noLiveInterface from './eslint-rules/no-live-interface.js';

/** The repository's own rules (`eslint-rules/`). */
const roadcraft = {
  rules: {
    'no-silent-catch': noSilentCatch,
    'no-module-state': noModuleState,
    'no-global-revision': noGlobalRevision,
    'no-whole-map-walk': noWholeMapWalk,
    'no-logic-timer': noLogicTimer,
    'no-live-interface': noLiveInterface,
  },
};

/** THE LAYER ORDER, ENFORCED. */
const LAYERS = {
  core: ['core'],
  world: ['core', 'world'],
  sim: ['core', 'world', 'sim'],
  view: ['core', 'view'],
  render: ['core', 'world', 'sim', 'view', 'render'],
  editor: ['core', 'world', 'editor'],
  ui: ['core', 'world', 'sim', 'view', 'ui'],
};

const ALL = Object.keys(LAYERS);

/** One ESLint block per layer, banning every alias it may not import. */
const layerRules = Object.entries(LAYERS).map(([layer, allowed]) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: ALL.filter((other) => !allowed.includes(other)).map((other) => ({
          group: [`@${other}/*`, `@/${other}/*`],
          message:
            `${layer} may not import ${other}. See the dependency order in ` +
            'CLAUDE.md (Layers) - if the thing you want is in the wrong ' +
            'layer, move the thing rather than the import.',
        })),
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      // The probe build, the runs' reports and the agents' worktrees: generated, never source.
      'dist-probe/**',
      'lab-reports/**',
      'test-results/**',
      '.claude/**',
      'research_notes/**',
      'reports/**',
      'node_modules/**',
      'docs/screenshots/**',
      // Dropped-in assets and generated output.
      'incoming/**',
      'exports/**',
      'cooked/**',
      // The desktop build (`npm run desktop:pack`): Electron and the game, compiled and packed
      'release/**',
      // Systems taken out of the game, kept for reference only.
      'src/backup/**',
      // The labs (FORMA, `labs/building/forma`)
      'labs/**',
      // Agent worktrees are full checkouts of the repository; they are linted in their own checkout, never from this one.
      '.claude/**',
      // Scratch space for investigation.
      'tests/**/_*/**',
      'tests/**/_*',
      'scripts/**/_*/**',
      'scripts/**/_*',
      // `zz` is this working tree's older scratch prefix for the same kind of file
      '**/zz*.mjs',
      '**/zz*.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...layerRules,
  {
    // One file, one responsibility; none over 800 lines (CLAUDE.md).
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.mjs', '*.ts', '*.js'],
    plugins: { roadcraft },
    rules: {
      'max-lines': ['error', { max: 800, skipBlankLines: false, skipComments: false }],
      'no-empty': 'error',
      'no-useless-catch': 'error',
      'roadcraft/no-silent-catch': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.d.ts'],
    plugins: { roadcraft },
    rules: { 'roadcraft/no-module-state': 'error' },
  },
  {
    // What the code held when they came is in `eslint-suppressions.json` and may only shrink; DO NOT suppress them inline.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.d.ts'],
    plugins: { roadcraft },
    rules: {
      'roadcraft/no-global-revision': 'error',
      'roadcraft/no-whole-map-walk': 'error',
      'roadcraft/no-logic-timer': 'error',
    },
  },
  {
    // NOTHING DRAWN AS THE GAME RUNS THAT COULD BE DRAWN ONCE (`eslint-rules/no-live-interface.js`): the menus show photos taken once
    // (`src/ui/photos.ts`). Only these files may make a canvas, ask a context, encode a picture or make a renderer, each for the reason given;
    // the textures still painted as the game starts are in `scripts/baselines/eslint-suppressions.json` and may only shrink. DO NOT add a menu here.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.d.ts', 'src/lab/**'],
    plugins: { roadcraft },
    rules: {
      'roadcraft/no-live-interface': ['error', { allowed: {
        'src/render/renderer.ts': "the game's one renderer and its canvas; the lab's WebGPU comparison",
        'src/render/gpu/webgpuView.ts': "the WebGPU renderer, the game's one when it is chosen",
        'src/main.ts': "the game's canvas, and the editor's overlay, drawn as the player draws",
        'src/graphicsWiring.ts': "the GPU's name, from a context let go at once, before the game's renderer exists (its quality tier)",
        'src/render/ktx2Texture.ts': "what the GPU can take a compressed texture as, asked before the game's renderer exists",
        'src/render/inspector.ts': 'a picture the lab or a test asks for (`shot`)',
        'src/render/buildings/photo.ts': "a design photographed once as the player saves it, with the game's renderer; the Builder's photos taken once (lab)",
        'src/ui/roads/profileSwatch.ts': "a player's own road photographed once as it is saved (`templates.ts`)",
      } }],
    },
  },
  {
    // THE HEAVY WORK OFF THE FRAME (-65, 2026-10-15)
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.d.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "Identifier[name=/^(holdBuildings|buildingsHeld)$/]",
          message: 'Do not hold the buildings layer until a city is grown: every site graded and every building put in the layer in one frame (5.6 s). Grade and draw each building in the frame it grows.',
        },
        {
          selector: "FunctionDeclaration[id.name='frame'] CallExpression[callee.name=/^(rebuildSimulationTopology)$/], FunctionDeclaration[id.name='frame'] CallExpression[callee.property.name=/^(rebuildTopology|rebuildVehicleTopology|rebuildWalkTopology)$/]",
          message: 'Do not rebuild the traffic topology in the frame: TopologyCatchUp brings it up with its turns and pairs in the workers (a 5.8 s frame).',
        },
        {
          selector: "FunctionDeclaration[id.name='warmLoose'] CallExpression[callee.property.name='render'][arguments.0.name='scene']",
          message: "Do not draw the game's scene to send one mesh up: draw it alone (`LOOSE.scene`); three walks every object of a scene it draws.",
        },
      ],
    },
  },
  {
    // Where a revision or the diary itself is the thing
    files: ['src/core/engine.ts', 'src/core/changeLog.ts', 'src/world/changes.ts', 'src/world/derived.ts',
      'src/editor/persistence.ts', 'src/editor/history.ts', 'src/editor/chunkedSave.ts'],
    rules: { 'roadcraft/no-global-revision': 'off' },
  },
  {
    // Where waiting on the page is the point
    files: ['src/ui/**/*.ts', 'src/lab/**/*.ts', 'src/editor/persistence.ts', 'src/editor/mapExport.ts', 'src/conflictPool.ts',
      'src/render/people/**/*.ts', 'src/render/riggedCitizens.ts', 'src/render/citizenBake.ts',
      'src/render/buildings/parts.ts', 'src/frameLoop.ts'],
    rules: { 'roadcraft/no-logic-timer': 'off' },
  },
  {
    // Plain Node tooling.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Browser globals inside `page.evaluate` / `addInitScript` callbacks
    files: [
      'scripts/look.mjs',
      'scripts/look/*.js',
      'scripts/diagnose/*.mjs',
      'scripts/optimization-sheet.mjs',
      'scripts/people-sheet.mjs',
    ],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        getComputedStyle: 'readonly',
        OffscreenCanvas: 'readonly',
        FileReader: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        requestAnimationFrame: 'readonly',
        performance: 'readonly',
        PerformanceObserver: 'readonly',
        Profiler: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        Event: 'readonly',
        Image: 'readonly',
      },
    },
  },
  {
    // The desktop window's main process (`desktop/main.cjs`)
    files: ['desktop/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        // Node's fetch API, which Electron's `protocol.handle` answers with.
        Response: 'readonly',
        Headers: 'readonly',
        // The page's window, which the preload hands the saves' port to (`desktop/preload.cjs`).
        window: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // TypeScript performs the authoritative project-wide unused check.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // Canvas fakes and browser diagnostic surfaces intentionally model dynamic platform APIs
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
