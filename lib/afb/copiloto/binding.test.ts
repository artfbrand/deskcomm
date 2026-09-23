/**
 * A regra de precedência do binding — medida nas duas fontes e nas bordas.
 *
 * O que este arquivo existe para impedir, em uma frase: que o funil passe a
 * servir um playbook DIFERENTE do que alguém escolheu, sem que nada acuse.
 * Por isso os casos mais cuidados não são os felizes — são os três em que as
 * duas fontes discordam, e aquele em que a fonte persistida está presente e
 * ilegível.
 *
 * Os exemplos do lado LEGADO são deliberadamente os mesmos de
 * `lib/pipelines/modulos.test.ts` ("playbookIdDoCopiloto — leitura genérica,
 * só a forma"): o binding delega a leitura àquele módulo, e reusar o corpus
 * é o que torna visível se um dos dois mudar de opinião sobre a mesma entrada.
 */
import { describe, expect, it } from "vitest";

import { lerBindingDoCopiloto, type BindingDoCopiloto } from "./binding";

/** UUID com a forma que a coluna `uuid` aceita. */
const UUID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const OUTRO_UUID = "cccccccc-cccc-4ccc-8ccc-000000000002";
/** Id de registry — o vocabulário legado, e o corpus de `modulos.test.ts`. */
const LEGADO = "afb_comercial_v1";

const comLegado = (playbookId: unknown) => ({
  modulos: { copiloto_comercial: { enabled: true, playbook_id: playbookId } },
});

const ler = (aiPlaybookId: unknown, settings: Record<string, unknown> | null | undefined = null) =>
  lerBindingDoCopiloto({ aiPlaybookId, settings });

describe("uma fonte de cada vez", () => {
  it("1. persistido sozinho", () => {
    expect(ler(UUID)).toEqual({ origem: "persistido", aiPlaybookId: UUID });
  });

  it("2. legado sozinho", () => {
    expect(ler(null, comLegado(LEGADO))).toEqual({ origem: "legado", registryPlaybookId: LEGADO });
  });

  it("4. nenhuma das duas", () => {
    expect(ler(null, null)).toEqual({ origem: "ausente" });
    expect(ler(undefined, undefined)).toEqual({ origem: "ausente" });
  });
});

describe("quando as duas fontes falam, o persistido vence", () => {
  it("3. ambos válidos e DIFERENTES: vence o ponteiro, e o legado não aparece", () => {
    const r = ler(UUID, comLegado(LEGADO));
    expect(r).toEqual({ origem: "persistido", aiPlaybookId: UUID });
    // O resultado NUNCA carrega os dois: quem lê não tem como escolher errado.
    expect(r).not.toHaveProperty("registryPlaybookId");
  });

  it("5. persistido null cede a vez ao legado", () => {
    expect(ler(null, comLegado(LEGADO))).toEqual({ origem: "legado", registryPlaybookId: LEGADO });
  });

  it("5b. persistido undefined (coluna não pedida no select) também cede", () => {
    expect(ler(undefined, comLegado(LEGADO))).toEqual({ origem: "legado", registryPlaybookId: LEGADO });
  });
});

/**
 * ─── A decisão do arquivo, isolada e medida ─────────────────────────────────
 *
 * Valor PRESENTE e ilegível não cai para o legado: para em `ausente`.
 *
 * `null` é a fonte persistida dizendo "nada a declarar"; um valor presente é
 * alguém tendo declarado um vínculo. Honrar o legado quando a declaração está
 * ilegível serviria um playbook DIFERENTE do escolhido, em silêncio.
 *
 * Estes casos são inalcançáveis pelo banco — a coluna é `uuid` e o Postgres
 * recusa a forma errada. Eles existem aqui para congelar a DECISÃO, não para
 * descrever algo que acontece em produção.
 */
describe("persistido presente e ILEGÍVEL para em ausente — nunca cai para o legado", () => {
  const ilegiveis: Array<[string, unknown]> = [
    ["6. string vazia", ""],
    ["7. UUID malformado (grupos errados)", "bbbbbbbb-bbbb-4bbb-8bbb-00000000000"],
    ["7b. UUID sem hífens", "bbbbbbbbbbbb4bbb8bbb000000000001"],
    ["7c. hexa inválido", "zzzzzzzz-bbbb-4bbb-8bbb-000000000001"],
    ["7d. id de registry na coluna do UUID", LEGADO],
    ["7e. número", 42],
    ["7f. objeto", {}],
    ["7g. array", []],
    ["7h. booleano", true],
  ];

  for (const [nome, valor] of ilegiveis) {
    it(`${nome}: ausente mesmo COM legado válido ao lado`, () => {
      expect(ler(valor, comLegado(LEGADO)), nome).toEqual({ origem: "ausente" });
    });
  }

  it("e o contraste que dá sentido à decisão: só null/undefined liberam o legado", () => {
    expect(ler("", comLegado(LEGADO))).toEqual({ origem: "ausente" });
    expect(ler(null, comLegado(LEGADO))).toEqual({ origem: "legado", registryPlaybookId: LEGADO });
  });
});

