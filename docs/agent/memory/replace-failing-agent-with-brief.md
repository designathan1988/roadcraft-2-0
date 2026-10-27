---
name: replace-failing-agent-with-brief
description: "When an agent keeps failing, the coordinator studies the root causes and launches a NEW agent with a correct brief; the coordinator does not take over the work itself"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T04:11:59.469Z
---

On 2026-10-25 the PEOPLE agent kept shipping defective people and reporting a fraction of the defects. I stopped it and said I would do the conversion myself. The owner: "EU DISSE QUE VOCÊ NÃO VAI, VOCÊ VAI VER OS PROBLEMAS, ENTENDER, ESTUDAR E LANÇAR OUTRO AGENTE NOVO COM O PROMPT CORRETO, ORIENTAÇÃO CORRETA".

**Why:** the coordinator's job is to coordinate and police. An agent that "won't evolve" is replaced, but the replacement fails the same way unless the brief carries what went wrong and why.

**How to apply:**
- Retire an agent that does not improve after hard corrections. Don't keep pushing it, and don't do its work myself.
- Before relaunching, read its code and outputs and find the cause of each defect in its code (file:line), then check the target format and the sources.
- Write the new brief to a file in the scratchpad. It should cover: the goal, the game-side files to read, the sources, every defect with its cause, the method (reference renders of the unmodified source first, one item end to end then stop for approval), the self-check list for images, the report format and the rules.
- This is the exception to [[reuse-agents-few-parallel]]: resume the same agent for follow-ups, but replace it with a new one when it cannot evolve.
- Related: [[harsh-with-agents]], [[vigia-must-see-images]].
