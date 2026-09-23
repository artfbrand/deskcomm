/**
 * O agendamento pós-resposta — os três caminhos, e nenhum deles inventado.
 *
 * O primeiro bloco NÃO mocka nada: vitest roda fora de escopo de request, e o
 * `after()` REAL do Next 16 lança ali. É a prova do caminho documentado
 * contra o Next instalado, não contra uma ideia dele.
 *
 * Os demais precisam de um `after()` que aceite ou que falhe de outro jeito,
 * e usam `vi.doMock` + import dinâmico para trocar o módulo por teste.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { agendarPosResposta } from "./pos-resposta";

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("next/server");
});

describe("fora de escopo de request — o `after()` REAL do Next", () => {
  it("cai para execução imediata em vez de perder a tarefa", async () => {
    let rodou = false;
    agendarPosResposta("teste", async () => {
      rodou = true;
    });
    await vi.waitFor(() => expect(rodou).toBe(true));
  });

  it("uma tarefa que rejeita é registrada, nunca vira unhandledRejection", async () => {
    agendarPosResposta("tarefa-quebrada", async () => {
      throw new Error("falhou por dentro");
    });
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        "pos_resposta.tarefa_falhou",
        expect.objectContaining({ tarefa: "tarefa-quebrada", erro: "falhou por dentro" }),
      ),
    );
  });

  it("não lança para quem chama — o caminho crítico não depende disto", () => {
    expect(() =>
      agendarPosResposta("teste", async () => {
        throw new Error("x");
      }),
    ).not.toThrow();
  });
});

describe("dentro de escopo de request", () => {
  it("entrega a tarefa ao after() e NÃO a executa na hora", async () => {
    const registradas: Array<() => Promise<void>> = [];
    vi.doMock("next/server", () => ({ after: (f: () => Promise<void>) => registradas.push(f) }));
    const { agendarPosResposta: agendar } = await import("./pos-resposta");

    let rodou = false;
    agendar("teste", async () => {
      rodou = true;
    });

    expect(registradas).toHaveLength(1);
    expect(rodou).toBe(false); // o Next é quem decide quando — depois da resposta
    await registradas[0]!();
    expect(rodou).toBe(true);
  });

  it("a tarefa continua com catch próprio mesmo rodando pelo after()", async () => {
    const registradas: Array<() => Promise<void>> = [];
    vi.doMock("next/server", () => ({ after: (f: () => Promise<void>) => registradas.push(f) }));
    // O import dinâmico traz um grafo de módulos NOVO — inclusive o logger.
    // Espionar o do import estático aqui vigiaria um objeto que este caminho
    // não usa, e o teste passaria a medir a si mesmo.
    const { logger: loggerDoGrafoNovo } = await import("@/lib/logger");
    const erro = vi.spyOn(loggerDoGrafoNovo, "error").mockImplementation(() => {});
    const { agendarPosResposta: agendar } = await import("./pos-resposta");

    agendar("pelo-after", async () => {
      throw new Error("estourou depois da resposta");
    });
    await expect(registradas[0]!()).resolves.toBeUndefined();
    expect(erro).toHaveBeenCalledWith(
      "pos_resposta.tarefa_falhou",
      expect.objectContaining({ tarefa: "pelo-after" }),
    );
  });
});

describe("regras vigiadas no FONTE", () => {
  const fonte = fs.readFileSync(path.join(process.cwd(), "lib/http/pos-resposta.ts"), "utf8");
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("a detecção é pelo CÓDIGO do erro, não só pelo texto da mensagem", () => {
    expect(codigo).toContain("__NEXT_ERROR_CODE");
    // A mensagem é rede de segurança, e a ordem importa: o código é testado
    // primeiro. Um `return` baseado só em texto seria contrato com uma string.
    expect(codigo.indexOf("__NEXT_ERROR_CODE")).toBeLessThan(codigo.indexOf("was called outside a request scope"));
  });

  it("nenhum catch vazio: todo caminho de erro loga ou relança", () => {
    expect(codigo).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
    expect(codigo).toMatch(/throw e;/);
    expect(codigo).toMatch(/logger\.error\(/);
  });
});

describe("erro inesperado do after() NÃO é engolido", () => {
  it("relança o que não for fora-de-escopo, em vez de silenciar trabalho", async () => {
    vi.doMock("next/server", () => ({
      after: () => {
        throw new Error("configuração do Next quebrada");
      },
    }));
    const { agendarPosResposta: agendar } = await import("./pos-resposta");

    let rodou = false;
    expect(() =>
      agendar("teste", async () => {
        rodou = true;
      }),
    ).toThrow("configuração do Next quebrada");
    // E não executou por baixo: um erro desconhecido não vira fallback.
    expect(rodou).toBe(false);
  });

  it("reconhece o fora-de-escopo pelo CÓDIGO, não só pela mensagem", async () => {
    vi.doMock("next/server", () => ({
      after: () => {
        const e = new Error("mensagem que ninguém previu");
        Object.defineProperty(e, "__NEXT_ERROR_CODE", { value: "E468" });
        throw e;
      },
    }));
    const { agendarPosResposta: agendar } = await import("./pos-resposta");

    let rodou = false;
    agendar("teste", async () => {
      rodou = true;
    });
    await vi.waitFor(() => expect(rodou).toBe(true));
  });
});
