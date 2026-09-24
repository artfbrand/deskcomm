/**
 * O `catch` da rota de sugestão LOGA a causa — e não muda mais nada.
 *
 * ─── O que este arquivo existe para impedir ─────────────────────────────────
 *
 * O `catch` desta rota era `catch { }`. O efeito, medido em produção: seis
 * tentativas entre 22 e 24/09 gravaram `status='failed'` /
 * `error_code='generation_failed'` em `ai_reply_drafts`, a tela mostrou a frase
 * genérica, e a exceção — a única peça que diz QUAL dos ~11 `throw` do preview
 * disparou — foi destruída. Dois dias sem diagnóstico possível.
 *
 * Aqui estão as duas metades da promessa:
 *
 *   1. a causa passa a existir no log do servidor;
 *   2. NADA do que o navegador recebe muda — status, código e corpo idênticos.
 *
 * ─── E o log não pode virar vazamento ──────────────────────────────────────
 *
 * Uma exceção do provider pode carregar prompt, resposta do modelo ou pedaço de
 * corpo HTTP. Por isso `safe_error_message` publica o PREFIXO conhecido, nunca
 * a mensagem inteira, e qualquer mensagem fora da lista vira `"redacted"`. O
 * cenário B mede isso com texto sensível de verdade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireSupportWrite = vi.fn();
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: () => requireSupportWrite(),
}));

const requireRole = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));

const generateReplyDraft = vi.fn();
vi.mock("@/lib/agent-engine/agent/reply-drafts", () => ({
  generateReplyDraft: (...a: unknown[]) => generateReplyDraft(...a),
}));

vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const CONV = "11111111-1111-4111-8111-000000000001";
const ORG = "87c0785b-7c42-48c1-bd11-0e6d23c61d52";

/** Supabase de sessão: devolve a conversa com contato e canal. */
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: CONV, contact_id: "c-1", channel_session_id: "s-1" },
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { NextRequest } from "next/server";

import { logger } from "@/lib/logger";

import {
  POST,
  detalhesSegurosDoErro,
} from "@/app/api/v1/conversations/[id]/draft-reply/route";

const pedido = () => new NextRequest(`http://localhost:3000/api/v1/conversations/${CONV}/draft-reply`, { method: "POST" });
const ctx = { params: Promise.resolve({ id: CONV }) };

async function chamar(): Promise<{ status: number; corpo: string }> {
  // O tipo de retorno da rota admite `undefined` (o ramo de `requireSupportWrite`);
  // aqui isso seria defeito do dublê, não do código — por isso a asserção explícita.
  const r = await POST(pedido(), ctx);
  if (!r) throw new Error("a rota não devolveu resposta — dublê mal configurado");
  return { status: r.status, corpo: await r.text() };
}

beforeEach(() => {
  requireSupportWrite.mockResolvedValue(null);
  requireRole.mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  });
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ─── A — erro interno seguro ─────────────────────────────────────────────────

describe("A. erro interno conhecido: loga a identificação e preserva o contrato", () => {
  it("HTTP 422, reply_unavailable, e o log nomeia o ponto de parada", async () => {
    generateReplyDraft.mockRejectedValue(
      new Error("fechamento do turno sem JSON de checkpoint — run re-tentado pela fila"),
    );

    const r = await chamar();

    // O contrato HTTP não mudou.
    expect(r.status).toBe(422);
    expect(JSON.parse(r.corpo).error.code).toBe("reply_unavailable");

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [evento, contexto] = vi.mocked(logger.error).mock.calls[0]!;
    expect(evento).toBe("ai_reply.generation_failed");
    expect(contexto).toMatchObject({
      organizationId: ORG,
      conversationId: CONV,
      error_name: "Error",
      safe_error_message: "fechamento do turno sem JSON de checkpoint",
    });
    // `requestId` é gerado na rota; só exigimos que exista e seja string.
    expect(typeof (contexto as { requestId: unknown }).requestId).toBe("string");
  });

  it("o prefixo casado DISCRIMINA entre os pontos de parada", () => {
    const casos: Array<[string, string]> = [
      ["reply_no_agent", "reply_no_agent"],
      ["reply_context_unavailable", "reply_context_unavailable"],
      ["preview_transport_forbidden", "preview_transport_forbidden"],
      ["preview_operational_job_forbidden", "preview_operational_job_forbidden"],
      ["preview_version_unavailable", "preview_version_unavailable"],
      ["turn_without_contact", "turn_without_contact"],
      ["abertura do turno falhou em get_lead_context (P0002)", "abertura do turno falhou em get_lead_context"],
      ["checkpoint do fechamento com shape inválido (stages.0: invalid_type)", "checkpoint do fechamento com shape inválido"],
      ["JSON de checkpoint inválido no fechamento do turno — run re-tentado pela fila", "JSON de checkpoint inválido no fechamento do turno"],
    ];
    for (const [mensagem, esperado] of casos) {
      expect(detalhesSegurosDoErro(new Error(mensagem)).safe_error_message, mensagem).toBe(esperado);
    }
  });

  it("publica o PREFIXO, não a mensagem inteira — a garantia sobrevive a quem acrescentar contexto", () => {
    const d = detalhesSegurosDoErro(
      new Error("abertura do turno falhou em get_lead_context (P0002) — lead 583260f9 do contato Carlos"),
    );
    expect(d.safe_error_message).toBe("abertura do turno falhou em get_lead_context");
    expect(d.safe_error_message).not.toContain("583260f9");
    expect(d.safe_error_message).not.toContain("Carlos");
  });

  it("classificação sai junto quando existir: name, code, status", () => {
    const erro = Object.assign(new Error("reply_no_agent"), { code: "PGRST116", status: 404 });
    expect(detalhesSegurosDoErro(erro)).toEqual({
      error_name: "Error",
      error_code: "PGRST116",
      error_status: 404,
      safe_error_message: "reply_no_agent",
    });
  });
});

