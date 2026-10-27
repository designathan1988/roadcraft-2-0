---
name: people-no-makehuman
description: No MakeHuman tooling or cook step in the game; people are ready files. A MakeHuman-based generator's output is fine if it is good (owner, 2026-10-25)
metadata:
  node_type: memory
  type: project
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T03:38:19.522Z
---

The user ordered every MakeHuman thing deleted from the game: bodies, hair, clothes, accessories, the lab and the cooker's sources. Nothing MakeHuman may load at run time and there is no "cook" step. The people are 16 ready files in `public/models/citizens/people/<role>.bin` + `.ktx2` (moved there from `cooked/people/mh_XX`, which was deleted on 2026-10-25). The mass deletion of `public/models/people`, `src/dev/people*`, `cooked/procedural` and the people scripts is intended; it is not a regression.

On 2026-10-25 the owner sharpened this. The point is the RESULT, not where the data came from. When I dismissed https://github.com/olatunde85/3d-gen (a generator built on the MakeHuman dataset) only because it is MakeHuman, the owner replied: "dane-se se é MakeHuman, se já gerar a pessoa pronta e otimizada". He also asked whether I had even looked at what it generates.

**Why:** the owner wants good-looking, ready, optimized, customizable people, GTA-style. The MakeHuman ban is about the tooling and cook step inside the game, not about the data source of finished assets.

**How to apply:**
- Never put the MakeHuman sources or a cook step back into the game.
- Judge a people source by generating it and comparing images at the game's drawn sizes, never by its origin.
- Never raise licence matters with the user ([[no-licence-concerns]]).
- The owner REJECTED all 16 old cooked people (2026-10-25): "NÃO QUERO ESSA MERDA E NEM GENTE FEIA E DEFEITUOSA, PODE TIRAR ESSA BOSTA FORA". Their defects were already in HEAD: a black bruise on male-adult-business's eye, smeared faces, broken far levels. They are being replaced by optimised 3d-gen "medium" people. Every new person's face must be checked close up for defects before it ships; "same as HEAD" is not a defence when HEAD itself is bad.
- Quality beats the triangle budget. The owner, 2026-10-25: "não importa se passar dos 3k, o que adianta 3k e ser uma bosta?" A good-looking person above 3,000 triangles is preferred to a bad one under it.
- Levels in the shipped files: L0 ≤ 3,000 and the previous L1 (1,153–2,504). The 300-triangle "shell" L2 was removed as a faceless blob.
