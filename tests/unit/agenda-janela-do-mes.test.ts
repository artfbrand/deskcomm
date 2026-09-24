/**
 * A janela da visão Mês: o que a grade DESENHA é o que a busca PEDE.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * A grade desenha seis semanas, derramando dias dos meses vizinhos. A busca
 * pedia o mês CIVIL. As duas contas viviam em arquivos diferentes, e o
 * resultado era uma célula desenhada e VAZIA: o dia aparece, e a ocupação dele
 * nunca foi buscada.
 *
 * Em 2026-09-24 isso reprovou `agenda-ocupacao-do-google-na-grade.spec.ts` duas
 * vezes seguidas, num PR que só mexia numa rota do Inbox — a falha acusou o
 * inocente. A spec nasceu em 2026-09-08, e essa foi a primeira vez que ela
 * atravessou uma virada de mês.
 *
 * ─── Por que o caso de 2026-10-01 é o centro deste arquivo ──────────────────
 *
 * Ele é o caso REAL que quebrou, reconstruído: âncora em 2026-10-01, evento em
 * 2026-09-30. Antes da correção, `startOfMonth(ancora)` = 2026-10-01, e o
 * evento ficava um dia FORA do intervalo pedido, enquanto a célula dele era
 * desenhada. O primeiro teste abaixo é a regressão dessa data.
 *
 * O invariante que fecha a CLASSE inteira, e não só essa data, é o último bloco:
 * para qualquer âncora, a janela pedida cobre exatamente as células desenhadas.
 */
import { addDays, startOfMonth, startOfWeek } from "date-fns";
import { describe, expect, it } from "vitest";

import {
  DIAS_NA_VISAO_DE_MES,
  PRIMEIRO_DIA_DA_SEMANA,
  SEMANAS_NA_VISAO_DE_MES,
  janelaVisivelDoMes,
  semanasDaVisaoDeMes,
} from "@/lib/agenda/janela-do-mes";

const dia = (d: Date) => d.toISOString().slice(0, 10);

describe("o caso da virada — a regressão de 2026-09-24", () => {
  // Âncora = hoje + 7 quando a suíte rodou em 2026-09-24 (quinta).
  const ancora = new Date(2026, 9, 1); // 2026-10-01
  const evento = new Date(2026, 8, 30, 15, 0, 0); // 2026-09-30 15:00

  it("a janela COMEÇA no domingo da semana do dia 1º, não no dia 1º", () => {
    const { inicio } = janelaVisivelDoMes(ancora);
    expect(dia(inicio)).toBe("2026-09-27");
    // O contraste que define o bug: o mês civil começaria em 01/10.
    expect(dia(startOfMonth(ancora))).toBe("2026-10-01");
    expect(inicio.getTime()).toBeLessThan(startOfMonth(ancora).getTime());
  });

  it("o evento de 2026-09-30 está DENTRO da janela", () => {
    const { inicio, fim } = janelaVisivelDoMes(ancora);
    expect(evento.getTime()).toBeGreaterThanOrEqual(inicio.getTime());
    expect(evento.getTime()).toBeLessThan(fim.getTime());
  });

  it("e a célula dele é uma das desenhadas — desenho e busca concordam", () => {
    const desenhadas = semanasDaVisaoDeMes(ancora).flat().map(dia);
    expect(desenhadas).toContain("2026-09-30");
  });

  it("antes da correção o evento ficava fora: prova do contraste", () => {
    // A conta ANTIGA, reproduzida aqui para que a diferença seja medida e não
    // lembrada. Se alguém restaurar `startOfMonth` no recorte, este teste
    // continua verde — quem reprova é o primeiro deste bloco. Este existe para
    // documentar POR QUE o primeiro exige 09-27.
    const inicioAntigo = startOfMonth(ancora);
    expect(evento.getTime()).toBeLessThan(inicioAntigo.getTime());
  });
});

