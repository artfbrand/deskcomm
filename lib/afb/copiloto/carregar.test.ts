/**
 * O carregador — o que ele PERGUNTA ao banco, e com quais filtros.
 *
 * O Supabase falso registra cada consulta (tabela + filtros `eq`) e responde
 * do que a fixtura tem, aplicando os filtros de verdade. Assim "não vaza" é
 * medido: uma conversa de outra org está na fixtura, e só não volta porque
 * o carregador filtrou por `organization_id` — não porque o mock a escondeu.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { carregarContextoDoCopiloto } from "./carregar";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const OUTRA_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONTATO = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const FUNIL = "cccccccc-cccc-4ccc-8ccc-000000000001";
const FUNIL_ALHEIO = "cccccccc-cccc-4ccc-8ccc-000000000002";
const COL = "dddddddd-dddd-4ddd-8ddd-000000000002";
const COL_ALHEIA = "dddddddd-dddd-4ddd-8ddd-000000000003";

type Linha = Record<string, unknown>;
interface Consulta { tabela: string; filtros: Record<string, unknown> }

interface Tabelas {
  conversations: Linha[];
  crm_leads: Linha[];
  crm_pipelines: Linha[];
  crm_stages: Linha[];
}
let tabelas: Tabelas;
let consultas: Consulta[];

/** Supabase falso: aplica os `eq` de verdade e registra o que foi perguntado. */
function clienteFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const cadeia = {
        select: () => cadeia,
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return cadeia;
        },
        maybeSingle: async () => {
          consultas.push({ tabela, filtros });
          const linhas = aplicar(tabela, filtros);
          return { data: linhas[0] ?? null, error: null };
        },
        then: (r: (v: unknown) => unknown) => {
          consultas.push({ tabela, filtros });
          return r({ data: aplicar(tabela, filtros), error: null });
        },
      };
      return cadeia;
    },
  };
}

function aplicar(tabela: string, filtros: Record<string, unknown>): Linha[] {
  return (tabelas[tabela as keyof Tabelas] ?? []).filter((l) => Object.entries(filtros).every(([k, v]) => l[k] === v));
}

const SETTINGS = { modulos: { copiloto_comercial: { enabled: true, playbook_id: "afb_comercial_v1", etapas: { [COL]: "conversa" } } } };

beforeEach(() => {
  consultas = [];
  tabelas = {
    conversations: [
      { id: "conv-1", organization_id: ORG, contact_id: CONTATO },
      { id: "conv-sem-contato", organization_id: ORG, contact_id: null },
      { id: "conv-alheia", organization_id: OUTRA_ORG, contact_id: CONTATO },
    ],
    crm_leads: [
      {
        id: "lead-1", organization_id: ORG, pipeline_id: FUNIL, stage_id: COL, status: "open", title: "Carlos",
        updated_at: "2026-09-18T12:00:00Z", last_activity_at: "2026-09-18T12:00:00Z", created_at: "2026-09-01T00:00:00Z",
        custom_fields: { etapa_playbook: "convite" }, contact_id: CONTATO,
      },
      // Lead do MESMO contato em outra org: o filtro de org é o que o mantém fora.
      {
        id: "lead-alheio", organization_id: OUTRA_ORG, pipeline_id: FUNIL_ALHEIO, stage_id: COL_ALHEIA, status: "open", title: "x",
        updated_at: "2026-09-18T12:00:00Z", last_activity_at: "2026-09-18T12:00:00Z", created_at: "2026-09-01T00:00:00Z",
        custom_fields: {}, contact_id: CONTATO,
      },
    ],
    crm_pipelines: [
      { id: FUNIL, organization_id: ORG, settings: SETTINGS, is_default: true, is_archived: false },
      { id: FUNIL_ALHEIO, organization_id: OUTRA_ORG, settings: SETTINGS, is_default: true, is_archived: false },
    ],
    crm_stages: [
      { id: COL, organization_id: ORG, pipeline_id: FUNIL, name: "Contato Feito", is_won: false, is_lost: false },
      { id: COL_ALHEIA, organization_id: OUTRA_ORG, pipeline_id: FUNIL_ALHEIO, name: "Contato Feito", is_won: false, is_lost: false },
    ],
  };
});

