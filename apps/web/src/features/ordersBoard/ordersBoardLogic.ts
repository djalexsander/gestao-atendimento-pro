// Lógica PURA da tela "Pedidos" (histórico operacional de pedidos enviados): montagem das linhas,
// status agregado, valor efetivo, busca/filtros/ordenação, agrupamento por dia e o controlador de
// período + paginação por cursor (com fonte falsa nos testes). Sem React e sem Supabase.
// Datas SEMPRE no dia civil de America/Sao_Paulo (reaproveita os utilitários da fila de impressão).
import {
  formatDayBR,
  rangeFor,
  rangeIncludesToday,
  spDay,
  validateRange,
  type QueueFilter,
  type QueueRange,
} from "../printing/printingQueueLogic";

export type { QueueFilter as PeriodFilter, QueueRange as PeriodRange };
export { FILTER_LABEL as PERIOD_LABEL, MAX_RANGE_DAYS, rangeBoundsUtc, rangeFor, spDay, validateRange, addDaysIso } from "../printing/printingQueueLogic";

export const PAGE_SIZE = 50;

export type PointKind = "table" | "command";
export type KindFilter = "all" | PointKind;
export type ProductionStatus = "pending" | "preparing" | "ready";
export type AggStatus = "pending" | "preparing" | "ready" | "partial" | "cancelled";
export type StatusFilter = "all" | AggStatus;
export type SortKey = "newest" | "oldest" | "value";

export const KIND_LABEL: Record<PointKind, string> = { table: "Mesa", command: "Comanda" };
export const STATUS_LABEL: Record<AggStatus, string> = {
  pending: "Aguardando",
  preparing: "Em produção",
  ready: "Pronto",
  partial: "Parcialmente cancelado",
  cancelled: "Cancelado",
};
export const PRODUCTION_LABEL: Record<ProductionStatus, string> = {
  pending: "Aguardando",
  preparing: "Em preparo",
  ready: "Pronto",
};

// ---- Linhas (como o banco devolve -> como a tela usa) ---------------------------------------

export interface RawBoardOrder {
  id: string;
  submitted_at: string;
  status: "submitted" | "cancelled";
  created_by: string;
  session: RawSession | RawSession[] | null;
  items: RawBoardItem[] | null;
}
interface RawSession {
  id: string;
  status: "open" | "closed";
  customer_name: string | null;
  point: RawPoint | RawPoint[] | null;
}
interface RawPoint {
  type: PointKind;
  code: string;
  display_name: string;
}
export interface RawBoardItem {
  id: string;
  product_name_snapshot: string;
  quantity: number;
  cancelled_quantity: number;
  unit_price: number | string;
  production_status: ProductionStatus;
  sector: { name: string } | Array<{ name: string }> | null;
}

export interface BoardItem {
  id: string;
  name: string;
  quantity: number; // original
  cancelledQuantity: number;
  unitPrice: number; // já inclui os adicionais
  productionStatus: ProductionStatus;
  sector: string | null;
}

