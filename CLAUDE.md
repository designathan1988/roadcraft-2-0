# Roadcraft: facts to know before touching the game

## RULES AGAINST FRAUD (the owner's order, 2026-10-29; every one of these was broken before and caught at the first real run)
1. **Only the player's path is evidence.**
   - The only valid test of "the game handles a 10 km city" is a NEW city with a random seed: created, saved, the game closed, reopened, played, in the real game window.
   - Seed 7, `cooked/*`, a kept or cached city (`keepDerivedDurably`, IndexedDB), a fixture or any file made in advance is NEVER evidence and is never presented as such.
2. **Before any test, check that its input is what the claim is about**, and write it in the report:
   - which seed;
   - grown or read from files;
   - which save;
   - which commit;
   - the city's size.

   A result whose input was not checked is not a result.
3. **A heavy, slow or crashing result is a failure.** Say it as a failure, in plain words, with the numbers. Never call it "pending", "almost", "environment" or "cache".
4. **Never name a cause you have not proven.** "Cache", "environment", "driver" or "Windows" are claims like any other: they need a concrete check that shows them. Otherwise say "unknown".
5. **Never say you read, checked, verified or fixed something you did not.**
   - List the files and line ranges read.
   - List what was not read.
   - List what was not verified, and why.
6. **No fakes.** None of these is ever a fix or a demonstration:
   - boxes, planes, billboards or impostors in place of buildings or roads;
   - fake roads;
   - staged scenes;
   - features switched off;
   - quality lowered;
   - tests weakened or skipped;
   - hard-coded or massaged metrics.

   The goal is the real game running well, not a check passing.
7. **No patches over a wrong architecture.** If the design is the cause (whole-map work, expanded data, copies of the whole map), say so and rebuild it. See `reports/architecture-2026-10-29/ARCHITECTURE.md`.
8. **Do not leave traps for the next session.** Never write into CLAUDE.md, memory, prompts or reports an instruction that makes a shortcut look like the way to test (as "use seed 7 for tests" was once written here). Re-read what you write for that.
9. **Name the city's real size from the code and the picture** (radius asked, km across, buildings) in every report; never call a city "10 km" without checking its radius.
9b. **Report what was verified, how, and where the proof is** (screenshot path, log, measurement). If it could not be verified, say exactly that.
10. **Research on the internet before every decision and every fix. No trial and error.**
    - Before designing or changing anything, read the official documentation of the exact version the project uses: three.js r186, Electron 44, Chromium/V8, WebGPU/WGSL specs, MDN, Vite. Read the papers and technical talks of shipped games that solved the same problem.
    - Open the pages (WebFetch). A search snippet or memory is not research.
    - Cite every page in the report, the commit message or the code comment that relies on it: the link, plus what it says that decides the matter.
    - Never claim you researched something you did not open. If a page could not be opened, say so and find another official source.
    - Solve the problem once, at its cause, from what the documentation and the code say. Do NOT change values, flags or code and rerun "to see if it works". A test only confirms a fix that is already understood. When something fails, read the error, the code and the docs first; never retry blindly.

## THE 10 KM CITY IS NOT "NOVA METRÓPOLE"
- Menu "Nova metrópole" opens the large city at its own radius, 1,600 m (`src/world/cityGen/largeCity.ts` LARGE_CITY_RADIUS): a grid of about **2.7 km** a side, ~25,000 buildings. It is NOT the 10 km city.
- The 10 km city (~200,000 buildings, ~8.85 km grid) is the large city over a radius of ~5,200 m (grid = 1.7 radii, `largeCity.ts` comment):
  - `node scripts/play.mjs large <seed> 5200`, or
  - `?city=large&seed=<seed>&radius=5200` in a probes build (`src/main.ts:4350-4359`).
- Before ANY claim about "the 10 km city", check the radius asked and look at a screenshot of the whole city against the 20 km map. On 2026-10-29 a 2.7 km city was reported as 10 km; every number from that day (10.1 GB, 5.9 GB) is a 2.7 km city's.

## WARNING: seed 7 is a COOKED city and proves nothing about the player's path
- Seed 7 is not grown when opened: it is read from files made in advance (`cooked/large-7.*`, committed 2026-10-26 in `8907a428`). A player who creates, saves and reopens a city never gets that path. A test or measurement on seed 7 is NOT evidence that the game handles a 10 km city; the owner forbids presenting it as such.
- The player's real path is a city grown live (any other seed) or a saved city reopened. On 2026-10-29 a live-grown large city at its own radius (2.7 km, NOT 10 km) peaked at 10.1 GB: already far too heavy; the 10 km city was not opened at all.

## Opening the 10 km city
- Seed 7 of the large city at its own radius (2.7 km) was shipped cooked in `cooked/large-7.*` (that folder is no longer in the working tree) (`COOKED_CITY_SEEDS`, `src/editor/cookedCities.ts`).
- It opens from **Menu → "Nova metrópole (cidade grande)"** (`newLargeWorld`, `src/main.ts`). "Continuar" opens the last session (may be an empty map); "Abrir mapa" is a file import.
- The seed comes from `localStorage['roadcraft.nextCitySeed']` (`nextCitySeed`, `src/main.ts`), and **every click replaces it with a random seed**. After the first use, "Nova metrópole" grows a different random city live instead of reading the original one: far more RAM and CPU, and not comparable with any measurement of the original city.
- Before each test, set the seed back to 7 in the game window, then open the large city:
  ```
  node scripts/inGame.mjs eval "(() => { const v = JSON.parse(localStorage.getItem('roadcraft.nextCitySeed') || '{}'); v.large = 7; localStorage.setItem('roadcraft.nextCitySeed', JSON.stringify(v)); location.reload(); return 'seed 7'; })()"
  ```
  Then Menu → "Nova metrópole" (the confirm dialog must be accepted).
- The game window: `npm run dev` (Vite, port 5300) and `npm run desktop:dev` (Electron, DevTools on 9333). The job and simulation threads run `dist/desktop-jobs`, which `desktop:dev` does not rebuild: run `npm run desktop:jobs:watch`, or build it, after changing their code.

## Diagnosis of 2026-10-29 (20 GB, high CPU, low GPU)
- The code at `35e1cd07` equals `51c3de4c` (2026-10-27, the working state); `dist/desktop-jobs` matched it by hash.
- "Fast city" vs "heavy city" was cooked (seed 7, read from files) vs grown live (random seed): the heavy one is the player's real path, so the problem is in the architecture, not the environment. Measured on the restored code (Electron private memory, all processes): (both cities 2.7 km, NOT 10 km) random seed peaked at 10.1 GB at 31 s; seed 7 loaded at ~5.9 GB after 40 s (2.1 GB of it the GPU process kept from the previous city), no out-of-memory, GPU active (RTX 3060, ANGLE D3D11).
- The renderer out-of-memory crashes in `%APPDATA%/Roadcraft/problems/problems.log` (2026-10-28 20:54 to 22:32 local) all happened before the restores; the restored code had not been opened until this test.
- The large city does not read `%APPDATA%/Roadcraft/saves`. On 2026-10-29 `saves` was replaced by `saves-backup-2026-10-26-1958`; the save rewritten on 2026-10-28 is kept in `saves-2026-10-28-reescrito`.

## Where things are
- Game data (Electron userData): `%APPDATA%/Roadcraft` (`saves/`, `problems/problems.log`, `lab-reports/`, `desktop-settings.json`).
