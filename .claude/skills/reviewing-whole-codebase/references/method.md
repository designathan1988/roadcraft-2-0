# Method: understanding code and proving its problems

## Contents
0. Research on the internet, all the time
1. Establish the contract before judging
2. Read a file so that it is understood
3. Trace behaviour: state, values and identity
4. Choose cases that tell right from wrong
5. What counts as a problem
6. From suspicion to proof
7. Verify a finding
8. Fix a finding
9. Writing notes and findings
10. Mistakes that make a review worthless

## 0. Research on the internet, all the time

What you remember about a language, library, framework, API, tool or platform may be outdated or wrong for the version this project uses. So every claim about how something external behaves is checked on the internet at the moment it matters, not once at the start:

- **While reading a file**: for each library call, framework hook, language feature with subtle semantics (coercion, async ordering, mutation, scoping), platform or browser API, configuration key, or command flag the lines use, open its official documentation for the installed version (versions are in the manifests and lockfiles; `npm ls <pkg>` and similar are allowed). Write what each page settled in the note's `## Sources`.
- **While deciding a finding** (`work F-NNNN`, phase verify): open the documentation that decides whether the behaviour is wrong. Cite it in `Source:`.
- **Before changing code** (`work F-NNNN`, phase fix): open the documentation of the right way to do it for that version: API signature, recommended pattern, deprecations, migration notes, known issues. Cite it in `Fix source:`. The edit hook refuses changes before this.
- **When something surprises you** (an error, an unexpected result in the app test): search the exact message and the version, then open the strongest sources.

How: prefer official documentation, specifications, release notes and the project's own repository or issue tracker; then maintainer posts; community answers only as leads. Open the page with WebFetch (a search result snippet is not reading). Check that the page covers the version in use. When sources disagree, prefer the one closest to the authority and the version, and say so. Never cite a page you did not open.

## 1. Establish the contract before judging

Code is judged against what it must do, not against itself. Before deciding that something is wrong, know the intended behaviour:

- **Normative sources** (they define required behaviour): explicit user requirements, project instructions, specifications, schemas, API definitions, documented decisions, the documented contract of a library the code relies on.
- **Descriptive sources** (they explain, but do not by themselves impose): READMEs, comments, tests, examples. A test or comment may show intent; it may also be wrong.
- When sources disagree and nothing says which wins, record the conflict as a finding instead of choosing silently.

For every unit (function, class, module, endpoint, script) write down, in the note, its contract: inputs and their valid ranges and units, outputs, side effects, invariants it keeps, errors it raises or returns, and who calls it with what.

## 2. Read a file so that it is understood

- Read in order, chunk by chunk, to the end. Describe each range as you go: imports and what they bring, declarations, each function and what it does with which data.
- For each function: what it reads, what it writes (its own state, shared state, files, network, the screen), what it returns, what it throws, what it schedules for later (callbacks, promises, timers, events).
- Follow every name to its definition when its behaviour matters: if the definition is in a file read earlier, open that file's note; if it is in a file not read yet, write a `Check:` on a suspected finding or in "To check in other files".
- Note what the file promises to others (exports, public API) and what it assumes about them.

## 3. Trace behaviour: state, values and identity

When a piece of code could be wrong, run it in your head over a concrete case and write the important steps:

`location | what it reads | what it writes or returns | does the contract still hold?`

Rules that prevent wrong conclusions:

- **Identity is not equality.** Assigning an object or array copies the reference; a later mutation is visible through every alias. A shallow copy keeps the inner references.
- **Missing, null, undefined, empty, zero and false are different** in most languages; check the exact operator (`||` versus `??`, truthiness, default parameters, `get` with default).
- **Evaluation order and timing matter**: what is captured by a closure or callback, what may change before an asynchronous continuation runs, what happens when an operation is cancelled or fails half way, what cleanup runs.
- **Loops and recursion**: check the first iteration, a middle one, the last one and the empty case; check termination.
- **Errors**: follow the real handler chain; check whether partial changes are rolled back or left behind.
- **Units and scales**: cents versus currency units, percent versus fraction, pixels versus points, seconds versus milliseconds, zero-based versus one-based.
- Keep unknowns as unknowns (`unknown: <why>`); do not fill them with the convenient value.

## 4. Choose cases that tell right from wrong

Defaults hide bugs. Choose inputs that separate correct from incorrect behaviour:

- below, at and above every threshold or boundary in the code;
- empty, one, many; first, middle, last; duplicates;
- non-default modes and selections; values that make two branches differ;
- the same object reached through two references, and an equal but distinct copy;
- failure in the middle (I/O error, exception, cancellation, timeout) and the state left after it;
- repeated calls, calls in a different order, re-entry, concurrent calls where the code allows them;
- data written and then read back (save/load, serialize/parse, cache/refresh).

## 5. What counts as a problem

Anything in the code that is wrong for its purpose:

