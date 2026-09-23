/**
 * registry ≡ definição — a prova de que o import do `afb_comercial_v1` não
 * perde nada, é determinístico, e de que o gate MORDE quando algo some.
 *
 * Nada aqui pina copy byte a byte contra um literal: o que se prende é que a
 * definição diz EXATAMENTE o que o registry diz, seja ele qual for hoje.
 * Editar uma frase do playbook muda as duas pontas juntas e o teste segue
 * verde; esquecer um campo no adaptador, não.
 *
 * Sobre "10% a 35%" nas copies e "10% a 30%" no Knowledge de Mercado Livre:
 * escopos distintos por decisão comercial (consultoria ampla × contratação de
 * energia), coexistência intencional, nenhum dos dois é promessa. O adaptador
 * copia o valor do playbook como está — o teste `figures` abaixo só confirma
 * que ele foi copiado, não o que ele vale.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ETAPAS_ESTRUTURAIS, SEQUENCIA_IDS } from "@/lib/afb/playbook/etapas";
import { PAPEIS_DE_ETAPA } from "@/lib/afb/playbook/papeis";
import { AFB_COMERCIAL_V1 } from "@/lib/afb/playbooks/comercial";
import { ESTRUTURA_DE_RESPOSTA } from "@/lib/afb/playbooks/comercial/objecoes";
import { todasAsMensagens } from "@/lib/afb/playbooks/registry";
import type { Playbook } from "@/lib/afb/playbooks/types";
import { canonicalHash } from "@/lib/agent-engine/agent/tool-breaker";

import {
  deRegistryParaDefinicao,
  divergenciasEntreRegistryEDefinicao,
  ErroDeAdaptacao,
  folhas,
} from "./adaptador-afb";
import { todasAsMensagensDaDefinicao, validarDefinicao, type DefinicaoDePlaybook } from "./definicao";

type Mutavel<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutavel<T[K]> : T[K] };

/** Cópia profunda e mutável do registry — para sabotar SEM tocar no playbook real. */
const copiaMutavel = (): Mutavel<Playbook> => structuredClone(AFB_COMERCIAL_V1) as Mutavel<Playbook>;

const { definition: D, sha256: SHA } = deRegistryParaDefinicao(AFB_COMERCIAL_V1);
const porId = new Map(D.stages.map((s) => [s.id, s]));

describe("a definição gerada é válida pelo schema genérico", () => {
  it("passa em validarDefinicao sem erro", () => {
    const r = validarDefinicao(D);
    expect(r.ok).toBe(true);
  });

  it("é JSON limpo: nenhuma chave com undefined em profundidade nenhuma", () => {
    const semUndefined = JSON.parse(JSON.stringify(D)) as unknown;
    expect(semUndefined).toEqual(D);
  });
});

describe("A/B/L — etapas: todas, na ordem da régua, nenhuma a mais", () => {
  it("os ids e a ordem são os de ETAPAS_ESTRUTURAIS", () => {
    const ordenadas = D.stages.slice().sort((a, b) => a.order - b.order);
    expect(ordenadas.map((s) => s.id)).toEqual(ETAPAS_ESTRUTURAIS.map((e) => e.id));
    expect(ordenadas.map((s) => s.order)).toEqual(ETAPAS_ESTRUTURAIS.map((e) => e.ordem));
    expect(D.stages).toHaveLength(ETAPAS_ESTRUTURAIS.length);
  });

  it("kind acompanha o tipo estrutural", () => {
    for (const e of ETAPAS_ESTRUTURAIS) {
      const esperado = e.tipo === "sequencia" ? "sequence" : e.tipo === "pos_sim" ? "post_yes" : "follow_up";
      expect(porId.get(e.id)?.kind).toBe(esperado);
    }
  });
});

describe("C/D/G — sequência: título, objetivo e espera por etapa", () => {
  it.each(AFB_COMERCIAL_V1.whatsapp.etapas.map((e) => [e.id, e] as const))("%s", (_id, e) => {
    const s = porId.get(e.id)!;
    expect(s.label).toBe(e.titulo);
    expect(s.objective).toBe(e.objetivo);
    expect(s.wait_for_reply).toBe(e.aguardarResposta);
    expect(s.wait_rule ?? undefined).toBe(e.regraDeEspera);
    expect(s.next_action).toBe(e.proximaAcao);
    expect(s.instructions).toEqual([...e.instrucoes]);
    expect(s.guardrail_ids).toEqual([...e.guardrails]);
  });
});

