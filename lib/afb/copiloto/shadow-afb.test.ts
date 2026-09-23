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
  identidadePersistidaDoPlaybook,
  observarPlaybookDoCopilotoAFB,
  SLUG_PERSISTIDO_POR_ID_DO_REGISTRY,
} from "./shadow-afb";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const PB = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const V1 = "cccccccc-cccc-4ccc-8ccc-000000000001";

type Linha = Record<string, unknown>;
let versoes: Linha[];

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
              ? [{ id: PB, organization_id: ORG, slug: AFB_PLAYBOOK_PERSISTIDO.slug, status: "published", published_version_id: V1 }]
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
      expect(await observarPlaybookDoCopilotoAFB({ client: clienteFalso() as never, organizationId: ORG, playbookId: id })).toEqual({
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
      await observar({ client: clienteFalso() as never, organizationId: ORG, playbookId: "afb_comercial_v1" }),
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