export interface BoardOrder {
  id: string;
  shortId: string;
  submittedAt: string;
  orderCancelled: boolean; // service_orders.status = 'cancelled' (o banco marca quando não sobra nada cobrável)
  kind: PointKind;
  code: string;
  displayName: string;
  customerName: string | null;
  waiterName: string | null; // quem ENVIOU o pedido
  sessionId: string;
  sessionOpen: boolean;
  items: BoardItem[];
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

// Código curto para a linha/busca: 6 primeiros caracteres do id, em maiúsculas.
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

// Pedido sem sessão/ponto legível é descartado (nunca inventa dados).
export function toBoardOrders(rows: RawBoardOrder[], names: Map<string, string>): BoardOrder[] {
  const result: BoardOrder[] = [];
  for (const row of rows) {
    const session = one(row.session);
    const point = session ? one(session.point) : null;
    if (!session || !point) continue;
    result.push({
      id: row.id,
      shortId: shortId(row.id),
      submittedAt: row.submitted_at,
      orderCancelled: row.status === "cancelled",
      kind: point.type === "table" ? "table" : "command",
      code: point.code,
      displayName: point.display_name,
      customerName: session.customer_name,
      waiterName: names.get(row.created_by) ?? null,
      sessionId: session.id,
      sessionOpen: session.status === "open",
      items: (row.items ?? []).map((i) => ({
        id: i.id,
        name: i.product_name_snapshot,
        quantity: i.quantity,
        cancelledQuantity: i.cancelled_quantity,
        unitPrice: Number(i.unit_price),
        productionStatus: i.production_status,
        sector: one(i.sector)?.name ?? null,
      })),
    });
  }
  return result;
}

// ---- Valor, quantidade e status ----------------------------------------------------------------

export function activeQty(item: Pick<BoardItem, "quantity" | "cancelledQuantity">): number {
  return Math.max(0, item.quantity - item.cancelledQuantity);
}

// Valor em centavos (inteiros, sem erro de ponto flutuante). Efetivo = (quantity − cancelled) × unit_price,
// a MESMA regra do fechamento da conta; o unit_price do snapshot já inclui os adicionais.
export function originalTotal(items: Array<Pick<BoardItem, "quantity" | "unitPrice">>): number {
  return items.reduce((s, i) => s + i.quantity * Math.round(i.unitPrice * 100), 0) / 100;
}
export function currentTotal(items: Array<Pick<BoardItem, "quantity" | "cancelledQuantity" | "unitPrice">>): number {
  return items.reduce((s, i) => s + activeQty(i) * Math.round(i.unitPrice * 100), 0) / 100;
}

// Produção do que ainda vale (itens com quantidade ativa): todos prontos -> ready; todos pendentes ->
// pending; qualquer outra combinação (algum em preparo, ou parte pronta e parte pendente) -> preparing.
// Sem item ativo -> null.
export function productionOf(items: BoardItem[]): ProductionStatus | null {
  const active = items.filter((i) => activeQty(i) > 0);
  if (active.length === 0) return null;
  if (active.every((i) => i.productionStatus === "ready")) return "ready";
  if (active.every((i) => i.productionStatus === "pending")) return "pending";
  return "preparing";
}

// Status agregado (regra única, por prioridade):
//   1. pedido cancelado no banco OU nenhuma unidade ativa  -> cancelled
//   2. qualquer unidade cancelada (parcial)                -> partial
//   3. senão a produção dos itens ativos                   -> ready / preparing / pending
export function aggregateStatus(order: Pick<BoardOrder, "orderCancelled" | "items">): AggStatus {
  const production = productionOf(order.items);
  if (order.orderCancelled || production === null) return "cancelled";
  if (order.items.some((i) => i.cancelledQuantity > 0)) return "partial";
  return production;
}

export interface OrderSummary {
  status: AggStatus;
  production: ProductionStatus | null;
  itemCount: number; // unidades ativas
  total: number; // efetivo
  original: number;
  sectors: string[]; // setores dos itens ativos, sem repetir, em ordem de aparição
  itemsText: string; // "Coca-Cola, X-Salada, +1"
}

export function summarize(order: BoardOrder): OrderSummary {
  const active = order.items.filter((i) => activeQty(i) > 0);
  const names = Array.from(new Set(active.map((i) => i.name)));
  const shown = names.slice(0, 2).join(", ");
  const sectors: string[] = [];
  for (const i of active) if (i.sector && !sectors.includes(i.sector)) sectors.push(i.sector);
  return {
    status: aggregateStatus(order),
    production: productionOf(order.items),
    itemCount: active.reduce((s, i) => s + activeQty(i), 0),
    total: currentTotal(order.items),
    original: originalTotal(order.items),
    sectors,
    itemsText: names.length > 2 ? `${shown}, +${names.length - 2}` : shown,
  };
}

// ---- Busca, filtros, ordenação ----------------------------------------------------------------

export function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Mesa, comanda (código e nome), cliente, atendente, produto (qualquer item, inclusive cancelado) e código do pedido.
export function matchesQuery(order: BoardOrder, query: string): boolean {
  const q = normalize(query.trim().replace(/^#/, ""));
  if (!q) return true;
  const fields = [order.code, order.displayName, order.customerName ?? "", order.waiterName ?? "", order.shortId, ...order.items.map((i) => i.name)];
  return fields.some((f) => normalize(f).includes(q));
}

export interface BoardFilters {
  query: string;
  status: StatusFilter;
  kind: KindFilter;
  sector: string | null; // nome do setor; null = todos
  waiter: string | null; // nome do atendente; null = todos
}

export const NO_FILTERS: BoardFilters = { query: "", status: "all", kind: "all", sector: null, waiter: null };

export function filterOrders(orders: BoardOrder[], f: BoardFilters): BoardOrder[] {
  return orders.filter((o) => {
    if (f.kind !== "all" && o.kind !== f.kind) return false;
    if (f.waiter !== null && o.waiterName !== f.waiter) return false;
    if (f.sector !== null && !o.items.some((i) => i.sector === f.sector)) return false;
    if (f.status !== "all" && aggregateStatus(o) !== f.status) return false;
    return matchesQuery(o, f.query);
  });
}

export function sortOrders(orders: BoardOrder[], key: SortKey): BoardOrder[] {
  const time = (o: BoardOrder) => new Date(o.submittedAt).getTime();
  return [...orders].sort((a, b) => {
    let diff = 0;
    if (key === "newest") diff = time(b) - time(a);
    else if (key === "oldest") diff = time(a) - time(b);
    else diff = currentTotal(b.items) - currentTotal(a.items);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

// Opções dinâmicas (a partir do que foi carregado), em ordem alfabética.
const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });
export function sectorOptions(orders: BoardOrder[]): string[] {
  return Array.from(new Set(orders.flatMap((o) => o.items.map((i) => i.sector).filter((s): s is string => !!s)))).sort(collator.compare);
}
export function waiterOptions(orders: BoardOrder[]): string[] {
  return Array.from(new Set(orders.map((o) => o.waiterName).filter((n): n is string => !!n))).sort(collator.compare);
}

export interface BoardCounts {
  all: number;
  pending: number;
  preparing: number;
  ready: number;
  partial: number;
  cancelled: number;
}
export function countOrders(orders: BoardOrder[]): BoardCounts {
  const c: BoardCounts = { all: orders.length, pending: 0, preparing: 0, ready: 0, partial: 0, cancelled: 0 };
  for (const o of orders) c[aggregateStatus(o)] += 1;
  return c;
}

export interface DayGroup {
  day: string; // yyyy-mm-dd (SP)
  label: string; // dd/mm/aaaa
  orders: BoardOrder[];
}
// Cabeçalho por dia na ordem em que os pedidos chegam (a lista já vem ordenada).
export function groupByDay(orders: BoardOrder[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const order of orders) {
    const day = spDay(order.submittedAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.orders.push(order);
    else groups.push({ day, label: formatDayBR(day), orders: [order] });
  }
  return groups;
}

// Cabeçalho por dia só quando o período tem mais de um dia E a ordem é por data; em "Maior valor" a lista é
// corrida (agrupar uma lista fora de ordem repetiria o mesmo dia várias vezes).
export function shouldGroupByDay(range: { from: string; to: string }, sort: SortKey): boolean {
  return range.from !== range.to && sort !== "value";
}

const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export function formatDateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso)).replace(",", " às");
}

// ---- Paginação por cursor (submitted_at desc, id desc) ------------------------------------------

export interface BoardCursor {
  submittedAt: string;
  id: string;
}

export function sortRecent(orders: BoardOrder[]): BoardOrder[] {
  return [...orders].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id));
}

