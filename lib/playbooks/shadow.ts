/**
 * SHADOW do playbook: o que está PUBLICADO no banco × o que o CÓDIGO diz.
 *
 * ─── O que isto é, e o que explicitamente não é ─────────────────────────────
 *
 * É observação. O registry TypeScript continua sendo a autoridade operacional:
 * nada aqui escolhe playbook, etapa, copy ou sugestão, e nada aqui alcança a
 * resposta de rota nenhuma. O resultado desta função é LIDO (log) e
 * DESCARTADO por quem chama. A troca de autoridade é fase posterior e
 * explícita — não começa por uma leitura que "só" ficou pendurada num if.
 *
 * ─── Dois eixos, e por que não um enum só ───────────────────────────────────
 *
 *   outcome "observed"      → status ∈ match | mismatch | missing | invalid | conflict
 *   outcome "not_observed"  → reason ∈ throttled | runtime_sem_playbook | database_error
 *
 * "não está lá" e "não consegui olhar" respondem perguntas diferentes.
 * Colapsar as duas faria uma queda de banco fabricar milhares de `missing` —
 * a contagem passaria a mentir exatamente quando mais importa. Os cinco
 * status descrevem uma observação que ACONTECEU; leitura que falhou é
 * NÃO-OBSERVAÇÃO, e tem eixo próprio.
 *
 * ─── Os três hashes ─────────────────────────────────────────────────────────
 *
 *   sha_persisted   o que o publicador AFIRMOU  (coluna definition_sha256)
 *   sha_recomputed  o que a linha CONTÉM agora  (canonicalHash do jsonb lido)
 *   sha_registry    o que o CÓDIGO diz          (canonicalHash do adaptador)
 *
 * Igualdade é SEMPRE `canonicalHash` — sha256 do JSON com chaves ordenadas
 * recursivamente. Nunca `JSON.stringify`: o `jsonb` não preserva ordem de
 * chaves, e comparar texto produziria divergência falsa em toda ida-e-volta
 * pelo banco. Há teste que lê este arquivo e reprova a reintrodução disso.
 *
 * ─── Precedência: o status é função pura, nunca ambíguo ─────────────────────
 *
 *   1. loader missing                → missing   (+motivo do loader)
 *   2. guarda de forma falhou        → invalid   (row_shape)
 *   3. sha_persisted ≠ recomputed    → conflict  ← ANTES do Zod
 *   4. Zod reprovou                  → invalid   (definicao_invalida)
 *   5. recomputed ≠ registry         → mismatch
 *   6. senão                         → match
 *
 * O passo 3 vem antes do 4 de propósito: uma linha que não descreve a si mesma
 * é achado mais forte que uma queixa de schema, e o Zod reprovando uma linha
 * corrompida é consequência do mesmo defeito, não um segundo defeito. Uma
 * definição pode ser inválida E divergente; o status é UM SÓ — status que
 * pode ser duas coisas não se conta. O diagnóstico completo sai do payload,
 * que carrega os três hashes.
 *
 * Nesta fase: `conflict` = integridade do REGISTRO persistido; `mismatch` =
 * dois lados válidos e íntegros com conteúdo diferente.
 *
 * ─── O resultado é desenhado para ser LOGADO como está ──────────────────────
 *
 * É o que torna mecânica — e não lembrada — a regra de não vazar conteúdo:
 * campo que não pode ir para o log não entra no tipo. Aqui não existe campo
 * para `definition`, copy, mensagem, `conversation_id`, `contact_id`,
 * `lead_id` nem `pipeline_id`. Os caches guardam hashes, booleanos e caminhos
 * de erro — nenhum deles guarda uma linha de texto comercial.
 *
 * Este módulo não importa nada de `lib/afb/`: a identidade persistida e o hash
 * do registry chegam por parâmetro. Há teste que lê os imports.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";
import { logger } from "@/lib/logger";

import { carregarPlaybookPublicado, type MotivoDeAusencia } from "./carregador";
import { validarDefinicao } from "./definicao";

// ─── Contrato ────────────────────────────────────────────────────────────────

export type PlaybookShadowStatus = "match" | "mismatch" | "missing" | "invalid" | "conflict";

export type PlaybookShadowReason =
  | MotivoDeAusencia
  | "row_shape"
  | "definicao_invalida"
  | "sha_gravado_diverge_do_conteudo"
  | "conteudo_divergente"
  | "equivalente";

export type PlaybookShadowSkip = "throttled" | "runtime_sem_playbook" | "database_error";

export interface PlaybookShadowObservation {
  outcome: "observed";
  status: PlaybookShadowStatus;
  reason: PlaybookShadowReason;
  organization_id: string;
  slug: string;
  /** O id que o funil grava hoje (`afb_comercial_v1`) — o rastro do binding em vigor. */
  registry_playbook_id: string;
  playbook_id: string | null;
  published_version_id: string | null;
  version_number: number | null;
  sha_persisted: string | null;
  sha_recomputed: string | null;
  sha_registry: string;
  /** Caminhos Zod, no máximo 5. Caminho, nunca valor: valor carregaria copy. */
  issue_paths?: string[];
  duration_ms: number;
}

