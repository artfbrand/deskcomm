/**
 * A fiação do shadow no Copiloto NÃO altera nada do que o usuário recebe.
 *
 * ─── O que este arquivo existe para impedir ─────────────────────────────────
 *
 * A Fase C conecta uma leitura de banco a uma rota que hoje funciona. O risco
 * inteiro da etapa cabe numa frase: uma falha na observação virar erro no
 * atendimento. Aqui isso é MEDIDO, não prometido — a resposta operacional é
 * capturada byte a byte sob os cinco status do shadow, sob não-observação, sob
 * tarefa que lança e sob agendamento que lança, e as oito saídas têm de ser
 * idênticas entre si e idênticas à resposta sem shadow nenhum.
 *
 * ─── E que o shadow é POSTERIOR à resposta ──────────────────────────────────
 *
 * Provado sem relógio e sem `sleep`: o shadow é uma promise que NUNCA resolve.
 * Se a rota a aguardasse, o teste travaria; ele passa porque ela não aguarda.
 * É o mesmo raciocínio do `after()` real, medido com uma ferramenta que não
 * depende de tempo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireRole = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));

const carregarContextoDoCopiloto = vi.fn();
vi.mock("@/lib/afb/copiloto/carregar", () => ({
  carregarContextoDoCopiloto: (...a: unknown[]) => carregarContextoDoCopiloto(...a),
}));

const observarPlaybookDoCopilotoAFB = vi.fn();
vi.mock("@/lib/afb/copiloto/shadow-afb", () => ({
  observarPlaybookDoCopilotoAFB: (...a: unknown[]) => observarPlaybookDoCopilotoAFB(...a),
  playbookIdDoContexto: () => "afb_comercial_v1",
}));

/** O agendador é substituído para que o teste controle QUANDO a tarefa roda. */
const agendarPosResposta = vi.fn();
vi.mock("@/lib/http/pos-resposta", () => ({
  agendarPosResposta: (...a: unknown[]) => agendarPosResposta(...a),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: vi.fn() }) }));

import { NextRequest } from "next/server";

import { logger } from "@/lib/logger";
import type { PlaybookShadowResult } from "@/lib/playbooks/shadow";

import { GET } from "@/app/api/v1/afb/copiloto/[conversationId]/route";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const CONVERSA = "11111111-1111-4111-8111-000000000001";

/** O contexto operacional — resolvido pelo REGISTRY, como sempre foi. */
const CONTEXTO = {
  conversation_id: CONVERSA,
  contact_id: "22222222-2222-4222-8222-000000000001",
  warnings: [],
  status: "active",
  lead: { id: "lead-1", title: "Carlos", pipeline_id: "f-1", stage_id: "c-1", status: "open", updated_at: "2026-09-20T10:00:00Z" },
  pipeline: { id: "f-1", playbook_id: "afb_comercial_v1" },
  stage: { id: "c-1", name: "Contato Feito", role: "conversa" },
  playbook: { id: "afb_comercial_v1", stage_id: "convite", title: "Convite", objective: "…", position_origin: "gravada", allowed_stage_ids: [] },
  suggestion: { kind: "message", message_id: "convite.primary", text: "COPY OFICIAL", wait_for_reply: true, wait_rule: null, placeholders: [] },
  fields: {},
};

const pedido = () => new NextRequest(`http://localhost:3000/api/v1/afb/copiloto/${CONVERSA}`);
const ctx = { params: Promise.resolve({ conversationId: CONVERSA }) };

/** Corpo + status, que é exatamente o que o navegador recebe. */
async function respostaOperacional(): Promise<{ status: number; corpo: string }> {
  const r = await GET(pedido(), ctx);
  return { status: r.status, corpo: await r.text() };
}

const observado = (status: string): PlaybookShadowResult =>
  ({
    outcome: "observed",
    status,
    reason: "equivalente",
    organization_id: ORG,
    slug: "afb_comercial",
    registry_playbook_id: "afb_comercial_v1",
    playbook_id: "pb-1",
    published_version_id: "v-1",
    version_number: 1,
    sha_persisted: "a".repeat(64),
    sha_recomputed: "a".repeat(64),
    sha_registry: "a".repeat(64),
    duration_ms: 1,
  }) as PlaybookShadowResult;

