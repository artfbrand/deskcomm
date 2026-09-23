/**
 * Do registry em código para a definição genérica — o import do `afb_comercial_v1`.
 *
 * ─── Papel deste arquivo ────────────────────────────────────────────────────
 *
 * É a ÚNICA ponte entre `lib/afb/` e `lib/playbooks/`, e a direção é fixa:
 * AFB → abstração. `definicao.ts` não sabe que a AFB existe; este arquivo sabe
 * as duas formas e traduz uma na outra sem perder nada — o teste ao lado
 * prova, campo a campo, que registry ≡ definição.
 *
 * Nesta fase (A0) o registry continua sendo a fonte operacional. A definição
 * produzida aqui não é lida por rota, contexto nem tela: existe em paralelo,
 * sob teste, para a fase seguinte importá-la como a primeira versão persistida
 * e comparar (`divergenciasEntreRegistryEDefinicao`) o que foi gravado com o
 * que o código diz.
 *
 * ─── Determinismo ───────────────────────────────────────────────────────────
 *
 * Mesma entrada ⇒ mesma definição ⇒ mesmo SHA-256. Nada aqui lê relógio,
 * ambiente, rede ou banco; não há UUID; toda lista sai na ordem em que o
 * registry a declara (etapas pela régua `ETAPAS_ESTRUTURAIS`, papéis pela
 * ordem de `PAPEIS_DE_ETAPA`). Chaves opcionais ausentes são OMITIDAS, não
 * gravadas como `undefined` — a definição é JSON limpo, do jeito que vai para
 * um `jsonb`.
 *
 * O hash é `canonicalHash` (`lib/agent-engine/agent/tool-breaker.ts`): sha256
 * do JSON com chaves ordenadas recursivamente. Reutilizado em vez de
 * duplicado porque é o único utilitário exportado de hash canônico no repo, e
 * o módulo dele só tem `node:crypto` em tempo de execução (o resto é `import
 * type`). Se um dia ele for promovido a `lib/crypto/`, este import muda de
 * caminho e nada mais.
 *
 * ─── O que é derivado, e de onde ────────────────────────────────────────────
 *
 * Quase tudo é cópia direta. Três coisas são DERIVADAS de estrutura que o
 * registry tem em outro lugar, nunca inventadas:
 *
 *   - `allowed_roles` de cada etapa: os papéis de coluna (`papeis.ts`) que a
 *     listam em `etapas`; para `follow_up`, os que têm `followUpPermitido`.
 *   - `transitions`: a régua (`etapas.ts`) — cada etapa da sequência vai à
 *     seguinte quando o cliente responde, a última vai ao pós-sim, e toda
 *     etapa da sequência vai ao follow-up quando ele silencia (é o que o
 *     próprio objetivo da cadência declara). O retorno do follow-up "às Etapas
 *     2 a 6" não vira transição: o destino depende de onde a pessoa parou, e
 *     isso o registry só diz em prosa (`on_reply`).
 *   - `figures`: a `faixaOficial` do meta, como o documento a escreve.
 *
 * ─── Sobre a faixa "10% a 35%" ──────────────────────────────────────────────
 *
 * As copies deste playbook citam 10% a 35%; o Knowledge de Mercado Livre cita
 * 10% a 30%. Decisão comercial registrada em 2026-09-22: são ESCOPOS
 * DISTINTOS e a coexistência é intencional — 10–30% é a referência específica
 * de contratação de energia (Mercado Livre); 10–35% é a referência histórica
 * ampla da consultoria. Nenhuma das duas é promessa nem garantia, e em
 * contexto ambíguo a orientação é não citar percentual. O adaptador copia o
 * valor como está no playbook; não corrige, não anota, não julga.
 */
import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";
import { ETAPAS_ESTRUTURAIS, SEQUENCIA_IDS, type EtapaId } from "@/lib/afb/playbook/etapas";
import { PAPEIS_DE_ETAPA } from "@/lib/afb/playbook/papeis";
import { todasAsMensagens } from "@/lib/afb/playbooks/registry";
import type {
  Cadencia,
  EtapaPosSim,
  EtapaWhatsapp,
  Mensagem as MensagemDoRegistry,
  Playbook,
} from "@/lib/afb/playbooks/types";

