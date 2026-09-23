-- ============================================================================
-- 0233 — PLAYBOOKS GENÉRICOS, VERSIONADOS: `ai_playbooks` + `ai_playbook_versions`.
--
-- ─── O que é ──────────────────────────────────────────────────────────────
--
-- Um playbook é ESTRATÉGIA CONVERSACIONAL — etapas com id estável, objetivos,
-- copies oficiais, condições de resposta, objeções, guardrails, canais e a
-- intenção de follow-up. Até aqui o único playbook do produto vive em código
-- (`lib/afb/playbooks/comercial/*`, registry em memória) e não tem draft,
-- publicação, histórico nem rollback. Esta migration cria só a PERSISTÊNCIA:
-- nenhuma rota, tela, import ou resolver passa a ler daqui ainda; o registry
-- em código segue sendo a fonte operacional até a fase que faz a troca.
--
-- A forma do `definition` é o Zod de `lib/playbooks/definicao.ts`
-- (`schema_version: 1`), validado na camada de servidor ANTES do publish. O
-- banco não repete essa validação: só garante que é um objeto JSON.
--
-- ─── Não confundir com `playbook_versions` / `playbook_pointers` (0004) ─────
--
-- Aquelas são CAMADAS DE PROMPT do agent-engine (`platform|tenant|campaign`,
-- Markdown ≤200 linhas, um ponteiro por org+camada, sem estrutura). Estas são
-- ENTIDADES nomeadas por organização, com etapas estruturadas, várias por org,
-- draft editável e versões numeradas. Mesma palavra, abstrações diferentes —
-- daí o prefixo `ai_`, como em `ai_agents` e `ai_knowledge_sources`.
--
-- ─── O padrão seguido: `<x>_pointers` + `<x>_versions` ────────────────────
--
-- O par espelha `followup_flow_pointers` / `followup_flow_versions` (0054/0056):
--   * o PONTEIRO (`ai_playbooks`) tem identidade, `status`, o `draft` em
--     edição e `published_version_id`;
--   * a VERSÃO (`ai_playbook_versions`) é um snapshot congelado —
--     `fn_agent_versions_immutable()` veta UPDATE, como em todas as
--     `*_versions` do produto;
--   * o publish é UMA função `security definer` (`fn_publish_ai_playbook_version`),
--     que insere a versão e move o ponteiro na mesma transação, com o ponteiro
--     sob `FOR UPDATE` — o que também serializa o `version_number` (max+1 sob o
--     lock da linha do ponteiro nunca corre com outro publish do mesmo playbook,
--     e `unique (playbook_id, version_number)` é o cinto).
--
-- ─── Semântica de `status` × `draft` × `published_version_id` ─────────────
--
--   draft      — criado e NUNCA publicado; `published_version_id` é NULL.
--   published  — tem versão publicada; `draft` NÃO NULO = há edição em
--                andamento SOBRE uma versão publicada (o runtime nunca lê o
--                draft). Publicar consome o draft (volta a NULL).
--   archived   — fora de uso; mantém `published_version_id` para histórico.
--
-- "status = draft" NÃO significa "tem draft": significa "nunca publicou". A
-- coerência é CHECK (`ai_playbooks_status_coerente`), não convenção.
--
-- ─── O que NÃO mora aqui, de propósito ────────────────────────────────────
--
--   * AUTONOMIA. Não há `mode`, `assisted`, `automatic`, `auto_send`,
--     `execution_mode`. OFF | ASSISTED | AUTOMATIC é do BINDING (hoje
--     `crm_pipelines.settings.modulos.copiloto_comercial`), nunca do playbook:
--     o mesmo playbook é assistido num funil e automático noutro.
--   * Automações (follow-up, agenda, lembretes, operador de CRM): políticas
--     próprias, fora daqui.
--   * Privacidade (`is_blocked`, `force_human`, opt-out, estados terminais):
--     guard central ANTES do resolver, não conteúdo de playbook.
--   * Bindings além do funil (campanha, webhook, canal, entry mode): fase
--     própria, tabela própria.
--
-- ─── DELETE ───────────────────────────────────────────────────────────────
--
-- Segue a doutrina de `fn_agent_versions_immutable` (0004): UPDATE de versão é
-- vetado; DELETE fica de fora para o cascade de `organizations` passar. O que
-- protege o histórico é (a) o FK do ponteiro — a versão publicada não pode ser
-- apagada enquanto apontada — e (b) a RLS das versões, que dá a `authenticated`
-- só SELECT: versões nascem exclusivamente pela função de publish. O ciclo de
-- vida do playbook é ARQUIVAR, não apagar.
--
-- ─── Coerência de tenant, pelo SCHEMA ─────────────────────────────────────
--
-- Duas FKs compostas, e as duas existem para tornar estado impossível de fato
-- impossível, em vez de "a função de publish toma cuidado":
--
--   1. `ai_playbook_versions (organization_id, playbook_id)` →
--      `ai_playbooks (organization_id, id)` — versão e playbook são SEMPRE da
--      mesma organização.
--   2. `ai_playbooks (id, published_version_id)` →
--      `ai_playbook_versions (playbook_id, id)` — o ponteiro só aponta para
--      uma versão DELE MESMO.
--
-- Juntas dão o que interessa por transitividade: a versão publicada é do mesmo
-- playbook E da mesma organização. Medido nos dois sentidos no teste de
-- invariante.
--
-- ─── FK cíclica ───────────────────────────────────────────────────────────
--
-- A (2) fecha um ciclo (`ai_playbooks` ↔ `ai_playbook_versions`). Ordem: cria o
-- ponteiro sem ela, cria as versões, e só então adiciona a constraint.
--
-- Idempotente: re-aplicável em clone que já tem tudo isto.
-- ============================================================================

