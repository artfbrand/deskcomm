/**
 * O contexto do copiloto — a regra pura, caso a caso.
 *
 * Nenhum nome de coluna ou de funil aparece como REGRA: as fixturas têm nomes
 * só para a tela mostrar, e a resolução passa por id, marcação e mapa.
 */
import { describe, expect, it } from "vitest";

import { escolherLead, montarContexto, type ColunaMinima, type ConversaMinima, type FunilMinimo, type LeadDoCopiloto } from "./contexto";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const OUTRA_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONTATO = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const FUNIL = "cccccccc-cccc-4ccc-8ccc-000000000001";
const COL_CONVERSA = "dddddddd-dddd-4ddd-8ddd-000000000002";
const COL_REUNIAO = "dddddddd-dddd-4ddd-8ddd-000000000004";
const COL_APRESENTACAO = "dddddddd-dddd-4ddd-8ddd-000000000005";
const COL_GANHO = "dddddddd-dddd-4ddd-8ddd-000000000009";
const COL_PERDIDO = "dddddddd-dddd-4ddd-8ddd-000000000010";
const COL_SEM_MAPA = "dddddddd-dddd-4ddd-8ddd-000000000099";

const conversa: ConversaMinima = { id: "conv-1", organization_id: ORG, contact_id: CONTATO };

function lead(over: Partial<LeadDoCopiloto> = {}): LeadDoCopiloto {
  return {
    id: "lead-1",
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: COL_CONVERSA,
    status: "open",
    title: "Carlos — Metalúrgica",
    updated_at: "2026-09-18T12:00:00Z",
    last_activity_at: "2026-09-18T12:00:00Z",
    created_at: "2026-09-01T12:00:00Z",
    custom_fields: { etapa_playbook: "gancho_de_valor", perfil_interlocutor: "decisor" },
    ...over,
  };
}

const SETTINGS_PRONTO = {
  modulos: {
    copiloto_comercial: {
      enabled: true,
      playbook_id: "afb_comercial_v1",
      etapas: {
        [COL_CONVERSA]: "conversa",
        [COL_REUNIAO]: "reuniao_agendada",
        [COL_APRESENTACAO]: "apresentacao",
      },
    },
  },
};

function funil(settings: Record<string, unknown> | null = SETTINGS_PRONTO, over: Partial<FunilMinimo> = {}): FunilMinimo {
  return { id: FUNIL, organization_id: ORG, settings, ...over };
}

function coluna(id: string, over: Partial<ColunaMinima> = {}): ColunaMinima {
  return { id, organization_id: ORG, pipeline_id: FUNIL, name: "Uma coluna", is_won: false, is_lost: false, ...over };
}

describe("escolherLead", () => {
  it("conversa sem contact_id → no_contact, antes de olhar lead nenhum", () => {
    expect(escolherLead({ ...conversa, contact_id: null }, [lead()], null)).toEqual({ tipo: "no_contact" });
  });

  it("contato sem lead (ou só fechados) → no_lead", () => {
    expect(escolherLead(conversa, [], null)).toEqual({ tipo: "no_lead" });
    expect(escolherLead(conversa, [lead({ status: "won" })], null)).toEqual({ tipo: "no_lead" });
  });

  it("um lead aberto → escolhido, mesmo sem funil padrão", () => {
    const r = escolherLead(conversa, [lead()], null);
    expect(r.tipo === "escolhido" && r.lead.id).toBe("lead-1");
  });

  it("dois leads abertos empatados → ambiguous_lead com os candidatos, sem escolher o mais recente", () => {
    const a = lead({ id: "lead-a" });
    const b = lead({ id: "lead-b", pipeline_id: "cccccccc-cccc-4ccc-8ccc-000000000002" });
    const r = escolherLead(conversa, [a, b], null);
    expect(r).toEqual({ tipo: "ambiguous_lead", candidateIds: ["lead-a", "lead-b"] });
  });

  it("dois leads abertos e um deles no funil padrão → o do padrão (regra do core)", () => {
    const a = lead({ id: "lead-a" });
    const b = lead({ id: "lead-b", pipeline_id: "cccccccc-cccc-4ccc-8ccc-000000000002" });
    const r = escolherLead(conversa, [a, b], FUNIL);
    expect(r.tipo === "escolhido" && r.lead.id).toBe("lead-a");
  });

  it("lista com lead de outra organização estoura — bug de chamador, não ambiguidade", () => {
    expect(() => escolherLead(conversa, [lead(), lead({ id: "x", organization_id: OUTRA_ORG })], null)).toThrow(/organization_id/);
  });
});

