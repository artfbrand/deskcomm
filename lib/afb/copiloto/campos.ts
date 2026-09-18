/**
 * Leitura DEFENSIVA dos `custom_fields` do lead que o copiloto usa.
 *
 * `crm_leads.custom_fields` é jsonb sem schema no banco: o PATCH faz merge
 * raso e não valida contra `pipeline.settings.fields` (ver
 * `updateLeadHandler`). Então o que chega aqui pode ser `null`, array,
 * string, número onde se esperava texto, "true" onde se esperava booleano.
 * Nada disso lança — o copiloto está renderizando — e cada campo sai como
 * `null` quando não tem forma que o playbook saiba usar.
 *
 * Só LEITURA. Gravar é de outra etapa e passa pelo PATCH do lead.
 */
import { CAMPOS_DO_COPILOTO } from "@/lib/afb/playbook/campos";
import { ehEtapaId, type EtapaId } from "@/lib/afb/playbook/etapas";

export interface CamposDoLead {
  /** Só um `EtapaId` válido sobrevive; qualquer outro valor vira `null`. */
  etapa_playbook: EtapaId | null;
  perfil_interlocutor: string | null;
  variacao_abordagem: string | null;
  status_followup: string | null;
  interesse_reuniao: boolean | null;
  fatura_solicitada: boolean | null;
  fatura_recebida: boolean | null;
  reuniao_realizada: boolean | null;
  data_reuniao: string | null;
  hora_reuniao: string | null;
}

export const CAMPOS_VAZIOS: CamposDoLead = {
  etapa_playbook: null,
  perfil_interlocutor: null,
  variacao_abordagem: null,
  status_followup: null,
  interesse_reuniao: null,
  fatura_solicitada: null,
  fatura_recebida: null,
  reuniao_realizada: null,
  data_reuniao: null,
  hora_reuniao: null,
};

function objetoSimples(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/** Texto não-vazio, aparado; número vira texto; o resto é `null`. */
function texto(valor: unknown): string | null {
  if (typeof valor === "string") {
    const v = valor.trim();
    return v === "" ? null : v;
  }
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return null;
}

/**
 * Booleano de verdade, ou as grafias que um campo `boolean`/`select` da tela
 * costuma gravar ("true"/"false", "sim"/"não"). Qualquer outra coisa é `null`
 * — inclusive `1`/`0`, que num jsonb solto tanto pode ser flag quanto contagem.
 */
function flag(valor: unknown): boolean | null {
  if (typeof valor === "boolean") return valor;
  if (typeof valor !== "string") return null;
  const v = valor.trim().toLowerCase();
  if (v === "true" || v === "sim") return true;
  if (v === "false" || v === "não" || v === "nao") return false;
  return null;
}

export interface LeituraDeCampos {
  campos: CamposDoLead;
  /** `custom_fields` não era objeto (null, array, string…): tudo veio como `null`. */
  malformado: boolean;
}

export function lerCamposDoLead(customFields: unknown): LeituraDeCampos {
  if (!objetoSimples(customFields)) {
    return { campos: CAMPOS_VAZIOS, malformado: customFields !== null && customFields !== undefined };
  }
  const c = customFields;
  const etapa = c[CAMPOS_DO_COPILOTO.etapa_playbook];
  return {
    malformado: false,
    campos: {
      etapa_playbook: ehEtapaId(etapa) ? etapa : null,
      perfil_interlocutor: texto(c[CAMPOS_DO_COPILOTO.perfil_interlocutor]),
      variacao_abordagem: texto(c[CAMPOS_DO_COPILOTO.variacao_abordagem]),
      status_followup: texto(c[CAMPOS_DO_COPILOTO.status_followup]),
      interesse_reuniao: flag(c.interesse_reuniao),
      fatura_solicitada: flag(c.fatura_solicitada),
      fatura_recebida: flag(c.fatura_recebida),
      reuniao_realizada: flag(c.reuniao_realizada),
      data_reuniao: texto(c.data_reuniao),
      hora_reuniao: texto(c.hora_reuniao),
    },
  };
}
