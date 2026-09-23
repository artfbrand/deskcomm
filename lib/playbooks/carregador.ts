/**
 * O LOADER do playbook publicado — genérico, somente leitura, por ponteiro.
 *
 * ─── O que ele responde ─────────────────────────────────────────────────────
 *
 * "Qual definição está PUBLICADA para esta organização, sob esta identidade?"
 *
 * Há DUAS identidades, e as duas são do BANCO — nunca o nome, nunca o sha,
 * nunca o id legado do registry:
 *
 *   (organization_id, slug)  a identidade LÓGICA. É a que o bootstrap usa para
 *                            decidir create/publish/unchanged/adopt/conflict.
 *   (organization_id, id)    o PONTEIRO em si. É a que um binding guarda.
 *
 * As duas são `unique` em `ai_playbooks` (migration 0233), as duas terminam na
 * mesma versão e no mesmo resultado; o que muda é a chave da PRIMEIRA consulta.
 *
 * Quem já tem o UUID não volta ao slug para chegar à linha. Traduzir
 * `uuid -> slug -> linha` devolveria autoridade a uma coluna renomeável, e o
 * slug deixa de ser autoridade no instante em que existe um ponteiro. Aqui o
 * slug é CARREGADO no resultado (quem observa o reporta) e nunca CONSULTADO.
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
 * TODA consulta filtra `organization_id` explicitamente, e o valor vem de quem
 * chama (sessão validada), nunca do corpo de um pedido. Mesmo com cliente de
 * sessão (RLS), o filtro é obrigatório: `fn_user_org_ids()` enxerga TODAS as
 * organizações do usuário, e sem o filtro o playbook de uma outra org da mesma
 * pessoa seria lido como se fosse o da ativa (CLAUDE.md).
 *
 * Na entrada por UUID isso pesa ainda mais: sem o filtro, conhecer um
 * `ai_playbooks.id` bastaria para ler a estratégia comercial de outra
 * organização — o id é chave primária, global, e não carrega tenant nenhum.
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
 * ─── Por que só a entrada por UUID filtra `playbook_id` na versão ───────────
 *
 * A FK `ai_playbooks (id, published_version_id) -> ai_playbook_versions
 * (playbook_id, id)` já garante, no banco, que a versão apontada pertence ao
 * ponteiro. Nas duas entradas. O filtro extra não corrige defeito nenhum.
 *
 * Ele existe na entrada por UUID porque ali o `playbook_id` é o ARGUMENTO de
 * quem chamou: repeti-lo na segunda consulta torna a garantia LOCAL — a função
 * devolve uma versão daquele playbook sem que seja preciso ler a definição de
 * uma constraint para saber disso.
 *
 * E ele NÃO foi retroencaixado na entrada por slug, de propósito. Aquela
 * função está num caminho vivo (o shadow do copiloto, em produção), e um
 * filtro a mais muda a consulta emitida. "O resultado é o mesmo porque a FK
 * garante" é um argumento, não uma medição — e não se troca medição por
 * argumento em código que já está no ar. Quando houver prova contra PostgREST
 * real, as duas convergem.
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
  /** Não há linha em `ai_playbooks` para a identidade pedida. */
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

/** Seguir para a versão, ou parar com um motivo. Sem I/O. */
type PassoDoPonteiro =
  | { seguir: true; versionId: string }
  | { seguir: false; motivo: MotivoDeAusencia };

/**
 * A regra de quando um ponteiro SERVE — compartilhada pelas duas entradas.
 *
 * Está fora das funções públicas porque não pode divergir conforme a chave que
 * achou a linha: um playbook arquivado é arquivado tenha sido encontrado por
 * slug ou por id. Duas cópias desta regra envelheceriam em direções opostas, e
 * a divergência apareceria como um shadow que diz `match` por uma porta e
 * `missing` pela outra para a MESMA linha.
 */
