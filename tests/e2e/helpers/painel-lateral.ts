/**
 * A terceira coluna do inbox tem abas (Copiloto / Contato). A ficha do
 * contato — demandas, memória, negócios, «Marcar compromisso», «Ver contato»
 * — é a aba «Contato», e a aba inicial depende do funil: com o copiloto
 * desligado (toda instalação fresca) já abre em Contato; com ele ligado abre
 * em Copiloto. Por isso o helper CONFERE antes de clicar, e vale nos dois
 * casos. A aba reinicia a cada navegação/troca de conversa: chame de novo
 * depois de `goto`/`reload`/clique em outra conversa.
 */
import type { Page } from "@playwright/test";

export async function abrirAbaContato(page: Page): Promise<void> {
  const aba = page.getByTestId("aba-contato").first();
  await aba.waitFor({ state: "visible" });
  if ((await aba.getAttribute("aria-selected")) !== "true") await aba.click();
}
