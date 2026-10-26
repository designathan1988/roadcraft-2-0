import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * THE GAME'S WINDOW WHILE IT IS WORKED ON (`npm run desktop:dev`): the desktop app loading the project's server (`npm run dev`, port 5300), so
 * every change of the code reloads it, with remote debugging on 9333 of this machine for the checks run in that window (`scripts/inGame.mjs`);
 * no Steam. The job threads read `dist/desktop-jobs` (`npm run desktop:jobs:watch` keeps it built). The window is shown and stays until closed.
 */
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['desktop/main.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, ROADCRAFT_DEV_URL: 'http://127.0.0.1:5300/', ROADCRAFT_DEBUG_PORT: '9333', ROADCRAFT_NO_STEAM: '1' },
});
child.on('exit', (code) => process.exit(code ?? 0));
