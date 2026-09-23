/**
 * Invariantes de schema dos playbooks genéricos (migration 0233):
 * `ai_playbooks` (ponteiro) + `ai_playbook_versions` (snapshots) +
 * `fn_publish_ai_playbook_version` (publish atômico).
 *
 * Roda contra o Postgres efêmero do `scripts/test-db.sh` (baseline aplicado,
 * banco novo para este arquivo). Congela:
 *
 *   A/B/C  ponteiro: criação, slug único POR ORG, mesmo slug em orgs diferentes;
 *   D/E/F  publish: cria a versão, numera de forma monotônica (inclusive sob
 *          concorrência real em duas conexões), move o ponteiro, consome o draft;
 *   G      versão publicada é IMUTÁVEL (qualquer UPDATE lança), e a versão
 *          apontada não pode ser apagada (FK);
 *   H      o draft do ponteiro continua editável DEPOIS de publicar, sem mexer
 *          na versão publicada;
 *   I/J/K  isolamento: membro de A não lê ponteiro nem versão de B, não escreve
 *          em B, e publish cross-org é recusado pela própria função;
 *   L      a função é service-only: anon/authenticated não executam;
 *   N      nenhuma coluna de autonomia (OFF/ASSISTED/AUTOMATIC é do binding);
 *   +      coerência status × ponteiro, FK composto (ponteiro só aponta para
 *          versão DELE), publish em arquivado recusado, cascade do ponteiro
 *          apaga as versões (o caminho de purga de organização continua aberto).
 *
 * Rollback NÃO é testado: não existe nesta fase (é só mover o ponteiro).
 * Zero PII: ids sintéticos e e-mails @invariant.test.
 */
import { execFileSync } from "node:child_process";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql, writeCountAs } from "./gov-helpers";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});
afterAll(async () => {
  await pool.end();
});

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

const ORG_A = "aaaaaaaa-7777-4000-8000-000000000001";
const ORG_B = "aaaaaaaa-7777-4000-8000-000000000002";
const USER_A = "aaaaaaaa-7778-4000-8000-000000000001";
const USER_B = "aaaaaaaa-7778-4000-8000-000000000002";
const PB_A = "aaaaaaaa-7779-4000-8000-000000000001";
const PB_B = "aaaaaaaa-7779-4000-8000-000000000002";
const PB_A2 = "aaaaaaaa-7779-4000-8000-000000000003";
const VIEWER_A = "aaaaaaaa-7778-4000-8000-000000000003";

const DEF = `'{"schema_version":1,"meta":{},"stages":[{"id":"abertura","label":"Abertura","order":1,"kind":"sequence"}]}'::jsonb`;
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function publicar(org: string, playbook: string, opts: { sha?: string; by?: string; def?: string } = {}): string {
  return `select version_id, version_number from public.fn_publish_ai_playbook_version(
    '${org}', '${playbook}', ${opts.def ?? DEF}, '${opts.sha ?? SHA}', ${opts.by ? `'${opts.by}'` : "null"}, null);`;
}

function seed(org: string, user: string, tag: string): string {
  return `
    insert into auth.users (id, email) values ('${user}', 'ai-playbooks-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'ai-playbooks-${tag}', 'AI Playbooks ${tag}', 'AI Playbooks ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'manager', now())
      on conflict do nothing;
  `;
}

beforeAll(() => {
  sql(seed(ORG_A, USER_A, "a") + seed(ORG_B, USER_B, "b"));
});

// ─── A/B/C — ponteiro ─────────────────────────────────────────────────────────