export interface PlaybookShadowSkipped {
  outcome: "not_observed";
  reason: PlaybookShadowSkip;
}

export type PlaybookShadowResult = PlaybookShadowObservation | PlaybookShadowSkipped;

export interface EntradaDoShadow {
  /** Cliente de SESSÃO (RLS). Nunca admin: isto roda em caminho de request. */
  client: SupabaseClient;
  /** Da sessão validada, nunca do corpo do pedido. */
  organizationId: string;
  /** A identidade persistida dentro da organização. */
  slug: string;
  registryPlaybookId: string;
  /**
   * O hash canônico do que o CÓDIGO diz, sob demanda. É thunk, e não valor,
   * por duas razões: derivar a definição do registry custa (~55 KB de JSON) e
   * não deve ser pago quando a observação está em cadência; e receber a
   * definição pronta obrigaria este módulo genérico a conhecer o formato de
   * quem a produz.
   */
  shaDoRegistry: () => string;
}

// ─── Cadência e caches ───────────────────────────────────────────────────────

/** Janela ÚNICA: uma observação por identidade a cada 10 min, por processo. */
export const JANELA_DE_OBSERVACAO_MS = 10 * 60 * 1000;
/** Teto grosseiro; uma instalação tem 1–2 versões vivas, não 50. */
const TETO_DO_CACHE = 50;

/**
 * O que uma versão publicada tem de imutável — e por isso cacheável PARA
 * SEMPRE por `version_id`: a linha é vetada a UPDATE por trigger, então o que
 * foi avaliado uma vez nunca muda. É o único cache que paga por si: ele não
 * evita consulta (o ponteiro tem de ser relido de qualquer jeito, senão um
 * publish novo passaria despercebido), evita RECALCULAR — `canonicalHash` e
 * Zod sobre ~55 KB de JSON a cada observação.
 *
 * Note o que NÃO está aqui: a definição. O cache guarda hashes, booleanos e
 * caminhos de erro; nenhuma linha de texto comercial mora nele.
 */
interface VersaoAvaliada {
  versionNumber: number | null;
  shaGravado: string | null;
  shaRecalculado: string | null;
  formaOk: boolean;
  zodOk: boolean;
  issuePaths: string[];
}

const versaoPorId = new Map<string, VersaoAvaliada>();
const shaDoRegistryPorId = new Map<string, string>();
const ultimaObservacaoPor = new Map<string, number>();

/** Só para teste. Nada do runtime chama isto. */
export function limparCachesDoShadow(): void {
  versaoPorId.clear();
  shaDoRegistryPorId.clear();
  ultimaObservacaoPor.clear();
}

// ─── Guardas de forma ────────────────────────────────────────────────────────

