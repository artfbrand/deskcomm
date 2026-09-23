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
 *
 * ─── Shadow do playbook persistido (observação, nunca decisão) ──────────────
 *
 * Depois que o contexto está pronto, a rota AGENDA — para depois do envio da
 * resposta — uma comparação entre o playbook publicado no banco e o que o
 * registry diz. O registry continua sendo a autoridade operacional: o shadow
 * lê, compara, registra no log e o valor é descartado. Ele não entra no
 * contrato HTTP, não troca copy, não muda etapa e não escreve em lugar nenhum.
 *
 * Duas propriedades sustentam isso, e nenhuma delas é promessa de comentário:
 * o trabalho roda via `after()` (portanto depois do flush da resposta, sem
 * custo de latência para quem está no inbox), e o agendamento é envolvido num
 * `catch` que registra e segue — de modo que nem uma falha do próprio
 * agendamento transforma um 200 funcional em 500.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { carregarContextoDoCopiloto } from "@/lib/afb/copiloto/carregar";
import { observarPlaybookDoCopilotoAFB, playbookIdDoContexto } from "@/lib/afb/copiloto/shadow-afb";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { agendarPosResposta } from "@/lib/http/pos-resposta";
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

  // OBSERVAÇÃO, depois da resposta. O contexto acima já está pronto e é a
  // única resposta operacional: o registry decidiu tudo, e nada daqui para
  // baixo o altera. `agendarPosResposta` pode lançar de propósito (erro
  // inesperado do `after()` não é engolido pelo helper genérico) — a barreira
  // operacional é ESTE `catch`, e não uma concessão lá dentro.
  try {
    agendarPosResposta("afb.copiloto.shadow", async () => {
      await observarPlaybookDoCopilotoAFB({
        client: supabase,
        organizationId: authz.org.orgId,
        playbookId: playbookIdDoContexto(resultado.contexto),
        // Canal interno: veio ao lado do contexto, não dentro dele, e por isso
        // não entra na resposta — que continua sendo `ok(resultado.contexto)`.
        binding: resultado.binding,
      });
    });
  } catch (e) {
    // Sanitizado: id do pedido, organização, nome do evento e o erro. Nada de
    // conversa, contato, lead ou conteúdo — este log nasce de uma falha de
    // agendamento, não de um atendimento.
    logger.error("afb.copiloto.shadow_nao_agendado", {
      requestId,
      organizationId: authz.org.orgId,
      erro: e instanceof Error ? e.message : String(e),
    });
  }

  return ok(resultado.contexto, { requestId });
}
