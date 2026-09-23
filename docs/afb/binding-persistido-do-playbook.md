# Binding persistido do playbook — arquitetura e rollout (Fase D)

> O que esta fase entregou, o que ela deliberadamente **não** entregou, e em que
> ordem ela pode ir para produção sem quebrar o Copiloto.
>
> Mapa vivo: [`docs/architecture/afb-comercial-outbound-bootstrap.architecture.json`](../architecture/afb-comercial-outbound-bootstrap.architecture.json)
> (node `binding`, arestas `e44`–`e46`).

---

## Estado atual — o registry continua sendo a autoridade

**O binding persistido não executa playbook nenhum.** Quem decide etapa, copy e
sugestão continua sendo o registry TypeScript (`lib/afb/playbooks/registry.ts`),
resolvido por `lib/afb/gate.ts` a partir do id legado gravado no funil.

O binding serve a quatro coisas, e nenhuma delas é execução:

| uso | onde |
|---|---|
| persistência estrutural (a coluna e a FK existem) | migration `0234` |
| produção do vínculo pelo provisionamento | `lib/afb/provisionamento/` |
| observação em shadow | `lib/afb/copiloto/shadow-afb.ts` |
| comparação registry × persistido | `lib/playbooks/shadow.ts` |

A frase que vale como invariante desta fase:

> **binding persistido observado ≠ binding persistido executado.**

É a mesma família de distinções que o produto já faz em outros lugares — *IA
sugeriu ≠ mensagem enviada*, *mensagem enviada ≠ efeito comercial concluído*.
Trocar a autoridade é fase posterior e explícita; não começa por uma leitura que
"só" ficou pendurada num `if`.

---

## Schema

```sql
alter table public.crm_pipelines
  add column if not exists ai_playbook_id uuid;

alter table public.crm_pipelines
  add constraint crm_pipelines_ai_playbook_fkey
  foreign key (organization_id, ai_playbook_id)
  references public.ai_playbooks (organization_id, id)
  on delete set null (ai_playbook_id);

create index if not exists idx_crm_pipelines_ai_playbook
  on public.crm_pipelines (ai_playbook_id)
  where ai_playbook_id is not null;
```

**Coluna real, nunca JSONB.** Um UUID dentro de
`settings.modulos.copiloto_comercial` seria um ponteiro para uma linha real sem
FK, dentro de um `jsonb` sem CHECK — três dos anti-patterns que o `CLAUDE.md`
proíbe de uma vez (string que deveria ser FK, FK ausente, lock-in de jsonb). As
consequências não são teóricas: playbook apagado deixaria ponteiro órfão, e um
UUID de outra organização entraria sem que nada recusasse.

**A lista de colunas no `set null` é obrigatória, não estilo.** `set null` sem
lista nulificaria também `organization_id`, que é `not null`, e o delete
falharia com `23502`. É sintaxe PostgreSQL 15+, e o pg15 é o piso declarado do
baseline.

As alternativas foram descartadas com motivo: `cascade` apagaria o **funil** ao
apagar um playbook; `restrict` bloquearia o expurgo de organização (LGPD), que
cascateia para as duas tabelas sem ordem garantida entre elas.

**Sem backfill.** A coluna nasce `null` em toda linha de todo clone. Preencher
na migration exigiria casar funil com playbook pelo **slug** — devolvendo ao
slug o papel de autoridade que o ponteiro acabou de tirar dele, dentro de um
lugar onde ninguém consegue auditar o que foi casado.

---

## Compatibilidade — os dois bindings convivem

O legado continua exatamente onde estava:

```
crm_pipelines.settings.modulos.copiloto_comercial.playbook_id = "afb_comercial_v1"
```

Precedência (`lib/afb/copiloto/binding.ts`):

| estado de `ai_playbook_id` | origem | quem responde |
|---|---|---|
| UUID legível | `persistido` | o ponteiro |
| `null` / ausente | `legado` | o id de registry do jsonb |
| **presente e ilegível** | `ausente` | **ninguém** |

A terceira linha é a decisão que mais merece atenção: **um valor presente e
ilegível NÃO cai para o legado.** `null` é a fonte persistida dizendo "não tenho
nada a declarar" — e aí perguntar ao legado é o certo. Um valor presente é
alguém tendo **declarado** um vínculo; honrar o legado quando a declaração está
ilegível entregaria um playbook **diferente** do escolhido, em silêncio.

Escopo honesto: como a coluna é `uuid`, o Postgres recusa a forma errada, então
esse estado é defensivo — só chega por cast na mão ou caminho de leitura
corrompido. Ele não ganhou vocabulário próprio (um quarto `origem: "invalido"`)
pela mesma razão já registrada em `lib/playbooks/carregador.ts`: não se inventa
vocabulário para um caso que ninguém consegue produzir nem usar.

Os dois vocabulários são **mutuamente inválidos** por forma — um UUID tem hífens
e nunca casa `^[a-z0-9_]+_v\d+$`; um id de registry não tem a forma 8-4-4-4-12.
Nenhum valor pode ser lido como o outro por engano.

---

## Shadow — o binding escolhe a porta, não o conteúdo

```
persistido : UUID           → carregarPlaybookPublicadoPorId(client, org, uuid)
legado     : id de registry → mapa temporário → slug → carregarPlaybookPublicado
ausente    : —              → not_observed / runtime_sem_playbook
```

O mapa `SLUG_PERSISTIDO_POR_ID_DO_REGISTRY` **continua existindo**, restrito ao
ramo legado. Quem já tem o UUID não volta ao slug para chegar à linha: isso
devolveria autoridade a uma coluna renomeável.

O log `playbook.shadow` ganhou um campo:

```
binding_source = "persistido" | "legado"
```

