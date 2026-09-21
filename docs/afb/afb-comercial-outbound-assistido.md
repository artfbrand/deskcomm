# AFB Comercial Outbound — Copilot Assistido

Estado: preparação do piloto. Este documento é a decisão atual; não reescreve o playbook histórico em
`docs/afb/playbooks/afb-comercial-v1.html` (Versão 6).

## Decisões vigentes

- **CONFIRMADO:** o Copilot usa `ai_agents` + `ai_agent_versions`, modo `assisted`, publicação nativa e
  aprovação humana de `ai_reply_drafts`.
- **DECISÃO:** D12 é mensagem automática via WhatsApp sobre Ambiente de Contratação Livre. E-mail
  ficará para uma fase futura.
- **DECISÃO:** nesta fase não há roteador, envio automático normal, operador, skill, fluxo de
  follow-up nem criação automática de agenda.
- **DECISÃO:** gerar uma sugestão não envia mensagem nem comprova efeito comercial. Só um evento
  comprovado pode autorizar CRM, follow-up ou agenda.
- **CONFIRMADO:** o funil é selecionado por UUID ou por configuração única já vinculada ao playbook;
  nomes de funil/etapa não são regra. `crm_stages.is_won` e `is_lost` continuam autoritativos.

## Configuração preparada

O bootstrap cria ou reconcilia, sem duplicar:

1. o agente `AFB Comercial Outbound — Assistido`;
2. seis materiais FAQ nativos e versionáveis;
3. a memória `AFB — Princípios comerciais e limites`;
4. `settings.modulos.copiloto_comercial.enabled=true` e
   `playbook_id=afb_comercial_v1`, preservando `etapas` e demais propriedades;
5. uma versão publicada com credencial, modelo, sessão, funil e materiais resolvidos;
6. uma linha `afb.bootstrap_applied` na auditoria.

O apply pode preparar funil, conhecimento e memória sem credencial OpenAI. Agente e versão só são
criados/publicados quando credencial OpenAI ativa e validada, modelo com tools, sessão `WORKING` e
funil estiverem inequívocos. A chave não é lida nem exibida pelo bootstrap; a consulta usa
`ai_provider_credentials_safe`.

## System prompt

```text
Você é o Copilot Comercial da AFB Engenharia & Consultoria.

Sua função é auxiliar um vendedor humano na condução comercial. Você trabalha em modo assistido.

Você pode interpretar mensagens, identificar intenção e objeções, consultar conhecimento aprovado,
memória organizacional e o playbook configurado, sugerir respostas e explicar brevemente o objetivo
da sugestão.

Você NÃO envia mensagens normais diretamente. Uma sugestão não é uma mensagem enviada, e uma
mensagem enviada não prova que um efeito comercial aconteceu. Somente um evento comprovado autoriza
efeitos posteriores.

Nunca prometa economia; invente dados, valores de fatura, contratos, disponibilidade, preço, prazo ou
credenciamento; determine solução técnica definitiva; conclua cálculo de banco de capacitores, estudo
de proteção ou parametrização de relés; conclua contrato; marque ganho ou perda; ou afirme que uma
reunião foi criada sem confirmação da agenda.

Economias entre 10% e 35% são referências históricas possíveis e nunca promessa. Serviços técnicos,
preços, contratos, condições especiais e decisões de engenharia exigem humano.

Quando faltar informação, diga o que falta, não invente e recomende esclarecimento ou handoff.

Use o playbook comercial configurado como fonte de verdade para sequência, etapas, mensagens
oficiais, objeções e regras comerciais. Use conhecimento e memória apenas como contexto adicional.
```

## Conhecimento e memória

Os conteúdos humanos e auditáveis são Markdown versionado no repositório:

- `docs/afb/knowledge/empresa-posicionamento.md`;
- `docs/afb/knowledge/portfolio-servicos.md`;
- `docs/afb/knowledge/metodo-gmt.md`;
- `docs/afb/knowledge/mercado-livre-energia-assinatura.md`;
- `docs/afb/knowledge/objecoes-contexto.md`;
- `docs/afb/knowledge/privacidade-consentimento.md`;
- `docs/afb/memory/principios-comerciais-e-limites.md`.

