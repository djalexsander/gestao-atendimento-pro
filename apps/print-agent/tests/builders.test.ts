import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiagnosticDocument, buildDocument } from "../src/core/document-builders.ts";
import { columnsFor, layout } from "../src/core/document.ts";
import { toJobModel, type JobModel } from "../src/core/model.ts";
import { renderText } from "../src/core/text-renderer.ts";

function job(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): JobModel {
  return toJobModel({ id: "j1", job_type: type, attempts: 1, device_name: "Impressora Balcão", paper_width: 80, windows_printer_name: "POS-80", payload, ...extra })!;
}
const text80 = (j: JobModel) => renderText(buildDocument(j), 48);
const COMPANY = { name: "ALEXPROAPPS" };

const order = job("production_order", {
  company: COMPANY,
  service_point: { label: "Comanda CMD005" },
  customer_name: "Fulano",
  operator: { name: "JULIANA" },
  sent_at: "2026-10-01T17:32:00Z",
  items: [
    { quantity: 2, product_name: "Espeto de Carne", notes: "sem cebola", sector: { name: "Churrasqueira" } },
    { quantity: 1, product_name: "Espeto de Frango", notes: null, sector: { name: "Churrasqueira" } },
  ],
});

test("pedido de produção: setor, comanda, quantidade em destaque, observação separada, SEM preço", () => {
  const out = text80(order);
  const joined = out.join("\n");
  assert.ok(joined.includes("CHURRASQUEIRA"));
  assert.ok(joined.includes("COMANDA CMD005"));
  assert.ok(joined.includes("2x ESPETO DE CARNE"));
  assert.ok(joined.includes(">> OBS: SEM CEBOLA"));
  assert.ok(joined.includes("1x ESPETO DE FRANGO"));
  assert.ok(joined.includes("Pedido: 14:32"), "horário em America/Sao_Paulo");
  assert.ok(joined.includes("Atendente: JULIANA"));
  assert.ok(!/R\$|\d+,\d\d/.test(joined), "pedido de produção não mostra preço");
  const lines = layout(buildDocument(order), 48);
  const itemLines = lines.filter((l) => l.kind === "text" && /^\dx /.test(l.text));
  assert.ok(itemLines.length >= 2 && itemLines.every((l) => l.kind === "text" && l.size === 2 && l.bold), "itens grandes e em negrito");
});

test("pedido com vários setores agrupa por setor", () => {
  const multi = job("production_order", { ...order.payload, items: [{ quantity: 1, product_name: "X", sector: { name: "Bar" } }, { quantity: 1, product_name: "Y", sector: { name: "Cozinha" } }] });
  const joined = text80(multi).join("\n");
  assert.ok(joined.includes("[ BAR ]") && joined.includes("[ COZINHA ]"));
});

test("cancelamento: chamativo e inequívoco", () => {
  const j = job("production_cancellation", {
    service_point: { label: "Comanda CMD005" },
    reason: "Cliente desistiu",
    cancelled_by: { name: "JULIANA" },
    cancelled_at: "2026-10-01T17:38:00Z",
    items: [{ quantity: 1, product_name: "Espeto de Carne" }],
  });
  const joined = text80(j).join("\n");
  assert.ok(joined.includes("*".repeat(48)));
  assert.ok(joined.includes("CANCELAMENTO"));
  assert.ok(joined.includes("1x ESPETO DE CARNE"));
  assert.ok(joined.includes("CLIENTE DESISTIU"));
  assert.ok(joined.includes("Cancelado por:") && joined.includes("JULIANA") && joined.includes("14:38"));
  const big = layout(buildDocument(j), 48).find((l) => l.kind === "text" && l.text.includes("CANCELAMENTO"));
  assert.ok(big && big.kind === "text" && big.size === 2 && big.bold);
  assert.ok(!joined.includes("PEDIDO"), "não pode parecer pedido novo");
});

test("conta / pré-conta: colunas, total e rodapé não fiscal", () => {
  const j = job("customer_bill", {
    company: COMPANY,
    service_point: { label: "Comanda CMD005" },
    customer_name: "Fulano",
    total: 32,
    printed_at: "2026-10-01T17:40:00Z",
    requested_by: { name: "ALEX" },
    footer: "Documento não fiscal",
    items: [
      { quantity: 2, product_name: "Espeto", unit_price: 12, total: 24 },
      { quantity: 1, product_name: "Coca-Cola", unit_price: 8, total: 8 },
    ],
  });
  const out = text80(j);
  assert.ok(out.some((l) => /^QTD {2}PRODUTO\s+VALOR$/.test(l) && l.length === 48));
  assert.ok(out.some((l) => /^2 {4}ESPETO\s+24,00$/.test(l)));
  assert.ok(out.some((l) => /^1 {4}COCA-COLA\s+8,00$/.test(l)));
  assert.ok(out.some((l) => /^TOTAL\s+32,00$/.test(l) && l.length === 48));
  assert.ok(out.join("\n").includes("CONTA / PRÉ-CONTA") && out.join("\n").includes("Documento não fiscal"));
});