const SHA_HEX = /^[0-9a-f]{64}$/;

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A guarda que torna HONESTO o cast de quem lê estas tabelas.
 *
 * O schema garante `definition_sha256 ~ '^[0-9a-f]{64}$'`, `version_number >= 1`
 * e `jsonb_typeof(definition) = 'object'`. Mas `lib/database.types.ts` não
 * conhece estas tabelas, então o TypeScript chega até aqui por cast — uma
 * promessa que ninguém verificou. Conferir na fronteira custa três `typeof`.
 */
function avaliarVersao(bruto: { versionNumber: unknown; definition: unknown; definitionSha256: unknown }): VersaoAvaliada {
  const shaGravado = typeof bruto.definitionSha256 === "string" && SHA_HEX.test(bruto.definitionSha256)
    ? bruto.definitionSha256
    : null;
  const versionNumber = typeof bruto.versionNumber === "number" && Number.isInteger(bruto.versionNumber) && bruto.versionNumber >= 1
    ? bruto.versionNumber
    : null;
  const definicaoEhObjeto = ehObjeto(bruto.definition);
  const formaOk = shaGravado !== null && versionNumber !== null && definicaoEhObjeto;

  // O hash é sobre o conteúdo; ele é calculável mesmo quando o carimbo ou o
  // número estão tortos, e é justamente aí que ele mais diz. Só não existe
  // quando nem objeto a definição é.
  const shaRecalculado = definicaoEhObjeto ? canonicalHash(bruto.definition) : null;

  const zod = definicaoEhObjeto ? validarDefinicao(bruto.definition) : null;
  return {
    versionNumber,
    shaGravado,
    shaRecalculado,
    formaOk,
    zodOk: zod?.ok === true,
    issuePaths: zod && !zod.ok ? zod.erros.slice(0, 5).map((e) => e.path) : [],
  };
}

// ─── A observação ────────────────────────────────────────────────────────────

/**
 * Observa e devolve. NÃO escreve em lugar nenhum, NÃO lança, e o valor
 * devolvido é para diagnóstico — quem chama o descarta.
 *
 * Fail-open é estrutural: todo caminho desta função termina num
 * `PlaybookShadowResult`, o `catch` de fora converte qualquer exceção
 * inesperada em `not_observed/database_error`, e nada daqui toca contexto,
 * sugestão, lead, funil ou envio.
 */
export async function observarPlaybookEmShadow(entrada: EntradaDoShadow): Promise<PlaybookShadowResult> {
  const inicio = Date.now();
  const chave = `${entrada.organizationId}:${entrada.slug}`;

  const ultima = ultimaObservacaoPor.get(chave);
  if (ultima !== undefined && inicio - ultima < JANELA_DE_OBSERVACAO_MS) {
    return { outcome: "not_observed", reason: "throttled" };
  }
  // Marca ANTES do await: dois pedidos simultâneos na mesma identidade não
  // disparam duas leituras. A cadência é do processo, e é por processo — num
  // host com N instâncias o volume é N×, o que na VPS self-host é 1–2.
  ultimaObservacaoPor.set(chave, inicio);

  try {
    let shaRegistry = shaDoRegistryPorId.get(entrada.registryPlaybookId);
    if (shaRegistry === undefined) {
      shaRegistry = entrada.shaDoRegistry();
      shaDoRegistryPorId.set(entrada.registryPlaybookId, shaRegistry);
    }

    const base = {
      organization_id: entrada.organizationId,
      slug: entrada.slug,
      registry_playbook_id: entrada.registryPlaybookId,
      sha_registry: shaRegistry,
    } as const;

    // O ponteiro é SEMPRE relido: ele é a única peça mutável do par, e publicar
    // é movê-lo. Um cache dele serviria a versão anterior a quem acabou de
    // publicar — e não pouparia nada, porque só se lê aqui uma vez a cada
    // janela de cadência.
    const leitura = await carregarPlaybookPublicado(entrada.client, entrada.organizationId, entrada.slug);

    if (leitura.tipo === "database_error") {
      logger.warn("playbook.shadow", {
        outcome: "not_observed",
        reason: "database_error",
        etapa: leitura.etapa,
        organization_id: entrada.organizationId,
        slug: entrada.slug,
        mensagem: leitura.mensagem,
      });
      return { outcome: "not_observed", reason: "database_error" };
    }

    if (leitura.tipo === "missing") {
      return publicar({
        outcome: "observed",
        status: "missing",
        reason: leitura.motivo,
        ...base,
        playbook_id: null,
        published_version_id: null,
        version_number: null,
        sha_persisted: null,
        sha_recomputed: null,
        duration_ms: Date.now() - inicio,
      });
    }

    let avaliada = versaoPorId.get(leitura.publishedVersionId);
    if (avaliada === undefined) {
      avaliada = avaliarVersao(leitura);
      if (versaoPorId.size >= TETO_DO_CACHE) versaoPorId.clear();
      versaoPorId.set(leitura.publishedVersionId, avaliada);
    }

    return publicar(
      montar(base, avaliada, leitura.playbookId, leitura.publishedVersionId, Date.now() - inicio),
    );
  } catch (e) {
    logger.error("playbook.shadow.falhou", {
      organization_id: entrada.organizationId,
      slug: entrada.slug,
      erro: e instanceof Error ? e.message : String(e),
    });
    return { outcome: "not_observed", reason: "database_error" };
  }
}

