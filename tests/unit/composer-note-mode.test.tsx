import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const createNoteMock = vi.fn();
const toastInfoMock = vi.fn();

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: createNoteMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/inbox/composer/ReplyReviewPanel", () => ({
  ReplyReviewPanel: ({ onUseDraft }: { onUseDraft: (text: string) => boolean }) => (
    <button type="button" onClick={() => onUseDraft("texto sugerido pela IA")}>
      Usar no composer
    </button>
  ),
}));
vi.mock("sonner", () => ({
  toast: { info: (...args: unknown[]) => toastInfoMock(...args) },
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

describe("Composer + modo nota interna", () => {
  beforeEach(() => {
    sendMock.mockClear();
    createNoteMock.mockClear();
    toastInfoMock.mockClear();
  });

  it("modo reply (default): envia normal via useSendMessage", () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "oi cliente" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1", body: "oi cliente", type: "text" }),
      expect.anything(),
    );
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("limpa o input na hora do envio, sem esperar onSuccess da API", () => {
    sendMock.mockImplementation(() => {
      /* simula request lento — onSuccess não é chamado */
    });
    renderComposer();
    const input = screen.getByLabelText(/mensagem/i);
    fireEvent.change(input, { target: { value: "oi cliente" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(input).toHaveValue("");
  });

  it("insere a sugestão no textarea nativo sem enviar e permite editar antes do envio normal", () => {
    renderComposer();
    const input = screen.getByLabelText(/mensagem/i);

    fireEvent.click(screen.getByRole("button", { name: "Usar no composer" }));

    expect(input).toHaveValue("texto sugerido pela IA");
    expect(sendMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "texto revisado pela pessoa" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: "conv-1",
        body: "texto revisado pela pessoa",
        type: "text",
      }),
      expect.anything(),
    );
  });

  it("preserva texto humano e avisa antes de inserir uma sugestão", () => {
    renderComposer();
    const input = screen.getByLabelText(/mensagem/i);
    fireEvent.change(input, { target: { value: "rascunho humano" } });

    fireEvent.click(screen.getByRole("button", { name: "Usar no composer" }));

    expect(input).toHaveValue("rascunho humano");
    expect(sendMock).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalled();
  });

  it("alterna pra modo nota interna: some anexo/rascunho/áudio, muda placeholder", () => {
    renderComposer();
    expect(screen.getByRole("button", { name: /anexar/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usar no composer" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));

    expect(screen.queryByRole("button", { name: /anexar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Usar no composer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /gravar áudio/i })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/nota interna/i)).toBeInTheDocument();
  });

  it("modo nota interna: enviar chama useCreateNote e NÃO useSendMessage", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));

    fireEvent.change(screen.getByPlaceholderText(/nota interna/i), {
      target: { value: "cliente ligou reclamando" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1", body: "cliente ligou reclamando" }),
      expect.anything(),
    );
    expect(sendMock).not.toHaveBeenCalled();
  });
});
