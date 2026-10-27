// THE GPU'S CLOCKS LOGGED BESIDE A TIMED RUN, READ ONLY: `nvidia-smi` queried every 100 ms (its pstate, core and memory clocks, its load), so a
// sheet's GPU times can be read against the clocks they were taken at (`src/lab/steadyTiming.ts`). Nothing is set: the clocks are never locked.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const QUERY = 'timestamp,pstate,clocks.gr,clocks.mem,utilization.gpu,power.draw';

/** Starts the log into `file` (CSV, nvidia-smi's own lines); `stop()` ends it and gives back its rows. */
export function startClockLog(file) {
  const rows = [];
  const out = createWriteStream(file);
  out.write(`${QUERY}\n`);
  const child = spawn('nvidia-smi', [`--query-gpu=${QUERY}`, '--format=csv,noheader,nounits', '-lms', '100'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ended = false;
  const finished = new Promise((done) => {
    const end = () => { if (!ended) { ended = true; out.end(); } done(rows); };
    child.on('close', end);
    // No NVIDIA tool: said, and the run goes on without a clock log.
    child.on('error', (error) => { console.error(`gpu clocks: nvidia-smi failed (${error.message}): no clock log`); end(); });
  });
  let rest = '';
  child.stdout.on('data', (chunk) => {
    out.write(chunk);
    rest += chunk.toString();
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const [stamp, pstate, gr, mem, load, power] = line.split(',').map((x) => x.trim());
      const t = Date.parse(stamp.replace(/\//g, '-').replace(' ', 'T'));
      if (Number.isFinite(t)) rows.push({ t, pstate, gr: Number(gr), mem: Number(mem), load: Number(load), power: Number(power) });
    }
  });
  return {
    /** The rows logged so far (the same array `stop` resolves with). */
    rows,
    stop: () => {
      if (!ended && child.exitCode === null) child.kill();
      return finished;
    },
  };
}

/** The clocks logged inside `window` ({ start, end }, ms since the epoch): each number's lowest, median and highest, the pstates seen. */
export function clocksDuring(rows, window) {
  const inside = rows.filter((r) => r.t >= window.start && r.t <= window.end);
  const stats = (key) => {
    const v = inside.map((r) => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? { min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1] } : null;
  };
  return { readings: inside.length, pstates: [...new Set(inside.map((r) => r.pstate))], core: stats('gr'), memory: stats('mem'), load: stats('load') };
}