describe("carregarContextoDoCopiloto", () => {
  it("resolve a conversa até o contexto active, e cada consulta filtra pela organização da sessão", async () => {
    const r = await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "conv-1");
    expect(r.tipo).toBe("ok");
    if (r.tipo !== "ok") return;
    expect(r.contexto.status).toBe("active");
    expect(r.contexto.status === "active" && r.contexto.playbook.stage_id).toBe("convite");
    // TODA consulta levou organization_id = org da sessão.
    expect(consultas.length).toBeGreaterThanOrEqual(5);
    for (const c of consultas) expect(c.filtros.organization_id, c.tabela).toBe(ORG);
    expect(consultas.map((c) => c.tabela).sort()).toEqual(["conversations", "crm_leads", "crm_pipelines", "crm_pipelines", "crm_stages"]);
  });

  it("15. conversa de outra organização → conversa_nao_encontrada (o mesmo que inexistente)", async () => {
    expect(await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "conv-alheia")).toEqual({ tipo: "conversa_nao_encontrada" });
    expect(await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "nao-existe")).toEqual({ tipo: "conversa_nao_encontrada" });
    // E não seguiu adiante: só a consulta da conversa foi feita.
    expect(consultas.every((c) => c.tabela === "conversations")).toBe(true);
  });

  it("2. conversa sem contact_id → no_contact, sem consultar leads", async () => {
    const r = await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "conv-sem-contato");
    expect(r).toMatchObject({ tipo: "ok", contexto: { status: "no_contact", conversation_id: "conv-sem-contato", contact_id: null } });
    expect(consultas.map((c) => c.tabela)).toEqual(["conversations"]);
  });

  it("3. o lead do mesmo contato em OUTRA org não entra: só o desta org é candidato", async () => {
    // Se o lead alheio entrasse, `resolveActiveLeadForContact` estouraria (orgs misturadas)
    // ou haveria ambiguidade. Nem uma coisa nem outra: o filtro segura.
    const r = await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "conv-1");
    expect(r.tipo === "ok" && r.contexto.status === "active" && r.contexto.lead.id).toBe("lead-1");
    const deLeads = consultas.find((c) => c.tabela === "crm_leads")!;
    expect(deLeads.filtros).toEqual({ contact_id: CONTATO, organization_id: ORG });
  });

  it("3b. contato sem lead nesta org → no_lead", async () => {
    tabelas.crm_leads = tabelas.crm_leads.filter((l) => l.organization_id !== ORG);
    const r = await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "conv-1");
    expect(r).toMatchObject({ tipo: "ok", contexto: { status: "no_lead" } });
  });

  it("4. dois leads abertos empatados → ambiguous_lead com os ids", async () => {
    tabelas.crm_leads.push({ ...tabelas.crm_leads[0]!, id: "lead-2", pipeline_id: FUNIL_ALHEIO, stage_id: COL });
    tabelas.crm_pipelines[0]!.is_default = false;
    const r = await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "conv-1");
    expect(r).toMatchObject({ tipo: "ok", contexto: { status: "ambiguous_lead", candidate_lead_ids: ["lead-1", "lead-2"] } });
  });

  it("13/14. funil e coluna são buscados por id + organização (+ funil, na coluna): fora do tenant, inconsistent", async () => {
    // O lead aponta para um funil e uma coluna que existem — noutra org.
    tabelas.crm_leads[0]!.pipeline_id = FUNIL_ALHEIO;
    tabelas.crm_leads[0]!.stage_id = COL_ALHEIA;
    const r = await carregarContextoDoCopiloto(clienteFalso() as never, ORG, "conv-1");
    expect(r).toMatchObject({ tipo: "ok", contexto: { status: "inconsistent", reason: "pipeline_not_found" } });
    const doFunil = consultas.find((c) => c.tabela === "crm_pipelines" && c.filtros.id === FUNIL_ALHEIO)!;
    expect(doFunil.filtros.organization_id).toBe(ORG);
    const daColuna = consultas.find((c) => c.tabela === "crm_stages")!;
    expect(daColuna.filtros).toEqual({ id: COL_ALHEIA, pipeline_id: FUNIL_ALHEIO, organization_id: ORG });
  });

  it("erro do banco vira `falha` com a mensagem — a rota decide o que expor", async () => {
    const quebrado = {
      from: () => {
        const cadeia = {
          select: () => cadeia,
          eq: () => cadeia,
          maybeSingle: async () => ({ data: null, error: { message: 'relation "conversations" does not exist' } }),
        };
        return cadeia;
      },
    };
    expect(await carregarContextoDoCopiloto(quebrado as never, ORG, "conv-1")).toEqual({ tipo: "falha", mensagem: 'relation "conversations" does not exist' });
  });
});
