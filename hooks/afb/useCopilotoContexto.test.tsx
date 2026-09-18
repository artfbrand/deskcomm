/**
 * O hook do contexto do copiloto — o que ele PEDE, o que trata como dado e
 * o que trata como erro, e o que acontece quando a conversa muda.
 *
 * `apiClient.get` é mockado como nos outros hooks do inbox; o que se mede é a
 * chamada (rota, ausência de ids extras) e o comportamento do react-query
 * com a chave por conversa. A parte "nunca mostra A como se fosse B" é o caso
 * que mais importa: ele muda o `conversationId` no MESMO hook, como o
 * `InboxLayout` faz com `selectedId`, e confere que no instante da troca não
 * há dado nenhum — não o de A.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

import {
  chaveDoContextoDoCopiloto,
  contextoIndisponivel,
  contextoNaoEncontrado,
  rotaDoContextoDoCopiloto,
  useCopilotoContexto,
} from "./useCopilotoContexto";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";

const ACTIVE_A = {
  status: "active",
  conversation_id: A,
  contact_id: "c1",
  warnings: [],
  lead: { id: "lead-a", title: "A", pipeline_id: "p", stage_id: "s", status: "open", updated_at: "2026-09-18T00:00:00Z" },
  pipeline: { id: "p", playbook_id: "afb_comercial_v1" },
  stage: { id: "s", name: "Contato Feito", role: "conversa" },
  playbook: { id: "afb_comercial_v1", stage_id: "gancho_de_valor", title: "Gancho de valor", objective: "…", position_origin: "gravada", allowed_stage_ids: ["qualificacao"] },
  fields: { etapa_playbook: "gancho_de_valor", perfil_interlocutor: null, variacao_abordagem: null, status_followup: null, interesse_reuniao: null, fatura_solicitada: null, fatura_recebida: null, reuniao_realizada: null, data_reuniao: null, hora_reuniao: null },
};

function qc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}
function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
function responde(porConversa: Record<string, unknown>) {
  vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
    const id = decodeURIComponent(path.split("/").pop()!);
    const r = porConversa[id];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new ApiError(404, "not_found", undefined, "req", "Conversa não encontrada.");
    return { data: r } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCopilotoContexto", () => {
  it("1. sem conversationId (null, undefined, vazio) não faz request e fica desligado", async () => {
    responde({ [A]: ACTIVE_A });
    for (const id of [null, undefined, "", "   "]) {
      const { result } = renderHook(() => useCopilotoContexto(id), { wrapper: wrapperFor(qc()) });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toBeUndefined();
      expect(result.current.fetchStatus).toBe("idle");
    }
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("2/3. com id chama EXATAMENTE a rota, sem organization_id, contact_id, lead_id ou pipeline_id", async () => {
    responde({ [A]: ACTIVE_A });
    const { result } = renderHook(() => useCopilotoContexto(A), { wrapper: wrapperFor(qc()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    const [rota, opts] = vi.mocked(apiClient.get).mock.calls[0]!;
    expect(rota).toBe(`/api/v1/afb/copiloto/${A}`);
    expect(rota).not.toMatch(/organization_id|contact_id|lead_id|pipeline_id|\?/);
    expect(opts).toBeUndefined();
  });

  it("rota e chave: id é escapado na rota e vai cru na chave", () => {
    expect(rotaDoContextoDoCopiloto("a b")).toBe("/api/v1/afb/copiloto/a%20b");
    expect(chaveDoContextoDoCopiloto(A)).toEqual(["afb", "copiloto", "contexto", A]);
    expect(chaveDoContextoDoCopiloto(null)).toEqual(["afb", "copiloto", "contexto", null]);
  });

  it("4. active chega em data.status, tipado", async () => {
    responde({ [A]: ACTIVE_A });
    const { result } = renderHook(() => useCopilotoContexto(A), { wrapper: wrapperFor(qc()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("active");
    expect(result.current.data?.status === "active" && result.current.data.playbook.stage_id).toBe("gancho_de_valor");
    expect(result.current.error).toBeNull();
  });

  it("5/6. no_lead e ambiguous_lead são DADO, não erro", async () => {
    responde({
      [A]: { status: "no_lead", conversation_id: A, contact_id: "c1", warnings: [] },
      [B]: { status: "ambiguous_lead", conversation_id: B, contact_id: "c1", candidate_lead_ids: ["l1", "l2"], warnings: [] },
    });
    const a = renderHook(() => useCopilotoContexto(A), { wrapper: wrapperFor(qc()) });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    expect(a.result.current.data?.status).toBe("no_lead");
    expect(a.result.current.isError).toBe(false);

    const b = renderHook(() => useCopilotoContexto(B), { wrapper: wrapperFor(qc()) });
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));
    expect(b.result.current.data).toMatchObject({ status: "ambiguous_lead", candidate_lead_ids: ["l1", "l2"] });
    expect(b.result.current.isError).toBe(false);
  });

  it("7. 404 vira erro identificável por contextoNaoEncontrado, sem lançar e sem re-tentar", async () => {
    responde({});
    const { result } = renderHook(() => useCopilotoContexto(A), { wrapper: wrapperFor(qc()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(contextoNaoEncontrado(result.current.error)).toBe(true);
    expect(contextoIndisponivel(result.current.error)).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it("8. 500 vira estado de erro do hook (contextoIndisponivel), e o texto cru não é o que a tela mostra", async () => {
    responde({ [A]: new ApiError(500, "internal_error", undefined, "req", 'relation "crm_leads" does not exist') });
    const { result } = renderHook(() => useCopilotoContexto(A), { wrapper: wrapperFor(qc()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(contextoIndisponivel(result.current.error)).toBe(true);
    expect(contextoNaoEncontrado(result.current.error)).toBe(false);
    // Os dois predicados são o que a tela usa — nunca `error.message`.
    expect(contextoIndisponivel(null)).toBe(false);
    expect(contextoIndisponivel(new Error("rede caiu"))).toBe(true);
  });

  it("9/10. trocar A → B (como o InboxLayout troca selectedId) usa outra chave e NUNCA mostra o contexto de A como se fosse B", async () => {
    responde({ [A]: ACTIVE_A, [B]: { ...ACTIVE_A, conversation_id: B, lead: { ...ACTIVE_A.lead, id: "lead-b" } } });
    // gcTime padrão aqui: o caso confere que a chave de A CONTINUA no cache,
    // separada — com gcTime 0 ela seria coletada ao deixar de ser observada.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useCopilotoContexto(id), {
      wrapper: wrapperFor(client),
      initialProps: { id: A },
    });
    await waitFor(() => expect(result.current.data?.conversation_id).toBe(A));

    rerender({ id: B });
    // No instante da troca: nova chave, sem dado — nem o de A.
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data?.conversation_id).toBe(B));
    expect(result.current.data?.status === "active" && result.current.data.lead.id).toBe("lead-b");

    // As duas chaves existem no cache, separadas; a de A continua sendo a de A.
    expect(client.getQueryData(chaveDoContextoDoCopiloto(A))).toMatchObject({ conversation_id: A });
    expect(client.getQueryData(chaveDoContextoDoCopiloto(B))).toMatchObject({ conversation_id: B });
    expect(vi.mocked(apiClient.get).mock.calls.map((c) => c[0])).toEqual([
      `/api/v1/afb/copiloto/${A}`,
      `/api/v1/afb/copiloto/${B}`,
    ]);
  });

  it("voltar para null (o «voltar» do celular) desliga a query sem dado residual", async () => {
    responde({ [A]: ACTIVE_A });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useCopilotoContexto(id), {
      wrapper: wrapperFor(qc()),
      initialProps: { id: A as string | null },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ id: null });
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("11. refetch pede de novo a mesma rota e atualiza o dado", async () => {
    let vez = 0;
    vi.mocked(apiClient.get).mockImplementation(async () => {
      vez += 1;
      return { data: { status: vez === 1 ? "no_lead" : "active", conversation_id: A, contact_id: "c1", warnings: [] } } as never;
    });
    const { result } = renderHook(() => useCopilotoContexto(A), { wrapper: wrapperFor(qc()) });
    await waitFor(() => expect(result.current.data?.status).toBe("no_lead"));
    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.status).toBe("active"));
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });
});

describe("12. o que o navegador carrega", () => {
  const RAIZ = join(__dirname, "..", "..");
  const importsDe = (caminho: string) =>
    [...readFileSync(join(RAIZ, caminho), "utf8").matchAll(/^\s*import\b([^;]*?)\bfrom\s+["']([^"']+)["']/gm)].map((m) => ({
      soTipo: /^\s*import\s+type\b/.test(m[0]),
      modulo: m[2]!,
    }));
  const SERVER_ONLY = [/copiloto\/contexto$/, /copiloto\/carregar$/, /playbooks\/registry/, /playbooks\/comercial/, /\/gate$/, /supabase\/(server|admin)/, /^next\/headers/, /^node:/, /leads\/active-lead/];

  it("o hook importa só o contrato (tipos) e o cliente HTTP — nada server-only", () => {
    const imports = importsDe("hooks/afb/useCopilotoContexto.ts");
    for (const i of imports) for (const p of SERVER_ONLY) expect(i.modulo, i.modulo).not.toMatch(p);
    const contrato = imports.find((i) => i.modulo === "@/lib/afb/copiloto/contrato")!;
    expect(contrato.soTipo).toBe(true);
  });

  it("o contrato é um módulo só de tipos: todo import é `import type`, e nenhum é server-only", () => {
    const imports = importsDe("lib/afb/copiloto/contrato.ts");
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i.soTipo, i.modulo).toBe(true);
      for (const p of SERVER_ONLY) expect(i.modulo, i.modulo).not.toMatch(p);
    }
    const fonte = readFileSync(join(RAIZ, "lib/afb/copiloto/contrato.ts"), "utf8");
    expect(fonte).not.toMatch(/^\s*export\s+(const|function|class)\b/m);
  });
});
