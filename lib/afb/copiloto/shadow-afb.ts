/**
 * A ÚNICA ponte entre o copiloto AFB e o shadow genérico.
 *
 * ─── O que ela traduz ───────────────────────────────────────────────────────
 *
 * O funil grava um id de REGISTRY (`afb_comercial_v1`); o playbook persistido
 * tem um SLUG (`afb_comercial`). São réguas diferentes e por isso a tradução
 * existe:
 *
 *   afb_comercial_v1   id do registry, versionado no NOME (herança do documento)
 *   afb_comercial      identidade persistida, estável, par de (organization_id, slug)
 *
 * O `_v1` do id legado NÃO é `ai_playbook_versions.version_number`. O primeiro
 * nunca muda; o segundo incrementa a cada publicação.
 *
 * ─── Por que o slug é literal aqui ──────────────────────────────────────────
 *
 * A constante existe também em `lib/afb/provisionamento/configuracao.ts`
 * (`AFB_PLAYBOOK_PERSISTIDO`), e seria natural importá-la. Não importamos: o
 * módulo de provisionamento é caminho de CLI, e puxá-lo para dentro de um
 * caminho de request acoplaria o runtime ao mundo do `afb:provision`. O preço
 * de declarar duas vezes é o risco de drift — e esse risco é pago por teste:
 * `shadow-afb.test.ts` compara as duas e reprova se divergirem.
 *
 * ─── O que esta camada NÃO faz ──────────────────────────────────────────────
 *
 * Não decide nada do copiloto. Não lê contexto, não escolhe etapa, não toca em
 * sugestão. Ela responde "qual identidade persistida corresponde ao playbook
 * que o runtime JÁ escolheu" e entrega isso ao shadow genérico, que observa.
 *
 * Nesta fase nenhum caminho vivo chama este módulo.
 */
import { getPlaybook } from "@/lib/afb/playbooks/registry";
import type { ContextoDoCopiloto } from "@/lib/afb/copiloto/contrato";
import { deRegistryParaDefinicao } from "@/lib/playbooks/adaptador-afb";
import { observarPlaybookEmShadow, type PlaybookShadowResult } from "@/lib/playbooks/shadow";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Id do registry → slug persistido. Um mapa de uma entrada, escrito à mão e de
 * propósito: enquanto o binding do funil gravar id legado, a correspondência é
 * conhecimento de código. Quando o binding passar a apontar para o UUID do
 * playbook, este mapa morre inteiro — não é peça a ser generalizada agora.
 */
export const SLUG_PERSISTIDO_POR_ID_DO_REGISTRY: Readonly<Record<string, string>> = {
  afb_comercial_v1: "afb_comercial",
};

export interface IdentidadePersistida {
  registryPlaybookId: string;
  slug: string;
}

/**
 * O playbook que o runtime JÁ resolveu, lido do contexto pronto.
 *
 * É LEITURA do que foi decidido, nunca uma segunda resolução: a rota não
 * consulta gate, registry nem funil de novo — se o copiloto está desligado,
 * sem escolha, com lead ambíguo ou em estado terminal, o contexto simplesmente
 * não traz `pipeline.playbook_id`, e o shadow não tem o que observar.
 *
 * O tipo entra por `import type` — este módulo não executa nada do contrato.
 */
export function playbookIdDoContexto(contexto: ContextoDoCopiloto): string | null {
  if (!("pipeline" in contexto)) return null;
  return "playbook_id" in contexto.pipeline ? contexto.pipeline.playbook_id : null;
}

/**
 * A tradução pura: id do registry → identidade persistida. `null` quando o id
 * não tem par no mapa. Não consulta o registry — quem precisa do CONTEÚDO
 * resolve uma vez, abaixo.
 */
export function identidadePersistidaDoPlaybook(
  playbookId: string | null | undefined,
): IdentidadePersistida | null {
  if (typeof playbookId !== "string") return null;
  const slug = SLUG_PERSISTIDO_POR_ID_DO_REGISTRY[playbookId];
  return slug === undefined ? null : { registryPlaybookId: playbookId, slug };
}

export interface EntradaDoShadowAFB {
  /** Cliente de SESSÃO (RLS), criado na rota antes da resposta. Nunca admin. */
  client: SupabaseClient;
  /** Da sessão validada, nunca do corpo do pedido. */
  organizationId: string;
  /** O que o runtime JÁ resolveu — `contexto.pipeline.playbook_id`. */
  playbookId: string | null | undefined;
}

/**
 * Observa em shadow o playbook que o copiloto já escolheu.
 *
 * `runtime_sem_playbook` quando não há o que observar — copiloto desligado,
 * funil sem escolha, id sem par persistido, ou id que o registry não resolve.
 * Não é falha e não é ausência no banco: é ausência de PERGUNTA. Um id com par
 * no mapa mas sem conteúdo no registry cai aqui de propósito: sem definição em
 * código não há `sha_registry` a comparar, e observar isso como divergência
 * culparia o banco por um buraco do código.
 */
export async function observarPlaybookDoCopilotoAFB(
  entrada: EntradaDoShadowAFB,
): Promise<PlaybookShadowResult> {
  const identidade = identidadePersistidaDoPlaybook(entrada.playbookId);
  if (!identidade) return { outcome: "not_observed", reason: "runtime_sem_playbook" };

  const playbook = getPlaybook(identidade.registryPlaybookId);
  if (playbook === null) return { outcome: "not_observed", reason: "runtime_sem_playbook" };

  return observarPlaybookEmShadow({
    client: entrada.client,
    organizationId: entrada.organizationId,
    slug: identidade.slug,
    registryPlaybookId: identidade.registryPlaybookId,
    // Thunk: derivar a definição do registry custa ~55 KB de JSON, e sob
    // cadência a observação nem acontece. O shadow memoiza o resultado.
    shaDoRegistry: () => deRegistryParaDefinicao(playbook).sha256,
  });
}
