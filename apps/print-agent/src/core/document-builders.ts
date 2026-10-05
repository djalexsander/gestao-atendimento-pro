import { big, bold, center, cut, divider, feed, row, text, type Block, type CodePage, type PaperWidth, type PrintDocument } from "./document.ts";
import { CODE_PAGE_LABEL } from "./document.ts";
import type { JobItem, JobModel } from "./model.ts";

// Modificadores logo abaixo do item (um por linha, recuados; nunca com preço no ticket de produção).
function modifierBlocks(item: JobItem): Block[] {
  return item.modifiers.map((m) => bold(`   ${m.name.toUpperCase()}`));
}

// REGRAS DE NEGÓCIO do papel: payload (snapshot do servidor) -> PrintDocument. Nenhum comando de
// impressora e nenhuma largura de papel aqui; isso é dos renderers.

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const TZ = "America/Sao_Paulo";
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

function parse(iso: unknown): Date | null {
  const d = typeof iso === "string" ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
export const when = (iso: unknown): string => {
  const d = parse(iso);
  return d ? dateTimeFmt.format(d) : "—";
};
export const hhmm = (iso: unknown): string => {
  const d = parse(iso);
  return d ? timeFmt.format(d) : "—";
};
export const amount = (value: number): string => value.toFixed(2).replace(".", ",");
export const money = (value: number): string => `R$ ${amount(value)}`;

const TITLE = "GESTÃO ATENDIMENTO PRO";

function reprintBanner(job: JobModel): Block[] {
  if (!job.isReprint) return [];
  const re = rec(job.payload.reprint);
  const blocks: Block[] = [center("*** REIMPRESSÃO ***", { bold: true })];
  if (re.requested_at) blocks.push(center(when(re.requested_at)));
  blocks.push(feed(1));
  return blocks;
}

function sectorOf(raw: unknown): string | null {
  const name = str(rec(rec(raw).sector).name);
  return name || null;
}

// Itens agrupados por setor, na ordem em que aparecem.
function groupBySector(job: JobModel): Array<{ sector: string | null; items: JobItem[] }> {
  const rawItems = Array.isArray(job.payload.items) ? job.payload.items : [];
  const groups: Array<{ sector: string | null; items: JobItem[] }> = [];
  job.items.forEach((item, index) => {
    const sector = sectorOf(rawItems[index]);
    let group = groups.find((g) => g.sector === sector);
    if (!group) {
      group = { sector, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  });
  return groups;
}

function productionOrder(job: JobModel): Block[] {
  const pl = job.payload;
  const blocks: Block[] = [...reprintBanner(job), center(TITLE, { bold: true })];
  const groups = groupBySector(job);
  const titled = groups.some((g) => g.sector);
  if (titled && groups.length === 1) blocks.push(feed(1), big(groups[0].sector!.toUpperCase(), { align: "center" }));
  blocks.push(feed(1));
  if (job.pointLabel) blocks.push(big(job.pointLabel.toUpperCase(), { align: "left" }));
  if (job.customerName) blocks.push(text(`Cliente: ${job.customerName}`));
  blocks.push(divider());
  for (const group of groups) {
    if (titled && groups.length > 1) blocks.push(bold(`[ ${(group.sector ?? "SEM SETOR").toUpperCase()} ]`));
    for (const item of group.items) {
      blocks.push(big(`${item.quantity}x ${item.productName.toUpperCase()}`));
      blocks.push(...modifierBlocks(item));
      if (item.notes) blocks.push(bold(`>> OBS: ${item.notes.toUpperCase()}`));
      blocks.push(feed(1));
    }
  }
  blocks.push(divider(), text(`Pedido: ${hhmm(pl.sent_at)}`));
  const operator = str(rec(pl.operator).name);
  if (operator) blocks.push(text(`Atendente: ${operator}`));
  blocks.push(feed(1), cut());
  return blocks;
}

function productionCancellation(job: JobModel): Block[] {
  const pl = job.payload;
  const blocks: Block[] = [...reprintBanner(job), divider("*"), big("CANCELAMENTO", { align: "center" }), divider("*"), feed(1)];
  if (job.pointLabel) blocks.push(bold(job.pointLabel.toUpperCase()));
  blocks.push(feed(1));
  for (const item of job.items) blocks.push(big(`${item.quantity}x ${item.productName.toUpperCase()}`), ...modifierBlocks(item));
  blocks.push(feed(1), bold("Motivo:"), text((str(pl.reason) || "—").toUpperCase()), feed(1));
  blocks.push(bold("Cancelado por:"), text(str(rec(pl.cancelled_by).name) || "—"), text(hhmm(pl.cancelled_at)), feed(1));
  blocks.push(divider("*"), feed(1), cut());
  return blocks;
}

function sessionHeader(job: JobModel, title: string): Block[] {
  const company = str(rec(job.payload.company).name);
  const blocks: Block[] = [...reprintBanner(job), center(TITLE, { bold: true }), center(title, { bold: true })];
  if (company) blocks.push(center(company));
  blocks.push(divider());
  if (job.pointLabel) blocks.push(bold(job.pointLabel.toUpperCase()));
  if (job.customerName) blocks.push(text(`Cliente: ${job.customerName}`));
  return blocks;
}

function footer(job: JobModel): Block[] {
  const pl = job.payload;
  const blocks: Block[] = [feed(1), text(`Impresso: ${when(pl.printed_at)}`)];
  const by = str(rec(pl.requested_by).name);
  if (by) blocks.push(text(`Operador: ${by}`));
  const note = str(pl.footer);
  if (note) blocks.push(divider(), center(note));
  blocks.push(feed(1), cut());
  return blocks;
}

function customerBill(job: JobModel): Block[] {
  const blocks = [...sessionHeader(job, "CONTA / PRÉ-CONTA"), divider(), row("QTD  PRODUTO", "VALOR", { bold: true })];
  for (const item of job.items) {
    const priced = item.modifiers.some((m) => (m.priceDelta ?? 0) > 0);
    const label = `${String(item.quantity).padEnd(4)} ${item.productName.toUpperCase()}`;
    if (priced) {
      // Linha do produto pelo preço BASE; cada adicional pago com seu valor (x quantidade); depois o total do item.
      const itemTotal = item.total ?? 0;
      const extras = item.modifiers.reduce((s, m) => s + (m.priceDelta ?? 0), 0) * item.quantity;
      blocks.push(row(label, amount(itemTotal - extras), { indent: 5 }));
      for (const m of item.modifiers) {
        const delta = (m.priceDelta ?? 0) * item.quantity;
        blocks.push(delta > 0 ? row(`     ${m.name}`, amount(delta), { indent: 7 }) : text(`     ${m.name}`));
      }
      blocks.push(row("     Total do item", amount(itemTotal), { indent: 7, bold: true }));
    } else {
      blocks.push(row(label, amount(item.total ?? 0), { indent: 5 }));
      for (const m of item.modifiers) blocks.push(text(`     ${m.name}`));
    }
    if (item.notes) blocks.push(text(`     Obs: ${item.notes}`));
  }
  blocks.push(divider(), row("TOTAL", amount(num(job.payload.total)), { bold: true }));
  return [...blocks, ...footer(job)];
}

function paymentReceipt(job: JobModel): Block[] {
  const pl = job.payload;
  const blocks = [...sessionHeader(job, "COMPROVANTE DE PAGAMENTO"), divider(), row("Total da conta", money(num(pl.total))), feed(1)];
  for (const entry of Array.isArray(pl.payments) ? pl.payments : []) {
    const pay = rec(entry);
    blocks.push(row(str(pay.label), money(num(pay.amount))));
    if (pay.amount_received !== null && pay.amount_received !== undefined) {
      blocks.push(text(`  Entregue: ${money(num(pay.amount_received))}`), text(`  Troco: ${money(num(pay.change_amount))}`));
    }
  }
  blocks.push(divider(), row("Total pago", money(num(pl.paid_total))));
  const refunds = Array.isArray(pl.refunds) ? pl.refunds : [];
  if (refunds.length > 0) {
    for (const entry of refunds) blocks.push(row("Estorno", `-${money(num(rec(entry).amount))}`));
    blocks.push(row("Total estornado", money(num(pl.refunded_total))));
  }
  blocks.push(row("LÍQUIDO", money(num(pl.net_total)), { bold: true }));
  return [...blocks, ...footer(job)];
}

function cashClosing(job: JobModel): Block[] {
  const pl = job.payload;
  const s = rec(pl.sales);
  const company = str(rec(pl.company).name);
  const blocks: Block[] = [...reprintBanner(job), center(TITLE, { bold: true }), center("FECHAMENTO DE CAIXA", { bold: true })];
  if (company) blocks.push(center(company));
  blocks.push(
    divider(),
    text(`Operador: ${str(rec(pl.operator).name) || "—"}`),
    text(`Abertura: ${when(pl.opened_at)}`),
    text(`Fechamento: ${when(pl.closed_at)}`),
    divider(),
    row("Saldo inicial", money(num(pl.opening_amount))),
    feed(1),
    bold("Vendas"),
    row("  Dinheiro", money(num(s.cash))),
    row("  Pix", money(num(s.pix))),
    row("  Débito", money(num(s.debit_card))),
    row("  Crédito", money(num(s.credit_card))),
    row("  Outros", money(num(s.other))),
    feed(1),
    row("Suprimentos", money(num(pl.supplies))),
    row("Sangrias", money(num(pl.withdrawals))),
    row("Estornos", money(num(pl.refunds))),
    divider(),
    row("Dinheiro esperado", money(num(pl.expected_cash))),
    row("Dinheiro informado", money(num(pl.counted_cash))),
    feed(1),
    big(str(pl.difference_label) || "—", { align: "center" }),
  );
  const notes = str(pl.closing_notes);
  if (notes) blocks.push(feed(1), bold("Observação:"), text(notes));
  blocks.push(feed(1), text(`Impresso: ${when(pl.printed_at)}`));
  const by = str(rec(pl.requested_by).name);
  if (by) blocks.push(text(`Operador da impressão: ${by}`));
  blocks.push(feed(1), cut());
  return blocks;
}

function serverTest(job: JobModel): Block[] {
  return [
    ...reprintBanner(job),
    center(TITLE, { bold: true }),
    feed(1),
    center("TESTE DE IMPRESSÃO", { bold: true }),
    feed(1),
    bold("Impressora:"),
    text(job.printerName),
    bold("Data/hora:"),
    text(when(job.payload.requested_at)),
    divider("="),
    center("IMPRESSÃO OK", { bold: true }),
    divider("="),
    feed(1),
    cut(),
  ];
}

export function buildDocument(job: JobModel): PrintDocument {
  switch (job.type) {
    case "production_order":
      return { blocks: productionOrder(job) };
    case "production_cancellation":
      return { blocks: productionCancellation(job) };
    case "customer_bill":
      return { blocks: customerBill(job) };
    case "payment_receipt":
      return { blocks: paymentReceipt(job) };
    case "cash_closing":
      return { blocks: cashClosing(job) };
    case "test":
      return { blocks: serverTest(job) };
    case "label_product":
    case "label_free":
    case "label_service_point":
      // Etiquetas NÃO passam por ESC/POS: o processador as rasteriza e envia ao driver (processLabelJob).
      throw new Error("Etiquetas não usam o documento ESC/POS.");
  }
}

// Teste LOCAL do diagnóstico (curto, para não gastar papel).
export function buildDiagnosticDocument(opts: { printerName: string; paperWidth: PaperWidth; codePage: CodePage }): PrintDocument {
  return {
    blocks: [
      center(TITLE, { bold: true }),
      feed(1),
      center("TESTE DE IMPRESSÃO", { bold: true }),
      feed(1),
      bold("Acentos:"),
      text("á é í ó ú"),
      text("ã õ"),
      text("ç"),
      text("GESTÃO"),
      text("PRODUÇÃO"),
      text("IMPRESSÃO"),
      divider(),
      text("1234567890"),
      text("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      divider(),
      text(opts.printerName),
      text(`${opts.paperWidth} mm`),
      text(CODE_PAGE_LABEL[opts.codePage]),
      feed(1),
      center("IMPRESSÃO OK", { bold: true }),
      feed(1),
      cut(),
    ],
  };
}