- **Logic**: wrong condition, inverted branch, off-by-one, precedence, wrong operator, identity versus value comparison.
- **Unhandled cases**: empty, null, zero, negative, huge, duplicate, missing file or key, failure of a dependency.
- **Contracts between files**: a caller passing a shape, unit, order or type the callee does not expect; a writer and a reader that disagree; exports nobody uses; imports of things that do not exist.
- **State and lifetime**: stale references or closures, shared data mutated where a copy was meant, missing reset, wrong initialization order.
- **Concurrency and async**: races, results applied after cancellation, unawaited operations, ordering the runtime does not guarantee, re-entrancy.
- **Errors**: swallowed (empty catch, ignored return codes), misreported, or leaving partial state.
- **Resources**: listeners, timers, subscriptions, handles, buffers, connections or GPU/OS objects created and never released; caches that only grow.
- **Wasted work**: something recomputed, re-sent or re-created on every call, frame or event with no change; work proportional to everything where only what changed was needed.
- **Security and data safety**: untrusted input reaching a query, shell, path, HTML or eval; secrets in code; missing permission checks.
- **API misuse**: a library or platform call used against its documentation for the installed version (read the official docs for that version; cite them in `Source:`).
- **Lies in the code**: comments, names, messages or counters that say what the code does not do; dead code; unreachable branches; configuration that has no effect.
- **Tests**: tests that cannot fail, assert the implementation instead of the behaviour, are skipped, or miss the case a finding shows.

## 6. From suspicion to proof

A finding is proven by a path, not by a feeling:

`starting state → trigger → path:line where it goes wrong → value or effect produced → where it reaches the user, the data or another module`

1. Read the definitions involved, not only the call site.
2. Follow the data both ways: who produces this value, who consumes it.
3. Use a concrete discriminating case (section 4).
4. Look for what could make it fine: an earlier guard, a later correction, a framework or language rule, documented library behaviour.
5. Find the earliest place where it goes wrong; the symptom is often far from the cause.
6. A suspicious construct with no reachable bad consequence is not a finding (but a lie in the code is).

## 7. Verify a finding

In phase verify, every suspected finding is re-checked in the current code: Read its lines and the links of its proof again (the hook records it). Decide:

- `confirmed`: the proof holds for a reachable case; write the `Proof:` path.
- `rejected`: something in the code or the documented semantics prevents it; `Rejected because:` names that code or source.
- If a link is still unknown, resolve it (read the code or the official docs). Do not confirm on a guess.
- Every decision cites in `Source:` the documentation opened for it (section 0).

## 8. Fix a finding

- Fix where the problem starts, not where it shows. If one cause produces several findings, fix the cause once and reference every finding.
- The smallest change that makes the contract hold for every case in section 4, not only the one in the proof.
- Never: swallow the error, add a default or guard that hides the cause, hard-code the expected value, disable a check, weaken or delete a test.
- Before editing, research how to do it right for the installed version (section 0) and cite it in `Fix source:`.
- The fix is checked in the code, not by running anything: re-read the changed lines (`Verified by: re-read path:a-b`), trace the discriminating cases of section 4 through the new code, and re-read every caller and consumer listed in the notes ("used by"); update the notes that became wrong.
- Run the static check (type checker or linter) as a plain command; it must pass. Tests, benchmarks and the app run only in phase apptest, after all the code work.

## 9. Writing notes and findings

Note (one per file, `.whole-review/notes/<path>.md`):

```
# src/store/cart.ts
Lines: 140
Summary: Cart store: items, cached total in cents, persistence to localStorage.

## Structure (every non-blank line range, 1 to the end, and what it holds)
- 1-12 imports: Item type from ../types, save/load from ./persist
- 14-38 class Cart fields: items[], sum (cached total in cents), listeners[]
- 40-61 addItem(item, qty): validates qty>0, pushes, adds price*qty to sum, notifies
- 62-99 removeItem(id): splices the item; does NOT update sum (F-0007)
- 100-111 clear(): empties items and sets sum to 0
- 112-140 load()/save(): JSON of {items}; sum is not saved, load does not recompute it (F-0008)

## Contracts, state and data flow
- invariant: sum == Σ price*qty in cents; kept only by addItem and clear

## Depends on / used by
- uses: src/types.ts, src/store/persist.ts; used by: src/checkout.ts (reads sum), src/ui/CartView.tsx

## Problems found (finding IDs)
- F-0007, F-0008

## To check in other files
- src/checkout.ts: does it trust cart.sum? (Check: on F-0007)

## Sources (pages opened with WebFetch while reading this file, and what each settled)
- https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage : values are strings; JSON round-trip needed (lines 112-140 do it)
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/splice : splice mutates in place and returns the removed items (line 88)
```

Finding (in `.whole-review/FINDINGS.md`):

```
### F-0007 · suspected · S2 · src/store/cart.ts:88 — removeItem leaves the cached total stale
What: removeItem splices the item but never subtracts it from sum.
Proof: cart.ts:52 addItem adds price*qty to sum; cart.ts:88 removeItem only splices; checkout.ts:22 charges cart.sum.
Effect: after removing an item, checkout charges the old total.
Fix plan: subtract price*qty in removeItem, or derive sum from items.
Check: src/checkout.ts
```

Severity: S1 breaks behaviour, data or security; S2 wrong result in a real case; S3 waste, fragility or misleading code; S4 cosmetic.

## 10. Mistakes that make a review worthless

- Reading the start of a file and assuming the rest; judging a file by its name or a search hit.
- A note that names the file's parts without saying what they do and with which data.
- Using a fact about an earlier file from memory instead of its note.
- Relying on remembered library or platform behaviour instead of the documentation of the installed version; researching once at the start and never again; citing a page that was not opened.
- Running tests, benchmarks or the app to find problems during the code work instead of reading the code.
- Confirming a suspicion without re-reading the code; rejecting one without naming what disproves it.
- Fixing the symptom where the cause is upstream; masking it with a guard, default or catch.
- Deleting, skipping or weakening a test to make it pass.
- Saying "everything is fixed" when the record shows open or blocked findings.
