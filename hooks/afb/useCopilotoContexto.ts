"use client";
/**
 * O contexto do Copiloto Comercial para a conversa aberta no inbox — leitura.
 *
 * Gêmeo de `hooks/inbox/useConversation`: `useQuery` + `apiClient`, chave por
 * id, desligado sem id, `retry: false` para o 404 não ser re-tentado. É o
 * MESMO sistema de fetching do resto do inbox; nada novo.
 *
 * ─── O que é erro e o que é estado ───────────────────────────────────────────
 *
 * A rota devolve 200 com `data.status` para TUDO que é decisão de negócio:
 * sem lead, lead ambíguo, copiloto desligado, sem playbook, coluna sem papel,
 * ganho/perdido… Nada disso é `error` aqui — é `data`, e a tela decide o que
 * mostrar. `error` é só transporte/servidor: 401, 404 (conversa inexistente
 * ou fora do acesso), 5xx. `contextoNaoEncontrado(error)` separa o 404 do
 * resto, como `isNotFound` faz para a conversa.
 *
 * ─── Contexto de A nunca aparece como se fosse de B ─────────────────────────
 *
 * A chave carrega o `conversationId`; trocar de conversa troca de chave, e o
 * react-query começa a nova com `data: undefined` — sem `placeholderData`,
 * de propósito: mostrar a etapa do lead anterior por um instante, com a
 * conversa nova já na tela, é exatamente o defeito que um copiloto não pode
 * ter. O custo é um esqueleto a cada troca; o preço da alternativa é sugerir
 * a copy errada para a pessoa errada.
 *
 * ─── O único identificador é o da conversa ──────────────────────────────────
 *
 * Nada de `organization_id`, `contact_id`, `lead_id` ou `pipeline_id` no
 * pedido: a rota resolve tudo a partir da conversa, dentro do tenant da
 * sessão. Mandar qualquer um deles seria oferecer ao servidor um dado que ele
 * tem de recusar.
 */
import { useQuery } from "@tanstack/react-query";

import type { ContextoDoCopiloto, RespostaDoContexto } from "@/lib/afb/copiloto/contrato";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

/** A chave de cache — `["afb", "copiloto", "contexto", <conversationId>]`. */
export function chaveDoContextoDoCopiloto(conversationId: string | null | undefined) {
  return ["afb", "copiloto", "contexto", conversationId ?? null] as const;
}

export function rotaDoContextoDoCopiloto(conversationId: string): string {
  return `/api/v1/afb/copiloto/${encodeURIComponent(conversationId)}`;
}

export function useCopilotoContexto(conversationId: string | null | undefined) {
  const id = conversationId && conversationId.trim() !== "" ? conversationId : null;
  return useQuery<ContextoDoCopiloto, ApiError | Error>({
    queryKey: chaveDoContextoDoCopiloto(id),
    enabled: id !== null,
    retry: false,
    queryFn: () => apiClient.get<RespostaDoContexto>(rotaDoContextoDoCopiloto(id!)).then((r) => r.data),
  });
}

/** 404: a conversa não existe ou está fora do acesso — a rota não distingue, e a tela também não deve. */
export function contextoNaoEncontrado(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Falha de transporte ou servidor (tudo que não é 404). O texto do erro NUNCA vai para a tela. */
export function contextoIndisponivel(error: unknown): boolean {
  return error != null && !contextoNaoEncontrado(error);
}
