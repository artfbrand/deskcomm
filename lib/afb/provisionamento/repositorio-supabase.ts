import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";

import {
  AFB_AGENT_NAME,
  AFB_BOOTSTRAP_VERSION,
  AFB_MEMORY_TITLE,
  AFB_PLAYBOOK_ID,
  AFB_PLAYBOOK_PERSISTIDO,
} from "./configuracao";
import type { DocumentoAfbCarregado, MemoriaAfbCarregada } from "./documentos";
import type {
  AfbProvisioningAuditSummary,
  AfbProvisioningRepository,
  AgentBootstrapInput,
  AgentUpsertResult,
  CredentialRef,
  ExistingKnowledgeRef,
  ModelRef,
  PipelineRef,
  PlaybookBootstrapInput,
  PlaybookUpsertResult,
  ProvisioningSnapshot,
  UpsertResult,
} from "./provisionador";
import { buildAfbPipelineSettings } from "./provisionador";

type JsonObject = Record<string, unknown>;

function objectOrEmpty(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function fail(operation: string): never {
  throw new Error(`Falha ao ${operation}. Consulte os logs do banco sem expor credenciais.`);
}

/**
 * A marca de propriedade do bootstrap no `metadata` do playbook persistido.
 * Mesma forma do `afb_bootstrap` que os materiais já usam — nada de estrutura
 * nova, e o `legacy_playbook_id` fica como referência de origem, nunca como
 * identidade (a identidade é `organization_id` + `slug`).
 */
function playbookBootstrapMetadata(slug: string): JsonObject {
  return {
    afb_bootstrap: {
      key: slug,
      legacy_playbook_id: AFB_PLAYBOOK_ID,
      source: "afb-provision",
      bootstrap_version: AFB_BOOTSTRAP_VERSION,
    },
  };
}

function bootstrapKey(metadata: unknown): string | null {
  const root = objectOrEmpty(metadata);
  const bootstrap = objectOrEmpty(root.afb_bootstrap);
  return typeof bootstrap.key === "string" ? bootstrap.key : null;
}

function documentSha256(metadata: unknown): string | null {
  const root = objectOrEmpty(metadata);
  const bootstrap = objectOrEmpty(root.afb_bootstrap);
  return typeof bootstrap.document_sha256 === "string" ? bootstrap.document_sha256 : null;
}

function normalizedKnowledgeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function organizationByIdentifier(identifier: string) {
  const admin = createAdminClient();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    identifier,
  );
  let query = admin.from("organizations").select("id, slug, display_name");
  query = isUuid ? query.eq("id", identifier) : query.eq("slug", identifier);
  const { data, error } = await query.limit(2);
  if (error) fail("resolver a organização");
  if (!data || data.length !== 1) return null;
  return {
    id: String(data[0]!.id),
    slug: String(data[0]!.slug),
    displayName: String(data[0]!.display_name),
  };
}

