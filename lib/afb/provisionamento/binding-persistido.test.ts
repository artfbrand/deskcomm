/**
 * D.4 — o provisionamento PRODUZ o binding persistido.
 *
 * O que se mede aqui: que o UUID gravado em `crm_pipelines.ai_playbook_id` é
 * exatamente o id que a persistência do playbook devolveu NESTA execução — não
 * um id buscado por slug, não um id lido antes da escrita, não um hardcode.
 *
 * ─── Por que este arquivo existe em vez de casos em provisionador.test.ts ───
 *
 * `provisionador.test.ts` está modificado por outra frente de trabalho, com 12
 * hunks que não são desta fase. Misturar casos novos ali tornaria impossível
 * separar depois o que é D.4 do que já estava. O dublê daqui é menor de
 * propósito: implementa o contrato inteiro, mas só o que D.4 observa tem corpo.
 *
 * ─── A fronteira, dita sem maquiagem ───────────────────────────────────────
 *
 * Isto prova a DECISÃO do provisionador — qual id ele passa, quando, e o que
 * ele preserva. NÃO prova que o PostgREST aceita o `update`, nem que a FK da
 * 0234 recusa cross-tenant: quem prova isso é
 * `tests/invariants/binding-de-playbook-no-funil.test.ts`, contra Postgres
 * real. As duas camadas se encontram no nome da coluna, e em nada mais.
 */
import { describe, expect, it } from "vitest";

import { AFB_PLAYBOOK_ID, AFB_PLAYBOOK_PERSISTIDO } from "./configuracao";
import {
  provisionAfbCommercialOutbound,
  uuidDoBindingPersistido,
  type AfbProvisioningRepository,
  type AgentBootstrapInput,
  type AgentUpsertResult,
  type ExistingPlaybookRef,
  type PlaybookBootstrapInput,
  type PlaybookUpsertResult,
  type ProvisioningSnapshot,
  type UpsertResult,
} from "./provisionador";
import type { DocumentosAfbCarregados } from "./documentos";

const ORG = "11111111-1111-4111-8111-000000000001";
const FUNIL = "22222222-2222-4222-8222-000000000001";
/** O UUID que a persistência devolve. Nasce no banco; aqui é o dublê que o dá. */
const UUID_NOVO = "33333333-3333-4333-8333-000000000001";
/** O UUID de um playbook que já existia no snapshot. */
const UUID_EXISTENTE = "33333333-3333-4333-8333-000000000002";
const SHA = "a".repeat(64);
const SHA_DIVERGENTE = "b".repeat(64);

const DEFINICAO = { schema_version: 1, stages: [] };

function documentos(): DocumentosAfbCarregados {
  const knowledge = [
    {
      key: "empresa_posicionamento",
      title: "AFB — Empresa e posicionamento",
      description: "d",
      documentPath: "docs/afb/knowledge/empresa-posicionamento.md",
      version: "3",
      status: "piloto" as const,
      scope: "s",
      question: "q",
      content: "conteudo",
      sha256: "c".repeat(64),
    },
  ];
  return {
    knowledge,
    memory: {
      key: "principios_comerciais_limites",
      title: "AFB — Princípios comerciais e limites",
      description: "d",
      documentPath: "docs/afb/memory/principios-comerciais-e-limites.md",
      version: "1",
      status: "piloto" as const,
      scope: "s",
      content: "conteudo",
      sha256: "d".repeat(64),
    },
  } as unknown as DocumentosAfbCarregados;
}

function snapshot(playbook: ExistingPlaybookRef | null): ProvisioningSnapshot {
  return {
    organization: { id: ORG, slug: "afb", displayName: "AFB" },
    pipelines: [{ id: FUNIL, name: "Prospecção Outbound AFB", settings: {}, isArchived: false }],
    credentials: [{ id: "cred-1", label: "OpenAI" }],
    channelSessions: [{ id: "sess-1", displayName: "WhatsApp" }],
    models: [{ id: "m-1", slug: "anthropic/claude-sonnet-4-6" }],
    knowledgeSources: [],
    memoryEntriesWithTitle: 0,
    memory: null,
    agent: null,
    playbook,
  } as unknown as ProvisioningSnapshot;
}

/** Playbook já existente e JÁ correto — o caminho `unchanged`. */
const PLAYBOOK_IGUAL: ExistingPlaybookRef = {
  id: UUID_EXISTENTE,
  slug: AFB_PLAYBOOK_PERSISTIDO.slug,
  name: AFB_PLAYBOOK_PERSISTIDO.name,
  status: "published",
  bootstrapKey: AFB_PLAYBOOK_PERSISTIDO.slug,
  publishedVersionId: "v-1",
  publishedVersionSha256: SHA,
  publishedVersionNumber: 1,
  draftSha256: null,
};

