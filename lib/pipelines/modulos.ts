/**
 * Módulos ligados por funil — `crm_pipelines.settings.modulos.<modulo>.enabled`.
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
 * ─── Por que o merge tem exatamente dois níveis ─────────────────────────────
 *
 * Um spread raso no topo (`nextSettings.modulos = patch.modulos`) apagaria os
 * outros módulos ao salvar um. Hoje só há um e o defeito ficaria invisível até
 * o segundo nascer — que é o tipo de bug que só aparece depois. Um deep-merge
 * genérico erra na outra direção: as chaves futuras de um módulo podem ser
 * arrays, e array se SUBSTITUI, não se concatena. Logo: topo por spread (a
 * action já faz), `modulos` por spread (aqui), módulo inteiro substituído.
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
 * Mescla o patch de módulos sobre o que já está gravado — segundo nível só.
 *
 * Módulo presente no patch SUBSTITUI o módulo inteiro (não funde chaves dentro
 * dele); módulo ausente no patch PERMANECE como estava. `atual` inválido (null,
 * array, string vinda de um jsonb mexido à mão) é tratado como vazio, nunca
 * lança — a action está no meio de uma gravação e um throw aqui deixaria o
 * administrador com "Erro:" e nenhuma pista.
 */
export function mergeModulos(
  atual: unknown,
  patch: ModulosDeFunil,
): Record<string, unknown> {
  const base = objetoSimples(atual) ? atual : {};
  return { ...base, ...patch };
}