// ─── B — erro desconhecido com texto sensível ────────────────────────────────

describe("B. erro desconhecido: redacted, e o texto sensível não aparece", () => {
  const SEGREDO = "sk-proj-AbCdEf123456";
  const COPY = "Olá Carlos, sobre a fatura de R$ 12.480 da sua unidade";

  it("HTTP continua 422 e safe_error_message = redacted", async () => {
    generateReplyDraft.mockRejectedValue(
      new Error(`OpenAI 400: invalid_request {"prompt":"${COPY}","key":"${SEGREDO}"}`),
    );

    const r = await chamar();

    expect(r.status).toBe(422);
    expect(JSON.parse(r.corpo).error.code).toBe("reply_unavailable");

    const [, contexto] = vi.mocked(logger.error).mock.calls[0]!;
    expect((contexto as { safe_error_message: string }).safe_error_message).toBe("redacted");

    // O log INTEIRO, serializado, não pode conter nada disso.
    const texto = JSON.stringify(contexto);
    for (const proibido of [SEGREDO, COPY, "invalid_request", "prompt", "Carlos", "12.480"]) {
      expect(texto, proibido).not.toContain(proibido);
    }
  });

  it("nem a resposta HTTP carrega a causa — ela vive só no log", async () => {
    generateReplyDraft.mockRejectedValue(new Error(`falha crua com ${SEGREDO}`));
    const r = await chamar();
    expect(r.corpo).not.toContain(SEGREDO);
    expect(r.corpo).not.toContain("falha crua");
  });

  it("valor lançado que não é Error também é tratado", () => {
    expect(detalhesSegurosDoErro("string solta")).toEqual({
      error_name: "string",
      error_code: null,
      error_status: null,
      safe_error_message: "redacted",
    });
    expect(detalhesSegurosDoErro(null).safe_error_message).toBe("redacted");
    expect(detalhesSegurosDoErro(undefined).error_name).toBe("undefined");
  });

  it("prefixo no MEIO da mensagem não conta — só no início", () => {
    // Senão um erro de provider que ecoasse o nosso texto viraria "seguro".
    expect(
      detalhesSegurosDoErro(new Error("provider devolveu: reply_no_agent e mais coisas")).safe_error_message,
    ).toBe("redacted");
  });
});

// ─── C — o catch não pode voltar a ser vazio ─────────────────────────────────

describe("C. o catch da rota não é vazio", () => {
  it("a rota captura o erro com binding e chama logger.error", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "app/api/v1/conversations/[id]/draft-reply/route.ts"),
      "utf8",
    );
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // `catch {` ou `catch()` sem binding é o defeito que voltaria.
    expect(codigo).not.toMatch(/catch\s*\{/);
    expect(codigo).toMatch(/catch\s*\(\s*erro\s*\)/);
    expect(codigo).toContain('logger.error("ai_reply.generation_failed"');
    // E o contrato HTTP tem de continuar escrito ali.
    expect(codigo).toContain('"reply_unavailable"');
    expect(codigo).toContain("422");
  });

  it("o log não referencia campos que carregariam conteúdo", () => {
    const proibidos = ["prompt", "systemPrompt", "candidates", "original_body", "headers", "authorization", "apiKey"];
    const chaves = Object.keys(detalhesSegurosDoErro(new Error("reply_no_agent")));
    for (const p of proibidos) expect(chaves, p).not.toContain(p);
    expect(chaves.sort()).toEqual(["error_code", "error_name", "error_status", "safe_error_message"]);
  });
});
