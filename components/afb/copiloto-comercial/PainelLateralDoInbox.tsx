"use client";
/**
 * A terceira coluna do inbox com DUAS abas: Copiloto e Contato.
 *
 * Não é uma quarta coluna — a grade em 1280px já foi medida no limite
 * (`InboxLayout`). É o mesmo espaço do `CRMSidePanel`, que continua inteiro
 * na aba Contato; no celular é a mesma ficha (`Sheet`) que já existia.
 *
 * Sem conversa selecionada, nada muda: o `CRMSidePanel` mostra o convite
 * "Selecione uma conversa" como sempre mostrou.
 *
 * A aba INICIAL de cada conversa depende do contexto: módulo desligado no
 * funil (`copilot_disabled`) abre em Contato — o copiloto não tem nada a
 * dizer ali além de "ligue em Configurações", e a ficha é o que o atendente
 * precisa; qualquer outro estado abre em Copiloto, inclusive os de
 * orientação (sem playbook, coluna sem papel, ambíguo, ganho/perdido…), que
 * têm informação útil. A escolha MANUAL vence enquanto for a mesma conversa;
 * conversa nova recalcula. Enquanto o contexto carrega ainda não se sabe o
 * estado, então a aba padrão é Copiloto com o esqueleto — e vira Contato no
 * instante em que o dado diz `copilot_disabled`, sem nunca passar pelo
 * contexto da conversa anterior (o hook começa a nova chave sem dado).
 *
 * Abas com semântica de abas (Radix: tablist/tab/tabpanel, setas do teclado),
 * rótulos por `t()`, e o painel inativo desmontado — o `CRMSidePanel` só
 * consulta o resumo do contato quando alguém abre a aba Contato.
 */
import { useState } from "react";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

import { CopilotoPanel, type ResultadoDoContexto } from "./CopilotoPanel";

export type AbaDoPainel = "copiloto" | "contato";

/**
 * A aba padrão para um contexto. Só `copilot_disabled` abre em Contato: é o
 * único estado em que o copiloto não tem nada a dizer sobre ESTA conversa. Os
 * demais — inclusive os que pedem configuração ou dizem "ganho/perdido" —
 * carregam informação e abrem em Copiloto. Carregando ou com erro, Copiloto:
 * é onde o esqueleto e o aviso aparecem.
 */
export function abaInicialDoContexto(contexto: ResultadoDoContexto): AbaDoPainel {
  return contexto.data?.status === "copilot_disabled" ? "contato" : "copiloto";
}

interface Props {
  conversation: ConversationWithContact | null;
  /** O resultado de `useCopilotoContexto(selectedId)`, buscado UMA vez no `InboxLayout`. */
  contexto: ResultadoDoContexto;
}

export function PainelLateralDoInbox({ conversation, contexto }: Props) {
  const t = useT();
  // Só a ESCOLHA MANUAL é estado, e por conversa: o par (id, aba). A aba
  // mostrada é derivada no render — escolha manual desta conversa, senão o
  // padrão pelo contexto. Id novo invalida a escolha sem efeito nem
  // remontagem — o padrão de "derivar do prop" do React.
  const [escolha, setEscolha] = useState<{ id: string | null; aba: AbaDoPainel } | null>(null);
  const idAtual = conversation?.id ?? null;
  const manual = escolha && escolha.id === idAtual ? escolha.aba : null;
  const aba: AbaDoPainel = manual ?? abaInicialDoContexto(contexto);

  if (!conversation) return <CRMSidePanel conversation={null} />;

  return (
    <Tabs
      value={aba}
      onValueChange={(v) => setEscolha({ id: idAtual, aba: v === "contato" ? "contato" : "copiloto" })}
      className="flex h-full min-h-0 flex-col border-l border-border bg-background"
      data-testid="painel-lateral-do-inbox"
    >
      <TabsList className="mx-4 mt-3 grid grid-cols-2" aria-label={t("Painel da conversa")}>
        <TabsTrigger value="copiloto" data-testid="aba-copiloto">
          {t("Copiloto")}
        </TabsTrigger>
        <TabsTrigger value="contato" data-testid="aba-contato">
          {t("Contato")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="copiloto" className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="painel-copiloto">
        <h3 className="mb-3 text-xs font-semibold text-text">{t("Copiloto comercial")}</h3>
        <CopilotoPanel contexto={contexto} />
      </TabsContent>
      <TabsContent value="contato" className="min-h-0 flex-1 overflow-hidden" data-testid="painel-contato">
        {/* O CRMSidePanel traz a própria borda esquerda e rolagem; aqui só o espaço. */}
        <CRMSidePanel conversation={conversation} />
      </TabsContent>
    </Tabs>
  );
}
