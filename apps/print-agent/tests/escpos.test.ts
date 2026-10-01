import assert from "node:assert/strict";
import { test } from "node:test";
import { bold, big, center, cut, feed, text, type CodePage, type PrintDocument } from "../src/core/document.ts";
import { codePageTable, encodeChar, encodeText, renderEscPos } from "../src/core/escpos.ts";

const render = (doc: PrintDocument, codePage: CodePage = "cp850", cutMode: "none" | "partial" | "full" = "partial", columns = 48) =>
  Array.from(renderEscPos(doc, { columns, codePage, cutMode }));
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

test("inicialização: ESC @ e seleção de code page (ESC t n)", () => {
  assert.deepEqual(render({ blocks: [] }, "cp850").slice(0, 5), [0x1b, 0x40, 0x1b, 0x74, 0x02]);
  assert.deepEqual(render({ blocks: [] }, "cp860").slice(0, 5), [0x1b, 0x40, 0x1b, 0x74, 0x03]);
  assert.deepEqual(render({ blocks: [] }, "cp1252").slice(0, 5), [0x1b, 0x40, 0x1b, 0x74, 0x10]);
});

test("texto simples termina com LF", () => {
  const out = render({ blocks: [text("OI")] });
  assert.deepEqual(out.slice(5, 8), [...ascii("OI"), 0x0a].slice(0, 3));
  assert.ok(hex(out).includes("4f 49 0a"));
});

test("negrito liga e desliga (ESC E 1 / ESC E 0) só quando muda", () => {
  const h = hex(render({ blocks: [bold("A"), text("B")] }));
  assert.ok(h.includes("1b 45 01 41 0a 1b 45 00 42 0a"), h);
});

test("tamanho dobrado: GS ! 0x11 e volta ao normal", () => {
  const h = hex(render({ blocks: [big("A"), text("B")] }));
  assert.ok(h.includes("1d 21 11"), h);
  assert.ok(h.includes("1d 21 00 42"), "volta ao normal antes do próximo texto normal");
});

test("alinhamento: ESC a 1 (centro) e volta a ESC a 0", () => {
  const h = hex(render({ blocks: [center("X"), text("Y")] }));
  assert.ok(h.includes("1b 61 01 58 0a 1b 61 00 59"), h);
});

test("avanço de papel: ESC d n", () => {
  assert.ok(hex(render({ blocks: [feed(3)] })).includes("1b 64 03"));
});

test("corte parcial / total / nenhum (avança 4 linhas antes e restaura estado)", () => {
  const doc: PrintDocument = { blocks: [bold("FIM"), cut()] };
  const partial = hex(render(doc, "cp850", "partial"));
  assert.ok(partial.endsWith("1b 61 00 1b 45 00 1d 21 00 1b 64 04 1d 56 01"), partial);
  assert.ok(hex(render(doc, "cp850", "full")).endsWith("1b 64 04 1d 56 00"));
  const none = hex(render(doc, "cp850", "none"));
  assert.ok(none.endsWith("1b 64 04") && !none.includes("1d 56"));
});

test("documento sem bloco cut só avança o papel (nunca corta sozinho)", () => {
  const h = hex(render({ blocks: [text("A")] }));
  assert.ok(h.endsWith("1b 64 03") && !h.includes("1d 56"));
});

test("code pages: tabelas completas (128) e bytes de português corretos", () => {
  assert.equal(Array.from(codePageTable("cp850")).length, 128);
  assert.equal(Array.from(codePageTable("cp860")).length, 128);
  const pt = "áéíóúãõçÇÃÕÁÉÍÓÚÊÂÀÜüêôâà";
  const expect850 = [0xa0, 0x82, 0xa1, 0xa2, 0xa3, 0xc6, 0xe4, 0x87, 0x80, 0xc7, 0xe5, 0xb5, 0x90, 0xd6, 0xe0, 0xe9, 0xd2, 0xb6, 0xb7, 0x9a, 0x81, 0x88, 0x93, 0x83, 0x85];
  assert.deepEqual(encodeText(pt, "cp850"), expect850);
  const expect860 = [0xa0, 0x82, 0xa1, 0xa2, 0xa3, 0x84, 0x94, 0x87, 0x80, 0x8e, 0x99, 0x86, 0x90, 0x8b, 0x9f, 0x96, 0x89, 0x8f, 0x91, 0x9a, 0x81, 0x88, 0x93, 0x83, 0x85];
  assert.deepEqual(encodeText(pt, "cp860"), expect860);
  assert.deepEqual(encodeText("çãõéÇ", "cp1252"), [0xe7, 0xe3, 0xf5, 0xe9, 0xc7]);
  assert.equal(encodeChar("€", "cp1252"), 0x80);
});

test("palavras do teste físico saem com os bytes certos (CP850)", () => {
  // GESTÃO -> ... Ã = 0xC7 ; IMPRESSÃO ; PRODUÇÃO -> Ç = 0x80
  assert.deepEqual(encodeText("GESTÃO", "cp850"), [...ascii("GEST"), 0xc7, ...ascii("O")]);
  assert.deepEqual(encodeText("PRODUÇÃO", "cp850"), [...ascii("PRODU"), 0x80, 0xc7, ...ascii("O")]);
});

test("caractere desconhecido: tenta a letra base, senão '?' (nunca quebra); tipografia vira ASCII", () => {
  assert.equal(encodeChar("ā", "cp850"), "a".charCodeAt(0));
  assert.equal(encodeChar("漢", "cp850"), 0x3f);
  assert.deepEqual(encodeText("a—b “c”…", "cp850"), ascii('a-b "c"...'));
  assert.deepEqual(encodeText("ç", "cp850").length, 1);
});

test("só ASCII e bytes de comando: nenhum caractere acima de 0xFF vaza", () => {
  const bytes = render({ blocks: [center("GESTÃO ATENDIMENTO PRO — ✂ → ok", { bold: true }), cut()] });
  assert.ok(bytes.every((b) => b >= 0 && b <= 0xff));
});