describe("ai_playbooks — o ponteiro", () => {
  it("A. membro da org cria o ponteiro pela sessão (RLS with check), em status draft e sem versão", () => {
    const n = writeCountAs(
      USER_A,
      `insert into public.ai_playbooks (id, organization_id, slug, name, created_by)
         values ('${PB_A}', '${ORG_A}', 'comercial_outbound', 'Comercial Outbound', '${USER_A}')`,
    );
    expect(n).toBe(1);
    const linha = sql(`select status, published_version_id is null, draft is null from public.ai_playbooks where id = '${PB_A}';`);
    expect(linha).toBe("draft|t|t");
  });

  it("B. o slug é único DENTRO da organização (23505 no segundo)", () => {
    const erro = falha(
      `insert into public.ai_playbooks (organization_id, slug, name) values ('${ORG_A}', 'comercial_outbound', 'Outro');`,
    );
    expect(erro).toMatch(/23505|duplicate key|ai_playbooks_organization_id_slug_key/);
  });

  it("C. o mesmo slug é permitido em OUTRA organização", () => {
    const n = writeCountAs(
      USER_B,
      `insert into public.ai_playbooks (id, organization_id, slug, name, created_by)
         values ('${PB_B}', '${ORG_B}', 'comercial_outbound', 'Comercial Outbound B', '${USER_B}')`,
    );
    expect(n).toBe(1);
  });

  it("slug fora da forma (maiúscula, hífen, espaço) é recusado pelo CHECK", () => {
    for (const slug of ["Comercial", "comercial-outbound", "comercial outbound", "1abc"]) {
      const erro = falha(`insert into public.ai_playbooks (organization_id, slug, name) values ('${ORG_A}', '${slug}', 'x');`);
      expect(erro, slug).toMatch(/23514|ai_playbooks_slug_check/);
    }
  });

  it("coerência: status=published exige ponteiro; status=draft exige ponteiro nulo; archived exige archived_at", () => {
    expect(
      falha(`insert into public.ai_playbooks (organization_id, slug, name, status) values ('${ORG_A}', 'incoerente_1', 'x', 'published');`),
    ).toMatch(/23514|ai_playbooks_status_coerente/);
    expect(
      falha(`insert into public.ai_playbooks (organization_id, slug, name, status) values ('${ORG_A}', 'incoerente_2', 'x', 'archived');`),
    ).toMatch(/23514|ai_playbooks_archived_at_coerente/);
    expect(
      falha(`insert into public.ai_playbooks (organization_id, slug, name, status) values ('${ORG_A}', 'incoerente_3', 'x', 'assisted');`),
    ).toMatch(/23514|ai_playbooks_status_check/);
  });
});

// ─── D/E/F — publish ──────────────────────────────────────────────────────────

