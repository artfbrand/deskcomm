/**
 * A ponte AFB → shadow: a identidade, o anti-drift e a não-observação.
 *
 * O teste mais importante daqui é o de DRIFT: o slug persistido está escrito
 * em dois lugares (aqui e no provisionamento) porque o runtime não deve
 * importar módulo de CLI. Duas declarações da mesma verdade só são seguras
 * enquanto alguém as compara — e quem compara é este arquivo.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AFB_COMERCIAL_V1 } from "@/lib/afb/playbooks/comercial";
import { AFB_PLAYBOOK_PERSISTIDO } from "@/lib/afb/provisionamento/configuracao";
import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";
import { deRegistryParaDefinicao } from "@/lib/playbooks/adaptador-afb";
import { logger } from "@/lib/logger";
import { limparCachesDoShadow, type PlaybookShadowObservation } from "@/lib/playbooks/shadow";

import {
  identidadeDoShadowPeloBinding,
  identidadePersistidaDoPlaybook,
  observarPlaybookDoCopilotoAFB,
  SLUG_PERSISTIDO_POR_ID_DO_REGISTRY,
} from "./shadow-afb";

/**
 * O binding LEGADO — funil sem `ai_playbook_id`, com o id de registry no
 * jsonb. É o estado de toda instalação que ainda não rodou o provisionamento
 * da Fase D, e por isso é o padrão dos casos herdados deste arquivo.
 */
const BINDING_LEGADO = { origem: "legado", registryPlaybookId: "afb_comercial_v1" } as const;

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const PB = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const V1 = "cccccccc-cccc-4ccc-8ccc-000000000001";

type Linha = Record<string, unknown>;
let versoes: Linha[];
/** O slug da linha persistida. Mutável para provar que a busca por ID o ignora. */
let slugDoPonteiro: string;

function clienteFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const cadeia = {
        select: () => cadeia,
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return cadeia;
        },
        maybeSingle: async () => {
          const linhas =
            tabela === "ai_playbooks"
              ? [{ id: PB, organization_id: ORG, slug: slugDoPonteiro, status: "published", published_version_id: V1 }]
              : versoes;
          return {
            data: linhas.filter((l) => Object.entries(filtros).every(([k, v]) => l[k] === v))[0] ?? null,
            error: null,
          };
        },
      };
      return cadeia;
    },
  };
}

