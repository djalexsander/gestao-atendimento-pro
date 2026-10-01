import assert from "node:assert/strict";
import { test } from "node:test";
import { bold, big, center, cut, divider, feed, layout, PAPER_COLUMNS, row, text, wrapText, columnsFor } from "../src/core/document.ts";
import { renderText } from "../src/core/text-renderer.ts";

test("larguras de papel ficam centralizadas: 80 mm = 48, 58 mm = 32", () => {
  assert.equal(columnsFor(80), 48);
  assert.equal(columnsFor(58), 32);
  assert.deepEqual(PAPER_COLUMNS, { 58: 32, 80: 48 });
});

test("wrap por palavras e respeito ao \\n", () => {
  assert.deepEqual(wrapText("ESPETO DE CARNE COM QUEIJO", 10), ["ESPETO DE", "CARNE COM", "QUEIJO"]);
  assert.deepEqual(wrapText("a\nb", 10), ["a", "b"]);
});

test("palavra maior que a linha é PARTIDA, nunca cortada em silêncio", () => {
  const lines = wrapText("PNEUMOULTRAMICROSCOPICO", 10);
  assert.ok(lines.every((l) => l.length <= 10));
  assert.equal(lines.join(""), "PNEUMOULTRAMICROSCOPICO");
});

for (const width of [58, 80] as const) {
  test(`wrap ${width} mm: nome grande quebra sem perder nenhuma palavra`, () => {
    const cols = columnsFor(width);
    const name = "ESPETO ESPECIAL DE CARNE COM QUEIJO COALHO E MOLHO DA CASA";
    const lines = layout({ blocks: [row(`2    ${name}`, "24,00", { indent: 5 })] }, cols);
    const texts = lines.map((l) => (l.kind === "text" ? l.text : ""));
    assert.ok(texts.every((t) => t.length <= cols), `linha maior que ${cols}`);
    assert.ok(texts[0].endsWith("24,00"), "valor na 1ª linha");
    const words = texts.join(" ").replace("24,00", "").split(/\s+/).filter(Boolean);
    assert.deepEqual(words, `2 ${name}`.split(/\s+/), "nenhuma palavra perdida");
    assert.ok(texts[1].startsWith("     "), "continuação recuada");
  });
}

test("linha de total: esquerda e direita preenchem exatamente a largura", () => {
  for (const cols of [32, 48]) {
    const [line] = layout({ blocks: [row("TOTAL", "32,00", { bold: true })] }, cols);
    assert.equal(line.kind === "text" && line.text.length, cols);
    assert.ok(line.kind === "text" && line.text.startsWith("TOTAL") && line.text.endsWith("32,00") && line.bold);
  }
});

test("tamanho dobrado usa metade das colunas", () => {
  const lines = layout({ blocks: [big("2x ESPETO DE CARNE DE SOL")] }, 32);
  assert.ok(lines.every((l) => l.kind === "text" && l.text.length <= 16 && l.size === 2 && l.bold));
});

test("divider ocupa a linha toda e aceita outro caractere", () => {
  const lines = layout({ blocks: [divider(), divider("*")] }, 32);
  assert.deepEqual(lines.map((l) => (l.kind === "text" ? l.text : "")), ["-".repeat(32), "*".repeat(32)]);
});

test("alinhamento: o preview centraliza e alinha à direita pela largura visual", () => {
  const out = renderText({ blocks: [center("ABC"), text("DIREITA", { align: "right" }), big("AB", { align: "center" })] }, 20);
  assert.equal(out[0], " ".repeat(8) + "ABC");
  assert.equal(out[1], " ".repeat(13) + "DIREITA");
  assert.equal(out[2], " ".repeat(8) + "AB"); // 2 chars em tamanho 2 = 4 colunas -> (20-4)/2 = 8
});

test("feed e cut viram linhas/marcador no preview", () => {
  const out = renderText({ blocks: [bold("X"), feed(2), cut()] }, 32);
  assert.equal(out.length, 4);
  assert.equal(out[1], "");
  assert.ok(out[3].includes("corte"));
});