describe("montarContexto", () => {
  it("1. conversa válida + lead + copiloto pronto → active, com etapa do playbook e campos", () => {
    const r = montarContexto({ conversa, lead: lead(), pipeline: funil(), stage: coluna(COL_CONVERSA, { name: "Contato Feito" }) });
    expect(r.status).toBe("active");
    if (r.status !== "active") return;
    expect(r.conversation_id).toBe("conv-1");
    expect(r.contact_id).toBe(CONTATO);
    expect(r.lead).toEqual({ id: "lead-1", title: "Carlos — Metalúrgica", pipeline_id: FUNIL, stage_id: COL_CONVERSA, status: "open", updated_at: "2026-09-18T12:00:00Z" });
    expect(r.pipeline).toEqual({ id: FUNIL, playbook_id: "afb_comercial_v1" });
    expect(r.stage).toEqual({ id: COL_CONVERSA, name: "Contato Feito", role: "conversa" });
    expect(r.playbook.stage_id).toBe("gancho_de_valor");
    expect(r.playbook.position_origin).toBe("gravada");
    expect(r.playbook.title).toBe("Gancho de valor");
    expect(r.playbook.objective.length).toBeGreaterThan(10);
    expect(r.playbook.allowed_stage_ids).toEqual(["qualificacao", "gancho_de_valor", "desarme_de_risco", "micro_spin", "convite"]);
    expect(r.fields.perfil_interlocutor).toBe("decisor");
    expect(r.warnings).toEqual([]);
  });

  it("sem etapa_playbook gravada, começa na primeira da coluna (origem inicial)", () => {
    const r = montarContexto({ conversa, lead: lead({ custom_fields: {} }), pipeline: funil(), stage: coluna(COL_CONVERSA) });
    expect(r.status === "active" && r.playbook.stage_id).toBe("qualificacao");
    expect(r.status === "active" && r.playbook.position_origin).toBe("inicial");
  });

  it("etapa_playbook de outra coluna é ajustada, e a resposta AVISA", () => {
    const r = montarContexto({ conversa, lead: lead({ stage_id: COL_REUNIAO, custom_fields: { etapa_playbook: "micro_spin" } }), pipeline: funil(), stage: coluna(COL_REUNIAO) });
    expect(r.status === "active" && r.playbook.stage_id).toBe("pos_sim");
    expect(r.status === "active" && r.playbook.position_origin).toBe("ajustada");
    expect(r.warnings).toContain("etapa_playbook_ajustada_para_a_coluna");
  });

  it("5. copiloto desligado → copilot_disabled", () => {
    const r = montarContexto({ conversa, lead: lead(), pipeline: funil({ modulos: { copiloto_comercial: { enabled: false, playbook_id: "afb_comercial_v1" } } }), stage: coluna(COL_CONVERSA) });
    expect(r).toMatchObject({ status: "copilot_disabled", pipeline: { id: FUNIL } });
  });

  it("6. enabled sem playbook_id → no_playbook (nada é escolhido por baixo dos panos)", () => {
    const r = montarContexto({ conversa, lead: lead(), pipeline: funil({ modulos: { copiloto_comercial: { enabled: true } } }), stage: coluna(COL_CONVERSA) });
    expect(r.status).toBe("no_playbook");
  });

  it("7. playbook com forma válida mas fora do registry → unknown_playbook, com o id", () => {
    const r = montarContexto({ conversa, lead: lead(), pipeline: funil({ modulos: { copiloto_comercial: { enabled: true, playbook_id: "afb_prospeccao_v1" } } }), stage: coluna(COL_CONVERSA) });
    expect(r).toMatchObject({ status: "unknown_playbook", pipeline: { id: FUNIL, playbook_id: "afb_prospeccao_v1" } });
  });

  it("8. coluna sem papel no mapa → unmapped_stage (nunca inferido pelo nome «Contato Feito»)", () => {
    const r = montarContexto({ conversa, lead: lead({ stage_id: COL_SEM_MAPA }), pipeline: funil(), stage: coluna(COL_SEM_MAPA, { name: "Contato Feito" }) });
    expect(r).toMatchObject({ status: "unmapped_stage", stage: { id: COL_SEM_MAPA, name: "Contato Feito", role: null } });
  });

  it("9. is_won → terminal_won, mesmo com mapa dizendo outra coisa", () => {
    const settings = { modulos: { copiloto_comercial: { ...SETTINGS_PRONTO.modulos.copiloto_comercial, etapas: { [COL_GANHO]: "conversa" } } } };
    const r = montarContexto({ conversa, lead: lead({ stage_id: COL_GANHO }), pipeline: funil(settings), stage: coluna(COL_GANHO, { is_won: true }) });
    expect(r).toMatchObject({ status: "terminal_won", stage: { role: "ganho" } });
  });

  it("10. is_lost → terminal_lost", () => {
    const r = montarContexto({ conversa, lead: lead({ stage_id: COL_PERDIDO }), pipeline: funil(), stage: coluna(COL_PERDIDO, { is_lost: true }) });
    expect(r).toMatchObject({ status: "terminal_lost", stage: { role: "perdido" } });
  });

  it("coluna com papel sem etapa de WhatsApp (apresentação) → out_of_playbook, com campos", () => {
    const r = montarContexto({ conversa, lead: lead({ stage_id: COL_APRESENTACAO }), pipeline: funil(), stage: coluna(COL_APRESENTACAO) });
    expect(r).toMatchObject({ status: "out_of_playbook", stage: { role: "apresentacao" } });
    expect(r.status === "out_of_playbook" && r.fields.perfil_interlocutor).toBe("decisor");
  });

  it("11. custom_fields null → active com campos null, sem aviso", () => {
    const r = montarContexto({ conversa, lead: lead({ custom_fields: null }), pipeline: funil(), stage: coluna(COL_CONVERSA) });
    expect(r.status).toBe("active");
    expect(r.status === "active" && r.fields.etapa_playbook).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("12. custom_fields malformado → active com campos null e AVISO, sem lançar", () => {
    for (const cf of ["lixo", [1, 2], 7]) {
      const r = montarContexto({ conversa, lead: lead({ custom_fields: cf }), pipeline: funil(), stage: coluna(COL_CONVERSA) });
      expect(r.status).toBe("active");
      expect(r.warnings).toContain("custom_fields_malformado");
    }
  });

  it("13. funil de outra organização (ou ausente) não vaza: inconsistent, sem ler o mapa dele", () => {
    const deOutraOrg = funil(SETTINGS_PRONTO, { organization_id: OUTRA_ORG });
    expect(montarContexto({ conversa, lead: lead(), pipeline: deOutraOrg, stage: coluna(COL_CONVERSA) })).toMatchObject({ status: "inconsistent", reason: "pipeline_not_found" });
    expect(montarContexto({ conversa, lead: lead(), pipeline: null, stage: coluna(COL_CONVERSA) })).toMatchObject({ status: "inconsistent", reason: "pipeline_not_found" });
  });

  it("14. coluna de outra organização, de outro funil ou ausente não vaza: inconsistent", () => {
    expect(montarContexto({ conversa, lead: lead(), pipeline: funil(), stage: coluna(COL_CONVERSA, { organization_id: OUTRA_ORG }) })).toMatchObject({ status: "inconsistent", reason: "stage_not_found" });
    expect(montarContexto({ conversa, lead: lead(), pipeline: funil(), stage: coluna(COL_CONVERSA, { pipeline_id: "cccccccc-cccc-4ccc-8ccc-000000000002" }) })).toMatchObject({ status: "inconsistent", reason: "stage_not_found" });
    expect(montarContexto({ conversa, lead: lead(), pipeline: funil(), stage: null })).toMatchObject({ status: "inconsistent", reason: "stage_not_found" });
  });

  it("mapa com entradas inválidas resolve o que dá e avisa", () => {
    const settings = { modulos: { copiloto_comercial: { ...SETTINGS_PRONTO.modulos.copiloto_comercial, etapas: { [COL_CONVERSA]: "conversa", [COL_REUNIAO]: "papel_inventado" } } } };
    const r = montarContexto({ conversa, lead: lead(), pipeline: funil(settings), stage: coluna(COL_CONVERSA) });
    expect(r.status).toBe("active");
    expect(r.warnings).toContain("mapa_de_etapas_com_1_entradas_invalidas");
  });

  it("o JSON é snake_case de ponta a ponta", () => {
    const r = montarContexto({ conversa, lead: lead(), pipeline: funil(), stage: coluna(COL_CONVERSA) });
    const chaves = JSON.stringify(r).match(/"([a-zA-Z_]+)":/g)!.map((k) => k.slice(1, -2));
    for (const k of chaves) expect(k, k).toMatch(/^[a-z_]+$/);
  });
});