describe("E/K — copies oficiais, canal a canal", () => {
  it("cada etapa da sequência tem a copy principal exata, e a ponte quando existe", () => {
    for (const e of AFB_COMERCIAL_V1.whatsapp.etapas) {
      const s = porId.get(e.id)!;
      const primaria = s.messages!.find((m) => m.purpose === "primary")!;
      expect(primaria).toMatchObject({ id: e.mensagem.id, channel: "whatsapp", text: e.mensagem.texto });
      expect(primaria.note ?? undefined).toBe(e.mensagem.nota);
      const ponte = s.messages!.find((m) => m.purpose === "bridge");
      expect(ponte?.text).toBe(e.ponte?.texto);
    }
  });

  it("condições de resposta (tabela da Etapa 2) preservadas linha a linha", () => {
    const q = AFB_COMERCIAL_V1.whatsapp.etapas.find((e) => e.id === "qualificacao")!;
    expect(porId.get("qualificacao")!.conditions).toEqual(
      q.condicoes!.map((c) => ({ customer_reply: c.respostaDoCliente, reading: c.leitura, go_to: c.paraOndeIr })),
    );
  });

  it("TODAS as mensagens do registry estão na definição, com id, canal, texto e nota — e nenhuma a mais", () => {
    const reg = todasAsMensagens(AFB_COMERCIAL_V1);
    const def = new Map(todasAsMensagensDaDefinicao(D).map((m) => [m.id, m]));
    expect(def.size).toBe(reg.length);
    for (const m of reg) {
      expect(def.get(m.id), m.id).toMatchObject({ channel: m.canal, text: m.texto });
      expect(def.get(m.id)!.note ?? undefined).toBe(m.nota);
    }
  });

  it("F — os canais são exatamente os do registry", () => {
    const canaisReg = new Set(todasAsMensagens(AFB_COMERCIAL_V1).map((m) => m.canal));
    const canaisDef = new Set(todasAsMensagensDaDefinicao(D).map((m) => m.channel));
    expect(canaisDef).toEqual(canaisReg);
    expect(Object.keys(D.channels!).sort()).toEqual(["email", "telefone"]);
  });

  it("e-mail: as três variações, assunto, quando usar, assinatura e regra do assunto", () => {
    const em = D.channels!.email!;
    expect(em.variants!.map((v) => [v.id, v.label, v.subject, v.when_to_use, v.body.text])).toEqual(
      AFB_COMERCIAL_V1.email.variacoes.map((v) => [v.id, v.rotulo, v.assunto, v.quandoUsar, v.corpo.texto]),
    );
    expect(em.signature).toEqual({ text: AFB_COMERCIAL_V1.email.assinaturaPadrao, note: AFB_COMERCIAL_V1.email.notaSobreAssinatura });
    expect(em.rules).toContain(AFB_COMERCIAL_V1.email.regraDoAssunto);
    expect(em.description).toBe(AFB_COMERCIAL_V1.email.descricao);
  });

  it("ligação: os cinco roteiros, o que nunca dizer, perguntas e instruções", () => {
    const tel = D.channels!.telefone!;
    const L = AFB_COMERCIAL_V1.ligacao;
    expect(tel.messages!.map((m) => [m.purpose, m.text])).toEqual([
      ["reception", L.recepcao.texto],
      ["what_is_it_about", L.doQueSeTrata.texto],
      ["opening_with_decision_maker", L.aberturaComDecisor.texto],
      ["schedule_close", L.fechamentoDeAgenda.texto],
      ["voicemail", L.caixaPostal.texto],
    ]);
    expect(tel.never_say).toEqual([...L.naRecepcaoNunca]);
    expect(tel.questions).toEqual([...L.perguntasDeDiagnostico]);
    expect(tel.instructions).toEqual([
      { id: "opening", text: L.instrucaoDaAbertura },
      { id: "diagnostic", text: L.instrucaoDoDiagnostico },
    ]);
  });
});