describe("fn_publish_ai_playbook_version — publish atômico", () => {
  it("D. publica: cria a versão 1 com definição, sha e autor", () => {
    const out = sql(publicar(ORG_A, PB_A, { by: USER_A }));
    const [versionId, numero] = lastLine(out).split("|");
    expect(numero).toBe("1");
    expect(versionId).toMatch(/^[0-9a-f-]{36}$/);
    const v = sql(
      `select version_number, definition_sha256, created_by, definition->>'schema_version'
         from public.ai_playbook_versions where id = '${versionId}';`,
    );
    expect(v).toBe(`1|${SHA}|${USER_A}|1`);
  });

  it("F. o ponteiro passou a apontar para a versão, status=published, published_at gravado", () => {
    const linha = sql(
      `select p.status, p.published_at is not null, v.version_number
         from public.ai_playbooks p join public.ai_playbook_versions v on v.id = p.published_version_id
        where p.id = '${PB_A}';`,
    );
    expect(linha).toBe("published|t|1");
  });

  it("E. o version_number é monotônico: dois publishes seguintes dão 2 e 3, e o ponteiro segue o último", () => {
    const n2 = lastLine(sql(publicar(ORG_A, PB_A, { sha: SHA2 }))).split("|")[1];
    const n3 = lastLine(sql(publicar(ORG_A, PB_A))).split("|")[1];
    expect([n2, n3]).toEqual(["2", "3"]);
    const atual = sql(
      `select v.version_number from public.ai_playbooks p
         join public.ai_playbook_versions v on v.id = p.published_version_id where p.id = '${PB_A}';`,
    );
    expect(atual).toBe("3");
    // As três continuam existindo — publicar nunca apaga histórico.
    expect(sql(`select count(*) from public.ai_playbook_versions where playbook_id = '${PB_A}';`)).toBe("3");
  });

  it("E'. sob CONCORRÊNCIA real (4 conexões ao mesmo tempo) os números são distintos e contínuos", async () => {
    const antes = Number(
      (await pool.query<{ m: string }>(`select coalesce(max(version_number),0)::text as m from ai_playbook_versions where playbook_id = $1`, [PB_A])).rows[0]!.m,
    );
    const q = `select version_number from fn_publish_ai_playbook_version($1, $2, $3::jsonb, $4, null, null)`;
    const def = `{"schema_version":1,"meta":{},"stages":[{"id":"abertura","label":"A","order":1,"kind":"sequence"}]}`;
    const resultados = await Promise.all(
      [1, 2, 3, 4].map(() => pool.query<{ version_number: number }>(q, [ORG_A, PB_A, def, SHA])),
    );
    const numeros = resultados.map((r) => r.rows[0]!.version_number).sort((a, b) => a - b);
    expect(numeros).toEqual([antes + 1, antes + 2, antes + 3, antes + 4]);
  });

  it("a constraint unique (playbook_id, version_number) é o cinto: insert direto duplicado → 23505", () => {
    const erro = falha(
      `insert into public.ai_playbook_versions (organization_id, playbook_id, version_number, definition, definition_sha256)
         values ('${ORG_A}', '${PB_A}', 1, ${DEF}, '${SHA}');`,
    );
    expect(erro).toMatch(/23505|duplicate key/);
  });

  it("publicar CONSOME o draft: draft gravado antes do publish volta a NULL", () => {
    sql(`update public.ai_playbooks set draft = '{"schema_version":1,"rascunho":true}'::jsonb where id = '${PB_A}';`);
    expect(sql(`select draft is null from public.ai_playbooks where id = '${PB_A}';`)).toBe("f");
    sql(publicar(ORG_A, PB_A));
    expect(sql(`select draft is null from public.ai_playbooks where id = '${PB_A}';`)).toBe("t");
  });

  it("definição que não é objeto JSON é recusada (22023)", () => {
    expect(falha(publicar(ORG_A, PB_A, { def: `'[1,2,3]'::jsonb` }))).toMatch(/definition_invalida|22023/);
    expect(falha(publicar(ORG_A, PB_A, { def: `null::jsonb` }))).toMatch(/definition_invalida|22023/);
  });

  it("sha256 fora da forma (não hex de 64) é recusado pelo CHECK", () => {
    expect(falha(publicar(ORG_A, PB_A, { sha: "nao-e-um-hash" }))).toMatch(/23514|ai_playbook_versions_sha256_check/);
  });
});

// ─── G — imutabilidade ────────────────────────────────────────────────────────

describe("ai_playbook_versions — imutável", () => {
  const primeira = () => sql(`select id from public.ai_playbook_versions where playbook_id = '${PB_A}' and version_number = 1;`);

  it.each([
    ["notes", `notes = 'editado'`],
    ["definition", `definition = '{"schema_version":1,"x":1}'::jsonb`],
    ["definition_sha256", `definition_sha256 = '${SHA2}'`],
    ["version_number", `version_number = 99`],
    ["created_by", `created_by = null`],
  ])("G. UPDATE de %s numa versão lança (mesmo como superusuário)", (_col, set) => {
    const erro = falha(`update public.ai_playbook_versions set ${set} where id = '${primeira()}';`);
    expect(erro).toMatch(/é imutável/);
  });

  it("G'. pela sessão, UPDATE em versão não alcança linha nenhuma (RLS só dá SELECT)", () => {
    const n = writeCountAs(USER_A, `update public.ai_playbook_versions set notes = 'x' where playbook_id = '${PB_A}'`);
    expect(n).toBe(0);
  });

  it("G''. pela sessão, INSERT direto em versão é barrado — versão só nasce pela função de publish", () => {
    const n = writeCountAs(
      USER_A,
      `insert into public.ai_playbook_versions (organization_id, playbook_id, version_number, definition, definition_sha256)
         values ('${ORG_A}', '${PB_A}', 999, ${DEF}, '${SHA}')`,
    );
    expect(n).toBe(0);
  });

  it("a versão APONTADA não pode ser apagada (FK do ponteiro, sem cascade)", () => {
    const apontada = sql(`select published_version_id from public.ai_playbooks where id = '${PB_A}';`);
    const erro = falha(`delete from public.ai_playbook_versions where id = '${apontada}';`);
    expect(erro).toMatch(/23503|ai_playbooks_published_version_fkey/);
  });
});

