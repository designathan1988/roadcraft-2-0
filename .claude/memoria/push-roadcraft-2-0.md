---
name: push-roadcraft-2-0
description: Every verified commit is pushed to github.com/designathan1988/roadcraft-2-0 (public; first push one orphan commit, no old history)
metadata:
  node_type: memory
  type: project
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T13:40:28.830Z
---

On 2026-10-24 the user asked to put all the work into main and push it to https://github.com/designathan1988/roadcraft-2-0.git. The repo was empty then. On 2026-10-25 the owner said "Faça agora o push e commit para https://github.com/designathan1988/roadcraft-2-0.git e commit sempre lá": from then on every commit goes there too. This replaces the "never push" of [[commit-local-always]] for that repo.

**Why:** the user wants one clean, verified game published there, kept up to date commit by commit.
**How to apply:**
- The repo is PUBLIC. The user chose "only the final state" (2026-10-24): the first push is one single commit of the finished, verified game with no old history (an orphan commit of the tree), which keeps the MakeHuman sources and the report dumps over 100 MB, which are in the local history, off GitHub. Later commits go on top of that one and are pushed as they are made.
- Push only verified work: type check, tests, build, and before/after images for visual changes.
- Never push the old local branches (main, otimizacao-geometria) there: their history is what must stay off GitHub.
- Done 2026-10-25: remote `roadcraft2`, local branch `publish` = 840e470c (orphan; the tree of local dce29be7 without `reports/`, 90.9 MB; reports/ has GLBs over 100 MB). To publish a later commit X: with the git-gate unlock, `T=$(git ls-tree X | grep -v $'	reports$' | git mktree)`, `C=$(git commit-tree "$T" -p publish -F msg)`, CHECK C is not empty (`set -e; test -n "$C"`), `git branch -f publish "$C"`, `git push roadcraft2 publish:main`. DO NOT use a temp index with `git rm --cached reports` (it refuses when the real index differs) and never run `git branch -f publish` with an empty value: it moved publish onto the local history (2026-10-25; the push was refused, nothing leaked). Do NOT check out `publish` in the working tree: it does not track reports/, so git would delete them from disk.
