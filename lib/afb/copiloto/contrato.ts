/**
 * O CONTRATO da rota `GET /api/v1/afb/copiloto/[conversationId]` — só tipos.
 *
 * Separado de `contexto.ts` de propósito: aquele arquivo é o RESOLVEDOR e
 * importa, em tempo de execução, o registry (todo o conteúdo do playbook), o
 * gate e a regra de lead ativo. O hook do inbox precisa só do formato da
 * resposta, e um módulo de tipos puros é o que garante — inclusive por teste
 * que lê os imports — que nada disso vai para o bundle do navegador.
 *
 * Tudo aqui é `import type`; o arquivo não tem código de execução.
 *
 * JSON em snake_case, como toda resposta de `/api/v1/` (CLAUDE.md).
 */
import type { EtapaId } from "@/lib/afb/playbook/etapas";
import type { PapelId } from "@/lib/afb/playbook/papeis";
import type { LeadStatus } from "@/lib/types/leads";

import type { CamposDoLead } from "./campos";

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

export interface BaseDoContexto {
  conversation_id: string;
  contact_id: string | null;
  /** Avisos legíveis por máquina (snake_case) — a tela decide se e como mostra. */
  warnings: string[];
}

export interface EtapaDoPlaybookNoContexto {
  id: string;
  /** A etapa do playbook em que a conversa está — um `EtapaId` do motor. */
  stage_id: EtapaId;
  title: string;
  objective: string;
  /** De onde saiu a posição: do campo do lead, do início da coluna, ou ajustada. */
  position_origin: "gravada" | "inicial" | "ajustada";
  allowed_stage_ids: readonly EtapaId[];
}

export type ContextoDoCopiloto =
  | ({ status: "no_contact" } & BaseDoContexto)
  | ({ status: "no_lead" } & BaseDoContexto)
  | ({ status: "ambiguous_lead"; candidate_lead_ids: string[] } & BaseDoContexto)
  | ({ status: "inconsistent"; reason: "pipeline_not_found" | "stage_not_found"; lead: LeadNoContexto } & BaseDoContexto)
  | ({ status: "copilot_disabled"; lead: LeadNoContexto; pipeline: { id: string } } & BaseDoContexto)
  | ({ status: "no_playbook"; lead: LeadNoContexto; pipeline: { id: string } } & BaseDoContexto)
  | ({ status: "unknown_playbook"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string } } & BaseDoContexto)
  | ({ status: "terminal_won"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string }; stage: ColunaNoContexto } & BaseDoContexto)
  | ({ status: "terminal_lost"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string }; stage: ColunaNoContexto } & BaseDoContexto)
  | ({ status: "unmapped_stage"; lead: LeadNoContexto; pipeline: { id: string; playbook_id: string }; stage: ColunaNoContexto } & BaseDoContexto)
  | ({
      /** A coluna tem papel, mas o papel não tem etapa de WhatsApp (apresentação, fechamento, pós-venda). */
      status: "out_of_playbook";
      lead: LeadNoContexto;
      pipeline: { id: string; playbook_id: string };
      stage: ColunaNoContexto & { role: PapelId };
      fields: CamposDoLead;
    } & BaseDoContexto)
  | ({
      status: "active";
      lead: LeadNoContexto;
      pipeline: { id: string; playbook_id: string };
      stage: ColunaNoContexto & { role: PapelId };
      playbook: EtapaDoPlaybookNoContexto;
      fields: CamposDoLead;
    } & BaseDoContexto);

export type StatusDoContexto = ContextoDoCopiloto["status"];

/** O envelope que a rota devolve com 200. */
export interface RespostaDoContexto {
  data: ContextoDoCopiloto;
}