// ─── H — draft continua editável ─────────────────────────────────────────────

describe("ai_playbooks — draft depois de publicar", () => {
  it("H. membro edita o draft pela sessão; status e versão publicada não mudam", () => {
    const antes = sql(`select status, published_version_id from public.ai_playbooks where id = '${PB_A}';`);
    const n = writeCountAs(
      USER_A,
      `update public.ai_playbooks set draft = '{"schema_version":1,"stages":[]}'::jsonb where id = '${PB_A}'`,
    );
    expect(n).toBe(1);
    const depois = sql(`select status, published_version_id from public.ai_playbooks where id = '${PB_A}';`);
    expect(depois).toBe(antes);
    expect(sql(`select draft->>'schema_version' from public.ai_playbooks where id = '${PB_A}';`)).toBe("1");
  });

  it("draft que não é objeto JSON é recusado pelo CHECK", () => {
    expect(falha(`update public.ai_playbooks set draft = '"texto"'::jsonb where id = '${PB_A}';`)).toMatch(/23514|ai_playbooks_draft_e_objeto/);
  });

  it("updated_at avança sozinho ao editar (trigger fn_set_updated_at)", () => {
    const antes = sql(`select updated_at from public.ai_playbooks where id = '${PB_A}';`);
    sql(`select pg_sleep(0.05); update public.ai_playbooks set description = 'd' where id = '${PB_A}';`);
    const depois = sql(`select updated_at from public.ai_playbooks where id = '${PB_A}';`);
    expect(depois > antes).toBe(true);
  });
});

// ─── I/J/K — isolamento ───────────────────────────────────────────────────────

