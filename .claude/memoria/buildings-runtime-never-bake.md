---
name: buildings-runtime-never-bake
description: The buildings are made at run time and edited by the player; never propose baking (HLOD atlas, impostor bake) for them; the far levels are the facade grammar per pixel (F-shade), already in the code
metadata:
  type: project-fact
---
The owner has said it many times: THE BUILDINGS ARE BUILT DYNAMICALLY IN THE GAME. Each building is a program made at run time
(`world/growth/zoning.ts` designOnLot, `src/render/buildings/program.ts`) and edited by the player. Every level is a filter over that program.
From afar only the mass stage is made (the whole map at the opening); the facades are made only where a cell is drawn near.

So NEVER propose or build a baked level for buildings (Unreal HLOD with a baked atlas, Simplygon proxies, impostor bakes). Baking needs
every building's facades for the whole map at the opening, a new bake on every edit, and an atlas of the whole map in GPU memory. That
breaks the opening of a 10 km city. It was rejected on 2026-10-27 (27bcdd1a) and proposed again by mistake on 2026-10-28 (withdrawn, 248680d0).

The right design is already in the code: the far levels (masses, tile, plate, base) are written in the facade level's own vertex format
and drawn by its own material (`massCells.ts` 256). That is F-shade: the facade grammar evaluated per pixel over the real masses (Haegler
et al., EGSR 2010, https://diglib.eg.org/items/c323b1b7-2ba8-4be3-8575-c0808924e2bf). A far-look problem is fixed inside that design.
Before proposing anything for buildings, read this and `program.ts`'s header.
