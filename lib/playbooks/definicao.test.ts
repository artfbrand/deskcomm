/**
 * O contrato da definição genérica: ids de etapa estáveis, referências que
 * resolvem, e NENHUMA chave de autonomia — estratégia não sabe se é assistida
 * ou automática.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  definicaoDePlaybookSchema,
  etapaPorId,
  etapasOrdenadas,
  SCHEMA_VERSION,
  STAGE_ID_REGEX,
  validarDefinicao,
  type DefinicaoDePlaybook,
} from "./definicao";

const minima = (): DefinicaoDePlaybook => ({
  schema_version: SCHEMA_VERSION,
  meta: {},
  stages: [
    { id: "abertura", label: "Abertura", order: 1, kind: "sequence", transitions: [{ to: "qualificacao", when: "replied" }] },
    { id: "qualificacao", label: "Qualificação inicial", order: 2, kind: "sequence" },
  ],
});

const clonar = <T,>(v: T): T => structuredClone(v);

describe("ids de etapa estáveis", () => {
  it.each(["abertura", "pos_sim", "a1", "gancho_de_valor", "x".repeat(40)])("aceita %s", (id) => {
    expect(STAGE_ID_REGEX.test(id)).toBe(true);
  });

  it.each([
    ["maiúscula", "Qualificacao"],
    ["começa por dígito", "1abertura"],
    ["hífen", "gancho-de-valor"],
    ["espaço (é rótulo, não id)", "Qualificação inicial"],
    ["uma letra só", "a"],
    ["41 caracteres", "a".repeat(41)],
    ["acento", "qualificação"],
  ])("recusa %s", (_rotulo, id) => {
    const d = minima();
    d.stages[1]!.id = id;
    d.stages[0]!.transitions = [];
    const r = validarDefinicao(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros.some((e) => e.path.startsWith("stages.1.id"))).toBe(true);
  });

  it("id duplicado é recusado; order duplicada é recusada", () => {
    const d = minima();
    d.stages[1]!.id = "abertura";
    d.stages[0]!.transitions = [];
    expect(validarDefinicao(d).ok).toBe(false);

    const e = minima();
    e.stages[1]!.order = 1;
    expect(validarDefinicao(e).ok).toBe(false);
  });

  it("mudar o rótulo preserva o id — o contrato que a UI vai honrar", () => {
    const v1 = definicaoDePlaybookSchema.parse(minima());
    const v2 = clonar(v1);
    v2.stages[1]!.label = "Diagnóstico inicial";
    const r = validarDefinicao(v2);
    expect(r.ok).toBe(true);
    expect(etapaPorId(v1, "qualificacao")?.label).toBe("Qualificação inicial");
    expect(etapaPorId(v2, "qualificacao")?.label).toBe("Diagnóstico inicial");
    // A transição de `abertura` continua apontando para o mesmo id.
    expect(v2.stages[0]!.transitions?.[0]?.to).toBe("qualificacao");
  });

  it("deprecated_stage_ids não pode conter etapa ativa", () => {
    const d = minima();
    d.deprecated_stage_ids = ["qualificacao"];
    const r = validarDefinicao(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros.map((e) => e.message).join()).toMatch(/ativo e deprecado/);
  });
});

describe("referências internas resolvem", () => {
  it("transição para etapa inexistente é recusada", () => {
    const d = minima();
    d.stages[0]!.transitions = [{ to: "convite" }];
    const r = validarDefinicao(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros.map((e) => e.message).join()).toMatch(/inexistente: convite/);
  });

  it("guardrail referenciado precisa existir", () => {
    const d = minima();
    d.stages[0]!.guardrail_ids = ["nunca.prometer"];
    expect(validarDefinicao(d).ok).toBe(false);
    d.guardrails = [{ id: "nunca.prometer", category: "promessas", severity: "nunca", rule: "Não prometer." }];
    expect(validarDefinicao(d).ok).toBe(true);
  });

  it("id de mensagem é único em toda a definição (etapas, toques, objeções, canais)", () => {
    const d = minima();
    d.stages[0]!.messages = [{ id: "whatsapp.abertura", channel: "whatsapp", text: "Olá" }];
    d.objections = [{ id: "solar", trigger: "É solar?", response: { id: "whatsapp.abertura", channel: "whatsapp", text: "Não." } }];
    const r = validarDefinicao(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros.map((e) => e.message).join()).toMatch(/message id duplicado/);
  });

  it("alias_of de placeholder aponta para token existente", () => {
    const d = minima();
    d.meta.placeholders = [{ token: "DIA", kind: "agenda", description: "…", alias_of: "dia" }];
    expect(validarDefinicao(d).ok).toBe(false);
    d.meta.placeholders.push({ token: "dia", kind: "agenda", description: "…" });
    expect(validarDefinicao(d).ok).toBe(true);
  });
});

describe("estratégia não carrega autonomia", () => {
  it.each(["mode", "autonomy", "auto_send", "assisted", "automatic", "execution_mode"])(
    "chave `%s` é recusada no topo e na etapa",
    (chave) => {
      const topo = { ...minima(), [chave]: "assisted" };
      expect(validarDefinicao(topo).ok).toBe(false);
      const d = minima();
      (d.stages[0] as Record<string, unknown>)[chave] = "automatic";
      expect(validarDefinicao(d).ok).toBe(false);
    },
  );

  it("o próprio schema não declara nenhuma chave de modo/autonomia", () => {
    const fonte = readFileSync(path.join(process.cwd(), "lib", "playbooks", "definicao.ts"), "utf8");
    // Só as linhas de código: o cabeçalho explica POR QUE a chave não existe e a cita.
    const codigo = fonte.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(codigo).not.toMatch(/\b(mode|autonomy|auto_send|assisted|automatic)\s*:/);
  });
});

describe("o genérico não conhece cliente nenhum", () => {
  it("definicao.ts não importa nada de lib/afb", () => {
    const fonte = readFileSync(path.join(process.cwd(), "lib", "playbooks", "definicao.ts"), "utf8");
    const imports = [...fonte.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(imports.filter((i) => i.includes("/afb"))).toEqual([]);
    expect(imports).toEqual(["zod"]);
  });
});

describe("utilitários", () => {
  it("etapasOrdenadas segue `order`, não a posição no array", () => {
    const d = definicaoDePlaybookSchema.parse({
      ...minima(),
      stages: [
        { id: "segunda", label: "B", order: 2, kind: "sequence" },
        { id: "primeira", label: "A", order: 1, kind: "sequence" },
      ],
    });
    expect(etapasOrdenadas(d).map((s) => s.id)).toEqual(["primeira", "segunda"]);
  });

  it("validarDefinicao devolve erros com caminho, nunca lança", () => {
    const r = validarDefinicao({ schema_version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erros.length).toBeGreaterThan(0);
  });
});
