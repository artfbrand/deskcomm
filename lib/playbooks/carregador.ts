/**
 * O LOADER do playbook publicado — genérico, somente leitura, por ponteiro.
 *
 * ─── O que ele responde ─────────────────────────────────────────────────────
 *
 * "Qual definição está PUBLICADA para esta organização, sob esta identidade?"
 * A identidade é `(organization_id, slug)` — nunca o nome, nunca o sha, nunca
 * o id legado do registry. É a mesma identidade que o bootstrap usa para
 * decidir `create`/`publish`/`unchanged`/`adopt`/`conflict`.
 *
 * ─── A versão vem do PONTEIRO, nunca do máximo ──────────────────────────────
 *
 * A versão lida é exatamente `ai_playbooks.published_version_id`. Não há
 * `order by version_number desc limit 1`, não há `max()`, não há "a mais
 * recente". A razão é que o ponteiro e o número são réguas diferentes:
 * rollback é MOVER O PONTEIRO, e num rollback a versão publicada é a de
 * número MENOR. Quem lê pelo máximo serve, em silêncio, a versão que acabou
 * de ser rejeitada. Há teste que lê este arquivo e reprova `.order(`.
 *
 * ─── Tenancy ────────────────────────────────────────────────────────────────
 *
 * As DUAS consultas filtram `organization_id` explicitamente, e o valor vem
 * de quem chama (sessão validada), nunca do corpo de um pedido. Mesmo com
 * cliente de sessão (RLS), o filtro é obrigatório: `fn_user_org_ids()`
 * enxerga TODAS as organizações do usuário, e sem o filtro o playbook de uma
 * outra org da mesma pessoa seria lido como se fosse o da ativa (CLAUDE.md).
 *
 * ─── Duas idas, e por quê ───────────────────────────────────────────────────
 *
 * Ponteiro primeiro, versão depois — a MESMA forma que o repositório de
 * provisionamento já exerce contra o PostgREST real. O join único por
 * embedding exigiria desambiguar entre as duas FKs compostas que ligam estas
 * tabelas, pelo NOME da constraint; e `lib/database.types.ts` não conhece
 * estas tabelas, então o tipo do embed seria cast de qualquer jeito.
 *
 * Se o ponteiro se mover entre as duas leituras, a segunda devolve vazio e o
 * resultado é `missing/version_row_missing`. Não há leitura rasgada possível:
 * a versão é imutável por trigger, então o que for lido por id é íntegro ou
 * não existe.
 *
 * ─── O que ele NÃO faz ──────────────────────────────────────────────────────
 *
 * Não valida a definição (isso é de `shadow.ts`, que sabe o que a forma
 * significa), não calcula hash, não escreve nada, e não lança: quem chama
 * está num caminho de observação e precisa da lista de casos, não de uma
 * exceção. Os campos cuja FORMA será conferida saem daqui como `unknown` —
 * afirmar o tipo deles aqui seria a mesma promessa vazia que o cast faz.
 *
 * Este módulo não importa nada de `lib/afb/`: o genérico não conhece cliente
 * nenhum, e há teste que lê os imports.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O que existe, mas não há o que comparar. Nada aqui é defeito. */
export type MotivoDeAusencia =
  /** Não há linha em `ai_playbooks` para `(organization_id, slug)`. */
  | "pointer_absent"
  /** Há ponteiro, mas ele nunca publicou (status `draft`, ou sem versão apontada). */
  | "not_published"
  /** O ponteiro está arquivado. */
  | "archived"
  /** O ponteiro aponta para uma versão que não existe ou não é legível. */
  | "version_row_missing";

export interface PlaybookPersistido {
  playbookId: string;
  slug: string;
  publishedVersionId: string;
  /** Cru de propósito: a guarda de forma é de quem compara. */
  versionNumber: unknown;
  /** O `jsonb` como veio. Quem valida é `shadow.ts`, com o schema Zod. */
  definition: unknown;
  /** O sha GRAVADO pelo publicador — não é recalculado aqui. */
  definitionSha256: unknown;
}

export type LeituraDePlaybook =
  | ({ tipo: "found" } & PlaybookPersistido)
  | { tipo: "missing"; motivo: MotivoDeAusencia }
  /** `mensagem` vai para o log correlacionado, NUNCA para uma resposta HTTP. */
  | { tipo: "database_error"; etapa: "pointer" | "version"; mensagem: string };

const COLUNAS_PONTEIRO = "id, slug, status, published_version_id";
const COLUNAS_VERSAO = "id, version_number, definition, definition_sha256";

export async function carregarPlaybookPublicado(
  client: SupabaseClient,
  organizationId: string,
  slug: string,
): Promise<LeituraDePlaybook> {
  const ponteiro = await client
    .from("ai_playbooks")
    .select(COLUNAS_PONTEIRO)
    .eq("organization_id", organizationId)
    .eq("slug", slug)
    .maybeSingle();
  if (ponteiro.error) {
    return { tipo: "database_error", etapa: "pointer", mensagem: ponteiro.error.message };
  }
  if (!ponteiro.data) return { tipo: "missing", motivo: "pointer_absent" };

  const linha = ponteiro.data as Record<string, unknown>;
  // Arquivado ANTES de publicado: o CHECK `archived_at_coerente` permite que um
  // ponteiro arquivado ainda carregue a versão que publicou, e servir essa
  // versão como se estivesse no ar seria ressuscitar estratégia aposentada.
  if (linha.status === "archived") return { tipo: "missing", motivo: "archived" };

  const versionId = linha.published_version_id;
  // `not_published` cobre também o ponteiro cujo `published_version_id` não é
  // um id utilizável. A coluna é `uuid`, então o caso é inalcançável pelo
  // schema; e a distinção "malformado" × "ausente" não teria consumidor —
  // dos dois jeitos não há versão a seguir. Não se inventa vocabulário para
  // um caso que ninguém consegue produzir nem usar.
  if (linha.status !== "published" || typeof versionId !== "string" || versionId === "") {
    return { tipo: "missing", motivo: "not_published" };
  }

  const versao = await client
    .from("ai_playbook_versions")
    .select(COLUNAS_VERSAO)
    .eq("organization_id", organizationId)
    .eq("id", versionId)
    .maybeSingle();
  if (versao.error) {
    return { tipo: "database_error", etapa: "version", mensagem: versao.error.message };
  }
  if (!versao.data) return { tipo: "missing", motivo: "version_row_missing" };

  const v = versao.data as Record<string, unknown>;
  return {
    tipo: "found",
    playbookId: String(linha.id),
    slug: String(linha.slug),
    publishedVersionId: versionId,
    versionNumber: v.version_number,
    definition: v.definition,
    definitionSha256: v.definition_sha256,
  };
}
