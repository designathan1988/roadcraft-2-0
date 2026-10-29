# Roadcraft: facts to know before touching the game

## Opening the original 10 km city (read before any test or measurement)
- The original 10 km city (~200k buildings) is the **large city of seed 7**, shipped ready in `cooked/large-7.*` (`COOKED_CITY_SEEDS`, `src/editor/cookedCities.ts`).
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
- The cause of "a different city, far heavier" was the seed above, not the code, the cache or the environment. Measured on the restored code (Electron private memory, all processes): random seed peaked at 10.1 GB at 31 s; **seed 7 loaded at ~5.9 GB after 40 s** (2.1 GB of it the GPU process kept from the previous city), no out-of-memory, GPU active (RTX 3060, ANGLE D3D11).
- The renderer out-of-memory crashes in `%APPDATA%/Roadcraft/problems/problems.log` (2026-10-28 20:54 to 22:32 local) all happened before the restores; the restored code had not been opened until this test.
- The large city does not read `%APPDATA%/Roadcraft/saves`. On 2026-10-29 `saves` was replaced by `saves-backup-2026-10-26-1958`; the save rewritten on 2026-10-28 is kept in `saves-2026-10-28-reescrito`.

## Where things are
- Game data (Electron userData): `%APPDATA%/Roadcraft` (`saves/`, `problems/problems.log`, `lab-reports/`, `desktop-settings.json`).
