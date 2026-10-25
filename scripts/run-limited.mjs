/** DO NOT bring back the lock of one heavy job on the whole machine, the wait for the CPU to fall */
import { spawn } from 'node:child_process';
import { constants, cpus, setPriority } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';
import { joinSessionJob, share } from './sessionJob.mjs';

// Older callers' memory flags (`--kill-gb=N`, `--min-free-gb=N`): the job's memory cap does their work now.
const argv = process.argv.slice(2);
while (argv[0]?.startsWith('--kill-gb=') || argv[0]?.startsWith('--min-free-gb=')) argv.shift();
const [requested, ...args] = argv;
if (!requested) {
  process.stderr.write('Usage: node scripts/run-limited.mjs <command> [args...]\n');
  process.exit(2);
}

// npm and npx through their .cmd shims
const windows = process.platform === 'win32';
const executable = requested === 'npm' || requested === 'npx'
  ? windows ? join(dirname(process.execPath), `${requested}.cmd`) : requested
  : requested === 'node' ? process.execPath : requested;

const joined = joinSessionJob();
if (!joined.joined && windows) process.stderr.write(`[run-limited] not in the conversation's job: ${joined.why}\n`);
try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL); } catch (error) { console.error(`[run-limited] priority: ${error.message}`); }

// Vitest's workers: at most as many as the share has processors (6 of 24 at 25 %), fewer when asked, handed to the configs as
// `ROADCRAFT_MAX_WORKERS` (`vitest.config.ts`). DO NOT hand it on as `VITEST_MAX_WORKERS`: Vitest reads that one itself after the config and
// it overrides every config's own cap (vitest 4.1 `resolveConfig`) - the scale suite's one file at a time (`fileParallelism: false`) ran six
// heavy files at once, ~1.4 GB each, past the job's 8 GB, and its workers died "out of memory" with 65 MB of heap (2026-10-25).
const { percent } = share();
const workers = Math.max(1, Math.floor((cpus().length * percent) / 100));
const asked = Number(process.env.ROADCRAFT_MAX_WORKERS ?? process.env.VITEST_MAX_WORKERS);
const env = { ...process.env, ROADCRAFT_MAX_WORKERS: String(Number.isFinite(asked) ? Math.min(workers, Math.max(1, asked)) : workers), ROADCRAFT_IN_JOB: joined.joined ? '1' : '' };
delete env.VITEST_MAX_WORKERS;

const TIMEOUT_S = Number(process.env.RUN_LIMITED_TIMEOUT_S ?? 480);
// DO NOT go back to `shell: true` with the arguments apart: Node joins them with spaces unquoted
const viaCmd = windows && /\.cmd$/i.test(executable);
/** One word of a cmd.exe command line: quoted when it holds a space or a character cmd.exe reads. */
const cmdWord = (word) => (word === '' || /[\s"&|<>^()%!,;=]/.test(word) ? `"${word.replace(/"/g, '""')}"` : word);
const child = viaCmd
  // `/d` no AutoRun, `/s` the outer quotes taken off and the rest run as written, `/c` then exit.
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[executable, ...args].map(cmdWord).join(' ')}"`],
    { stdio: 'inherit', env, windowsVerbatimArguments: true })
  : spawn(executable, args, { stdio: 'inherit', env });
let stopping = false;
const stop = (signal) => {
  if (stopping || !child.pid) return;
  stopping = true;
  // The whole process tree, not only the parent: a Vitest worker or a Chrome renderer would keep running.
  if (windows) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill(signal);
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
};
const runaway = setTimeout(() => {
  process.stderr.write(`[run-limited] stopped after ${TIMEOUT_S} s (RUN_LIMITED_TIMEOUT_S)\n`);
  stop('SIGTERM');
}, TIMEOUT_S * 1000);
child.on('exit', () => clearTimeout(runaway));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (!stopping) process.exitCode = code ?? (signal ? 1 : 0); });
