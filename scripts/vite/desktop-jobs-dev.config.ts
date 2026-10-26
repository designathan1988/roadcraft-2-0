import { type UserConfig, defineConfig, mergeConfig } from 'vite';
import jobs from './desktop-jobs.config.ts';

/** THE DESKTOP'S JOB THREADS REBUILT AS THE CODE CHANGES (`npm run desktop:dev`, `vite build --watch`): the folder never emptied between builds, so a page reloaded while a build runs still finds its threads' code (each page's threads are made anew, `desktop/jobs.cjs`). */
export default mergeConfig(jobs as UserConfig, defineConfig({ build: { emptyOutDir: false } }));
