import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiagnosticDocument } from "../src/core/document-builders.ts";
import { defaultDiagnosticPrinter, isVirtualPrinter, looksLikeLabelPrinter } from "../src/core/printer-kind.ts";
import { RawEscPosPrinterTransport, RawPrinterError, SimulationPrinterTransport, type RawPrinterPort } from "../src/core/transport.ts";

const document = buildDiagnosticDocument({ printerName: "POS-80", paperWidth: 80, codePage: "cp850" });
const req = { printerName: "POS-80", paperWidth: 80 as const, codePage: "cp850" as const, cutMode: "partial" as const, document };

test("simulação: devolve preview e NÃO usa nenhuma porta de impressora", async () => {
  const result = await new SimulationPrinterTransport().print({ ...req, printerName: null });
  assert.equal(result.mode, "simulation");
  assert.ok(result.preview.some((l) => l.includes("IMPRESSÃO OK")));
  assert.equal(result.bytes, undefined);
});

test("RAW (mock): envia bytes ESC/POS à impressora certa, com a finalidade informada", async () => {
  const sent: Array<{ printer: string; bytes: Uint8Array; purpose: string }> = [];
  const port: RawPrinterPort = { printRaw: async (printer, bytes, purpose) => void sent.push({ printer, bytes, purpose }) };
  const result = await new RawEscPosPrinterTransport(port, "diagnostic").print(req);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].printer, "POS-80");
  assert.equal(sent[0].purpose, "diagnostic");
  assert.deepEqual(Array.from(sent[0].bytes.slice(0, 5)), [0x1b, 0x40, 0x1b, 0x74, 0x02]);
  assert.equal(result.mode, "real");
  assert.equal(result.bytes, sent[0].bytes.length);
});

test("RAW (mock): erro do spooler sobe como RawPrinterError com mensagem amigável", async () => {
  const port: RawPrinterPort = {
    printRaw: async () => {
      throw "Acesso negado à impressora. Verifique as permissões do Windows para este usuário. (erro 5 do Windows)";
    },
  };
  await assert.rejects(
    () => new RawEscPosPrinterTransport(port, "diagnostic").print(req),
    (e: unknown) => e instanceof RawPrinterError && /Acesso negado/.test((e as Error).message),
  );
});

test("RAW sem impressora selecionada não chama a porta", async () => {
  let called = false;
  const port: RawPrinterPort = { printRaw: async () => void (called = true) };
  await assert.rejects(() => new RawEscPosPrinterTransport(port, "diagnostic").print({ ...req, printerName: null }), RawPrinterError);
  assert.equal(called, false);
});

test("heurísticas: virtual, etiquetas e seleção padrão do diagnóstico (POS-80)", () => {
  assert.ok(isVirtualPrinter("Microsoft Print to PDF") && isVirtualPrinter("OneNote (Desktop)"));
  assert.ok(!isVirtualPrinter("POS-80"));
  assert.ok(looksLikeLabelPrinter("LABEL") && !looksLikeLabelPrinter("POS-80"));
  const found = [
    { name: "POS-80", isDefault: true },
    { name: "LABEL", isDefault: false },
    { name: "Microsoft Print to PDF", isDefault: false },
    { name: "OneNote (Desktop)", isDefault: false },
  ];
  assert.equal(defaultDiagnosticPrinter(found), "POS-80");
  assert.equal(defaultDiagnosticPrinter([{ name: "Microsoft Print to PDF", isDefault: true }, { name: "LABEL", isDefault: false }]), "", "nunca seleciona virtual/etiqueta sozinho");
  assert.equal(defaultDiagnosticPrinter([{ name: "LABEL", isDefault: true }, { name: "EPSON TM-T20", isDefault: false }]), "EPSON TM-T20", "padrão LABEL é pulado");
});
