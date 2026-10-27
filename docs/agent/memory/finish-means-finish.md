---
name: finish-means-finish
description: "When the owner orders an item finished (\"manda finalizar\", \"para com isso\"), never send the agent back to polish it again"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T07:04:54.747Z
---

When the owner says an item is to be finished ("MANDA FINALIZAR", "PARA COM ISSO JÁ"), the item is closed: do not send the agent back for one more cosmetic pass, even a "small" one. Report the remaining flaw to the owner and let him decide.

**Why:** 2026-10-25 the owner had ordered the people agent to stop the mouth and finish; I sent it back to fix the teeth strip ends at 25° and the owner exploded ("O AGENTE DE PESSOAS ESTÁ NA BOCA AINDA. MANDE ESSE DESGRAÇADO PARAR").

**How to apply:** after a "finish" order, only defects that break the owner's own stated requirements reopen the item, and even then ask the owner first. Push the agent to the remaining deliverables. Related: [[vigia-must-see-images]], [[harsh-with-agents]].
