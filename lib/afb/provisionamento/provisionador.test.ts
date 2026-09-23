import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { papelDaEtapaDoFunil } from "@/lib/afb/playbook/mapeamento";
import { AFB_COMERCIAL_V1 } from "@/lib/afb/playbooks/comercial";
import { catalogEntry } from "@/lib/mcp/tools/catalog";
import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";
import { deRegistryParaDefinicao } from "@/lib/playbooks/adaptador-afb";

import {
  AFB_AGENT_NAME,
  AFB_ALLOWED_TOOL_IDS,
  AFB_BLOCKED_CRITICAL_TOOL_IDS,
  AFB_KNOWLEDGE_SOURCES,
  AFB_MEMORY_TITLE,
  AFB_PLAYBOOK_ID,
  AFB_PLAYBOOK_PERSISTIDO,
  OPENAI_CREDENTIAL_WARNING,
} from "./configuracao";
import {
  carregarDocumentosAfb,
  type DocumentoAfbCarregado,
  type DocumentosAfbCarregados,
  type MemoriaAfbCarregada,
} from "./documentos";
import {
  buildAfbPipelineSettings,
  ProvisioningInputError,
  provisionAfbCommercialOutbound,
  type AfbProvisioningAuditSummary,
  type AfbProvisioningRepository,
  type AgentBootstrapInput,
  type AgentUpsertResult,
  type ExistingPlaybookRef,
  playbookPlan,
  type PlaybookBootstrapInput,
  type PlaybookUpsertResult,
  type ProvisioningSnapshot,
  type UpsertResult,
} from "./provisionador";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const PIPELINE = "00000000-0000-4000-8000-000000000010";
const CREDENTIAL = "00000000-0000-4000-8000-000000000020";
const SESSION = "00000000-0000-4000-8000-000000000030";
const STAGE = "00000000-0000-4000-8000-000000000040";
const PLAYBOOK = "00000000-0000-4000-8000-000000000060";