Derivado da identidade, nunca passado — dois campos que pudessem discordar
seriam um a mais. É o que torna a migração **contável** em vez de suposta.

`slug` passou a poder ser `null`: na busca por id sem linha encontrada, o slug
não é conhecido antes de ler, e inventá-lo seria a tradução que esta fase existe
para não fazer.

**O lado executado da comparação continua sendo o registry:** `sha_registry` vem
de `deRegistryParaDefinicao(playbook)`, e `registry_playbook_id` vem do contexto
que o runtime já resolveu.

A chave de cadência passou a carregar o **tipo** da identidade
(`org:id:<uuid>` / `org:slug:<slug>`). Sem isso, uma instalação que migra do
slug para o ponteiro herdaria a janela da identidade antiga e ficaria até 10 min
sem a primeira observação pelo binding novo — justamente a que se quer ver.

---

## Segurança

- **`organization_id` vem da sessão ou da própria linha**, nunca de payload.
- **A FK composta impede cross-tenant no BANCO**, não na aplicação: a primeira
  coluna do par é o `organization_id` do próprio funil, então vincular um funil
  de A a um playbook de B é recusado com `23503` — inclusive para `service_role`,
  que bypassa RLS.
- **Nenhum UUID hardcoded** no provisionador nem no repositório.
- **Sem service role em handler normal**: o Copiloto usa cliente de sessão, e
  ainda assim filtra `organization_id` explicitamente em toda consulta.
- **O UUID não vem do cliente**: `ProvisioningOptions` não aceita playbook, e a
  rota do Copiloto recebe apenas `conversationId`.
- **Nenhuma tradução UUID→slug no caminho persistido.**
- O binding viaja como **irmão** do contexto, não dentro dele — por isso não
  entra no JSON público. O endereço interno do playbook não chega ao browser.

---

## Rollout — ORDEM OBRIGATÓRIA

> ## ⚠️ NUNCA implante a imagem D.4/D.5 antes da migration 0234.

**Por quê, em concreto:**

- **D.4** faz `.select("settings, ai_playbook_id")` em `configurePipeline`. Sem
  a coluna, o PostgREST erra e o `afb:provision` **para por inteiro**.
- **D.5** faz o mesmo `.select()` em `carregarContextoDoCopiloto`. Sem a coluna,
  o erro vira `{tipo:"falha"}` e **a rota do Copiloto responde 500**. Isso
  acontece **antes** do shadow, no carregamento do contexto — portanto **não é
  fail-open**.

Inverter a ordem não degrada: **quebra o Copiloto para o usuário final.**

### Sequência

| # | passo | como confirmar |
|---|---|---|
| 1 | aplicar a migration `0234` | sem erro |
| 2 | validar coluna, FK e índice | ver consulta abaixo |
| 3 | publicar/deployar a imagem com D.4/D.5 | só depois do passo 2 |
| 4 | validar health e runtime | `version` = o SHA esperado; app responde |
| 5 | executar o provisionamento AFB | `afb:provision --pipeline <uuid> --apply` |
| 6 | confirmar o binding gravado | `ai_playbook_id` preenchido no funil |
| 7 | abrir o Copiloto numa conversa | a tela responde como sempre |
| 8 | confirmar o log | ver bloco abaixo |

**Passo 2 — a conferência do schema:**

```sql
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='crm_pipelines'
   and column_name='ai_playbook_id';

select conname, confdeltype, pg_get_constraintdef(oid)
  from pg_constraint
 where conname='crm_pipelines_ai_playbook_fkey';

select indexname from pg_indexes
 where schemaname='public' and indexname='idx_crm_pipelines_ai_playbook';
```

**Passo 8 — o que o log tem de dizer:**

```
playbook.shadow
  binding_source = persistido
  status         = match
  reason         = equivalente
```

`binding_source = legado` no passo 8 significa que o passo 5 ou 6 não surtiu
efeito — o funil ainda não tem o ponteiro. Não é falha do Copiloto.

**O shadow só emite quando alguém abre o Copiloto**, e tem janela de cadência de
10 minutos por identidade. Silêncio logo após o deploy é ausência de uso, não
defeito.

### Quem usa o `update.sh` não precisa fazer nada

O kit já aplica `supabase/baseline.sql` **antes** de puxar a imagem nova
(`setup-kit/update.sh`: baseline na linha ~145, imagem a partir da ~230). A
ordem obrigatória acima é, portanto, garantida pelo caminho normal.

Ela precisa ser **executada à mão** apenas em instalações que atualizam fora do
kit — por exemplo trocando a imagem direto no orquestrador.

---

## Rollback

**Se a 0234 já foi aplicada e a imagem nova falhar, o rollback da imagem é
seguro.** A coluna pode — e deve — permanecer no banco:

- ela é `nullable` e nasceu `null`;
- o runtime antigo não a seleciona e não a conhece;
- a FK só é exercida quando há valor, e valor só existe se o provisionamento
  novo rodou.

> **Não remova a coluna durante um rollback operacional.**

Remover a `0234` é mudança **destrutiva** — apagaria bindings já gravados e
exigiria uma migration de reversão versionada. Isso não faz parte do rollback
normal desta entrega, e não deve ser improvisado sob pressão de incidente.

Se for mesmo necessário desfazer o schema, é decisão de produto com migration
própria, plano de migração e major — não um passo de runbook.

---

## O que esta fase NÃO mudou

- autonomia (não existe OFF/ASSISTED/AUTOMATIC nesta fase);
- CRM, leads, etapas, envio de mensagens;
- o conteúdo do playbook;
- o Knowledge;
- qualquer tela;
- a resposta HTTP do Copiloto — provado byte a byte em
  `tests/unit/copiloto-shadow-sem-efeito.test.ts`, sob as três origens de
  binding e sob falha do shadow.
