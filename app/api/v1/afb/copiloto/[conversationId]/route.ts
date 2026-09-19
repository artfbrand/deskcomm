/**
 * GET /api/v1/afb/copiloto/[conversationId] — o contexto do Copiloto Comercial
 * para uma conversa aberta no inbox.
 *
 * Rota própria, em `/afb/`, e não uma chave a mais no `crm-summary`: o que
 * ela devolve é específico do módulo (papel da coluna, etapa do playbook,
 * campos do copiloto), e inflar o resumo genérico com isso faria toda
 * instalação pagar por um módulo que a maioria não liga.
 *
 * Segurança, na ordem em que acontece:
 *   1. `requireRole("viewer")` — sessão validada no backend (`getUser()`),
 *      organização ATIVA resolvida da sessão. Nada vem do pedido além do id
 *      da conversa, que está no path. O piso é VIEWER porque isto é leitura
 *      do que a pessoa já enxerga no CRM (`inbox.view`, `pipeline.view`,
 *      `contact.view` são `viewer`): a coluna do lead, o campo do lead, o
 *      papel da coluna. Um piso de `agent` negava a sessão de acompanhamento
 *      SOMENTE LEITURA — que é `viewer` por construção
 *      (`fn_user_role_in_org`) e vê a conversa inteira — com um 403 que não
 *      protegia nada: o mesmo dado sai do `crm-summary` sem piso nenhum.
 *      Quem não pode ver o inbox continua sem ver o copiloto: a RLS e o
 *      filtro de organização abaixo não mudam com o papel.
 *   2. Cliente de SESSÃO (RLS). Nunca admin.
 *   3. Toda consulta do carregador filtra `organization_id` da sessão — a RLS
 *      enxerga todas as orgs do usuário, e o filtro é o que prende à ativa.
 *   4. Conversa que não existe e conversa de outra organização são o MESMO
 *      404: a diferença entre as duas é informação que não se dá.
 *
 * Os estados de negócio (sem lead, ambíguo, desligado, sem playbook, coluna
 * sem papel, ganho/perdido…) são 200 com `status` discriminado — a tela decide
 * o que mostrar. 500 só para falha inesperada, e sem a mensagem do Postgres.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { carregarContextoDoCopiloto } from "@/lib/afb/copiloto/carregar";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ conversationId: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { conversationId } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const resultado = await carregarContextoDoCopiloto(supabase, authz.org.orgId, conversationId);

  if (resultado.tipo === "conversa_nao_encontrada") {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }
  if (resultado.tipo === "falha") {
    // A mensagem do banco vai para o log correlacionado, não para o cliente.
    logger.error("afb.copiloto.contexto_falhou", { requestId, conversationId, mensagem: resultado.mensagem });
    return fail("internal_error", t("Não foi possível montar o contexto do copiloto."), 500, { requestId });
  }
  return ok(resultado.contexto, { requestId });
}