function snapshot(): ProvisioningSnapshot {
  return {
    organization: { id: ORG, slug: "afb", displayName: "AFB" },
    pipelines: [
      {
        id: PIPELINE,
        name: "Piloto atual",
        isArchived: false,
        settings: {
          futuro: "preservar",
          modulos: {
            copiloto_comercial: {
              enabled: false,
              playbook_id: AFB_PLAYBOOK_ID,
              etapas: { [STAGE]: "conversa" },
              humano: "preservar",
            },
          },
        },
      },
    ],
    credentials: [
      {
        id: CREDENTIAL,
        label: "OpenAI validada",
        provider: "openai",
        isActive: true,
        validatedAt: "2026-09-20T10:00:00.000Z",
        validationError: null,
        modelsAvailable: ["openai-general"],
      },
    ],
    channelSessions: [
      { id: SESSION, displayName: "WhatsApp piloto", status: "WORKING", archivedAt: null },
    ],
    models: [
      {
        model_id: "openai-general",
        is_default_for_provider: true,
        supports_tools: true,
        input_price_per_million_cents: 100,
        output_price_per_million_cents: 200,
      },
    ],
    knowledgeSources: [],
    memoryEntriesWithTitle: 0,
    memory: null,
    agent: null,
    playbook: null,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Toda copy oficial do playbook montado, colhida do próprio objeto.
 *
 * A travessia procura a chave `texto`, que é como o playbook nomeia a copy em todos os
 * seus módulos (objeções, cadência, WhatsApp, ligação, e-mail, reunião). Derivar em vez
 * de digitar é o que faz o gate envelhecer bem: copy nova entra vigiada sem ninguém
 * lembrar de atualizar este arquivo.
 */
function coletarCopiesOficiais(valor: unknown, encontradas: string[] = []): string[] {
  if (Array.isArray(valor)) {
    for (const item of valor) coletarCopiesOficiais(item, encontradas);
    return encontradas;
  }
  if (valor && typeof valor === "object") {
    for (const [chave, item] of Object.entries(valor as Record<string, unknown>)) {
      if (chave === "texto" && typeof item === "string" && item.trim().length > 0) {
        encontradas.push(item.trim());
      } else {
        coletarCopiesOficiais(item, encontradas);
      }
    }
  }
  return encontradas;
}

class FakeRepository implements AfbProvisioningRepository {
  state = snapshot();
  foreignState = { organizationId: OTHER_ORG, agents: 1, sources: 2, memories: 1 };
  writes = { pipeline: 0, sources: 0, memories: 0, agents: 0, versions: 0, indexes: 0, audits: 0 };
  lastAgent: AgentBootstrapInput | null = null;
  inspected: string[] = [];
  memoryContent: string | null = null;
  private agentSignature: string | null = null;

  async inspect(identifier: string): Promise<ProvisioningSnapshot | null> {
    this.inspected.push(identifier);
    if (identifier !== ORG && identifier !== "afb") return null;
    return structuredClone(this.state);
  }

  async configurePipeline(organizationId: string, pipelineId: string): Promise<boolean> {
    expect(organizationId).toBe(ORG);
    const pipeline = this.state.pipelines.find((item) => item.id === pipelineId)!;
    const next = buildAfbPipelineSettings(pipeline.settings);
    const changed = JSON.stringify(next) !== JSON.stringify(pipeline.settings);
    if (changed) {
      pipeline.settings = next;
      this.writes.pipeline++;
    }
    return changed;
  }

  async upsertKnowledgeSource(
    organizationId: string,
    source: DocumentoAfbCarregado,
  ): Promise<UpsertResult> {
    expect(organizationId).toBe(ORG);
    const current = this.state.knowledgeSources.find(
      (item) => item.bootstrapKey === source.key || (item.bootstrapKey === null && item.name === source.title),
    );
    if (current) {
      const changed = current.documentSha256 !== source.sha256 || current.name !== source.title;
      if (changed) {
        current.name = source.title;
        current.bootstrapKey = source.key;
        current.documentSha256 = source.sha256;
        this.writes.sources++;
      }
      return { id: current.id, created: false, changed };
    }
    const id = `00000000-0000-4000-8000-${String(this.state.knowledgeSources.length + 100).padStart(12, "0")}`;
    this.state.knowledgeSources = [
      ...this.state.knowledgeSources,
      {
        id,
        name: source.title,
        bootstrapKey: source.key,
        documentSha256: source.sha256,
        activeVersionId: null,
        isActive: true,
        sourceType: "faq",
        status: "ready",
        faqItems: [{ question: source.question, tags: [] }],
      },
    ];
    this.writes.sources++;
    return { id, created: true, changed: true };
  }

  async upsertMemory(organizationId: string, memory: MemoriaAfbCarregada): Promise<UpsertResult> {
    expect(organizationId).toBe(ORG);
    if (this.state.memoryEntriesWithTitle === 1) {
      const changed = this.memoryContent !== memory.content;
      if (changed) {
        this.memoryContent = memory.content;
        this.state.memory = {
          id: "00000000-0000-4000-8000-000000000050",
          body: memory.content,
          source: "manual",
          status: "active",
        };
        this.writes.memories++;
      }
      return { id: "00000000-0000-4000-8000-000000000050", created: false, changed };
    }
    this.state.memoryEntriesWithTitle = 1;
    this.memoryContent = memory.content;
    this.state.memory = {
      id: "00000000-0000-4000-8000-000000000050",
      body: memory.content,
      source: "manual",
      status: "active",
    };
    this.writes.memories++;
    return { id: "00000000-0000-4000-8000-000000000050", created: true, changed: true };
  }

  async upsertAgent(input: AgentBootstrapInput): Promise<AgentUpsertResult> {
    expect(input.organizationId).toBe(ORG);
    this.lastAgent = structuredClone(input);
    const signature = JSON.stringify(input);
    const created = this.state.agent === null;
    const changed = created || signature !== this.agentSignature;
    if (created) {
      this.state.agent = {
        id: "00000000-0000-4000-8000-000000000060",
        name: input.name,
        kind: "mcp_agent",
        archivedAt: null,
      };
      this.writes.agents++;
    }
    if (changed) this.writes.versions++;
    this.agentSignature = signature;
    return {
      id: this.state.agent!.id,
      versionId: "00000000-0000-4000-8000-000000000061",
      created,
      changed,
      versionCreated: changed,
      published: true,
    };
  }

  async requestKnowledgeIndex(organizationId: string, sourceId: string): Promise<void> {
    expect(organizationId).toBe(ORG);
    const source = this.state.knowledgeSources.find((item) => item.id === sourceId)!;
    source.activeVersionId = `index-${sourceId}`;
    this.writes.indexes++;
  }

  async recordAudit(organizationId: string, summary: AfbProvisioningAuditSummary): Promise<void> {
    expect(organizationId).toBe(ORG);
    this.ultimaAuditoria = summary;
    this.writes.audits++;
  }

  // ── Playbook persistido (Fase B) ────────────────────────────────────────
  //
  // O fake imita o CONTRATO do banco, não o SQL: quem prova o SQL (constraints,
  // RPC, numeração sob lock) é `tests/invariants/afb-playbook-bootstrap.test.ts`,
  // contra o schema real.
  playbookEnviado: PlaybookBootstrapInput | null = null;
  ultimaAuditoria: unknown = null;
  playbookWrites = { created: 0, published: 0, adopted: 0 };
  playbookVersions: Array<{ id: string; number: number; sha: string }> = [];

  async createAndPublishPlaybook(input: PlaybookBootstrapInput): Promise<PlaybookUpsertResult> {
    expect(input.organizationId).toBe(ORG);
    this.playbookEnviado = structuredClone(input) as PlaybookBootstrapInput;
    expect(this.state.playbook).toBeNull();
    this.playbookWrites.created++;
    this.state.playbook = {
      id: PLAYBOOK,
      slug: input.slug,
      name: input.name,
      status: "draft",
      bootstrapKey: input.slug,
      publishedVersionId: null,
      publishedVersionSha256: null,
      publishedVersionNumber: null,
      draftSha256: input.definitionSha256,
    };
    const publicado = await this.publishPlaybookVersion({ ...input, playbookId: PLAYBOOK });
    return { ...publicado, created: true };
  }

  async publishPlaybookVersion(
    input: PlaybookBootstrapInput & { playbookId: string },
  ): Promise<PlaybookUpsertResult> {
    expect(input.organizationId).toBe(ORG);
    this.playbookEnviado = structuredClone(input) as PlaybookBootstrapInput;
    const alvo = this.state.playbook!;
    expect(alvo.id).toBe(input.playbookId);
    this.playbookWrites.published++;
    const numero = this.playbookVersions.length + 1;
    const versao = { id: `${PLAYBOOK}-v${numero}`, number: numero, sha: input.definitionSha256 };
    this.playbookVersions.push(versao);
    this.state.playbook = {
      ...alvo,
      status: "published",
      publishedVersionId: versao.id,
      publishedVersionSha256: versao.sha,
      publishedVersionNumber: numero,
      draftSha256: null,
    };
    return { id: input.playbookId, versionId: versao.id, versionNumber: numero, created: false, published: true, adopted: false };
  }

  async adoptPlaybook(organizationId: string, playbookId: string): Promise<PlaybookUpsertResult> {
    expect(organizationId).toBe(ORG);
    this.playbookWrites.adopted++;
    const alvo = this.state.playbook!;
    // Adoção grava SÓ a marca: id, versões e conteúdo ficam como estavam.
    this.state.playbook = { ...alvo, bootstrapKey: AFB_PLAYBOOK_PERSISTIDO.slug };
    return {
      id: playbookId,
      versionId: alvo.publishedVersionId,
      versionNumber: alvo.publishedVersionNumber,
      created: false,
      published: false,
      adopted: true,
    };
  }
}

async function documentosComConhecimentoAlterado(): Promise<DocumentosAfbCarregados> {
  const documents = await carregarDocumentosAfb();
  const original = documents.knowledge[0]!;
  const content = `${original.content}\nContexto revisado para o teste.\n`;
  return {
    ...documents,
    knowledge: [{ ...original, content, sha256: sha256(content) }, ...documents.knowledge.slice(1)],
  };
}

async function fonteManualCompativel(key: string) {
  const document = (await carregarDocumentosAfb()).knowledge.find((item) => item.key === key)!;
  return {
    id: "00000000-0000-4000-8000-000000000099",
    name: document.title,
    bootstrapKey: null,
    documentSha256: null,
    activeVersionId: "manual-version",
    isActive: true,
    sourceType: "faq",
    status: "ready",
    faqItems: [{ question: document.question, tags: [] }],
  };
}

describe("bootstrap AFB Comercial Outbound assistido", () => {
  it("é dry-run por padrão e não escreve", async () => {
    const repository = new FakeRepository();
    const report = await provisionAfbCommercialOutbound(repository, { organization: "afb" });
    expect(report.mode).toBe("dry-run");
    expect(report.applied).toBe(false);
    expect(Object.values(repository.writes).every((count) => count === 0)).toBe(true);
  });

  it("planeja criar as nove fontes ausentes sem escrever no dry-run", async () => {
    const repository = new FakeRepository();
    const report = await provisionAfbCommercialOutbound(repository, { organization: "afb" });

    expect(report.knowledge).toHaveLength(9);
    expect(report.knowledge.every((source) => source.action === "create")).toBe(true);
    expect(repository.state.knowledgeSources).toHaveLength(0);
  });

  it("adota uma fonte manual única e compatível sem trocar seu source_id", async () => {
    const repository = new FakeRepository();
    const manual = await fonteManualCompativel("processo-comercial-outbound");
    repository.state.knowledgeSources = [manual];

    const dryRun = await provisionAfbCommercialOutbound(repository, { organization: ORG });
    expect(dryRun.knowledge.find((item) => item.name === manual.name)?.action).toBe("adopt");

    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    expect(repository.state.knowledgeSources).toHaveLength(9);
    expect(repository.state.knowledgeSources[0]).toMatchObject({
      id: manual.id,
      bootstrapKey: "processo-comercial-outbound",
    });

    const second = await provisionAfbCommercialOutbound(repository, { organization: ORG });
    expect(second.knowledge.find((item) => item.name === manual.name)?.action).toBe("unchanged");
  });

  it("mantém conflict para fonte manual duplicada, arquivada, incompatível ou pertencente a outra chave", async () => {
    const scenarios: Array<(repository: FakeRepository) => Promise<void>> = [
      async (repository) => {
        const manual = await fonteManualCompativel("qualificacao-comercial");
        repository.state.knowledgeSources = [manual, { ...manual, id: "00000000-0000-4000-8000-000000000098" }];
      },
      async (repository) => {
        const manual = await fonteManualCompativel("qualificacao-comercial");
        repository.state.knowledgeSources = [{ ...manual, isActive: false }];
      },
      async (repository) => {
        const manual = await fonteManualCompativel("qualificacao-comercial");
        repository.state.knowledgeSources = [{ ...manual, sourceType: "document" }];
      },
      async (repository) => {
        const manual = await fonteManualCompativel("qualificacao-comercial");
        repository.state.knowledgeSources = [{ ...manual, bootstrapKey: "outra-chave-afb" }];
      },
    ];

    for (const setup of scenarios) {
      const repository = new FakeRepository();
      await setup(repository);
      const report = await provisionAfbCommercialOutbound(repository, { organization: ORG });
      expect(report.knowledge.find((item) => item.name === "AFB — Qualificação comercial")?.action).toBe(
        "conflict",
      );
    }
  });

  it("duas execuções não duplicam agente, versão, conhecimento nem memória", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    expect(repository.writes.agents).toBe(1);
    expect(repository.writes.versions).toBe(1);
    expect(repository.writes.sources).toBe(AFB_KNOWLEDGE_SOURCES.length);
    expect(repository.state.knowledgeSources).toHaveLength(AFB_KNOWLEDGE_SOURCES.length);
    expect(repository.writes.memories).toBe(1);
  });

  it("atualiza a mesma fonte quando o conteúdo muda", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    const sourceId = repository.state.knowledgeSources[0]!.id;
    const documents = await documentosComConhecimentoAlterado();

    const report = await provisionAfbCommercialOutbound(
      repository,
      { organization: ORG, apply: true },
      { loadDocuments: async () => documents },
    );

    expect(report.knowledge[0]?.action).toBe("update");
    expect(repository.state.knowledgeSources[0]).toMatchObject({
      id: sourceId,
      documentSha256: documents.knowledge[0]!.sha256,
    });
    expect(repository.state.knowledgeSources).toHaveLength(AFB_KNOWLEDGE_SOURCES.length);
    expect(repository.writes.sources).toBe(AFB_KNOWLEDGE_SOURCES.length + 1);

    await provisionAfbCommercialOutbound(
      repository,
      { organization: ORG, apply: true },
      { loadDocuments: async () => documents },
    );
    expect(repository.writes.sources).toBe(AFB_KNOWLEDGE_SOURCES.length + 1);
  });

  it("lê os nove documentos versionados nos caminhos declarados", async () => {
    const documents = await carregarDocumentosAfb();
    expect(documents.knowledge).toHaveLength(9);

    for (const config of AFB_KNOWLEDGE_SOURCES) {
      const loaded = documents.knowledge.find((document) => document.key === config.key)!;
      const raw = await readFile(path.resolve(process.cwd(), config.documentPath), "utf8");
      expect(loaded.documentPath).toBe(config.documentPath);
      expect(loaded.content).toBe(`${raw.replace(/\r\n/g, "\n").trim()}\n`);
      expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(loaded.content).toContain(`titulo: ${config.title}`);
    }
  });

  it("declara chaves, caminhos, perguntas e versões canônicos para as nove fontes", () => {
    expect(AFB_KNOWLEDGE_SOURCES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "empresa_posicionamento",
          documentPath: "docs/afb/knowledge/empresa-posicionamento.md",
          version: "2",
          question:
            "Como a AFB se posiciona comercialmente, quais são suas principais especialidades e qual é a estratégia da campanha outbound?",
        }),
        expect.objectContaining({
          key: "servicos",
          documentPath: "docs/afb/knowledge/portfolio-servicos.md",
          version: "2",
          question:
            "Quais serviços e frentes de consultoria a AFB oferece e em quais contextos eles podem ser avaliados?",
        }),
        expect.objectContaining({
          key: "metodo_gmt",
          documentPath: "docs/afb/knowledge/metodo-gmt.md",
          version: "2",
          question:
            "Como funciona o Relatório GMT, o que ele analisa e o que é gratuito ou contratado separadamente?",
        }),
        expect.objectContaining({
          key: "mercado_livre_assinatura",
          documentPath: "docs/afb/knowledge/mercado-livre-energia-assinatura.md",
          version: "2",
          question:
            "Como a AFB atua na análise de Mercado Livre de Energia e energia por assinatura, quais benefícios podem existir e como a negociação é conduzida?",
        }),
        expect.objectContaining({
          key: "objecoes",
          documentPath: "docs/afb/knowledge/objecoes-contexto.md",
          version: "2",
          question:
            "Como o Copilot da AFB deve identificar, interpretar e tratar objeções comerciais durante a prospecção outbound?",
        }),
        expect.objectContaining({
          key: "privacidade_optout",
          documentPath: "docs/afb/knowledge/privacidade-consentimento.md",
          version: "2",
          question: "Quais limites de privacidade e contato devem ser respeitados?",
        }),
        expect.objectContaining({
          key: "processo-comercial-outbound",
          documentPath: "docs/afb/knowledge/processo-comercial-outbound.md",
          version: "1",
          question:
            "Como funciona o processo comercial outbound da AFB e qual é o objetivo do Copilot antes e depois de cada reunião?",
        }),
        expect.objectContaining({
          key: "qualificacao-comercial",
          documentPath: "docs/afb/knowledge/qualificacao-comercial.md",
          version: "2",
          question:
            "Como funciona a qualificação comercial da AFB antes e depois da primeira reunião e como o Formulário Diagnóstico da Instalação Elétrica deve ser utilizado para identificar oportunidades?",
        }),
        expect.objectContaining({
          key: "reunioes-agenda-proximos-passos",
          documentPath: "docs/afb/knowledge/reunioes-agenda-proximos-passos.md",
          version: "2",
          question:
            "Como o Copilot da AFB deve conduzir agendamento, confirmação, lembretes, remarcação, no-show, conflitos de agenda, handoff humano e próximos passos da Reunião 1 e da Reunião 2?",
        }),
      ]),
    );
    expect(new Set(AFB_KNOWLEDGE_SOURCES.map((source) => source.key)).size).toBe(9);
    expect(new Set(AFB_KNOWLEDGE_SOURCES.map((source) => source.documentPath)).size).toBe(9);
  });

  it("não mantém o conteúdo comercial longo em configuracao.ts", async () => {
    const configSource = await readFile(path.resolve(__dirname, "configuracao.ts"), "utf8");
    expect(configSource).not.toContain("A AFB Engenharia & Consultoria atua");
    expect(configSource).not.toContain("A análise de fatura observa");
    for (const source of AFB_KNOWLEDGE_SOURCES) {
      expect(configSource).toContain(source.documentPath);
    }
  });

  it("não duplica o playbook nem as copies oficiais como Knowledge", async () => {
    const documents = await carregarDocumentosAfb();
    const objections = documents.knowledge.find((document) => document.key === "objecoes")!;

    // (A) O Knowledge nomeia o playbook operacional como dono das copies. Cobra o
    // IDENTIFICADOR do playbook, nunca o caminho do arquivo que hoje o implementa: esse
    // caminho é detalhe de implementação e morre quando o playbook passar a ser resolvido
    // pelo Gerenciador de Playbooks.
    //
    // A proibição de o Knowledge citar `lib/...` NÃO mora aqui, e a razão é de
    // fronteira: quem reescreve esse trecho do Markdown é a frente de Knowledge,
    // e uma asserção que exige o texto novo faz esta suíte depender de um arquivo
    // que esta cadeia de commits não traz — foi esse acoplamento que a auditoria
    // em checkout limpo pegou. A regra volta junto com o Markdown que a satisfaz.
    expect(objections.content).toContain(AFB_COMERCIAL_V1.id);
    expect(objections.content).toMatch(/copies oficiais[^.]*playbook/i);

    // (B) Nenhuma copy oficial aparece integralmente em material nenhum. A lista é
    // DERIVADA do playbook montado, não digitada aqui: copy nova nasce vigiada, e copy
    // renomeada não escapa. A menor copy tem 140 caracteres, então `toContain` não produz
    // coincidência acidental.
    const copies = coletarCopiesOficiais(AFB_COMERCIAL_V1);
    expect(copies.length).toBeGreaterThanOrEqual(AFB_COMERCIAL_V1.objecoes.length);
    for (const document of [...documents.knowledge, documents.memory]) {
      for (const copy of copies) {
        expect(document.content, `${document.title} duplica copy oficial do playbook`).not.toContain(
          copy,
        );
      }
    }

    expect(
      AFB_KNOWLEDGE_SOURCES.some((source) => source.documentPath.endsWith("afb-comercial-v1.html")),
    ).toBe(false);
  });

  it("mantém a memória idempotente e atualiza a mesma entrada quando o documento muda", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    expect(repository.writes.memories).toBe(1);
    expect(repository.state.memoryEntriesWithTitle).toBe(1);
    expect(
      (await provisionAfbCommercialOutbound(repository, { organization: ORG })).memory.action,
    ).toBe("unchanged");

    const documents = await carregarDocumentosAfb();
    const content = `${documents.memory.content}\nLimite adicional de teste.\n`;
    const changed = {
      ...documents,
      memory: { ...documents.memory, content, sha256: sha256(content) },
    };
    await provisionAfbCommercialOutbound(
      repository,
      { organization: ORG, apply: true },
      { loadDocuments: async () => changed },
    );
    expect(repository.writes.memories).toBe(2);
    expect(repository.state.memoryEntriesWithTitle).toBe(1);
  });

  it("não lê nem contém segredos nos documentos AFB", async () => {
    const documents = await carregarDocumentosAfb();
    const all = [...documents.knowledge, documents.memory];
    for (const document of all) {
      expect(document.documentPath).toMatch(/^docs\/afb\/(knowledge|memory)\/.+\.md$/);
      expect(document.documentPath).not.toContain(".env");
      expect(document.content).not.toMatch(/\bsk-[A-Za-z0-9_-]{12,}\b/);
      expect(document.content).not.toMatch(
        /(OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|DB_PASSWORD|[A-Z0-9]+_SECRET)\s*[:=]/,
      );
    }
  });

  it("não expõe segredo nem o campo last4 no relatório", async () => {
    const repository = new FakeRepository();
    const report = await provisionAfbCommercialOutbound(repository, { organization: ORG });
    const output = JSON.stringify(report);
    expect(output).not.toContain("OPENAI_API_KEY");
    expect(output).not.toContain("service_role");
    expect(output).not.toContain("last4");
  });

  it("exige organização explícita e nunca escolhe a primeira", async () => {
    const repository = new FakeRepository();
    await expect(
      provisionAfbCommercialOutbound(repository, { organization: "" }),
    ).rejects.toBeInstanceOf(ProvisioningInputError);
    expect(repository.inspected).toEqual([]);
    await expect(
      provisionAfbCommercialOutbound(repository, { organization: "inexistente" }),
    ).rejects.toThrow("Organização não encontrada");
    expect(repository.inspected).toEqual(["inexistente"]);
  });

  it("múltiplas credenciais OpenAI validadas exigem seleção explícita", async () => {
    const repository = new FakeRepository();
    repository.state.credentials = [
      ...repository.state.credentials,
      {
        ...repository.state.credentials[0]!,
        id: "00000000-0000-4000-8000-000000000021",
        label: "OpenAI segunda",
      },
    ];
    await expect(provisionAfbCommercialOutbound(repository, { organization: ORG })).rejects.toThrow(
      "--credential",
    );
  });

  it("múltiplos funis já configurados exigem seleção explícita", async () => {
    const repository = new FakeRepository();
    repository.state.pipelines = [
      ...repository.state.pipelines,
      {
        ...repository.state.pipelines[0]!,
        id: "00000000-0000-4000-8000-000000000011",
        name: "Outro piloto configurado",
      },
    ];
    await expect(provisionAfbCommercialOutbound(repository, { organization: ORG })).rejects.toThrow(
      "--pipeline",
    );
  });

  it("credencial ausente emite o aviso exato e ainda prepara os dados sem agente", async () => {
    const repository = new FakeRepository();
    repository.state.credentials = [];
    const report = await provisionAfbCommercialOutbound(repository, {
      organization: ORG,
      apply: true,
    });
    expect(report.warnings).toContain(OPENAI_CREDENTIAL_WARNING);
    expect(repository.writes.sources).toBe(AFB_KNOWLEDGE_SOURCES.length);
    expect(repository.writes.memories).toBe(1);
    expect(repository.writes.agents).toBe(0);
  });

  it("mantém o agente assistido, sem envio normal, follow-up, operador ou tools críticas", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    expect(repository.lastAgent).toMatchObject({
      name: AFB_AGENT_NAME,
      operationMode: "assisted",
      normalAutoSendEnabled: false,
      executionPolicy: "require_human_approval",
      followup: { enabled: false, flow_pointer_ids: [] },
      operatorEnabled: false,
      operatorToolIds: [],
      handoffToolEnabled: true,
      casesEnabled: true,
    });
    expect(repository.lastAgent?.toolIds).toEqual(AFB_ALLOWED_TOOL_IDS);
    for (const critical of AFB_BLOCKED_CRITICAL_TOOL_IDS) {
      expect(repository.lastAgent?.toolIds).not.toContain(critical);
    }
    for (const toolId of AFB_ALLOWED_TOOL_IDS) {
      expect(catalogEntry(toolId), toolId).toMatchObject({ category: "read", risco: "seguro" });
    }
  });

  it("usa playbook correto e preserva etapas por UUID e propriedades humanas", () => {
    const current = snapshot().pipelines[0]!.settings;
    const result = buildAfbPipelineSettings(current);
    expect(result).toMatchObject({
      futuro: "preservar",
      modulos: {
        copiloto_comercial: {
          enabled: true,
          playbook_id: AFB_PLAYBOOK_ID,
          etapas: { [STAGE]: "conversa" },
          humano: "preservar",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("nome_da_coluna");
  });

  it("ganho e perdido continuam autoritativos por is_won/is_lost", () => {
    const config = { etapas: { [STAGE]: "conversa" as const }, descartadas: 0 };
    expect(papelDaEtapaDoFunil({ id: STAGE, is_won: true, is_lost: false }, config)).toMatchObject({
      papel: { id: "ganho" },
      origem: "marcacao",
    });
    expect(papelDaEtapaDoFunil({ id: STAGE, is_won: false, is_lost: true }, config)).toMatchObject({
      papel: { id: "perdido" },
      origem: "marcacao",
    });
  });

  it("documenta D12 e todos os toques escritos desta fase como WhatsApp, sem e-mail", () => {
    const d12 = AFB_COMERCIAL_V1.followup.toques.find((touch) => touch.dia === 12)!;
    expect(d12.canal).toBe("whatsapp");
    expect(d12.mensagem?.canal).toBe("whatsapp");
    expect(
      AFB_COMERCIAL_V1.followup.toques
        .filter((touch) => touch.canal !== "telefone")
        .every((touch) => touch.canal === "whatsapp" && touch.mensagem?.canal !== "email"),
    ).toBe(true);
  });

  it("não instala skills, não cria follow-up nem agenda", async () => {
    expect(AFB_ALLOWED_TOOL_IDS.some((id) => id.startsWith("afb-"))).toBe(false);
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true });
    expect(repository.lastAgent?.followup).toEqual({ enabled: false, flow_pointer_ids: [] });
    expect(repository.lastAgent?.toolIds).toContain("crm_find_free_slots");
    expect(repository.lastAgent?.toolIds).not.toContain("crm_book_appointment");
  });

  it("mantém isolamento do tenant em todas as escritas", async () => {
    const repository = new FakeRepository();
    const foreignBefore = structuredClone(repository.foreignState);
    await provisionAfbCommercialOutbound(repository, { organization: "afb", apply: true });
    expect(repository.foreignState).toEqual(foreignBefore);
    expect(repository.inspected).toEqual(["afb"]);
  });

  it("define nove materiais separados e uma única memória estável", () => {
    expect(AFB_KNOWLEDGE_SOURCES).toHaveLength(9);
    expect(new Set(AFB_KNOWLEDGE_SOURCES.map((source) => source.title)).size).toBe(9);
    expect(AFB_MEMORY_TITLE).toBe("AFB — Princípios comerciais e limites");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fase B — o playbook PERSISTIDO
//
// O plano é conservador por construção: nunca republica, nunca sobrescreve e
// só toma posse com prova de sha. Nenhuma decisão olha o NOME.
// ───────────────────────────────────────────────────────────────────────────

const DEFINICAO = deRegistryParaDefinicao(AFB_COMERCIAL_V1);

function playbookExistente(over: Partial<ExistingPlaybookRef> = {}): ExistingPlaybookRef {
  return {
    id: PLAYBOOK,
    slug: AFB_PLAYBOOK_PERSISTIDO.slug,
    name: AFB_PLAYBOOK_PERSISTIDO.name,
    status: "published",
    bootstrapKey: AFB_PLAYBOOK_PERSISTIDO.slug,
    publishedVersionId: PLAYBOOK + "-v1",
    publishedVersionSha256: DEFINICAO.sha256,
    publishedVersionNumber: 1,
    draftSha256: null,
    ...over,
  };
}

const planoDe = (existing: ExistingPlaybookRef | null) =>
  playbookPlan(existing, DEFINICAO.sha256, AFB_PLAYBOOK_PERSISTIDO.slug);

const semVersao = {
  status: "draft",
  publishedVersionId: null,
  publishedVersionSha256: null,
  publishedVersionNumber: null,
} as const;

describe("Fase B — plano do playbook persistido", () => {
  it("1. não existe → create", () => {
    expect(planoDe(null).action).toBe("create");
  });

  it("2. é nosso e a versão publicada tem o mesmo sha → unchanged", () => {
    expect(planoDe(playbookExistente()).action).toBe("unchanged");
  });

  it("3. é nosso e a versão publicada tem sha diferente → conflict (não republica por cima de gente)", () => {
    const plano = planoDe(
      playbookExistente({ publishedVersionSha256: "f".repeat(64), publishedVersionNumber: 4 }),
    );
    expect(plano.action).toBe("conflict");
    expect(plano.reason).toMatch(/conteúdo diferente/);
  });

  it("4. existe com o nosso slug mas SEM marca de propriedade → conflict, mesmo com o nome igual", () => {
    const plano = planoDe(
      playbookExistente({ bootstrapKey: null, publishedVersionSha256: "e".repeat(64) }),
    );
    expect(plano.action).toBe("conflict");
    expect(plano.reason).toMatch(/não pertence ao bootstrap/);
  });

  it("5. sem marca de propriedade, mas com versão publicada IDÊNTICA → adopt (prova por sha)", () => {
    expect(planoDe(playbookExistente({ bootstrapKey: null })).action).toBe("adopt");
  });

  it("5'. sem marca e sem versão publicada → conflict: não há o que provar", () => {
    expect(
      planoDe(playbookExistente({ bootstrapKey: null, ...semVersao, draftSha256: DEFINICAO.sha256 }))
        .action,
    ).toBe("conflict");
  });

  it("6. falha parcial: é nosso, sem versão publicada, com o draft certo → publish (retomada)", () => {
    expect(planoDe(playbookExistente({ ...semVersao, draftSha256: DEFINICAO.sha256 })).action).toBe(
      "publish",
    );
  });

  it("6'. é nosso, sem versão publicada, com draft DIFERENTE → conflict (alguém editou)", () => {
    expect(
      planoDe(playbookExistente({ ...semVersao, draftSha256: "a".repeat(64) })).action,
    ).toBe("conflict");
  });

  it("10. nenhuma decisão depende do nome visual: renomear não muda o plano", () => {
    expect(planoDe(playbookExistente({ name: "Outro nome qualquer" })).action).toBe("unchanged");
    expect(planoDe(playbookExistente({ name: "", bootstrapKey: null })).action).toBe("adopt");
  });
});

describe("Fase B — o provisionador executa o plano", () => {
  it("7/8. a definição e o hash vêm do ADAPTADOR, nunca de constante no provisionador", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    expect(repository.playbookEnviado?.definition).toEqual(DEFINICAO.definition);
    expect(repository.playbookEnviado?.definitionSha256).toBe(DEFINICAO.sha256);
    expect(repository.playbookEnviado?.definitionSha256).toBe(canonicalHash(DEFINICAO.definition));
    expect(repository.playbookEnviado?.slug).toBe("afb_comercial");
  });

  it("9. a configuração não duplica conteúdo: só identidade, e o legado fica como referência", () => {
    expect(Object.keys(AFB_PLAYBOOK_PERSISTIDO).sort()).toEqual([
      "description",
      "legacyId",
      "name",
      "slug",
    ]);
    expect(AFB_PLAYBOOK_PERSISTIDO.slug).toBe("afb_comercial");
    expect(AFB_PLAYBOOK_PERSISTIDO.legacyId).toBe(AFB_PLAYBOOK_ID);
    expect(AFB_PLAYBOOK_PERSISTIDO.slug).not.toBe(AFB_PLAYBOOK_ID);
    const texto = JSON.stringify(AFB_PLAYBOOK_PERSISTIDO);
    for (const copy of coletarCopiesOficiais(AFB_COMERCIAL_V1)) {
      expect(texto).not.toContain(copy.slice(0, 40));
    }
  });

  it("dry-run NÃO escreve nada do playbook e ainda assim declara a ação", async () => {
    const repository = new FakeRepository();
    const relatorio = await provisionAfbCommercialOutbound(repository, { organization: ORG }, { loadDocuments: carregarDocumentosAfb });
    expect(relatorio.persistedPlaybook).toMatchObject({
      slug: "afb_comercial",
      name: "AFB Comercial Outbound",
      action: "create",
      sha256: DEFINICAO.sha256,
    });
    expect(repository.playbookWrites).toEqual({ created: 0, published: 0, adopted: 0 });
    expect(relatorio.changes).toContain("create: playbook AFB Comercial Outbound");
  });

  it("IDEMPOTÊNCIA: 1º apply cria 1 playbook + v1; 2º e 3º ficam unchanged, sem v2", async () => {
    const repository = new FakeRepository();
    const primeiro = await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    expect(primeiro.persistedPlaybook.action).toBe("create");
    expect(repository.playbookWrites).toEqual({ created: 1, published: 1, adopted: 0 });
    expect(repository.playbookVersions.map((v) => v.number)).toEqual([1]);

    for (const _ of [2, 3]) {
      const seguinte = await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
      expect(seguinte.persistedPlaybook.action).toBe("unchanged");
    }
    expect(repository.playbookWrites).toEqual({ created: 1, published: 1, adopted: 0 });
    expect(repository.playbookVersions).toHaveLength(1);
    expect(repository.state.playbook?.publishedVersionNumber).toBe(1);
  });

  it("CONFLITO não escreve: a versão publicada diferente sobrevive intacta e vira aviso", async () => {
    const repository = new FakeRepository();
    repository.state.playbook = playbookExistente({
      publishedVersionSha256: "c".repeat(64),
      publishedVersionNumber: 7,
    });
    const relatorio = await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    expect(relatorio.persistedPlaybook.action).toBe("conflict");
    expect(repository.playbookWrites).toEqual({ created: 0, published: 0, adopted: 0 });
    expect(repository.state.playbook?.publishedVersionNumber).toBe(7);
    expect(relatorio.warnings.join(" ")).toMatch(/não será tocado/);
  });

  it("RETOMADA: ponteiro nosso sem versão publica a v1 sem criar um segundo ponteiro", async () => {
    const repository = new FakeRepository();
    repository.state.playbook = playbookExistente({ ...semVersao, draftSha256: DEFINICAO.sha256 });
    const relatorio = await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    expect(relatorio.persistedPlaybook.action).toBe("publish");
    expect(repository.playbookWrites).toEqual({ created: 0, published: 1, adopted: 0 });
    expect(repository.state.playbook?.id).toBe(PLAYBOOK);
    expect(repository.playbookVersions.map((v) => v.number)).toEqual([1]);
  });

  it("ADOÇÃO preserva id e versão: grava só a marca de propriedade", async () => {
    const repository = new FakeRepository();
    repository.state.playbook = playbookExistente({ bootstrapKey: null });
    const relatorio = await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    expect(relatorio.persistedPlaybook.action).toBe("adopt");
    expect(repository.playbookWrites).toEqual({ created: 0, published: 0, adopted: 1 });
    expect(repository.state.playbook).toMatchObject({
      id: PLAYBOOK,
      publishedVersionId: PLAYBOOK + "-v1",
      publishedVersionNumber: 1,
      bootstrapKey: "afb_comercial",
    });
    expect(repository.playbookVersions).toHaveLength(0);
  });

  it("o apply do playbook NÃO altera o binding do funil: segue afb_comercial_v1, sem uuid, slug, version_id ou mode", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    const modulo = (
      repository.state.pipelines[0]!.settings as {
        modulos: { copiloto_comercial: Record<string, unknown> };
      }
    ).modulos.copiloto_comercial;
    expect(modulo.playbook_id).toBe(AFB_PLAYBOOK_ID);
    expect(Object.keys(modulo).sort()).toEqual(["enabled", "etapas", "humano", "playbook_id"]);
  });

  it("a auditoria distingue a ação e carrega o sha, sem tipo de evento novo", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    expect(repository.ultimaAuditoria).toMatchObject({
      playbookAction: "create",
      playbookVersionNumber: 1,
      playbookSha256: DEFINICAO.sha256,
    });
  });

  it("o registro persistido não ganha campo de autonomia por nenhum caminho", async () => {
    const repository = new FakeRepository();
    await provisionAfbCommercialOutbound(repository, { organization: ORG, apply: true }, { loadDocuments: carregarDocumentosAfb });
    const enviado = JSON.stringify(repository.playbookEnviado);
    expect(enviado).not.toMatch(
      /"(mode|assisted|automatic|auto_send|approval_mode|autonomy_mode|require_human_approval)"/,
    );
  });
});
