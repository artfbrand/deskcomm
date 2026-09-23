/**
 * O shadow: os cinco status, a precedência inteira, a cadência, os caches e a
 * promessa de não vazar conteúdo.
 *
 * O relógio é falso (`toFake: ["Date"]`, sem mexer em timers), então a cadência
 * é MEDIDA e não esperada em tempo real — e o módulo de produção usa
 * `Date.now()` direto, sem costura de injeção existindo só para o teste.
 * O Supabase falso serve as duas tabelas e conta as consultas — é assim que a
 * eficácia de cada cache vira observação em vez de promessa.
 *
 * ─── Fronteira ─────────────────────────────────────────────────────────────
 *
 * Isto prova a REGRA. Não prova banco: quem responde por schema, RLS e FK é
 * `tests/invariants/ai-playbooks-schema.test.ts`, por outro caminho.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";
import { logger } from "@/lib/logger";

import {
  JANELA_DE_OBSERVACAO_MS,
  limparCachesDoShadow,
  observarPlaybookEmShadow,
  type PlaybookShadowObservation,
  type PlaybookShadowResult,
} from "./shadow";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const PB = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const V1 = "cccccccc-cccc-4ccc-8ccc-000000000001";
const SLUG = "afb_comercial";
const ID_LEGADO = "afb_comercial_v1";

/** Uma copy plantada: se ela aparecer no resultado, o vazamento está provado. */
const COPY_SECRETA = "TEXTO-COMERCIAL-QUE-NAO-PODE-VAZAR";

const DEF_VALIDA = {
  schema_version: 1,
  meta: {},
  stages: [
    {
      id: "abertura",
      label: "Abertura",
      order: 1,
      kind: "sequence",
      messages: [{ id: "abertura.primary", channel: "whatsapp", text: COPY_SECRETA }],
    },
  ],
};

/** Mesmo JSON, chaves em OUTRA ordem — o que o `jsonb` faz na ida-e-volta. */
const DEF_VALIDA_DESORDENADA = {
  stages: [
    {
      kind: "sequence",
      messages: [{ text: COPY_SECRETA, channel: "whatsapp", id: "abertura.primary" }],
      order: 1,
      label: "Abertura",
      id: "abertura",
    },
  ],
  meta: {},
  schema_version: 1,
};

/** Objeto JSON legítimo que o schema recusa: `id` de etapa fora do regex. */
const DEF_INVALIDA = {
  schema_version: 1,
  meta: {},
  stages: [{ id: "Abertura-Maiuscula", label: "Abertura", order: 1, kind: "sequence" }],
};

const SHA_VALIDA = canonicalHash(DEF_VALIDA);
const SHA_INVALIDA = canonicalHash(DEF_INVALIDA);
const SHA_OUTRO = canonicalHash({ schema_version: 1, meta: {}, stages: [{ id: "outra", label: "x", order: 1, kind: "sequence" }] });

type Linha = Record<string, unknown>;
interface Tabelas {
  ai_playbooks: Linha[];
  ai_playbook_versions: Linha[];
}

let tabelas: Tabelas;
let consultas: string[];
let erroDoPonteiro: string | null;
let clienteExplode: boolean;
let vezesQueOSthaDoRegistryFoiCalculado: number;

