import { escolherModeloDoProvedor } from "@/lib/ai/agents/escolher-modelo";
import { mergeConfiguracaoDeModulos, playbookIdDoCopiloto } from "@/lib/pipelines/modulos";

import { AFB_COMERCIAL_V1 } from "@/lib/afb/playbooks/comercial";
import { deRegistryParaDefinicao } from "@/lib/playbooks/adaptador-afb";

import {
  AFB_AGENT_NAME,
  AFB_ALLOWED_TOOL_IDS,
  AFB_BOOTSTRAP_VERSION,
  AFB_MEMORY_TITLE,
  AFB_PLAYBOOK_ID,
  AFB_PLAYBOOK_PERSISTIDO,
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

/**
 * O playbook persistido desta organização com o slug do bootstrap, como está
 * no banco. `null` quando não existe — o caso de toda instalação de hoje.
 */
export interface ExistingPlaybookRef {
  id: string;
  slug: string;
  name: string;
  status: string;
  /** Marca de propriedade do bootstrap (`metadata.afb_bootstrap.key`). `null` = registro humano. */
  bootstrapKey: string | null;
  publishedVersionId: string | null;
  /** `definition_sha256` da versão publicada; `null` quando nunca publicou. */
  publishedVersionSha256: string | null;
  publishedVersionNumber: number | null;
  /** sha256 canônico do `draft`, quando há draft. */
  draftSha256: string | null;
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
  /** O playbook persistido com o slug do bootstrap. Ausente na instalação que ainda não o tem. */
  playbook: ExistingPlaybookRef | null;
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
  /** A ação executada no playbook persistido, ou `null` quando nada foi tocado. */
  playbookAction: AcaoDoPlaybook;
  playbookVersionNumber: number | null;
  playbookSha256: string;
  documents: readonly {
    key: string;
    kind: "knowledge" | "memory";
    path: string;
    version: string;
    sha256: string;
  }[];
}

/** O que o bootstrap precisa gravar para o playbook — nunca o conteúdo, que vem do adaptador. */
export interface PlaybookBootstrapInput {
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  definition: unknown;
  definitionSha256: string;
}

export interface PlaybookUpsertResult {
  id: string;
  versionId: string | null;
  versionNumber: number | null;
  created: boolean;
  published: boolean;
  adopted: boolean;
}

export interface AfbProvisioningRepository {
  inspect(organizationIdentifier: string): Promise<ProvisioningSnapshot | null>;
  /** Cria o ponteiro com o draft e publica a v1. Idempotente por (organization_id, slug). */
  createAndPublishPlaybook(input: PlaybookBootstrapInput): Promise<PlaybookUpsertResult>;
  /** Conclui a publicação de um ponteiro que já existe com o draft certo (falha parcial). */
  publishPlaybookVersion(
    input: PlaybookBootstrapInput & { playbookId: string },
  ): Promise<PlaybookUpsertResult>;
  /** Adota um registro equivalente: grava SÓ a marca de propriedade, preservando ids e versões. */
  adoptPlaybook(organizationId: string, playbookId: string): Promise<PlaybookUpsertResult>;
  /**
   * Grava o módulo do Copiloto no funil e, quando houver, o binding persistido.
   *
   * `aiPlaybookId` é `null` para "NÃO mexa na coluna" — nunca para "limpe".
   * Limpar seria o provisionador desfazer um vínculo que uma pessoa pode ter
   * feito na tela, e a postura desta peça é a mesma do `playbookPlan`: em
   * dúvida, não passa por cima.
   */
  configurePipeline(
    organizationId: string,
    pipelineId: string,
    aiPlaybookId: string | null,
  ): Promise<boolean>;
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
  /**
   * O playbook PERSISTIDO (Fase B) — paralelo ao runtime, que segue lendo o
   * registry em código. `sha256` vem do adaptador, nunca de constante.
   */
  persistedPlaybook: {
    slug: string;
    name: string;
    sha256: string;
    action: AcaoDoPlaybook;
    reason: string;
    /**
     * O UUID que o funil receberá em `crm_pipelines.ai_playbook_id` (migration
     * 0234). `null` em dois casos DIFERENTES, e o `action` ao lado os separa:
     * em `create` o id ainda não existe (ele nasce no banco, nesta execução);
     * em `conflict` não haverá binding nenhum.
     *
     * No dry-run isto é o que permite conferir QUAL playbook o funil passaria
     * a apontar, antes de qualquer escrita.
     */
    pipelineBindingId: string | null;
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

/**
 * O PLANO do playbook persistido — conservador por construção.
 *
 * O provisionador está criando o PRIMEIRO estado persistido de algo que, a
 * partir da fase seguinte, passa a ser editado por gente na tela. Então ele
 * nunca republica, nunca sobrescreve e nunca toma posse sem prova:
 *
 *   create    — não existe playbook com este slug nesta organização.
 *   publish   — existe, é NOSSO, nunca publicou, e o draft é exatamente a
 *               definição do adaptador. É a retomada de um apply que criou o
 *               ponteiro e morreu antes de publicar; publicar aqui é concluir
 *               o que ficou pela metade, não sobrescrever nada.
 *   unchanged — existe, é nosso, e a versão publicada tem o MESMO sha.
 *   adopt     — existe com o nosso slug, SEM marca de propriedade, mas com uma
 *               versão publicada cujo sha é byte a byte o nosso. É o mesmo
 *               playbook por prova, não por nome: adotar só grava a marca,
 *               preservando `ai_playbooks.id` e todas as versões.
 *   conflict  — todo o resto. Inclui: nosso com sha publicado DIFERENTE (houve
 *               publicação humana — o provisionador não passa por cima),
 *               nosso sem versão e com draft diferente (alguém editou), e
 *               registro humano que apenas se parece com o nosso.
 *
 * Nenhuma decisão olha o NOME: nome é rótulo editável. O que decide é o par
 * (organização, slug), a marca de propriedade e o sha da definição.
 */
export type AcaoDoPlaybook = "create" | "publish" | "unchanged" | "adopt" | "conflict";

/**
 * A definição a persistir, derivada do registry em código. Vive aqui para o
 * provisionador nunca carregar JSON duplicado: `lib/playbooks/adaptador-afb.ts`
 * é a única forma de produzir a definição, e `canonicalHash` a única de
 * produzir o sha.
 */
export function construirDefinicaoDoPlaybook(): { definition: unknown; sha256: string } {
  const { definition, sha256 } = deRegistryParaDefinicao(AFB_COMERCIAL_V1);
  return { definition, sha256 };
}

export function playbookPlan(
  existing: ExistingPlaybookRef | null,
  definitionSha256: string,
  bootstrapKey: string,
): { action: AcaoDoPlaybook; reason: string } {
  if (!existing) return { action: "create", reason: "nenhum playbook com este slug na organização" };

  const nosso = existing.bootstrapKey === bootstrapKey;

  if (nosso) {
    if (existing.publishedVersionSha256 === definitionSha256) {
      return { action: "unchanged", reason: "versão publicada tem o mesmo conteúdo" };
    }
    if (existing.publishedVersionId === null) {
      return existing.draftSha256 === definitionSha256
        ? { action: "publish", reason: "ponteiro do bootstrap sem versão publicada, com o draft correto" }
        : { action: "conflict", reason: "ponteiro do bootstrap sem versão publicada e com draft diferente do repositório" };
    }
    return { action: "conflict", reason: "versão publicada tem conteúdo diferente do repositório" };
  }

  // Sem marca de propriedade: só se adota com prova inequívoca.
  if (existing.publishedVersionId !== null && existing.publishedVersionSha256 === definitionSha256) {
    return { action: "adopt", reason: "registro sem marca de propriedade, com versão publicada idêntica ao repositório" };
  }
  return { action: "conflict", reason: "existe um playbook com este slug que não pertence ao bootstrap" };
}

/**
 * QUAL UUID o funil deve passar a apontar — a partir do plano, não do nome.
 *
 * O id vem sempre do BANCO, por um de dois caminhos, e nunca de uma busca por
 * slug dentro do `configurePipeline`:
 *
 *   create / publish / adopt  → o id devolvido pela escrita desta execução.
 *   unchanged                 → o id que o snapshot já trouxe (não houve
 *                               escrita: o playbook já estava correto).
 *   conflict                  → `null`. Existe um playbook com o nosso slug
 *                               que NÃO é o nosso, ou que divergiu. Apontar o
 *                               funil para ele seria o provisionador escolher
 *                               por cima de uma publicação humana — a mesma
 *                               coisa que `playbookPlan` recusa fazer.
 *
 * `null` significa "não mexa na coluna", nunca "limpe a coluna".
 *
 * Por que `aplicado` vem antes de `existente`: no `adopt` os dois são o mesmo
 * id (adotar preserva `ai_playbooks.id`), e no `create` só o primeiro existe.
 * Preferir o que a escrita acabou de devolver é o que garante que o UUID
 * gravado é o da MESMA execução, e não um lido antes de qualquer coisa mudar.
 */
export function uuidDoBindingPersistido(
  acao: AcaoDoPlaybook,
  existente: ExistingPlaybookRef | null,
  aplicado: PlaybookUpsertResult | null,
): string | null {
  if (acao === "conflict") return null;
  return aplicado?.id ?? existente?.id ?? null;
}

export interface ProvisioningDependencies {
  loadDocuments?: () => Promise<DocumentosAfbCarregados>;
  /** A definição persistida vem SEMPRE do adaptador; injetável só para teste. */
  buildPlaybookDefinition?: () => { definition: unknown; sha256: string };
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
  // A definição persistida é SEMPRE a do adaptador — nunca JSON escrito à mão
  // aqui, nunca um sha de constante.
  const playbookDefinicao = (dependencies.buildPlaybookDefinition ?? construirDefinicaoDoPlaybook)();
  const playbookPlano = playbookPlan(
    snapshot.playbook,
    playbookDefinicao.sha256,
    AFB_PLAYBOOK_PERSISTIDO.slug,
  );
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
  if (playbookPlano.action === "conflict") {
    warnings.push(
      `O playbook persistido «${AFB_PLAYBOOK_PERSISTIDO.slug}» não será tocado: ${playbookPlano.reason}. ` +
        "Nenhuma versão é publicada por cima de conteúdo humano — resolva pela tela ou renomeie o registro.",
    );
  }

  const readyToPublish =
    pipeline !== null &&
    credential !== null &&
    session !== null &&
    model !== null &&
    !knowledge.some((entry) => entry.action === "conflict") &&
    snapshot.memoryEntriesWithTitle <= 1;

  // O binding que o funil receberá, calculado ANTES de qualquer escrita: é o
  // que o dry-run publica. No `apply` ele é recalculado depois da escrita do
  // playbook, porque só então o id do `create` existe.
  const bindingPlanejado = uuidDoBindingPersistido(playbookPlano.action, snapshot.playbook, null);

  const changes = [
    ...(pipeline ? [`configurar playbook ${AFB_PLAYBOOK_ID} no funil ${pipeline.id}`] : []),
    // Linha própria, e não um adendo à de cima: o legado e o persistido são
    // dois vínculos que convivem nesta fase, e juntá-los na mesma frase faria
    // parecer que um substituiu o outro.
    ...(pipeline && playbookPlano.action !== "conflict"
      ? [
          `vincular funil ${pipeline.id} ao playbook persistido ${
            bindingPlanejado ?? "(id criado nesta execução)"
          }`,
        ]
      : []),
    ...knowledge.map((entry) => `${entry.action}: conhecimento ${entry.name}`),
    `${memoryAction}: memória ${AFB_MEMORY_TITLE}`,
    `${playbookPlano.action}: playbook ${AFB_PLAYBOOK_PERSISTIDO.name}`,
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
    persistedPlaybook: {
      slug: AFB_PLAYBOOK_PERSISTIDO.slug,
      name: AFB_PLAYBOOK_PERSISTIDO.name,
      sha256: playbookDefinicao.sha256,
      action: playbookPlano.action,
      reason: playbookPlano.reason,
      pipelineBindingId: bindingPlanejado,
    },
    changes,
    warnings,
    applied: false,
  };

  if (!options.apply) return report;

  // O funil é configurado DEPOIS do playbook persistido (mais abaixo), e não
  // aqui, onde esta chamada ficava. O motivo é o `create`: o UUID do binding só
  // existe depois do INSERT, então configurar antes só poderia gravar o módulo
  // legado — e o binding ficaria para "a próxima execução", em silêncio.
  let pipelineChanged = false;

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

  // ─── Playbook persistido (Fase B) ────────────────────────────────────────
  //
  // Paralelo ao runtime: o funil continua com `playbook_id: afb_comercial_v1`
  // e o Copiloto continua lendo o registry em código. `unchanged` e `conflict`
  // não escrevem NADA — em conflito, o provisionador prefere parar a passar por
  // cima do que uma pessoa publicou.
  let playbookAplicado: PlaybookUpsertResult | null = null;
  const playbookInput: PlaybookBootstrapInput = {
    organizationId: snapshot.organization.id,
    slug: AFB_PLAYBOOK_PERSISTIDO.slug,
    name: AFB_PLAYBOOK_PERSISTIDO.name,
    description: AFB_PLAYBOOK_PERSISTIDO.description,
    definition: playbookDefinicao.definition,
    definitionSha256: playbookDefinicao.sha256,
  };
  if (playbookPlano.action === "create") {
    playbookAplicado = await repository.createAndPublishPlaybook(playbookInput);
  } else if (playbookPlano.action === "publish" && snapshot.playbook) {
    playbookAplicado = await repository.publishPlaybookVersion({
      ...playbookInput,
      playbookId: snapshot.playbook.id,
    });
  } else if (playbookPlano.action === "adopt" && snapshot.playbook) {
    playbookAplicado = await repository.adoptPlaybook(snapshot.organization.id, snapshot.playbook.id);
  }

  // ─── O funil: módulo legado + binding persistido, na MESMA escrita ────────
  //
  // O legado continua sendo gravado exatamente como antes
  // (`buildAfbPipelineSettings`, dentro do repositório); o que muda é que agora
  // vai junto o UUID desta execução.
  //
  // Se esta chamada falhar depois de o playbook ter sido criado, a instalação
  // fica com playbook sem binding — e a execução seguinte vê `unchanged` (mesmo
  // sha), recalcula o mesmo id pelo snapshot e grava. Não há estado do qual não
  // se saia repetindo o comando.
  if (pipeline) {
    pipelineChanged = await repository.configurePipeline(
      snapshot.organization.id,
      pipeline.id,
      uuidDoBindingPersistido(playbookPlano.action, snapshot.playbook, playbookAplicado),
    );
  }

  await repository.recordAudit(snapshot.organization.id, {
    pipelineChanged,
    knowledgeChanged: sources.filter((source) => source.changed).length,
    memoryChanged,
    agentChanged,
    playbookAction: playbookPlano.action,
    playbookVersionNumber: playbookAplicado?.versionNumber ?? null,
    playbookSha256: playbookDefinicao.sha256,
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
