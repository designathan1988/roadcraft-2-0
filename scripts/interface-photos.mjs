// THE INTERFACE'S PHOTOS, TAKEN ONCE: every option a menu shows (`src/lab/interfacePhotos.ts`), photographed on the lab page that never starts
// the game, and written to `src/ui/photos/<shelf>/<option>.png`, which the menus show as they are (`src/ui/photos.ts`). Nothing of the
// interface is drawn as the game runs (`eslint-rules/no-live-interface.js`). Run after a change to how an option looks: `npm run photos`.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const url = 'http://127.0.0.1:5310/';
const { createServer } = await import('vite');
// A port of its own, watching no file: the photos are not taken by the game's dev server (https://vite.dev/config/server-options, `server.watch`).
const server = await createServer({ server: { host: '127.0.0.1', port: 5310, strictPort: true, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  // A static file of the server: the same origin, so the engine's modules load, but the game itself never starts.
  await page.goto(`${url}public/models/citizens/LICENSE-ANIMATIONS.txt`);
  const shelves = await page.evaluate(async () => (await import('/src/lab/interfacePhotos.ts')).photographInterface());
  const { photoFile } = await server.ssrLoadModule('/src/ui/photos.ts');
  for (const [shelf, photos] of Object.entries(shelves)) {
    const dir = join(process.cwd(), 'src', 'ui', 'photos', shelf);
    // The shelf written whole: a photo of an option that is gone does not stay.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [id, dataUrl] of Object.entries(photos)) writeFileSync(join(dir, photoFile(id)), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    console.log(`${shelf}: ${readdirSync(dir).length} photos`);
  }
} finally {
  await browser.close();
  await server.close();
}