describe("H/I — objeções e guardrails", () => {
  it("as objeções, uma a uma, com gatilho, por trás, resposta, observação e próxima ação", () => {
    expect(D.objections!.map((o) => [o.id, o.trigger, o.behind, o.response.text, o.observation, o.next_action])).toEqual(
      AFB_COMERCIAL_V1.objecoes.map((o) => [o.id, o.gatilho, o.porTras, o.resposta.texto, o.observacao, o.proximaAcao]),
    );
    expect(D.objections).toHaveLength(AFB_COMERCIAL_V1.objecoes.length);
  });

  it("os guardrails, um a um, com categoria, severidade, regra, origem e termos de alerta", () => {
    expect(D.guardrails!.map((g) => [g.id, g.category, g.severity, g.rule, g.source, g.alert_terms])).toEqual(
      AFB_COMERCIAL_V1.guardrails.map((g) => [g.id, g.categoria, g.severidade, g.regra, g.origem, g.termosDeAlerta ? [...g.termosDeAlerta] : undefined]),
    );
    expect(D.guardrails).toHaveLength(AFB_COMERCIAL_V1.guardrails.length);
  });

  it("as regras transversais das objeções (estrutura de resposta) estão em objection_rules, literalmente", () => {
    expect(D.objection_rules).toEqual([...AFB_COMERCIAL_V1.regrasDasObjecoes]);
    expect(D.objection_rules).toContain(ESTRUTURA_DE_RESPOSTA);
    // Campo próprio: não é guardrail, não é princípio, não está dentro de uma objeção.
    expect(D.guardrails!.some((g) => g.rule === ESTRUTURA_DE_RESPOSTA)).toBe(false);
    expect(D.meta.principles!.some((p) => p.title === ESTRUTURA_DE_RESPOSTA || p.detail === ESTRUTURA_DE_RESPOSTA)).toBe(false);
    expect(D.objections!.some((o) => o.response.text === ESTRUTURA_DE_RESPOSTA)).toBe(false);
  });

  it("toda referência de guardrail feita por etapa resolve na definição", () => {
    const ids = new Set(D.guardrails!.map((g) => g.id));
    for (const s of D.stages) for (const g of s.guardrail_ids ?? []) expect(ids.has(g), g).toBe(true);
  });
});

describe("J — pós-sim (Etapa 7) e reunião", () => {
  const P = AFB_COMERCIAL_V1.whatsapp.posSim;
  const s = porId.get("pos_sim")!;
  const msg = (purpose: string) => s.messages!.find((m) => m.purpose === purpose)!;

  it("confirmação, lembrete 24h (com a linha sem fatura) e abertura com fatura", () => {
    expect(msg("confirmation").text).toBe(P.confirmacao.texto);
    expect(msg("reminder_24h").text).toBe(P.lembrete24h.texto);
    expect(msg("reminder_24h").addenda).toEqual([{ when: "invoice_not_received", text: P.lembreteSemFatura }]);
    expect(msg("meeting_opening").text).toBe(P.aberturaComFatura.texto);
  });

  it("condução da reunião e regras, na ordem", () => {
    expect(s.scenarios).toEqual(P.conducaoDaReuniao.map((c) => ({ scenario: c.cenario, how_to_open: c.comoAbrir, what_not_to_do: c.oQueNaoFazer })));
    expect(s.rules).toEqual([...P.regras]);
    expect(s.label).toBe(P.titulo);
    expect(s.objective).toBe(P.objetivo);
  });
});

describe("follow-up é INTENÇÃO e conteúdo, nunca execução", () => {
  const C = AFB_COMERCIAL_V1.followup;
  const fi = porId.get("follow_up")!.followup_intent!;

  it("dias, canais, temas, copies e remissões de cada toque", () => {
    expect(fi.touches.map((t) => [t.id, t.day, t.channel, t.topic, t.period, t.refers_to, t.attachment, t.message?.text])).toEqual(
      C.toques.map((t) => [t.id, t.dia, t.canal, t.tema, t.periodo, t.remeteA, t.anexo, t.mensagem?.texto]),
    );
  });

  it("ciclo, reciclagem, regra de resposta, janela, regras e regra dos cases", () => {
    expect(fi.cycle_days).toBe(C.cicloDias);
    expect(fi.recycle_after_months).toBe(C.reciclagemMeses);
    expect(fi.reply_interrupts).toBe(true);
    expect(fi.on_reply).toBe(C.aoResponder);
    expect(fi.contact_window).toEqual({
      ranges: C.janela.faixas.map((f) => ({ start_min: f.inicioMin, end_min: f.fimMin })),
      allowed_weekdays: [...C.janela.diasPermitidos],
      discouraged: C.janela.desaconselhados.map((d) => ({ weekday: d.diaDaSemana, period: d.periodo })),
      afternoon_starts_min: C.janela.inicioDaTardeMin,
    });
    expect(fi.rules).toEqual([...C.regras]);
    expect(fi.attachment_rule).toBe(C.regraDosCases);
  });

  it("a definição não tem nenhum campo de agendamento/execução (schedule, send, cron, enroll)", () => {
    const chaves = new Set<string>();
    const coletar = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(coletar);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { chaves.add(k); coletar(x); }
    };
    coletar(D);
    expect([...chaves].filter((k) => /schedule|send|cron|enroll|dispatch|execute/i.test(k))).toEqual([]);
  });
});

