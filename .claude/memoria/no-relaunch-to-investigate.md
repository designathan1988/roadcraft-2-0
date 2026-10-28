---
name: no-relaunch-to-investigate
description: "Do not reopen/reload the game over and over to find causes; once the causes are known, write the fixes from the code and open the game once per finished batch"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f48001e1-de85-47af-9b0b-8a635d5fcf4f
  modified: 2026-10-26T22:28:44.182Z
---



On 2026-10-26 the owner protested at my repeated reloads of the 10 km save (each ~3 min) to trace phases and queues: "Vai ficar insistindo em ficar subindo o jogo até que horas? Por que não corrige de uma vez por todas o código?"

**Why:** the causes were already known and written down (`reports/root-architecture-plan-2026-10-26.md`); every relaunch spent minutes without changing the code.

**How to apply:** find causes by reading the code; once a cause is named, implement the whole fix batch in code (tsc/eslint as you go), then open the game once for the confirming photo. No reload loops, no polling the pool to diagnose. Related: [[fix-in-code-test-in-app]], [[architecture-judged-by-code]], [[goal-10km-correct-code]].
