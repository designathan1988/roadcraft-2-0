import { type UserConfig, defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config.ts';

/** THE DESKTOP'S JOB THREADS AND ITS SIMULATION THREAD BUILT FOR NODE (`desktop/jobs.cjs`, `src/jobs/nodeJobHost.ts`, `src/nodeSimHost.ts`): the game's own job worker and simulation worker, every module they load bundled in (no node_modules beside the game), next to the page's build (`dist/desktop-jobs/`, served nowhere: read by the utility processes). Two entries of one build (Vite `build.ssr: true` with `rollupOptions.input`, https://vite.dev/config/build-options#build-ssr): what they share is one chunk. */
export default mergeConfig(base as UserConfig, defineConfig({
  build: {
    ssr: true,
    outDir: 'dist/desktop-jobs',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    rollupOptions: {
      input: { jobHost: 'src/jobs/nodeJobHost.ts', simHost: 'src/nodeSimHost.ts' },
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
}));
