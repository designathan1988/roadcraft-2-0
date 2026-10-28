// THE OWNER'S ORDERS, WORD FOR WORD, ACROSS COMPACTIONS.
// A compaction replaces the conversation with a summary written by the model, and an order the summary rewrote or dropped is lost:
// only the project-root CLAUDE.md, unscoped rules, skills and the output of SessionStart hooks matching `compact` come back from disk
// (https://code.claude.com/docs/en/context-window#what-survives-compaction). So the orders do not wait for anyone to copy them:
// - UserPromptSubmit: every prompt the owner sends is appended, as typed, with its time, to docs/agent/orders.md (nothing printed).
// - SessionStart (startup, resume, clear, compact): the newest orders are printed verbatim, newest first, within what a hook can hand over
//   whole (10,000 characters, https://code.claude.com/docs/en/hooks; past it only a 2 KB preview reaches the session).
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
const file = path.join(root, 'docs', 'agent', 'orders.md');
/** What the printed orders may take, under the hook's 10,000 characters. */
const MOST = 9500;
/** The separator between two orders in the file. */
const SEP = '\n\n---\n';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch (error) {
    process.stderr.write(`orders.cjs: the hook's input is not JSON (${error.message})\n`);
    process.exit(0);
  }
  if (input.hook_event_name === 'UserPromptSubmit') record(input);
  else print();
});

/** One prompt of the owner's, appended as typed. */
function record(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return;
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '# The owner\'s orders, word for word (written by .claude/hooks/orders.cjs at every prompt; newest last)\n');
  }
  fs.appendFileSync(file, `${SEP}${at}\n\n${prompt}\n`);
}

/** The newest orders, newest first, as many whole as fit; the one that does not fit cut, with the file's name to read the rest. */
function print() {
  if (!fs.existsSync(file)) return;
  const orders = fs.readFileSync(file, 'utf8').split(SEP).slice(1).map((o) => o.trim()).filter(Boolean).reverse();
  if (!orders.length) return;
  const head = 'THE OWNER\'S LATEST ORDERS, WORD FOR WORD, NEWEST FIRST (docs/agent/orders.md holds every one). They stand above any summary: '
    + 'obey them as written; a later order overrides an earlier one only where they conflict.\n\n';
  const tail = '\n\n(Older orders: read docs/agent/orders.md.)\n';
  let out = head;
  for (const order of orders) {
    const block = `[${order}]\n\n`;
    if (out.length + block.length + tail.length > MOST) {
      const room = MOST - out.length - tail.length - 40;
      if (room > 200) out += `[${order.slice(0, room)} ... (cut: read docs/agent/orders.md)]\n\n`;
      break;
    }
    out += block;
  }
  process.stdout.write(out + tail);
}