describe("uma data comum, sem virada no dia alvo", () => {
  // 2026-11-01 é um domingo: o mês começa exatamente no primeiro dia da grade.
  const ancoraDomingo = new Date(2026, 10, 15); // 2026-11-15
  // 2026-07-15: julho de 2026 começa numa quarta — derrama três dias de junho.
  const ancoraQuarta = new Date(2026, 6, 15); // 2026-07-15

  it("mês que começa no domingo: a janela começa no próprio dia 1º", () => {
    const { inicio } = janelaVisivelDoMes(ancoraDomingo);
    expect(dia(inicio)).toBe("2026-11-01");
    expect(inicio.getTime()).toBe(startOfMonth(ancoraDomingo).getTime());
  });

  it("mês que começa no meio da semana: a janela recua para o domingo anterior", () => {
    const { inicio } = janelaVisivelDoMes(ancoraQuarta);
    expect(dia(inicio)).toBe("2026-06-28");
    expect(dia(startOfMonth(ancoraQuarta))).toBe("2026-07-01");
  });

  it("um evento do meio do mês continua dentro, como sempre esteve", () => {
    const { inicio, fim } = janelaVisivelDoMes(ancoraQuarta);
    const meio = new Date(2026, 6, 15, 10, 0, 0);
    expect(meio.getTime()).toBeGreaterThanOrEqual(inicio.getTime());
    expect(meio.getTime()).toBeLessThan(fim.getTime());
  });
});

describe("a janela é exatamente a grade — para QUALQUER âncora", () => {
  it("seis semanas, 42 dias, e o fim é exclusivo", () => {
    expect(SEMANAS_NA_VISAO_DE_MES).toBe(6);
    expect(DIAS_NA_VISAO_DE_MES).toBe(42);
    expect(PRIMEIRO_DIA_DA_SEMANA).toBe(0);
  });

  it("o primeiro dia desenhado é `inicio` e o último é a véspera de `fim`", () => {
    // Doze meses de 2026 mais as duas pontas: cobre todo mês que começa em
    // cada dia da semana, incluindo fevereiro e os meses de 31 dias.
    for (let mes = -1; mes <= 12; mes++) {
      const ancora = new Date(2026, mes, 15);
      const { inicio, fim } = janelaVisivelDoMes(ancora);
      const desenhadas = semanasDaVisaoDeMes(ancora).flat();

      expect(desenhadas.length, dia(ancora)).toBe(DIAS_NA_VISAO_DE_MES);
      expect(dia(desenhadas[0]!), dia(ancora)).toBe(dia(inicio));
      expect(dia(desenhadas[desenhadas.length - 1]!), dia(ancora)).toBe(dia(addDays(fim, -1)));
      // Nenhuma célula desenhada cai fora da janela pedida — é a promessa inteira.
      for (const d of desenhadas) {
        expect(d.getTime() >= inicio.getTime() && d.getTime() < fim.getTime(), dia(d)).toBe(true);
      }
    }
  });

  it("o mês civil inteiro está sempre contido na janela", () => {
    for (let mes = 0; mes < 12; mes++) {
      const ancora = new Date(2026, mes, 15);
      const { inicio, fim } = janelaVisivelDoMes(ancora);
      const primeiroDoMes = startOfMonth(ancora);
      const ultimoDoMes = addDays(startOfMonth(new Date(2026, mes + 1, 1)), -1);
      expect(primeiroDoMes.getTime() >= inicio.getTime(), dia(ancora)).toBe(true);
      expect(ultimoDoMes.getTime() < fim.getTime(), dia(ancora)).toBe(true);
    }
  });

  it("a janela começa sempre num domingo", () => {
    for (let mes = 0; mes < 12; mes++) {
      const { inicio } = janelaVisivelDoMes(new Date(2026, mes, 15));
      expect(inicio.getDay(), `mês ${mes + 1}`).toBe(0);
      expect(inicio.getTime()).toBe(
        startOfWeek(inicio, { weekStartsOn: PRIMEIRO_DIA_DA_SEMANA }).getTime(),
      );
    }
  });
});

describe("regras vigiadas no FONTE — as duas contas não podem divergir de novo", () => {
  it("o recorte de busca usa o módulo, e não recalcula o mês civil", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(path.join(process.cwd(), "app/app/agenda/_client.tsx"), "utf8");
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(codigo).toContain("janelaVisivelDoMes");
    // A conta antiga não pode voltar ao recorte.
    expect(codigo).not.toMatch(/endOfMonth\s*\(/);
    expect(codigo).not.toMatch(/startOfMonth\s*\(/);
  });

  it("a grade desenha pelo módulo, e não por um `6` próprio", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "components/agenda/GradeDaAgenda.tsx"),
      "utf8",
    );
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(codigo).toContain("semanasDaVisaoDeMes");
    expect(codigo).not.toMatch(/startOfMonth\s*\(/);
    expect(codigo).not.toMatch(/Array\.from\(\s*\{\s*length:\s*6\s*\}/);
  });
});
