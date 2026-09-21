import { escolherModeloDoProvedor } from "@/lib/ai/agents/escolher-modelo";
import { mergeConfiguracaoDeModulos, playbookIdDoCopiloto } from "@/lib/pipelines/modulos";

import {
  AFB_AGENT_NAME,
  AFB_ALLOWED_TOOL_IDS,
  AFB_BOOTSTRAP_VERSION,
  AFB_MEMORY_TITLE,
  AFB_PLAYBOOK_ID,
  AFB_SYSTEM_PROMPT,
  OPENAI_CREDENTIAL_WARNING,
} from "./configuracao";
import {
  carregarDocumentosAfb,
  type DocumentoAfbCarregado,
  type DocumentosAfbCarregados,
  type MemoriaAfbCarregada,
} from "./documentos";

export interface OrganizationRef {
  id: string;
  slug: string;
  displayName: string;
}

export interface PipelineRef {
  id: string;
  name: string;
  settings: unknown;
  isArchived: boolean;
}

export interface CredentialRef {
  id: string;
  label: string | null;
  provider: string;
  isActive: boolean;
  validatedAt: string | null;
  validationError: string | null;
  modelsAvailable: readonly string[];
}

export interface ChannelSessionRef {
  id: string;
  displayName: string | null;
  status: string;
  archivedAt: string | null;
}

export interface ModelRef {
  model_id: string;
  is_default_for_provider: boolean;
  supports_tools: boolean;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
}

export interface ExistingKnowledgeRef {
  id: string;
  name: string;
  bootstrapKey: string | null;
  documentSha256: string | null;
  activeVersionId: string | null;
  isActive: boolean;
  sourceType: string;
  status: string;
  faqItems: readonly { question: string | null; tags: readonly string[] }[];
}

export interface ExistingAgentRef {
  id: string;
  name: string;
  kind: string;
  archivedAt: string | null;
}

export interface ExistingMemoryRef {
  id: string;
  body: string;
  source: string;
  status: string;
}

export interface ProvisioningSnapshot {
  organization: OrganizationRef;
  pipelines: readonly PipelineRef[];
  credentials: readonly CredentialRef[];
  channelSessions: readonly ChannelSessionRef[];
  models: readonly ModelRef[];
  knowledgeSources: readonly ExistingKnowledgeRef[];
  memoryEntriesWithTitle: number;
  memory: ExistingMemoryRef | null;
  agent: ExistingAgentRef | null;
}

export interface AgentBootstrapInput {
  organizationId: string;
  pipelineId: string;
  credentialId: string;
  channelSessionId: string;
  model: string;
  knowledgeSourceIds: readonly string[];
  name: string;
  description: string;
  systemPrompt: string;
  operationMode: "assisted";
  priority: number;
  toolIds: readonly string[];
  triggerConfig: {
    events: ["message"];
    filters: {
      ignore_groups: true;
      ignore_self: true;
      keyword_regex: null;
      business_hours: null;
    };
    concurrency: "one_per_conversation";
  };
  handoffToolEnabled: true;
  casesEnabled: true;
  followup: { enabled: false; flow_pointer_ids: [] };
  operatorEnabled: false;
  operatorToolIds: [];
  executionPolicy: "require_human_approval";
  normalAutoSendEnabled: false;
}

export interface UpsertResult {
  id: string;
  changed: boolean;
  created: boolean;
}

export interface AgentUpsertResult extends UpsertResult {
  versionId: string;
  versionCreated: boolean;
  published: boolean;
}

export interface AfbProvisioningAuditSummary {
  pipelineChanged: boolean;
  knowledgeChanged: number;
  memoryChanged: boolean;
  agentChanged: boolean;
  documents: readonly {
    key: string;
    kind: "knowledge" | "memory";
    path: string;
    version: string;
    sha256: string;
  }[];
}

