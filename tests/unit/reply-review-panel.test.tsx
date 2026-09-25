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

import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";

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
});
