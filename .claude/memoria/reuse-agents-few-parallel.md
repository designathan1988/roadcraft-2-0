---
name: reuse-agents-few-parallel
description: Resume the agent that already worked on a topic instead of spawning a new one; keep few research agents running at once
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T04:27:09.725Z
---

On 2026-10-25 I spawned 8 new agents for the library evaluations, two of them duplicating agents that had already installed and studied the same libraries. The owner: "POR QUE NÃO USOU OS QUE JÁ ESTAVAM PESQUISANDO ANTES SOBRE AS MESMAS BIBLIOTECAS? POR QUE ABRIU NOVOS?" and "NÃO QUERO QUE MANDE TANTOS AGENTES EM PARALELO".

**Why:** a new agent starts with no context, repeats the setup and wastes time and machine. The machine was already loaded, with timings varying 1.5-2x.

**How to apply:**
- For follow-up work on a topic, resume the agent that did it, with SendMessage to its id, even after it finished.
- Spawn a new agent only for a genuinely new topic with no prior agent.
- Keep research agents to about 2 at a time, and queue the rest until those finish.
- Count the running agents before spawning, and tell the owner the count when asked.
- 2026-10-25, after the new PEOPLE and VEHICLES agents were launched, the owner said: "LANÇA O ULTIMO E CHEGA DE LANÇAR AGENTES AGORA. CHEGA". Launch no more agents until he says otherwise. Work with the running ones, using SendMessage, TaskStop and resume.
