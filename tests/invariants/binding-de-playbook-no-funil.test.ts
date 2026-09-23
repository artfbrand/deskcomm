/**
 * Invariantes do binding persistido funil → playbook (migration 0234):
 * `crm_pipelines.ai_playbook_id` + a FK composta para `ai_playbooks`.
 *
 * Roda contra o Postgres efêmero do `scripts/test-db.sh` (baseline aplicado,
 * banco novo para este arquivo). Congela:
 *
 *   A      a coluna existe, é `uuid` e é NULLABLE;
 *   B      a FK composta existe e referencia `(organization_id, id)` de
 *          `ai_playbooks`, com `set null` restrito à coluna do binding;
 *   C      o índice parcial existe;
 *   D      `null` é aceito, e toda linha nasce `null` (sem backfill);
 *   E      CROSS-TENANT É RECUSADO PELO BANCO — a propriedade central;
 *   F      UUID inexistente é recusado;
 *   G      vínculo legítimo (mesma org) é aceito;
 *   H      apagar o playbook nulifica o binding, PRESERVA `organization_id` e
 *          não apaga o funil;
 *   I      apagar a organização continua funcionando, sem violação de FK.
 *
 * ─── Por que estes testes rodam como `postgres`, e não por sessão ───────────
 *
 * O que se mede aqui é a FK, não a RLS. A FK vale para TODO papel — inclusive
 * `service_role`, que bypassa RLS e é exatamente quem escreveria um binding
 * errado num handler descuidado. Medir a recusa com o papel mais poderoso do
 * banco é a versão FORTE da afirmação: se nem `postgres` consegue vincular
 * cross-tenant, nenhum caminho da aplicação consegue.
 *
 * ─── O que este arquivo NÃO cobre ───────────────────────────────────────────
 *
 * Que o baseline instala do zero e reaplica sem erro não é testado aqui: é o
 * `scripts/test-db.sh` que faz isso, nas duas passadas e as duas com
 * `ON_ERROR_STOP=1`, ANTES desta suíte existir. Repetir aqui mediria o mesmo
 * fato duas vezes e daria a impressão de duas provas.
 *
 * Zero PII: ids sintéticos e e-mails @invariant.test.
 */
import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { columnExists, indexExists, sql } from "./gov-helpers";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

/** Roda o script e devolve a MENSAGEM de erro do psql, ou null se passou. */
function falha(script: string): string | null {
  try {
    execFileSync(
      "docker",
      ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return null;
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

const ORG_A = "bbbbbbbb-7777-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-7777-4000-8000-000000000002";
const ORG_DESCARTAVEL = "bbbbbbbb-7777-4000-8000-000000000003";
const USER_A = "bbbbbbbb-7778-4000-8000-000000000001";
const PB_A = "bbbbbbbb-7779-4000-8000-000000000001";
const PB_B = "bbbbbbbb-7779-4000-8000-000000000002";
const PB_DESCARTAVEL = "bbbbbbbb-7779-4000-8000-000000000003";
const FUNIL_A = "bbbbbbbb-777a-4000-8000-000000000001";
const FUNIL_B = "bbbbbbbb-777a-4000-8000-000000000002";
const FUNIL_DESCARTAVEL = "bbbbbbbb-777a-4000-8000-000000000003";
/** Não existe em `ai_playbooks` — usado para provar a recusa por ausência. */
const PB_FANTASMA = "bbbbbbbb-7779-4000-8000-0000000000ff";

function seedOrg(org: string, tag: string): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'binding-${tag}', 'Binding ${tag}', 'Binding ${tag}')
      on conflict (id) do nothing;
  `;
}

function seedFunil(funil: string, org: string, tag: string): string {
  return `
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${funil}', '${org}', 'Funil ${tag}', 'funil-${tag}')
      on conflict (id) do nothing;
  `;
}

function seedPlaybook(pb: string, org: string, tag: string): string {
  return `
    insert into public.ai_playbooks (id, organization_id, slug, name)
      values ('${pb}', '${org}', 'binding_${tag}', 'Binding ${tag}')
      on conflict (id) do nothing;
  `;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${USER_A}', 'binding-a@invariant.test')
      on conflict (id) do nothing;
    ${seedOrg(ORG_A, "a")}
    ${seedOrg(ORG_B, "b")}
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_A}', '${ORG_A}', 'manager', now())
      on conflict do nothing;
    ${seedFunil(FUNIL_A, ORG_A, "a")}
    ${seedFunil(FUNIL_B, ORG_B, "b")}
    ${seedPlaybook(PB_A, ORG_A, "a")}
    ${seedPlaybook(PB_B, ORG_B, "b")}
  `);
});

// ─── A — a coluna ─────────────────────────────────────────────────────────────