function clienteFalso() {
  return {
    from(tabela: string) {
      if (clienteExplode) throw new Error("cliente quebrou de um jeito imprevisto");
      const filtros: Record<string, unknown> = {};
      const cadeia = {
        select: () => cadeia,
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return cadeia;
        },
        maybeSingle: async () => {
          consultas.push(tabela);
          if (tabela === "ai_playbooks" && erroDoPonteiro) {
            return { data: null, error: { message: erroDoPonteiro } };
          }
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

function observar(shaRegistry = SHA_VALIDA): Promise<PlaybookShadowResult> {
  return observarPlaybookEmShadow({
    client: clienteFalso() as never,
    organizationId: ORG,
    slug: SLUG,
    registryPlaybookId: ID_LEGADO,
    shaDoRegistry: () => {
      vezesQueOSthaDoRegistryFoiCalculado += 1;
      return shaRegistry;
    },
  });
}

/** Empurra o relógio do módulo de produção, que lê `Date.now()`. */
function avancar(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

const comoObservacao = (r: PlaybookShadowResult): PlaybookShadowObservation => {
  expect(r.outcome).toBe("observed");
  return r as PlaybookShadowObservation;
};

function versaoComDefinicao(definition: unknown, sha: string): void {
  tabelas.ai_playbook_versions = [
    { id: V1, organization_id: ORG, playbook_id: PB, version_number: 1, definition, definition_sha256: sha },
  ];
}

beforeEach(() => {
  limparCachesDoShadow();
  consultas = [];
  erroDoPonteiro = null;
  clienteExplode = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  vezesQueOSthaDoRegistryFoiCalculado = 0;
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  tabelas = {
    ai_playbooks: [{ id: PB, organization_id: ORG, slug: SLUG, status: "published", published_version_id: V1 }],
    ai_playbook_versions: [],
  };
  versaoComDefinicao(DEF_VALIDA, SHA_VALIDA);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("os cinco status", () => {
  it("match quando os três hashes coincidem", async () => {
    const o = comoObservacao(await observar(SHA_VALIDA));
    expect(o.status).toBe("match");
    expect(o.reason).toBe("equivalente");
    expect(o.sha_persisted).toBe(SHA_VALIDA);
    expect(o.sha_recomputed).toBe(SHA_VALIDA);
    expect(o.sha_registry).toBe(SHA_VALIDA);
    expect(o.playbook_id).toBe(PB);
    expect(o.published_version_id).toBe(V1);
    expect(o.version_number).toBe(1);
  });

  it("match sobrevive à reordenação de chaves — é canonicalHash, não texto", async () => {
    versaoComDefinicao(DEF_VALIDA_DESORDENADA, SHA_VALIDA);
    // A prova de que a armadilha existe: como TEXTO os dois lados diferem.
    expect(JSON.stringify(DEF_VALIDA_DESORDENADA)).not.toBe(JSON.stringify(DEF_VALIDA));
    expect(comoObservacao(await observar(SHA_VALIDA)).status).toBe("match");
  });

  it("mismatch quando os dois lados são válidos e o conteúdo difere", async () => {
    const o = comoObservacao(await observar(SHA_OUTRO));
    expect(o.status).toBe("mismatch");
    expect(o.reason).toBe("conteudo_divergente");
    expect(o.sha_persisted).toBe(o.sha_recomputed);
    expect(o.sha_recomputed).not.toBe(o.sha_registry);
  });

  it("conflict quando o carimbo gravado não descreve o conteúdo", async () => {
    versaoComDefinicao(DEF_VALIDA, "f".repeat(64));
    const o = comoObservacao(await observar(SHA_VALIDA));
    expect(o.status).toBe("conflict");
    expect(o.reason).toBe("sha_gravado_diverge_do_conteudo");
    expect(o.sha_persisted).not.toBe(o.sha_recomputed);
  });

  it("invalid/row_shape quando a linha não tem a forma que o cast promete", async () => {
    versaoComDefinicao(DEF_VALIDA, "nao-e-sha");
    const o = comoObservacao(await observar(SHA_VALIDA));
    expect(o.status).toBe("invalid");
    expect(o.reason).toBe("row_shape");
    expect(o.sha_persisted).toBeNull();
    // O hash do CONTEÚDO continua calculável, e é aí que ele mais diz.
    expect(o.sha_recomputed).toBe(SHA_VALIDA);
  });

  it("invalid/row_shape quando version_number não é inteiro ≥ 1", async () => {
    tabelas.ai_playbook_versions = [
      { id: V1, organization_id: ORG, playbook_id: PB, version_number: 0, definition: DEF_VALIDA, definition_sha256: SHA_VALIDA },
    ];
    const o = comoObservacao(await observar(SHA_VALIDA));
    expect(o.status).toBe("invalid");
    expect(o.reason).toBe("row_shape");
    expect(o.version_number).toBeNull();
  });

  it("invalid/definicao_invalida quando o JSON é objeto mas o schema recusa", async () => {
    versaoComDefinicao(DEF_INVALIDA, SHA_INVALIDA);
    const o = comoObservacao(await observar(SHA_INVALIDA));
    expect(o.status).toBe("invalid");
    expect(o.reason).toBe("definicao_invalida");
    expect(o.issue_paths?.length).toBeGreaterThan(0);
    expect(o.issue_paths!.length).toBeLessThanOrEqual(5);
  });

  it("missing traz o motivo do loader, sem inventar vocabulário", async () => {
    tabelas.ai_playbooks = [];
    expect(comoObservacao(await observar()).reason).toBe("pointer_absent");

    limparCachesDoShadow();
    tabelas.ai_playbooks = [{ id: PB, organization_id: ORG, slug: SLUG, status: "draft", published_version_id: null }];
    expect(comoObservacao(await observar()).reason).toBe("not_published");

    limparCachesDoShadow();
    tabelas.ai_playbooks = [{ id: PB, organization_id: ORG, slug: SLUG, status: "archived", published_version_id: V1 }];
    expect(comoObservacao(await observar()).reason).toBe("archived");

    limparCachesDoShadow();
    tabelas.ai_playbooks = [{ id: PB, organization_id: ORG, slug: SLUG, status: "published", published_version_id: V1 }];
    tabelas.ai_playbook_versions = [];
    const o = comoObservacao(await observar());
    expect(o.status).toBe("missing");
    expect(o.reason).toBe("version_row_missing");
    expect(o.published_version_id).toBeNull();
  });
});

describe("precedência — o status é UM só, e sempre o mesmo", () => {
  it("conflict vence invalid: linha que mente sobre si é achado mais forte", async () => {
    // Definição inválida PARA O SCHEMA e carimbo que não bate com ela.
    versaoComDefinicao(DEF_INVALIDA, "f".repeat(64));
    const o = comoObservacao(await observar(SHA_VALIDA));
    expect(o.status).toBe("conflict");
  });

  it("row_shape vence conflict: sem forma, o carimbo nem é comparável", async () => {
    versaoComDefinicao(DEF_VALIDA, "carimbo-torto");
    expect(comoObservacao(await observar(SHA_VALIDA)).reason).toBe("row_shape");
  });

  it("invalid vence mismatch: estar malformado importa mais que divergir", async () => {
    versaoComDefinicao(DEF_INVALIDA, SHA_INVALIDA);
    const o = comoObservacao(await observar(SHA_OUTRO));
    expect(o.status).toBe("invalid");
    // E o diagnóstico da divergência não se perde: está nos hashes.
    expect(o.sha_recomputed).not.toBe(o.sha_registry);
  });

  it("missing vence tudo: não há o que comparar", async () => {
    tabelas.ai_playbooks = [];
    expect(comoObservacao(await observar(SHA_OUTRO)).status).toBe("missing");
  });
});

describe("não-observação — eixo próprio, nunca disfarçada de missing", () => {
  it("throttled na segunda chamada dentro da janela", async () => {
    expect((await observar()).outcome).toBe("observed");
    avancar(JANELA_DE_OBSERVACAO_MS - 1);
    expect(await observar()).toEqual({ outcome: "not_observed", reason: "throttled" });
  });

  it("throttled não consulta o banco", async () => {
    await observar();
    const antes = consultas.length;
    avancar(1000);
    await observar();
    expect(consultas.length).toBe(antes);
  });

  it("observa de novo depois da janela", async () => {
    await observar();
    avancar(JANELA_DE_OBSERVACAO_MS);
    expect((await observar()).outcome).toBe("observed");
  });

  it("erro de banco é database_error, NUNCA missing", async () => {
    erroDoPonteiro = "conexão caiu";
    expect(await observar()).toEqual({ outcome: "not_observed", reason: "database_error" });
  });

  it("exceção inesperada vira database_error e não escapa", async () => {
    clienteExplode = true;
    await expect(observar()).resolves.toEqual({ outcome: "not_observed", reason: "database_error" });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("caches e cadência", () => {
  it("o sha do registry é derivado UMA vez por processo", async () => {
    await observar();
    avancar(JANELA_DE_OBSERVACAO_MS);
    await observar();
    expect(vezesQueOSthaDoRegistryFoiCalculado).toBe(1);
  });

  it("o sha do registry NÃO é derivado quando a observação está em cadência", async () => {
    avancar(JANELA_DE_OBSERVACAO_MS);
    await observar();
    const depoisDaPrimeira = vezesQueOSthaDoRegistryFoiCalculado;
    avancar(1);
    await observar();
    expect(vezesQueOSthaDoRegistryFoiCalculado).toBe(depoisDaPrimeira);
  });

  it("versão é imutável: reavaliar a mesma version_id serve o cache", async () => {
    expect(comoObservacao(await observar(SHA_VALIDA)).status).toBe("match");
    // A linha "muda" debaixo do cache — o que o banco proíbe por trigger. Se o
    // shadow reavaliasse, isto viraria conflict; servindo o cache, continua match.
    versaoComDefinicao(DEF_INVALIDA, "f".repeat(64));
    avancar(JANELA_DE_OBSERVACAO_MS);
    expect(comoObservacao(await observar(SHA_VALIDA)).status).toBe("match");
  });

  it("o ponteiro é RELIDO a cada observação permitida — ele nunca é cacheado", async () => {
    await observar();
    const antes = consultas.filter((t) => t === "ai_playbooks").length;
    avancar(JANELA_DE_OBSERVACAO_MS);
    await observar();
    expect(consultas.filter((t) => t === "ai_playbooks").length).toBe(antes + 1);
  });

  it("o published_version_id ATUAL é respeitado: publicar move o ponteiro e o shadow enxerga", async () => {
    expect(comoObservacao(await observar(SHA_VALIDA)).published_version_id).toBe(V1);

    // Publicação nova: versão nova, ponteiro movido. Se o ponteiro fosse
    // cacheado, o shadow continuaria observando a v1 e reportaria `match`
    // enquanto o que está no ar é outra coisa — o pior erro possível num
    // observador, porque ele é silencioso e tranquilizador.
    const V2 = "cccccccc-cccc-4ccc-8ccc-000000000002";
    tabelas.ai_playbook_versions.push({
      id: V2, organization_id: ORG, playbook_id: PB, version_number: 2,
      definition: DEF_INVALIDA, definition_sha256: SHA_INVALIDA,
    });
    tabelas.ai_playbooks = [{ id: PB, organization_id: ORG, slug: SLUG, status: "published", published_version_id: V2 }];

    avancar(JANELA_DE_OBSERVACAO_MS);
    const o = comoObservacao(await observar(SHA_VALIDA));
    expect(o.published_version_id).toBe(V2);
    expect(o.version_number).toBe(2);
    expect(o.status).toBe("invalid");
  });

  it("o cache de versão é por version_id — a v2 não herda a avaliação da v1", async () => {
    await observar(SHA_VALIDA);
    const V2 = "cccccccc-cccc-4ccc-8ccc-000000000002";
    tabelas.ai_playbook_versions.push({
      id: V2, organization_id: ORG, playbook_id: PB, version_number: 2,
      definition: DEF_VALIDA, definition_sha256: "f".repeat(64),
    });
    tabelas.ai_playbooks = [{ id: PB, organization_id: ORG, slug: SLUG, status: "published", published_version_id: V2 }];
    avancar(JANELA_DE_OBSERVACAO_MS);
    expect(comoObservacao(await observar(SHA_VALIDA)).status).toBe("conflict");
  });
});

describe("o resultado é desenhado para ser logado como está", () => {
  it("não carrega definition, copy, conversa, contato, lead nem funil", async () => {
    const o = comoObservacao(await observar());
    const texto = JSON.stringify(o);
    expect(texto).not.toContain(COPY_SECRETA);
    expect(texto).not.toContain("Abertura");
    for (const proibido of ["definition", "conversation_id", "contact_id", "lead_id", "pipeline_id", "text", "message"]) {
      expect(Object.keys(o)).not.toContain(proibido);
    }
  });

  it("nem quando a definição é inválida: caminho de erro, nunca valor", async () => {
    versaoComDefinicao(DEF_INVALIDA, SHA_INVALIDA);
    const o = comoObservacao(await observar(SHA_INVALIDA));
    expect(JSON.stringify(o)).not.toContain(COPY_SECRETA);
    for (const p of o.issue_paths ?? []) expect(p).toMatch(/^[a-z_0-9.]*$/i);
  });

  it("match vai para info; qualquer outro status vai para warn", async () => {
    await observar(SHA_VALIDA);
    expect(logger.info).toHaveBeenCalledWith("playbook.shadow", expect.objectContaining({ status: "match" }));
    expect(logger.warn).not.toHaveBeenCalled();

    limparCachesDoShadow();
    await observar(SHA_OUTRO);
    expect(logger.warn).toHaveBeenCalledWith("playbook.shadow", expect.objectContaining({ status: "mismatch" }));
  });

  it("o log trunca os hashes em 12 hex — correlaciona sem despejar", async () => {
    await observar(SHA_VALIDA);
    const [, linha] = (logger.info as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0]!;
    expect(linha.sha_registry).toBe(SHA_VALIDA.slice(0, 12));
    expect(String(linha.sha_persisted)).toHaveLength(12);
  });

  it("a cadência não loga: throttled seria ruído por requisição", async () => {
    await observar();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    avancar(1);
    await observar();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("regras vigiadas no FONTE", () => {
  const fonte = fs.readFileSync(path.join(process.cwd(), "lib/playbooks/shadow.ts"), "utf8");
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("igualdade de playbook nunca é textual", () => {
    expect(codigo).not.toMatch(/JSON\.stringify/);
  });

  it("o genérico não importa lib/afb", () => {
    expect(fonte).not.toMatch(/from\s+"@\/lib\/afb/);
    expect(fonte).not.toMatch(/from\s+"\.\.\/afb/);
  });

  it("não escreve: nada de insert, update, upsert, delete ou rpc", () => {
    for (const escrita of ["insert(", "update(", "upsert(", "delete(", ".rpc("]) {
      expect(codigo).not.toContain(escrita);
    }
  });

  it("usa o canonicalHash do produto, não um segundo algoritmo", () => {
    expect(fonte).toMatch(/import \{ canonicalHash \} from "@\/lib\/agent-engine\/agent\/tool-breaker"/);
    expect(codigo).not.toMatch(/createHash\(/);
  });
});
