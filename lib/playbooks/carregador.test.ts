/**
 * O loader — o que ele PERGUNTA ao banco, com quais filtros, e em que ordem.
 *
 * O Supabase falso aplica os `eq` DE VERDADE e registra cada consulta. É o que
 * torna "não vaza entre organizações" uma MEDIÇÃO e não uma afirmação: as
 * linhas da outra organização estão na fixtura, e só não voltam porque o
 * loader filtrou — não porque o falso as escondeu.
 *
 * ─── A fronteira desta camada, dita sem maquiagem ───────────────────────────
 *
 * Isto prova o ALGORITMO e as CHAMADAS. Não prova que o PostgREST aceita estas
 * consultas, nem que a RLS as autoriza — nenhum Postgres roda aqui. Quem prova
 * schema/RLS/FK é `tests/invariants/ai-playbooks-schema.test.ts`, por um driver
 * `psql` que NÃO passa por este arquivo. A fronteira entre as duas fica aberta
 * até haver um teste do loader contra PostgREST real (fora da Fase C).
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { carregarPlaybookPublicado } from "./carregador";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const OUTRA_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const PB = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const PB_ALHEIO = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
const V1 = "cccccccc-cccc-4ccc-8ccc-000000000001";
const V2 = "cccccccc-cccc-4ccc-8ccc-000000000002";
const V_ALHEIA = "cccccccc-cccc-4ccc-8ccc-000000000009";
const SHA = "a".repeat(64);

type Linha = Record<string, unknown>;
interface Consulta {
  tabela: string;
  colunas: string;
  filtros: Record<string, unknown>;
}
interface Tabelas {
  ai_playbooks: Linha[];
  ai_playbook_versions: Linha[];
}

let tabelas: Tabelas;
let consultas: Consulta[];
/** Tabela → erro a devolver, para provar os dois estágios de `database_error`. */
let erros: Partial<Record<keyof Tabelas, string>>;

function clienteFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let colunas = "";
      const cadeia = {
        select: (c: string) => {
          colunas = c;
          return cadeia;
        },
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return cadeia;
        },
        maybeSingle: async () => {
          consultas.push({ tabela, colunas, filtros });
          const erro = erros[tabela as keyof Tabelas];
          if (erro) return { data: null, error: { message: erro } };
          const linhas = (tabelas[tabela as keyof Tabelas] ?? []).filter((l) =>
            Object.entries(filtros).every(([k, v]) => l[k] === v),
          );
          return { data: linhas[0] ?? null, error: null };
        },
      };
      return cadeia;
    },
  };
}

const ler = (slug: string, org = ORG) => carregarPlaybookPublicado(clienteFalso() as never, org, slug);

beforeEach(() => {
  consultas = [];
  erros = {};
  tabelas = {
    ai_playbooks: [
      // Publicado, e o ponteiro aponta para a versão de número MENOR (v1),
      // com uma v2 existindo: é o cenário de rollback, e é o que separa
      // "ler pelo ponteiro" de "ler pelo máximo".
      { id: PB, organization_id: ORG, slug: "afb_comercial", status: "published", published_version_id: V1 },
      { id: "pb-draft", organization_id: ORG, slug: "so_rascunho", status: "draft", published_version_id: null },
      { id: "pb-arq", organization_id: ORG, slug: "arquivado", status: "archived", published_version_id: V1 },
      {
        id: "pb-orfao",
        organization_id: ORG,
        slug: "orfao",
        status: "published",
        published_version_id: "dddddddd-dddd-4ddd-8ddd-000000000000",
      },
      // Mesmo slug em OUTRA organização — a armadilha que o filtro tem de barrar.
      { id: PB_ALHEIO, organization_id: OUTRA_ORG, slug: "afb_comercial", status: "published", published_version_id: V_ALHEIA },
    ],
    ai_playbook_versions: [
      { id: V1, organization_id: ORG, playbook_id: PB, version_number: 1, definition: { schema_version: 1 }, definition_sha256: SHA },
      {
        id: V2,
        organization_id: ORG,
        playbook_id: PB,
        version_number: 2,
        definition: { schema_version: 1 },
        definition_sha256: "b".repeat(64),
      },
      {
        id: V_ALHEIA,
        organization_id: OUTRA_ORG,
        playbook_id: PB_ALHEIO,
        version_number: 7,
        definition: { schema_version: 1 },
        definition_sha256: "c".repeat(64),
      },
    ],
  };
});

describe("carregarPlaybookPublicado — o caminho feliz", () => {
  it("devolve a versão APONTADA pelo ponteiro, não a de maior número", async () => {
    const r = await ler("afb_comercial");
    expect(r).toEqual({
      tipo: "found",
      playbookId: PB,
      slug: "afb_comercial",
      publishedVersionId: V1,
      versionNumber: 1,
      definition: { schema_version: 1 },
      definitionSha256: SHA,
    });
    // A v2 existe e tem número maior. Se o loader lesse pelo máximo, este
    // teste devolveria a v2 — é exatamente a regressão que ele vigia.
    expect((r as { publishedVersionId: string }).publishedVersionId).not.toBe(V2);
  });

  it("faz DUAS consultas, nesta ordem, e filtra organization_id nas DUAS", async () => {
    await ler("afb_comercial");
    expect(consultas).toHaveLength(2);
    expect(consultas[0]!.tabela).toBe("ai_playbooks");
    expect(consultas[0]!.filtros).toEqual({ organization_id: ORG, slug: "afb_comercial" });
    expect(consultas[1]!.tabela).toBe("ai_playbook_versions");
    expect(consultas[1]!.filtros).toEqual({ organization_id: ORG, id: V1 });
    for (const c of consultas) expect(c.filtros.organization_id).toBe(ORG);
  });

  it("a versão é buscada por id — nunca por playbook + ordenação", async () => {
    await ler("afb_comercial");
    expect(Object.keys(consultas[1]!.filtros).sort()).toEqual(["id", "organization_id"]);
  });

  it("não pede a definição na consulta do ponteiro (o draft não é lido)", async () => {
    await ler("afb_comercial");
    expect(consultas[0]!.colunas).not.toContain("draft");
    expect(consultas[0]!.colunas).not.toContain("definition");
  });
});