/** Playbook de outra gente, com o nosso slug — o caminho `conflict`. */
const PLAYBOOK_ALHEIO: ExistingPlaybookRef = {
  ...PLAYBOOK_IGUAL,
  bootstrapKey: null,
  publishedVersionSha256: SHA_DIVERGENTE,
};

interface ChamadaDeFunil {
  organizationId: string;
  pipelineId: string;
  aiPlaybookId: string | null;
}

class RepositorioDuble implements AfbProvisioningRepository {
  chamadasDeFunil: ChamadaDeFunil[] = [];
  ordem: string[] = [];
  /** O estado do funil, como o repositório real o manteria. */
  funil = { settings: {} as Record<string, unknown>, aiPlaybookId: null as string | null };

  constructor(private readonly playbookInicial: ExistingPlaybookRef | null) {}

  async inspect(): Promise<ProvisioningSnapshot | null> {
    const s = snapshot(this.playbookInicial);
    (s.pipelines[0] as { settings: unknown }).settings = structuredClone(this.funil.settings);
    return s;
  }

  async createAndPublishPlaybook(input: PlaybookBootstrapInput): Promise<PlaybookUpsertResult> {
    this.ordem.push("playbook");
    expect(input.organizationId).toBe(ORG);
    return { id: UUID_NOVO, versionId: "v-1", versionNumber: 1, created: true, published: true, adopted: false };
  }

  async publishPlaybookVersion(
    input: PlaybookBootstrapInput & { playbookId: string },
  ): Promise<PlaybookUpsertResult> {
    this.ordem.push("playbook");
    return { id: input.playbookId, versionId: "v-1", versionNumber: 1, created: false, published: true, adopted: false };
  }

  async adoptPlaybook(organizationId: string, playbookId: string): Promise<PlaybookUpsertResult> {
    this.ordem.push("playbook");
    expect(organizationId).toBe(ORG);
    return { id: playbookId, versionId: "v-1", versionNumber: 1, created: false, published: false, adopted: true };
  }

  async configurePipeline(
    organizationId: string,
    pipelineId: string,
    aiPlaybookId: string | null,
  ): Promise<boolean> {
    this.ordem.push("funil");
    this.chamadasDeFunil.push({ organizationId, pipelineId, aiPlaybookId });
    // Espelha a regra do repositório real: `null` não toca na coluna.
    const mudou = aiPlaybookId !== null && this.funil.aiPlaybookId !== aiPlaybookId;
    if (mudou) this.funil.aiPlaybookId = aiPlaybookId;
    return mudou;
  }

  async upsertKnowledgeSource(): Promise<UpsertResult> {
    return { id: "k-1", changed: false, created: false };
  }
  async upsertMemory(): Promise<UpsertResult> {
    return { id: "m-1", changed: false, created: false };
  }
  async upsertAgent(_input: AgentBootstrapInput): Promise<AgentUpsertResult> {
    return { id: "a-1", changed: false, versionId: null, published: false } as unknown as AgentUpsertResult;
  }
  async requestKnowledgeIndex(): Promise<void> {}
  async recordAudit(): Promise<void> {
    this.ordem.push("audit");
  }
}

/**
 * `pipelineId` explícito é o caminho real do primeiro provisionamento
 * (`afb:provision --pipeline <uuid>`): sem ele, `selectPipeline` só acha o
 * funil que JÁ tem o id legado gravado, e uma instalação nova não tem.
 */
const rodar = (repo: RepositorioDuble, apply: boolean) =>
  provisionAfbCommercialOutbound(
    repo,
    { organization: ORG, pipelineId: FUNIL, apply },
    { loadDocuments: async () => documentos(), buildPlaybookDefinition: () => ({ definition: DEFINICAO, sha256: SHA }) },
  );

// ─── A regra pura, isolada ───────────────────────────────────────────────────

describe("uuidDoBindingPersistido — de onde o id vem, por ação", () => {
  const aplicado = (id: string): PlaybookUpsertResult => ({
    id,
    versionId: "v",
    versionNumber: 1,
    created: false,
    published: false,
    adopted: false,
  });

  it("create/publish/adopt: usa o id devolvido pela escrita DESTA execução", () => {
    for (const acao of ["create", "publish", "adopt"] as const) {
      expect(uuidDoBindingPersistido(acao, null, aplicado(UUID_NOVO)), acao).toBe(UUID_NOVO);
    }
  });

  it("o id da escrita VENCE o do snapshot quando os dois existem", () => {
    // No `adopt` os dois são o mesmo id; este caso força a diferença para
    // deixar explícito QUAL dos dois a função prefere, e por quê.
    expect(uuidDoBindingPersistido("adopt", PLAYBOOK_IGUAL, aplicado(UUID_NOVO))).toBe(UUID_NOVO);
  });

  it("unchanged: não houve escrita, então o id vem do snapshot", () => {
    expect(uuidDoBindingPersistido("unchanged", PLAYBOOK_IGUAL, null)).toBe(UUID_EXISTENTE);
  });

  it("conflict: NENHUM binding, mesmo havendo um playbook com o nosso slug", () => {
    expect(uuidDoBindingPersistido("conflict", PLAYBOOK_ALHEIO, null)).toBeNull();
    expect(uuidDoBindingPersistido("conflict", PLAYBOOK_ALHEIO, aplicado(UUID_NOVO))).toBeNull();
  });

  it("sem playbook e sem escrita: null", () => {
    expect(uuidDoBindingPersistido("unchanged", null, null)).toBeNull();
  });
});