describe("papéis, transições, meta", () => {
  it("allowed_roles de cada etapa = os papéis de papeis.ts que a abrigam (follow_up = followUpPermitido)", () => {
    for (const e of ETAPAS_ESTRUTURAIS) {
      const esperado =
        e.id === "follow_up"
          ? PAPEIS_DE_ETAPA.filter((p) => p.followUpPermitido).map((p) => p.id)
          : PAPEIS_DE_ETAPA.filter((p) => p.etapas.includes(e.id)).map((p) => p.id);
      expect(porId.get(e.id)!.allowed_roles, e.id).toEqual(esperado);
    }
  });

  it("transições seguem a régua: próxima da sequência ao responder; última → pós-sim; silêncio → follow-up", () => {
    SEQUENCIA_IDS.forEach((id, i) => {
      const t = porId.get(id)!.transitions!;
      const proxima = SEQUENCIA_IDS[i + 1];
      expect(t[0]).toEqual(proxima ? { to: proxima, when: "replied" } : { to: "pos_sim", when: "meeting_accepted" });
      expect(t[1]).toEqual({ to: "follow_up", when: "no_reply" });
    });
  });

  it("meta: objetivo único, postura, regra que não se quebra, ciclo, região, princípios, placeholders, fonte", () => {
    const M = AFB_COMERCIAL_V1.meta;
    expect(D.meta.objective).toBe(M.objetivoUnico);
    expect(D.meta.posture).toBe(M.postura);
    expect(D.meta.unbreakable_rule).toBe(M.regraQueNaoSeQuebra);
    expect(D.meta.cycle_days).toBe(M.cicloDias);
    expect(D.meta.region).toEqual({ name: M.areaDeConcessao.distribuidora, note: M.areaDeConcessao.nota });
    expect(D.meta.principles).toEqual(AFB_COMERCIAL_V1.principios.map((p) => ({ order: p.ordem, title: p.titulo, detail: p.detalhe })));
    expect(D.meta.placeholders!.map((p) => [p.token, p.kind, p.description, p.alias_of])).toEqual(
      AFB_COMERCIAL_V1.placeholders.map((p) => [p.token, p.tipo, p.descricao, p.equivaleA]),
    );
    expect(D.meta.source).toEqual({
      registry_id: AFB_COMERCIAL_V1.id,
      name: AFB_COMERCIAL_V1.nome,
      document_version: AFB_COMERCIAL_V1.versaoDoDocumento,
      reference: AFB_COMERCIAL_V1.fonte,
    });
  });

  it("figures copia a faixa oficial como o playbook a escreve (escopo amplo da consultoria; o Knowledge de ML tem o seu)", () => {
    expect(D.meta.figures).toEqual([{ id: "faixa_oficial", value: AFB_COMERCIAL_V1.meta.faixaOficial }]);
  });

  it("métricas, notas e backlog do documento", () => {
    expect(D.metrics!.indicators).toEqual(AFB_COMERCIAL_V1.metricas.map((m) => ({ indicator: m.indicador, how_to_measure: m.comoMedir, when_low: m.quandoBaixo })));
    expect(D.metrics!.notes).toEqual([...AFB_COMERCIAL_V1.notasDeMetricas]);
    expect(D.backlog).toEqual([...AFB_COMERCIAL_V1.emDesenvolvimento]);
  });
});

describe("M — nenhum texto oficial desaparece", () => {
  it("toda folha (string/número) do registry existe literalmente na definição", () => {
    const def = folhas(D);
    const faltando = [...folhas(AFB_COMERCIAL_V1)].filter((f) => !def.has(f));
    expect(faltando).toEqual([]);
  });

  it("o verificador de equivalência não encontra divergência no registry real", () => {
    expect(divergenciasEntreRegistryEDefinicao(AFB_COMERCIAL_V1, D)).toEqual([]);
  });
});