export interface AfbProvisioningRepository {
  inspect(organizationIdentifier: string): Promise<ProvisioningSnapshot | null>;
  configurePipeline(organizationId: string, pipelineId: string): Promise<boolean>;
  upsertKnowledgeSource(
    organizationId: string,
    source: DocumentoAfbCarregado,
  ): Promise<UpsertResult>;
  upsertMemory(organizationId: string, memory: MemoriaAfbCarregada): Promise<UpsertResult>;
  upsertAgent(input: AgentBootstrapInput): Promise<AgentUpsertResult>;
  requestKnowledgeIndex(organizationId: string, knowledgeSourceId: string): Promise<void>;
  recordAudit(organizationId: string, summary: AfbProvisioningAuditSummary): Promise<void>;
}

export interface ProvisioningOptions {
  organization: string;
  pipelineId?: string;
  credentialId?: string;
  channelSessionId?: string;
  model?: string;
  apply?: boolean;
}

export interface ProvisioningReport {
  mode: "dry-run" | "apply";
  organization: OrganizationRef;
  playbook: typeof AFB_PLAYBOOK_ID;
  pipeline: { id: string; name: string } | null;
  outboundPipelineFoundByName: boolean;
  credential: { id: string; label: string | null } | null;
  channelSession: { id: string; displayName: string | null } | null;
  model: string | null;
  agent: { name: string; readyToPublish: boolean; action: string };
  knowledge: readonly {
    name: string;
    documentPath: string;
    sha256: string;
    action: "create" | "adopt" | "update" | "unchanged" | "conflict";
  }[];
  memory: {
    title: string;
    documentPath: string;
    sha256: string;
    action: "create" | "update" | "unchanged" | "conflict";
  };
  changes: string[];
  warnings: string[];
  applied: boolean;
}

export class ProvisioningInputError extends Error {}

/** Altera apenas o módulo do Copilot; etapas e qualquer configuração vizinha sobrevivem. */
export function buildAfbPipelineSettings(settings: unknown): Record<string, unknown> {
  const root =
    typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {};
  const modulos =
    typeof root.modulos === "object" && root.modulos !== null && !Array.isArray(root.modulos)
      ? (root.modulos as Record<string, unknown>)
      : undefined;
  root.modulos = mergeConfiguracaoDeModulos(modulos, {
    copiloto_comercial: { enabled: true, playbook_id: AFB_PLAYBOOK_ID },
  });
  return root;
}

function selectPipeline(snapshot: ProvisioningSnapshot, requested?: string): PipelineRef | null {
  const active = snapshot.pipelines.filter((pipeline) => !pipeline.isArchived);
  if (requested) {
    const match = active.find((pipeline) => pipeline.id === requested);
    if (!match)
      throw new ProvisioningInputError(
        "O funil informado não existe na organização alvo ou está arquivado.",
      );
    return match;
  }
  const configured = active.filter(
    (pipeline) =>
      playbookIdDoCopiloto(
        typeof pipeline.settings === "object" &&
          pipeline.settings !== null &&
          !Array.isArray(pipeline.settings)
          ? (pipeline.settings as Record<string, unknown>)
          : undefined,
      ) === AFB_PLAYBOOK_ID,
  );
  if (configured.length > 1) {
    throw new ProvisioningInputError(
      `Há mais de um funil configurado com ${AFB_PLAYBOOK_ID}. Informe explicitamente --pipeline <uuid>.`,
    );
  }
  return configured.length === 1 ? configured[0]! : null;
}

function selectCredential(
  snapshot: ProvisioningSnapshot,
  requested?: string,
): CredentialRef | null {
  const valid = snapshot.credentials.filter(
    (credential) =>
      credential.provider === "openai" &&
      credential.isActive &&
      credential.validatedAt !== null &&
      credential.validationError === null,
  );
  if (requested) {
    const match = valid.find((credential) => credential.id === requested);
    if (!match) {
      throw new ProvisioningInputError(
        "A credencial informada não é uma credencial OpenAI ativa e validada da organização alvo.",
      );
    }
    return match;
  }
  if (valid.length > 1) {
    throw new ProvisioningInputError(
      "Há mais de uma credencial OpenAI validada. Informe explicitamente --credential <uuid>.",
    );
  }
  return valid[0] ?? null;
}