import {
  definicaoDePlaybookSchema,
  SCHEMA_VERSION,
  todasAsMensagensDaDefinicao,
  type DefinicaoDePlaybook,
  type Etapa,
  type FollowupIntent,
  type Mensagem,
} from "./definicao";

/** O registry não tem conteúdo para uma etapa que a régua declara: a definição seria incompleta. */
export class ErroDeAdaptacao extends Error {
  constructor(readonly etapa: EtapaId, detalhe: string) {
    super(`adaptador-afb: ${detalhe} (${etapa})`);
    this.name = "ErroDeAdaptacao";
  }
}

// ─── Utilitários puros ───────────────────────────────────────────────────────

/** Só as chaves com valor: `undefined` nunca entra na definição. */
function semIndefinidos<T extends Record<string, unknown>>(obj: T): T {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) saida[k] = v;
  return saida as T;
}

function mensagem(m: MensagemDoRegistry, purpose?: string, extras?: Partial<Mensagem>): Mensagem {
  return semIndefinidos({
    id: m.id,
    channel: m.canal,
    purpose,
    text: m.texto,
    note: m.nota,
    ...extras,
  });
}

function papeisQueAbrigam(id: EtapaId): string[] {
  if (id === "follow_up") return PAPEIS_DE_ETAPA.filter((p) => p.followUpPermitido).map((p) => p.id);
  return PAPEIS_DE_ETAPA.filter((p) => p.etapas.includes(id)).map((p) => p.id);
}

function transicoesDaSequencia(id: EtapaId): Etapa["transitions"] {
  const i = SEQUENCIA_IDS.indexOf(id);
  const proxima = SEQUENCIA_IDS[i + 1];
  const saida: NonNullable<Etapa["transitions"]> = [];
  if (proxima) saida.push({ to: proxima, when: "replied" });
  else saida.push({ to: "pos_sim", when: "meeting_accepted" });
  saida.push({ to: "follow_up", when: "no_reply" });
  return saida;
}

// ─── Etapas ──────────────────────────────────────────────────────────────────

function etapaDaSequencia(e: EtapaWhatsapp): Etapa {
  const messages: Mensagem[] = [mensagem(e.mensagem, "primary")];
  if (e.ponte) messages.push(mensagem(e.ponte, "bridge"));
  return semIndefinidos({
    id: e.id,
    label: e.titulo,
    order: e.ordem,
    kind: "sequence",
    objective: e.objetivo,
    instructions: [...e.instrucoes],
    messages,
    wait_for_reply: e.aguardarResposta,
    wait_rule: e.regraDeEspera,
    conditions: e.condicoes?.map((c) => ({
      customer_reply: c.respostaDoCliente,
      reading: c.leitura,
      go_to: c.paraOndeIr,
    })),
    next_action: e.proximaAcao,
    allowed_roles: papeisQueAbrigam(e.id),
    transitions: transicoesDaSequencia(e.id),
    guardrail_ids: [...e.guardrails],
  });
}

function etapaPosSim(p: EtapaPosSim): Etapa {
  return {
    id: p.id,
    label: p.titulo,
    order: p.ordem,
    kind: "post_yes",
    objective: p.objetivo,
    messages: [
      mensagem(p.confirmacao, "confirmation"),
      mensagem(p.lembrete24h, "reminder_24h", {
        addenda: [{ when: "invoice_not_received", text: p.lembreteSemFatura }],
      }),
      mensagem(p.aberturaComFatura, "meeting_opening"),
    ],
    scenarios: p.conducaoDaReuniao.map((c) => ({
      scenario: c.cenario,
      how_to_open: c.comoAbrir,
      what_not_to_do: c.oQueNaoFazer,
    })),
    rules: [...p.regras],
    allowed_roles: papeisQueAbrigam(p.id),
  };
}

