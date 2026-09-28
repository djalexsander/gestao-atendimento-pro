const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatCents(cents: number): string {
  return brl.format(cents / 100);
}

// Aceita "49,90", "49.90" ou "1.234,56". Retorna null se inválido.
export function parseCents(input: string): number | null {
  const s = input.trim().replace(/\s/g, "");
  if (!s) return null;
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(parseFloat(normalized) * 100);
}

// products.sale_price (e colunas numeric(12,2) equivalentes) guardam REAIS direto, não
// centavos — ver 20260926040000_product_catalog.sql. formatReais/parseReais espelham
// formatCents/parseCents para esse formato.
export function formatReais(value: number): string {
  return brl.format(value);
}

// Mesma validação/parsing de parseCents (aceita "18,00", "18.00"); devolve reais, não
// centavos. A regex de parseCents já recusa sinal negativo, então o resultado nunca é < 0.
export function parseReais(input: string): number | null {
  const cents = parseCents(input);
  return cents === null ? null : cents / 100;
}
