/goal Cumprir docs/agent/MISSION.md inteira, lida por inteiro (o hook só imprime o começo): os itens 1 a 9, com todos os subitens, na ordem, a partir do primeiro não feito em docs/agent/work.md (1a feito: d3a2d41e), e depois o Fim.

## Condição de cumprimento

A condição está cumprida só quando todas estas coisas aparecem no chat:

1. Para cada item e subitem, uma destas duas:
   - o hash do commit publicado no roadcraft-2-0, junto com a saída do `npm run typecheck` sem erros e do spec daquele ponto passando;
   - a prova, no código, de que já estava corrigido ou de que não pode ser feito como está escrito (arquivo:linha e o motivo), e por que nenhuma outra forma correta resolve.
2. Nenhum item pulado e nenhum dado como feito sem essa prova.
3. Depois do item 9, uma única abertura do jogo, com fotos deste código e do 7c4de70f nas mesmas vistas:
   - centro de perto;
   - centro de longe;
   - rua de um bairro;
   - durante e depois de arrastar a câmera;
   - à noite.

   Cada foto aparece com o caminho do arquivo e a análise. As diferenças indevidas foram corrigidas e fotografadas de novo.
4. O `git status` final sem nada pendente em `src/` e `tests/`, e o último commit publicado.

## Durante todo o goal

- Antes do primeiro item: `"deny": ["Agent"]` no `.claude/settings.json` e um hook `Stop` com `npm run typecheck 1>&2 || exit 2`, commitados.
- Não perguntar nada. Não terminar o turno com um resumo que anuncia o próximo passo: fazer o próximo passo.
- Sem subagentes.
- Sem medir, sem benchmark, sem sondas; achar as causas lendo o código, começando cada item por reachar no código atual cada causa listada.
- O jogo abre só no Fim, acima da regra de foto após cada mudança visual do `CLAUDE.md` de `city`.
- Não enfraquecer testes; teste errado ou item inviável se diz com a prova.
- Nada falso e nenhuma compensação de cor em shader.
- Nunca assar prédios.
- Nenhuma mudança visível, a não ser as que a missão manda; nível simplificado só aceito pelo erro em pixels e pela silhueta.
- Não refazer o que foi revertido, os passos 2, 3, 4 e 6 da solução antiga, nem as rodadas de modelos rejeitadas.
- Tudo no projeto em inglês; no chat, português.
