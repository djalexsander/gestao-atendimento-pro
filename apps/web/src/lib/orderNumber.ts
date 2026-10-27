// Número sequencial operacional dos pedidos de Delivery/Retirada (alocado no banco, por empresa, compartilhado entre os dois tipos).
// Aqui só se FORMATA para exibição; nunca se calcula nem se contam linhas. O UUID continua sendo a identidade interna.

export type OrderNumberKind = "delivery" | "pickup";

const KIND_TITLE: Record<OrderNumberKind, string> = { delivery: "DELIVERY", pickup: "RETIRADA" };

/** 1 -> "0001"; 10000 -> "10000". Sem número (pedido de antes da numeração ou resposta antiga): "". */
export function formatOrderNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  const i = Math.trunc(v);
  return i < 10000 ? String(i).padStart(4, "0") : String(i);
}

/** Código curto técnico (6 primeiros caracteres do UUID): só suporte e fallback quando não há número. */
export function technicalCode(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

/** "DELIVERY #0001" / "RETIRADA #0002". Sem número cai no código técnico: "DELIVERY #A1B2C3" (nunca fica sem identificação). */
export function orderTitle(kind: OrderNumberKind, n: number | string | null | undefined, fallbackId?: string | null): string {
  const num = formatOrderNumber(n);
  const code = num || (fallbackId ? technicalCode(fallbackId) : "");
  return code ? `${KIND_TITLE[kind]} #${code}` : KIND_TITLE[kind];
}

/** Só "#0001" (ou o código técnico quando não há número). */
export function orderTag(n: number | string | null | undefined, fallbackId?: string | null): string {
  const num = formatOrderNumber(n);
  const code = num || (fallbackId ? technicalCode(fallbackId) : "");
  return code ? `#${code}` : "";
}

/** Busca: aceita "1", "0001", "#0001" e o código técnico. */
export function matchesOrderNumber(n: number | string | null | undefined, query: string): boolean {
  const q = query.trim().replace(/^#/, "");
  if (!q || !/^\d+$/.test(q)) return false;
  const num = formatOrderNumber(n);
  if (!num) return false;
  return Number(q) === Number(num) || num.includes(q);
}