describe("isolamento entre organizações", () => {
  beforeAll(() => {
    sql(publicar(ORG_B, PB_B, { by: USER_B }));
  });

  it("J. membro de A lê 0 ponteiros de B (e o próprio, positivo)", () => {
    expect(countAs(USER_A, `select count(*) from public.ai_playbooks where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(USER_A, `select count(*) from public.ai_playbooks where organization_id = '${ORG_A}';`)).toBeGreaterThanOrEqual(1);
    expect(countAs(USER_B, `select count(*) from public.ai_playbooks where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("I. membro de A lê 0 versões de B (e as próprias, positivo)", () => {
    expect(countAs(USER_A, `select count(*) from public.ai_playbook_versions where organization_id = '${ORG_B}';`)).toBe(0);
    expect(countAs(USER_A, `select count(*) from public.ai_playbook_versions where organization_id = '${ORG_A}';`)).toBeGreaterThanOrEqual(1);
    expect(countAs(USER_B, `select count(*) from public.ai_playbook_versions where organization_id = '${ORG_A}';`)).toBe(0);
  });

  it("membro de A não atualiza nem apaga o ponteiro de B", () => {
    expect(writeCountAs(USER_A, `update public.ai_playbooks set name = 'invasao' where id = '${PB_B}'`)).toBe(0);
    expect(writeCountAs(USER_A, `delete from public.ai_playbooks where id = '${PB_B}'`)).toBe(0);
    expect(sql(`select name from public.ai_playbooks where id = '${PB_B}';`)).toBe("Comercial Outbound B");
  });

  it("papel: viewer da org LÊ o playbook mas NÃO cria, edita nem apaga; manager passa (par 0150)", () => {
    sql(`
      insert into auth.users (id, email) values ('${VIEWER_A}', 'ai-playbooks-viewer@invariant.test') on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${VIEWER_A}', '${ORG_A}', 'viewer', now()) on conflict do nothing;
    `);
    expect(countAs(VIEWER_A, `select count(*) from public.ai_playbooks where id = '${PB_A}';`)).toBe(1);
    expect(countAs(VIEWER_A, `select count(*) from public.ai_playbook_versions where playbook_id = '${PB_A}';`)).toBeGreaterThanOrEqual(1);
    expect(writeCountAs(VIEWER_A, `insert into public.ai_playbooks (organization_id, slug, name) values ('${ORG_A}', 'do_viewer', 'x')`)).toBe(0);
    expect(writeCountAs(VIEWER_A, `update public.ai_playbooks set name = 'sequestrado' where id = '${PB_A}'`)).toBe(0);
    expect(writeCountAs(VIEWER_A, `delete from public.ai_playbooks where id = '${PB_A}'`)).toBe(0);
    expect(sql(`select name from public.ai_playbooks where id = '${PB_A}';`)).toBe("Comercial Outbound");
    // O manager (USER_A) é quem já criou e editou o draft nos casos A e H — o lado positivo do par.
    expect(writeCountAs(USER_A, `update public.ai_playbooks set description = 'pelo manager' where id = '${PB_A}'`)).toBe(1);
  });

  it("membro de A não cria ponteiro EM B (with check)", () => {
    expect(
      writeCountAs(USER_A, `insert into public.ai_playbooks (organization_id, slug, name) values ('${ORG_B}', 'invasao', 'x')`),
    ).toBe(0);
  });

  it("K. publish cross-org é recusado pela própria função: org B com playbook de A → playbook_not_found", () => {
    const erro = falha(publicar(ORG_B, PB_A));
    expect(erro).toMatch(/playbook_not_found/);
    // E nada foi gravado.
    expect(sql(`select count(*) from public.ai_playbook_versions where playbook_id = '${PB_A}' and organization_id = '${ORG_B}';`)).toBe("0");
  });

  it("COERÊNCIA DE TENANT: versão com organization_id diferente do playbook é IMPOSSÍVEL pelo schema", () => {
    // Não depende da função de publish: é INSERT direto, como superusuário —
    // o caminho de um script administrativo ou de uma migração de dados.
    const erro = falha(
      `insert into public.ai_playbook_versions (organization_id, playbook_id, version_number, definition, definition_sha256)
         values ('${ORG_B}', '${PB_A}', 9001, ${DEF}, '${SHA}');`,
    );
    expect(erro).toMatch(/23503|ai_playbook_versions_organization_id_playbook_id_fkey|violates foreign key/);
    // Controle positivo: a MESMA linha com a org certa entra.
    expect(
      falha(
        `insert into public.ai_playbook_versions (organization_id, playbook_id, version_number, definition, definition_sha256)
           values ('${ORG_A}', '${PB_A}', 9001, ${DEF}, '${SHA}');`,
      ),
    ).toBeNull();
    sql(`delete from public.ai_playbook_versions where version_number = 9001;`);
  });

  it("e mover o playbook para outra org depois (UPDATE) também é impossível — é o FK que barra", () => {
    // Organização TERCEIRA, sem nenhum playbook com este slug: sem ela, o
    // UPDATE seria recusado pelo unique (organization_id, slug) e o teste
    // passaria sem nunca exercitar o FK que ele existe para provar.
    const ORG_C = "aaaaaaaa-7777-4000-8000-000000000003";
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_C}', 'ai-playbooks-c', 'AI Playbooks c', 'AI Playbooks c')
        on conflict (id) do nothing;
    `);
    const erro = falha(`update public.ai_playbooks set organization_id = '${ORG_C}' where id = '${PB_A}';`);
    expect(erro).toMatch(/violates foreign key|still referenced/);
    expect(erro).toMatch(/ai_playbook_versions_organization_id_playbook_id_fkey/);
    expect(sql(`select organization_id from public.ai_playbooks where id = '${PB_A}';`)).toBe(ORG_A);
  });

  it("FK composto: o ponteiro não consegue apontar para versão de OUTRO playbook (mesma org inclusive)", () => {
    sql(`insert into public.ai_playbooks (id, organization_id, slug, name) values ('${PB_A2}', '${ORG_A}', 'segundo', 'Segundo') on conflict (id) do nothing;`);
    const versaoDeA = sql(`select published_version_id from public.ai_playbooks where id = '${PB_A}';`);
    const erro = falha(
      `update public.ai_playbooks set status = 'published', published_version_id = '${versaoDeA}' where id = '${PB_A2}';`,
    );
    expect(erro).toMatch(/23503|ai_playbooks_published_version_fkey/);
  });
});

// ─── L — service only ─────────────────────────────────────────────────────────

describe("fn_publish_ai_playbook_version — só o service role executa", () => {
  it("L. anon e authenticated não têm EXECUTE (nem por PUBLIC, nem por grant direto)", () => {
    const priv = sql(`
      select has_function_privilege('anon', 'public.fn_publish_ai_playbook_version(uuid,uuid,jsonb,text,uuid,text)', 'execute')
          || '|' || has_function_privilege('authenticated', 'public.fn_publish_ai_playbook_version(uuid,uuid,jsonb,text,uuid,text)', 'execute')
          || '|' || has_function_privilege('service_role', 'public.fn_publish_ai_playbook_version(uuid,uuid,jsonb,text,uuid,text)', 'execute');
    `);
    expect(priv).toBe("false|false|true");
  });

  it("L'. chamada sob role authenticated (membro legítimo da org) é negada — o caminho é a rota com admin", () => {
    const erro = falha(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
      ${publicar(ORG_A, PB_A)}
    `);
    expect(erro).toMatch(/42501|permission denied/);
  });

  it("é security definer com search_path fixo", () => {
    const linha = sql(`
      select p.prosecdef, array_to_string(p.proconfig, ',')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fn_publish_ai_playbook_version';
    `);
    expect(linha).toMatch(/^t\|search_path=public/);
  });
});

// ─── N — sem autonomia; catálogo ─────────────────────────────────────────────

describe("o playbook não carrega nível de autonomia", () => {
  it("N. nenhuma coluna de modo/autonomia/aprovação em ai_playbooks nem em ai_playbook_versions", () => {
    const colunas = sql(`
      select string_agg(table_name || '.' || column_name, ',' order by table_name, column_name)
        from information_schema.columns
       where table_schema = 'public' and table_name in ('ai_playbooks', 'ai_playbook_versions');
    `);
    expect(colunas).not.toMatch(/mode|assisted|automatic|auto_send|approval|execution|autonomy/i);
    // E o que EXISTE é exatamente o desenho (para a regressão por coluna nova ser deliberada).
    expect(colunas).toBe(
      [
        "ai_playbook_versions.created_at", "ai_playbook_versions.created_by", "ai_playbook_versions.definition",
        "ai_playbook_versions.definition_sha256", "ai_playbook_versions.id", "ai_playbook_versions.notes",
        "ai_playbook_versions.organization_id", "ai_playbook_versions.playbook_id", "ai_playbook_versions.version_number",
        "ai_playbooks.archived_at", "ai_playbooks.created_at", "ai_playbooks.created_by", "ai_playbooks.description",
        "ai_playbooks.draft", "ai_playbooks.id", "ai_playbooks.metadata", "ai_playbooks.name", "ai_playbooks.organization_id",
        "ai_playbooks.published_at", "ai_playbooks.published_version_id", "ai_playbooks.slug", "ai_playbooks.status",
        "ai_playbooks.updated_at",
      ].join(","),
    );
  });

  it("RLS ligada nas duas tabelas, com a policy de tenant presente", () => {
    const rls = sql(`
      select c.relname || '=' || c.relrowsecurity::text
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('ai_playbooks','ai_playbook_versions') order by c.relname;
    `);
    expect(rls).toBe("ai_playbook_versions=true\nai_playbooks=true");
    const policies = sql(`
      select tablename || ':' || policyname || ':' || cmd from pg_policies
       where schemaname = 'public' and tablename in ('ai_playbooks','ai_playbook_versions')
         and policyname not like 'support_write_%' order by 1;
    `);
    // Formato 0150/0181: leitura para membros; escrita `for all` COM fn_role_at_least
    // (o gate `rbac-config-ia-canais` reprova tabela nova com ALL só-tenancy).
    expect(policies).toBe(
      [
        "ai_playbook_versions:tenant_isolation_ai_playbook_versions_select:SELECT",
        "ai_playbooks:tenant_isolation_ai_playbooks_select:SELECT",
        "ai_playbooks:tenant_isolation_ai_playbooks_write:ALL",
      ].join("\n"),
    );
    const escritaComPapel = sql(`
      select (coalesce(qual,'') || coalesce(with_check,'')) like '%role_at_least%'
        from pg_policies where schemaname = 'public' and policyname = 'tenant_isolation_ai_playbooks_write';
    `);
    expect(escritaComPapel).toBe("t");
  });

  it("a cerca da sessão de suporte cobre as duas tabelas (3 policies restritivas cada)", () => {
    // O enumerador global roda ANTES deste apêndice, então só alcança as
    // tabelas do dump: sem a declaração explícita da 0233, estas duas ficavam
    // sem cerca num install FRESCO (medido) e ganhavam-na só no update — um
    // admin em suporte SOMENTE LEITURA escreveria no playbook do cliente.
    const cerca = sql(`
      select c.relname || '=' || (select count(*) from pg_policy p
             where p.polrelid = c.oid and not p.polpermissive and p.polname like 'support_write_%')
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('ai_playbooks','ai_playbook_versions') order by c.relname;
    `);
    expect(cerca).toBe("ai_playbook_versions=3\nai_playbooks=3");
  });
});

// ─── ciclo de vida ────────────────────────────────────────────────────────────

describe("ciclo de vida", () => {
  it("publish em playbook ARQUIVADO é recusado (playbook_archived)", () => {
    sql(`update public.ai_playbooks set status = 'archived', archived_at = now() where id = '${PB_A2}';`);
    expect(falha(publicar(ORG_A, PB_A2))).toMatch(/playbook_archived/);
  });

  it("apagar o ponteiro apaga as versões em cascata — o ciclo de FKs não prende a purga de organização", () => {
    const antes = Number(sql(`select count(*) from public.ai_playbook_versions where playbook_id = '${PB_B}';`));
    expect(antes).toBeGreaterThanOrEqual(1);
    expect(falha(`delete from public.ai_playbooks where id = '${PB_B}';`)).toBeNull();
    expect(sql(`select count(*) from public.ai_playbook_versions where playbook_id = '${PB_B}';`)).toBe("0");
  });
});

// ─── O — published_version_id × max(version_number) ──────────────────────────
//
// Duas RÉGUAS, e a diferença entre elas é o que este bloco congela.
//
// `version_number` é a ordem em que se publicou; `published_version_id` é o que
// está NO AR. O schema não as amarra: mover o ponteiro para uma versão de número
// MENOR é uma atualização legítima, que as FKs aceitam — e é exatamente o que um
// rollback faz, porque rollback aqui é mover o ponteiro, nunca apagar versão.
//
// ⚠️ O QUE ESTE BLOCO NÃO PROVA: que `lib/playbooks/carregador.ts` lê pelo
// ponteiro. Ele não passa por uma linha de TypeScript do produto — fala com o
// Postgres por `docker exec psql`, como todo este arquivo. O que ele estabelece
// é a PREMISSA: que o estado "ponteiro em versão não-máxima" existe e é válido
// no banco. Quem cobre o lado do código é `lib/playbooks/carregador.test.ts`
// (algoritmo e chamadas, com cliente falso), e a fronteira entre os dois — o
// loader contra um PostgREST real — segue aberta e declarada.

describe("published_version_id é o ponteiro, e não o máximo", () => {
  const PB_ROLL = "aaaaaaaa-7779-4000-8000-000000000004";
  let v1 = "";
  let v2 = "";

  it("prepara: um playbook próprio com v1 e v2 publicadas, nesta ordem", () => {
    sql(
      `insert into public.ai_playbooks (id, organization_id, slug, name)
         values ('${PB_ROLL}', '${ORG_A}', 'com_rollback', 'Com Rollback') on conflict (id) do nothing;`,
    );
    v1 = lastLine(sql(publicar(ORG_A, PB_ROLL, { sha: SHA }))).split("|")[0]!;
    v2 = lastLine(sql(publicar(ORG_A, PB_ROLL, { sha: SHA2 }))).split("|")[0]!;
    expect(v1).toMatch(/^[0-9a-f-]{36}$/);
    expect(v2).not.toBe(v1);
    // Logo após publicar, ponteiro e máximo coincidem — é a coincidência que o
    // resto deste bloco desfaz. Enquanto elas batem, ler por um ou por outro dá
    // o mesmo resultado, e é por isso que a diferença passa despercebida.
    const linha = sql(
      `select p.published_version_id = '${v2}', v.version_number
         from public.ai_playbooks p join public.ai_playbook_versions v on v.id = p.published_version_id
        where p.id = '${PB_ROLL}';`,
    );
    expect(linha).toBe("t|2");
  });

  it("O. mover o ponteiro para a versão de número MENOR é aceito pelo schema", () => {
    const erro = falha(
      `update public.ai_playbooks set published_version_id = '${v1}' where id = '${PB_ROLL}' and organization_id = '${ORG_A}';`,
    );
    expect(erro).toBeNull();
  });

  it("O'. depois do movimento: ponteiro em v1, v2 intacta, máximo ainda 2", () => {
    const estado = sql(`
      select
        (select published_version_id from public.ai_playbooks where id = '${PB_ROLL}') = '${v1}',
        (select count(*) from public.ai_playbook_versions where id = '${v2}'),
        (select max(version_number) from public.ai_playbook_versions where playbook_id = '${PB_ROLL}'),
        (select version_number from public.ai_playbook_versions
           where id = (select published_version_id from public.ai_playbooks where id = '${PB_ROLL}')),
        (select status from public.ai_playbooks where id = '${PB_ROLL}');
    `);
    // ponteiro=v1 | v2 existe | max=2 | número da publicada=1 | status segue published
    expect(estado).toBe("t|1|2|1|published");
  });

  it("O''. a FK do ponteiro continua ARMADA neste estado, não apenas satisfeita", () => {
    // Que o UPDATE acima passou prova que a FK o aceitou. Isto prova o outro
    // lado: ela continua recusando o que sempre recusou. Sem esta asserção o
    // bloco seria compatível com uma FK que simplesmente parou de vigiar.
    const versaoDeOutro = sql(
      `select id from public.ai_playbook_versions where playbook_id = '${PB_A}' order by version_number limit 1;`,
    );
    const erro = falha(
      `update public.ai_playbooks set published_version_id = '${versaoDeOutro}' where id = '${PB_ROLL}';`,
    );
    expect(erro).toMatch(/23503|violates foreign key/);
    // E o estado não se mexeu com a tentativa recusada.
    expect(sql(`select published_version_id = '${v1}' from public.ai_playbooks where id = '${PB_ROLL}';`)).toBe("t");
  });

  it("O'''. e a versão de número maior, não apontada, segue imutável e legível", () => {
    expect(falha(`update public.ai_playbook_versions set notes = 'adulterado' where id = '${v2}';`)).toMatch(
      /imutável|P0001/,
    );
    expect(sql(`select definition_sha256 from public.ai_playbook_versions where id = '${v2}';`)).toBe(SHA2);
  });
});