-- ─── 1. O ponteiro ─────────────────────────────────────────────────────────

create table if not exists public.ai_playbooks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Identidade humana e estável dentro da organização (`afb_comercial`). Nunca
  -- é referência de runtime — quem referencia usa `id`.
  slug text not null,
  name text not null,
  description text,
  status text not null default 'draft',
  -- A definição em EDIÇÃO. Nunca é lida pelo runtime; publicar a consome.
  draft jsonb,
  -- FK adicionada no passo 3 (ciclo com as versões).
  published_version_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  archived_at timestamptz,
  unique (organization_id, slug),
  -- Alvo do FK COMPOSTO das versões: é o que torna impossível uma versão da
  -- org B pendurada num playbook da org A (padrão de `channel_routing_policies`).
  unique (organization_id, id),
  constraint ai_playbooks_slug_check check (slug ~ '^[a-z][a-z0-9_]{1,63}$'),
  constraint ai_playbooks_status_check check (status in ('draft', 'published', 'archived')),
  constraint ai_playbooks_draft_e_objeto check (draft is null or jsonb_typeof(draft) = 'object'),
  constraint ai_playbooks_metadata_e_objeto check (jsonb_typeof(metadata) = 'object'),
  -- draft ⇔ nunca publicou; published ⇒ aponta para uma versão; archived ⇒ tanto faz.
  constraint ai_playbooks_status_coerente check (
    status = 'archived'
    or (status = 'draft') = (published_version_id is null)
  ),
  constraint ai_playbooks_archived_at_coerente check ((status = 'archived') = (archived_at is not null))
);

comment on table public.ai_playbooks is
  'Playbook (estratégia conversacional) da organização — o PONTEIRO: identidade, status, draft em edição e a versão publicada. Sem campo de autonomia: OFF/ASSISTED/AUTOMATIC é do binding. Ver migration 0233.';
comment on column public.ai_playbooks.draft is
  'Definição em edição (schema de lib/playbooks/definicao.ts). Nunca lida pelo runtime; publicar a consome (volta a NULL).';
comment on column public.ai_playbooks.published_version_id is
  'A versão que vale. Rollback = apontar para uma versão anterior deste mesmo playbook (FK composto garante).';

create index if not exists idx_ai_playbooks_org_status
  on public.ai_playbooks (organization_id, status);

drop trigger if exists trg_ai_playbooks_updated_at on public.ai_playbooks;
create trigger trg_ai_playbooks_updated_at
  before update on public.ai_playbooks
  for each row execute function public.fn_set_updated_at();

-- ─── 2. As versões (imutáveis) ─────────────────────────────────────────────

