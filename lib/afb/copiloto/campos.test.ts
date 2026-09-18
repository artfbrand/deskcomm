import { describe, expect, it } from "vitest";

import { CAMPOS_VAZIOS, lerCamposDoLead } from "./campos";

describe("lerCamposDoLead", () => {
  it("lê os campos do copiloto quando estão bem formados", () => {
    const r = lerCamposDoLead({
      etapa_playbook: "micro_spin",
      perfil_interlocutor: "decisor",
      variacao_abordagem: "A",
      status_followup: "ativa",
      interesse_reuniao: true,
      fatura_solicitada: "sim",
      fatura_recebida: "false",
      reuniao_realizada: false,
      data_reuniao: "2026-10-02",
      hora_reuniao: "14:30",
      empresa: "ignorado — não é campo do copiloto",
    });
    expect(r.malformado).toBe(false);
    expect(r.campos).toEqual({
      etapa_playbook: "micro_spin",
      perfil_interlocutor: "decisor",
      variacao_abordagem: "A",
      status_followup: "ativa",
      interesse_reuniao: true,
      fatura_solicitada: true,
      fatura_recebida: false,
      reuniao_realizada: false,
      data_reuniao: "2026-10-02",
      hora_reuniao: "14:30",
    });
  });

  it("custom_fields null/undefined → tudo null, sem marcar como malformado", () => {
    expect(lerCamposDoLead(null)).toEqual({ campos: CAMPOS_VAZIOS, malformado: false });
    expect(lerCamposDoLead(undefined)).toEqual({ campos: CAMPOS_VAZIOS, malformado: false });
    expect(lerCamposDoLead({})).toEqual({ campos: CAMPOS_VAZIOS, malformado: false });
  });

  it("custom_fields malformado (array, string, número) → tudo null e malformado=true, sem lançar", () => {
    for (const v of [[], "lixo", 42, true]) {
      expect(() => lerCamposDoLead(v)).not.toThrow();
      expect(lerCamposDoLead(v)).toEqual({ campos: CAMPOS_VAZIOS, malformado: true });
    }
  });

  it("valor de tipo errado vira null campo a campo, sem derrubar os outros", () => {
    const r = lerCamposDoLead({
      etapa_playbook: "Abertura", // não é EtapaId
      perfil_interlocutor: ["decisor"],
      variacao_abordagem: 7, // número vira texto
      status_followup: "   ",
      interesse_reuniao: 1, // 1/0 não é flag
      fatura_solicitada: "talvez",
      data_reuniao: { d: 1 },
      hora_reuniao: null,
    });
    expect(r.malformado).toBe(false);
    expect(r.campos.etapa_playbook).toBeNull();
    expect(r.campos.perfil_interlocutor).toBeNull();
    expect(r.campos.variacao_abordagem).toBe("7");
    expect(r.campos.status_followup).toBeNull();
    expect(r.campos.interesse_reuniao).toBeNull();
    expect(r.campos.fatura_solicitada).toBeNull();
    expect(r.campos.data_reuniao).toBeNull();
    expect(r.campos.hora_reuniao).toBeNull();
  });
});
