/**
 * O bootstrap do playbook AFB contra o SCHEMA REAL (Fase B).
 *
 * Os testes de unidade (`lib/afb/provisionamento/provisionador.test.ts`) provam
 * o PLANO com um repositório falso. Este arquivo prova o que só o banco pode
 * responder: que a definição do adaptador cabe no `jsonb`, que a RPC numera as
 * versões, que o segundo e o terceiro apply não criam v2, que o conflito não
 * escreve, e que duas organizações convivem com o mesmo slug.
 *
 * O driver abaixo fala com o Postgres efêmero por `docker exec psql` — o mesmo
 * caminho dos outros invariantes — e implementa a MESMA interface que o
 * provisionador consome. Ele não substitui o repositório Supabase (esse é
 * coberto por unidade com cliente falso): o que se prova aqui é o algoritmo
 * inteiro contra as constraints e a função reais.
 *
 * Zero PII: ids sintéticos e e-mails @invariant.test.
 */
import { describe, expect, it, beforeAll } from "vitest";

import { AFB_COMERCIAL_V1 } from "@/lib/afb/playbooks/comercial";
import { AFB_PLAYBOOK_PERSISTIDO } from "@/lib/afb/provisionamento/configuracao";
import { playbookPlan, type ExistingPlaybookRef } from "@/lib/afb/provisionamento/provisionador";
import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";
import { deRegistryParaDefinicao } from "@/lib/playbooks/adaptador-afb";

import { sql } from "./gov-helpers";

const ORG_A = "bbbbbbbb-1111-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-1111-4000-8000-000000000002";

const { definition: DEFINICAO, sha256: SHA } = deRegistryParaDefinicao(AFB_COMERCIAL_V1);
const SLUG = AFB_PLAYBOOK_PERSISTIDO.slug;

/** Literal SQL de um jsonb, com aspas simples escapadas. */
function jsonb(valor: unknown): string {
  return `'${JSON.stringify(valor).replaceAll("'", "''")}'::jsonb`;
}

const METADATA = { afb_bootstrap: { key: SLUG, legacy_playbook_id: AFB_PLAYBOOK_PERSISTIDO.legacyId, source: "afb-provision" } };

/** O estado do playbook desta organização, na forma que o plano consome. */
function lerPlaybook(org: string): ExistingPlaybookRef | null {
  const linha = sql(`
    select coalesce(
      (select p.id || '|' || p.slug || '|' || p.name || '|' || p.status
              || '|' || coalesce(p.metadata->'afb_bootstrap'->>'key', '')
              || '|' || coalesce(p.published_version_id::text, '')
              || '|' || coalesce((select v.definition_sha256 from public.ai_playbook_versions v where v.id = p.published_version_id), '')
              || '|' || coalesce((select v.version_number::text from public.ai_playbook_versions v where v.id = p.published_version_id), '')
              || '|' || coalesce(p.draft::text, '')
         from public.ai_playbooks p
        where p.organization_id = '${org}' and p.slug = '${SLUG}'), 'AUSENTE');
  `);
  if (linha === "AUSENTE") return null;
  const [id, slug, name, status, key, versionId, sha, numero, draft] = linha.split("|");
  return {
    id: id!,
    slug: slug!,
    name: name!,
    status: status!,
    bootstrapKey: key ? key : null,
    publishedVersionId: versionId ? versionId : null,
    publishedVersionSha256: sha ? sha : null,
    publishedVersionNumber: numero ? Number(numero) : null,
    draftSha256: draft ? canonicalHash(JSON.parse(draft) as unknown) : null,
  };
}

/**
 * Uma rodada de `afb:provision` restrita ao playbook: planeja a partir do que
 * está no banco e executa a ação pelos MESMOS caminhos do repositório real
 * (insert do ponteiro + RPC de publish; adoção só grava a marca).
 */
function rodarBootstrap(org: string): { action: string; reason: string } {
  const plano = playbookPlan(lerPlaybook(org), SHA, SLUG);
  if (plano.action === "create") {
    sql(`
      insert into public.ai_playbooks (organization_id, slug, name, description, draft, metadata)
        values ('${org}', '${SLUG}', '${AFB_PLAYBOOK_PERSISTIDO.name}', 'bootstrap', ${jsonb(DEFINICAO)}, ${jsonb(METADATA)});
      select version_number from public.fn_publish_ai_playbook_version(
        '${org}',
        (select id from public.ai_playbooks where organization_id = '${org}' and slug = '${SLUG}'),
        ${jsonb(DEFINICAO)}, '${SHA}', null, 'bootstrap afb:provision');
    `);
  } else if (plano.action === "publish") {
    sql(`
      select version_number from public.fn_publish_ai_playbook_version(
        '${org}',
        (select id from public.ai_playbooks where organization_id = '${org}' and slug = '${SLUG}'),
        ${jsonb(DEFINICAO)}, '${SHA}', null, 'bootstrap afb:provision');
    `);
  } else if (plano.action === "adopt") {
    sql(`
      update public.ai_playbooks
         set metadata = metadata || ${jsonb(METADATA)}
       where organization_id = '${org}' and slug = '${SLUG}';
    `);
  }
  return plano;
}

