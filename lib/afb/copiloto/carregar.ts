/**
 * Carrega, DENTRO DO TENANT, tudo que `montarContexto` precisa.
 *
 * Cliente de SESSÃO (RLS), nunca admin — e mesmo assim toda consulta filtra
 * `organization_id` explicitamente (CLAUDE.md): a RLS enxerga todas as
 * organizações do usuário (`fn_user_org_ids()`), e sem o filtro uma conversa
 * de outra org do mesmo usuário seria lida como se fosse da ativa. O
 * `organization_id` vem da sessão (`requireRole`), nunca do pedido.
 *
 * Só o `conversationId` vem do cliente. Contato, leads, funil e coluna são
 * resolvidos a partir dele, cada um filtrado pelo tenant — id de lead ou de
 * funil mandado pelo cliente seria confiar no que se quer verificar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  escolherLead,
  montarContexto,
  type ColunaMinima,
  type ContextoDoCopiloto,
  type ConversaMinima,
  type FunilMinimo,
  type LeadDoCopiloto,
} from "./contexto";

type Cliente = SupabaseClient;

export type Carregamento =
  | { tipo: "conversa_nao_encontrada" }
  | { tipo: "falha"; mensagem: string }
  | { tipo: "ok"; contexto: ContextoDoCopiloto };

const LEAD_COLS = "id, organization_id, pipeline_id, stage_id, status, title, updated_at, last_activity_at, created_at, custom_fields";

export async function carregarContextoDoCopiloto(
  supabase: Cliente,
  orgId: string,
  conversationId: string,
): Promise<Carregamento> {
  const conv = await supabase
    .from("conversations")
    .select("id, organization_id, contact_id")
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (conv.error) return { tipo: "falha", mensagem: conv.error.message };
  if (!conv.data) return { tipo: "conversa_nao_encontrada" };
  const conversa = conv.data as ConversaMinima;

  const base = { conversation_id: conversa.id, contact_id: conversa.contact_id, warnings: [] as string[] };
  if (!conversa.contact_id) return { tipo: "ok", contexto: { ...base, status: "no_contact" } };

  const [leads, padrao] = await Promise.all([
    supabase
      .from("crm_leads")
      .select(LEAD_COLS)
      .eq("contact_id", conversa.contact_id)
      .eq("organization_id", orgId),
    supabase
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", orgId)
      .eq("is_default", true)
      .eq("is_archived", false)
      .maybeSingle(),
  ]);
  if (leads.error) return { tipo: "falha", mensagem: leads.error.message };
  if (padrao.error) return { tipo: "falha", mensagem: padrao.error.message };

  const escolha = escolherLead(
    conversa,
    (leads.data ?? []) as LeadDoCopiloto[],
    (padrao.data as { id: string } | null)?.id ?? null,
  );
  if (escolha.tipo === "no_contact") return { tipo: "ok", contexto: { ...base, status: "no_contact" } };
  if (escolha.tipo === "no_lead") return { tipo: "ok", contexto: { ...base, status: "no_lead" } };
  if (escolha.tipo === "ambiguous_lead") {
    return { tipo: "ok", contexto: { ...base, status: "ambiguous_lead", candidate_lead_ids: escolha.candidateIds } };
  }
  const lead = escolha.lead;

  const [pipeline, stage] = await Promise.all([
    supabase
      .from("crm_pipelines")
      .select("id, organization_id, settings")
      .eq("id", lead.pipeline_id)
      .eq("organization_id", orgId)
      .maybeSingle(),
    supabase
      .from("crm_stages")
      .select("id, organization_id, pipeline_id, name, is_won, is_lost")
      .eq("id", lead.stage_id)
      .eq("pipeline_id", lead.pipeline_id)
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);
  if (pipeline.error) return { tipo: "falha", mensagem: pipeline.error.message };
  if (stage.error) return { tipo: "falha", mensagem: stage.error.message };

  return {
    tipo: "ok",
    contexto: montarContexto({
      conversa,
      lead,
      pipeline: (pipeline.data as FunilMinimo | null) ?? null,
      stage: (stage.data as ColunaMinima | null) ?? null,
    }),
  };
}
