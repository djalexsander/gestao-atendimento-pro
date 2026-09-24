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
