import { chromium } from 'playwright';

/**
 * A CHECK RUN IN THE GAME'S OPEN WINDOW (`npm run desktop:dev`: the desktop app on the project's server, remote debugging on
 * `ROADCRAFT_DEBUG_PORT`), never in another one: connected over the DevTools protocol, the check run, the connection dropped - the window stays
 * open as it was (the process exits without closing the browser).
 *
 *   node scripts/inGame.mjs eval "<expression>"            the expression's value in the page, as JSON
 *   node scripts/inGame.mjs until "<expression>" [ms]     waits until it is truthy (default 30 min), prints the seconds it took
 *   node scripts/inGame.mjs shot <file.png>               a picture of the window as it is
 *   node scripts/inGame.mjs errors [ms]                   the page loaded again, its errors and warnings for `ms` (default 15 s)
 */

const PORT = process.env.ROADCRAFT_DEBUG_PORT ?? '9333';
const [command, arg, extra] = process.argv.slice(2);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://'));
if (!page) {
  console.error(`no game window on port ${PORT}: start it with \`npm run desktop:dev\``);
  process.exit(1);
}
if (command === 'eval') {
  console.log(JSON.stringify(await page.evaluate(arg), null, 2));
} else if (command === 'until') {
  const started = Date.now();
  await page.waitForFunction(arg, null, { timeout: Number(extra ?? 1_800_000), polling: 500 });
  console.log(`true after ${((Date.now() - started) / 1000).toFixed(1)} s`);
} else if (command === 'shot') {
  await page.screenshot({ path: arg, type: 'png' });
  console.log(`saved ${arg}`);
} else if (command === 'errors') {
  // The page loaded again, its console's errors and warnings and its uncaught errors printed for `arg` ms (default 15 s).
  const lines = [];
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') lines.push(`${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => lines.push(`pageerror: ${error.message}`));
  await page.reload({ waitUntil: 'commit' });
  await new Promise((wake) => setTimeout(wake, Number(arg ?? 15_000)));
  console.log(lines.length ? lines.join('\n') : '(no error, no warning)');
} else {
  console.error('usage: node scripts/inGame.mjs eval|until|shot ...');
  process.exit(2);
}
// The connection dropped with the process: the window is the owner's and stays open.
process.exit(0);