function selectSession(
  snapshot: ProvisioningSnapshot,
  requested?: string,
): ChannelSessionRef | null {
  const working = snapshot.channelSessions.filter(
    (session) => session.status === "WORKING" && session.archivedAt === null,
  );
  if (requested) {
    const match = working.find((session) => session.id === requested);
    if (!match) {
      throw new ProvisioningInputError(
        "A sessão informada não pertence à organização alvo, está arquivada ou não está WORKING.",
      );
    }
    return match;
  }
  if (working.length > 1) {
    throw new ProvisioningInputError(
      "Há mais de uma sessão WhatsApp operacional. Informe explicitamente --channel-session <uuid>.",
    );
  }
  return working[0] ?? null;
}

function selectModel(
  snapshot: ProvisioningSnapshot,
  credential: CredentialRef | null,
  requested?: string,
): string | null {
  if (!credential) return null;
  const available = new Set(credential.modelsAvailable);
  const catalog = snapshot.models.filter((model) => available.has(model.model_id));
  if (requested) {
    const match = catalog.find((model) => model.model_id === requested && model.supports_tools);
    if (!match) {
      throw new ProvisioningInputError(
        "O modelo informado não está disponível na credencial validada ou não suporta ferramentas.",
      );
    }
    return match.model_id;
  }
  const selection = escolherModeloDoProvedor(catalog);
  return selection.escolhido ? selection.modelId : null;
}

function normalizedKnowledgeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Política AFB deliberadamente restrita para fontes manuais anteriores ao bootstrap.
 * Não é uma regra genérica de tomada de posse por título.
 */
function manualSourceCanBeAdopted(
  source: ExistingKnowledgeRef,
  desired: DocumentoAfbCarregado,
): boolean {
  if (!source.isActive || source.sourceType !== "faq" || source.status !== "ready") return false;
  if (source.faqItems.length !== 1 || source.faqItems[0]?.question !== desired.question) return false;

  const expectedTag = `afb-bootstrap:${desired.key}:documento`;
  const bootstrapTags = source.faqItems[0]!.tags.filter((tag) => tag.startsWith("afb-bootstrap:"));
  return bootstrapTags.every((tag) => tag === expectedTag);
}

function knowledgePlan(
  snapshot: ProvisioningSnapshot,
  documents: DocumentosAfbCarregados,
): ProvisioningReport["knowledge"] {
  return documents.knowledge.map((desired) => {
    const base = {
      name: desired.title,
      documentPath: desired.documentPath,
      sha256: desired.sha256,
    };
    const owned = snapshot.knowledgeSources.filter((source) => source.bootstrapKey === desired.key);
    if (owned.length > 1) return { ...base, action: "conflict" as const };
    const existing = owned[0];
    const similarTitles = snapshot.knowledgeSources.filter(
      (source) => normalizedKnowledgeTitle(source.name) === normalizedKnowledgeTitle(desired.title),
    );
    if (existing) {
      if (!existing.isActive || existing.sourceType !== "faq" || existing.status !== "ready") {
        return { ...base, action: "conflict" as const };
      }
      const titleCollision = similarTitles.some((source) => source.id !== existing.id);
      if (titleCollision) return { ...base, action: "conflict" as const };
      return {
        ...base,
        action:
          existing.documentSha256 === desired.sha256 && existing.name === desired.title
            ? ("unchanged" as const)
            : ("update" as const),
      };
    }
    if (similarTitles.length === 0) return { ...base, action: "create" as const };
    if (similarTitles.length !== 1 || similarTitles[0]!.name !== desired.title) {
      return { ...base, action: "conflict" as const };
    }
    const manual = similarTitles[0]!;
    if (manual.bootstrapKey !== null || !manualSourceCanBeAdopted(manual, desired)) {
      return { ...base, action: "conflict" as const };
    }
    return {
      ...base,
      action: "adopt" as const,
    };
  });
}

