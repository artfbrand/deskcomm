-- 0234 — O binding persistido entre o funil e o playbook.
--
-- ─── O que esta migration cria, e o que ela deliberadamente NÃO cria ────────
--
-- Cria UMA coluna: `crm_pipelines.ai_playbook_id`, o ponteiro do funil para a
-- linha de `ai_playbooks` (migration 0233). Nada mais. Não há leitor, não há
-- escritor, não há backfill, não há trigger, não há função, não há policy
-- nova. Depois desta migration o produto se comporta exatamente como antes —
-- a coluna nasce `null` em TODA linha de TODA instalação, e `null` é o estado
-- normal, não um defeito a ser curado.
--
-- ─── Por que uma COLUNA, e não uma chave em `settings` ──────────────────────
--
-- O binding de hoje mora em `crm_pipelines.settings.modulos.copiloto_comercial
-- .playbook_id`, e é um id de REGISTRY (`afb_comercial_v1`) — uma constante de
-- código, sem linha correspondente no banco. Guardar ali o UUID de
-- `ai_playbooks.id` seria outra coisa: um PONTEIRO para uma linha real, dentro
-- de um `jsonb` sem CHECK, escrito por um merge de três níveis.
--
-- Isso é, ao pé da letra, três dos anti-patterns que o CLAUDE.md proíbe:
-- string que deveria ser FK (1), FK ausente que vira inferência (4) e lock-in
-- de jsonb (6). As consequências não são teóricas: playbook apagado deixaria
-- ponteiro órfão, e um UUID de OUTRA organização entraria sem que nada
-- recusasse — a RLS esconde na leitura, mas o binding já estaria errado.
--
-- ─── A garantia de tenant é da FK, não da aplicação ─────────────────────────
--
--   foreign key (organization_id, ai_playbook_id)
--     references public.ai_playbooks (organization_id, id)
--
-- A primeira coluna do par é o `organization_id` DO PRÓPRIO FUNIL. Ninguém o
-- envia, ninguém o escolhe: ele já está na linha. Logo, vincular um funil da
-- organização A a um playbook da organização B é recusado pelo BANCO, com
-- 23503, sem que nenhum handler precise lembrar de conferir.
--
-- É o mesmo par que a 0233 já usa internamente — `ai_playbook_versions
-- (organization_id, playbook_id) -> ai_playbooks (organization_id, id)` — e
-- funciona porque `ai_playbooks` declara `unique (organization_id, id)`
-- justamente para ser alvo de FK composta de terceiros.
--
-- ─── Por que `on delete set null (ai_playbook_id)`, com a coluna entre ──────
-- ─── parênteses ────────────────────────────────────────────────────────────
--
-- A lista de colunas é obrigatória aqui, e não é estilo: `set null` sem lista
-- nulifica TODAS as colunas da FK, e `organization_id` é `not null` — o delete
-- falharia com 23502. A forma `set null (<coluna>)` nulifica apenas a listada;
-- a FK passa a ter uma coluna nula e é satisfeita por MATCH SIMPLE, que é o
-- padrão.
--
-- As alternativas foram descartadas com motivo:
--
--   cascade  — apagar um playbook APAGARIA O FUNIL, com os leads dentro.
--   restrict — além de impedir apagar um playbook em uso, cria um risco pior:
--              apagar uma organização cascateia para `crm_pipelines` e para
--              `ai_playbooks` sem ordem garantida entre as duas, e o RESTRICT
--              entre elas pode abortar a transação inteira. O expurgo de
--              organização (LGPD) é caminho real; não se põe um RESTRICT no
--              meio dele.
--
-- `set null (coluna)` é PostgreSQL 15+. O piso declarado do projeto é o pg15
-- (`scripts/test-db.sh` sobe `pgvector/pgvector:pg15`, e
-- `tests/unit/baseline-no-piso-do-postgres.test.ts` guarda esse piso), então a
-- dependência é legítima. Medida antes de escrever esta linha, num pg15 limpo:
-- após o delete do pai, a coluna listada vira `null` e `organization_id`
-- permanece com o valor original.
--
-- ─── Por que NÃO há backfill ────────────────────────────────────────────────
--
-- Preencher o binding aqui exigiria casar cada funil com um playbook — e a
-- única pista disponível seria o slug. Isso devolveria ao slug o papel de
-- AUTORIDADE que o ponteiro acabou de tirar dele, dentro de uma migration,
-- onde ninguém consegue auditar o que foi casado. Quem grava o binding é quem
-- tem prova do UUID: o provisionamento, numa etapa própria.
--
-- Como consequência, nenhuma constraint pode falhar por dado existente — a
-- coluna nasce nula em todo lugar. É isso que torna o `update.sh` de um clone
-- seguro nesta migration.
--
-- ─── RLS ────────────────────────────────────────────────────────────────────
--
-- Nenhuma policy nova. A RLS é da TABELA, não da coluna: `crm_pipelines` já a
-- tem, e ela passa a cobrir a coluna nova sem mais nada. A cerca da sessão de
-- suporte também já alcança a tabela — ela veio do enumerador do baseline, que
-- percorre o catálogo do dump, e `crm_pipelines` está no dump.

-- ─── 1. A coluna ───────────────────────────────────────────────────────────

alter table public.crm_pipelines
  add column if not exists ai_playbook_id uuid;

comment on column public.crm_pipelines.ai_playbook_id is
  'Binding PERSISTIDO do playbook deste funil: aponta para public.ai_playbooks.id '
  '(migration 0233). NULL significa ausência de binding persistido — é o estado '
  'normal e não um defeito. Durante a compatibilidade, o runtime legado continua '
  'resolvendo o playbook por settings.modulos.copiloto_comercial.playbook_id, que '
  'guarda um id de registry em código e não um ponteiro para linha. Tenant é '
  'garantido pela FK composta (organization_id, ai_playbook_id), não pela aplicação.';

-- ─── 2. A FK composta ──────────────────────────────────────────────────────
--
-- `add constraint` não aceita `if not exists`; o idioma idempotente da casa é
-- o bloco anônimo com `duplicate_object` (ver 0233, passo 3).

do $$ begin
  alter table public.crm_pipelines
    add constraint crm_pipelines_ai_playbook_fkey
    foreign key (organization_id, ai_playbook_id)
    references public.ai_playbooks (organization_id, id)
    on delete set null (ai_playbook_id);
exception when duplicate_object then null; end $$;

-- ─── 3. O índice ───────────────────────────────────────────────────────────
--
-- Parcial: a grande maioria das linhas fica `null` durante toda a transição, e
-- índice de coluna majoritariamente nula é peso sem leitor. O predicado também
-- é o que serve à pergunta que alguém realmente fará — "quais funis já estão
-- vinculados?" — e à varredura que a FK faz ao apagar um playbook.

create index if not exists idx_crm_pipelines_ai_playbook
  on public.crm_pipelines (ai_playbook_id)
  where ai_playbook_id is not null;