const contar = (org: string) => ({
  ponteiros: Number(sql(`select count(*) from public.ai_playbooks where organization_id = '${org}' and slug = '${SLUG}';`)),
  versoes: Number(
    sql(`select count(*) from public.ai_playbook_versions v join public.ai_playbooks p on p.id = v.playbook_id
           where p.organization_id = '${org}' and p.slug = '${SLUG}';`),
  ),
});

beforeAll(() => {
  for (const [org, tag] of [[ORG_A, "a"], [ORG_B, "b"]] as const) {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${org}', 'afb-bootstrap-${tag}', 'AFB Bootstrap ${tag}', 'AFB Bootstrap ${tag}')
        on conflict (id) do nothing;
    `);
  }
});

describe("CASO 1/2/3 — idempotência do bootstrap contra o schema real", () => {
  it("1º apply: cria exatamente 1 ponteiro e 1 versão, numerada 1, com o sha do adaptador", () => {
    expect(rodarBootstrap(ORG_A).action).toBe("create");
    expect(contar(ORG_A)).toEqual({ ponteiros: 1, versoes: 1 });
    const estado = lerPlaybook(ORG_A)!;
    expect(estado.publishedVersionNumber).toBe(1);
    expect(estado.publishedVersionSha256).toBe(SHA);
    expect(estado.status).toBe("published");
    // O draft foi consumido pela publicação (contrato da Fase A).
    expect(estado.draftSha256).toBeNull();
  });

  it("a definição gravada é EXATAMENTE a do adaptador (ida e volta pelo jsonb)", () => {
    const gravada = sql(`
      select v.definition::text from public.ai_playbook_versions v
        join public.ai_playbooks p on p.id = v.playbook_id
       where p.organization_id = '${ORG_A}' and p.slug = '${SLUG}' and v.version_number = 1;
    `);
    const voltou = JSON.parse(gravada) as unknown;
    expect(canonicalHash(voltou)).toBe(SHA);
    expect(voltou).toEqual(JSON.parse(JSON.stringify(DEFINICAO)));
  });

  it("2º apply: unchanged — continua 1 ponteiro e 1 versão, sem v2", () => {
    expect(rodarBootstrap(ORG_A).action).toBe("unchanged");
    expect(contar(ORG_A)).toEqual({ ponteiros: 1, versoes: 1 });
  });

  it("3º apply: unchanged de novo", () => {
    expect(rodarBootstrap(ORG_A).action).toBe("unchanged");
    expect(contar(ORG_A)).toEqual({ ponteiros: 1, versoes: 1 });
    expect(lerPlaybook(ORG_A)!.publishedVersionNumber).toBe(1);
  });
});

describe("CASO 5 — multi-organização", () => {
  it("a org B usa o MESMO slug, com ponteiro e versão próprios", () => {
    expect(rodarBootstrap(ORG_B).action).toBe("create");
    expect(contar(ORG_B)).toEqual({ ponteiros: 1, versoes: 1 });
    const a = lerPlaybook(ORG_A)!;
    const b = lerPlaybook(ORG_B)!;
    expect(b.id).not.toBe(a.id);
    expect(b.publishedVersionId).not.toBe(a.publishedVersionId);
    // Mesmo conteúdo, versões independentes: cada organização tem a sua v1.
    expect(b.publishedVersionSha256).toBe(a.publishedVersionSha256);
    expect(b.publishedVersionNumber).toBe(1);
  });

  it("o bootstrap de uma organização não mexe na outra", () => {
    const antes = lerPlaybook(ORG_B)!;
    expect(rodarBootstrap(ORG_A).action).toBe("unchanged");
    expect(lerPlaybook(ORG_B)).toEqual(antes);
  });
});

describe("CASO 4/7 — conflito não sobrescreve", () => {
  it("versão publicada com outro sha ⇒ conflict, nenhuma v2 criada, conteúdo humano intacto", () => {
    // Uma publicação "humana" com conteúdo diferente, pela MESMA RPC.
    const outra = { schema_version: 1, meta: {}, stages: [{ id: "humano", label: "Editado por gente", order: 1, kind: "sequence" }] };
    sql(`
      select version_number from public.fn_publish_ai_playbook_version(
        '${ORG_B}',
        (select id from public.ai_playbooks where organization_id = '${ORG_B}' and slug = '${SLUG}'),
        ${jsonb(outra)}, '${canonicalHash(outra)}', null, 'edição humana');
    `);
    expect(contar(ORG_B)).toEqual({ ponteiros: 1, versoes: 2 });

    const plano = rodarBootstrap(ORG_B);
    expect(plano.action).toBe("conflict");
    expect(contar(ORG_B)).toEqual({ ponteiros: 1, versoes: 2 });
    const estado = lerPlaybook(ORG_B)!;
    expect(estado.publishedVersionNumber).toBe(2);
    expect(estado.publishedVersionSha256).toBe(canonicalHash(outra));
  });
});

describe("CASO 6 — falha parcial: ponteiro criado, publish não aconteceu", () => {
  const ORG_C = "bbbbbbbb-1111-4000-8000-000000000003";

  it("o provisionador seguinte conclui o publish, sem criar um segundo ponteiro", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_C}', 'afb-bootstrap-c', 'AFB Bootstrap c', 'AFB Bootstrap c') on conflict (id) do nothing;
      insert into public.ai_playbooks (organization_id, slug, name, description, draft, metadata)
        values ('${ORG_C}', '${SLUG}', '${AFB_PLAYBOOK_PERSISTIDO.name}', 'bootstrap', ${jsonb(DEFINICAO)}, ${jsonb(METADATA)});
    `);
    expect(contar(ORG_C)).toEqual({ ponteiros: 1, versoes: 0 });

    expect(rodarBootstrap(ORG_C).action).toBe("publish");
    expect(contar(ORG_C)).toEqual({ ponteiros: 1, versoes: 1 });
    expect(lerPlaybook(ORG_C)!.publishedVersionNumber).toBe(1);

    // E a rodada seguinte já é unchanged.
    expect(rodarBootstrap(ORG_C).action).toBe("unchanged");
    expect(contar(ORG_C)).toEqual({ ponteiros: 1, versoes: 1 });
  });
});