describe("legado inválido nunca vira binding", () => {
  it("8. o corpus de modulos.test.ts, com o persistido ausente", () => {
    for (const id of ["", "Comercial AFB", "afb_comercial", "AFB_V1", 1, {}, [], null]) {
      expect(ler(null, comLegado(id)), String(id)).toEqual({ origem: "ausente" });
    }
  });

  it("8b. legado com forma válida mas nome qualquer é aceito — a forma é o contrato", () => {
    // `playbookIdDoCopiloto` valida FORMA, não pertencimento ao registry; quem
    // resolve o id é o gate. Repetir a checagem aqui seria resolver playbook,
    // que é justamente o que esta camada não faz.
    expect(ler(null, comLegado("qualquer_coisa_v7"))).toEqual({
      origem: "legado",
      registryPlaybookId: "qualquer_coisa_v7",
    });
  });
});

describe("os dois vocabulários não se confundem", () => {
  it("9. UUID nunca é lido como id legado", () => {
    // Na coluna certa vira persistido; na posição do legado, não vira nada.
    expect(ler(UUID)).toEqual({ origem: "persistido", aiPlaybookId: UUID });
    expect(ler(null, comLegado(UUID))).toEqual({ origem: "ausente" });
  });

  it("10. id legado nunca é lido como UUID", () => {
    expect(ler(null, comLegado(LEGADO))).toEqual({ origem: "legado", registryPlaybookId: LEGADO });
    expect(ler(LEGADO)).toEqual({ origem: "ausente" });
  });

  it("10b. trocar as duas fontes de lugar não produz binding nenhum", () => {
    expect(ler(LEGADO, comLegado(UUID))).toEqual({ origem: "ausente" });
  });
});

describe("a origem é sempre explícita", () => {
  it("11. todo resultado tem origem, e ela é uma das três", () => {
    const casos: unknown[][] = [
      [UUID, null],
      [null, comLegado(LEGADO)],
      [null, null],
      ["torto", comLegado(LEGADO)],
      [OUTRO_UUID, comLegado("qualquer_coisa_v7")],
      [undefined, {}],
    ];
    for (const [ai, settings] of casos) {
      const r = ler(ai, settings as Record<string, unknown> | null);
      expect(["persistido", "legado", "ausente"], JSON.stringify([ai, settings])).toContain(r.origem);
      // Nunca "ausente" carregando identificador pendurado.
      if (r.origem === "ausente") expect(Object.keys(r)).toEqual(["origem"]);
    }
  });

  it("11b. o discriminante é suficiente para o TypeScript escolher o campo", () => {
    const r: BindingDoCopiloto = ler(UUID);
    // Sem cast: se a união não fosse discriminada, isto não compilaria.
    expect(r.origem === "persistido" ? r.aiPlaybookId : null).toBe(UUID);
  });
});

describe("a função não muta a entrada", () => {
  it("12. settings sai exatamente como entrou, inclusive congelado", () => {
    const settings = Object.freeze(comLegado(LEGADO));
    const antes = JSON.stringify(settings);
    expect(() => ler(null, settings)).not.toThrow();
    expect(JSON.stringify(settings)).toBe(antes);
  });

  it("12b. nem quando o persistido vence e o legado é ignorado", () => {
    const settings = comLegado(LEGADO);
    const antes = JSON.stringify(settings);
    ler(UUID, settings);
    expect(JSON.stringify(settings)).toBe(antes);
  });
});

describe("settings torto não derruba a leitura", () => {
  it("13. settings ausente, null, array ou tipo errado", () => {
    for (const s of [null, undefined, {}, { modulos: null }, { modulos: [] }, { modulos: 1 }]) {
      expect(ler(null, s as Record<string, unknown> | null), String(s)).toEqual({ origem: "ausente" });
    }
  });

  it("14. copiloto_comercial ausente, ou presente sem playbook_id", () => {
    expect(ler(null, { modulos: {} })).toEqual({ origem: "ausente" });
    expect(ler(null, { modulos: { copiloto_comercial: {} } })).toEqual({ origem: "ausente" });
    expect(ler(null, { modulos: { copiloto_comercial: { enabled: true } } })).toEqual({ origem: "ausente" });
    expect(ler(null, { modulos: { copiloto_comercial: [] } })).toEqual({ origem: "ausente" });
  });

  it("14b. o módulo DESLIGADO não muda o binding — quem lê enabled é o gate", () => {
    // Binding e interruptor são perguntas diferentes: um funil desligado pode
    // continuar apontando para um playbook, e é o gate que decide não usar.
    expect(ler(null, { modulos: { copiloto_comercial: { enabled: false, playbook_id: LEGADO } } })).toEqual({
      origem: "legado",
      registryPlaybookId: LEGADO,
    });
    expect(ler(UUID, { modulos: { copiloto_comercial: { enabled: false } } })).toEqual({
      origem: "persistido",
      aiPlaybookId: UUID,
    });
  });
});

describe("regras vigiadas no FONTE", () => {
  it("não consulta banco, não resolve playbook e não conhece cliente nenhum", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(path.join(process.cwd(), "lib/afb/copiloto/binding.ts"), "utf8");
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const proibido of ["supabase", "createClient", "createAdminClient", ".from(", "await "]) {
      expect(codigo, proibido).not.toContain(proibido);
    }
    // Não resolve playbook nem traduz para slug.
    expect(codigo).not.toContain("getPlaybook");
    expect(codigo).not.toContain("slug");
    // Nenhum hardcode de cliente: o módulo é genérico apesar de morar em lib/afb.
    expect(codigo).not.toMatch(/afb_[a-z]/);
  });
});