describe("crm_pipelines.ai_playbook_id — a coluna", () => {
  it("A1. existe", () => {
    expect(columnExists("crm_pipelines", "ai_playbook_id")).toBe(true);
  });

  it("A2. é uuid e é NULLABLE", () => {
    const linha = sql(`
      select data_type, is_nullable, column_default is null
        from information_schema.columns
       where table_schema = 'public' and table_name = 'crm_pipelines'
         and column_name = 'ai_playbook_id';
    `);
    // Nullable e sem default: a coluna nasce vazia e ninguém a preenche por
    // acidente. Um default aqui inventaria binding onde não há decisão humana.
    expect(linha).toBe("uuid|YES|t");
  });

  it("A3. tem COMMENT — a coluna explica o próprio contrato no catálogo", () => {
    const comentario = sql(`
      select coalesce(col_description('public.crm_pipelines'::regclass, a.attnum), '')
        from pg_attribute a
       where a.attrelid = 'public.crm_pipelines'::regclass and a.attname = 'ai_playbook_id';
    `);
    expect(comentario).toMatch(/ai_playbooks/);
    expect(comentario).toMatch(/NULL/);
  });
});

// ─── B — a FK composta ────────────────────────────────────────────────────────

describe("crm_pipelines_ai_playbook_fkey — a forma da FK", () => {
  it("B1. é FK composta (organization_id, ai_playbook_id) → ai_playbooks (organization_id, id)", () => {
    const linha = sql(`
      select
        c.contype,
        (select string_agg(a.attname, ',' order by x.ord)
           from unnest(c.conkey) with ordinality x(attnum, ord)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = x.attnum),
        c.confrelid::regclass::text,
        (select string_agg(a.attname, ',' order by x.ord)
           from unnest(c.confkey) with ordinality x(attnum, ord)
           join pg_attribute a on a.attrelid = c.confrelid and a.attnum = x.attnum)
      from pg_constraint c
      where c.conname = 'crm_pipelines_ai_playbook_fkey'
        and c.conrelid = 'public.crm_pipelines'::regclass;
    `);
    // A ORDEM das colunas importa: é ela que casa organization_id com
    // organization_id. Invertida, a FK compararia org com id e nunca casaria.
    expect(linha).toBe("f|organization_id,ai_playbook_id|ai_playbooks|organization_id,id");
  });

  it("B2. ON DELETE é SET NULL, e SÓ da coluna do binding", () => {
    const linha = sql(`
      select
        c.confdeltype,
        coalesce((select string_agg(a.attname, ',' order by x.ord)
           from unnest(c.confdelsetcols) with ordinality x(attnum, ord)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = x.attnum), '(todas)')
      from pg_constraint c
      where c.conname = 'crm_pipelines_ai_playbook_fkey'
        and c.conrelid = 'public.crm_pipelines'::regclass;
    `);
    // `n` = SET NULL. A lista NÃO pode ser "(todas)": sem ela o delete tentaria
    // nulificar organization_id, que é not null, e estouraria 23502. Este é o
    // caso que a sintaxe pg15 existe para resolver, e o teste que o prova.
    expect(linha).toBe("n|ai_playbook_id");
  });

  it("C. o índice parcial existe", () => {
    expect(indexExists("idx_crm_pipelines_ai_playbook")).toBe(true);
    const pred = sql(`
      select pg_get_expr(i.indpred, i.indrelid) is not null
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
       where c.relname = 'idx_crm_pipelines_ai_playbook';
    `);
    expect(pred).toBe("t");
  });
});

// ─── D — sem backfill ─────────────────────────────────────────────────────────

describe("o binding nasce vazio — não houve backfill", () => {
  it("D1. nenhum funil do banco tem binding preenchido", () => {
    const n = sql(`select count(*) from public.crm_pipelines where ai_playbook_id is not null;`);
    expect(n).toBe("0");
  });

  it("D2. funis criados sem citar a coluna ficam null", () => {
    const linha = sql(`select ai_playbook_id is null from public.crm_pipelines where id = '${FUNIL_A}';`);
    expect(linha).toBe("t");
  });

  it("D3. null explícito é aceito (desvincular é uma operação legítima)", () => {
    const erro = falha(`update public.crm_pipelines set ai_playbook_id = null where id = '${FUNIL_A}';`);
    expect(erro).toBeNull();
  });
});

// ─── E/F/G — o que a FK aceita e o que ela recusa ─────────────────────────────

