/**
 * A DEFINIÇÃO genérica de um playbook — o contrato versionável, sem dono.
 *
 * ─── O que isto é ───────────────────────────────────────────────────────────
 *
 * Um playbook é ESTRATÉGIA CONVERSACIONAL: etapas, objetivos, copies oficiais,
 * condições de resposta, objeções, guardrails e a intenção de follow-up. Esta
 * é a forma que uma versão publicada congela (Fase A: `ai_playbook_versions
 * .definition`), que o editor valida antes de publicar e que o import de um
 * playbook existente produz (`adaptador-afb.ts`).
 *
 * Nesta fase (A0) ela é uma representação PARALELA, provada por teste contra o
 * registry em código. Nenhuma rota, contexto ou tela a consome ainda.
 *
 * ─── O que isto NÃO é ───────────────────────────────────────────────────────
 *
 *   - Não é Knowledge: fato, política e limite recuperável por busca moram nas
 *     fontes de conhecimento. Aqui só entra o que é roteiro.
 *   - Não é Automation: nada aqui executa. `followup_intent` declara a
 *     cadência como conteúdo e intenção; quem agenda, envia ou move card é o
 *     motor de automação, por política própria.
 *   - Não carrega AUTONOMIA. Não existe `mode`, `assisted`, `automatic`,
 *     `auto_send` nem equivalente: OFF | ASSISTED | AUTOMATIC é do BINDING
 *     (funil/campanha/contexto), nunca do playbook — o mesmo playbook é
 *     assistido num funil e automático noutro sem mudar uma vírgula. Os
 *     objetos são `strict`, então uma chave dessas é recusada na validação, e
 *     o teste ao lado prova que é recusada.
 *
 * ─── IDs de etapa são ESTÁVEIS ──────────────────────────────────────────────
 *
 * `stage.id` é o que bindings, `custom_fields.etapa_playbook`, analytics,
 * histórico e automações referenciam. Ele nasce uma vez, segue
 * `STAGE_ID_REGEX`, e NÃO deriva do rótulo: `label` é livre e editável
 * ("Qualificação inicial" → "Diagnóstico inicial" muda só o `label`). Toda
 * referência interna (`transitions[].to`) aponta para um id, nunca para um
 * rótulo, e a validação recusa referência a id inexistente.
 *
 * `deprecated_stage_ids` é o contrato para a comparação entre versões (fase
 * seguinte): um id que sai da lista de etapas tem de ser declarado aqui em vez
 * de sumir em silêncio. Nesta fase o schema só garante que a lista não colide
 * com etapas ativas.
 *
 * ─── Chaves em snake_case inglês ────────────────────────────────────────────
 *
 * A definição vai virar `jsonb` e corpo de `/api/v1/`, e o contrato do repo
 * para JSON externo é snake_case (CLAUDE.md). Os identificadores TypeScript
 * seguem o resto do código, em português.
 *
 * Este módulo não importa nada de `lib/afb/` — o genérico não conhece cliente
 * nenhum. A direção é sempre AFB → abstração, e o teste do adaptador lê os
 * imports deste arquivo para garantir.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

/** Minúsculo, começa por letra, `_` como separador, 2–40 caracteres. */
export const STAGE_ID_REGEX = /^[a-z][a-z0-9_]{1,39}$/;

/** Ids de mensagem, objeção, guardrail, toque: como os de etapa, com `.` para namespace. */
export const ITEM_ID_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

const texto = z.string().min(1);
const textoOpcional = texto.optional();
const listaDeTextos = z.array(texto);

const stageId = z.string().regex(STAGE_ID_REGEX, "stage id inválido: use ^[a-z][a-z0-9_]{1,39}$");
const itemId = z.string().regex(ITEM_ID_REGEX, "id inválido: minúsculo, com _ e . como separadores");

// ─── Peças ───────────────────────────────────────────────────────────────────

/**
 * Uma copy oficial. `text` entra como quem vende escreveu — placeholders
 * (`[Nome]`) intactos. `purpose` distingue as mensagens de uma mesma etapa
 * ("primary", "bridge", "confirmation", "reminder_24h"…): vocabulário aberto,
 * porque cada estratégia nomeia os seus momentos.
 */
