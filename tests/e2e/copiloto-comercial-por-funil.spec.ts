/**
 * O interruptor "Copiloto comercial" da tela de funis — a flag por funil que o
 * inbox vai ler (`crm_pipelines.settings.modulos.copiloto_comercial.enabled`).
 *
 * O que este spec prova, e por que cada metade importa:
 *
 *   1. LIGAR e DESLIGAR persistem — provado por RECARREGAR a página, não pelo
 *      toast. O toast diz que a action respondeu `ok`; só o reload diz que o
 *      jsonb foi gravado e que o estado inicial do `useState` lê a chave certa.
 *      Os dois sentidos entram porque um merge que só ADICIONA passaria no
 *      "ligar" e falharia em silêncio no "desligar".
 *
 *   2. Quem NÃO pode editar configuração não vê o interruptor — o `manager`
 *      abre a tela (é o piso dela) mas o `PipelineEditor` inteiro só nasce com
 *      `podeEditarConfig`. Nenhuma regra nova de autorização: é a existente,
 *      medida pela tela.
 *
 * Idempotente: termina com o interruptor DESLIGADO, que é o estado de um funil
 * recém-criado, para a próxima rodada (e os outros specs) encontrarem o mesmo
 * chão. Se o banco estiver sujo com a flag ligada, o fluxo força "ligado" antes
 * de medir — não depende do ponto de partida.
 *
 * Pré-requisito: seed de credenciais (rodado aqui se faltar).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence");
const TELA = "/app/settings/tenant/pipelines";

let creds = lerCreds();

async function loginSimples(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

/** O primeiro funil com editor na tela — o bloco inteiro, para o botão Salvar ser o DELE. */
function editorDoPrimeiroFunil(page: Page) {
  return page.locator('[data-testid^="funil-config-"]').first();
}

async function salvarERecarregar(page: Page): Promise<void> {
  const editor = editorDoPrimeiroFunil(page);
  await editor.getByRole("button", { name: /salvar vocabulário e campos/i }).click();
  await expect(page.getByText(/atualizado\./)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await page.waitForLoadState("networkidle");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
});

test("admin liga, salva, recarrega, continua ligado; desliga, salva, recarrega, continua desligado", async ({
  page,
}) => {
  test.setTimeout(120_000);
  creds = await loginComoAdmin(page, creds);
  await page.goto(TELA);
  await page.waitForLoadState("networkidle");

  const editor = editorDoPrimeiroFunil(page);
  await expect(editor, "o admin precisa ver o editor de configuração do funil").toBeVisible();
  const interruptor = editor.getByTestId("copiloto-comercial-liga");
  await expect(interruptor).toBeVisible();
  await expect(interruptor).toHaveAttribute("role", "switch");

  // ── LIGAR ──────────────────────────────────────────────────────────────────
  if (!(await interruptor.isChecked())) await interruptor.click();
  await expect(interruptor).toBeChecked();
  await salvarERecarregar(page);
  await expect(
    editorDoPrimeiroFunil(page).getByTestId("copiloto-comercial-liga"),
    "depois de recarregar, o interruptor lê `enabled: true` do funil",
  ).toBeChecked();
  await page.screenshot({
    path: path.join(EVIDENCIA, "copiloto-por-funil-01-ligado-apos-reload.png"),
    fullPage: true,
  });

  // ── DESLIGAR ───────────────────────────────────────────────────────────────
  await editorDoPrimeiroFunil(page).getByTestId("copiloto-comercial-liga").click();
  await expect(editorDoPrimeiroFunil(page).getByTestId("copiloto-comercial-liga")).not.toBeChecked();
  await salvarERecarregar(page);
  await expect(
    editorDoPrimeiroFunil(page).getByTestId("copiloto-comercial-liga"),
    "depois de recarregar, o interruptor lê `enabled: false` — o merge substitui, não só adiciona",
  ).not.toBeChecked();
  await page.screenshot({
    path: path.join(EVIDENCIA, "copiloto-por-funil-02-desligado-apos-reload.png"),
    fullPage: true,
  });
});

test("manager abre a tela de funis mas não vê o interruptor nem o editor", async ({ page }) => {
  await loginSimples(page, creds.users.manager!.email);
  await page.goto(TELA);
  await page.waitForLoadState("networkidle");

  // A tela abriu (manager é o piso dela) — sem isto o "não vê" abaixo provaria
  // um 403, não a autorização do editor.
  await expect(page.getByRole("heading", { name: /etapas do funil/i })).toBeVisible();
  await expect(page.locator('[data-testid^="etapa-"]').first()).toBeVisible();

  await expect(page.getByTestId("copiloto-comercial-liga")).toHaveCount(0);
  await expect(page.locator('[data-testid^="funil-config-"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /salvar vocabulário e campos/i })).toHaveCount(0);
  await page.screenshot({
    path: path.join(EVIDENCIA, "copiloto-por-funil-03-manager-sem-editor.png"),
    fullPage: true,
  });
});