export class SupabaseAfbProvisioningRepository implements AfbProvisioningRepository {
  async inspect(organizationIdentifier: string): Promise<ProvisioningSnapshot | null> {
    const organization = await organizationByIdentifier(organizationIdentifier);
    if (!organization) return null;
    const admin = createAdminClient();
    const organizationId = organization.id;

    const [pipelines, credentials, sessions, models, sources, memories, agents] = await Promise.all(
      [
        admin
          .from("crm_pipelines")
          .select("id, name, settings, is_archived")
          .eq("organization_id", organizationId),
        admin
          .from("ai_provider_credentials_safe")
          .select(
            "id, label, provider, is_active, validated_at, validation_error, models_available",
          )
          .eq("organization_id", organizationId)
          .eq("provider", "openai"),
        admin
          .from("channel_sessions")
          .select("id, display_name, status, archived_at")
          .eq("organization_id", organizationId),
        admin
          .from("ai_models")
          .select(
            "model_id, is_default_for_provider, supports_tools, input_price_per_million_cents, output_price_per_million_cents",
          )
          .eq("provider", "openai")
          .is("deprecated_at", null),
        admin
          .from("ai_knowledge_sources")
          .select(
            "id, name, source_metadata, active_kb_version_id, is_active, source_type, status",
          )
          .eq("organization_id", organizationId),
        admin
          .from("org_memory_entries")
          .select("id, body, source, status")
          .eq("organization_id", organizationId)
          .eq("title", AFB_MEMORY_TITLE),
        admin
          .from("ai_agents")
          .select("id, name, kind, archived_at")
          .eq("organization_id", organizationId)
          .eq("name", AFB_AGENT_NAME),
      ],
    );

    if (
      pipelines.error ||
      credentials.error ||
      sessions.error ||
      models.error ||
      sources.error ||
      memories.error ||
      agents.error
    ) {
      fail("carregar o estado atual do bootstrap AFB");
    }
    if ((agents.data?.length ?? 0) > 1) fail("resolver o agente AFB sem ambiguidade");

    const sourceIds = (sources.data ?? []).map((source) => String(source.id));
    const faqItems =
      sourceIds.length === 0
        ? { data: [], error: null }
        : await admin
            .from("ai_faq_items")
            .select("knowledge_source_id, question, tags")
            .eq("organization_id", organizationId)
            .in("knowledge_source_id", sourceIds);
    if (faqItems.error) fail("carregar os itens dos materiais AFB");

    // O playbook persistido é identificado por (organização, slug) — nunca
    // pelo nome, que é rótulo editável. A versão publicada é lida à parte para
    // o plano comparar o `definition_sha256` sem carregar a definição inteira.
    const { data: playbookRow, error: playbookErro } = await admin
      .from("ai_playbooks")
      .select("id, slug, name, status, metadata, draft, published_version_id")
      .eq("organization_id", organizationId)
      .eq("slug", AFB_PLAYBOOK_PERSISTIDO.slug)
      .maybeSingle();
    if (playbookErro) fail("carregar o playbook persistido da AFB");

    let playbook: ProvisioningSnapshot["playbook"] = null;
    if (playbookRow) {
      let publishedSha: string | null = null;
      let publishedNumber: number | null = null;
      if (playbookRow.published_version_id) {
        const { data: versao, error: versaoErro } = await admin
          .from("ai_playbook_versions")
          .select("id, definition_sha256, version_number")
          .eq("id", playbookRow.published_version_id)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (versaoErro) fail("carregar a versão publicada do playbook AFB");
        publishedSha = versao?.definition_sha256 === undefined ? null : String(versao.definition_sha256);
        publishedNumber = versao?.version_number === undefined ? null : Number(versao.version_number);
      }
      playbook = {
        id: String(playbookRow.id),
        slug: String(playbookRow.slug),
        name: String(playbookRow.name),
        status: String(playbookRow.status),
        bootstrapKey: bootstrapKey(playbookRow.metadata),
        publishedVersionId:
          playbookRow.published_version_id === null ? null : String(playbookRow.published_version_id),
        publishedVersionSha256: publishedSha,
        publishedVersionNumber: publishedNumber,
        // O sha do draft é calculado com o MESMO algoritmo canônico do
        // adaptador — é o que permite reconhecer o draft que nós mesmos
        // gravamos num apply que morreu antes de publicar.
        draftSha256:
          playbookRow.draft === null || playbookRow.draft === undefined
            ? null
            : canonicalHash(playbookRow.draft),
      };
    }

    return {
      organization,
      playbook,
      pipelines: (pipelines.data ?? []).map((row): PipelineRef => ({
        id: String(row.id),
        name: String(row.name),
        settings: row.settings,
        isArchived: Boolean(row.is_archived),
      })),
      credentials: (credentials.data ?? []).map((row): CredentialRef => ({
        id: String(row.id),
        label: row.label === null ? null : String(row.label),
        provider: String(row.provider),
        isActive: Boolean(row.is_active),
        validatedAt: row.validated_at === null ? null : String(row.validated_at),
        validationError: row.validation_error === null ? null : String(row.validation_error),
        modelsAvailable: Array.isArray(row.models_available)
          ? row.models_available.map(String)
          : [],
      })),
      channelSessions: (sessions.data ?? []).map((row) => ({
        id: String(row.id),
        displayName: row.display_name === null ? null : String(row.display_name),
        status: String(row.status),
        archivedAt: row.archived_at === null ? null : String(row.archived_at),
      })),
      models: (models.data ?? []).map((row): ModelRef => ({
        model_id: String(row.model_id),
        is_default_for_provider: Boolean(row.is_default_for_provider),
        supports_tools: Boolean(row.supports_tools),
        input_price_per_million_cents:
          typeof row.input_price_per_million_cents === "number"
            ? row.input_price_per_million_cents
            : null,
        output_price_per_million_cents:
          typeof row.output_price_per_million_cents === "number"
            ? row.output_price_per_million_cents
            : null,
      })),
      knowledgeSources: (sources.data ?? []).map((row): ExistingKnowledgeRef => ({
        id: String(row.id),
        name: String(row.name),
        bootstrapKey: bootstrapKey(row.source_metadata),
        documentSha256: documentSha256(row.source_metadata),
        activeVersionId:
          row.active_kb_version_id === null ? null : String(row.active_kb_version_id),
        isActive: Boolean(row.is_active),
        sourceType: String(row.source_type),
        status: String(row.status),
        faqItems: (faqItems.data ?? [])
          .filter((item) => String(item.knowledge_source_id) === String(row.id))
          .map((item) => ({
            question: item.question === null ? null : String(item.question),
            tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
          })),
      })),
      memoryEntriesWithTitle: memories.data?.length ?? 0,
      memory:
        memories.data?.length === 1
          ? {
              id: String(memories.data[0]!.id),
              body: String(memories.data[0]!.body),
              source: String(memories.data[0]!.source),
              status: String(memories.data[0]!.status),
            }
          : null,
      agent: agents.data?.[0]
        ? {
            id: String(agents.data[0].id),
            name: String(agents.data[0].name),
            kind: String(agents.data[0].kind),
            archivedAt:
              agents.data[0].archived_at === null ? null : String(agents.data[0].archived_at),
          }
        : null,
    };
  }