export interface ProvisioningDependencies {
  loadDocuments?: () => Promise<DocumentosAfbCarregados>;
}

export async function provisionAfbCommercialOutbound(
  repository: AfbProvisioningRepository,
  options: ProvisioningOptions,
  dependencies: ProvisioningDependencies = {},
): Promise<ProvisioningReport> {
  if (!options.organization?.trim()) {
    throw new ProvisioningInputError(
      "Informe --organization <uuid-ou-slug>. A organização é obrigatória.",
    );
  }

  const snapshot = await repository.inspect(options.organization.trim());
  if (!snapshot) {
    throw new ProvisioningInputError("Organização não encontrada pelo UUID ou slug informado.");
  }
  const documents = await (dependencies.loadDocuments ?? carregarDocumentosAfb)();

  const pipeline = selectPipeline(snapshot, options.pipelineId);
  const credential = selectCredential(snapshot, options.credentialId);
  const session = selectSession(snapshot, options.channelSessionId);
  const model = selectModel(snapshot, credential, options.model);
  const knowledge = knowledgePlan(snapshot, documents);
  const memoryAction: ProvisioningReport["memory"]["action"] =
    snapshot.memoryEntriesWithTitle > 1
      ? "conflict"
      : snapshot.memoryEntriesWithTitle === 0
        ? "create"
        : snapshot.memory?.body === documents.memory.content &&
            snapshot.memory.source === "manual" &&
            snapshot.memory.status === "active"
          ? "unchanged"
          : "update";
  const warnings: string[] = [];

  if (!pipeline) warnings.push("funil outbound não encontrado; informe --pipeline <uuid>.");
  if (!credential) warnings.push(OPENAI_CREDENTIAL_WARNING);
  if (!session)
    warnings.push("Sessão WhatsApp WORKING necessária antes de publicar/testar o agente.");
  if (credential && !model) {
    warnings.push(
      "Nenhum modelo OpenAI com suporte a ferramentas está disponível na credencial validada.",
    );
  }
  if (knowledge.some((entry) => entry.action === "conflict")) {
    warnings.push(
      "Existe material AFB ambíguo, arquivado ou com nome reservado sem a marca de propriedade; ele não será sobrescrito nem duplicado.",
    );
  }
  if (snapshot.memoryEntriesWithTitle > 1) {
    warnings.push(
      "Há mais de uma memória com o título reservado; remova a ambiguidade antes do apply.",
    );
  }

  const readyToPublish =
    pipeline !== null &&
    credential !== null &&
    session !== null &&
    model !== null &&
    !knowledge.some((entry) => entry.action === "conflict") &&
    snapshot.memoryEntriesWithTitle <= 1;

  const changes = [
    ...(pipeline ? [`configurar playbook ${AFB_PLAYBOOK_ID} no funil ${pipeline.id}`] : []),
    ...knowledge.map((entry) => `${entry.action}: conhecimento ${entry.name}`),
    `${memoryAction}: memória ${AFB_MEMORY_TITLE}`,
    readyToPublish
      ? `${snapshot.agent ? "atualizar" : "criar"} e publicar ${AFB_AGENT_NAME} em modo assistido`
      : `preparar ${AFB_AGENT_NAME}; publicação pendente das dependências indicadas`,
  ];

  const report: ProvisioningReport = {
    mode: options.apply ? "apply" : "dry-run",
    organization: snapshot.organization,
    playbook: AFB_PLAYBOOK_ID,
    pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null,
    outboundPipelineFoundByName: snapshot.pipelines.some(
      (item) => !item.isArchived && item.name === "Prospecção Outbound AFB",
    ),
    credential: credential ? { id: credential.id, label: credential.label } : null,
    channelSession: session ? { id: session.id, displayName: session.displayName } : null,
    model,
    agent: {
      name: AFB_AGENT_NAME,
      readyToPublish,
      action: readyToPublish
        ? snapshot.agent
          ? "update_or_keep"
          : "create"
        : "pending_dependencies",
    },
    knowledge,
    memory: {
      title: AFB_MEMORY_TITLE,
      documentPath: documents.memory.documentPath,
      sha256: documents.memory.sha256,
      action: memoryAction,
    },
    changes,
    warnings,
    applied: false,
  };

  if (!options.apply) return report;

  let pipelineChanged = false;
  if (pipeline) {
    pipelineChanged = await repository.configurePipeline(snapshot.organization.id, pipeline.id);
  }

  const sources: UpsertResult[] = [];
  if (!knowledge.some((entry) => entry.action === "conflict")) {
    for (const source of documents.knowledge) {
      sources.push(await repository.upsertKnowledgeSource(snapshot.organization.id, source));
    }
  }

  let memoryChanged = false;
  if (snapshot.memoryEntriesWithTitle <= 1) {
    memoryChanged = (await repository.upsertMemory(snapshot.organization.id, documents.memory))
      .changed;
  }

  for (const source of sources) {
    const previous = snapshot.knowledgeSources.find((item) => item.id === source.id);
    if (source.changed || !previous?.activeVersionId) {
      await repository.requestKnowledgeIndex(snapshot.organization.id, source.id);
    }
  }

  let agentChanged = false;
  if (readyToPublish && pipeline && credential && session && model) {
    const agent = await repository.upsertAgent({
      organizationId: snapshot.organization.id,
      pipelineId: pipeline.id,
      credentialId: credential.id,
      channelSessionId: session.id,
      model,
      knowledgeSourceIds: sources.map((source) => source.id),
      name: AFB_AGENT_NAME,
      description: "Copilot comercial outbound da AFB, assistido e sujeito à revisão humana.",
      systemPrompt: AFB_SYSTEM_PROMPT,
      operationMode: "assisted",
      priority: 0,
      toolIds: AFB_ALLOWED_TOOL_IDS,
      triggerConfig: {
        events: ["message"],
        filters: {
          ignore_groups: true,
          ignore_self: true,
          keyword_regex: null,
          business_hours: null,
        },
        concurrency: "one_per_conversation",
      },
      handoffToolEnabled: true,
      casesEnabled: true,
      followup: { enabled: false, flow_pointer_ids: [] },
      operatorEnabled: false,
      operatorToolIds: [],
      executionPolicy: "require_human_approval",
      normalAutoSendEnabled: false,
    });
    agentChanged = agent.changed;
  }

  await repository.recordAudit(snapshot.organization.id, {
    pipelineChanged,
    knowledgeChanged: sources.filter((source) => source.changed).length,
    memoryChanged,
    agentChanged,
    documents: [
      ...documents.knowledge.map((document) => ({
        key: document.key,
        kind: "knowledge" as const,
        path: document.documentPath,
        version: document.version,
        sha256: document.sha256,
      })),
      {
        key: documents.memory.key,
        kind: "memory" as const,
        path: documents.memory.documentPath,
        version: documents.memory.version,
        sha256: documents.memory.sha256,
      },
    ],
  });

  return { ...report, applied: true };
}

export const AFB_AGENT_INVARIANTS = {
  operationMode: "assisted",
  normalAutoSendEnabled: false,
  followupEnabled: false,
  operatorEnabled: false,
  playbookId: AFB_PLAYBOOK_ID,
  memoryTitle: AFB_MEMORY_TITLE,
  bootstrapVersion: AFB_BOOTSTRAP_VERSION,
} as const;
