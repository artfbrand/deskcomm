/**
 * O painel lateral com abas e o shell do copiloto — o que aparece em cada
 * estado, sem copy nenhuma, e sem nunca mostrar o contexto de outra conversa.
 *
 * `CRMSidePanel` é mockado: ele tem testes próprios, e aqui o que importa é
 * que a aba Contato o renderiza INTEIRO com a conversa certa.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { ContextoDoCopiloto } from "@/lib/afb/copiloto/contrato";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

vi.mock("@/components/inbox/CRMSidePanel", () => ({
  CRMSidePanel: ({ conversation }: { conversation: { id: string } | null }) => (
    <div data-testid="crm-side-panel">{conversation ? conversation.id : "sem-conversa"}</div>
  ),
}));

import { abaInicialDoContexto, PainelLateralDoInbox } from "./PainelLateralDoInbox";
import type { ResultadoDoContexto } from "./CopilotoPanel";

const CONV_A = { id: "conv-a" } as unknown as ConversationWithContact;
const CONV_B = { id: "conv-b" } as unknown as ConversationWithContact;

const base = { contact_id: "c1", warnings: [] as string[] };
const lead = { id: "lead-1", title: "Carlos — Metalúrgica", pipeline_id: "p", stage_id: "s", status: "open" as const, updated_at: "2026-09-18T00:00:00Z" };
const pipeline = { id: "p", playbook_id: "afb_comercial_v1" };
const fields = { etapa_playbook: null, perfil_interlocutor: "decisor", variacao_abordagem: null, status_followup: null, interesse_reuniao: null, fatura_solicitada: null, fatura_recebida: null, reuniao_realizada: null, data_reuniao: null, hora_reuniao: null };

function ativo(conversationId: string, over: Partial<Extract<ContextoDoCopiloto, { status: "active" }>> = {}): ContextoDoCopiloto {
  return {
    status: "active",
    conversation_id: conversationId,
    ...base,
    lead,
    pipeline,
    stage: { id: "s", name: "Contato Feito", role: "conversa" },
    playbook: { id: "afb_comercial_v1", stage_id: "qualificacao", title: "Qualificação / Situação", objective: "Uma pergunta só.", position_origin: "gravada", allowed_stage_ids: ["qualificacao"] },
    fields,
    ...over,
  };
}

const pronto = (data: ContextoDoCopiloto): ResultadoDoContexto => ({ data, error: null, isLoading: false, isError: false });
const carregando: ResultadoDoContexto = { data: undefined, error: null, isLoading: true, isError: false };
const comErro = (error: unknown): ResultadoDoContexto => ({ data: undefined, error, isLoading: false, isError: true });

function montar(conversation: ConversationWithContact | null, contexto: ResultadoDoContexto) {
  return render(<PainelLateralDoInbox conversation={conversation} contexto={contexto} />);
}

beforeEach(() => vi.clearAllMocks());

describe("abas", () => {
  it("1/2. com conversa: abas Copiloto e Contato, semântica de abas, Copiloto selecionada", () => {
    montar(CONV_A, pronto(ativo("conv-a")));
    const lista = screen.getByRole("tablist", { name: "Painel da conversa" });
    const abas = within(lista).getAllByRole("tab").map((a) => a.textContent);
    expect(abas).toEqual(["Copiloto", "Contato"]);
    expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("data-testid", "painel-copiloto");
  });

  it("3. a aba Contato renderiza o CRMSidePanel existente com a conversa", async () => {
    const user = userEvent.setup();
    montar(CONV_A, pronto(ativo("conv-a")));
    expect(screen.queryByTestId("crm-side-panel")).toBeNull();
    await user.click(screen.getByTestId("aba-contato"));
    expect(screen.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("crm-side-panel")).toHaveTextContent("conv-a");
  });

  it("sem conversa: comportamento atual do inbox (o próprio CRMSidePanel vazio), sem abas", () => {
    montar(null, { data: undefined, error: null, isLoading: false, isError: false });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("crm-side-panel")).toHaveTextContent("sem-conversa");
  });

  it("17. trocar de conversa volta para Copiloto e nunca mostra o contexto da anterior", async () => {
    const user = userEvent.setup();
    const { rerender } = montar(CONV_A, pronto(ativo("conv-a")));
    expect(screen.getByTestId("copiloto-lead")).toHaveTextContent("Carlos — Metalúrgica");
    await user.click(screen.getByTestId("aba-contato"));

    // A conversa B chega: primeiro carregando (é o que o hook devolve na
    // troca de chave), e a aba volta para Copiloto.
    rerender(<PainelLateralDoInbox conversation={CONV_B} contexto={carregando} />);
    expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("copiloto-estado")).toHaveAttribute("data-estado", "loading");
    expect(screen.queryByText("Carlos — Metalúrgica")).toBeNull();

    rerender(<PainelLateralDoInbox conversation={CONV_B} contexto={pronto(ativo("conv-b", { lead: { ...lead, title: "Ana — Padaria" } }))} />);
    expect(screen.getByTestId("copiloto-lead")).toHaveTextContent("Ana — Padaria");
    expect(screen.queryByText("Carlos — Metalúrgica")).toBeNull();
  });

  describe("aba inicial pelo contexto", () => {
    const desligado = (id: string): ContextoDoCopiloto => ({ status: "copilot_disabled", conversation_id: id, ...base, lead, pipeline: { id: "p" } });
    const semPlaybook = (id: string): ContextoDoCopiloto => ({ status: "no_playbook", conversation_id: id, ...base, lead, pipeline: { id: "p" } });

    it("copilot_disabled abre em Contato; active e os estados de orientação abrem em Copiloto", () => {
      expect(abaInicialDoContexto(pronto(desligado("x")))).toBe("contato");
      for (const ctx of [
        ativo("x"),
        semPlaybook("x"),
        { status: "unknown_playbook", conversation_id: "x", ...base, lead, pipeline } as ContextoDoCopiloto,
        { status: "unmapped_stage", conversation_id: "x", ...base, lead, pipeline, stage: { id: "s", name: "n", role: null } } as ContextoDoCopiloto,
        { status: "no_lead", conversation_id: "x", ...base } as ContextoDoCopiloto,
        { status: "ambiguous_lead", conversation_id: "x", candidate_lead_ids: ["a", "b"], ...base } as ContextoDoCopiloto,
        { status: "inconsistent", reason: "stage_not_found", conversation_id: "x", ...base, lead } as ContextoDoCopiloto,
        { status: "out_of_playbook", conversation_id: "x", ...base, lead, pipeline, stage: { id: "s", name: "n", role: "apresentacao" }, fields } as ContextoDoCopiloto,
        { status: "terminal_won", conversation_id: "x", ...base, lead, pipeline, stage: { id: "s", name: "n", role: "ganho" } } as ContextoDoCopiloto,
        { status: "terminal_lost", conversation_id: "x", ...base, lead, pipeline, stage: { id: "s", name: "n", role: "perdido" } } as ContextoDoCopiloto,
      ]) {
        expect(abaInicialDoContexto(pronto(ctx)), ctx.status).toBe("copiloto");
      }
      // Carregando ou com erro: Copiloto, onde o esqueleto/aviso aparecem.
      expect(abaInicialDoContexto(carregando)).toBe("copiloto");
      expect(abaInicialDoContexto(comErro(new Error("x")))).toBe("copiloto");
    });

    it("na tela: copilot_disabled abre com Contato selecionada e a ficha visível; active abre com Copiloto", () => {
      const { unmount } = montar(CONV_A, pronto(desligado("conv-a")));
      expect(screen.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("crm-side-panel")).toHaveTextContent("conv-a");
      unmount();
      montar(CONV_A, pronto(ativo("conv-a")));
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
    });

    it("no_playbook abre em Copiloto (tem orientação útil)", () => {
      montar(CONV_A, pronto(semPlaybook("conv-a")));
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("copiloto-estado")).toHaveAttribute("data-estado", "no_playbook");
    });

    it("carregando abre em Copiloto (esqueleto) e vira Contato quando o dado diz copilot_disabled — sem passar por outra conversa", () => {
      const { rerender } = montar(CONV_A, carregando);
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("copiloto-estado")).toHaveAttribute("data-estado", "loading");
      rerender(<PainelLateralDoInbox conversation={CONV_A} contexto={pronto(desligado("conv-a"))} />);
      expect(screen.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
    });

    it("troca active → disabled abre Contato; disabled → active abre Copiloto", () => {
      const { rerender } = montar(CONV_A, pronto(ativo("conv-a")));
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");

      rerender(<PainelLateralDoInbox conversation={CONV_B} contexto={carregando} />);
      expect(screen.queryByText("Carlos — Metalúrgica")).toBeNull();
      rerender(<PainelLateralDoInbox conversation={CONV_B} contexto={pronto(desligado("conv-b"))} />);
      expect(screen.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("crm-side-panel")).toHaveTextContent("conv-b");

      rerender(<PainelLateralDoInbox conversation={CONV_A} contexto={carregando} />);
      rerender(<PainelLateralDoInbox conversation={CONV_A} contexto={pronto(ativo("conv-a"))} />);
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("copiloto-lead")).toHaveTextContent("Carlos — Metalúrgica");
    });

    it("escolha manual vence enquanto for a mesma conversa — inclusive se o dado chegar depois", async () => {
      const user = userEvent.setup();
      // Disabled abriria em Contato; o atendente vai ao Copiloto e fica lá.
      const { rerender } = montar(CONV_A, pronto(desligado("conv-a")));
      await user.click(screen.getByTestId("aba-copiloto"));
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
      rerender(<PainelLateralDoInbox conversation={CONV_A} contexto={pronto(desligado("conv-a"))} />);
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");

      // Escolha feita DURANTE o carregamento também vence o padrão que o dado traria.
      rerender(<PainelLateralDoInbox conversation={CONV_B} contexto={carregando} />);
      await user.click(screen.getByTestId("aba-contato"));
      rerender(<PainelLateralDoInbox conversation={CONV_B} contexto={pronto(ativo("conv-b"))} />);
      expect(screen.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");

      // Mas a escolha não viaja para a conversa seguinte.
      rerender(<PainelLateralDoInbox conversation={CONV_A} contexto={pronto(ativo("conv-a"))} />);
      expect(screen.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
    });
  });

  it("navegação por teclado entre as abas (setas)", async () => {
    const user = userEvent.setup();
    montar(CONV_A, pronto(ativo("conv-a")));
    screen.getByTestId("aba-copiloto").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByTestId("aba-contato"));
  });
});

describe("estados do copiloto", () => {
  it("4. loading: esqueleto com aria-busy e texto para leitor de tela", () => {
    montar(CONV_A, carregando);
    const el = screen.getByTestId("copiloto-estado");
    expect(el).toHaveAttribute("data-estado", "loading");
    expect(el).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Carregando o contexto do copiloto…")).toBeInTheDocument();
  });

  it("5. active: etapa, objetivo, momento comercial, perfil, oportunidade e playbook — sem copy nem botões", () => {
    montar(CONV_A, pronto(ativo("conv-a")));
    expect(screen.getByTestId("copiloto-estado")).toHaveAttribute("data-estado", "active");
    expect(screen.getByTestId("copiloto-etapa")).toHaveTextContent("Qualificação / Situação");
    expect(screen.getByTestId("copiloto-objetivo")).toHaveTextContent("Uma pergunta só.");
    expect(screen.getByTestId("copiloto-papel")).toHaveTextContent("Conversa em andamento");
    expect(screen.getByTestId("copiloto-perfil")).toHaveTextContent("decisor");
    expect(screen.getByTestId("copiloto-lead")).toHaveTextContent("Carlos — Metalúrgica");
    expect(screen.getByTestId("copiloto-playbook")).toHaveTextContent("Playbook Comercial — Consultoria em Energia");
    expect(screen.queryByRole("button")).toBeNull();
    // Nenhum id técnico como texto.
    expect(screen.getByTestId("copiloto-estado")).not.toHaveTextContent(/afb_comercial_v1|lead-1|conv-a/);
  });

  it("active sem perfil gravado não mostra a linha de perfil; posição ajustada mostra aviso", () => {
    const referencia = ativo("x") as Extract<ContextoDoCopiloto, { status: "active" }>;
    montar(CONV_A, pronto(ativo("conv-a", { fields: { ...fields, perfil_interlocutor: null }, playbook: { ...referencia.playbook, position_origin: "ajustada" } })));
    expect(screen.queryByTestId("copiloto-perfil")).toBeNull();
    expect(screen.getByTestId("copiloto-aviso-ajuste")).toBeInTheDocument();
  });

  it.each([
    ["no_contact", { status: "no_contact", conversation_id: "conv-a", ...base, contact_id: null }, /não tem contato vinculado/],
    ["no_lead", { status: "no_lead", conversation_id: "conv-a", ...base }, /ainda não tem uma oportunidade aberta/],
    ["ambiguous_lead", { status: "ambiguous_lead", conversation_id: "conv-a", candidate_lead_ids: ["l1", "l2"], ...base }, /mais de uma oportunidade ativa/],
    ["copilot_disabled", { status: "copilot_disabled", conversation_id: "conv-a", ...base, lead, pipeline: { id: "p" } }, /desligado neste funil/],
    ["no_playbook", { status: "no_playbook", conversation_id: "conv-a", ...base, lead, pipeline: { id: "p" } }, /ainda não tem um playbook escolhido/],
    ["unknown_playbook", { status: "unknown_playbook", conversation_id: "conv-a", ...base, lead, pipeline }, /não está disponível nesta versão/],
    ["inconsistent", { status: "inconsistent", reason: "stage_not_found", conversation_id: "conv-a", ...base, lead }, /não está disponível/],
    ["unmapped_stage", { status: "unmapped_stage", conversation_id: "conv-a", ...base, lead, pipeline, stage: { id: "s", name: "Contato Feito", role: null } }, /ainda não foi mapeada/],
    ["out_of_playbook", { status: "out_of_playbook", conversation_id: "conv-a", ...base, lead, pipeline, stage: { id: "s", name: "Apresentação I", role: "apresentacao" }, fields }, /fora do WhatsApp/],
    ["terminal_won", { status: "terminal_won", conversation_id: "conv-a", ...base, lead, pipeline, stage: { id: "s", name: "Ganho", role: "ganho" } }, /Oportunidade ganha/],
    ["terminal_lost", { status: "terminal_lost", conversation_id: "conv-a", ...base, lead, pipeline, stage: { id: "s", name: "Perdido", role: "perdido" } }, /Oportunidade perdida/],
  ] as const)("6–14. %s mostra o aviso certo, sem JSON nem id técnico", async (status, data, texto) => {
    montar(CONV_A, pronto(data as unknown as ContextoDoCopiloto));
    // copilot_disabled abre em Contato por regra; o aviso está na aba Copiloto.
    if (status === "copilot_disabled") await userEvent.setup().click(screen.getByTestId("aba-copiloto"));
    const el = screen.getByTestId("copiloto-estado");
    expect(el).toHaveAttribute("data-estado", status);
    expect(el).toHaveTextContent(texto);
    expect(el.textContent).not.toMatch(/[{}"]|conv-a|lead-1|afb_comercial_v1/);
  });

  it("ambiguous_lead não escolhe: nenhum lead é mostrado, e a orientação manda organizar no CRM", () => {
    montar(CONV_A, pronto({ status: "ambiguous_lead", conversation_id: "conv-a", candidate_lead_ids: ["l1", "l2"], ...base }));
    expect(screen.getByTestId("copiloto-estado")).toHaveAttribute("data-candidatos", "2");
    expect(screen.queryByTestId("copiloto-lead")).toBeNull();
    expect(screen.getByTestId("copiloto-estado")).toHaveTextContent(/Ele não escolhe sozinho/);
  });

  it("terminais dizem que não há próxima etapa e mostram a oportunidade", () => {
    montar(CONV_A, pronto({ status: "terminal_won", conversation_id: "conv-a", ...base, lead, pipeline, stage: { id: "s", name: "Ganho", role: "ganho" } }));
    expect(screen.getByTestId("copiloto-estado")).toHaveTextContent(/não sugere próxima etapa/);
    expect(screen.getByTestId("copiloto-estado")).toHaveTextContent("Carlos — Metalúrgica");
  });

  it("15. 404 → «conversa não encontrada», sem crash", () => {
    montar(CONV_A, comErro(new ApiError(404, "not_found", undefined, "req", "Conversa não encontrada.")));
    const el = screen.getByTestId("copiloto-estado");
    expect(el).toHaveAttribute("data-estado", "nao_encontrada");
    expect(el).toHaveTextContent(/não encontrada ou fora do seu acesso/);
  });

  it("16. 500 → «indisponível», sem mostrar o texto cru do erro", () => {
    montar(CONV_A, comErro(new ApiError(500, "internal_error", undefined, "req", 'relation "crm_leads" does not exist')));
    const el = screen.getByTestId("copiloto-estado");
    expect(el).toHaveAttribute("data-estado", "indisponivel");
    expect(el).toHaveTextContent(/Não foi possível carregar o copiloto agora/);
    expect(el.textContent).not.toMatch(/relation|crm_leads/);
  });
});
