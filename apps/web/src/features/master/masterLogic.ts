// Regras PURAS da área Master (sem React/Supabase). Os valores vêm do catálogo (nada de preço fixo aqui); o total
// mensal é sempre "preço do plano + soma dos módulos opcionais ativos". Dinheiro em CENTAVOS.

// Únicos módulos comerciais opcionais desta versão. O núcleo (Atendimento, Comandas/Mesas, Pedidos, Caixa básico,
// Clientes, Dashboard, Configurações) está no Plano Base e NUNCA é módulo pago.
export const COMMERCIAL_MODULE_CODES = ["financeiro", "producao", "estoque", "impressao"] as const;

export const CORE_INCLUDED = ["Atendimento", "Comandas/Mesas", "Pedidos", "Caixa básico", "Clientes", "Dashboard", "Configurações"];

export const MODULE_FEATURES: Record<string, string[]> = {
  financeiro: ["Visão financeira", "Contas a receber", "Contas a pagar"],
  producao: ["Painel de produção", "Setores", "Fila", "Histórico", "Métricas de preparo"],
  estoque: ["Estoque", "Disponibilidade", "Movimentações", "Relatórios"],
  impressao: ["Print Agent", "Impressão avançada", "Etiquetas de produto, livre e comanda/mesa"],
};

export const isCommercialModule = (code: string): boolean => (COMMERCIAL_MODULE_CODES as readonly string[]).includes(code);

export function monthlyTotalCents(baseCents: number, selectedModulePrices: number[]): number {
  return baseCents + selectedModulePrices.reduce((a, b) => a + b, 0);
}

export interface PriceLine {
  label: string;
  cents: number;
}

// Linhas da conta "Base + módulos = total" na ordem do catálogo.
export function totalBreakdown(baseCents: number, modules: Array<{ name: string; priceCents: number }>): { lines: PriceLine[]; totalCents: number } {
  const lines = [{ label: "Plano Base", cents: baseCents }, ...modules.map((m) => ({ label: m.name, cents: m.priceCents }))];
  return { lines, totalCents: lines.reduce((a, l) => a + l.cents, 0) };
}

export interface InvoiceFilterable {
  company_name: string;
  due_date: string;
}

export interface InvoiceFilters {
  company: string;
  dueFrom: string;
  dueTo: string;
}

export const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// Empresa (texto) e vencimento (intervalo, inclusivo) são filtrados no cliente sobre o resultado já filtrado
// por status/competência no banco.
export function filterInvoices<T extends InvoiceFilterable>(rows: T[], f: InvoiceFilters): T[] {
  const q = norm(f.company);
  return rows.filter((r) => (!q || norm(r.company_name).includes(q)) && (!f.dueFrom || r.due_date >= f.dueFrom) && (!f.dueTo || r.due_date <= f.dueTo));
}

export interface CompanyFilterable {
  name: string;
  document: string | null;
}

export function filterCompanies<T extends CompanyFilterable>(rows: T[], search: string): T[] {
  const q = norm(search);
  const digits = search.replace(/\D/g, "");
  if (!q) return rows;
  return rows.filter((r) => norm(r.name).includes(q) || (digits.length > 0 && (r.document ?? "").replace(/\D/g, "").includes(digits)));
}

// Mesma máscara de CPF/CNPJ do restante do sistema, só para exibição.
export function fmtDocument(doc: string | null): string {
  if (!doc) return "—";
  const d = doc.replace(/\D/g, "");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return doc;
}