describe("a FK decide o que pode ser vinculado", () => {
  it("E. CROSS-TENANT é recusado: funil da org A não recebe playbook da org B", () => {
    const erro = falha(`update public.crm_pipelines set ai_playbook_id = '${PB_B}' where id = '${FUNIL_A}';`);
    // 23503 = foreign_key_violation. Recusado com o papel `postgres`, que
    // bypassa RLS — logo nenhum caminho da aplicação consegue escrever isto,
    // nem um handler que use service role e esqueça de filtrar a organização.
    expect(erro).toMatch(/23503|violates foreign key constraint|crm_pipelines_ai_playbook_fkey/);
    const depois = sql(`select ai_playbook_id is null from public.crm_pipelines where id = '${FUNIL_A}';`);
    expect(depois).toBe("t");
  });

  it("E2. o inverso também: funil da org B não recebe playbook da org A", () => {
    const erro = falha(`update public.crm_pipelines set ai_playbook_id = '${PB_A}' where id = '${FUNIL_B}';`);
    expect(erro).toMatch(/23503|violates foreign key constraint|crm_pipelines_ai_playbook_fkey/);
  });

  it("F. UUID que não existe em ai_playbooks é recusado", () => {
    const erro = falha(`update public.crm_pipelines set ai_playbook_id = '${PB_FANTASMA}' where id = '${FUNIL_A}';`);
    expect(erro).toMatch(/23503|violates foreign key constraint|crm_pipelines_ai_playbook_fkey/);
  });

  it("G. vínculo legítimo (mesma organização) é aceito", () => {
    const erro = falha(`update public.crm_pipelines set ai_playbook_id = '${PB_A}' where id = '${FUNIL_A}';`);
    expect(erro).toBeNull();
    const linha = sql(`select ai_playbook_id from public.crm_pipelines where id = '${FUNIL_A}';`);
    expect(linha).toBe(PB_A);
  });
});

// ─── H — o delete do playbook ─────────────────────────────────────────────────

describe("apagar o playbook desvincula, sem levar o funil junto", () => {
  it("H. ai_playbook_id vira null, organization_id é PRESERVADO e o funil sobrevive", () => {
    sql(`
      ${seedOrg(ORG_DESCARTAVEL, "desc")}
      ${seedFunil(FUNIL_DESCARTAVEL, ORG_DESCARTAVEL, "desc")}
      ${seedPlaybook(PB_DESCARTAVEL, ORG_DESCARTAVEL, "desc")}
      update public.crm_pipelines
         set ai_playbook_id = '${PB_DESCARTAVEL}'
       where id = '${FUNIL_DESCARTAVEL}';
    `);
    const antes = sql(`
      select ai_playbook_id, organization_id from public.crm_pipelines where id = '${FUNIL_DESCARTAVEL}';
    `);
    expect(antes).toBe(`${PB_DESCARTAVEL}|${ORG_DESCARTAVEL}`);

    const erro = falha(`delete from public.ai_playbooks where id = '${PB_DESCARTAVEL}';`);
    expect(erro).toBeNull();

    const depois = sql(`
      select count(*), max(ai_playbook_id::text) is null, max(organization_id::text)
        from public.crm_pipelines where id = '${FUNIL_DESCARTAVEL}';
    `);
    // O funil continua existindo (count=1), o binding virou null, e a
    // organização é a MESMA. Se a FK tivesse `set null` sem lista de colunas,
    // este delete teria estourado 23502 em vez de chegar aqui.
    expect(depois).toBe(`1|t|${ORG_DESCARTAVEL}`);
  });
});

// ─── I — o delete da organização ──────────────────────────────────────────────

describe("apagar a organização continua funcionando", () => {
  it("I. cascade da organização não é travado pela FK nova", () => {
    // O caminho de expurgo (LGPD) apaga a organização, e ela cascateia para
    // `crm_pipelines` E para `ai_playbooks` sem ordem garantida entre as duas.
    // Com `restrict` no lugar de `set null`, esta transação poderia abortar.
    sql(`
      ${seedPlaybook(PB_DESCARTAVEL, ORG_DESCARTAVEL, "desc2")}
      update public.crm_pipelines
         set ai_playbook_id = '${PB_DESCARTAVEL}'
       where id = '${FUNIL_DESCARTAVEL}';
    `);
    const vinculado = sql(`select ai_playbook_id from public.crm_pipelines where id = '${FUNIL_DESCARTAVEL}';`);
    expect(vinculado).toBe(PB_DESCARTAVEL);

    const erro = falha(`delete from public.organizations where id = '${ORG_DESCARTAVEL}';`);
    expect(erro).toBeNull();

    const sobrou = sql(`
      select
        (select count(*) from public.crm_pipelines where id = '${FUNIL_DESCARTAVEL}'),
        (select count(*) from public.ai_playbooks where id = '${PB_DESCARTAVEL}');
    `);
    expect(sobrou).toBe("0|0");
  });
});