export const mensagemSchema = z.strictObject({
  id: itemId,
  channel: texto,
  purpose: textoOpcional,
  text: texto,
  note: textoOpcional,
  /** Acréscimos condicionais ao texto ("se a fatura não chegou, acrescente…"). */
  addenda: z.array(z.strictObject({ when: texto, text: texto })).optional(),
});
export type Mensagem = z.infer<typeof mensagemSchema>;

export const placeholderSchema = z.strictObject({
  token: texto,
  kind: texto,
  description: texto,
  /** Outro token que significa o mesmo — aponta para o canônico. */
  alias_of: textoOpcional,
});

/** Uma linha da tabela "como usar a resposta": o que o cliente disse → leitura → para onde ir. */
export const condicaoDeRespostaSchema = z.strictObject({
  customer_reply: texto,
  reading: texto,
  go_to: texto,
});

export const transicaoSchema = z.strictObject({
  to: stageId,
  /** Gatilho conversacional ("replied", "no_reply", "meeting_accepted"). Vocabulário aberto. */
  when: textoOpcional,
});

/** Como conduzir um momento presencial/síncrono (reunião): cenário → como abrir → o que não fazer. */
export const cenarioSchema = z.strictObject({
  scenario: texto,
  how_to_open: texto,
  what_not_to_do: texto,
});

// ─── Intenção de follow-up (estratégia, não execução) ────────────────────────

const faixaDeHorarioSchema = z.strictObject({
  start_min: z.number().int().min(0).max(1440),
  end_min: z.number().int().min(0).max(1440),
});

export const janelaDeContatoSchema = z.strictObject({
  ranges: z.array(faixaDeHorarioSchema),
  /** `Date#getDay()`: 0 = domingo. */
  allowed_weekdays: z.array(z.number().int().min(0).max(6)),
  discouraged: z.array(z.strictObject({ weekday: z.number().int().min(0).max(6), period: texto })),
  afternoon_starts_min: z.number().int().min(0).max(1440),
});

export const toqueSchema = z.strictObject({
  id: itemId,
  /** Dias corridos desde a âncora (D0). */
  day: z.number().int().min(0),
  label: texto,
  channel: texto,
  topic: texto,
  period: textoOpcional,
  message: mensagemSchema.optional(),
  /** Quando o toque não tem copy própria e remete a outra mensagem/roteiro. */
  refers_to: textoOpcional,
  attachment: textoOpcional,
});

/**
 * A cadência como INTENÇÃO E CONTEÚDO aprovado. Declara dias, temas, janela e
 * regras; NÃO agenda, NÃO envia. Quem executa é a automação, por política
 * própria — e é ela que decide se a cadência corre automática enquanto a
 * conversa livre segue assistida.
 */
export const followupIntentSchema = z.strictObject({
  kind: z.literal("cadence"),
  title: texto,
  objective: texto,
  cycle_days: z.number().int().min(0),
  reply_interrupts: z.boolean(),
  on_reply: textoOpcional,
  recycle_after_months: z.number().int().min(0).optional(),
  contact_window: janelaDeContatoSchema.optional(),
  touches: z.array(toqueSchema),
  rules: listaDeTextos.optional(),
  attachment_rule: textoOpcional,
});
export type FollowupIntent = z.infer<typeof followupIntentSchema>;

// ─── Etapa ───────────────────────────────────────────────────────────────────

export const etapaSchema = z.strictObject({
  /** ESTÁVEL. Ver o cabeçalho. */
  id: stageId,
  /** Editável. Nunca é referência. */
  label: texto,
  order: z.number().int().min(1),
  /** "sequence", "post_yes", "follow_up"… vocabulário aberto da estratégia. */
  kind: texto,
  objective: textoOpcional,
  instructions: listaDeTextos.optional(),
  messages: z.array(mensagemSchema).optional(),
  cta: z.strictObject({ kind: textoOpcional, text: textoOpcional }).nullable().optional(),
  wait_for_reply: z.boolean().optional(),
  wait_rule: textoOpcional,
  conditions: z.array(condicaoDeRespostaSchema).optional(),
  next_action: textoOpcional,
  /** Papéis de coluna do funil em que esta etapa pode aparecer (vocabulário do core). */
  allowed_roles: listaDeTextos.optional(),
  transitions: z.array(transicaoSchema).optional(),
  /** Ids de `guardrails[]` que a etapa invoca explicitamente. */
  guardrail_ids: z.array(itemId).optional(),
  scenarios: z.array(cenarioSchema).optional(),
  rules: listaDeTextos.optional(),
  followup_intent: followupIntentSchema.optional(),
});
export type Etapa = z.infer<typeof etapaSchema>;

