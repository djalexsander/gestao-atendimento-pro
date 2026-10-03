// Lógica PURA da tela "Comandas / Mesas abertas": monta as linhas a partir do que o banco devolve,
// calcula total/itens, busca, filtro, ordenação e o texto do tempo em aberto. Sem React e sem
// Supabase, de propósito (testada à parte).

export type OpenKind = "table" | "command";
export type KindFilter = "all" | OpenKind;
export type SortKey = "oldest" | "newest" | "value";

// Como o banco devolve (embeds do PostgREST; um embed N:1 pode vir como objeto ou como array).
export interface RawOpenSession {
  id: string;
  status?: string;
  customer_name: string | null;
  opened_at: string;
  opened_by: string;
  point: RawPoint | RawPoint[] | null;
  orders: RawOrder[] | null;
}
interface RawPoint {
  type: OpenKind;
  code: string;
  display_name: string;
}
export interface RawOrder {
  status: string;
  items: Array<{ quantity: number; cancelled_quantity: number; unit_price: number | string }> | null;
}

export interface OpenAttendance {
  id: string;
  kind: OpenKind;
  code: string;
  displayName: string;
  customerName: string | null;
  waiterName: string | null;
  openedAt: string;
  itemCount: number; // unidades ativas (pedido enviado, menos o cancelado)
  total: number; // reais
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

// MESMA regra do fechamento e da impressão da conta (banco): pedido 'submitted', quantidade
// cobrável (quantity - cancelled_quantity) x unit_price. O unit_price do snapshot já INCLUI os
// adicionais. Em centavos inteiros para não acumular erro de ponto flutuante.
export function summarizeOrders(orders: RawOrder[] | null): { itemCount: number; total: number } {
  let itemCount = 0;
  let cents = 0;
  for (const order of orders ?? []) {
    if (order.status !== "submitted") continue;
    for (const item of order.items ?? []) {
      const active = Math.max(0, item.quantity - item.cancelled_quantity);
      if (active === 0) continue;
      itemCount += active;
      cents += active * Math.round(Number(item.unit_price) * 100);
    }
  }
  return { itemCount, total: cents / 100 };
}

// Linhas da tela. Só sessão ABERTA (a consulta já filtra; aqui é defesa) e com ponto legível:
// nunca inventa dados.
export function toOpenAttendances(rows: RawOpenSession[], names: Map<string, string>): OpenAttendance[] {
  const result: OpenAttendance[] = [];
  for (const row of rows) {
    if (row.status !== undefined && row.status !== "open") continue;
    const point = one(row.point);
    if (!point) continue;
    const { itemCount, total } = summarizeOrders(row.orders);
    result.push({
      id: row.id,
      kind: point.type === "table" ? "table" : "command",
      code: point.code,
      displayName: point.display_name,
      customerName: row.customer_name,
      waiterName: names.get(row.opened_by) ?? null,
      openedAt: row.opened_at,
      itemCount,
      total,
    });
  }
  return result;
}

export function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Busca por mesa/comanda (código e nome), cliente e garçom/atendente.
export function matchesQuery(item: OpenAttendance, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  return [item.code, item.displayName, item.customerName ?? "", item.waiterName ?? ""].some((f) => normalize(f).includes(q));
}

export function filterOpen(items: OpenAttendance[], filters: { query: string; kind: KindFilter }): OpenAttendance[] {
  return items.filter((i) => (filters.kind === "all" || i.kind === filters.kind) && matchesQuery(i, filters.query));
}

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

// Mais antigo primeiro é o padrão (o que está aberto há mais tempo pede atenção). Empate: código.
export function sortOpen(items: OpenAttendance[], key: SortKey): OpenAttendance[] {
  const time = (i: OpenAttendance) => new Date(i.openedAt).getTime();
  return [...items].sort((a, b) => {
    let diff = 0;
    if (key === "oldest") diff = time(a) - time(b);
    else if (key === "newest") diff = time(b) - time(a);
    else diff = b.total - a.total;
    return diff !== 0 ? diff : collator.compare(a.code, b.code);
  });
}

export interface OpenCounts {
  all: number;
  table: number;
  command: number;
  totalAmount: number;
}

// Contadores do topo: sempre sobre TUDO o que está aberto (a busca/filtro não os altera).
export function countOpen(items: OpenAttendance[]): OpenCounts {
  const cents = items.reduce((s, i) => s + Math.round(i.total * 100), 0);
  return {
    all: items.length,
    table: items.filter((i) => i.kind === "table").length,
    command: items.filter((i) => i.kind === "command").length,
    totalAmount: cents / 100,
  };
}

// Quantos cada filtro de tipo mostraria dentro da busca atual.
export function countByKind(items: OpenAttendance[], query: string): Record<KindFilter, number> {
  const scoped = items.filter((i) => matchesQuery(i, query));
  return {
    all: scoped.length,
    table: scoped.filter((i) => i.kind === "table").length,
    command: scoped.filter((i) => i.kind === "command").length,
  };
}

// "Aberta há 12 min", "Aberta há 1h 08min", "Aberta há 1 d 3h". Relógio local (sem consulta).
export function formatElapsed(openedAtIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(openedAtIso).getTime()) / 60000));
  if (minutes < 1) return "Aberta agora";
  if (minutes < 60) return `Aberta há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Aberta há ${hours}h ${String(minutes % 60).padStart(2, "0")}min`;
  return `Aberta há ${Math.floor(hours / 24)} d ${hours % 24}h`;
}

// Destaque visual discreto (não é SLA nem regra do banco): > 1h atenção, > 2h mais atenção.
export type AgeTier = "normal" | "warn" | "late";
export function ageTier(openedAtIso: string, now: Date): AgeTier {
  const minutes = (now.getTime() - new Date(openedAtIso).getTime()) / 60000;
  if (minutes > 120) return "late";
  if (minutes > 60) return "warn";
  return "normal";
}

// Atendente abre pela área de Atendimento; os demais (caixa, owner, admin) pela do Caixa.
export function attendancePath(role: string | null | undefined, sessionId: string): string {
  return role === "attendant" ? `/operacional/atendimento/${sessionId}` : `/operacional/caixa/${sessionId}`;
}

export const KIND_LABEL: Record<OpenKind, string> = { table: "Mesa", command: "Comanda" };