export function nextCursor(page: BoardOrder[]): BoardCursor | null {
  const last = page[page.length - 1];
  return last ? { submittedAt: last.submittedAt, id: last.id } : null;
}

// "Carregar mais": anexa sem duplicar (id já presente é ignorado).
export function appendPage(existing: BoardOrder[], page: BoardOrder[]): BoardOrder[] {
  const seen = new Set(existing.map((o) => o.id));
  return sortRecent([...existing, ...page.filter((o) => !seen.has(o.id))]);
}

// Recarga da CABEÇA (Realtime/visibilidade): troca o topo pelo lote novo e mantém o que já foi paginado
// mais abaixo (estritamente mais antigo que o último do lote novo).
export function mergeHead(existing: BoardOrder[], head: BoardOrder[], headHasMore: boolean): BoardOrder[] {
  if (!headHasMore) return sortRecent(head);
  const last = head[head.length - 1];
  if (!last) return [];
  const older = existing.filter((o) => o.submittedAt < last.submittedAt || (o.submittedAt === last.submittedAt && o.id < last.id));
  return appendPage(head, older);
}

// ---- Controlador (período + páginas) -------------------------------------------------------------

export interface PageResult {
  orders: BoardOrder[];
  nextCursor: BoardCursor | null; // null = não há mais
}
export interface OrdersBoardSource {
  loadPage(companyId: string, range: QueueRange, cursor: BoardCursor | null, limit: number): Promise<{ data: PageResult | null; error: string | null }>;
}