// ─── Objeções, guardrails, canais, métricas ──────────────────────────────────

export const objecaoSchema = z.strictObject({
  id: itemId,
  trigger: texto,
  behind: textoOpcional,
  response: mensagemSchema,
  observation: textoOpcional,
  next_action: textoOpcional,
});

export const guardrailSchema = z.strictObject({
  id: itemId,
  category: texto,
  severity: texto,
  rule: texto,
  source: textoOpcional,
  /** Termos que, digitados, sugerem quebra da regra — para AVISAR, nunca bloquear. */
  alert_terms: listaDeTextos.optional(),
});

/** O material de um canal secundário (e-mail, telefone): roteiros, variações, regras. */
export const canalSchema = z.strictObject({
  description: textoOpcional,
  messages: z.array(mensagemSchema).optional(),
  variants: z
    .array(
      z.strictObject({
        id: itemId,
        label: texto,
        subject: textoOpcional,
        body: mensagemSchema,
        when_to_use: textoOpcional,
      }),
    )
    .optional(),
  rules: listaDeTextos.optional(),
  never_say: listaDeTextos.optional(),
  instructions: z.array(z.strictObject({ id: itemId, text: texto })).optional(),
  questions: listaDeTextos.optional(),
  signature: z.strictObject({ text: texto, note: textoOpcional }).optional(),
});

export const metricaSchema = z.strictObject({
  indicator: texto,
  how_to_measure: texto,
  when_low: textoOpcional,
});

// ─── Meta ────────────────────────────────────────────────────────────────────

export const metaSchema = z.strictObject({
  /** O objetivo único da estratégia — o CTA do playbook inteiro. */
  objective: textoOpcional,
  posture: textoOpcional,
  unbreakable_rule: textoOpcional,
  cycle_days: z.number().int().min(0).optional(),
  /**
   * Números de referência que as copies citam (faixas históricas, prazos). São
   * dado do roteiro, com o valor como quem vende escreveu — a regra de que
   * referência não é promessa mora nos princípios e nos guardrails.
   */
  figures: z.array(z.strictObject({ id: itemId, value: texto, note: textoOpcional })).optional(),
  region: z.strictObject({ name: texto, note: textoOpcional }).optional(),
  principles: z.array(z.strictObject({ order: z.number().int().min(1), title: texto, detail: textoOpcional })).optional(),
  placeholders: z.array(placeholderSchema).optional(),
  /** De onde esta definição veio (documento, registry, versão do documento). */
  source: z
    .strictObject({
      registry_id: textoOpcional,
      name: textoOpcional,
      document_version: textoOpcional,
      reference: textoOpcional,
    })
    .optional(),
});

// ─── A definição ─────────────────────────────────────────────────────────────

const definicaoBase = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  meta: metaSchema,
  stages: z.array(etapaSchema).min(1),
  objections: z.array(objecaoSchema).optional(),
  /**
   * Regras TRANSVERSAIS ao tratamento de qualquer objeção ("reconhecer →
   * reenquadrar → devolver o convite"). Não são guardrails (não proíbem),
   * não são princípios (são operacionais da biblioteca) e não pertencem a
   * uma objeção específica — por isso têm campo próprio.
   */
  objection_rules: listaDeTextos.optional(),
  guardrails: z.array(guardrailSchema).optional(),
  channels: z.record(texto, canalSchema).optional(),
  metrics: z.strictObject({ indicators: z.array(metricaSchema), notes: listaDeTextos.optional() }).optional(),
  backlog: listaDeTextos.optional(),
  deprecated_stage_ids: z.array(stageId).optional(),
});

