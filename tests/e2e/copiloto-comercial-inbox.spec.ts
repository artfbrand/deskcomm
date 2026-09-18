/**
 * O shell do Copiloto Comercial no inbox — as abas da terceira coluna.
 *
 * O que este spec prova, pela tela:
 *
 *   1. Com uma conversa aberta no desktop (≥ 1280px), a terceira coluna tem
 *      DUAS abas com semântica de abas, e a aba «Contato» mostra a ficha de
 *      sempre (as seções do CRMSidePanel). A aba INICIAL segue o estado: módulo
 *      desligado abre em Contato; qualquer outro estado abre em Copiloto.
 *   2. O painel do copiloto mostra UM estado declarado (`data-estado`), e no
 *      funil semeado — que não tem o módulo ligado — esse estado é uma
 *      orientação ao administrador, nunca um painel em branco nem JSON.
 *   3. No celular, a mesma «Ficha» abre as mesmas duas abas.
 *
 * Não liga o módulo nem escolhe playbook: esse caminho é da tela de funis
 * (`copiloto-comercial-por-funil.spec.ts`), e o estado `copilot_disabled` é o
 * que qualquer instalação fresca mostra — é a primeira impressão real.
 *
 * Pré-requisito: seed de credenciais + uma conversa acessível ao manager. O
 * spec pega a primeira da lista; se a instalação não tiver conversa nenhuma,
 * ele declara e pula em vez de fingir.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence");
const creds = lerCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

async function abrirPrimeiraConversa(page: Page): Promise<boolean> {
  await page.goto("/app/inbox?filter=all");
  await page.waitForLoadState("networkidle");
  const item = page.getByTestId("inbox-item").first();
  if ((await item.count()) === 0) return false;
  await item.click();
  // A conversa abriu quando o cabeçalho dela existe — vale para desktop e celular.
  await expect(page.getByTestId("comando-da-conversa").first()).toBeVisible();
  return true;
}

test.beforeAll(() => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
});

test("desktop: terceira coluna com abas Copiloto/Contato, Copiloto selecionada, estado declarado", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, creds.users.manager!.email);
  test.skip(!(await abrirPrimeiraConversa(page)), "instalação sem conversa acessível — nada a medir");

  const painel = page.getByTestId("painel-lateral-do-inbox").first();
  const abas = painel.getByRole("tab");
  await expect(abas).toHaveCount(2);
  await expect(abas.nth(0)).toHaveText("Copiloto");
  await expect(abas.nth(1)).toHaveText("Contato");
  const abaInicial = await painel.getByTestId("aba-copiloto").getAttribute("aria-selected");

  // Um estado declarado, nunca JSON nem id técnico na tela.
  if (abaInicial !== "true") await painel.getByTestId("aba-copiloto").click();
  const estado = painel.getByTestId("copiloto-estado");
  await expect(estado).toBeVisible();
  const valor = await estado.getAttribute("data-estado");
  expect(valor, "o painel declara em que estado está").toBeTruthy();
  expect(valor).not.toBe("loading");
  // A regra da aba inicial: só `copilot_disabled` abre em Contato.
  expect(abaInicial === "true", `estado ${valor} → aba inicial`).toBe(valor !== "copilot_disabled");
  await expect(estado).not.toContainText(/[{}]/);
  await expect(estado).not.toContainText(/afb_comercial_v1/);
  await page.screenshot({ path: path.join(EVIDENCIA, "copiloto-inbox-01-aba-copiloto.png"), fullPage: true });

  // A aba Contato é a ficha de sempre.
  await painel.getByTestId("aba-contato").click();
  await expect(painel.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
  await expect(painel.getByTestId("inbox-demandas")).toBeVisible();
  await expect(painel.getByTestId("inbox-campos-lead")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "copiloto-inbox-02-aba-contato.png"), fullPage: true });

  // Largura medida por ferramenta: o painel cabe na viewport (não é uma quarta coluna).
  const caixa = await painel.boundingBox();
  expect(caixa).not.toBeNull();
  expect(caixa!.x + caixa!.width, "o painel termina dentro da viewport").toBeLessThanOrEqual(1440 + 1);
});

test("celular: a Ficha abre as mesmas duas abas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, creds.users.manager!.email);
  test.skip(!(await abrirPrimeiraConversa(page)), "instalação sem conversa acessível — nada a medir");

  await page.getByRole("button", { name: /ficha/i }).click();
  const ficha = page.getByRole("dialog");
  await expect(ficha).toBeVisible();
  await expect(ficha.getByRole("tab")).toHaveCount(2);
  await ficha.getByTestId("aba-copiloto").click();
  await expect(ficha.getByTestId("copiloto-estado")).toBeVisible();
  await ficha.getByTestId("aba-contato").click();
  await expect(ficha.getByTestId("inbox-demandas")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "copiloto-inbox-03-ficha-celular.png"), fullPage: true });
});
