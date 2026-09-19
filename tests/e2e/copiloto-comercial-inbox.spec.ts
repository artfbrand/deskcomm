/**
 * O shell do Copiloto Comercial no inbox — as abas da terceira coluna, com
 * fixture PRÓPRIA (o mesmo padrão de `encerramento-atendimento` e
 * `central-avisos-destino`): organização, usuário, funil, etapa, contato,
 * conversa e oportunidade criados pelo spec com a service role, e apagados no
 * `finally`. Nada aqui depende do seed ter conversa, da ordem da lista ou do
 * que outro spec deixou.
 *
 * O que se prova, pela tela e com o usuário autenticado normalmente:
 *
 *   DESKTOP (1440px) — funil COM o copiloto ligado e a coluna mapeada:
 *     a terceira coluna tem duas abas com semântica de abas; abre em Copiloto
 *     (o contexto real é `active`); o painel mostra etapa, momento comercial
 *     e a oportunidade criada, sem id técnico; a aba Contato mostra a ficha
 *     de sempre; a coluna cabe na viewport (não é uma quarta coluna).
 *
 *   DESKTOP — funil SEM o módulo: abre em Contato (regra da aba inicial), e
 *     a aba Copiloto declara `copilot_disabled` com orientação, sem JSON.
 *
 *   CELULAR (390px) — a mesma Ficha abre as duas abas, e dá para alternar.
 *
 * A service role só PREPARA e LIMPA; a aplicação é usada logada, pela RLS.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credentials = credenciaisSupabaseDeTeste();
const db = createClient(credentials.url, credentials.serviceRole, { auth: { persistSession: false } });
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence");

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(table).insert(values).select("id").single();
  if (error) throw error;
  return data.id as string;
}

interface Fixture {
  org: string;
  user: string;
  email: string;
  password: string;
  contact: string;
  conversation: string;
  lead: string;
  stage: string;
}

/**
 * Uma organização inteira, do zero. `copiloto: true` liga o módulo no funil,
 * escolhe o `afb_comercial_v1` e mapeia a coluna do lead como «conversa» —
 * é o que a tela de funis gravaria; aqui vai direto no jsonb porque é
 * preparo de fixture, não o caminho do produto.
 */
