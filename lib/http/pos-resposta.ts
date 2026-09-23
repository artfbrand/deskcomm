/**
 * Trabalho que roda DEPOIS da resposta — o `after()` do Next, encapsulado.
 *
 * ─── Por que não `void promise` ─────────────────────────────────────────────
 *
 * O repo já tem o padrão `void audit({...})` em dezenas de rotas, e ali ele é
 * defensável: o alvo é VPS self-host, contêiner `next start` de vida longa, e
 * o processo não termina ao fim do request. Mas isso é propriedade do
 * AMBIENTE, não garantia do runtime. Para observação a diferença é grave: a
 * tarefa some em silêncio e o log fica vazio — indistinguível de "não havia
 * nada a relatar".
 *
 * `after()` registra a tarefa no contexto do request; o framework envia a
 * resposta e só então executa, mantendo a tarefa viva até concluir.
 * (`node_modules/next/dist/server/after/after-context.js` troca a fase do
 * work unit store para `'after'` antes de rodar.)
 *
 * ─── A armadilha do `cookies()`, e de que lado dela ficar ───────────────────
 *
 * Chamar `cookies()` DENTRO de `after()` lança `E1381`
 * (`next/dist/server/request/cookies.js`: *"used `cookies()` inside `after()`
 * … use `cookies()` outside of the callback"*). A guarda mora dentro da
 * função `cookies()`, não nos métodos do store já resolvido — então a regra
 * prática é: **resolva tudo que depende do request ANTES**, e passe o valor
 * pronto para dentro da tarefa. Um cliente Supabase criado na rota já
 * capturou o seu cookie store e pode ser usado aqui; criar um novo lá dentro,
 * não.
 *
 * ─── Fallback estreito, de propósito ────────────────────────────────────────
 *
 * Fora de escopo de request — teste unitário, worker, script — o `after()`
 * lança `E468` ("called outside a request scope"). ESSE caso, e só ele, cai
 * para execução imediata. Qualquer outra exceção é RELANÇADA: um erro de
 * configuração do Next engolido aqui viraria trabalho que nunca roda, com
 * ninguém sabendo — exatamente o defeito que este módulo existe para evitar.
 *
 * A tarefa tem catch próprio: ela é fire-and-forget nos dois caminhos, e uma
 * rejeição sem dono viraria `unhandledRejection` no processo do cliente.
 */
import { after } from "next/server";

import { logger } from "@/lib/logger";

/** O código que o Next carimba no erro de `after()` fora de escopo de request. */
const FORA_DE_ESCOPO = "E468";

function ehForaDeEscopoDeRequest(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if ((e as { __NEXT_ERROR_CODE?: unknown }).__NEXT_ERROR_CODE === FORA_DE_ESCOPO) return true;
  // A mensagem é a rede para o caso de o código deixar de ser carimbado numa
  // versão futura. Não é a sonda primária: mensagem muda, código é contrato.
  return e instanceof Error && e.message.includes("was called outside a request scope");
}

/**
 * Agenda `tarefa` para depois do envio da resposta.
 *
 * `nome` identifica a tarefa no log quando ela falha — sem ele, um erro de
 * pós-resposta chega sem dono num log compartilhado.
 *
 * Não devolve nada e não lança por causa da tarefa: quem chama está no
 * caminho crítico e não pode depender deste agendamento.
 */
export function agendarPosResposta(nome: string, tarefa: () => Promise<void>): void {
  const protegida = async (): Promise<void> => {
    try {
      await tarefa();
    } catch (e) {
      logger.error("pos_resposta.tarefa_falhou", {
        tarefa: nome,
        erro: e instanceof Error ? e.message : String(e),
      });
    }
  };

  try {
    after(protegida);
  } catch (e) {
    if (!ehForaDeEscopoDeRequest(e)) throw e;
    void protegida();
  }
}
