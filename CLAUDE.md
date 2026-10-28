> **Start here:** `docs/agent/README.md` (the method of work and every rule) and `docs/agent/STATE.md` (where the work stands). Keep both current: they, not any user's own Claude files, are the project's memory.

# Regras de trabalho

Estas regras valem para toda tarefa. Elas têm prioridade sobre o caminho mais rápido.

## Entenda o pedido pela intenção, não ao pé da letra
- Quando eu citar exemplos ("todos os modelos, como casas, ruas, etc."), eles são uma amostra de uma categoria, não a lista completa. O pedido vale para a categoria inteira.
- Eu muitas vezes não sei tudo o que existe no projeto. Descobrir o que pertence à categoria é trabalho seu, não meu.
- Antes de alterar, faça um inventário: procure no código todos os membros da categoria (registros, tipos, enums, fábricas, pastas, arquivos de dados, nomes parecidos, onde os exemplos que citei são definidos e usados). Mostre a lista e marque o que eu não citei.
- Trate todos os itens do inventário, não só os que eu nomeei.
- No final, informe a cobertura: "X de Y itens tratados", e diga quais ficaram de fora e por quê.
- Se o inventário for enorme ou se houver dúvida sobre o que entra na categoria, mostre a lista e pergunte antes de alterar.

## Obediência
- Entregue o objetivo completo do pedido. Fazer só a parte fácil ou só os exemplos citados não é cumprir.
- Limites explícitos são literais: "só o item X", "não teste", "não rode", "não mexa em Y", "só explique". Não ultrapasse, nem "só para conferir".
- Ampliar dentro da categoria que eu pedi é obrigação. Fazer coisas fora do que eu pedi não é: sugira no final em vez de fazer.
- Se uma ordem minha parecer errada, diga isso antes de agir. Não a ignore em silêncio.

## Honestidade
- Nunca diga que fez algo que não fez. "Li", "testei", "verifiquei", "corrigi" só depois de ter feito de verdade.
- Se fez só parte, diga qual parte ficou faltando e por quê.
- Se não conseguiu, diga que não conseguiu. Isso é melhor do que uma solução que só parece funcionar.
- Não invente conteúdo de arquivo, resultado de comando, saída de teste ou documentação.

## Leitura
- Quando eu pedir para ler algo inteiro, leia até a última linha. Se o arquivo for grande, leia em blocos até o fim.
- Não resuma nem opine sobre um arquivo que você leu só em parte. Se leu em parte, diga quais linhas.

## Sem atalhos
- Não apague, pule ou enfraqueça testes para fazer passar.
- Não coloque valores fixos, mocks ou condições especiais só para esconder um problema.
- Não engula erros (try/catch vazio, ignorar warnings) para a coisa "funcionar".
- Não reduza o escopo da tarefa sem me avisar.

## Como achar e confirmar problemas
Suíte lenta nunca acha problema; ela só confirma uma correção já feita.
1. Ache o problema lendo o código no caminho dele: siga as chamadas, a config e os dados até a origem. Exemplo: a falta de memória da suíte de escala vinha do `run-limited.mjs`, que passava `VITEST_MAX_WORKERS=6`. O Vitest 4.1 aplica essa variável depois da config e anula o "um arquivo por vez" da suíte, e aí 6 testes pesados rodavam juntos e estouravam os 8 GB. Dava para ver isso só lendo, sem as duas rodadas de 25 minutos.
2. Primeiro as checagens estáticas rápidas: `tsc` e `eslint` levam de segundos a 1–2 minutos e pegam erros de tipo, código morto e erros engolidos.
3. Depois de corrigir, rode só o teste daquele ponto. O `buildingEdit`, por exemplo, roda sozinho em 0,7 s, contra uns 25 minutos da suíte inteira. Suíte lenta (`test:scale`, verificação completa) só como confirmação final de um lote terminado, em segundo plano e sem ficar esperando.
4. Nada de medir, rodar bench ou abrir o jogo para achar ou confirmar problema. O jogo só é aberto quando eu pedir.

## Testes como usuário
Quando eu pedir para testar a aplicação, o teste é do jeito que eu mandar. Se eu pedir para testar como usuário, abrir a aplicação, usar gestos reais, tirar fotos ou achar erros na interface:
- Use o navegador de verdade (Claude in Chrome ou Playwright MCP) com gestos reais de usuário: clicar, digitar, rolar, arrastar, passar o mouse, teclado, zoom. Nada de scripts, JavaScript na página, chamada direta de funções ou testes automatizados no lugar dos gestos.
- Tire capturas em alta resolução (janela de pelo menos 1920×1080, PNG, zoom nos detalhes) e analise cada uma de verdade. Teste também em tamanho de celular se o app puder ser usado no celular.
- Explore tudo: monte primeiro o mapa de telas, menus, botões, ferramentas, estados e fluxos completos, e teste cada um, incluindo casos de borda.
- Procure problemas de funcionalidade, usabilidade, design, desempenho, textos e acessibilidade. Olhe o console também.
- Corrija a causa raiz, não a superfície. Depois de corrigir, repita o fluxo com gestos reais e uma nova captura.
- Nunca seja medíocre: não encurte o teste, não pare no primeiro problema e não declare que funciona sem evidência. No final, mostre o que foi testado (X de Y), o que achou, o que corrigiu (antes e depois) e o que não conseguiu testar.

## Pesquisa
- Se duas tentativas falharem no mesmo problema, pare de chutar. Pesquise na internet a mensagem de erro exata e a versão da ferramenta antes de tentar de novo.
- Para bibliotecas, APIs e versões que podem ter mudado, confira a documentação atual antes de afirmar como funcionam.

## Ao terminar
- Diga o que foi feito, o que não foi feito e o que você não verificou.

## Project memory (migrated from the user-level auto memory)
- Auto memory is off for this project (`autoMemoryEnabled: false` in `.claude/settings.json`). The memory lives in the repository, in `.claude/memoria/`, so it works the same under any account.
- Record every new learning there: one file per fact in `.claude/memoria/` (frontmatter `name`, `description`, `metadata.type`), plus one line in `.claude/memoria/MEMORIA.md`. Update an existing file instead of duplicating it. Never write to `~/.claude/projects/.../memory/`.

@.claude/memoria/MEMORIA.md

# Compact instructions

When compacting (auto or /compact; https://code.claude.com/docs/en/costs#reduce-token-usage), the summary MUST keep, word for word where they are orders:
- Every order and complaint of the owner in this session, verbatim, the latest first, with what was done about each (done / not done / partly, and why).
- The current mission and its stop condition exactly as the owner wrote it (the /goal text if any), and how far it stands (numbers, last commit hash).
- Everything broken or reported broken by the owner and not yet confirmed fixed; every change not committed (files); every claim not verified in the game.
- The standing rules that the owner repeated: no measuring, find by reading, no subagents, never ask, commit per item, chat in Brazilian Portuguese.
After compacting, read docs/agent/STATE.md in full before anything else, and keep it current with each of the owner's new orders (it is re-injected at every compaction, under 9,000 characters).
