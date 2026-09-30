// Lógica PURA do estoque simples por produto (sem React e sem Supabase). A autoridade do saldo,
// da baixa e do bloqueio é do banco (add_stock_movement, submit_service_order...).

export type StockStatus = "normal" | "low" | "out";

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  normal: "Normal",
  low: "Baixo estoque",
  out: "Sem estoque",
};

// Sem estoque = 0; baixo = no mínimo ou abaixo (mas > 0). Só ALERTA: abaixo do mínimo a venda segue.
export function stockStatus(quantity: number, minimum: number): StockStatus {
  if (quantity <= 0) return "out";
  if (quantity <= minimum) return "low";
  return "normal";
}

export type StockFilter = "all" | "low" | "out" | "inactive";

export interface StockRow {
  id: string;
  name: string;
  code: string;
  stock_quantity: number;
  minimum_stock_quantity: number;
  is_active: boolean;
  available_for_sale: boolean;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function filterStock(rows: StockRow[], query: string, filter: StockFilter): StockRow[] {
  const q = normalize(query.trim());
  return rows.filter((row) => {
    if (q && !normalize(row.name).includes(q) && !normalize(row.code).includes(q)) return false;
    const status = stockStatus(row.stock_quantity, row.minimum_stock_quantity);
    if (filter === "low") return row.is_active && status === "low";
    if (filter === "out") return row.is_active && status === "out";
    if (filter === "inactive") return !row.is_active;
    return true;
  });
}

export function countByStatus(rows: StockRow[]): Record<StockStatus, number> {
  const counts: Record<StockStatus, number> = { normal: 0, low: 0, out: 0 };
  for (const row of rows) if (row.is_active) counts[stockStatus(row.stock_quantity, row.minimum_stock_quantity)] += 1;
  return counts;
}

export type MovementKind = "entry" | "adjustment_in" | "adjustment_out" | "sale" | "cancellation_reversal" | "opening";

export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  opening: "Saldo inicial",
  entry: "Entrada",
  adjustment_in: "Ajuste (entrada)",
  adjustment_out: "Ajuste (saída)",
  sale: "Venda",
  cancellation_reversal: "Devolução por cancelamento",
};

export function isOutgoing(kind: MovementKind): boolean {
  return kind === "adjustment_out" || kind === "sale";
}

// Saldo resultante mostrado ANTES de confirmar (o servidor recalcula e recusa se ficasse negativo).
export function resultingBalance(current: number, kind: "entry" | "adjustment_in" | "adjustment_out", quantity: number): number {
  return kind === "adjustment_out" ? current - quantity : current + quantity;
}

export function parseQuantity(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 1000000 ? n : null;
}
