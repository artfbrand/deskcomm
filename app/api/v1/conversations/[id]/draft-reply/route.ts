import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

/**
 * Os prefixos de mensagem interna que este caminho pode lançar e que, POR
 * CONSTRUÇÃO, não carregam conteúdo da conversa — são nomes de estado, não
 * texto do cliente nem resposta do modelo.
 *
 * Coletados lendo os `throw` de `reply-drafts.ts`, `sandbox.ts` e
 * `inbound-turn.ts`; cada um identifica um ponto de parada distinto, que é
 * exatamente o que falta saber.
 */
const PREFIXOS_INTERNOS_SEGUROS = [
  "reply_no_agent",
  "reply_context_unavailable",
  "reply_without_contact",
  "preview_version_unavailable",
  "preview_operational_job_forbidden",
  "preview_transport_forbidden",
  "turn_without_contact",
  "job de turno sem contact_id",
  "fechamento do turno sem JSON de checkpoint",
  "JSON de checkpoint inválido no fechamento do turno",
  "checkpoint do fechamento com shape inválido",
  "abertura do turno falhou em get_lead_context",
  "envio marcado como failed pelo CRM",
] as const;

export interface DetalhesSegurosDoErro {
  error_name: string;
  error_code: string | null;
  error_status: number | null;
  safe_error_message: string;
}

/**
 * O que pode ir para o log sem risco.
 *
 * `safe_error_message` é o PREFIXO casado, nunca a mensagem inteira — e essa
 * escolha é o que faz a garantia sobreviver ao tempo: se alguém amanhã
 * acrescentar contexto a uma dessas mensagens, o log continua publicando só a
 * identificação. Mensagem fora da lista vira `"redacted"`, porque uma exceção
 * de biblioteca ou do provider pode trazer prompt, resposta do modelo ou
 * pedaço de corpo HTTP.
 *
 * `error_name`, `error_code` e `error_status` saem sempre que existirem: são
 * classificação, não conteúdo.
 */
export function detalhesSegurosDoErro(erro: unknown): DetalhesSegurosDoErro {
  const objeto = typeof erro === "object" && erro !== null ? (erro as Record<string, unknown>) : {};
  const mensagem = erro instanceof Error ? erro.message : "";
  const prefixo = PREFIXOS_INTERNOS_SEGUROS.find((p) => mensagem.startsWith(p));
  const code = objeto.code;
  const status = objeto.status ?? objeto.statusCode;
  return {
    error_name: erro instanceof Error ? erro.name : typeof erro,
    error_code: typeof code === "string" || typeof code === "number" ? String(code) : null,
    error_status: typeof status === "number" ? status : null,
    safe_error_message: prefixo ?? "redacted",
  };
}

type Ctx = { params: Promise<{ id: string }> };
async function context(ctx: Ctx, requestId: string) {
  const auth = await requireRole("agent", { requestId, resource: "conversations" });
  if (!auth.ok) return { response: auth.response } as const;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const { id } = await ctx.params;
  const db = await createClient();
  const { data: conversation } = await db
    .from("conversations")
    .select("id,contact_id,channel_session_id")
    .eq("organization_id", auth.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!conversation)
    return { response: fail("not_found", t("Conversa não encontrada."), 404, { requestId }) } as const;
  return { auth, conversation, t } as const;
}
export async function GET(_req: NextRequest, ctx: Ctx) {
  const requestId = randomUUID(),
    c = await context(ctx, requestId);
  if ("response" in c) return c.response;
  const { rows } = await getRequestPool().query(
    `select id,revision::text,original_body,edited_body,approved_body,proposals,feedback,error_code,created_at,
 case when status in ('generating','pending','approved') and not fn_reply_context_current(organization_id,id) then 'stale' else status end as status
 from ai_reply_drafts where organization_id=$1 and conversation_id=$2 order by created_at desc limit 5`,
    [c.auth.org.orgId, c.conversation.id],
  );
  return ok({ drafts: rows }, { requestId });
}
export async function POST(_req: NextRequest, ctx: Ctx) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID(),
    c = await context(ctx, requestId);
  if ("response" in c) return c.response;
  const {
    contact_id: contactId,
    channel_session_id: channelId,
    id: conversationId,
  } = c.conversation;
  if (!contactId || !channelId)
    return fail("unprocessable", c.t("Conversa sem contato/canal."), 422, { requestId });
  try {
    const draft = await generateReplyDraft(getRequestPool(), requestTurnDeps(), {
      organizationId: c.auth.org.orgId,
      conversationId,
      contactId,
      channelId,
    });
    void audit({
      action: "ai_reply.generated",
      actorUserId: c.auth.user.id,
      organizationId: c.auth.org.orgId,
      resourceType: "conversation",
      resourceId: conversationId,
      requestId,
    });
    return ok(
      { draft: draft.original_body ?? "", draft_id: draft.id, status: draft.status },
      { requestId },
    );
  } catch (erro) {
    // O `catch` era VAZIO, e isso custou dois dias de cegueira: o draft ficava
    // `failed`/`generation_failed` no banco, a tela mostrava a frase genérica, e
    // a exceção — a única peça que diz QUAL dos ~11 throws do preview disparou —
    // era destruída aqui. O log não muda nada do que o navegador recebe.
    logger.error("ai_reply.generation_failed", {
      requestId,
      organizationId: c.auth.org.orgId,
      conversationId,
      ...detalhesSegurosDoErro(erro),
    });
    return fail(
      "reply_unavailable",
      c.t("Não foi possível gerar a sugestão. Confira a publicação e a configuração do agente."),
      422,
      { requestId },
    );
  }
}