create table if not exists public.ai_playbook_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O vínculo com o playbook é COMPOSTO, com a organização dentro: a coerência
  -- de tenant é do SCHEMA, não da função de publish. Sem isto, um INSERT de
  -- service role (script, migração de dados, engano) conseguiria pendurar uma
  -- versão da org B num playbook da org A — e a RLS das versões, que filtra por
  -- `organization_id`, esconderia essa versão de quem é dono do playbook.
  playbook_id uuid not null,
  foreign key (organization_id, playbook_id)
    references public.ai_playbooks (organization_id, id) on delete cascade,
  version_number integer not null,
  -- Snapshot congelado da definição (Zod em lib/playbooks/definicao.ts).
  definition jsonb not null,
  -- sha256 hex do JSON canônico da definição, calculado pela camada que publica
  -- com o MESMO algoritmo determinístico do adaptador (canonicalHash). O banco
  -- não recalcula: um segundo algoritmo aqui divergiria do primeiro em silêncio.
  definition_sha256 text not null,
  notes text,
  -- Quem publicou.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (playbook_id, version_number),
  -- Alvo do FK composto do ponteiro (passo 3).
  unique (playbook_id, id),
  constraint ai_playbook_versions_version_number_check check (version_number >= 1),
  constraint ai_playbook_versions_definition_e_objeto check (jsonb_typeof(definition) = 'object'),
  constraint ai_playbook_versions_sha256_check check (definition_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.ai_playbook_versions is
  'Versão PUBLICADA de um playbook — snapshot imutável (trigger veta UPDATE). Rollback move o ponteiro; a versão antiga continua aqui. Ver migration 0233.';
comment on column public.ai_playbook_versions.definition_sha256 is
  'sha256 hex do JSON canônico de `definition`, fornecido por quem publica (mesmo algoritmo do adaptador). Sem tamanho máximo no banco: a definição de referência tem ~54 KB e o limite, se houver, é da camada de servidor.';

create index if not exists idx_ai_playbook_versions_org
  on public.ai_playbook_versions (organization_id);

-- Imutabilidade compartilhada de todas as *_versions (função genérica da 0004:
-- só usa tg_table_name; não conhece coluna nem status).
drop trigger if exists trg_ai_playbook_versions_immutable on public.ai_playbook_versions;
create trigger trg_ai_playbook_versions_immutable
  before update on public.ai_playbook_versions
  for each row execute function public.fn_agent_versions_immutable();

-- ─── 3. Fecha o ciclo: o ponteiro só aponta para versão DELE ───────────────

do $$ begin
  alter table public.ai_playbooks
    add constraint ai_playbooks_published_version_fkey
    foreign key (id, published_version_id)
    references public.ai_playbook_versions (playbook_id, id);
exception when duplicate_object then null; end $$;

-- ─── 4. RLS ────────────────────────────────────────────────────────────────

alter table public.ai_playbooks enable row level security;
alter table public.ai_playbook_versions enable row level security;

-- Formato da 0150/0181: ler é de todo membro; ESCREVER exige papel — o
-- PostgREST é exposto ao browser, e sem `fn_role_at_least` um `viewer`
-- reescreveria a estratégia comercial da própria organização com o JWT dele.
-- `manager` é o piso de quem monta o agente (Follow-ups, Conhecimento,
-- Memória têm o mesmo piso na navegação); a rota espelha.
drop policy if exists tenant_isolation_ai_playbooks_select on public.ai_playbooks;
create policy tenant_isolation_ai_playbooks_select on public.ai_playbooks
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_playbooks_write on public.ai_playbooks;
create policy tenant_isolation_ai_playbooks_write on public.ai_playbooks
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

-- Versões: membro da org LÊ; ninguém escreve pela sessão. INSERT só pela função
-- de publish (definer), UPDATE vetado pelo trigger para todo papel, DELETE só
-- por cascade/service role (ver cabeçalho).
drop policy if exists tenant_isolation_ai_playbook_versions_select on public.ai_playbook_versions;
create policy tenant_isolation_ai_playbook_versions_select on public.ai_playbook_versions
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

-- ─── 4b. A cerca da sessão de suporte, DECLARADA ───────────────────────────
--
-- O bloco que gera `support_write_{insert,update,delete}` enumera o catálogo
-- UMA vez, no meio do baseline — antes deste apêndice. Toda tabela do dump é
-- alcançada; uma tabela criada SÓ aqui, não. Medido num container com o
-- baseline aplicado uma única vez (o que o `install.sh` faz): estas duas eram
-- as ÚNICAS tenant-graváveis sem as três policies restritivas, entre 101 com a
-- cerca completa. Na segunda aplicação (`update.sh`) elas apareciam — isto é,
-- a instalação FRESCA ficava diferente da atualizada, e pior: sem a cerca, um
-- `admin` em sessão de suporte SOMENTE LEITURA escreveria na estratégia
-- comercial do cliente que ele está atendendo.
--
-- Declarar aqui resolve sem mexer no mecanismo global. A forma é a MESMA que o
-- enumerador produz, então quando ele rodar de novo (na atualização) o
-- drop/create recria idêntico. Vigiado por `ai-playbooks-schema.test.ts`
-- ("a cerca da sessão de suporte cobre as duas tabelas").
do $$
declare t text;
begin
  foreach t in array array['ai_playbooks', 'ai_playbook_versions'] loop
    execute format('drop policy if exists support_write_insert on public.%I', t);
    execute format('create policy support_write_insert on public.%I as restrictive for insert to authenticated with check (public.fn_support_write_allowed(organization_id))', t);
    execute format('drop policy if exists support_write_update on public.%I', t);
    execute format('create policy support_write_update on public.%I as restrictive for update to authenticated using (public.fn_support_write_allowed(organization_id)) with check (public.fn_support_write_allowed(organization_id))', t);
    execute format('drop policy if exists support_write_delete on public.%I', t);
    execute format('create policy support_write_delete on public.%I as restrictive for delete to authenticated using (public.fn_support_write_allowed(organization_id))', t);
  end loop;
end $$;

-- ─── 5. Publish atômico ────────────────────────────────────────────────────

create or replace function public.fn_publish_ai_playbook_version(
  p_org uuid,
  p_playbook uuid,
  p_definition jsonb,
  p_definition_sha256 text,
  p_created_by uuid,
  p_notes text default null
)
returns table (version_id uuid, version_number integer, published_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pointer record;
  v_next integer;
  v_id uuid;
  v_now timestamptz := now();
begin
  if p_definition is null or jsonb_typeof(p_definition) <> 'object' then
    raise exception 'definition_invalida' using errcode = '22023';
  end if;

  -- O lock da linha do ponteiro é o que serializa publicações do MESMO
  -- playbook: o max+1 abaixo corre sob ele, então dois publishes concorrentes
  -- nunca calculam o mesmo número. `organization_id` é conferido contra o que
  -- está gravado, nunca aceito do chamador como verdade.
  select p.id, p.organization_id, p.status
    into v_pointer
  from ai_playbooks p
  where p.id = p_playbook
  for update;

  if not found or v_pointer.organization_id <> p_org then
    raise exception 'playbook_not_found' using errcode = 'P0001';
  end if;
  if v_pointer.status = 'archived' then
    raise exception 'playbook_archived' using errcode = 'P0001';
  end if;

  select coalesce(max(v.version_number), 0) + 1
    into v_next
  from ai_playbook_versions v
  where v.playbook_id = p_playbook;

  insert into ai_playbook_versions
    (organization_id, playbook_id, version_number, definition, definition_sha256, notes, created_by)
  values
    (p_org, p_playbook, v_next, p_definition, p_definition_sha256, p_notes, p_created_by)
  returning id into v_id;

  update ai_playbooks
     set published_version_id = v_id,
         status = 'published',
         published_at = v_now,
         draft = null,
         updated_at = v_now
   where id = p_playbook;

  return query select v_id, v_next, v_now;
end;
$$;

comment on function public.fn_publish_ai_playbook_version(uuid, uuid, jsonb, text, uuid, text) is
  'Publica uma versão de playbook: insere o snapshot e move o ponteiro na mesma transação, com o ponteiro sob FOR UPDATE (serializa o version_number). Service role only; a rota valida a definição (Zod) e o papel antes de chamar. Ver migration 0233.';

-- As DUAS origens de EXECUTE (CLAUDE.md §Migrations, item 9): o PUBLIC que o
-- Postgres dá ao criar, e o grant direto a anon/authenticated do ALTER DEFAULT
-- PRIVILEGES do baseline.
revoke all on function public.fn_publish_ai_playbook_version(uuid, uuid, jsonb, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_publish_ai_playbook_version(uuid, uuid, jsonb, text, uuid, text)
  to service_role;
