import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import {
  ReplyReviewPanel,
  replyDraftRefetchInterval,
} from "@/components/inbox/composer/ReplyReviewPanel";

const draft = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: "1",
  status: "pending",
  original_body: "Sugestão da IA",
  edited_body: "Sugestão da IA",
  error_code: null,
  proposals: [],
};

function renderPanel(onUseDraft = vi.fn(() => true)) {
  return {
    onUseDraft,
    ...render(
      <QueryClientProvider client={new QueryClient()}>
        <ReplyReviewPanel conversationId="conv-1" onUseDraft={onUseDraft} />
      </QueryClientProvider>,
    ),
  };
}

describe("ReplyReviewPanel", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    getMock.mockResolvedValue({ data: { drafts: [draft] } });
  });

  it("manda a sugestão ao composer sem aprovar ou enviar", async () => {
    const { onUseDraft } = renderPanel();
    const useButton = await screen.findByRole("button", { name: "Usar no composer" });

    fireEvent.click(useButton);

    expect(onUseDraft).toHaveBeenCalledWith("Sugestão da IA");
    expect(postMock).not.toHaveBeenCalled();
    expect(screen.getByText("Sugestão inserida no composer")).toBeInTheDocument();
  });

  it("consulta rápido somente enquanto o draft está gerando", () => {
    expect(replyDraftRefetchInterval("generating")).toBe(750);
    expect(replyDraftRefetchInterval("pending")).toBe(4000);
    expect(replyDraftRefetchInterval(undefined)).toBe(4000);
  });

  it("mantém a sugestão disponível quando o composer protege texto humano", async () => {
    const { onUseDraft } = renderPanel(vi.fn(() => false));
    fireEvent.click(await screen.findByRole("button", { name: "Usar no composer" }));

    expect(onUseDraft).toHaveBeenCalledWith("Sugestão da IA");
    expect(screen.getByRole("button", { name: "Usar no composer" })).toBeInTheDocument();
    expect(screen.queryByText("Sugestão inserida no composer")).not.toBeInTheDocument();
  });

  it("preserva a rejeição persistida", async () => {
    postMock.mockResolvedValue({ data: {} });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Rejeitar" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(`/api/v1/ai/replies/${draft.id}`, {
        action: "reject",
        revision: "1",
        body: "Sugestão da IA",
        feedback: "",
      }),
    );
  });

  it("mantém o refetch após a mutation manual", async () => {
    postMock.mockResolvedValue({ data: {} });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Sugerir resposta" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/conv-1/draft-reply", {}),
    );
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  it("troca a query ao mudar de conversa", async () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ReplyReviewPanel conversationId="conv-1" onUseDraft={vi.fn(() => true)} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "Usar no composer" });

    view.rerender(
      <QueryClientProvider client={client}>
        <ReplyReviewPanel conversationId="conv-2" onUseDraft={vi.fn(() => true)} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/v1/conversations/conv-2/draft-reply"),
    );
  });

  it("não deixa polling rápido após desmontar", async () => {
    getMock.mockResolvedValue({
      data: {
        drafts: [
          {
            ...draft,
            status: "generating",
            original_body: null,
            edited_body: null,
          },
        ],
      },
    });
    const { unmount } = renderPanel();
    await screen.findByText("Preparando sugestão…");

    unmount();
    const callsBeforeWait = getMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(getMock).toHaveBeenCalledTimes(callsBeforeWait);
  });
});
