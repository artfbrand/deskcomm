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

import { lerBindingDoCopiloto, type BindingDoCopiloto } from "@/lib/afb/copiloto/binding";

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
  | {
      tipo: "ok";
      contexto: ContextoDoCopiloto;
      /**
       * O binding do funil — CANAL INTERNO, irmão do contexto e nunca dentro
       * dele.
       *
       * A rota responde `ok(resultado.contexto)`; este campo fica de fora do
       * JSON por construção, não por lembrança. Foi por isso que ele não virou
       * um campo do `ContextoDoCopiloto`: ali entraria na resposta pública, e
       * o endereço interno do playbook não tem por que chegar ao browser.
       *
       * Quem consome é o shadow, depois da resposta. Nada do runtime o lê.
       */
      binding: BindingDoCopiloto;
    };

/** Nenhum funil carregado ⇒ nenhum binding. Não é falha; é ausência. */
const SEM_BINDING: BindingDoCopiloto = { origem: "ausente" };

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
  if (!conversa.contact_id) return { tipo: "ok", contexto: { ...base, status: "no_contact" }, binding: SEM_BINDING };

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
  if (escolha.tipo === "no_contact") return { tipo: "ok", contexto: { ...base, status: "no_contact" }, binding: SEM_BINDING };
  if (escolha.tipo === "no_lead") return { tipo: "ok", contexto: { ...base, status: "no_lead" }, binding: SEM_BINDING };
  if (escolha.tipo === "ambiguous_lead") {
    return {
      tipo: "ok",
      contexto: { ...base, status: "ambiguous_lead", candidate_lead_ids: escolha.candidateIds },
      binding: SEM_BINDING,
    };
  }
  const lead = escolha.lead;

  const [pipeline, stage] = await Promise.all([
    supabase
      .from("crm_pipelines")
      // `ai_playbook_id` (migration 0234) é o binding persistido. Ele PRECISA
      // estar aqui: `lerBindingDoCopiloto` trata coluna ausente como
      // `undefined`, que libera o caminho legado — então esquecê-lo faria tudo
      // "funcionar" pelo legado e esconderia a ausência do binding novo. Há
      // teste que lê esta string e reprova a remoção.
      .select("id, organization_id, settings, ai_playbook_id")
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

  // A coluna do binding é lida da linha CRUA, antes do estreitamento para
  // `FunilMinimo`: o tipo do contexto não a conhece, e não precisa conhecer —
  // ela não participa de nada que o Copiloto responde.
  const funil = pipeline.data as (FunilMinimo & { ai_playbook_id?: unknown }) | null;

  return {
    tipo: "ok",
    contexto: montarContexto({
      conversa,
      lead,
      pipeline: funil ?? null,
      stage: (stage.data as ColunaMinima | null) ?? null,
    }),
    binding: lerBindingDoCopiloto({
      aiPlaybookId: funil?.ai_playbook_id,
      settings: funil?.settings ?? null,
    }),
  };
}