describe("adoção — registro humano equivalente", () => {
  const ORG_D = "bbbbbbbb-1111-4000-8000-000000000004";

  it("mesmo slug, sem marca, com versão publicada IDÊNTICA: adota preservando id e versão", () => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_D}', 'afb-bootstrap-d', 'AFB Bootstrap d', 'AFB Bootstrap d') on conflict (id) do nothing;
      insert into public.ai_playbooks (organization_id, slug, name, description, draft)
        values ('${ORG_D}', '${SLUG}', 'Nome escolhido por gente', 'humano', ${jsonb(DEFINICAO)});
      select version_number from public.fn_publish_ai_playbook_version(
        '${ORG_D}',
        (select id from public.ai_playbooks where organization_id = '${ORG_D}' and slug = '${SLUG}'),
        ${jsonb(DEFINICAO)}, '${SHA}', null, 'publicado por gente');
    `);
    const antes = lerPlaybook(ORG_D)!;
    expect(antes.bootstrapKey).toBeNull();

    expect(rodarBootstrap(ORG_D).action).toBe("adopt");
    const depois = lerPlaybook(ORG_D)!;
    expect(depois.id).toBe(antes.id);
    expect(depois.publishedVersionId).toBe(antes.publishedVersionId);
    expect(depois.name).toBe("Nome escolhido por gente"); // o nome humano não é reescrito
    expect(depois.bootstrapKey).toBe(SLUG);
    expect(contar(ORG_D)).toEqual({ ponteiros: 1, versoes: 1 });

    // Adotado, a rodada seguinte é unchanged.
    expect(rodarBootstrap(ORG_D).action).toBe("unchanged");
    expect(contar(ORG_D)).toEqual({ ponteiros: 1, versoes: 1 });
  });
});

describe("CASO 8 — nada disto encosta no binding do funil", () => {
  it("o bootstrap do playbook não escreve binding nenhum em crm_pipelines", () => {
    // A organização NASCE com funil padrão (trigger do produto) — contar zero
    // funis mediria o seeding, não o bootstrap. O que este caso prova é que
    // nenhum funil ganhou o módulo do copiloto por causa desta fase: o binding
    // continua sendo assunto do apply completo, com o id LEGADO.
    const comModulo = sql(`
      select count(*) from public.crm_pipelines
       where organization_id in ('${ORG_A}','${ORG_B}')
         and settings -> 'modulos' -> 'copiloto_comercial' is not null;
    `);
    expect(comModulo).toBe("0");
    // Controle positivo: os funis padrão existem, então o zero acima é sobre o
    // módulo e não sobre uma tabela vazia.
    expect(
      Number(sql(`select count(*) from public.crm_pipelines where organization_id in ('${ORG_A}','${ORG_B}');`)),
    ).toBeGreaterThan(0);
  });

  it("o playbook persistido não tem coluna nem conteúdo de autonomia", () => {
    const definicao = sql(`
      select v.definition::text from public.ai_playbook_versions v
        join public.ai_playbooks p on p.id = v.playbook_id
       where p.organization_id = '${ORG_A}' and p.slug = '${SLUG}' and v.version_number = 1;
    `);
    expect(definicao).not.toMatch(/"(mode|assisted|automatic|auto_send|approval_mode|autonomy_mode|require_human_approval)"/);
  });
});