export interface BoardState {
  filter: QueueFilter;
  custom: QueueRange;
  range: QueueRange;
  rangeError: string | null;
  orders: BoardOrder[] | null;
  cursor: BoardCursor | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

const BOARD_ERROR = "Não foi possível carregar os pedidos agora. Tente novamente.";

export function createBoardController(deps: {
  source: OrdersBoardSource;
  companyId: string;
  now?: () => Date;
  pageSize?: number;
  onChange: (state: BoardState) => void;
}) {
  const pageSize = deps.pageSize ?? PAGE_SIZE;
  const now = deps.now ?? (() => new Date());
  let disposed = false;
  let generation = 0; // sobe a cada troca de período/Atualizar: respostas antigas são ignoradas

  const today = spDay(now());
  const state: BoardState = {
    filter: "today",
    custom: { from: today, to: today },
    range: { from: today, to: today },
    rangeError: null,
    orders: null,
    cursor: null,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null,
  };

  function emit() {
    if (!disposed) deps.onChange({ ...state });
  }

  async function reloadFirstPage(): Promise<void> {
    if (state.rangeError) return;
    const gen = ++generation;
    state.loading = true;
    state.loadingMore = false;
    emit();
    const result = await deps.source.loadPage(deps.companyId, state.range, null, pageSize);
    if (disposed || gen !== generation) return;
    state.loading = false;
    if (result.error || !result.data) {
      state.error = result.error ?? BOARD_ERROR;
      emit();
      return;
    }
    state.error = null;
    state.orders = sortRecent(result.data.orders);
    state.cursor = result.data.nextCursor;
    state.hasMore = result.data.nextCursor !== null;
    emit();
  }

  // Realtime/visibilidade: só a cabeça, preservando as páginas já carregadas. Não sobe a geração.
  async function reloadHead(): Promise<void> {
    if (state.rangeError || state.orders === null) return;
    const gen = generation;
    const range = state.range;
    const result = await deps.source.loadPage(deps.companyId, range, null, pageSize);
    if (disposed || gen !== generation || range !== state.range) return;
    if (result.error || !result.data) return;
    const headHasMore = result.data.nextCursor !== null;
    state.orders = mergeHead(state.orders ?? [], sortRecent(result.data.orders), headHasMore);
    state.cursor = headHasMore ? nextCursor(state.orders) : null;
    state.hasMore = headHasMore;
    emit();
  }

  async function loadMore(): Promise<void> {
    if (!state.hasMore || !state.cursor || state.loadingMore || state.loading || state.rangeError) return;
    const gen = generation;
    const cursor = state.cursor;
    state.loadingMore = true;
    emit();
    const result = await deps.source.loadPage(deps.companyId, state.range, cursor, pageSize);
    if (disposed || gen !== generation) return;
    state.loadingMore = false;
    if (result.error || !result.data) {
      state.error = result.error ?? BOARD_ERROR;
      emit();
      return;
    }
    state.orders = appendPage(state.orders ?? [], result.data.orders);
    state.cursor = result.data.nextCursor;
    state.hasMore = result.data.nextCursor !== null;
    emit();
  }

  function applyRange(): void {
    state.range = rangeFor(state.filter, spDay(now()), state.custom);
    state.rangeError = state.filter === "custom" ? validateRange(state.range) : null;
    generation += 1; // invalida respostas em voo
    state.orders = null;
    state.cursor = null;
    state.hasMore = false;
    state.loading = false;
    state.loadingMore = false;
  }

  return {
    getState: () => ({ ...state }),
    async init() {
      applyRange();
      emit();
      await reloadFirstPage();
    },
    async setFilter(filter: QueueFilter) {
      state.filter = filter;
      applyRange();
      emit();
      if (!state.rangeError) await reloadFirstPage();
    },
    async setCustom(from: string, to: string) {
      state.custom = { from, to };
      state.filter = "custom";
      applyRange();
      emit();
      if (!state.rangeError) await reloadFirstPage();
    },
    // Atualizar: primeira página do período atual, sem acumular.
    async refresh() {
      if (state.filter !== "custom") state.range = rangeFor(state.filter, spDay(now()), state.custom); // virou a meia-noite
      await reloadFirstPage();
    },
    reloadHead,
    loadMore,
    // Evento do Realtime: só recarrega a cabeça quando o período inclui HOJE (histórico antigo não muda sozinho).
    async onRealtime() {
      if (rangeIncludesToday(state.range, spDay(now()))) await reloadHead();
    },
    async onVisible() {
      await reloadHead();
    },
    dispose() {
      disposed = true;
    },
  };
}

// Pode abrir o atendimento? Só se a sessão ainda está aberta (nunca reabre sessão fechada).
export function canOpenAttendance(order: Pick<BoardOrder, "sessionOpen">): boolean {
  return order.sessionOpen;
}

// ---- Detalhe (carregado sob demanda) ---------------------------------------------------------------

export interface DetailCancellation {
  quantity: number;
  reason: string;
  createdAt: string;
  byName: string | null;
}
export interface DetailModifier {
  groupName: string;
  name: string;
  type: "add" | "remove";
  priceDelta: number;
}
export interface DetailItem extends BoardItem {
  notes: string | null;
  modifiers: DetailModifier[];
  cancellations: DetailCancellation[];
}
export interface OrderDetail {
  id: string;
  items: DetailItem[];
}
