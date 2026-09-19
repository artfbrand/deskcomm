/**
 * GET /api/v1/afb/copiloto/[conversationId] — o contrato HTTP e as portas
 * que ela NÃO abre.
 *
 * A regra de negócio tem testes próprios (`lib/afb/copiloto/*`). Aqui o que se
 * mede é a casca: 401 sem sessão, 404 para conversa inexistente OU alheia (o
 * mesmo código, de propósito), 200 com `status` para estado de negócio, 500
 * sem a mensagem do Postgres — e que a rota usa o cliente de SESSÃO, nunca o
 * admin, e nunca lê `organization_id` do pedido.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { carregarContextoDoCopiloto } from "@/lib/afb/copiloto/carregar";
import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/afb/copiloto/carregar", () => ({ carregarContextoDoCopiloto: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { GET } from "@/app/api/v1/afb/copiloto/[conversationId]/route";
import { logger } from "@/lib/logger";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const OUTRA_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONV = "eeeeeeee-eeee-4eee-8eee-000000000001";
const SESSAO = { marcador: "cliente-de-sessao" };

function chamar(conversationId = CONV, url = `https://crm.exemplo/api/v1/afb/copiloto/${conversationId}`) {
  return GET(new NextRequest(url), { params: Promise.resolve({ conversationId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" } as never,
    org: { orgId: ORG, role: "agent" } as never,
  });
  vi.mocked(createClient).mockResolvedValue(SESSAO as never);
  vi.mocked(carregarContextoDoCopiloto).mockResolvedValue({
    tipo: "ok",
    contexto: { status: "no_lead", conversation_id: CONV, contact_id: "c1", warnings: [] },
  });
});

describe("GET /api/v1/afb/copiloto/[conversationId]", () => {
  it("16. sem sessão → 401, e o carregador nem é chamado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401),
    });
    const res = await chamar();
    expect(res.status).toBe(401);
    expect(carregarContextoDoCopiloto).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("exige papel viewer (leitura — o mesmo piso do inbox e do CRM) e responde com X-Request-Id", async () => {
    const res = await chamar();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("viewer");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("17. usa o cliente de SESSÃO e passa a org DA SESSÃO ao carregador; nunca o admin", async () => {
    await chamar();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(carregarContextoDoCopiloto).toHaveBeenCalledWith(SESSAO, ORG, CONV);
  });

  it("18. organization_id vindo do pedido é ignorado — a org é a da sessão", async () => {
    await chamar(CONV, `https://crm.exemplo/api/v1/afb/copiloto/${CONV}?organization_id=${OUTRA_ORG}`);
    expect(carregarContextoDoCopiloto).toHaveBeenCalledWith(SESSAO, ORG, CONV);
  });

  it("15. conversa inexistente ou de outra organização → 404 com o MESMO código", async () => {
    vi.mocked(carregarContextoDoCopiloto).mockResolvedValue({ tipo: "conversa_nao_encontrada" });
    const res = await chamar();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
    expect(JSON.stringify(body)).not.toMatch(/organiza/i);
  });

  it("estado de negócio é 200 com `status` discriminado no `data`", async () => {
    for (const status of ["active", "no_contact", "no_lead", "ambiguous_lead", "copilot_disabled", "no_playbook", "unknown_playbook", "unmapped_stage", "terminal_won", "terminal_lost", "out_of_playbook"]) {
      vi.mocked(carregarContextoDoCopiloto).mockResolvedValueOnce({
        tipo: "ok",
        contexto: { status, conversation_id: CONV, contact_id: null, warnings: [] } as never,
      });
      const res = await chamar();
      expect(res.status, status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe(status);
    }
  });

  it("falha do banco → 500 genérico; a mensagem crua vai só para o log", async () => {
    vi.mocked(carregarContextoDoCopiloto).mockResolvedValue({ tipo: "falha", mensagem: 'relation "crm_leads" does not exist' });
    const res = await chamar();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(JSON.stringify(body)).not.toMatch(/relation|crm_leads/);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls[0])).toMatch(/crm_leads/);
  });
});
