import { formatReais } from "../../lib/money";
import {
  cashDifferenceText,
  METHOD_LABEL,
  periodLabel,
  pointText,
  type ReportData,
} from "./reportsLogic";

const brl = (n: number) => formatReais(n).replace(/ /g, " ");
const when = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(iso));

// Gera o PDF ESTRUTURADO do relatório (texto e tabelas reais; não é print de tela). As bibliotecas
// são carregadas só aqui (import dinâmico), então não pesam no carregamento normal do app.
export async function buildReportPdf(data: ReportData, companyName: string): Promise<Blob> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const autoTable = autoTableModule.default;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  const generatedAt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date());

  let y = 50;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Gestão Atendimento Pro", margin, y);
  y += 22;
  doc.setFontSize(12);
  doc.text("Relatório do período", margin, y);
  y += 18;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Empresa: ${companyName}`, margin, y);
  y += 14;
  doc.text(`Período: ${periodLabel(data.period)}`, margin, y);
  y += 14;
  doc.text(`Gerado em: ${generatedAt}`, margin, y);
  y += 10;

  const table = (title: string, head: string[], body: string[][], opts: { emptyText?: string } = {}) => {
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    const startY = (last?.finalY ?? y) + 22;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    if (startY > 760) doc.addPage();
    const top = startY > 760 ? 50 : startY;
    doc.text(title, margin, top);
    if (body.length === 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text(opts.emptyText ?? "Sem dados no período.", margin, top + 16);
      // mantém a posição para a próxima seção
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable = { finalY: top + 16 };
      return;
    }
    autoTable(doc, {
      startY: top + 8,
      head: [head],
      body,
      margin: { left: margin, right: margin, bottom: 50 },
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [90, 60, 180] },
      theme: "striped",
    });
  };

  const s = data.sales;
  table(
    "Resumo de vendas",
    ["Indicador", "Valor"],
    [
      ["Total vendido", brl(s.gross)],
      ["Total estornado (no período)", brl(s.refunded)],
      ["Total líquido", brl(s.net)],
      ["Contas fechadas", String(s.sessions)],
      ["Ticket médio", s.ticket === null ? "-" : brl(s.ticket)],
      ["Itens vendidos (válidos)", String(s.items_sold)],
    ],
  );

  table(
    "Formas de pagamento",
    ["Forma", "Recebido", "Estornado", "Líquido"],
    data.methods.map((m) => [METHOD_LABEL[m.method], brl(m.paid), brl(m.refunded), brl(m.net)]),
  );

  table(
    "Produtos vendidos",
    ["Produto", "Qtd. válida", "Valor bruto", "Cancelados", "Valor líquido"],
    data.products.map((p) => [p.name, String(p.quantity_valid), brl(p.value_gross), `${p.cancelled_quantity} (${brl(p.cancelled_value)})`, brl(p.value_net)]),
    { emptyText: "Nenhum produto vendido no período." },
  );

  table(
    `Cancelamentos (${data.cancellations.events} eventos, ${data.cancellations.quantity} un, ${brl(data.cancellations.value)})`,
    ["Data/hora", "Produto", "Qtd.", "Motivo", "Quem", "Comanda/Mesa"],
    data.cancellations.list.map((c) => [when(c.created_at), c.product, String(c.quantity), c.reason, c.cancelled_by_name ?? "-", pointText(c)]),
    { emptyText: "Nenhum cancelamento no período." },
  );

  table(
    `Estornos (${data.refunds.count}, total ${brl(data.refunds.total)})`,
    ["Data/hora", "Forma", "Valor", "Motivo", "Quem", "Atendimento"],
    data.refunds.list.map((r) => [when(r.created_at), METHOD_LABEL[r.method], brl(r.amount), r.reason, r.refunded_by_name ?? "-", pointText(r)]),
    { emptyText: "Nenhum estorno no período." },
  );

  const c = data.cash;
  table(
    "Caixas - resumo (cada caixa é uma gaveta separada)",
    ["Indicador", "Valor"],
    [
      ["Caixas abertos / fechados", `${c.open_count} / ${c.closed_count}`],
      ["Saldo inicial (soma)", brl(c.opening_total)],
      ["Vendas", brl(c.sales_total)],
      ["Suprimentos", brl(c.supply_total)],
      ["Sangrias", brl(c.withdrawal_total)],
      ["Estornos pagos", brl(c.refund_total)],
      ["Faltas", brl(c.shortage_total)],
      ["Sobras", brl(c.surplus_total)],
    ],
  );
  table(
    "Caixas - detalhe por sessão",
    ["Operador", "Abertura", "Fechamento", "Inicial", "Vendas", "Supr.", "Sang.", "Estornos", "Conferência"],
    c.list.map((k) => [
      k.operator_name ?? "-",
      when(k.opened_at),
      k.closed_at ? when(k.closed_at) : "Aberto",
      brl(k.opening_amount),
      brl(k.sales),
      brl(k.supply),
      brl(k.withdrawal),
      brl(k.refund),
      cashDifferenceText(k.cash_difference, brl),
    ]),
    { emptyText: "Nenhum caixa aberto no período." },
  );

  const p = data.production;
  table(
    "Produção",
    ["Indicador", "Valor"],
    [
      ["Itens produzidos", String(p.items)],
      ["Tempo médio de produção", p.avg_minutes === null ? "-" : `${p.avg_minutes} min`],
      ["Cancelados durante a produção", String(p.cancelled_in_production)],
    ],
  );
  table("Produção por setor", ["Setor", "Quantidade"], p.by_sector.map((x) => [x.sector, String(x.quantity)]), { emptyText: "Sem produção no período." });
  table("Produção por produto", ["Produto", "Quantidade"], p.by_product.map((x) => [x.name, String(x.quantity)]), { emptyText: "Sem produção no período." });

  // Rodapé em todas as páginas
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("Gerado pelo Gestão Atendimento Pro", margin, doc.internal.pageSize.getHeight() - 24);
    doc.text(`Página ${i} de ${pages}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 24, { align: "right" });
  }

  return doc.output("blob");
}

export function reportFileName(data: ReportData): string {
  const { from, to } = data.period;
  return from === to ? `relatorio-${from}.pdf` : `relatorio-${from}_a_${to}.pdf`;
}