function intencaoDeFollowup(c: Cadencia): FollowupIntent {
  return {
    kind: "cadence",
    title: c.titulo,
    objective: c.objetivo,
    cycle_days: c.cicloDias,
    reply_interrupts: c.respostaInterrompe,
    on_reply: c.aoResponder,
    recycle_after_months: c.reciclagemMeses,
    contact_window: {
      ranges: c.janela.faixas.map((f) => ({ start_min: f.inicioMin, end_min: f.fimMin })),
      allowed_weekdays: [...c.janela.diasPermitidos],
      discouraged: c.janela.desaconselhados.map((d) => ({ weekday: d.diaDaSemana, period: d.periodo })),
      afternoon_starts_min: c.janela.inicioDaTardeMin,
    },
    touches: c.toques.map((t) =>
      semIndefinidos({
        id: t.id,
        day: t.dia,
        label: t.rotulo,
        channel: t.canal,
        topic: t.tema,
        period: t.periodo,
        message: t.mensagem ? mensagem(t.mensagem) : undefined,
        refers_to: t.remeteA,
        attachment: t.anexo,
      }),
    ),
    rules: [...c.regras],
    attachment_rule: c.regraDosCases,
  };
}

function etapaDeFollowup(c: Cadencia, ordem: number): Etapa {
  return {
    id: "follow_up",
    label: c.titulo,
    order: ordem,
    kind: "follow_up",
    objective: c.objetivo,
    allowed_roles: papeisQueAbrigam("follow_up"),
    followup_intent: intencaoDeFollowup(c),
  };
}

// ─── A tradução ──────────────────────────────────────────────────────────────

export interface DefinicaoAdaptada {
  definition: DefinicaoDePlaybook;
  /** sha256 hex do JSON canônico da definição. */
  sha256: string;
}

/**
 * Traduz um playbook do registry para a definição genérica e devolve o hash.
 *
 * Lança `ErroDeAdaptacao` quando a régua declara uma etapa da sequência para a
 * qual o registry não tem conteúdo — melhor recusar do que exportar uma
 * estratégia com buraco. Lança `ZodError` se a tradução violar o próprio
 * schema, o que seria defeito deste arquivo, não do playbook.
 */
export function deRegistryParaDefinicao(playbook: Playbook): DefinicaoAdaptada {
  const stages: Etapa[] = ETAPAS_ESTRUTURAIS.map((estrutural) => {
    switch (estrutural.tipo) {
      case "sequencia": {
        const e = playbook.whatsapp.etapas.find((x) => x.id === estrutural.id);
        if (!e) throw new ErroDeAdaptacao(estrutural.id, "a régua declara a etapa e o registry não tem conteúdo para ela");
        return etapaDaSequencia(e);
      }
      case "pos_sim":
        return etapaPosSim(playbook.whatsapp.posSim);
      case "follow_up":
        return etapaDeFollowup(playbook.followup, estrutural.ordem);
    }
  });

  const bruta = {
    schema_version: SCHEMA_VERSION,
    meta: semIndefinidos({
      objective: playbook.meta.objetivoUnico,
      posture: playbook.meta.postura,
      unbreakable_rule: playbook.meta.regraQueNaoSeQuebra,
      cycle_days: playbook.meta.cicloDias,
      figures: [{ id: "faixa_oficial", value: playbook.meta.faixaOficial }],
      region: { name: playbook.meta.areaDeConcessao.distribuidora, note: playbook.meta.areaDeConcessao.nota },
      principles: playbook.principios.map((p) => ({ order: p.ordem, title: p.titulo, detail: p.detalhe })),
      placeholders: playbook.placeholders.map((p) =>
        semIndefinidos({ token: p.token, kind: p.tipo, description: p.descricao, alias_of: p.equivaleA }),
      ),
      source: {
        registry_id: playbook.id,
        name: playbook.nome,
        document_version: playbook.versaoDoDocumento,
        reference: playbook.fonte,
      },
    }),
    stages,
    objections: playbook.objecoes.map((o) =>
      semIndefinidos({
        id: o.id,
        trigger: o.gatilho,
        behind: o.porTras,
        response: mensagem(o.resposta),
        observation: o.observacao,
        next_action: o.proximaAcao,
      }),
    ),
    objection_rules: [...playbook.regrasDasObjecoes],
    guardrails: playbook.guardrails.map((g) =>
      semIndefinidos({
        id: g.id,
        category: g.categoria,
        severity: g.severidade,
        rule: g.regra,
        source: g.origem,
        alert_terms: g.termosDeAlerta ? [...g.termosDeAlerta] : undefined,
      }),
    ),
    channels: {
      email: {
        description: playbook.email.descricao,
        rules: [playbook.email.regraDoAssunto],
        signature: { text: playbook.email.assinaturaPadrao, note: playbook.email.notaSobreAssinatura },
        variants: playbook.email.variacoes.map((v) => ({
          id: v.id,
          label: v.rotulo,
          subject: v.assunto,
          body: mensagem(v.corpo),
          when_to_use: v.quandoUsar,
        })),
      },
      telefone: {
        description: playbook.ligacao.descricao,
        messages: [
          mensagem(playbook.ligacao.recepcao, "reception"),
          mensagem(playbook.ligacao.doQueSeTrata, "what_is_it_about"),
          mensagem(playbook.ligacao.aberturaComDecisor, "opening_with_decision_maker"),
          mensagem(playbook.ligacao.fechamentoDeAgenda, "schedule_close"),
          mensagem(playbook.ligacao.caixaPostal, "voicemail"),
        ],
        never_say: [...playbook.ligacao.naRecepcaoNunca],
        instructions: [
          { id: "opening", text: playbook.ligacao.instrucaoDaAbertura },
          { id: "diagnostic", text: playbook.ligacao.instrucaoDoDiagnostico },
        ],
        questions: [...playbook.ligacao.perguntasDeDiagnostico],
      },
    },
    metrics: {
      indicators: playbook.metricas.map((m) => ({
        indicator: m.indicador,
        how_to_measure: m.comoMedir,
        when_low: m.quandoBaixo,
      })),
      notes: [...playbook.notasDeMetricas],
    },
    backlog: [...playbook.emDesenvolvimento],
    deprecated_stage_ids: [],
  };

  const definition = definicaoDePlaybookSchema.parse(bruta);
  return { definition, sha256: canonicalHash(definition) };
}

