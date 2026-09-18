/**
 * O CONTEXTO do copiloto para uma conversa — a regra pura, sem banco.
 *
 * Recebe o que o carregador já leu (conversa, leads do contato, funil, coluna)
 * e devolve um contrato DISCRIMINADO: cada situação em que o copiloto não pode
 * agir tem nome próprio, para a tela dizer o que falta em vez de mostrar um
 * painel vazio. Nada aqui chuta:
 *
 *   - o lead é o que `resolveActiveLeadForContact` devolve; empate é
 *     `ambiguous_lead`, com os candidatos, e não "o mais recente";
 *   - `is_won`/`is_lost` vencem qualquer configuração (`terminal_*`);
 *   - o papel da coluna vem do mapa por ID, nunca do nome;
 *   - o playbook vem do id gravado no funil, nunca do nome do funil;
 *   - `custom_fields` torto vira `null` campo a campo, com aviso.
 *
 * JSON em snake_case, como toda resposta de `/api/v1/` (CLAUDE.md).
 */
import { lerConfiguracaoDoCopiloto, papelDaEtapaDoFunil, posicaoNoPlaybook } from "@/lib/afb/playbook/mapeamento";
import type { EtapaId } from "@/lib/afb/playbook/etapas";
import type { PapelId } from "@/lib/afb/playbook/papeis";
import { estadoDoCopiloto } from "@/lib/afb/gate";
import { etapaDoPlaybookComercial } from "@/lib/afb/playbooks/registry";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import type { LeadStatus } from "@/lib/types/leads";

import { lerCamposDoLead, type CamposDoLead } from "./campos";

// ─── Entrada (o que o carregador lê) ─────────────────────────────────────────

export interface ConversaMinima {
  id: string;
  organization_id: string;
  contact_id: string | null;
}

export interface LeadDoCopiloto extends LeadCandidate {
  title: string;
  stage_id: string;
  updated_at: string;
  custom_fields: unknown;
}

export interface FunilMinimo {
  id: string;
  organization_id: string;
  settings: Record<string, unknown> | null;
}

export interface ColunaMinima {
  id: string;
  organization_id: string;
  pipeline_id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
}

// ─── Saída (o contrato da rota) ──────────────────────────────────────────────

export interface LeadNoContexto {
  id: string;
  title: string;
  pipeline_id: string;
  stage_id: string;
  status: LeadStatus;
  updated_at: string;
}

export interface ColunaNoContexto {
  id: string;
  name: string;
  /** `null` quando a coluna não está no mapa do copiloto. */
  role: PapelId | null;
}

interface Base {
  conversation_id: string;
  contact_id: string | null;
  warnings: string[];
}

export type ContextoDoCopiloto =
  | ({ status: "no_contact" } & Base)
  | ({ status: "no_lead" } & Base)
  | ({ status: "ambiguous_lead"; candidate_lead_ids: string[] } & Base)
  | ({ status: "inconsistent"; reason: "pipeline_not_found" | "stage_not_found"; lead: LeadNoContexto } & Base)
  | ({ status: "copilot_disabled"; lead: LeadNoContexto; pipeline: { id: string } } & Base)
  | ({ status: "no_playbook"; lead: LeadNoContexto; pipeline: { id: string } } & Base)
  | ({ status: "unknown_playbook"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string } } & Base)
  | ({ status: "terminal_won"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string }; stage: ColunaNoContexto } & Base)
  | ({ status: "terminal_lost"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string }; stage: ColunaNoContexto } & Base)
  | ({ status: "unmapped_stage"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string }; stage: ColunaNoContexto } & Base)
  | ({
      /** A coluna tem papel, mas o papel não tem etapa de WhatsApp (apresentação, fechamento, pós-venda). */
      status: "out_of_playbook";
      lead: LeadNoContexto;
      pipeline: { id: string; playbook_id: string };
      stage: ColunaNoContexto & { role: PapelId };
      fields: CamposDoLead;
    } & Base)
  | ({
      status: "active";
      lead: LeadNoContexto;
      pipeline: { id: string; playbook_id: string };
      stage: ColunaNoContexto & { role: PapelId };
      playbook: {
        id: string;
        /** A etapa do playbook em que a conversa está — um `EtapaId` do motor. */
        stage_id: EtapaId;
        title: string;
        objective: string;
        /** De onde saiu a posição: do campo do lead, do início da coluna, ou ajustada. */
        position_origin: "gravada" | "inicial" | "ajustada";
        allowed_stage_ids: readonly EtapaId[];
      };
      fields: CamposDoLead;
    } & Base);

export type StatusDoContexto = ContextoDoCopiloto["status"];

// ─── Passo 1: qual lead ──────────────────────────────────────────────────────

export type EscolhaDeLead =
  | { tipo: "no_contact" }
  | { tipo: "no_lead" }
  | { tipo: "ambiguous_lead"; candidateIds: string[] }
  | { tipo: "escolhido"; lead: LeadDoCopiloto };

/**
 * Passa pelo `resolveActiveLeadForContact` do core — a mesma regra que roteia
 * atividade do agente — e traduz para o vocabulário do contexto. Sem
 * heurística própria: se o core não escolhe, a tela pergunta.
 */
