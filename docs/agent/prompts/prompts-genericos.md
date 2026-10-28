# Prompts genéricos

Dez prompts, um por seção. Copie de "# Prompt N" até a linha --- seguinte.

As regras que não podem ter exceção (sem subagentes, não mexer no código numa tarefa só de leitura, type check sem erro, ir até o fim da lista) estão como configuração que o Claude Code aplica sozinho: regras `deny` e hooks. Texto no prompt o modelo pode deixar de seguir; configuração, não (https://code.claude.com/docs/en/best-practices#enforce-the-rules-that-cant-have-exceptions).

---

# Prompt 1: Criar uma memória que resista à compactação

Crie neste projeto um mecanismo de memória que sobreviva à compactação manual e à autocompactação, e faça-o funcionar de verdade antes de dizer que está pronto.

## Por que

O que se perde numa compactação é tudo o que não volta do disco. Volta só:
- o CLAUDE.md da raiz;
- as regras sem escopo;
- as skills invocadas;
- a saída dos hooks SessionStart (https://code.claude.com/docs/en/context-window#what-survives-compaction).

Então a memória tem de estar em arquivos do projeto e ser reimpressa por hooks.

## Faça, nesta ordem

1. Leia a documentação oficial de hooks (https://code.claude.com/docs/en/hooks) e de compactação antes de escrever qualquer coisa. Confirme o limite de caracteres que um hook pode devolver inteiro e respeite-o.
2. Crie uma pasta de memória dentro do projeto (nunca na pasta do usuário), versionada no git, com:
   - um arquivo de ordens do dono: cada prompt que ele digita, gravado palavra por palavra com data e hora, por um hook UserPromptSubmit. Filtre o que não é o dono: avisos do app, notificações de tarefa, retorno de hooks, mensagens de comando;
   - um arquivo de estado curto: o que está em andamento, o que está quebrado, o que não foi verificado, o próximo passo. Ele é reescrito a cada mudança de tarefa e fica sempre abaixo do limite do hook;
   - um caderno da tarefa atual: o que foi lido, o que foi achado (arquivo:linha), o que foi feito, o commit e o próximo passo;
   - um índice das regras e lições permanentes, um arquivo por fato.
3. Crie hooks SessionStart para startup, resume, clear e compact que imprimam, nesta ordem:
   - as ordens mais recentes do dono, palavra por palavra, das mais novas para as mais antigas;
   - o estado;
   - o caderno da tarefa;
   - onde o trabalho parou, lido do arquivo da conversa no disco (as últimas ferramentas e os últimos arquivos lidos), sem depender do resumo.
4. No CLAUDE.md da raiz, ponha um ponteiro para essa pasta e uma seção de instruções de compactação dizendo o que o resumo tem de manter palavra por palavra: as ordens do dono, a missão e a condição de parada, o que está quebrado e o que não está commitado. Mantenha o CLAUDE.md curto (menos de 200 linhas) e sem regras que se contradigam (https://code.claude.com/docs/en/memory#write-effective-instructions).
5. Teste cada hook rodando-o com uma entrada de exemplo, do mesmo jeito que o Claude Code o chama (o comando do settings, com o JSON na entrada):
   - confira a saída e o tamanho de cada um;
   - confira que o arquivo de ordens grava um prompt do dono e não grava os avisos do app.
6. Commite.
7. A compactação real só eu posso fazer, porque `/compact` é um comando que só o usuário digita. Termine pedindo que eu digite `/compact`. Depois que eu digitar, mostre que as ordens, o estado, o caderno e o ponto onde o trabalho parou voltaram ao contexto, e corrija o que não voltou.

## Regras

- Faça você mesmo, sem subagentes.
- Decida sozinho o que for de rotina.
- Não diga que funciona sem os testes dos passos 5 e 7.
- No fim, diga o que foi feito, o que foi testado e o que não foi.

---

# Prompt 2: Ler toda a documentação do projeto

Leia toda a documentação deste projeto, inteira, e grave o que for achando enquanto lê.

## O que é "toda"

Cada documento escrito que existe no projeto, em qualquer pasta: relatórios, notas, histórico, memórias, planos, READMEs, CLAUDE.md, relatórios de medição e de auditoria.

- Arquivo grande se lê em blocos sequenciais (Read com offset e limit) até a última linha.
- Busca por trechos não substitui a leitura. Um documento lido em parte não conta como lido.

## Antes de começar: as regras que o programa garante

1. Se a sessão tiver um mecanismo de memória que resista à compactação, use-o. Se não tiver, crie um, com um hook SessionStart que reimprima o caderno da tarefa depois de cada compactação.
2. Faça o inventário: liste cada documento com o número de linhas num arquivo de lista dentro do projeto, cada um com [ ] na frente.
3. Em `.claude/settings.json` (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks):
   - `"permissions": { "deny": ["Agent", "Edit(/src/**)", "Edit(/tests/**)"] }`, com as pastas de código e de testes deste projeto no lugar de src e tests. O nome da ferramenta sozinho bloqueia todo uso dela; aqui, todo subagente;
   - um hook `Stop` que sai com código 2 enquanto a lista tiver um [ ], com a mensagem do que falta na saída de erro. Por exemplo: `node -e "if(require('fs').readFileSync('LISTA','utf8').includes('[ ]')){console.error('Ainda há documentos sem [x] em LISTA');process.exit(2)}"`.

   O Claude Code pega as mudanças de hooks no settings pelo vigia de arquivos.

## Faça, nesta ordem

1. Leia o primeiro documento sem [x], inteiro, até a última linha.
2. Logo depois de terminá-lo, acrescente a um arquivo de achados cada problema, decisão, solução e fato que ele traz:
   - o que é;
   - onde (arquivo:linha ou a vista);
   - o estado (corrigido com o commit, aberto, ou decidido não mudar e por quê);
   - a solução decidida.

   Marque o documento com [x] e atualize no caderno quantos de quantos já foram lidos.
3. Commite a lista e os achados a cada poucos documentos, para nada se perder numa compactação.
4. Repita até não sobrar nenhum [ ].
5. Tire do settings as regras e o hook desta tarefa, para não prenderem as próximas sessões, e commite.
6. No fim, releia inteiro o arquivo de achados e informe:
   - o que foi lido (cada arquivo e o número de linhas) e o total;
   - o que não foi lido e por quê. Só vale como "não lido" um arquivo que não é texto, e você diz qual é.

## Regras

- Faça você mesmo.
- Decida sozinho o que for de rotina.
- Não mude código nem documentação além da lista, dos achados, do caderno e do settings desta tarefa.
- Nunca diga que leu o que não leu.

---

# Prompt 3: Ler todo o código e achar todos os erros

Leia todo o código deste projeto, integralmente, e ache todos os erros pelo código, registrando enquanto lê.

## O que é "todo"

Cada arquivo de código-fonte do projeto: aplicação, workers, shaders, scripts, configuração e testes. Ficam de fora só as dependências instaladas e o que é gerado pelo build.

- Arquivo grande se lê em blocos sequenciais (Read com offset e limit) até a última linha.
- Busca por trechos não substitui a leitura. Um arquivo lido em parte não conta como lido.

## Método

- Ache cada erro lendo: siga as chamadas, os imports, os tipos e os dados entre arquivos até a origem; ligue cada trecho com problema a tudo que ele afeta e de que depende.
- Não rode o programa, não meça, não use benchmark nem suíte de testes para achar erro. Checagens estáticas rápidas (o type check e o lint do projeto) podem servir de pista, e você diz quando um achado veio delas.
- Erro aqui é tudo que está errado no código:
  - bug de lógica, caso não tratado, condição de corrida, erro engolido;
  - recurso que vaza ou nunca é liberado;
  - trabalho repetido sem necessidade: refeito, reenviado, recalculado ou criado a cada quadro, a cada chamada ou a cada evento sem mudança;
  - trabalho proporcional ao todo onde bastava o que mudou;
  - uso errado de API (confira na documentação oficial da versão instalada e cite o link);
  - código morto, contadores e comentários que mentem.

## Antes de começar: as regras que o programa garante

1. Se a sessão tiver um mecanismo de memória que resista à compactação, use-o. Se não tiver, crie um, com um hook SessionStart que reimprima o caderno da tarefa depois de cada compactação.
2. Faça o inventário: liste cada arquivo de código com o número de linhas num arquivo de lista dentro do projeto, cada um com [ ] na frente.
3. Em `.claude/settings.json` (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks):
   - `"permissions": { "deny": ["Agent", "Edit(/src/**)", "Edit(/tests/**)"] }`, com as pastas de código e de testes deste projeto no lugar de src e tests: sem subagentes e sem mudar código nesta tarefa;
   - um hook `Stop` que sai com código 2 enquanto a lista tiver um [ ], com a mensagem do que falta na saída de erro. Por exemplo: `node -e "if(require('fs').readFileSync('LISTA','utf8').includes('[ ]')){console.error('Ainda há arquivos sem [x] em LISTA');process.exit(2)}"`.

## Faça, nesta ordem

1. Leia o primeiro arquivo sem [x], inteiro.
2. Logo depois, registre num arquivo de achados cada erro:
   - arquivo:linha;
   - o que está errado;
   - por que (o caminho no código que prova);
   - o que ele afeta;
   - a gravidade;
   - a correção certa.

   Registre também o que você precisa conferir em outro arquivo, e confira quando chegar lá. Marque o arquivo com [x] e atualize no caderno quantos de quantos já foram lidos.
3. Commite a lista e os achados a cada poucos arquivos.
4. Repita até não sobrar nenhum [ ].
5. Tire do settings as regras e o hook desta tarefa e commite.
6. No fim, releia inteiro o arquivo de achados, junte o que é a mesma causa e descarte, com a prova, o que a leitura de outros arquivos mostrou não se sustentar. Informe:
   - os arquivos lidos e o número de linhas (X de Y arquivos);
   - os erros por gravidade;
   - o que ficou sem ler e por quê.

## Regras

- Faça você mesmo.
- Decida sozinho o que for de rotina.
- Não corrija nada; só leia e registre.
- Nunca diga que leu o que não leu, nem afirme um erro sem o caminho no código que o prova.

---

# Prompt 4: Auditoria completa do projeto

Faça a auditoria completa deste projeto: identifique todos os problemas que ele tem, analisando tudo integralmente e pelo código, e entregue no fim um relatório com tudo.

## O que é "tudo"

Cada arquivo do projeto que seja texto:
- o código-fonte (aplicação, workers, shaders, scripts, testes);
- a configuração (build, lint, type check, dependências, CI, hooks);
- a documentação (READMEs, notas, relatórios, planos, histórico, CLAUDE.md).

Ficam de fora só as dependências instaladas e o que é gerado pelo build.

- Arquivo grande se lê em blocos sequenciais (Read com offset e limit) até a última linha.
- Busca por trechos não substitui a leitura. Um arquivo lido em parte não conta como lido.

## Método

- Ache cada problema lendo: siga as chamadas, os imports, os tipos, os dados e a configuração entre arquivos até a origem; ligue cada problema a tudo que ele afeta e de que depende.
- Não rode a aplicação, não meça, não use benchmark nem suíte de testes para achar problema. O type check e o lint do projeto podem servir de pista, e você diz quando um achado veio deles.
- Confira na documentação oficial da versão instalada cada uso de biblioteca ou API que você apontar como errado, e cite o link.
- Problema é tudo que está errado ou pior do que deveria:
  - bugs e casos não tratados; condições de corrida; erros engolidos;
  - recursos que vazam; trabalho repetido sem necessidade ou proporcional ao todo onde bastava o que mudou;
  - desempenho e memória;
  - segurança: entradas não validadas, segredos no código, dependências vulneráveis;
  - arquitetura: acoplamento, ciclos de import, responsabilidades misturadas, duplicação;
  - testes que não testam o que dizem, faltam ou foram enfraquecidos; configuração inconsistente;
  - código morto; documentação que contradiz o código; instruções do CLAUDE.md que se contradizem; TODOs e promessas não cumpridas nos documentos.

## Antes de começar: as regras que o programa garante

1. Se a sessão tiver um mecanismo de memória que resista à compactação, use-o. Se não tiver, crie um, com um hook SessionStart que reimprima o caderno da tarefa depois de cada compactação.
2. Faça o inventário: liste cada arquivo com o número de linhas num arquivo de lista dentro do projeto, cada um com [ ] na frente, a documentação primeiro e o código depois.
3. Em `.claude/settings.json` (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks):
   - `"permissions": { "deny": ["Agent", "Edit(/src/**)", "Edit(/tests/**)"] }`, com as pastas de código e de testes deste projeto no lugar de src e tests: sem subagentes e sem mudar código nesta tarefa;
   - um hook `Stop` que sai com código 2 enquanto a lista tiver um [ ], com a mensagem do que falta na saída de erro. Por exemplo: `node -e "if(require('fs').readFileSync('LISTA','utf8').includes('[ ]')){console.error('Ainda há arquivos sem [x] em LISTA');process.exit(2)}"`.

## Faça, nesta ordem

1. Leia o primeiro arquivo sem [x], inteiro. Logo depois, registre num arquivo de achados cada problema:
   - arquivo:linha;
   - o que está errado e por quê (o caminho no código ou o trecho do documento que prova);
   - o que afeta; a categoria e a gravidade;
   - a correção certa.

   Registre também o que precisa conferir em outro arquivo, e confira quando chegar lá. Marque o arquivo com [x] e atualize no caderno quantos de quantos já foram lidos.
2. Commite a lista e os achados a cada poucos arquivos. Repita o passo 1 até não sobrar nenhum [ ].
3. Releia inteiro o arquivo de achados. Junte os achados que são a mesma causa e descarte, com a prova, o que a leitura de outros arquivos mostrou não se sustentar.
4. Escreva o relatório final num arquivo do projeto. Ele traz:
   - a cobertura: arquivos lidos e linhas, X de Y, e o que ficou sem ler e por quê (só vale arquivo que não é texto);
   - todos os problemas, por gravidade e por categoria, cada um com arquivo:linha, a prova, o efeito e a correção;
   - as causas comuns por trás de vários problemas;
   - a ordem recomendada para corrigir;
   - o que não pôde ser confirmado só pelo código, dito claramente.
5. Tire do settings as regras e o hook desta tarefa e commite com o relatório.

## Regras

- Faça você mesmo.
- Decida sozinho o que for de rotina.
- Não corrija nada; só leia, registre e relate.
- Nunca diga que leu o que não leu, nem afirme um problema sem a prova.

---

# Prompt 5: Testar a aplicação como um usuário humano, com Playwright

Teste esta aplicação de ponta a ponta como um usuário humano, no Chrome controlado pelo Playwright MCP, ache todos os problemas de funcionalidade e de interface, e corrija cada um.

"De ponta a ponta" quer dizer cada item do mapa do passo 2, sem exceção; o teste só termina quando todos estiverem com [x].

## Gestos de verdade, como uma pessoa

Use as ferramentas de mouse e de teclado do Playwright MCP (https://github.com/microsoft/playwright-mcp). As de coordenadas precisam do servidor ligado com `--caps=vision`. Se elas não aparecerem na sessão, pare e me diga para ligá-lo assim; não troque por outro jeito.

- Mova o mouse com `browser_mouse_move_xy` em vários passos, em trajetórias irregulares e com velocidade variável: com tremor, curvas, desvios, ultrapassando o alvo e voltando.
- Clique com `browser_mouse_down` e `browser_mouse_up` no ponto onde o mouse chegou, ou `browser_mouse_click_xy` (simples, duplo com `clickCount`, botão direito com `button`).
- Pouse o mouse sobre as coisas e espere, para ver dicas, hover e menus.
- Arraste com `browser_mouse_down`, vários `browser_mouse_move_xy` e `browser_mouse_up`, devagar e rápido. Solte fora do alvo e no meio do caminho.
- Role com `browser_mouse_wheel`. Use as teclas e os atalhos com `browser_press_key`, e digite com `browser_type` com `slowly`, com erros corrigidos com Backspace.
- Faça o que um usuário faria sem querer: clicar duas vezes, mudar de ideia no meio de um gesto, apertar Esc, redimensionar a janela (`browser_resize`).
- Nada de `browser_evaluate` nem `browser_run_code_unsafe`, de chamar funções da página ou de mexer no DOM ou no estado direto.

## Antes de começar: as regras que o programa garante

1. Se a sessão tiver um mecanismo de memória que resista à compactação, use-o. Se não tiver, crie um, com um hook SessionStart que reimprima o caderno da tarefa depois de cada compactação.
2. Leia o código da interface para montar o mapa completo da aplicação, num arquivo de lista dentro do projeto, cada item com [ ]:
   - telas, menus, botões, ferramentas, painéis, atalhos, diálogos;
   - estados (vazio, carregando, cheio, erro) e fluxos completos, do começo ao fim;
   - casos de borda: valores extremos, entradas inválidas, ações repetidas, desfazer e refazer, salvar e reabrir, janela pequena e tamanho de celular, se a aplicação puder ser usada no celular.
3. Em `.claude/settings.json` (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks):
   - `"permissions": { "deny": ["Agent"] }`: sem subagentes;
   - um hook `Stop` que sai com código 2 enquanto o type check do projeto falhar ou a lista tiver um [ ], com o motivo na saída de erro. Por exemplo, num projeto TypeScript: `npx tsc --noEmit 1>&2 || exit 2`, mais o teste da lista.

## Faça, nesta ordem

1. Abra a aplicação com o Playwright MCP, numa janela de pelo menos 1920x1080.
2. Para cada item sem [x]:
   - execute-o com gestos humanos;
   - tire uma captura (`browser_take_screenshot`, PNG) depois de cada passo que muda a tela, e amplie a região quando o detalhe importa;
   - abra e analise cada captura de verdade;
   - leia o console (`browser_console_messages`) e os erros de rede (`browser_network_requests`).
3. Registre num arquivo de achados cada problema:
   - o que aconteceu e o que devia acontecer;
   - os passos para repetir;
   - a captura (caminho do arquivo);
   - a categoria (funcionalidade, interface, usabilidade, texto, acessibilidade, desempenho, console) e a gravidade.
4. Corrija cada problema na causa, lendo o código até a origem. Não remende a superfície e não esconda o sintoma.
   - Depois de corrigir, repita o mesmo fluxo com gestos humanos e tire a captura nova.
   - Só marque o item com [x] quando a captura nova mostrar que está certo.
   - Commite cada correção verificada.
5. Quando não sobrar nenhum [ ], passe de novo pelos fluxos que as correções tocaram, para achar o que elas quebraram.
6. Tire do settings as regras e o hook desta tarefa e commite.
7. No fim, informe:
   - o que foi testado (X de Y itens do mapa);
   - o que foi achado, com as capturas;
   - o que foi corrigido, com as capturas de antes e depois e o commit de cada um;
   - o que não foi corrigido e por quê, com a prova no código;
   - o que não pôde ser testado e por quê.

## Regras

- Faça você mesmo.
- Decida sozinho o que for de rotina.
- Não pare no primeiro problema.
- Nunca diga que algo funciona sem a captura que mostra isso.

---

# Prompt 6: Criar uma aplicação com uma única fonte da verdade

Crie a aplicação descrita abaixo, do jeito correto: uma única fonte da verdade para cada coisa, arquitetura que não quebra quando algo muda, código em inglês e tecnologias escolhidas com pesquisa.

## A aplicação (preenchido pelo dono)

- Nome: [[NOME DA APLICAÇÃO]]
- O que ela é e para que serve, em poucas frases: [[OBJETIVO]]
- Quem usa e em que situação: [[USUÁRIOS E CONTEXTO DE USO]]
- Onde roda (web, desktop, celular, servidor, várias): [[PLATAFORMAS]]
- Idiomas da interface: [[IDIOMAS]]

## Funcionalidades (preenchido pelo dono)

Uma por linha, com o que o usuário faz e o que deve acontecer.

1. [[FUNCIONALIDADE 1: o que o usuário faz -> o que a aplicação faz -> o que ele vê]]
2. [[FUNCIONALIDADE 2]]
3. [[FUNCIONALIDADE 3]]
4. [[MAIS FUNCIONALIDADES, quantas forem]]

## Dados e regras (preenchido pelo dono)

- Os dados que a aplicação guarda e como se relacionam: [[DADOS]]
- As regras de negócio que nunca podem ser violadas: [[REGRAS / INVARIANTES]]
- Onde os dados ficam (local, servidor, nuvem, offline primeiro): [[PERSISTÊNCIA]]
- Integrações com outros sistemas ou APIs: [[INTEGRAÇÕES]] (opcional)
- Contas, login, permissões: [[USUÁRIOS E PERMISSÕES]] (opcional)

## Sugestões e restrições (preenchido pelo dono)

- Tecnologias que sugiro ou prefiro: [[SUGESTÕES DE TECNOLOGIA]] (opcional)
- Tecnologias que não quero: [[TECNOLOGIAS PROIBIDAS]] (opcional)
- Limites de desempenho, tamanho, custo ou hardware: [[RESTRIÇÕES]] (opcional)
- Aparência e estilo da interface: [[ESTILO VISUAL]] (opcional)
- Outras sugestões: [[SUGESTÕES LIVRES]] (opcional)

## Etapa 1: especificação, antes de qualquer código

1. Leia o que preenchi e me entreviste só sobre as lacunas que mudariam o trabalho: o que acontece nos casos de borda, o que fica de fora, o que eu quis dizer onde duas leituras levam a aplicações diferentes. Pergunte tudo de uma vez, com opções.
2. Pesquise na documentação oficial e em fontes técnicas atuais as tecnologias certas para esta aplicação e estas plataformas: linguagem, framework, gerenciamento de estado, persistência, testes e build.
   - Use as minhas sugestões quando forem boas. Quando não forem, diga por quê e proponha a alternativa.
   - Confira as versões atuais e cite os links.
3. Escreva no projeto docs/SPEC.md e docs/ARCHITECTURE.md.
   - A especificação traz cada funcionalidade como critérios de aceitação verificáveis, os dados, as invariantes e o que fica de fora.
   - A arquitetura traz as tecnologias, as versões, o porquê de cada escolha e os comandos de type check, lint, teste e build.
4. Pare e me mostre os dois. Só comece a etapa 2 depois que eu aprovar.

## Etapa 2: construção

De preferência numa sessão nova, que começa lendo docs/SPEC.md e docs/ARCHITECTURE.md (https://code.claude.com/docs/en/best-practices#brainstorm-with-claude-first).

### Antes do primeiro código: as regras que o programa garante

Em `.claude/settings.json` (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks):
- `"permissions": { "deny": ["Agent"] }`: sem subagentes;
- um hook `Stop` que sai com código 2 enquanto o type check falhar, com a saída do compilador na saída de erro. Por exemplo, num projeto TypeScript: `npx tsc --noEmit 1>&2 || exit 2`.

Esses dois ficam no projeto depois da construção, porque valem para todo trabalho nele.

### A arquitetura

A complexidade certa é a mínima que a especificação pede: nada de camada, abstração, configuração ou flexibilidade para um requisito que não está nela (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#overeagerness). Dentro disso, o que não muda com o tamanho da aplicação:

- **Uma única fonte da verdade.** Todo estado da aplicação vive num único lugar, com um schema tipado. Nenhum componente guarda cópia de estado que pertence a ele. O que pode ser calculado a partir do estado é derivado e nunca guardado em dobro. Cada constante, configuração e tipo de dado é definido uma vez só, e todo o resto o importa.
- **Um único controlador de estado.** O estado só muda por ações tipadas, tratadas por funções puras (estado anterior + ação -> estado novo). O fluxo é de mão única: interface -> ação -> estado -> interface. Nada escreve no estado por fora desse caminho. Componentes só leem por seletores e só mudam o estado despachando ações.
- **Efeitos isolados.** Rede, disco, timers e APIs ficam numa camada própria, que recebe ações e emite ações. Nunca dentro dos componentes nem das funções puras.
- **Contratos.** Tipos estritos (sem any), validação de toda entrada externa na fronteira, erros tratados e mostrados ao usuário, nunca engolidos.
- **Persistência**, se a aplicação salva dados: formato versionado, com migração testada de cada versão para a seguinte. Um arquivo antigo sempre abre.
- **Desfazer e refazer**, se a especificação pede: pelas ações, não por cópias soltas do estado.
- **Desempenho:** trabalho proporcional ao que mudou, nunca ao todo; nada recalculado, recriado ou reenviado sem mudança.
- **Textos da interface** num único catálogo de idiomas.
- Barramento de eventos, camadas separadas de domínio e de infraestrutura e regras de lint que bloqueiam import entre camadas entram quando o tamanho da aplicação pedir. Registre a decisão no docs/ARCHITECTURE.md.

### Testes

- Das funções puras e dos tratadores de ações.
- Das fronteiras (validação das entradas externas).
- De migração, se houver formato salvo.
- De ponta a ponta para cada critério de aceitação da especificação.
- Um teste novo tem de falhar quando a correção é desfeita. Nunca enfraqueça, apague ou fixe valores de teste para passar. Se um teste estiver errado ou um critério for inviável, me avise em vez de contornar.

### Como construir

- Funcionalidade por funcionalidade, na ordem da especificação. Cada uma está pronta quando seus critérios de aceitação passam nos testes e, se for visual, quando você abriu a aplicação, fez a captura de tela e analisou.
- Cada mudança pequena, verificada e commitada sozinha, com mensagem em inglês.

## Regras

- Tudo no projeto em inglês: código, nomes, comentários, mensagens de log e de erro, commits, documentação. Fale comigo em português.
- Implemente a lógica real, que funcione para todos os casos válidos. Nada falso, nada fixo só para parecer pronto.
- Faça você mesmo. Depois da aprovação da etapa 1, decida sozinho o que for de rotina e registre as decisões no docs/ARCHITECTURE.md.
- No fim, informe:
  - o que foi feito (funcionalidade por funcionalidade, com os commits);
  - o que não foi e por quê;
  - o que não foi verificado;
  - como rodar, testar e fazer o build.

---

# Prompt 7: Analisar a interface atual e criar uma nova

Analise a interface desta aplicação por inteiro, entenda todas as funcionalidades dela e crie uma nova interface com base nessa análise.

"Por inteiro" quer dizer cada item do inventário do passo 3; a análise só termina quando todos estiverem com [x].

## Faça, nesta ordem

1. Se a sessão tiver um mecanismo de memória que resista à compactação, use-o. Se não tiver, crie um, com um hook SessionStart que reimprima o caderno da tarefa depois de cada compactação.
2. Leia todo o código da interface, inteiro, em blocos até a última linha de cada arquivo: telas, componentes, estilos, textos, atalhos, estados.
3. Monte o inventário completo, num arquivo de lista do projeto, cada item com [ ], de tudo o que a aplicação faz e de tudo o que a interface oferece:
   - cada funcionalidade e o fluxo completo dela;
   - cada tela, menu, painel, diálogo, botão, ferramenta e atalho;
   - cada estado (vazio, carregando, cheio, erro).

   Marque o que está no código mas não tem caminho na interface. Em `.claude/settings.json`, ponha `"permissions": { "deny": ["Agent"] }` (sem subagentes) e um hook `Stop` que sai com código 2 enquanto a lista tiver um [ ] (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks).
4. Abra a aplicação e percorra cada item do inventário como um usuário, com gestos reais de mouse e teclado.
   - Tire capturas em PNG em resolução cheia de cada tela e de cada estado, e amplie a região quando o detalhe importa.
   - Abra e analise cada captura de verdade.
   - Teste também em tamanho de celular, se a aplicação puder ser usada no celular.
5. Escreva a análise num arquivo do projeto, cada ponto com a captura que o mostra:
   - o que está bom e deve ficar;
   - o que está ruim: navegação confusa, passos demais, hierarquia visual fraca, inconsistência entre telas, textos ruins, contraste e acessibilidade, retorno ao usuário que falta, estados de erro e de vazio mal resolvidos, desempenho percebido;
   - o que falta: funcionalidades sem acesso, atalhos, retorno visual, ajuda;
   - o que sobra;
   - o fluxo de cada tarefa principal hoje, passo a passo, e quantos passos ele custa.
6. Pesquise referências atuais de interfaces de aplicações do mesmo tipo e de boas práticas (padrões de interação, acessibilidade WCAG, guias de design das plataformas). Cite os links e diga o que cada uma ensina para este caso.
7. Proponha a nova interface:
   - o mapa de navegação novo;
   - o fluxo novo de cada tarefa principal, com quantos passos custa;
   - o sistema visual: cores como tokens, tipografia, espaçamento, componentes, estados, modo claro e escuro;
   - como cada problema da análise fica resolvido;
   - como cada funcionalidade do inventário continua acessível. Nenhuma pode sumir.

   Pare e me mostre a proposta. Só comece o passo 8 depois que eu aprovar.
8. Crie a nova interface de verdade, ligada às funcionalidades reais da aplicação, sem tirar nenhuma:
   - um mesmo sistema de tokens e componentes para tudo, definido num único lugar;
   - os textos num único catálogo.

   Não pinte a interface atual de outra cor e chame de nova: a estrutura, a navegação e os fluxos têm de mudar onde a análise mostrou problema.
9. Depois de cada tela feita, abra a aplicação, percorra os fluxos dela com gestos reais, tire as capturas novas e compare com as antigas. Corrija o que estiver errado e repita. Commite cada tela verificada.
10. Tire do settings o hook da lista e commite.
11. No fim, informe:
    - o inventário (X de Y itens cobertos na nova interface);
    - a análise resumida;
    - o antes e depois de cada tela, com as capturas;
    - o que não foi feito e por quê;
    - o que não foi verificado.

## Regras

- Faça você mesmo.
- Fora da aprovação do passo 7, decida sozinho o que for de rotina.
- Tudo no projeto em inglês; a conversa comigo em português.
- Nunca diga que uma tela está pronta sem a captura que mostra isso.

---

# Prompt 8: Protótipo navegável em HTML autocontido

Crie um protótipo da interface completa da aplicação descrita abaixo: um único arquivo HTML autocontido, com toda a navegação funcionando e nada além disso.

## A aplicação (preenchido pelo dono)

- Nome: [[NOME DA APLICAÇÃO]]
- O que ela é e para que serve: [[OBJETIVO]]
- Quem usa e em que situação: [[USUÁRIOS E CONTEXTO]]
- Onde vai rodar (desktop, celular, os dois): [[PLATAFORMAS]]
- Idioma da interface: [[IDIOMA]]

## Telas (preenchido pelo dono)

Uma por linha: o nome, o que mostra e de onde se chega a ela.

1. [[TELA 1: nome, o que mostra, o que tem nela]]
2. [[TELA 2]]
3. [[TELA 3]]
4. [[MAIS TELAS, quantas forem]]

## Navegação (preenchido pelo dono)

- Tipo de navegação principal (barra lateral, abas, menu superior, barra inferior no celular): [[NAVEGAÇÃO PRINCIPAL]]
- Caminhos entre telas que devem existir: [[FLUXOS DE NAVEGAÇÃO, ex.: lista -> detalhe -> editar -> voltar]]
- Diálogos, menus e painéis que abrem por cima: [[MODAIS E PAINÉIS]] (opcional)

## Aparência (preenchido pelo dono)

- Estilo e referências que gosto: [[ESTILO E REFERÊNCIAS]] (opcional)
- Cores da marca: [[CORES]] (opcional)
- Modo claro, escuro ou os dois: [[TEMA]] (opcional)
- Outras sugestões: [[SUGESTÕES LIVRES]] (opcional)

## O que o protótipo é

- Um único arquivo .html autocontido: o HTML, o CSS e o JavaScript dentro dele, sem build, sem servidor, sem dependência externa, abrindo direto no navegador. Se uma fonte ou biblioteca for indispensável, carregue-a de uma CDN com a versão exata e diga qual é.
- Todas as telas da lista, cada uma com o conteúdo de exemplo realista que a tela teria: textos, listas, números e imagens de marcação feitas em CSS ou SVG inline. Nada de "lorem ipsum".
- Toda a navegação funcionando:
  - cada item de menu, botão de navegação, link, aba, voltar, abrir e fechar diálogo e painel leva aonde deve;
  - o endereço muda com a tela (hash, por exemplo #/tela), então o voltar e o avançar do navegador funcionam e uma tela pode ser aberta pelo endereço;
  - a tela atual fica marcada no menu.
- Nada além da navegação: nenhum dado salvo, nenhuma regra de negócio, nenhum formulário que processa algo, nenhuma integração. Botões que não navegam ficam visíveis e com aparência de clicáveis, e ao clicar mostram um aviso discreto de que são só do protótipo.

## Como deve ser feito

- Uma única fonte da verdade para a navegação: a lista de telas e rotas, os itens de menu e os títulos definidos num único objeto no script, e tudo gerado a partir dele. Nada repetido à mão.
- Uma única fonte da verdade para o visual: cores, tipografia, espaçamentos, raios e sombras como variáveis CSS num só lugar, com o tema escuro redefinindo as mesmas variáveis.
- Os componentes repetidos (cartões, botões, linhas de lista, cabeçalhos) com o mesmo estilo em todas as telas.
- Responsivo: funciona e fica bom de 360 px a 1920 px de largura, sem rolagem horizontal; no celular, a navegação vira o padrão de celular.
- Acessível: HTML semântico, foco visível, navegação inteira pelo teclado, contraste mínimo WCAG AA, rótulos em botões só de ícone.
- Código (nomes, classes, comentários) em inglês; os textos da interface no idioma pedido.

## Verificação

- Abra o arquivo no navegador e percorra cada tela e cada caminho de navegação da lista com cliques e teclado reais.
- Tire capturas em desktop e em celular de cada tela, abra e analise cada uma, corrija o que estiver errado e capture de novo.
- Confira que o console não tem erros.
- No fim, entregue o arquivo e informe:
  - as telas feitas (X de Y);
  - os caminhos de navegação testados;
  - onde estão as capturas;
  - o que não foi feito e por quê.

## Regras

- Decida sozinho o que for de rotina e registre as decisões num comentário no topo do arquivo. Pergunte só se o que preenchi permitir duas leituras que levariam a protótipos muito diferentes, e pergunte tudo de uma vez, antes de começar.
- Nunca diga que uma tela está pronta sem a captura que mostra isso.

---

# Prompt 9: Resolver os problemas de uma aplicação

Resolva por completo os problemas desta aplicação descritos abaixo, na causa, sem quebrar nada.

## O problema (preenchido pelo dono)

[[DESCREVA O PROBLEMA OU OS PROBLEMAS: o que acontece, onde, quando, o que devia acontecer]]

## Contexto (opcional, preenchido pelo dono)

- Passos para ver o problema acontecer: [[PASSOS]] (opcional)
- Mensagens de erro, capturas ou logs: [[ERROS / CAPTURAS / LOGS]] (opcional)
- O que já foi tentado: [[TENTATIVAS ANTERIORES]] (opcional)

## O que "resolver" quer dizer

- Resolver é eliminar a causa, não o sintoma.
- Fica proibido:
  - esconder o erro, engolir exceção, pôr try/catch vazio;
  - fixar valores, desligar a funcionalidade, aumentar um limite só para não aparecer;
  - pôr um caso especial que só serve ao exemplo;
  - apagar ou enfraquecer testes.
- Os testes verificam a correção; não são eles que definem a solução. Se um teste estiver errado ou o pedido for inviável, me avise em vez de contornar.
- O problema pertence a uma categoria. Se ele acontece num lugar, procure e resolva todos os lugares onde a mesma causa existe, não só o que eu citei.
- Nada que funciona hoje pode deixar de funcionar, e nada visível pode mudar além do que o problema pede.

## Antes de começar: as regras que o programa garante

Em `.claude/settings.json` (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks):
- `"permissions": { "deny": ["Agent"] }`: sem subagentes;
- um hook `Stop` que sai com código 2 enquanto o type check do projeto falhar, com a saída do compilador na saída de erro. Por exemplo, num projeto TypeScript: `npx tsc --noEmit 1>&2 || exit 2`.

## Faça, nesta ordem

1. Se a sessão tiver um mecanismo de memória que resista à compactação, use-o. Se não tiver, crie um, com um hook SessionStart que reimprima o caderno da tarefa depois de cada compactação. Registre no caderno, a cada passo, o que leu, o que achou (arquivo:linha), o que mudou, o commit e o próximo passo.
2. Entenda o problema pela intenção, não ao pé da letra. Escreva no caderno:
   - o que está errado e o que é o comportamento certo;
   - a lista de todos os lugares e casos da mesma categoria que você vai verificar.
3. Ache a causa lendo o código:
   - siga as chamadas, os imports, os tipos, os dados e a configuração até a origem;
   - leia inteiros os arquivos do caminho, em blocos até a última linha;
   - ligue a causa a tudo que ela afeta e de que depende.

   Não rode a aplicação, não meça e não altere valores para ver se "funciona" como forma de achar a causa. Rodar serve só para confirmar a correção depois.
4. Antes de mudar o uso de qualquer biblioteca ou API, confira na documentação oficial da versão instalada e cite o link. Se duas tentativas falharem, pare de tentar e pesquise a mensagem de erro exata com a versão da ferramenta antes de tentar de novo.
5. Corrija a causa com a lógica real, que funcione para todos os casos válidos. Se a correção certa exige mudar a arquitetura do trecho, mude.
6. Prove a correção, nesta ordem:
   - o type check e o lint do projeto sem erro novo;
   - um teste do ponto que reproduz o problema: ele passa com a correção e falha quando a correção é desfeita (mostre as duas saídas);
   - os testes já existentes daquele trecho passando;
   - se for visual, abra a aplicação, repita os passos com gestos reais de mouse e teclado, tire a captura, analise e informe onde ela foi salva.
7. Commite cada correção verificada sozinha, com mensagem em inglês que diga a causa e a correção.
8. Repita os passos 3 a 7 para cada caso da lista do passo 2 até não sobrar nenhum.
9. No fim, informe:
   - a causa de cada problema, com arquivo:linha;
   - o que foi mudado, com o commit;
   - a prova: as saídas dos testes e as capturas;
   - quantos casos da categoria foram verificados e resolvidos (X de Y);
   - o que não foi resolvido e por quê, com a prova no código;
   - o que não foi verificado.

## Regras

- Faça você mesmo.
- Decida sozinho o que for de rotina.
- Tudo no projeto em inglês; a conversa comigo em português.
- Se algum pedido meu parecer errado ou impossível como está escrito, diga numa frase, com a prova, e siga com o resto do pedido como eu escrevi.
- Nunca diga que corrigiu sem a prova do passo 6.

---

# Prompt 10: Pesquisa profunda para um fim

Faça uma pesquisa profunda sobre o assunto abaixo, para o fim que eu digo. Ela tem de cobrir tudo o que existe sobre o assunto, não só o que eu citei: o que deve ser feito, o que deve ser evitado, as regras, as melhores práticas, as armadilhas, os erros comuns e as soluções de cada um.

Eu não sei tudo o que existe sobre o assunto, e não vou listar. Descobrir o que existe é a primeira parte do trabalho.

## O fim (preenchido pelo dono)

- Para que serve a pesquisa: [[O FIM, ex.: criar uma skill do Claude Code que faz X]]
- Onde o resultado vai ser usado (projeto, ferramenta, versão): [[CONTEXTO, ex.: este repositório, Claude Code atual]]
- O que eu já sei ou já decidi: [[O QUE JÁ SEI]] (opcional)
- Fontes que eu quero que entrem: [[FONTES]] (opcional)

## O que é "profunda"

- **Cobre o assunto inteiro.** Antes de aprofundar qualquer ponto, você monta o mapa do assunto: cada parte, conceito, opção, configuração, limite e caso de uso. Monta pelas próprias fontes: o índice da documentação oficial, as referências, os changelogs e os assuntos que as fontes citam umas das outras.
- **Vai à fonte primária.** Nesta ordem de peso:
  1. a documentação oficial da versão atual;
  2. a referência técnica e o código-fonte, quando é aberto;
  3. os changelogs e as notas de versão;
  4. os exemplos oficiais;
  5. os issues e as discussões do repositório oficial, que é onde aparecem os erros reais e as soluções.

  Blogs, fóruns e respostas de terceiros servem para achar armadilhas e erros comuns, e cada coisa que vier deles é conferida na fonte primária.
- **Lê a página inteira.** Uma página longa se lê até o fim, em partes. O resumo de uma busca não conta como página lida.
- **Tem data e versão.** Cada afirmação traz o link, a data ou a versão a que se refere. Uma regra de uma versão antiga é marcada como antiga.
- **Resolve os conflitos.** Quando duas fontes discordam, você diz quais são, qual vale e por quê: a mais nova, a oficial ou a que você confirmou na prática.
- **Diz o que não achou.** Uma lacuna é escrita como lacuna, nunca preenchida com suposição.

## Antes de começar: as regras que o programa garante

1. Crie a pasta da pesquisa no projeto (por exemplo `docs/research/<assunto>/`) com:
   - `map.md`: o mapa do assunto, cada parte com [ ] na frente;
   - `sources.md`: cada fonte lida, com o link, a data e o que ela traz;
   - `notes.md`: os achados, escritos enquanto você lê.
2. Se a sessão tiver um mecanismo de memória que resista à compactação, use-o. Se não tiver, crie um, com um hook SessionStart que reimprima o `map.md` e o `notes.md` depois de cada compactação.
3. Em `.claude/settings.json` (https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/hooks):
   - `"permissions": { "deny": ["Agent"] }`: sem subagentes;
   - um hook `Stop` que sai com código 2 enquanto o `map.md` tiver um [ ], com o que falta na saída de erro.

## Faça, nesta ordem

1. Monte o mapa do assunto no `map.md`. Ponha nele também o que o fim exige e as fontes não mostram de imediato: como se testa, como se distribui, como falha, o que muda entre versões, o que é proibido ou desaconselhado. Marque o que eu não citei.
2. Para cada parte sem [x]:
   - leia as fontes dela, inteiras;
   - registre no `notes.md`, cada item com o link e a versão:
     - como funciona e as regras;
     - o que fazer (melhores práticas, com o porquê);
     - o que evitar (o que a fonte desaconselha, com o porquê);
     - as armadilhas e os erros comuns, cada um com o sintoma, a causa e a solução;
     - os limites (tamanhos, quantidades, versões, plataformas);
   - acrescente ao mapa as partes novas que as fontes revelarem;
   - marque a parte com [x].
3. Mantenha no `notes.md` as hipóteses sobre o melhor caminho para o fim, com o grau de confiança de cada uma. Atualize-as conforme as fontes confirmam ou derrubam.
4. Commite a pasta da pesquisa a cada poucas partes.
5. Quando o mapa não tiver mais [ ], escreva o `report.md`:
   - o resumo: o que é preciso saber para atingir o fim;
   - as regras obrigatórias e as recomendações, separadas;
   - o que fazer e o que evitar, cada item com o porquê e o link;
   - as armadilhas e os erros comuns, com o sintoma, a causa e a solução;
   - os conflitos entre fontes e como foram resolvidos;
   - o caminho recomendado para o fim, passo a passo, e as alternativas descartadas, com o porquê;
   - a lista de verificação que diz quando o resultado está certo;
   - as lacunas: o que não foi encontrado ou não pôde ser confirmado.
6. Tire do settings o hook `Stop` desta tarefa e commite.

## Regras

- Faça você mesmo.
- Decida sozinho o que for de rotina.
- Não construa o resultado (a skill, o código) neste prompt: a entrega é a pesquisa. O relatório é o ponto de partida para construí-lo numa sessão nova.
- Nunca afirme algo sem a fonte, nunca diga que leu uma página que não leu e nunca apresente suposição como fato.
- Tudo no projeto em inglês; a conversa comigo em português.
- No fim, informe:
  - as partes do mapa cobertas (X de Y), com as que eu não tinha citado;
  - as fontes lidas (quantas e quais as principais);
  - onde está o relatório;
  - as lacunas.