describe("carregarPlaybookPublicado — isolamento entre organizações", () => {
  it("o mesmo slug em outra organização não é alcançado", async () => {
    const r = await ler("afb_comercial", ORG);
    expect((r as { playbookId: string }).playbookId).toBe(PB);
    expect((r as { playbookId: string }).playbookId).not.toBe(PB_ALHEIO);
  });

  it("uma organização sem o playbook recebe missing, não o da vizinha", async () => {
    const semNada = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003";
    expect(await ler("afb_comercial", semNada)).toEqual({ tipo: "missing", motivo: "pointer_absent" });
  });

  it("a versão de outra org não é servida nem quando o id é alcançado pelo ponteiro", async () => {
    tabelas.ai_playbooks.push({
      id: "pb-apontando-fora",
      organization_id: ORG,
      slug: "aponta_fora",
      status: "published",
      published_version_id: V_ALHEIA,
    });
    // O id existe — mas é de OUTRA organização, e o filtro da segunda consulta
    // é o que o mantém fora. Sem ele isto devolveria a definição da vizinha.
    expect(await ler("aponta_fora")).toEqual({ tipo: "missing", motivo: "version_row_missing" });
  });
});

describe("carregarPlaybookPublicado — ausências, cada uma com nome próprio", () => {
  it("pointer_absent quando não há linha para (org, slug)", async () => {
    expect(await ler("nao_existe")).toEqual({ tipo: "missing", motivo: "pointer_absent" });
  });

  it("not_published quando o ponteiro é rascunho", async () => {
    expect(await ler("so_rascunho")).toEqual({ tipo: "missing", motivo: "not_published" });
  });

  it("archived vence published_version_id preenchido", async () => {
    expect(await ler("arquivado")).toEqual({ tipo: "missing", motivo: "archived" });
  });

  it("version_row_missing quando o ponteiro aponta para versão inexistente", async () => {
    expect(await ler("orfao")).toEqual({ tipo: "missing", motivo: "version_row_missing" });
  });

  it("not_published quando published_version_id não é um id utilizável", async () => {
    tabelas.ai_playbooks.push({
      id: "pb-torto",
      organization_id: ORG,
      slug: "torto",
      status: "published",
      published_version_id: 42,
    });
    expect(await ler("torto")).toEqual({ tipo: "missing", motivo: "not_published" });
  });

  it("ausência NUNCA dispara a segunda consulta", async () => {
    await ler("so_rascunho");
    expect(consultas).toHaveLength(1);
  });
});

describe("carregarPlaybookPublicado — erro de banco, com o estágio nomeado", () => {
  it("erro no ponteiro é database_error/pointer e não consulta a versão", async () => {
    erros.ai_playbooks = "conexão caiu";
    expect(await ler("afb_comercial")).toEqual({ tipo: "database_error", etapa: "pointer", mensagem: "conexão caiu" });
    expect(consultas).toHaveLength(1);
  });

  it("erro na versão é database_error/version", async () => {
    erros.ai_playbook_versions = "timeout";
    expect(await ler("afb_comercial")).toEqual({ tipo: "database_error", etapa: "version", mensagem: "timeout" });
  });

  it("nenhum caso lança — quem chama recebe a lista, não uma exceção", async () => {
    erros.ai_playbooks = "boom";
    await expect(ler("afb_comercial")).resolves.toBeDefined();
  });
});

describe("carregarPlaybookPublicado — regras vigiadas no FONTE", () => {
  const fonte = fs.readFileSync(path.join(process.cwd(), "lib/playbooks/carregador.ts"), "utf8");
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("não ordena, não limita e não tira máximo de version_number", () => {
    expect(codigo).not.toMatch(/\.order\(/);
    expect(codigo).not.toMatch(/\.limit\(/);
    expect(codigo).not.toMatch(/max\(/i);
  });

  it("o genérico não conhece cliente nenhum: nada de lib/afb", () => {
    expect(fonte).not.toMatch(/from\s+"@\/lib\/afb/);
    expect(fonte).not.toMatch(/from\s+"\.\.\/afb/);
  });

  it("nunca service role: o cliente vem de quem chama, e é o de sessão", () => {
    expect(codigo).not.toContain("createAdminClient");
    expect(codigo).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("usa maybeSingle: ausência legítima é dado, não exceção", () => {
    expect(codigo).toContain(".maybeSingle()");
    expect(codigo).not.toMatch(/\.single\(\)/);
  });

  it("não escreve nada", () => {
    for (const escrita of ["insert(", "update(", "upsert(", "delete(", ".rpc("]) {
      expect(codigo).not.toContain(escrita);
    }
  });
});