describe("determinismo e hash canônico", () => {
  it("duas execuções ⇒ definições estruturalmente iguais e o MESMO sha256", () => {
    const a = deRegistryParaDefinicao(AFB_COMERCIAL_V1);
    const b = deRegistryParaDefinicao(AFB_COMERCIAL_V1);
    expect(a.definition).toEqual(b.definition);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(SHA);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o hash não depende da ordem das chaves: um clone com chaves invertidas dá o mesmo sha", () => {
    const inverter = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(inverter);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as object).reverse()) out[k] = inverter((v as Record<string, unknown>)[k]);
        return out;
      }
      return v;
    };
    const invertido = inverter(D);
    expect(JSON.stringify(invertido)).not.toBe(JSON.stringify(D)); // a serialização crua muda…
    expect(canonicalHash(invertido)).toBe(SHA); // …o hash canônico não
  });

  it("o adaptador não lê relógio, ambiente, aleatoriedade nem rede", () => {
    const fonte = readFileSync(path.join(process.cwd(), "lib", "playbooks", "adaptador-afb.ts"), "utf8");
    const codigo = fonte.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(codigo).not.toMatch(/Date\.now|new Date\(|Math\.random|randomUUID|process\.env|fetch\(|createAdminClient|from\("/);
  });

  it("esqueleto estável (ids, ordem, kinds, ids de mensagem) — snapshot como camada adicional", () => {
    expect(
      D.stages.map((s) => ({ id: s.id, order: s.order, kind: s.kind, messages: (s.messages ?? []).map((m) => m.id) })),
    ).toMatchSnapshot();
  });
});

describe("sabotagem — o gate morde (fixtures, o playbook real fica intacto)", () => {
  it("copy oficial alterada ⇒ divergência apontada e sha diferente", () => {
    const sab = copiaMutavel();
    sab.whatsapp.etapas[0]!.mensagem.texto += " (alterado)";
    const { definition, sha256 } = deRegistryParaDefinicao(sab as unknown as Playbook);
    const div = divergenciasEntreRegistryEDefinicao(AFB_COMERCIAL_V1, definition);
    expect(div.some((x) => /abertura: copy principal difere/.test(x))).toBe(true);
    expect(sha256).not.toBe(SHA);
  });

  it("guardrail removido ⇒ divergência apontada", () => {
    const sab = copiaMutavel();
    const referenciados = new Set(sab.whatsapp.etapas.flatMap((e) => e.guardrails));
    const alvo = sab.guardrails.find((g) => !referenciados.has(g.id))!;
    sab.guardrails = sab.guardrails.filter((g) => g.id !== alvo.id);
    const { definition } = deRegistryParaDefinicao(sab as unknown as Playbook);
    const div = divergenciasEntreRegistryEDefinicao(AFB_COMERCIAL_V1, definition);
    expect(div).toContain(`guardrail ausente: ${alvo.id}`);
  });

  it("etapa da sequência sem conteúdo ⇒ o adaptador RECUSA em vez de exportar com buraco", () => {
    const sab = copiaMutavel();
    sab.whatsapp.etapas = sab.whatsapp.etapas.filter((e) => e.id !== "micro_spin");
    expect(() => deRegistryParaDefinicao(sab as unknown as Playbook)).toThrow(ErroDeAdaptacao);
  });

  it("etapa retirada da DEFINIÇÃO ⇒ o verificador aponta a etapa e as mensagens dela", () => {
    const def: DefinicaoDePlaybook = structuredClone(D);
    def.stages = def.stages.filter((s) => s.id !== "micro_spin");
    const div = divergenciasEntreRegistryEDefinicao(AFB_COMERCIAL_V1, def);
    expect(div.some((x) => x.startsWith("etapas:"))).toBe(true);
    expect(div).toContain("micro_spin: etapa ausente");
    expect(div).toContain("mensagem ausente: whatsapp.micro_spin");
  });

  it("regra transversal das objeções removida do registry ⇒ a equivalência deixa de passar", () => {
    const sab = copiaMutavel();
    sab.regrasDasObjecoes = [];
    const { definition, sha256 } = deRegistryParaDefinicao(sab as unknown as Playbook);
    const div = divergenciasEntreRegistryEDefinicao(AFB_COMERCIAL_V1, definition);
    expect(div).toContain("regras transversais das objeções diferem");
    // E a rede de folhas também acusa: a frase oficial sumiu da definição.
    expect(div.some((x) => x.startsWith("texto do registry ausente na definição: Reconhecer sem discutir"))).toBe(true);
    expect(sha256).not.toBe(SHA);
  });

  it("objeção com resposta trocada ⇒ divergência apontada", () => {
    const sab = copiaMutavel();
    sab.objecoes[0]!.resposta.texto = "Sim, é energia solar.";
    const { definition } = deRegistryParaDefinicao(sab as unknown as Playbook);
    expect(divergenciasEntreRegistryEDefinicao(AFB_COMERCIAL_V1, definition)).toContain(`objeção difere: ${sab.objecoes[0]!.id}`);
  });
});