function interpretarPonteiro(linha: Record<string, unknown>): PassoDoPonteiro {
  // Arquivado ANTES de publicado: o CHECK `archived_at_coerente` permite que um
  // ponteiro arquivado ainda carregue a versão que publicou, e servir essa
  // versão como se estivesse no ar seria ressuscitar estratégia aposentada.
  if (linha.status === "archived") return { seguir: false, motivo: "archived" };

  const versionId = linha.published_version_id;
  // `not_published` cobre também o ponteiro cujo `published_version_id` não é
  // um id utilizável. A coluna é `uuid`, então o caso é inalcançável pelo
  // schema; e a distinção "malformado" × "ausente" não teria consumidor —
  // dos dois jeitos não há versão a seguir. Não se inventa vocabulário para
  // um caso que ninguém consegue produzir nem usar.
  if (linha.status !== "published" || typeof versionId !== "string" || versionId === "") {
    return { seguir: false, motivo: "not_published" };
  }
  return { seguir: true, versionId };
}

/**
 * Ponteiro + linha de versão → o resultado `found`. Também compartilhada: o
 * formato do que sai daqui é o contrato que `shadow.ts` consome, e ele não
 * pode depender de qual entrada foi usada.
 */
function montarEncontrado(
  linha: Record<string, unknown>,
  versionId: string,
  v: Record<string, unknown>,
): LeituraDePlaybook {
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

/** Lê o playbook publicado pela identidade LÓGICA `(organization_id, slug)`. */
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
  const passo = interpretarPonteiro(linha);
  if (!passo.seguir) return { tipo: "missing", motivo: passo.motivo };

  const versao = await client
    .from("ai_playbook_versions")
    .select(COLUNAS_VERSAO)
    .eq("organization_id", organizationId)
    .eq("id", passo.versionId)
    .maybeSingle();
  if (versao.error) {
    return { tipo: "database_error", etapa: "version", mensagem: versao.error.message };
  }
  if (!versao.data) return { tipo: "missing", motivo: "version_row_missing" };

  return montarEncontrado(linha, passo.versionId, versao.data as Record<string, unknown>);
}

/**
 * Lê o playbook publicado pelo PONTEIRO `(organization_id, id)`.
 *
 * É a entrada de quem guarda um binding: o UUID de `ai_playbooks.id` já É a
 * linha, e a função vai direto a ela. Nenhuma etapa consulta, deriva ou
 * compara `slug` — ele aparece apenas no resultado, como dado de quem observa.
 *
 * Mesmo resultado, mesmos motivos e mesma ordem de consultas da entrada por
 * slug: quem consome não precisa saber por qual porta o playbook entrou.
 */
export async function carregarPlaybookPublicadoPorId(
  client: SupabaseClient,
  organizationId: string,
  playbookId: string,
): Promise<LeituraDePlaybook> {
  const ponteiro = await client
    .from("ai_playbooks")
    .select(COLUNAS_PONTEIRO)
    .eq("organization_id", organizationId)
    .eq("id", playbookId)
    .maybeSingle();
  if (ponteiro.error) {
    return { tipo: "database_error", etapa: "pointer", mensagem: ponteiro.error.message };
  }
  if (!ponteiro.data) return { tipo: "missing", motivo: "pointer_absent" };

  const linha = ponteiro.data as Record<string, unknown>;
  const passo = interpretarPonteiro(linha);
  if (!passo.seguir) return { tipo: "missing", motivo: passo.motivo };

  const versao = await client
    .from("ai_playbook_versions")
    .select(COLUNAS_VERSAO)
    .eq("organization_id", organizationId)
    // O terceiro filtro: a versão tem de ser DESTE playbook. Ver o cabeçalho —
    // a FK já garante, e repetir aqui torna a garantia local ao argumento.
    .eq("playbook_id", playbookId)
    .eq("id", passo.versionId)
    .maybeSingle();
  if (versao.error) {
    return { tipo: "database_error", etapa: "version", mensagem: versao.error.message };
  }
  if (!versao.data) return { tipo: "missing", motivo: "version_row_missing" };

  return montarEncontrado(linha, passo.versionId, versao.data as Record<string, unknown>);
}