test("comprovante: formas de pagamento, troco, estorno e líquido", () => {
  const j = job("payment_receipt", {
    company: COMPANY,
    service_point: { label: "Comanda CMD005" },
    total: 104,
    payments: [
      { label: "Dinheiro", amount: 80, amount_received: 100, change_amount: 20 },
      { label: "Pix", amount: 24, amount_received: null, change_amount: 0 },
    ],
    paid_total: 104,
    refunds: [{ amount: 10 }],
    refunded_total: 10,
    net_total: 94,
    footer: "Documento não fiscal",
  });
  const joined = text80(j).join("\n");
  assert.ok(joined.includes("COMPROVANTE DE PAGAMENTO"));
  assert.ok(/Dinheiro\s+R\$ 80,00/.test(joined) && /Pix\s+R\$ 24,00/.test(joined));
  assert.ok(joined.includes("Entregue: R$ 100,00") && joined.includes("Troco: R$ 20,00"));
  assert.ok(/Estorno\s+-R\$ 10,00/.test(joined) && /LÍQUIDO\s+R\$ 94,00/.test(joined));
});

test("fechamento de caixa: seções e conferência (FALTA / SOBRA / CONFERE)", () => {
  const base = {
    company: COMPANY,
    operator: { name: "ALEX" },
    opened_at: "2026-10-01T11:00:00Z",
    closed_at: "2026-10-01T21:00:00Z",
    opening_amount: 100,
    sales: { cash: 80, pix: 30.5, debit_card: 0, credit_card: 0, other: 0 },
    supplies: 50,
    withdrawals: 30,
    refunds: 0,
    expected_cash: 200,
    counted_cash: 195,
    closing_notes: "Troco errado",
    printed_at: "2026-10-01T21:05:00Z",
  };
  const falta = text80(job("cash_closing", { ...base, difference_label: "FALTA R$ 5,00" })).join("\n");
  assert.ok(falta.includes("FECHAMENTO DE CAIXA") && falta.includes("FALTA R$ 5,00") && falta.includes("Troco errado"));
  assert.ok(/Dinheiro esperado\s+R\$ 200,00/.test(falta) && /Dinheiro informado\s+R\$ 195,00/.test(falta));
  assert.ok(/Pix\s+R\$ 30,50/.test(falta) && /Suprimentos\s+R\$ 50,00/.test(falta) && /Sangrias\s+R\$ 30,00/.test(falta));
  assert.ok(text80(job("cash_closing", { ...base, difference_label: "CONFERE", closing_notes: null })).join("\n").includes("CONFERE"));
  assert.ok(text80(job("cash_closing", { ...base, difference_label: "SOBRA R$ 2,00" })).join("\n").includes("SOBRA R$ 2,00"));
});

test("reimpressão: destaque *** REIMPRESSÃO *** no TOPO de qualquer tipo", () => {
  for (const type of ["production_order", "production_cancellation", "customer_bill", "payment_receipt", "cash_closing", "test"]) {
    const j = job(type, { ...order.payload, reprint: { label: "*** REIMPRESSÃO ***", requested_at: "2026-10-01T18:00:00Z" } });
    const out = text80(j);
    assert.ok(out[0].includes("*** REIMPRESSÃO ***"), `${type} sem destaque`);
  }
});

test("58 mm: nenhuma linha passa de 32 colunas (16 em tamanho dobrado), nada se perde", () => {
  const j = job("production_order", { ...order.payload, items: [{ quantity: 12, product_name: "Espeto Especial de Carne com Queijo Coalho", notes: "bem passado e sem pimenta nenhuma", sector: { name: "Churrasqueira" } }] }, { paper_width: 58 });
  const cols = columnsFor(58);
  const lines = layout(buildDocument(j), cols);
  for (const l of lines) if (l.kind === "text") assert.ok(l.text.length <= (l.size === 2 ? cols / 2 : cols), `"${l.text}" estoura`);
  const all = lines.map((l) => (l.kind === "text" ? l.text : "")).join(" ");
  for (const word of ["ESPETO", "ESPECIAL", "QUEIJO", "COALHO", "PIMENTA", "NENHUMA"]) assert.ok(all.includes(word), `perdeu ${word}`);
});

test("teste do servidor e teste de diagnóstico", () => {
  const server = text80(job("test", { requested_at: "2026-10-01T17:00:00Z" })).join("\n");
  assert.ok(server.includes("TESTE DE IMPRESSÃO") && server.includes("IMPRESSÃO OK") && server.includes("Impressora Balcão"));
  const diag = renderText(buildDiagnosticDocument({ printerName: "POS-80", paperWidth: 80, codePage: "cp850" }), 48).join("\n");
  for (const s of ["GESTÃO ATENDIMENTO PRO", "TESTE DE IMPRESSÃO", "á é í ó ú", "ã õ", "ç", "PRODUÇÃO", "1234567890", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "POS-80", "80 mm", "CP850", "IMPRESSÃO OK"]) {
    assert.ok(diag.includes(s), `faltou ${s}`);
  }
});