/** A precedência, e só ela. Função pura: mesmos hashes ⇒ mesmo status. */
function montar(
  base: { organization_id: string; slug: string; registry_playbook_id: string; sha_registry: string },
  a: VersaoAvaliada,
  playbookId: string,
  versionId: string,
  duracao: number,
): PlaybookShadowObservation {
  const comum = {
    outcome: "observed" as const,
    ...base,
    playbook_id: playbookId,
    published_version_id: versionId,
    version_number: a.versionNumber,
    sha_persisted: a.shaGravado,
    sha_recomputed: a.shaRecalculado,
    duration_ms: duracao,
  };

  // 2. forma da linha
  if (!a.formaOk) return { ...comum, status: "invalid", reason: "row_shape" };
  // 3. a linha descreve a si mesma?
  if (a.shaGravado !== a.shaRecalculado) {
    return { ...comum, status: "conflict", reason: "sha_gravado_diverge_do_conteudo" };
  }
  // 4. a definição tem a forma do contrato?
  if (!a.zodOk) return { ...comum, status: "invalid", reason: "definicao_invalida", issue_paths: a.issuePaths };
  // 5. os dois lados dizem a mesma coisa?
  if (a.shaRecalculado !== base.sha_registry) return { ...comum, status: "mismatch", reason: "conteudo_divergente" };
  // 6.
  return { ...comum, status: "match", reason: "equivalente" };
}

const curto = (sha: string | null): string | null => (sha === null ? null : sha.slice(0, 12));

/**
 * O destino desta fase é UM: log estruturado. Sem escrita em tabela, sem
 * aviso na Central, sem `event_log`, sem `api_audit_log` — o shadow não é
 * mutação, e auditar leitura recorrente é o defeito que a doutrina já pagou
 * com 95% de audit log de batida de cron vazia.
 *
 * `match` também é logado: o volume é governado pela cadência (≤6 linhas/hora
 * por identidade), não pelo tráfego, e é o que torna "quantos match" uma
 * contagem em vez de uma suposição.
 */
function publicar(o: PlaybookShadowObservation): PlaybookShadowObservation {
  const linha = {
    ...o,
    sha_persisted: curto(o.sha_persisted),
    sha_recomputed: curto(o.sha_recomputed),
    sha_registry: curto(o.sha_registry),
  };
  if (o.status === "match") logger.info("playbook.shadow", linha);
  else logger.warn("playbook.shadow", linha);
  return o;
}
