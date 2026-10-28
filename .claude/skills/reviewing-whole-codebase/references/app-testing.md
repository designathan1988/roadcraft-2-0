# Testing the application as a real user

## Contents
1. When and why
2. Setting up Chrome
3. The gestures
4. How to explore
5. Screenshots: look at every one
6. Errors of every kind
7. From a defect on screen to its cause in code
8. Closing a round

## 1. When and why

Only in phase apptest, after all the code work of the block is done. The goal is to see whether the implementation works, whether anything broke, and how it feels to use: function, layout, text, usability. It is not a place for measurements or benchmarks (the hook refuses them) and not a place to change code (the hook refuses it): defects are recorded, traced to the code, verified and fixed in phases verify and fix, and then a new round tests again.

## 2. Setting up Chrome

- Start the app with the command declared in `set-app` (run it in the background so it keeps serving).
- `node "<skill>/scripts/browser.mjs" start --url <url>` opens Google Chrome (headless; `--headed` shows the window) at 1920x1080 with device scale 2: every screenshot is 3840x2160. `viewport mobile` reopens the page at 390x844, scale 3, with touch (the page reloads: state in memory is lost).
- Playwright is taken from the project, else from the skill folder. If neither has it: `npm install --prefix "<skill>" playwright-core` (allowed by the hook). Google Chrome must be installed.

## 3. The gestures

Targets are Playwright selectors (`role=button[name="Save"]`, `text=Checkout`, `#email`, `.row >> nth=2`) or a point `@x,y` read from a screenshot (CSS pixels: screenshot pixels divided by the scale).

| Command | What a person does |
| --- | --- |
| `move <t>` | moves the pointer there on a curved, uneven path |
| `hover <t>` | moves there and rests (tooltips, hover states) |
| `click <t>` / `--double` / `--right` | aims inside the target, not at its exact centre, pauses, presses and releases with a human hold; taps on mobile |
| `drag <from> <to>` | presses, passes the drag threshold with small moves, carries slowly, settles over the drop target, releases |
| `type <text> --into <t>` | clicks the field, types with uneven per-key timing and pauses |
| `press <keys>` | `Tab`, `Enter`, `Escape`, `ArrowDown`, `Control+A`, `Shift+Tab`... with modifiers held like fingers do |
| `scroll <dy> [--at <t>]` | moves over the area and scrolls in uneven wheel bursts |
| `goto <url>`, `shot <label> [--full]`, `zoom <t> <label>`, `state`, `stop` | navigate, look at the whole page, look closely at a detail, current URL and counts, close |

Paths follow the WindMouse model (gravity toward the target plus random wind) with Fitts's-law timing and an occasional overshoot and correction on long moves. Off-screen targets are brought into view with the wheel, as a person scrolls.

## 4. How to explore

Write the scenarios first, from the README, the notes and the screens you see: one per user task (sign up, search, add to cart, edit, delete, undo, settings, error recovery...). For each scenario, on desktop and on mobile:

- do the task the way a first-time user would find it, then the way a frequent user would (keyboard, shortcuts);
- try every control on the way: buttons, links, menus, forms, toggles, drag-and-drop, scroll areas, dialogs (open, use, close with Escape and by clicking outside);
- wrong and edge input: empty, too long, invalid, double submit, going back, reload;
- states: loading, empty, error, success, disabled, long content, many items;
- keyboard only: can the whole task be done with Tab, Enter, Space, Escape and arrows? Is the focus visible and in a sensible order?

## 5. Screenshots: look at every one

Every gesture saves a screenshot under `.whole-review/apptest/round-N/shots/` and prints its path. Read each one (the hook records it) and write a line for it in `ANALYSIS.md` under its scenario: what the screen shows and what is wrong. Use `zoom` for small text, alignment, borders and icons. Look for:

- function: the action did nothing, did the wrong thing, lost data, showed stale data;
- layout: overflow, clipping, overlap, cut text, misalignment, inconsistent spacing, elements off-screen (also on mobile);
- text: typos, wrong labels, untranslated strings, wrong units or numbers;
- visual: contrast, focus ring missing, hover/active states missing, broken images or icons;
- usability: unclear next step, no feedback after an action, hard-to-hit targets, surprising behaviour, too many steps.

## 6. Errors of every kind

Console errors and warnings, uncaught page errors, failed requests and HTTP responses of 400 or more are logged with ids (`E-1`, `E-2`, ...) and printed after the gesture that caused them. Each id gets a line in `ANALYSIS.md` with its cause or its finding.

## 7. From a defect on screen to its cause in code

Record each defect at once in `FINDINGS.md` as `suspected`, located `app:<screen>` while the cause is unknown, with `Evidence: <screenshot file>`. After the round: `phase verify`; for each, `work F-NNNN`, find the responsible code by reading (the notes' "used by" help), research the behaviour involved, move the heading to `path:line` and confirm it. Then `phase fix`, and a new `phase apptest` round that repeats the scenarios, the fixed ones first.

## 8. Closing a round

The round closes when: there was at least a click, keyboard use and scrolling; desktop and mobile were tested (or `set-app --desktop-only "<reason>"`); every screenshot was looked at and has its line in `ANALYSIS.md`; there is a real `## Scenario` section; every error id is triaged; Chrome is closed (`stop`). If the round found defects, go to `phase verify`; if not, and no code changed after the round started, `finish`.
