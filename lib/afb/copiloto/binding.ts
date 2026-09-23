/**
 * QUAL binding o funil declara — e de QUAL das duas fontes ele veio.
 *
 * Regra pura: não consulta banco, não resolve playbook, não traduz id para
 * slug e não conhece playbook nenhum pelo nome. Ela responde uma pergunta só,
 * e responde com a procedência junto:
 *
 *   "este funil aponta para um playbook? por qual das duas vias?"
 *
 * ─── As duas fontes, e por que elas NÃO se confundem ────────────────────────
 *
 *   persistido  `crm_pipelines.ai_playbook_id` — UUID, aponta para uma LINHA
 *               de `ai_playbooks` (migrations 0233/0234). É o ponteiro real,
 *               com FK composta que garante o tenant no banco.
 *   legado      `settings.modulos.copiloto_comercial.playbook_id` — id de
 *               REGISTRY (`afb_comercial_v1`), uma constante de CÓDIGO. Não há
 *               linha correspondente; a forma é `<nome>_v<n>`.
 *
 * Os dois vocabulários são mutuamente inválidos, e isso não é sorte: um UUID
 * tem hífens e nunca casa `^[a-z0-9_]+_v\d+$`; um id de registry não tem a
 * forma 8-4-4-4-12. Então nenhum valor pode ser lido como o outro por engano —
 * e há teste que mede exatamente isso nos dois sentidos.
 *
 * ─── Precedência ────────────────────────────────────────────────────────────
 *
 *   1. `ai_playbook_id` legível  →  persistido
 *   2. senão, legado com forma válida  →  legado
 *   3. senão  →  ausente
 *
 * `ausente` é o estado NORMAL de toda instalação de hoje: a 0234 criou a
 * coluna sem backfill, então ela é `null` em toda linha de todo clone. Não é
 * defeito, não lança, e não vira exceção.
 *
 * ─── A decisão sobre UUID presente e ILEGÍVEL ───────────────────────────────
 *
 * Valor presente que não tem forma de UUID NÃO cai para o legado: para em
 * `ausente`.
 *
 * O motivo é que as duas situações dizem coisas diferentes. `null` é a fonte
 * persistida dizendo "não tenho nada a declarar" — e aí perguntar ao legado é
 * o comportamento certo. Um valor presente é alguém tendo DECLARADO um vínculo;
 * se ele é ilegível, servir o id legado no lugar entregaria um playbook
 * DIFERENTE do que foi escolhido, calado. É o fallback silencioso que esta
 * fase inteira existe para não ter.
 *
 * Vale registrar o alcance honesto da decisão: ela é sobre um estado que o
 * banco não consegue produzir. A coluna é `uuid`, então o Postgres recusa
 * qualquer coisa que não tenha a forma — um valor torto só chega aqui por um
 * cast na mão, um dublê de teste ou um caminho de leitura corrompido.
 *
 * E é por isso que ele NÃO ganha vocabulário próprio (um quarto `origem:
 * "invalido"`). A casa já decidiu esse mesmo ponto em `lib/playbooks/
 * carregador.ts`, para a mesma classe de coluna: *"a distinção malformado ×
 * ausente não teria consumidor… não se inventa vocabulário para um caso que
 * ninguém consegue produzir nem usar"*. O que muda aqui é só o destino do
 * caso — lá não havia segunda fonte para cair; aqui há, e cair nela é que
 * seria o erro.
 *
 * ─── Sobre a validação de forma do UUID ─────────────────────────────────────
 *
 * Não existe helper público de UUID neste repositório (o único parecido é um
 * `const` local dentro do repositório de provisionamento, não exportado), então
 * a forma é verificada aqui mesmo, em uma linha.
 *
 * E a forma verificada é a que o TIPO DA COLUNA aceita — 8-4-4-4-12 hexa —, não
 * a de um UUID v4. A regex do provisionamento restringe versão (`[1-5]`) e
 * variante (`[89ab]`); copiá-la aqui inventaria um contrato mais estrito que o
 * do banco, e passaria a recusar um valor que o Postgres guarda sem reclamar.
 * Quem decide se o UUID EXISTE é a FK, não esta função.
 */
import { playbookIdDoCopiloto } from "@/lib/pipelines/modulos";

/** A forma que a coluna `uuid` do Postgres aceita. Sem restrição de versão. */
const FORMA_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O binding do funil, com a procedência sempre explícita. Nunca as duas ao
 * mesmo tempo: quem lê sabe, pelo discriminante, qual identificador recebeu e
 * de onde ele veio.
 */
export type BindingDoCopiloto =
  /** Ponteiro para `ai_playbooks.id`. */
  | { origem: "persistido"; aiPlaybookId: string }
  /** Id do registry em código (`<nome>_v<n>`), na forma — não resolvido. */
  | { origem: "legado"; registryPlaybookId: string }
  /** Nenhuma das duas fontes declara vínculo utilizável. */
  | { origem: "ausente" };

export interface EntradaDoBinding {
  /**
   * `crm_pipelines.ai_playbook_id` como veio da linha. `unknown` de propósito:
   * quem chama traz o resultado de um `.select()`, e afirmar `string | null`
   * aqui seria uma promessa que esta função não pode conferir.
   */
  aiPlaybookId: unknown;
  /** `crm_pipelines.settings` — `jsonb` sem CHECK, lido sem confiar na forma. */
  settings: Record<string, unknown> | null | undefined;
}

/**
 * Lê o binding do funil sem tocar em banco e sem resolver nada.
 *
 * Não muta a entrada: as duas fontes são só lidas, e `settings` sai daqui
 * exatamente como entrou.
 */
export function lerBindingDoCopiloto(entrada: EntradaDoBinding): BindingDoCopiloto {
  const persistido = entrada.aiPlaybookId;

  // Ausente é `null` ou `undefined` — e SÓ isso é o convite para perguntar ao
  // legado. Qualquer valor presente é uma declaração, e é tratado como tal.
  if (persistido !== null && persistido !== undefined) {
    if (typeof persistido === "string" && FORMA_DE_UUID.test(persistido)) {
      // Devolvido VERBATIM, sem normalizar caixa: normalizar seria transformar
      // em silêncio um valor que quem chamou vai comparar com o banco.
      return { origem: "persistido", aiPlaybookId: persistido };
    }
    // Presente e ilegível. Para aqui, de propósito — ver o cabeçalho.
    return { origem: "ausente" };
  }

  // O legado é lido pelo MESMO leitor que o resto do produto usa
  // (`lib/pipelines/modulos.ts`), e não por uma segunda cópia da regra: duas
  // cópias divergiriam, e a divergência apareceria como um funil que o gate
  // considera configurado e o binding considera vazio.
  const legado = playbookIdDoCopiloto(entrada.settings);
  if (legado !== null) return { origem: "legado", registryPlaybookId: legado };

  return { origem: "ausente" };
}