O bootstrap lê somente esses caminhos declarados, valida título, versão, status e escopo, normaliza o
conteúdo e calcula SHA-256. Cada conhecimento vira uma fonte `faq` nativa, com um item documental
identificado por tag estável. O Markdown completo fica na resposta desse item porque esse formato é
auditável e editável pela interface nativa atual. Caminho, versão declarada, hash, status e escopo
ficam em `ai_knowledge_sources.source_metadata.afb_bootstrap`.

Uma nova execução localiza a fonte primeiro pela chave estável do bootstrap e usa o título reservado
para detectar colisões. Se o hash, o título ou os metadados mudarem, atualiza a mesma fonte e o mesmo
item e solicita nova indexação; não cria outra fonte. Itens humanos não pertencentes ao bootstrap são
preservados. Material homônimo sem a chave de propriedade, chave duplicada ou fonte AFB arquivada é
conflito e nunca é sobrescrito, reativado ou duplicado silenciosamente.

Os seis materiais cobrem empresa e posicionamento; serviços; método GMT; Mercado Livre e energia por
assinatura; contexto de objeções; privacidade, consentimento e opt-out. O documento de objeções aponta
para `lib/afb/playbooks/comercial/objecoes.ts` e `afb_comercial_v1`, sem copiar as respostas oficiais.
O HTML completo do playbook não é copiado para o RAG e continua sendo a fonte de verdade para
sequência, copy, objeções, cadência e regras do fluxo.

A memória contém apenas princípios comerciais e limites estáveis, carregados do documento em
`docs/afb/memory/`. Ela não repete a cadência nem as copies oficiais e é reconciliada pelo título
reservado dentro da organização.

### Auditoria na interface

**CONFIRMADO:** o módulo nativo de Conhecimento lista nome, status de indexação e quantidade de
trechos. A pessoa pode abrir os trechos indexados, editar e revisar o conteúdo textual, solicitar
reindexação e arquivar a fonte. Fontes arquivadas aparecem na seção correspondente. Não é necessária
uma tela AFB paralela.

**LIMITAÇÃO:** a tela apresenta o Markdown como a resposta do único item documental da FAQ, não como
um arquivo com visualização Markdown dedicada. A UI também não expõe hoje os campos AFB de caminho,
versão e SHA-256 do `source_metadata`, embora eles estejam disponíveis no registro para auditoria
técnica. Editar o item pela UI não altera o arquivo versionado nem seu hash de bootstrap; essa edição
é um desvio temporário que o próximo apply explícito reconcilia com o repositório. A reativação de uma
fonte arquivada não aparece como ação na mesma tela.

## Capacidades

Habilitadas: leitura de contatos, conversas, histórico, oportunidades e funis; consulta ao conhecimento
e à memória; leitura dos tipos, compromissos e horários livres da agenda. Handoff e casos ficam
habilitados pelos controles nativos da versão.

Bloqueadas: enviar WhatsApp; criar/alterar/mover oportunidade; marcar ganho/perda; gravar memória;
criar/remarcar/cancelar compromisso; iniciar/cancelar follow-up; apagar registros. O operador fica
desligado e sem ferramentas.

## Follow-up futuro — não provisionado

| Dia    | Decisão futura                                                |
| ------ | ------------------------------------------------------------- |
| D0     | envio manual; o **envio real** é a âncora, nunca a importação |
| D1     | tarefa de ligação pela manhã                                  |
| D3     | WhatsApp automático — demanda contratada                      |
| D5     | tarefa de ligação à tarde                                     |
| D8     | WhatsApp automático — energia reativa                         |
| D12    | WhatsApp automático — Ambiente de Contratação Livre           |
| D15    | WhatsApp automático — encerramento                            |
| depois | reciclagem em 6 meses                                         |

## Agenda futura — não provisionada

Serão reutilizados os tipos de agendamento, disponibilidade, agendamentos, integração Google, sync e
as funções idempotentes já existentes. Tipos planejados: `Reunião 1 — Diagnóstico energético` e
`Reunião 2 — Resultados GMT e fechamento`. Nenhum tipo ou compromisso é criado pelo bootstrap.

## Escalonamento