beforeEach(() => {
  requireRole.mockResolvedValue({ ok: true, user: { id: "u-1", idioma: "pt-BR" }, org: { orgId: ORG, name: "AFB", role: "admin" } });
  carregarContextoDoCopiloto.mockResolvedValue({ tipo: "ok", contexto: CONTEXTO });
  observarPlaybookDoCopilotoAFB.mockResolvedValue(observado("match"));
  // Por padrão o agendador roda a tarefa na hora: é o pior caso para o
  // isolamento, e mesmo assim a resposta não pode mudar.
  //
  // O `try/catch` aqui NÃO é conveniência de teste: ele espelha o wrapper do
  // helper real (`lib/http/pos-resposta.ts`), que é quem tem o catch da
  // tarefa. Um dublê sem ele mediria um caminho que a produção não tem — e a
  // primeira versão deste arquivo, sem o wrapper, produziu exatamente a
  // rejeição não tratada que o helper existe para impedir. Que o helper de
  // verdade loga e não relança está provado em `lib/http/pos-resposta.test.ts`.
  agendarPosResposta.mockImplementation(async (_nome: string, tarefa: () => Promise<void>) => {
    try {
      await tarefa();
    } catch (e) {
      logger.error("pos_resposta.tarefa_falhou", { tarefa: "dublê", erro: String(e) });
    }
  });
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("a resposta operacional é IDÊNTICA sob qualquer desfecho do shadow", () => {
  it("os oito cenários produzem exatamente o mesmo status e o mesmo corpo", async () => {
    const cenarios: Array<[string, () => void]> = [
      ["A match", () => observarPlaybookDoCopilotoAFB.mockResolvedValue(observado("match"))],
      ["B mismatch", () => observarPlaybookDoCopilotoAFB.mockResolvedValue(observado("mismatch"))],
      ["C missing", () => observarPlaybookDoCopilotoAFB.mockResolvedValue(observado("missing"))],
      ["D invalid", () => observarPlaybookDoCopilotoAFB.mockResolvedValue(observado("invalid"))],
      ["E conflict", () => observarPlaybookDoCopilotoAFB.mockResolvedValue(observado("conflict"))],
      [
        "F not_observed/database_error",
        () => observarPlaybookDoCopilotoAFB.mockResolvedValue({ outcome: "not_observed", reason: "database_error" }),
      ],
      ["G tarefa lança", () => observarPlaybookDoCopilotoAFB.mockRejectedValue(new Error("shadow explodiu"))],
      [
        "H agendamento lança erro INESPERADO",
        () =>
          agendarPosResposta.mockImplementation(() => {
            throw new Error("after() quebrou de um jeito imprevisto");
          }),
      ],
    ];

    const saidas: Array<{ cenario: string; status: number; corpo: string }> = [];
    for (const [nome, preparar] of cenarios) {
      preparar();
      const r = await respostaOperacional();
      saidas.push({ cenario: nome, ...r });
    }

    const primeira = saidas[0]!;
    expect(primeira.status).toBe(200);
    for (const s of saidas) {
      expect({ status: s.status, corpo: s.corpo }).toEqual({ status: primeira.status, corpo: primeira.corpo });
    }
    // E o corpo é o contexto do REGISTRY, intacto — inclusive a sugestão.
    expect(JSON.parse(primeira.corpo).data).toEqual(CONTEXTO);
  });

  it("H em detalhe: agendamento que lança vira LOG, nunca 500", async () => {
    agendarPosResposta.mockImplementation(() => {
      throw new Error("after() quebrou de um jeito imprevisto");
    });

    const r = await respostaOperacional();

    expect(r.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      "afb.copiloto.shadow_nao_agendado",
      expect.objectContaining({ organizationId: ORG, erro: "after() quebrou de um jeito imprevisto" }),
    );
  });

  it("o log de falha de agendamento é sanitizado", async () => {
    agendarPosResposta.mockImplementation(() => {
      throw new Error("falhou");
    });
    await respostaOperacional();

    const [, contexto] = vi.mocked(logger.error).mock.calls[0]!;
    expect(Object.keys(contexto as object).sort()).toEqual(["erro", "organizationId", "requestId"]);
    const texto = JSON.stringify(contexto);
    for (const proibido of [CONVERSA, CONTEXTO.contact_id, CONTEXTO.lead.id, "COPY OFICIAL", "Carlos"]) {
      expect(texto).not.toContain(proibido);
    }
  });
});

describe("o shadow é POSTERIOR à resposta", () => {
  it("a rota não aguarda a observação: promise que nunca resolve não a trava", async () => {
    let tarefaRegistrada: (() => Promise<void>) | null = null;
    agendarPosResposta.mockImplementation((_nome: string, tarefa: () => Promise<void>) => {
      tarefaRegistrada = tarefa;
    });
    // Nunca resolve. Se a rota aguardasse, este teste estouraria por timeout.
    observarPlaybookDoCopilotoAFB.mockReturnValue(new Promise<never>(() => {}));

    const r = await respostaOperacional();

    expect(r.status).toBe(200);
    expect(JSON.parse(r.corpo).data).toEqual(CONTEXTO);
    expect(tarefaRegistrada).not.toBeNull();
    // Registrada, e ainda não executada — quem decide o momento é o `after()`.
    expect(observarPlaybookDoCopilotoAFB).not.toHaveBeenCalled();
  });

  it("agenda com nome próprio e uma tarefa, e só depois de o contexto estar ok", async () => {
    await respostaOperacional();
    expect(agendarPosResposta).toHaveBeenCalledTimes(1);
    const [nome, tarefa] = agendarPosResposta.mock.calls[0]!;
    expect(nome).toBe("afb.copiloto.shadow");
    expect(typeof tarefa).toBe("function");
  });

  it("observa com a organização da SESSÃO e o playbook que o runtime resolveu", async () => {
    await respostaOperacional();
    expect(observarPlaybookDoCopilotoAFB).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, playbookId: "afb_comercial_v1" }),
    );
  });
});

describe("caminhos que não são 200 não agendam nada", () => {
  it("conversa inexistente: 404 e nenhum shadow", async () => {
    carregarContextoDoCopiloto.mockResolvedValue({ tipo: "conversa_nao_encontrada" });
    const r = await respostaOperacional();
    expect(r.status).toBe(404);
    expect(agendarPosResposta).not.toHaveBeenCalled();
  });

  it("falha ao montar o contexto: 500 e nenhum shadow", async () => {
    carregarContextoDoCopiloto.mockResolvedValue({ tipo: "falha", mensagem: "boom" });
    const r = await respostaOperacional();
    expect(r.status).toBe(500);
    expect(agendarPosResposta).not.toHaveBeenCalled();
  });

  it("sessão sem permissão: a resposta de autorização passa intacta", async () => {
    requireRole.mockResolvedValue({ ok: false, response: new Response("nao", { status: 403 }) });
    const r = await respostaOperacional();
    expect(r.status).toBe(403);
    expect(agendarPosResposta).not.toHaveBeenCalled();
  });
});
