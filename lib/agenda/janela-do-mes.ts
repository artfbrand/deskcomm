/**
 * A JANELA VISÍVEL da visão Mês — uma conta, um lugar.
 *
 * ─── O defeito que este módulo existe para fechar ───────────────────────────
 *
 * A visão Mês DESENHA seis semanas, começando no domingo da semana que contém o
 * dia 1º. Isso derrama dias dos meses vizinhos para dentro da grade, de
 * propósito (a altura da célula não muda ao virar o mês). Mas a BUSCA pedia o
 * mês CIVIL — `startOfMonth` até `endOfMonth + 1` — e as duas contas viviam em
 * arquivos diferentes, cada uma sem saber da outra.
 *
 * O resultado é uma célula desenhada e vazia: o dia aparece na grade, e a
 * ocupação dele nunca foi buscada.
 *
 * Medido com o `date-fns` do repositório, para `ancora = 2026-10-01`:
 *
 *   desenho  começa em  2026-09-27   (startOfWeek(startOfMonth(ancora)))
 *   busca    começava em 2026-10-01   (startOfMonth(ancora))
 *   evento em 2026-09-30 → célula DESENHADA, dado NÃO buscado
 *
 * Em 2026-09-24 isso reprovou `agenda-ocupacao-do-google-na-grade.spec.ts` duas
 * vezes seguidas, num PR que só mexia numa rota do Inbox. A spec nasceu em
 * 2026-09-08 e essa foi a primeira vez que ela atravessou uma virada de mês —
 * a janela de falha tem TRÊS dias por mês (24, 25 e 26 de setembro de 2026),
 * que é o intervalo em que o quarto dia da semana seguinte cai no mês anterior
 * ao da âncora.
 *
 * ─── Por que um módulo, e não duas linhas corrigidas ────────────────────────
 *
 * Corrigir só a busca fecharia ESTE caso e deixaria as duas contas soltas, cada
 * uma com o seu `6` e o seu `weekStartsOn`. A próxima divergência voltaria pelo
 * mesmo caminho, e o sintoma continuaria sendo "o e2e reprova três dias por
 * mês num PR que não tem nada com Agenda" — o modo de falha mais caro que há,
 * porque acusa o inocente.
 *
 * Com a conta num lugar só, desenhar e buscar passam a ser a MESMA janela por
 * construção. Quem mudar o número de semanas muda os dois lados junto.
 */
import { addDays, startOfMonth, startOfWeek } from "date-fns";

/**
 * SEIS semanas sempre, mesmo quando o mês cabe em cinco.
 *
 * Um mês que ocupa 5 linhas e outro que ocupa 6 fariam a célula mudar de altura
 * ao virar o mês — a grade "pula" e quem estava olhando um dia perde a
 * referência. O custo é uma linha de dias do mês vizinho, que já nasce
 * esmaecida.
 */
export const SEMANAS_NA_VISAO_DE_MES = 6;

/** O domingo é o primeiro dia da grade. Mesma convenção da visão semana. */
export const PRIMEIRO_DIA_DA_SEMANA = 0 as const;

/** Sete dias por semana × as seis linhas desenhadas. */
export const DIAS_NA_VISAO_DE_MES = SEMANAS_NA_VISAO_DE_MES * 7;

export interface JanelaDoMes {
  /** Primeiro instante desenhado — o domingo da semana do dia 1º. INCLUSIVO. */
  inicio: Date;
  /**
   * Primeiro instante FORA da grade. EXCLUSIVO, como o `ate` que a rota de
   * agendamentos espera — é o mesmo contrato das visões semana e dia, e é por
   * isso que a conversão para ISO em `_client.tsx` não precisa de ajuste.
   */
  fim: Date;
}

/**
 * A janela que a visão Mês desenha para uma âncora — e, por consequência, a
 * que ela precisa buscar.
 *
 * `fim` é exclusivo. `inicio` não é o dia 1º: é o domingo anterior a ele,
 * quando o mês não começa num domingo.
 */
export function janelaVisivelDoMes(ancora: Date): JanelaDoMes {
  const inicio = startOfWeek(startOfMonth(ancora), { weekStartsOn: PRIMEIRO_DIA_DA_SEMANA });
  return { inicio, fim: addDays(inicio, DIAS_NA_VISAO_DE_MES) };
}

/**
 * Os dias desenhados, em seis linhas de sete — a forma que a grade consome.
 *
 * Deriva de `janelaVisivelDoMes`, e não de uma segunda conta: é o que garante
 * que a última célula desenhada seja sempre a véspera de `fim`.
 */
export function semanasDaVisaoDeMes(ancora: Date): Date[][] {
  const { inicio } = janelaVisivelDoMes(ancora);
  return Array.from({ length: SEMANAS_NA_VISAO_DE_MES }, (_, semana) =>
    Array.from({ length: 7 }, (_, dia) => addDays(inicio, semana * 7 + dia)),
  );
}