/** Todas as mensagens da definição, para as checagens de unicidade e para varreduras. */
export function todasAsMensagensDaDefinicao(d: z.infer<typeof definicaoBase>): Mensagem[] {
  const saida: Mensagem[] = [];
  for (const s of d.stages) {
    saida.push(...(s.messages ?? []));
    for (const t of s.followup_intent?.touches ?? []) if (t.message) saida.push(t.message);
  }
  for (const o of d.objections ?? []) saida.push(o.response);
  for (const c of Object.values(d.channels ?? {})) {
    saida.push(...(c.messages ?? []));
    for (const v of c.variants ?? []) saida.push(v.body);
  }
  return saida;
}

function duplicados(valores: readonly string[]): string[] {
  const vistos = new Set<string>();
  const dup = new Set<string>();
  for (const v of valores) (vistos.has(v) ? dup : vistos).add(v);
  return [...dup];
}

export const definicaoDePlaybookSchema = definicaoBase.superRefine((d, ctx) => {
  const ids = d.stages.map((s) => s.id);
  for (const id of duplicados(ids)) {
    ctx.addIssue({ code: "custom", path: ["stages"], message: `stage id duplicado: ${id}` });
  }
  for (const o of duplicados(d.stages.map((s) => String(s.order)))) {
    ctx.addIssue({ code: "custom", path: ["stages"], message: `order duplicada: ${o}` });
  }

  const ativos = new Set(ids);
  for (const dep of d.deprecated_stage_ids ?? []) {
    if (ativos.has(dep)) {
      ctx.addIssue({ code: "custom", path: ["deprecated_stage_ids"], message: `${dep} está ativo e deprecado ao mesmo tempo` });
    }
  }

  const guardrailIds = new Set((d.guardrails ?? []).map((g) => g.id));
  for (const id of duplicados((d.guardrails ?? []).map((g) => g.id))) {
    ctx.addIssue({ code: "custom", path: ["guardrails"], message: `guardrail id duplicado: ${id}` });
  }
  for (const id of duplicados((d.objections ?? []).map((o) => o.id))) {
    ctx.addIssue({ code: "custom", path: ["objections"], message: `objection id duplicado: ${id}` });
  }

  d.stages.forEach((s, i) => {
    for (const t of s.transitions ?? []) {
      if (!ativos.has(t.to)) {
        ctx.addIssue({ code: "custom", path: ["stages", i, "transitions"], message: `transição para etapa inexistente: ${t.to}` });
      }
    }
    for (const g of s.guardrail_ids ?? []) {
      if (!guardrailIds.has(g)) {
        ctx.addIssue({ code: "custom", path: ["stages", i, "guardrail_ids"], message: `guardrail inexistente: ${g}` });
      }
    }
  });

  for (const id of duplicados(todasAsMensagensDaDefinicao(d).map((m) => m.id))) {
    ctx.addIssue({ code: "custom", path: ["stages"], message: `message id duplicado: ${id}` });
  }

  const tokens = (d.meta.placeholders ?? []).map((p) => p.token);
  for (const t of duplicados(tokens)) {
    ctx.addIssue({ code: "custom", path: ["meta", "placeholders"], message: `placeholder duplicado: ${t}` });
  }
  const tokenSet = new Set(tokens);
  for (const p of d.meta.placeholders ?? []) {
    if (p.alias_of !== undefined && !tokenSet.has(p.alias_of)) {
      ctx.addIssue({ code: "custom", path: ["meta", "placeholders"], message: `alias_of aponta para token inexistente: ${p.alias_of}` });
    }
  }
});

export type DefinicaoDePlaybook = z.infer<typeof definicaoDePlaybookSchema>;

export type ResultadoDaValidacao =
  | { ok: true; definicao: DefinicaoDePlaybook }
  | { ok: false; erros: Array<{ path: string; message: string }> };

/** Valida sem lançar — quem chama está numa rota ou num editor e precisa mostrar o erro. */
export function validarDefinicao(valor: unknown): ResultadoDaValidacao {
  const r = definicaoDePlaybookSchema.safeParse(valor);
  if (r.success) return { ok: true, definicao: r.data };
  return {
    ok: false,
    erros: r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  };
}

/** As etapas na ordem declarada por `order` — nunca a ordem do array. */
export function etapasOrdenadas(d: DefinicaoDePlaybook): Etapa[] {
  return d.stages.slice().sort((a, b) => a.order - b.order);
}

export function etapaPorId(d: DefinicaoDePlaybook, id: string): Etapa | null {
  return d.stages.find((s) => s.id === id) ?? null;
}
