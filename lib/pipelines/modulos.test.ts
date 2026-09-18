/**
 * Leitor e merge de módulos por funil.
 *
 * Os dois defeitos que este arquivo existe para tornar impossíveis:
 *
 *   1. LEITURA CRÉDULA — `settings` chega de cinco leitores sem validação; se
 *      o leitor aceitasse `"true"` ou `1`, um jsonb mexido à mão ligaria um
 *      módulo que ninguém ligou.
 *   2. MERGE RASO — atribuir `patch.modulos` inteiro apaga os módulos que o
 *      patch não citou. Com um módulo só o bug não aparece; o caso "módulo
 *      existente não é apagado ao atualizar outro" é o que o pega ANTES do
 *      segundo módulo existir. Sabotagem provada: trocar o spread de segundo
 *      nível por atribuição direta deixa esse caso vermelho.
 */
import { describe, expect, it } from "vitest";

import { mergeModulos, moduloDeFunilAtivo } from "./modulos";

describe("moduloDeFunilAtivo", () => {
  it("é true somente quando enabled === true", () => {
    expect(moduloDeFunilAtivo({ modulos: { x: { enabled: true } } }, "x")).toBe(true);
    expect(moduloDeFunilAtivo({ modulos: { x: { enabled: false } } }, "x")).toBe(false);
  });

  it("é false para settings ausente ou nulo", () => {
    expect(moduloDeFunilAtivo(null, "x")).toBe(false);
    expect(moduloDeFunilAtivo(undefined, "x")).toBe(false);
    expect(moduloDeFunilAtivo({}, "x")).toBe(false);
  });

  it("é false quando o módulo pedido não existe (mesmo com outros ligados)", () => {
    expect(moduloDeFunilAtivo({ modulos: { outro: { enabled: true } } }, "x")).toBe(false);
  });

  it("é false para enabled em forma errada: string, number, null, objeto", () => {
    for (const enabled of ["true", 1, null, {}, [true]]) {
      expect(moduloDeFunilAtivo({ modulos: { x: { enabled } } }, "x")).toBe(false);
    }
  });

  it("é false quando modulos ou o módulo são array/string/null", () => {
    expect(moduloDeFunilAtivo({ modulos: [] }, "x")).toBe(false);
    expect(moduloDeFunilAtivo({ modulos: "x" }, "x")).toBe(false);
    expect(moduloDeFunilAtivo({ modulos: null }, "x")).toBe(false);
    expect(moduloDeFunilAtivo({ modulos: { x: [] } }, "x")).toBe(false);
    expect(moduloDeFunilAtivo({ modulos: { x: true } }, "x")).toBe(false);
    expect(moduloDeFunilAtivo({ modulos: { x: null } }, "x")).toBe(false);
  });

  it("ignora chaves herdadas do protótipo", () => {
    // `{}` tem `toString` via prototype; um módulo chamado assim não pode
    // "existir" só porque Object.prototype o tem.
    expect(moduloDeFunilAtivo({ modulos: {} }, "toString")).toBe(false);
  });
});

describe("mergeModulos", () => {
  it("não apaga módulo existente ao atualizar outro", () => {
    const atual = { a: { enabled: true }, b: { enabled: false } };
    const r = mergeModulos(atual, { copiloto_comercial: { enabled: true } });
    expect(r).toEqual({
      a: { enabled: true },
      b: { enabled: false },
      copiloto_comercial: { enabled: true },
    });
  });

  it("módulo presente no patch é substituído INTEIRO, não fundido", () => {
    const atual = { copiloto_comercial: { enabled: true, chave_antiga: "x" } };
    const r = mergeModulos(atual, { copiloto_comercial: { enabled: false } });
    expect(r.copiloto_comercial).toEqual({ enabled: false });
  });

  it("aceita atual null/undefined e devolve só o patch", () => {
    expect(mergeModulos(null, { copiloto_comercial: { enabled: true } })).toEqual({
      copiloto_comercial: { enabled: true },
    });
    expect(mergeModulos(undefined, { copiloto_comercial: { enabled: true } })).toEqual({
      copiloto_comercial: { enabled: true },
    });
  });

  it("atual inválido (array, string, número) não explode e vira vazio", () => {
    for (const atual of [[], "lixo", 42, true]) {
      expect(() => mergeModulos(atual, { copiloto_comercial: { enabled: true } })).not.toThrow();
      expect(mergeModulos(atual, { copiloto_comercial: { enabled: true } })).toEqual({
        copiloto_comercial: { enabled: true },
      });
    }
  });

  it("patch vazio devolve o atual intacto", () => {
    const atual = { a: { enabled: true } };
    expect(mergeModulos(atual, {})).toEqual(atual);
  });

  it("não muta o objeto de entrada", () => {
    const atual = { a: { enabled: true } };
    mergeModulos(atual, { copiloto_comercial: { enabled: true } });
    expect(atual).toEqual({ a: { enabled: true } });
  });
});