  async configurePipeline(organizationId: string, pipelineId: string): Promise<boolean> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("crm_pipelines")
      .select("settings")
      .eq("organization_id", organizationId)
      .eq("id", pipelineId)
      .eq("is_archived", false)
      .maybeSingle();
    if (error || !data) fail("carregar o funil alvo");
    const settings = objectOrEmpty(data.settings);
    const next = buildAfbPipelineSettings(settings);
    if (canonical(next) === canonical(settings)) return false;
    const { error: updateError } = await admin
      .from("crm_pipelines")
      .update({ settings: next })
      .eq("organization_id", organizationId)
      .eq("id", pipelineId);
    if (updateError) fail("configurar o playbook no funil");
    return true;
  }

  async upsertKnowledgeSource(
    organizationId: string,
    source: DocumentoAfbCarregado,
  ): Promise<UpsertResult> {
    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("ai_knowledge_sources")
      .select("id, name, source_metadata, source_type, status, is_active")
      .eq("organization_id", organizationId);
    if (error) fail(`carregar o material ${source.title}`);

    const owned = (rows ?? []).filter((row) => bootstrapKey(row.source_metadata) === source.key);
    if (owned.length > 1) fail(`resolver a chave ${source.key} sem ambiguidade`);
    const titleMatches = (rows ?? []).filter((row) => row.name === source.title);
    const similarTitles = (rows ?? []).filter(
      (row) => normalizedKnowledgeTitle(String(row.name)) === normalizedKnowledgeTitle(source.title),
    );
    const existing = owned[0] ?? titleMatches[0];
    if (
      titleMatches.some((row) => String(row.id) !== String(existing?.id)) ||
      similarTitles.some((row) => String(row.id) !== String(existing?.id)) ||
      (existing && !existing.is_active)
    ) {
      throw new Error(
        `Material AFB ambíguo ou arquivado: ${source.title}.`,
      );
    }

    if (existing && bootstrapKey(existing.source_metadata) !== source.key) {
      if (
        existing.name !== source.title ||
        existing.source_type !== "faq" ||
        existing.status !== "ready" ||
        !existing.is_active
      ) {
        throw new Error(`Material manual incompatível para adoção: ${source.title}.`);
      }
      const { data: manualItems, error: manualItemsError } = await admin
        .from("ai_faq_items")
        .select("id, question, answer, tags")
        .eq("organization_id", organizationId)
        .eq("knowledge_source_id", existing.id);
      if (manualItemsError) fail(`validar a fonte manual ${source.title}`);
      const expectedTag = `afb-bootstrap:${source.key}:documento`;
      const compatible =
        (manualItems?.length ?? 0) === 1 &&
        manualItems?.[0]?.question === source.question &&
        typeof manualItems[0]?.answer === "string" &&
        manualItems[0].answer.trim().length > 0 &&
        (Array.isArray(manualItems[0].tags) ? manualItems[0].tags : [])
          .filter((tag) => typeof tag === "string" && tag.startsWith("afb-bootstrap:"))
          .every((tag) => tag === expectedTag);
      if (!compatible) {
        throw new Error(`Material manual incompatível para adoção: ${source.title}.`);
      }
    }

    let id: string;
    let created = false;
    let changed = false;
    if (!existing) {
      const { data, error: insertError } = await admin
        .from("ai_knowledge_sources")
        .insert({
          organization_id: organizationId,
          agent_id: null,
          source_type: "faq",
          name: source.title,
          status: "ready",
          is_active: true,
          ingested_at: new Date().toISOString(),
          source_metadata: {
            afb_bootstrap: {
              key: source.key,
              bootstrap_version: AFB_BOOTSTRAP_VERSION,
              document_path: source.documentPath,
              document_version: source.version,
              document_sha256: source.sha256,
              status: source.status,
              scope: source.scope,
              description: source.description,
            },
          },
        })
        .select("id")
        .single();
      if (insertError || !data) fail(`criar o material ${source.title}`);
      id = String(data.id);
      created = true;
      changed = true;
    } else {
      id = String(existing.id);
      const metadata = objectOrEmpty(existing.source_metadata);
      const nextMetadata = {
        ...metadata,
        afb_bootstrap: {
          key: source.key,
          bootstrap_version: AFB_BOOTSTRAP_VERSION,
          document_path: source.documentPath,
          document_version: source.version,
          document_sha256: source.sha256,
          status: source.status,
          scope: source.scope,
          description: source.description,
        },
      };
      if (
        existing.name !== source.title ||
        existing.source_type !== "faq" ||
        existing.status !== "ready" ||
        !existing.is_active ||
        canonical(metadata) !== canonical(nextMetadata)
      ) {
        const { error: updateError } = await admin
          .from("ai_knowledge_sources")
          .update({
            name: source.title,
            source_type: "faq",
            status: "ready",
            is_active: true,
            source_metadata: nextMetadata,
          })
          .eq("organization_id", organizationId)
          .eq("id", id);
        if (updateError) fail(`atualizar o material ${source.title}`);
        changed = true;
      }
    }

    const { data: items, error: itemError } = await admin
      .from("ai_faq_items")
      .select("id, question, answer, tags, locale, position")
      .eq("organization_id", organizationId)
      .eq("knowledge_source_id", id);
    if (itemError) fail(`carregar os itens de ${source.title}`);

    const tag = `afb-bootstrap:${source.key}:documento`;
    const matches = (items ?? []).filter(
      (item) => Array.isArray(item.tags) && item.tags.includes(tag),
    );
    if (matches.length > 1) fail(`resolver o item ${tag} sem ambiguidade`);
    const current = matches[0];
    const row = {
      question: source.question,
      answer: source.content,
      tags: [tag, "afb", "comercial-outbound", `sha256:${source.sha256}`],
      locale: "pt-BR",
      position: 0,
    };
    if (!current) {
      const { error: insertError } = await admin.from("ai_faq_items").insert({
        organization_id: organizationId,
        knowledge_source_id: id,
        ...row,
      });
      if (insertError) fail(`criar o item ${tag}`);
      changed = true;
    } else if (
      canonical({
        question: current.question,
        answer: current.answer,
        tags: current.tags,
        locale: current.locale,
        position: current.position,
      }) !== canonical(row)
    ) {
      const { error: updateError } = await admin
        .from("ai_faq_items")
        .update(row)
        .eq("organization_id", organizationId)
        .eq("knowledge_source_id", id)
        .eq("id", current.id);
      if (updateError) fail(`atualizar o item ${tag}`);
      changed = true;
    }
    return { id, created, changed };
  }

  async upsertMemory(organizationId: string, memory: MemoriaAfbCarregada): Promise<UpsertResult> {
    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("org_memory_entries")
      .select("id, body, source, status")
      .eq("organization_id", organizationId)
      .eq("title", AFB_MEMORY_TITLE);
    if (error) fail("carregar a memória AFB");
    if ((rows?.length ?? 0) > 1) fail("resolver a memória AFB sem ambiguidade");
    const current = rows?.[0];
    if (!current) {
      const { data, error: insertError } = await admin
        .from("org_memory_entries")
        .insert({
          organization_id: organizationId,
          title: AFB_MEMORY_TITLE,
          body: memory.content,
          source: "manual",
          status: "active",
        })
        .select("id")
        .single();
      if (insertError || !data) fail("criar a memória AFB");
      return { id: String(data.id), created: true, changed: true };
    }
    const changed =
      current.body !== memory.content || current.source !== "manual" || current.status !== "active";
    if (changed) {
      const { error: updateError } = await admin
        .from("org_memory_entries")
        .update({ body: memory.content, source: "manual", status: "active" })
        .eq("organization_id", organizationId)
        .eq("id", current.id);
      if (updateError) fail("atualizar a memória AFB");
    }
    return { id: String(current.id), created: false, changed };
  }

  async upsertAgent(input: AgentBootstrapInput): Promise<AgentUpsertResult> {
    const admin = createAdminClient();
    const { data: agents, error } = await admin
      .from("ai_agents")
      .select(
        "id, kind, archived_at, description, model, system_prompt, priority, operation_mode, config, is_active, is_default",
      )
      .eq("organization_id", input.organizationId)
      .eq("name", input.name);
    if (error) fail("carregar o agente AFB");
    if ((agents?.length ?? 0) > 1) fail("resolver o agente AFB sem ambiguidade");

    const current = agents?.[0];
    if (current && (current.kind !== "mcp_agent" || current.archived_at !== null)) {
      throw new Error("O nome reservado já pertence a um agente incompatível ou arquivado.");
    }
    const currentConfig = objectOrEmpty(current?.config);
    const desiredConfig = {
      ...currentConfig,
      afb_bootstrap: { version: AFB_BOOTSTRAP_VERSION },
      execution_policy: input.executionPolicy,
      normal_auto_send_enabled: input.normalAutoSendEnabled,
      router_enabled: false,
    };
    const agentFields = {
      description: input.description,
      model: `openai/${input.model}`,
      system_prompt: input.systemPrompt,
      is_active: true,
      is_default: false,
      kind: "mcp_agent",
      priority: input.priority,
      operation_mode: input.operationMode,
      config: desiredConfig,
    };

    let agentId: string;
    let created = false;
    let agentChanged = false;
    if (!current) {
      const { data, error: insertError } = await admin
        .from("ai_agents")
        .insert({ organization_id: input.organizationId, name: input.name, ...agentFields })
        .select("id")
        .single();
      if (insertError || !data) fail("criar o agente AFB");
      agentId = String(data.id);
      created = true;
      agentChanged = true;
    } else {
      agentId = String(current.id);
      const comparableCurrent = {
        description: current.description,
        model: current.model,
        system_prompt: current.system_prompt,
        priority: current.priority,
        operation_mode: current.operation_mode,
        config: current.config,
        is_active: current.is_active,
        is_default: current.is_default,
      };
      const comparableDesired = {
        description: agentFields.description,
        model: agentFields.model,
        system_prompt: agentFields.system_prompt,
        priority: agentFields.priority,
        operation_mode: agentFields.operation_mode,
        config: agentFields.config,
        is_active: agentFields.is_active,
        is_default: agentFields.is_default,
      };
      if (canonical(comparableCurrent) !== canonical(comparableDesired)) {
        const { error: updateError } = await admin
          .from("ai_agents")
          .update(agentFields)
          .eq("organization_id", input.organizationId)
          .eq("id", agentId);
        if (updateError) fail("atualizar o agente AFB");
        agentChanged = true;
      }
    }

    const versionFields = {
      system_prompt: input.systemPrompt,
      provider: "openai",
      model: input.model,
      credential_id: input.credentialId,
      tool_ids: [...input.toolIds],
      trigger_config: input.triggerConfig,
      channel_session_id: input.channelSessionId,
      max_steps: 10,
      token_budget: 50000,
      cost_budget_cents: 50,
      history_message_window: 20,
      history_token_window: 8000,
      handoff_keywords: [
        "falar com humano",
        "preço",
        "contrato",
        "exclusão",
        "não contatar",
        "reclamação",
      ],
      handoff_tool_enabled: input.handoffToolEnabled,
      cases_enabled: input.casesEnabled,
      split_messages: false,
      split_max_chars: 600,
      followup: input.followup,
      operator_enabled: input.operatorEnabled,
      operator_model: null,
      operator_tool_ids: input.operatorToolIds,
      pipeline_ids: [input.pipelineId],
      knowledge_source_ids: [...input.knowledgeSourceIds],
    };
    const { data: versions, error: versionsError } = await admin
      .from("ai_agent_versions")
      .select(
        "id, version_number, status, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, pipeline_ids, knowledge_source_ids",
      )
      .eq("organization_id", input.organizationId)
      .eq("agent_id", agentId)
      .order("version_number", { ascending: false });
    if (versionsError) fail("carregar as versões do agente AFB");

    const matching = (versions ?? []).find((version) => {
      const { id: _id, version_number: _number, status: _status, ...fields } = version;
      return canonical(fields) === canonical(versionFields);
    });
    let versionId: string;
    let versionCreated = false;
    let published = matching?.status === "published";
    if (matching) {
      versionId = String(matching.id);
    } else {
      const nextNumber = ((versions?.[0]?.version_number as number | undefined) ?? 0) + 1;
      const { data, error: insertError } = await admin
        .from("ai_agent_versions")
        .insert({
          organization_id: input.organizationId,
          agent_id: agentId,
          version_number: nextNumber,
          status: "draft",
          ...versionFields,
        })
        .select("id")
        .single();
      if (insertError || !data) fail("criar a versão do agente AFB");
      versionId = String(data.id);
      versionCreated = true;
    }

    if (!published) {
      const { error: publishError } = await admin.rpc("fn_publish_ai_agent_version", {
        p_org_id: input.organizationId,
        p_agent_id: agentId,
        p_version_id: versionId,
      });
      if (publishError) fail("publicar a versão do agente AFB");
      published = true;
    }

    return {
      id: agentId,
      versionId,
      created,
      changed: agentChanged || versionCreated,
      versionCreated,
      published,
    };
  }

  async requestKnowledgeIndex(organizationId: string, knowledgeSourceId: string): Promise<void> {
    const admin = createAdminClient();
    const { error } = await admin.rpc(
      "emit_event" as never,
      {
        p_event_type: "knowledge_source.updated",
        p_entity_kind: "ai_knowledge_source",
        p_entity_id: knowledgeSourceId,
        p_payload: { knowledge_source_id: knowledgeSourceId, source_type: "faq", agent_id: null },
        p_organization_id: organizationId,
      } as never,
    );
    if (error) fail("solicitar a indexação do conhecimento AFB");
  }

  // ─── Playbook persistido (Fase B) ────────────────────────────────────────
  //
  // Service role bypassa RLS, então TODA consulta filtra `organization_id`
  // explicitamente (CLAUDE.md, anti-pattern 10) — e o id vem sempre da
  // organização já resolvida pelo `inspect`, nunca de argumento externo cru.
  // A publicação não insere linha à mão: chama a RPC canônica, que numera a
  // versão sob o lock do ponteiro e move o ponteiro na mesma transação.

  async createAndPublishPlaybook(input: PlaybookBootstrapInput): Promise<PlaybookUpsertResult> {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ai_playbooks")
      .insert({
        organization_id: input.organizationId,
        slug: input.slug,
        name: input.name,
        description: input.description,
        draft: input.definition as never,
        metadata: playbookBootstrapMetadata(input.slug),
      })
      .select("id")
      .single();
    if (error || !data) fail("criar o playbook persistido da AFB");
    const playbookId = String(data.id);
    const publicado = await this.publishPlaybookVersion({ ...input, playbookId });
    return { ...publicado, created: true };
  }

  async publishPlaybookVersion(
    input: PlaybookBootstrapInput & { playbookId: string },
  ): Promise<PlaybookUpsertResult> {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("fn_publish_ai_playbook_version" as never, {
      p_org: input.organizationId,
      p_playbook: input.playbookId,
      p_definition: input.definition,
      p_definition_sha256: input.definitionSha256,
      p_created_by: null,
      p_notes: "bootstrap afb:provision",
    } as never);
    if (error) fail("publicar a versão do playbook persistido da AFB");
    const linha = (Array.isArray(data) ? data[0] : data) as
      | { version_id?: unknown; version_number?: unknown }
      | null
      | undefined;
    return {
      id: input.playbookId,
      versionId: linha?.version_id === undefined ? null : String(linha.version_id),
      versionNumber: linha?.version_number === undefined ? null : Number(linha.version_number),
      created: false,
      published: true,
      adopted: false,
    };
  }

  async adoptPlaybook(organizationId: string, playbookId: string): Promise<PlaybookUpsertResult> {
    const admin = createAdminClient();
    // Adoção grava SÓ a marca de propriedade: nada de nome, descrição, draft ou
    // versão. O registro adotado é, por prova de sha, o mesmo playbook — o que
    // falta nele é a marca, não o conteúdo.
    const { data: atual, error: leituraErro } = await admin
      .from("ai_playbooks")
      .select("id, metadata, published_version_id")
      .eq("id", playbookId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (leituraErro || !atual) fail("ler o playbook a adotar");
    const { error } = await admin
      .from("ai_playbooks")
      .update({
        metadata: {
          ...objectOrEmpty(atual.metadata),
          ...playbookBootstrapMetadata(AFB_PLAYBOOK_PERSISTIDO.slug),
        } as never,
      })
      .eq("id", playbookId)
      .eq("organization_id", organizationId);
    if (error) fail("adotar o playbook persistido da AFB");
    return {
      id: playbookId,
      versionId: atual.published_version_id === null ? null : String(atual.published_version_id),
      versionNumber: null,
      created: false,
      published: false,
      adopted: true,
    };
  }

  async recordAudit(organizationId: string, summary: AfbProvisioningAuditSummary): Promise<void> {
    await audit({
      action: "afb.bootstrap_applied",
      organizationId,
      resourceType: "organization",
      resourceId: organizationId,
      requestId: randomUUID(),
      bypassedRls: true,
      metadata: {
        bootstrap_version: AFB_BOOTSTRAP_VERSION,
        playbook_id: AFB_PLAYBOOK_ID,
        ...summary,
      },
    });
  }
}