Casos e handoff nativos serão usados para pedido de preço, contrato, promessa de economia, decisão
técnica, disponibilidade ambígua, falha de agenda, reclamação, exclusão, possível problema de
consentimento e informação contraditória. Não existe um sistema de alertas paralelo.

## Observabilidade e gaps

**CONFIRMADO:** `ai_agent_runs` preserva agente/versão, conversa, contato, sessão, tokens, custo,
latência, tools e resultado; `llm_calls` registra provedor/modelo/tokens/custo/latência;
`knowledge_searches` registra fontes e qualidade da busca; `ai_reply_drafts` preserva contexto,
rascunho, revisão, feedback, trace e mensagem enviada; `event_log`, outbox e `api_audit_log` fecham a
trilha operacional.

**GAPS:** ainda não há uma única entidade correlacionando todos os campos desejados. `playbook_id`,
versão/etapa do playbook, pipeline/stage/lead e versão da memória não formam hoje um snapshot completo
em `ai_agent_runs`; `suggestion_id` ainda não é um identificador transversal; e os estados de
`ai_reply_drafts` não são a taxonomia futura `generated/inserted/sent_unchanged/sent_edited/discarded/
manual_message`. O desenho preserva versão do agente, modelo, contexto e execução e não impede essa
evolução.

### Versão do documento usada por uma sugestão

**CONFIRMADO hoje:** cada fonte guarda `document_path`, `document_version` e `document_sha256` em
`source_metadata.afb_bootstrap`; cada reindexação cria uma linha numerada em
`ai_knowledge_versions`; `ai_knowledge_sources.active_kb_version_id` aponta para a versão ativa; e
cada trecho registra `ai_chunks.content_hash`. Isso permite provar qual documento o bootstrap desejava
e qual índice está ativo no momento da inspeção. Cada apply também grava no `api_audit_log` o caminho,
a versão declarada e o SHA-256 dos seis conhecimentos e da memória, sem copiar seu conteúdo.

**GAP:** `ai_knowledge_versions.sources_snapshot` não é preenchido pelo indexador atual, e a geração
da sugestão não persiste ainda o conjunto exato de fontes, versões ativas e hashes consultados. Logo,
o estado atual não prova retroativamente, por sugestão, qual hash estava ativo naquele instante. A
tabela de entradas de memória também não possui coluna própria de hash; para ela, o hash existe no
relatório e na auditoria do apply, enquanto o documento e seu frontmatter são a fonte versionada.

**CAMINHO RECOMENDADO:** no início de cada geração, capturar para cada fonte consultável o trio
`knowledge_source_id`, `active_kb_version_id` e `document_sha256`, junto com a versão da memória, e
persisti-lo no contexto/trace do `ai_agent_run` ou de `ai_reply_drafts`. As citações da busca devem
carregar o mesmo `kb_version_id`. Esse snapshot pequeno liga sugestão, execução e chunks sem criar um
segundo sistema de conhecimento nem copiar o conteúdo completo.

## Skills futuras — backlog somente

- `afb-qualificar-consultoria-energetica`
- `afb-conduzir-objecoes-outbound`
- `afb-agendar-reuniao-diagnostico`
- `afb-coletar-dados-gmt`
- `afb-triar-servico-subestacao`
- `afb-escalar-decisao-tecnica`

Nenhuma delas é instalada ou implementada nesta preparação.

## Execução

Dry-run, padrão e sem escrita:

```bash
pnpm afb:provision -- --organization <uuid-ou-slug>
```

Apply explícito, preferindo IDs para referências ambíguas:

```bash
pnpm afb:provision -- --organization <uuid-ou-slug> --pipeline <uuid> \
  --credential <uuid> --channel-session <uuid> --model <model-id> --apply
```

`--credential`, `--channel-session` e `--model` podem ser omitidos somente quando a resolução é
inequívoca. O funil pode ser omitido somente se exatamente um funil ativo já tiver
`playbook_id=afb_comercial_v1`. Encontrar o nome `Prospecção Outbound AFB` é apenas informação no
relatório, nunca autorização para escolhê-lo.

Se faltar credencial, a interface deve ser usada para cadastrar e validar OpenAI. Depois, execute o
dry-run novamente. A mensagem esperada é:

> Credencial OpenAI validada necessária antes de publicar/testar o agente.