async function fixture(opts: { copiloto: boolean }): Promise<Fixture> {
  const n = randomUUID().slice(0, 8);
  const email = `copiloto-${n}@invariant.test`;
  const password = `Local-${randomUUID()}!`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error;
  const user = created.data.user.id;
  const org = await insert("organizations", {
    slug: `copiloto-${n}`,
    display_name: `Copiloto ${n}`,
    legal_name: `Copiloto ${n}`,
    onboarded_at: new Date().toISOString(),
  });
  const membership = await db.from("user_organizations").insert({
    organization_id: org,
    user_id: user,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (membership.error) throw membership.error;

  // O funil e a coluna PRIMEIRO: o mapa do copiloto é por id de coluna.
  const pipeline = await insert("crm_pipelines", {
    organization_id: org,
    name: "Funil copiloto",
    slug: `copiloto-${n}`,
  });
  const stage = await insert("crm_stages", {
    organization_id: org,
    pipeline_id: pipeline,
    name: "Contato Feito",
    slug: "contato_feito",
    position: 1000,
  });
  if (opts.copiloto) {
    const cfg = await db
      .from("crm_pipelines")
      .update({
        settings: {
          fields: [],
          modulos: { copiloto_comercial: { enabled: true, playbook_id: "afb_comercial_v1", etapas: { [stage]: "conversa" } } },
        },
      })
      .eq("id", pipeline)
      .eq("organization_id", org);
    if (cfg.error) throw cfg.error;
  }

  const contact = await insert("contacts", {
    organization_id: org,
    display_name: "Carlos Copiloto",
    phone_number: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
  });
  const session = await insert("channel_sessions", {
    organization_id: org,
    waha_session_name: `copiloto-${randomUUID()}`,
    display_name: "Canal copiloto",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  const conversation = await insert("conversations", {
    organization_id: org,
    contact_id: contact,
    channel_session_id: session,
    status: "open",
  });
  const sentAt = new Date().toISOString();
  await insert("messages", {
    organization_id: org,
    contact_id: contact,
    conversation_id: conversation,
    channel_session_id: session,
    direction: "inbound",
    type: "text",
    status: "received",
    body: "Quero entender a conta de energia",
    sent_at: sentAt,
  });
  const lead = await insert("crm_leads", {
    organization_id: org,
    pipeline_id: pipeline,
    stage_id: stage,
    contact_id: contact,
    title: "Carlos — Metalúrgica Copiloto",
    owner_user_id: user,
    last_activity_at: sentAt,
    custom_fields: { etapa_playbook: "gancho_de_valor", perfil_interlocutor: "decisor" },
  });
  return { org, user, email, password, contact, conversation, lead, stage };
}

async function limpar(f: Fixture | null): Promise<void> {
  if (!f) return;
  await db.from("organizations").delete().eq("id", f.org);
  await db.auth.admin.deleteUser(f.user);
}

async function login(page: Page, f: Fixture): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(f.email);
  await page.locator("#password").fill(f.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

test.beforeAll(() => {
  mkdirSync(EVIDENCIA, { recursive: true });
});

test("desktop, copiloto ligado: abre em Copiloto com o contexto ativo; Contato é a ficha; a coluna cabe", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let f: Fixture | null = null;
  try {
    f = await fixture({ copiloto: true });
    await login(page, f);
    await page.goto(`/app/inbox/${f.conversation}`);

    const painel = page.getByTestId("painel-lateral-do-inbox").first();
    await expect(painel).toBeVisible();
    const abas = painel.getByRole("tab");
    await expect(abas).toHaveCount(2);
    await expect(abas.nth(0)).toHaveText("Copiloto");
    await expect(abas.nth(1)).toHaveText("Contato");
    await expect(painel.getByRole("tablist")).toHaveAttribute("aria-label", "Painel da conversa");

    // Módulo ligado + coluna mapeada + lead com etapa gravada → active, e a aba inicial é Copiloto.
    await expect(painel.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
    const estado = painel.getByTestId("copiloto-estado");
    await expect(estado).toHaveAttribute("data-estado", "active");
    await expect(estado).toHaveAttribute("data-etapa-playbook", "gancho_de_valor");
    await expect(painel.getByTestId("copiloto-etapa")).toHaveText("Gancho de valor");
    await expect(painel.getByTestId("copiloto-papel")).toHaveText("Conversa em andamento");
    await expect(painel.getByTestId("copiloto-perfil")).toHaveText("decisor");
    await expect(painel.getByTestId("copiloto-lead")).toHaveText("Carlos — Metalúrgica Copiloto");
    await expect(painel.getByTestId("copiloto-playbook")).toContainText("Playbook Comercial");
    // Nada de JSON, id de lead ou id do playbook como texto.
    await expect(estado).not.toContainText(/[{}]/);
    await expect(estado).not.toContainText(new RegExp(`${f.lead}|afb_comercial_v1`));
    // Nesta fase: nenhum botão de ação no painel do copiloto.
    await expect(painel.getByTestId("painel-copiloto").getByRole("button")).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "copiloto-inbox-01-ativo-desktop.png"), fullPage: true });

    // A aba Contato é a ficha de sempre, com o negócio criado.
    await painel.getByTestId("aba-contato").click();
    await expect(painel.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
    await expect(painel.getByTestId("inbox-demandas")).toBeVisible();
    await expect(painel.getByTestId("inbox-campos-lead")).toBeVisible();
    await expect(painel.getByTestId("inbox-campos-lead")).toContainText("Carlos — Metalúrgica Copiloto");
    await page.screenshot({ path: path.join(EVIDENCIA, "copiloto-inbox-02-contato-desktop.png"), fullPage: true });

    // Medido por ferramenta: a terceira coluna termina dentro da viewport e
    // continua com a largura de sempre (não é uma quarta coluna).
    const caixa = await painel.boundingBox();
    expect(caixa).not.toBeNull();
    expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(1440 + 1);
    expect(caixa!.width).toBeGreaterThanOrEqual(280);
    expect(caixa!.width).toBeLessThanOrEqual(340);
  } finally {
    await context.close().catch(() => undefined);
    await limpar(f);
  }
});

test("desktop, copiloto desligado: abre em Contato; a aba Copiloto declara o estado com orientação", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let f: Fixture | null = null;
  try {
    f = await fixture({ copiloto: false });
    await login(page, f);
    await page.goto(`/app/inbox/${f.conversation}`);

    const painel = page.getByTestId("painel-lateral-do-inbox").first();
    await expect(painel.getByRole("tab")).toHaveCount(2);
    // A regra da aba inicial: só `copilot_disabled` abre em Contato.
    await expect(painel.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
    await expect(painel.getByTestId("inbox-demandas")).toBeVisible();

    await painel.getByTestId("aba-copiloto").click();
    const estado = painel.getByTestId("copiloto-estado");
    await expect(estado).toHaveAttribute("data-estado", "copilot_disabled");
    await expect(estado).toContainText("desligado neste funil");
    await expect(estado).toContainText("Configurações › Funis");
    await expect(estado).not.toContainText(/[{}]/);
    await page.screenshot({ path: path.join(EVIDENCIA, "copiloto-inbox-03-desligado-desktop.png"), fullPage: true });
  } finally {
    await context.close().catch(() => undefined);
    await limpar(f);
  }
});

test("celular: a Ficha abre as duas abas e alterna entre elas", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let f: Fixture | null = null;
  try {
    f = await fixture({ copiloto: true });
    await login(page, f);
    await page.goto(`/app/inbox/${f.conversation}`);
    await expect(page.getByTestId("comando-da-conversa").first()).toBeVisible();

    await page.getByRole("button", { name: /ficha/i }).click();
    const ficha = page.getByRole("dialog");
    await expect(ficha).toBeVisible();
    await expect(ficha.getByRole("tab")).toHaveCount(2);
    await expect(ficha.getByTestId("aba-copiloto")).toHaveAttribute("aria-selected", "true");
    await expect(ficha.getByTestId("copiloto-estado")).toHaveAttribute("data-estado", "active");
    await expect(ficha.getByTestId("copiloto-etapa")).toHaveText("Gancho de valor");

    await ficha.getByTestId("aba-contato").click();
    await expect(ficha.getByTestId("aba-contato")).toHaveAttribute("aria-selected", "true");
    await expect(ficha.getByTestId("inbox-demandas")).toBeVisible();
    await ficha.getByTestId("aba-copiloto").click();
    await expect(ficha.getByTestId("copiloto-estado")).toHaveAttribute("data-estado", "active");
    // A ficha cabe no celular.
    const caixa = await ficha.boundingBox();
    expect(caixa).not.toBeNull();
    expect(caixa!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(EVIDENCIA, "copiloto-inbox-04-ficha-celular.png"), fullPage: true });
  } finally {
    await context.close().catch(() => undefined);
    await limpar(f);
  }
});