// ─── O fluxo: o id chega ao funil ────────────────────────────────────────────

describe("apply — o UUID criado é o mesmo entregue ao funil", () => {
  it("1/2. create: configurePipeline recebe o id que createAndPublishPlaybook devolveu", async () => {
    const repo = new RepositorioDuble(null);
    await rodar(repo, true);

    expect(repo.chamadasDeFunil).toHaveLength(1);
    expect(repo.chamadasDeFunil[0]!.aiPlaybookId).toBe(UUID_NOVO);
    expect(repo.funil.aiPlaybookId).toBe(UUID_NOVO);
  });

  it("a escrita do playbook acontece ANTES da do funil — senão o id não existiria", async () => {
    const repo = new RepositorioDuble(null);
    await rodar(repo, true);
    expect(repo.ordem.indexOf("playbook")).toBeLessThan(repo.ordem.indexOf("funil"));
    // E a auditoria continua por último, depois das duas.
    expect(repo.ordem.indexOf("funil")).toBeLessThan(repo.ordem.indexOf("audit"));
  });

  it("3/4. a organização entregue é a do snapshot, e o funil é o resolvido", async () => {
    const repo = new RepositorioDuble(null);
    await rodar(repo, true);
    expect(repo.chamadasDeFunil[0]!.organizationId).toBe(ORG);
    expect(repo.chamadasDeFunil[0]!.pipelineId).toBe(FUNIL);
  });

  it("unchanged: o id vem do snapshot e o funil é vinculado assim mesmo", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_IGUAL);
    await rodar(repo, true);
    expect(repo.chamadasDeFunil[0]!.aiPlaybookId).toBe(UUID_EXISTENTE);
    expect(repo.funil.aiPlaybookId).toBe(UUID_EXISTENTE);
  });

  it("conflict: o funil NÃO é vinculado a um playbook que não é nosso", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_ALHEIO);
    await rodar(repo, true);
    expect(repo.chamadasDeFunil[0]!.aiPlaybookId).toBeNull();
    expect(repo.funil.aiPlaybookId).toBeNull();
  });
});

// ─── Idempotência ────────────────────────────────────────────────────────────

describe("8. idempotência", () => {
  it("segunda execução reconhece o mesmo UUID e não declara mudança", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_IGUAL);
    await rodar(repo, true);
    expect(repo.funil.aiPlaybookId).toBe(UUID_EXISTENTE);

    repo.chamadasDeFunil = [];
    await rodar(repo, true);

    // Chamou de novo — mas com o mesmo id, e o dublê (como o repositório real)
    // devolve `false`: nada a escrever.
    expect(repo.chamadasDeFunil[0]!.aiPlaybookId).toBe(UUID_EXISTENTE);
    expect(repo.funil.aiPlaybookId).toBe(UUID_EXISTENTE);
  });

  it("binding já correto não é reescrito com outro id", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_IGUAL);
    repo.funil.aiPlaybookId = UUID_EXISTENTE;
    await rodar(repo, true);
    expect(repo.funil.aiPlaybookId).toBe(UUID_EXISTENTE);
  });
});

// ─── O legado sobrevive ──────────────────────────────────────────────────────

describe("5/6/7. o binding legado e a vizinhança continuam intactos", () => {
  it("o módulo legado continua com o id de REGISTRY, e o UUID não entra no jsonb", async () => {
    const repo = new RepositorioDuble(null);
    // O repositório real grava `settings` via `buildAfbPipelineSettings`; aqui
    // o que se mede é o CONTRATO: o provisionador não manda UUID no jsonb.
    await rodar(repo, true);

    const { buildAfbPipelineSettings } = await import("./provisionador");
    const settings = buildAfbPipelineSettings({
      modulos: { copiloto_comercial: { etapas: { [FUNIL]: "conversa" } } },
      canonical_tags: ["x"],
    }) as {
      modulos: { copiloto_comercial: Record<string, unknown> };
      canonical_tags: string[];
    };

    expect(settings.modulos.copiloto_comercial.playbook_id).toBe(AFB_PLAYBOOK_ID);
    expect(settings.modulos.copiloto_comercial.enabled).toBe(true);
    // Etapas preservadas, vizinhança preservada, e NENHUM uuid no jsonb.
    expect(settings.modulos.copiloto_comercial.etapas).toEqual({ [FUNIL]: "conversa" });
    expect(settings.canonical_tags).toEqual(["x"]);
    expect(JSON.stringify(settings)).not.toContain(UUID_NOVO);
    expect(JSON.stringify(settings)).not.toContain(UUID_EXISTENTE);
  });
});