beforeEach(() => {
  limparCachesDoShadow();
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  versoes = [];
  slugDoPonteiro = AFB_PLAYBOOK_PERSISTIDO.slug;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("identidade persistida — a tradução, e o anti-drift", () => {
  it("afb_comercial_v1 → afb_comercial", () => {
    expect(identidadePersistidaDoPlaybook("afb_comercial_v1")).toEqual({
      registryPlaybookId: "afb_comercial_v1",
      slug: "afb_comercial",
    });
  });

  it("o slug declarado aqui é o MESMO que o provisionamento persiste", () => {
    expect(SLUG_PERSISTIDO_POR_ID_DO_REGISTRY[AFB_PLAYBOOK_PERSISTIDO.legacyId]).toBe(AFB_PLAYBOOK_PERSISTIDO.slug);
  });

  it("o id legado do mapa é o id real do registry", () => {
    expect(Object.keys(SLUG_PERSISTIDO_POR_ID_DO_REGISTRY)).toEqual([AFB_COMERCIAL_V1.id]);
    expect(AFB_PLAYBOOK_PERSISTIDO.legacyId).toBe(AFB_COMERCIAL_V1.id);
  });

  it("id desconhecido, nulo ou de outro formato não tem identidade", () => {
    expect(identidadePersistidaDoPlaybook("outro_playbook_v1")).toBeNull();
    expect(identidadePersistidaDoPlaybook(null)).toBeNull();
    expect(identidadePersistidaDoPlaybook(undefined)).toBeNull();
    expect(identidadePersistidaDoPlaybook("")).toBeNull();
  });
});

describe("observarPlaybookDoCopilotoAFB", () => {
  it("sem identidade é runtime_sem_playbook — ausência de pergunta, não de dado", async () => {
    for (const id of [null, undefined, "desconhecido_v9"]) {
      expect(await observarPlaybookDoCopilotoAFB({ client: clienteFalso() as never, organizationId: ORG, playbookId: id , binding: BINDING_LEGADO })).toEqual({
        outcome: "not_observed",
        reason: "runtime_sem_playbook",
      });
    }
  });

  it("id com par no mapa mas sem conteúdo no registry também é runtime_sem_playbook", async () => {
    // O `getPlaybook` devolve `Playbook | null`, então o ramo é exigido pelo
    // tipo, não inventado. Ele existe para que um buraco do CÓDIGO (mapa e
    // registry fora de sincronia) não seja observado como divergência do
    // BANCO — e para não lançar dentro de um caminho fail-open.
    vi.resetModules();
    vi.doMock("@/lib/afb/playbooks/registry", () => ({ getPlaybook: () => null }));
    const { observarPlaybookDoCopilotoAFB: observar } = await import("./shadow-afb");
    expect(
      await observar({ client: clienteFalso() as never, organizationId: ORG, playbookId: "afb_comercial_v1" , binding: BINDING_LEGADO }),
    ).toEqual({ outcome: "not_observed", reason: "runtime_sem_playbook" });
    vi.doUnmock("@/lib/afb/playbooks/registry");
    vi.resetModules();
  });

  it("match contra a definição que o adaptador produz do registry", async () => {
    const { definition, sha256 } = deRegistryParaDefinicao(AFB_COMERCIAL_V1);
    versoes = [
      { id: V1, organization_id: ORG, playbook_id: PB, version_number: 1, definition, definition_sha256: sha256 },
    ];

    const r = await observarPlaybookDoCopilotoAFB({
      client: clienteFalso() as never,
      organizationId: ORG,
      playbookId: AFB_COMERCIAL_V1.id,
      binding: BINDING_LEGADO,
    });

    const o = r as PlaybookShadowObservation;
    expect(o.outcome).toBe("observed");
    expect(o.status).toBe("match");
    expect(o.slug).toBe(AFB_PLAYBOOK_PERSISTIDO.slug);
    expect(o.registry_playbook_id).toBe(AFB_COMERCIAL_V1.id);
    expect(o.sha_registry).toBe(sha256);
  });

  it("mismatch quando o persistido é outra estratégia — e nenhuma copy escapa", async () => {
    const outra = { schema_version: 1, meta: {}, stages: [{ id: "abertura", label: "x", order: 1, kind: "sequence" }] };
    const shaDaOutra = canonicalHash(outra);
    versoes = [
      { id: V1, organization_id: ORG, playbook_id: PB, version_number: 1, definition: outra, definition_sha256: shaDaOutra },
    ];

    const o = (await observarPlaybookDoCopilotoAFB({
      client: clienteFalso() as never,
      organizationId: ORG,
      playbookId: AFB_COMERCIAL_V1.id,
      binding: BINDING_LEGADO,
    })) as PlaybookShadowObservation;

    expect(o.status).toBe("mismatch");
    expect(o.sha_registry).toBe(deRegistryParaDefinicao(AFB_COMERCIAL_V1).sha256);
    // A copy oficial do playbook não aparece em lugar nenhum do resultado.
    const texto = JSON.stringify(o);
    for (const m of AFB_COMERCIAL_V1.whatsapp.etapas.slice(0, 3)) {
      expect(texto).not.toContain(m.mensagem.texto);
    }
  });
});

describe("regras vigiadas no FONTE", () => {
  const fonte = fs.readFileSync(path.join(process.cwd(), "lib/afb/copiloto/shadow-afb.ts"), "utf8");

  it("o runtime não importa configuração de provisionamento", () => {
    expect(fonte).not.toMatch(/from\s+"@\/lib\/afb\/provisionamento/);
  });

  it("não escreve nada", () => {
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const escrita of ["insert(", "update(", "upsert(", "delete(", ".rpc("]) {
      expect(codigo).not.toContain(escrita);
    }
  });
});

/**
 * ─── D.5: o binding decide POR ONDE o persistido é procurado ────────────────
 *
 * E só isso. O playbook EXECUTADO continua vindo do registry em todos os casos
 * abaixo — o que muda é a porta de entrada do lado persistido da comparação.
 */
describe("identidadeDoShadowPeloBinding — a regra pura", () => {
  it("persistido → busca por id, sem passar pelo mapa de slugs", () => {
    expect(
      identidadeDoShadowPeloBinding({ origem: "persistido", aiPlaybookId: PB }, "afb_comercial_v1"),
    ).toEqual({ por: "id", playbookId: PB });
  });

  it("legado → busca por slug, pelo mapa da transição", () => {
    expect(
      identidadeDoShadowPeloBinding({ origem: "legado", registryPlaybookId: "afb_comercial_v1" }, "afb_comercial_v1"),
    ).toEqual({ por: "slug", slug: AFB_PLAYBOOK_PERSISTIDO.slug });
  });

  it("legado com id fora do mapa → null (nada a observar, e nada inventado)", () => {
    expect(
      identidadeDoShadowPeloBinding({ origem: "legado", registryPlaybookId: "x_v1" }, "desconhecido_v9"),
    ).toBeNull();
  });

  it("ausente → null", () => {
    expect(identidadeDoShadowPeloBinding({ origem: "ausente" }, "afb_comercial_v1")).toBeNull();
  });
});

describe("observarPlaybookDoCopilotoAFB — binding persistido", () => {
  const comDefinicaoDoRegistry = () => {
    const { definition, sha256 } = deRegistryParaDefinicao(AFB_COMERCIAL_V1);
    versoes = [
      { id: V1, organization_id: ORG, playbook_id: PB, version_number: 1, definition, definition_sha256: sha256 },
    ];
    return sha256;
  };

  const observarCom = (binding: Parameters<typeof identidadeDoShadowPeloBinding>[0]) =>
    observarPlaybookDoCopilotoAFB({
      client: clienteFalso() as never,
      organizationId: ORG,
      playbookId: AFB_COMERCIAL_V1.id,
      binding,
    });

  it("match pelo UUID, e o log declara binding_source persistido", async () => {
    const sha = comDefinicaoDoRegistry();
    const o = (await observarCom({ origem: "persistido", aiPlaybookId: PB })) as PlaybookShadowObservation;

    expect(o.outcome).toBe("observed");
    expect(o.status).toBe("match");
    expect(o.reason).toBe("equivalente");
    expect(o.binding_source).toBe("persistido");
    expect(o.playbook_id).toBe(PB);
    expect(o.published_version_id).toBe(V1);
    expect(o.sha_registry).toBe(sha);
    // O registry continua sendo o que o runtime executou.
    expect(o.registry_playbook_id).toBe(AFB_COMERCIAL_V1.id);
  });

  it("o mapa de slugs NÃO participa: a linha é achada mesmo com slug diferente", async () => {
    comDefinicaoDoRegistry();
    // O ponteiro existe, com o id certo e um slug QUE O MAPA NÃO CONHECE.
    slugDoPonteiro = "outro_slug_qualquer";

    const persistido = (await observarCom({ origem: "persistido", aiPlaybookId: PB })) as PlaybookShadowObservation;
    expect(persistido.status).toBe("match");
    // E o slug reportado é o DA LINHA, não o do mapa — ele é lido, não suposto.
    expect(persistido.slug).toBe("outro_slug_qualquer");

    limparCachesDoShadow();
    // Pelo caminho legado, a MESMA fixtura não é encontrada: ali a busca é pelo
    // slug do mapa, que não casa. É o contraste que prova que as duas portas
    // são independentes.
    const legado = (await observarCom(BINDING_LEGADO)) as PlaybookShadowObservation;
    expect(legado.status).toBe("missing");
    expect(legado.reason).toBe("pointer_absent");
    expect(legado.binding_source).toBe("legado");
  });

  it("UUID persistido que não existe → missing/pointer_absent, fail-open", async () => {
    comDefinicaoDoRegistry();
    const o = (await observarCom({
      origem: "persistido",
      aiPlaybookId: "ffffffff-ffff-4fff-8fff-000000000000",
    })) as PlaybookShadowObservation;
    expect(o.outcome).toBe("observed");
    expect(o.status).toBe("missing");
    expect(o.reason).toBe("pointer_absent");
    // Slug desconhecido na busca por id sem linha: null, nunca inventado.
    expect(o.slug).toBeNull();
  });

  it("binding ausente → not_observed, sem tocar no banco", async () => {
    comDefinicaoDoRegistry();
    expect(await observarCom({ origem: "ausente" })).toEqual({
      outcome: "not_observed",
      reason: "runtime_sem_playbook",
    });
  });

  it("mismatch pelo UUID quando o persistido é outra estratégia", async () => {
    const outra = { schema_version: 1, meta: {}, stages: [{ id: "abertura", label: "x", order: 1, kind: "sequence" }] };
    versoes = [
      { id: V1, organization_id: ORG, playbook_id: PB, version_number: 1, definition: outra, definition_sha256: canonicalHash(outra) },
    ];
    const o = (await observarCom({ origem: "persistido", aiPlaybookId: PB })) as PlaybookShadowObservation;
    expect(o.status).toBe("mismatch");
    expect(o.binding_source).toBe("persistido");
  });

  it("o log do caminho persistido não carrega copy nem definição", async () => {
    comDefinicaoDoRegistry();
    await observarCom({ origem: "persistido", aiPlaybookId: PB });
    const [, linha] = vi.mocked(logger.info).mock.calls.at(-1)!;
    // A garantia é do TIPO, não da lembrança: o que pode ser logado é o
    // conjunto fechado de chaves do contrato. Qualquer chave a mais aqui é
    // campo novo que ninguém revisou — inclusive um que carregue copy.
    const permitidas = [
      "outcome", "status", "reason", "organization_id", "binding_source", "slug",
      "registry_playbook_id", "playbook_id", "published_version_id", "version_number",
      "sha_persisted", "sha_recomputed", "sha_registry", "issue_paths", "duration_ms",
    ];
    for (const chave of Object.keys(linha as object)) expect(permitidas, chave).toContain(chave);
    expect((linha as { binding_source: string }).binding_source).toBe("persistido");
    // E os hashes saem TRUNCADOS, nunca a definição.
    expect(JSON.stringify(linha)).not.toContain("definition");
  });
});