export function escolherLead(
  conversa: ConversaMinima,
  leads: readonly LeadDoCopiloto[],
  pipelinePadraoId: string | null,
): EscolhaDeLead {
  if (!conversa.contact_id) return { tipo: "no_contact" };
  const r = resolveActiveLeadForContact([...leads], { defaultPipelineId: pipelinePadraoId });
  if (!r.routed) {
    return r.reason === "ambiguous_open_leads"
      ? { tipo: "ambiguous_lead", candidateIds: r.candidateIds }
      : { tipo: "no_lead" };
  }
  const lead = leads.find((l) => l.id === r.leadId);
  return lead ? { tipo: "escolhido", lead } : { tipo: "no_lead" };
}

// ─── Passo 2: o contexto ─────────────────────────────────────────────────────

function leadNoContexto(l: LeadDoCopiloto): LeadNoContexto {
  return { id: l.id, title: l.title, pipeline_id: l.pipeline_id, stage_id: l.stage_id, status: l.status, updated_at: l.updated_at };
}

export interface EntradaDoContexto {
  conversa: ConversaMinima;
  lead: LeadDoCopiloto;
  /** `null` quando o carregador não achou o funil DENTRO do tenant. */
  pipeline: FunilMinimo | null;
  /** `null` quando o carregador não achou a coluna DENTRO do tenant e do funil. */
  stage: ColunaMinima | null;
}

export function montarContexto(entrada: EntradaDoContexto): ContextoDoCopiloto {
  const { conversa, lead, pipeline, stage } = entrada;
  const base: Base = { conversation_id: conversa.id, contact_id: conversa.contact_id, warnings: [] };
  const leadOut = leadNoContexto(lead);

  // Integridade de tenant: o carregador filtra por organização; se o funil ou
  // a coluna do lead não apareceram, ou não são deste tenant ou não existem.
  // Declarado, nunca contornado com outra consulta.
  if (!pipeline || pipeline.organization_id !== conversa.organization_id || pipeline.id !== lead.pipeline_id) {
    return { ...base, status: "inconsistent", reason: "pipeline_not_found", lead: leadOut };
  }
  if (!stage || stage.organization_id !== conversa.organization_id || stage.pipeline_id !== pipeline.id || stage.id !== lead.stage_id) {
    return { ...base, status: "inconsistent", reason: "stage_not_found", lead: leadOut };
  }

  const estado = estadoDoCopiloto(pipeline.settings);
  if (estado.estado === "desligado") return { ...base, status: "copilot_disabled", lead: leadOut, pipeline: { id: pipeline.id } };
  if (estado.estado === "sem_playbook") return { ...base, status: "no_playbook", lead: leadOut, pipeline: { id: pipeline.id } };
  if (estado.estado === "playbook_desconhecido") {
    return { ...base, status: "unknown_playbook", lead: leadOut, pipeline: { id: pipeline.id, playbook_id: estado.playbookId } };
  }
  const playbook = estado.playbook;
  const pipelineOut = { id: pipeline.id, playbook_id: playbook.id };

  const config = lerConfiguracaoDoCopiloto(pipeline.settings);
  if (config.descartadas > 0) base.warnings.push(`mapa_de_etapas_com_${config.descartadas}_entradas_invalidas`);

  const papel = papelDaEtapaDoFunil({ id: stage.id, is_won: stage.is_won, is_lost: stage.is_lost }, config);
  const stageOut: ColunaNoContexto = { id: stage.id, name: stage.name, role: papel.mapeada ? papel.papel.id : null };

  // Marcação do CRM vence tudo — antes de olhar mapa ou campo.
  if (stage.is_won) return { ...base, status: "terminal_won", lead: leadOut, pipeline: pipelineOut, stage: { ...stageOut, role: "ganho" } };
  if (stage.is_lost) return { ...base, status: "terminal_lost", lead: leadOut, pipeline: pipelineOut, stage: { ...stageOut, role: "perdido" } };
  if (!papel.mapeada) return { ...base, status: "unmapped_stage", lead: leadOut, pipeline: pipelineOut, stage: stageOut };

  const leitura = lerCamposDoLead(lead.custom_fields);
  if (leitura.malformado) base.warnings.push("custom_fields_malformado");
  const stageComPapel = { ...stageOut, role: papel.papel.id };

  const posicao = posicaoNoPlaybook(papel.papel, leitura.campos.etapa_playbook);
  if (posicao.etapa === null) {
    return { ...base, status: "out_of_playbook", lead: leadOut, pipeline: pipelineOut, stage: stageComPapel, fields: leitura.campos };
  }
  if (posicao.origem === "ajustada") base.warnings.push("etapa_playbook_ajustada_para_a_coluna");

  const etapa = etapaDoPlaybookComercial(playbook, posicao.etapa);
  // O papel diz que a etapa cabe aqui, mas este playbook não a cobre: é
  // conteúdo faltando, e a tela precisa saber — não um painel em branco.
  if (!etapa) {
    base.warnings.push(`playbook_sem_conteudo_para_${posicao.etapa}`);
    return { ...base, status: "out_of_playbook", lead: leadOut, pipeline: pipelineOut, stage: stageComPapel, fields: leitura.campos };
  }

  return {
    ...base,
    status: "active",
    lead: leadOut,
    pipeline: pipelineOut,
    stage: stageComPapel,
    playbook: {
      id: playbook.id,
      stage_id: posicao.etapa,
      title: etapa.titulo,
      objective: etapa.objetivo,
      position_origin: posicao.origem,
      allowed_stage_ids: posicao.permitidas,
    },
    fields: leitura.campos,
  };
}
