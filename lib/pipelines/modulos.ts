/**
 * Módulos ligados por funil — `crm_pipelines.settings.modulos.<modulo>`.
 *
 * Duas funções puras, e é de propósito que nenhuma delas conheça um módulo
 * pelo nome: o core sabe LER e MESCLAR módulos; quem sabe QUAL módulo existe é
 * a camada que o implementa (ex.: `lib/afb/gate.ts`). É o que deixa um fork
 * atualizar este arquivo sem carregar nome de cliente.
 *
 * ─── Por que `=== true` e nada mais ─────────────────────────────────────────
 *
 * `settings` é jsonb sem CHECK e chega aqui como `Record<string, unknown>` de
 * cinco leitores diferentes, nenhum dos quais valida (board, funil padrão,
 * crm-summary, tela de funis, handler). Só a ESCRITA pela server action passa
 * pelo Zod; SQL na mão não passa. Então a leitura não confia na forma:
 * `"true"`, `1`, `modulos` como array, módulo como array — tudo é "desligado".
 *
 * ─── O merge tem exatamente TRÊS níveis, e para no terceiro ─────────────────
 *
 *   settings          → spread (a action faz)       preserva fields, canonical_tags…
 *   modulos           → spread (aqui)               preserva os outros módulos
 *   módulo            → spread (aqui)               preserva as propriedades não enviadas
 *   propriedade       → SUBSTITUIÇÃO INTEIRA         `etapas` enviado troca o mapa todo
 *
 * O terceiro nível existe porque um módulo tem MAIS de uma propriedade com
 * donos diferentes: o interruptor da tela manda `{ enabled }` e não sabe do
 * mapa de etapas; a tela do mapa manda `{ etapas }` e não sabe do interruptor.
 * Substituir o módulo inteiro faria cada uma apagar a outra.
 *
 * O quarto nível NÃO existe, de propósito: `etapas` enviado substitui o mapa
 * inteiro. Merge por stageId tornaria impossível DESMAPEAR uma coluna — quem
 * quer tirar uma entrada manda o mapa sem ela. E um deep-merge genérico erra
 * também em array: array se substitui, não se concatena.
 */
import type { ModulosDeFunil } from "@/lib/schemas/settings";

/** Objeto simples, não-nulo, não-array — a única forma que um jsonb de módulos pode ter. */
function objetoSimples(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/**
 * Lê `settings.modulos[modulo].enabled` sem confiar na forma.
 *
 * `true` só quando o caminho inteiro existe, é objeto em cada nível e o
 * `enabled` é o booleano `true`. Qualquer outra coisa — ausente, `null`,
 * string, número, array, objeto malformado — é `false`.
 */
export function moduloDeFunilAtivo(
  settings: Record<string, unknown> | null | undefined,
  modulo: string,
): boolean {
  if (!objetoSimples(settings)) return false;
  const modulos = settings.modulos;
  if (!objetoSimples(modulos)) return false;
  const m = modulos[modulo];
  if (!objetoSimples(m)) return false;
  return m.enabled === true;
}

/**
 * Mescla o patch de módulos sobre o que já está gravado — três níveis, ver o
 * cabeçalho.
 *
 * `atual` inválido (null, array, string vinda de um jsonb mexido à mão) é
 * tratado como vazio, nunca lança — a action está no meio de uma gravação e
 * um throw aqui deixaria o administrador com "Erro:" e nenhuma pista. Módulo
 * atual inválido idem: o patch dele vira o módulo inteiro.
 */
export function mergeConfiguracaoDeModulos(
  atual: unknown,
  patch: ModulosDeFunil,
): Record<string, unknown> {
  const base: Record<string, unknown> = objetoSimples(atual) ? { ...atual } : {};
  for (const [nome, moduloPatch] of Object.entries(patch)) {
    if (moduloPatch === undefined) continue;
    const moduloAtual = objetoSimples(base[nome]) ? base[nome] : {};
    base[nome] = { ...moduloAtual, ...moduloPatch };
  }
  return base;
}