// ─── Equivalência: o que a fase seguinte compara ─────────────────────────────

/** Separador para comparar listas de textos como um só valor — um byte que texto de venda nunca contém. */
const SEP = String.fromCharCode(0);

/**
 * As folhas (strings e números) de um valor, em qualquer profundidade. É a
 * rede de "nenhum texto oficial desaparece": tudo que o registry diz tem de
 * estar, literalmente, em algum lugar da definição.
 */
export function folhas(valor: unknown, acc: Set<string> = new Set()): Set<string> {
  if (typeof valor === "string") acc.add(valor);
  else if (typeof valor === "number") acc.add(String(valor));
  else if (Array.isArray(valor)) for (const v of valor) folhas(v, acc);
  else if (valor !== null && typeof valor === "object") {
    for (const v of Object.values(valor as Record<string, unknown>)) folhas(v, acc);
  }
  return acc;
}

/**
 * Lista, em prosa curta, tudo em que `definition` difere do `playbook`.
 * Vazia ⇒ equivalentes. Não lança: quem chama (teste hoje, comparação
 * persistido × código amanhã) quer a lista inteira, não a primeira falha.
 */
export function divergenciasEntreRegistryEDefinicao(
  playbook: Playbook,
  definition: DefinicaoDePlaybook,
): string[] {
  const d: string[] = [];
  const porId = new Map(definition.stages.map((s) => [s.id, s]));

  // A/B/L — todas as etapas da régua, na ordem, e nenhuma a mais.
  const esperados = ETAPAS_ESTRUTURAIS.map((e) => e.id);
  const obtidos = definition.stages.slice().sort((a, b) => a.order - b.order).map((s) => s.id);
  if (obtidos.join(",") !== esperados.join(",")) d.push(`etapas: esperado [${esperados}], obtido [${obtidos}]`);
  for (const e of ETAPAS_ESTRUTURAIS) {
    const s = porId.get(e.id);
    if (!s) continue;
    if (s.order !== e.ordem) d.push(`${e.id}: order ${s.order} ≠ ${e.ordem}`);
  }

  // C/D/G/K — sequência: título, objetivo, espera, copy, ponte, condições, próxima ação, instruções, guardrails.
  for (const e of playbook.whatsapp.etapas) {
    const s = porId.get(e.id);
    if (!s) { d.push(`${e.id}: etapa ausente`); continue; }
    if (s.label !== e.titulo) d.push(`${e.id}: label ≠ titulo`);
    if (s.objective !== e.objetivo) d.push(`${e.id}: objective ≠ objetivo`);
    if (s.wait_for_reply !== e.aguardarResposta) d.push(`${e.id}: wait_for_reply ≠ aguardarResposta`);
    if ((s.wait_rule ?? undefined) !== e.regraDeEspera) d.push(`${e.id}: wait_rule ≠ regraDeEspera`);
    if (s.next_action !== e.proximaAcao) d.push(`${e.id}: next_action ≠ proximaAcao`);
    if ((s.instructions ?? []).join(SEP) !== e.instrucoes.join(SEP)) d.push(`${e.id}: instructions ≠ instrucoes`);
    if ((s.guardrail_ids ?? []).join(",") !== e.guardrails.join(",")) d.push(`${e.id}: guardrail_ids ≠ guardrails`);
    const primaria = s.messages?.find((m) => m.purpose === "primary");
    if (!primaria || primaria.id !== e.mensagem.id || primaria.text !== e.mensagem.texto || primaria.channel !== e.mensagem.canal) {
      d.push(`${e.id}: copy principal difere`);
    }
    const ponte = s.messages?.find((m) => m.purpose === "bridge");
    if ((ponte?.text ?? undefined) !== e.ponte?.texto) d.push(`${e.id}: ponte difere`);
    const cond = (s.conditions ?? []).map((c) => `${c.customer_reply}|${c.reading}|${c.go_to}`).join(SEP);
    const condEsperada = (e.condicoes ?? []).map((c) => `${c.respostaDoCliente}|${c.leitura}|${c.paraOndeIr}`).join(SEP);
    if (cond !== condEsperada) d.push(`${e.id}: conditions ≠ condicoes`);
  }

  // J — pós-sim.
  const ps = porId.get("pos_sim");
  const p = playbook.whatsapp.posSim;
  if (!ps) d.push("pos_sim: etapa ausente");
  else {
    if (ps.label !== p.titulo || ps.objective !== p.objetivo) d.push("pos_sim: título/objetivo diferem");
    const por = new Map((ps.messages ?? []).map((m) => [m.purpose, m]));
    if (por.get("confirmation")?.text !== p.confirmacao.texto) d.push("pos_sim: confirmação difere");
    if (por.get("reminder_24h")?.text !== p.lembrete24h.texto) d.push("pos_sim: lembrete 24h difere");
    if (por.get("reminder_24h")?.addenda?.[0]?.text !== p.lembreteSemFatura) d.push("pos_sim: lembrete sem fatura difere");
    if (por.get("meeting_opening")?.text !== p.aberturaComFatura.texto) d.push("pos_sim: abertura com fatura difere");
    const cen = (ps.scenarios ?? []).map((c) => `${c.scenario}|${c.how_to_open}|${c.what_not_to_do}`).join(SEP);
    const cenEsp = p.conducaoDaReuniao.map((c) => `${c.cenario}|${c.comoAbrir}|${c.oQueNaoFazer}`).join(SEP);
    if (cen !== cenEsp) d.push("pos_sim: condução da reunião difere");
    if ((ps.rules ?? []).join(SEP) !== p.regras.join(SEP)) d.push("pos_sim: regras diferem");
  }

  // Follow-up como intenção: dias, canais, temas, copies, janela, regras.
  const fu = porId.get("follow_up");
  const c = playbook.followup;
  if (!fu?.followup_intent) d.push("follow_up: intenção ausente");
  else {
    const fi = fu.followup_intent;
    if (fu.label !== c.titulo || fi.objective !== c.objetivo) d.push("follow_up: título/objetivo diferem");
    if (fi.cycle_days !== c.cicloDias || fi.recycle_after_months !== c.reciclagemMeses) d.push("follow_up: ciclo/reciclagem diferem");
    if (fi.reply_interrupts !== c.respostaInterrompe || fi.on_reply !== c.aoResponder) d.push("follow_up: regra de resposta difere");
    const toques = fi.touches.map((t) => `${t.id}|${t.day}|${t.channel}|${t.topic}|${t.period ?? ""}|${t.refers_to ?? ""}|${t.attachment ?? ""}|${t.message?.text ?? ""}`).join(SEP);
    const toquesEsp = c.toques.map((t) => `${t.id}|${t.dia}|${t.canal}|${t.tema}|${t.periodo ?? ""}|${t.remeteA ?? ""}|${t.anexo ?? ""}|${t.mensagem?.texto ?? ""}`).join(SEP);
    if (toques !== toquesEsp) d.push("follow_up: toques diferem");
    if ((fi.rules ?? []).join(SEP) !== c.regras.join(SEP)) d.push("follow_up: regras diferem");
    if (fi.attachment_rule !== c.regraDosCases) d.push("follow_up: regra dos cases difere");
    const j = fi.contact_window;
    if (
      !j ||
      j.afternoon_starts_min !== c.janela.inicioDaTardeMin ||
      j.allowed_weekdays.join(",") !== c.janela.diasPermitidos.join(",") ||
      j.ranges.map((r) => `${r.start_min}-${r.end_min}`).join(",") !== c.janela.faixas.map((f) => `${f.inicioMin}-${f.fimMin}`).join(",")
    ) {
      d.push("follow_up: janela de contato difere");
    }
  }

  // E/F/M — TODAS as mensagens do registry, com id, canal, texto e nota; e o conjunto de canais.
  const msgsDef = new Map(todasAsMensagensDaDefinicao(definition).map((m) => [m.id, m]));
  const msgsReg = todasAsMensagens(playbook);
  for (const m of msgsReg) {
    const x = msgsDef.get(m.id);
    if (!x) d.push(`mensagem ausente: ${m.id}`);
    else if (x.text !== m.texto || x.channel !== m.canal || (x.note ?? undefined) !== m.nota) d.push(`mensagem difere: ${m.id}`);
  }
  if (msgsDef.size !== msgsReg.length) d.push(`quantidade de mensagens: ${msgsDef.size} ≠ ${msgsReg.length}`);
  const canaisReg = [...new Set(msgsReg.map((m) => m.canal))].sort().join(",");
  const canaisDef = [...new Set([...msgsDef.values()].map((m) => m.channel))].sort().join(",");
  if (canaisReg !== canaisDef) d.push(`canais: ${canaisDef} ≠ ${canaisReg}`);

  // H — objeções.
  const objDef = new Map((definition.objections ?? []).map((o) => [o.id, o]));
  for (const o of playbook.objecoes) {
    const x = objDef.get(o.id);
    if (!x) d.push(`objeção ausente: ${o.id}`);
    else if (
      x.trigger !== o.gatilho || x.behind !== o.porTras || x.response.text !== o.resposta.texto ||
      (x.observation ?? undefined) !== o.observacao || (x.next_action ?? undefined) !== o.proximaAcao
    ) d.push(`objeção difere: ${o.id}`);
  }
  if (objDef.size !== playbook.objecoes.length) d.push(`quantidade de objeções: ${objDef.size} ≠ ${playbook.objecoes.length}`);
  if ((definition.objection_rules ?? []).join(SEP) !== playbook.regrasDasObjecoes.join(SEP)) d.push("regras transversais das objeções diferem");

  // I — guardrails.
  const gDef = new Map((definition.guardrails ?? []).map((g) => [g.id, g]));
  for (const g of playbook.guardrails) {
    const x = gDef.get(g.id);
    if (!x) d.push(`guardrail ausente: ${g.id}`);
    else if (
      x.category !== g.categoria || x.severity !== g.severidade || x.rule !== g.regra || x.source !== g.origem ||
      (x.alert_terms ?? []).join(",") !== (g.termosDeAlerta ?? []).join(",")
    ) d.push(`guardrail difere: ${g.id}`);
  }
  if (gDef.size !== playbook.guardrails.length) d.push(`quantidade de guardrails: ${gDef.size} ≠ ${playbook.guardrails.length}`);

  // K — e-mail e ligação.
  const email = definition.channels?.email;
  if (!email) d.push("canal email ausente");
  else {
    const vars = (email.variants ?? []).map((v) => `${v.id}|${v.label}|${v.subject}|${v.when_to_use}|${v.body.text}`).join(SEP);
    const varsEsp = playbook.email.variacoes.map((v) => `${v.id}|${v.rotulo}|${v.assunto}|${v.quandoUsar}|${v.corpo.texto}`).join(SEP);
    if (vars !== varsEsp) d.push("email: variações diferem");
    if (email.signature?.text !== playbook.email.assinaturaPadrao || email.signature?.note !== playbook.email.notaSobreAssinatura) d.push("email: assinatura difere");
    if (!(email.rules ?? []).includes(playbook.email.regraDoAssunto)) d.push("email: regra do assunto ausente");
  }
  const tel = definition.channels?.telefone;
  if (!tel) d.push("canal telefone ausente");
  else {
    if ((tel.never_say ?? []).join(SEP) !== playbook.ligacao.naRecepcaoNunca.join(SEP)) d.push("telefone: naRecepcaoNunca difere");
    if ((tel.questions ?? []).join(SEP) !== playbook.ligacao.perguntasDeDiagnostico.join(SEP)) d.push("telefone: perguntas diferem");
    const instr = new Map((tel.instructions ?? []).map((i) => [i.id, i.text]));
    if (instr.get("opening") !== playbook.ligacao.instrucaoDaAbertura || instr.get("diagnostic") !== playbook.ligacao.instrucaoDoDiagnostico) d.push("telefone: instruções diferem");
  }

  // Meta, princípios, placeholders, métricas, backlog.
  if (definition.meta.objective !== playbook.meta.objetivoUnico) d.push("meta: objetivo difere");
  if (definition.meta.posture !== playbook.meta.postura) d.push("meta: postura difere");
  if (definition.meta.unbreakable_rule !== playbook.meta.regraQueNaoSeQuebra) d.push("meta: regra que não se quebra difere");
  if (definition.meta.cycle_days !== playbook.meta.cicloDias) d.push("meta: ciclo difere");
  if (definition.meta.figures?.[0]?.value !== playbook.meta.faixaOficial) d.push("meta: faixa oficial difere");
  if (definition.meta.region?.name !== playbook.meta.areaDeConcessao.distribuidora) d.push("meta: distribuidora difere");
  const prin = (definition.meta.principles ?? []).map((p) => `${p.order}|${p.title}|${p.detail}`).join(SEP);
  const prinEsp = playbook.principios.map((p) => `${p.ordem}|${p.titulo}|${p.detalhe}`).join(SEP);
  if (prin !== prinEsp) d.push("princípios diferem");
  const ph = (definition.meta.placeholders ?? []).map((p) => `${p.token}|${p.kind}|${p.description}|${p.alias_of ?? ""}`).join(SEP);
  const phEsp = playbook.placeholders.map((p) => `${p.token}|${p.tipo}|${p.descricao}|${p.equivaleA ?? ""}`).join(SEP);
  if (ph !== phEsp) d.push("placeholders diferem");
  const met = (definition.metrics?.indicators ?? []).map((m) => `${m.indicator}|${m.how_to_measure}|${m.when_low}`).join(SEP);
  const metEsp = playbook.metricas.map((m) => `${m.indicador}|${m.comoMedir}|${m.quandoBaixo}`).join(SEP);
  if (met !== metEsp) d.push("métricas diferem");
  if ((definition.metrics?.notes ?? []).join(SEP) !== playbook.notasDeMetricas.join(SEP)) d.push("notas de métricas diferem");
  if ((definition.backlog ?? []).join(SEP) !== playbook.emDesenvolvimento.join(SEP)) d.push("backlog difere");

  // M — a rede final: toda folha do registry está na definição.
  const folhasDef = folhas(definition);
  for (const f of folhas(playbook)) if (!folhasDef.has(f)) d.push(`texto do registry ausente na definição: ${f.slice(0, 60)}`);

  return d;
}