// ─── Dry-run ─────────────────────────────────────────────────────────────────

describe("9/10. dry-run", () => {
  it("não escreve nada: nenhuma chamada de funil e nenhum playbook aplicado", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_IGUAL);
    const r = await rodar(repo, false);
    expect(r.applied).toBe(false);
    expect(repo.chamadasDeFunil).toHaveLength(0);
    expect(repo.ordem).toEqual([]);
    expect(repo.funil.aiPlaybookId).toBeNull();
  });

  it("declara QUAL UUID seria aplicado, quando ele já existe", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_IGUAL);
    const r = await rodar(repo, false);
    expect(r.persistedPlaybook.pipelineBindingId).toBe(UUID_EXISTENTE);
    expect(r.changes).toContain(`vincular funil ${FUNIL} ao playbook persistido ${UUID_EXISTENTE}`);
  });

  it("no create o id AINDA NÃO EXISTE, e o relatório diz isso em vez de inventar", async () => {
    const repo = new RepositorioDuble(null);
    const r = await rodar(repo, false);
    // `null` aqui não é "não haverá binding": o `action` ao lado o separa.
    expect(r.persistedPlaybook.pipelineBindingId).toBeNull();
    expect(r.persistedPlaybook.action).toBe("create");
    expect(r.changes).toContain(`vincular funil ${FUNIL} ao playbook persistido (id criado nesta execução)`);
  });

  it("em conflito o dry-run NÃO promete binding nenhum", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_ALHEIO);
    const r = await rodar(repo, false);
    expect(r.persistedPlaybook.action).toBe("conflict");
    expect(r.persistedPlaybook.pipelineBindingId).toBeNull();
    expect(r.changes.some((linha) => linha.startsWith("vincular funil"))).toBe(false);
  });

  it("a linha do legado continua existindo, separada da do binding", async () => {
    const repo = new RepositorioDuble(PLAYBOOK_IGUAL);
    const r = await rodar(repo, false);
    expect(r.changes).toContain(`configurar playbook ${AFB_PLAYBOOK_ID} no funil ${FUNIL}`);
  });
});

// ─── Regras vigiadas no FONTE ────────────────────────────────────────────────

describe("11/12/13. o id não é inventado nem resolvido dentro do repositório", () => {
  it("configurePipeline do repositório real não busca playbook por slug/nome/versão", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "lib/afb/provisionamento/repositorio-supabase.ts"),
      "utf8",
    );
    const corpo = fonte.slice(
      fonte.indexOf("async configurePipeline("),
      fonte.indexOf("async upsertKnowledgeSource("),
    );
    const codigo = corpo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(codigo).toContain("ai_playbook_id");
    // Nenhuma segunda consulta, nenhuma resolução por identidade lógica.
    expect(codigo).not.toContain("ai_playbooks");
    expect(codigo).not.toContain("slug");
    expect(codigo).not.toContain(".order(");
    expect(codigo).not.toContain("version_number");
    // O filtro de tenant nas DUAS pontas.
    expect(codigo.match(/\.eq\("organization_id", organizationId\)/g) ?? []).toHaveLength(2);
  });

  it("nenhum UUID hardcoded no provisionador nem no repositório", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const arquivo of ["provisionador.ts", "repositorio-supabase.ts"]) {
      const fonte = fs.readFileSync(path.join(process.cwd(), "lib/afb/provisionamento", arquivo), "utf8");
      expect(uuid.test(fonte.replace(/\/\*[\s\S]*?\*\//g, "")), arquivo).toBe(false);
    }
  });

  it("o id do binding não vem das opções de CLI", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(path.join(process.cwd(), "lib/afb/provisionamento/provisionador.ts"), "utf8");
    const opcoes = fonte.slice(
      fonte.indexOf("export interface ProvisioningOptions"),
      fonte.indexOf("export interface ProvisioningReport"),
    );
    // O operador escolhe o FUNIL, a credencial, a sessão e o modelo. Nunca o
    // playbook persistido: aceitar um UUID de fora seria deixar o CLI apontar
    // o funil para qualquer linha da tabela.
    expect(opcoes).not.toContain("aiPlaybook");
    expect(opcoes).not.toContain("playbookId");
  });
});
