// Lógica PURA da tela de Produção (KDS): tipos, agrupamento por pedido, tempo decorrido e
// urgência. Sem React e sem Supabase, de propósito. A autoridade de permissão e de transição
// de status é do banco (update_production_item_status / production_queue).

export type ProductionStatus = "pending" | "preparing" | "ready";

export const PRODUCTION_STATUS_LABEL: Record<ProductionStatus, string> = {
  pending: "Pendente",
  preparing: "Em preparo",
  ready: "Pronto",
};

export const PRODUCTION_COLUMNS: Array<{ status: ProductionStatus; title: string }> = [
  { status: "pending", title: "Pendentes" },
  { status: "preparing", title: "Em preparo" },
  { status: "ready", title: "Prontos" },
];

// Adicional/opção do item (sem preço: a produção não vê valores).
export interface ProductionModifier {
  name: string;
  type: "add" | "remove";
}
export interface RawModifier {
  name: string;
  type: "add" | "remove";
}
export function toModifiers(raw: RawModifier[] | null | undefined): ProductionModifier[] {
  return (raw ?? []).map((m) => ({ name: m.name, type: m.type === "remove" ? "remove" : "add" }));
}

export interface ProductionItem {
  id: string;
  orderId: string;
  quantity: number;
  name: string;
  notes: string | null;
  modifiers: ProductionModifier[];
  sectorId: string | null;
  sectorName: string | null;
  status: ProductionStatus;
  startedAt: string | null;
  readyAt: string | null;
  submittedAt: string;
  submittedDate: string; // dia do pedido em America/Sao_Paulo (yyyy-mm-dd), calculado no servidor
  pointType: "command" | "table";
  pointCode: string;
  pointName: string;
  customerName: string | null;
  sentByName: string | null;
}

// Uma linha do JSON devolvido por production_queue().
export interface RawProductionItem {
  id: string;
  order_id: string;
  quantity: number;
  name: string;
  notes: string | null;
  modifiers?: RawModifier[] | null;
  sector_id: string | null;
  sector_name: string | null;
  status: ProductionStatus;
  started_at: string | null;
  ready_at: string | null;
  submitted_at: string;
  submitted_date: string;
  point_type: "command" | "table";
  point_code: string;
  point_name: string;
  customer_name: string | null;
  sent_by_name: string | null;
}

export function toProductionItem(raw: RawProductionItem): ProductionItem {
  return {
    id: raw.id,
    orderId: raw.order_id,
    quantity: raw.quantity,
    name: raw.name,
    notes: raw.notes,
    modifiers: toModifiers(raw.modifiers),
    sectorId: raw.sector_id,
    sectorName: raw.sector_name,
    status: raw.status,
    startedAt: raw.started_at,
    readyAt: raw.ready_at,
    submittedAt: raw.submitted_at,
    submittedDate: raw.submitted_date,
    pointType: raw.point_type,
    pointCode: raw.point_code,
    pointName: raw.point_name,
    customerName: raw.customer_name,
    sentByName: raw.sent_by_name,
  };
}

// Um card = os itens de UM pedido que estão NA MESMA coluna (o status é por item: o mesmo pedido
// pode aparecer em colunas diferentes, cada uma só com os seus itens).
export interface OrderGroup {
  orderId: string;
  submittedAt: string;
  submittedDate: string;
  pointType: "command" | "table";
  pointCode: string;
  pointName: string;
  customerName: string | null;
  sentByName: string | null;
  items: ProductionItem[];
}

// Pedidos mais antigos primeiro (o que espera há mais tempo fica no topo); nos prontos, o mais
// recente primeiro (o que acabou de sair).
export function groupByOrder(items: ProductionItem[], status: ProductionStatus): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();
  for (const item of items) {
    if (item.status !== status) continue;
    let group = groups.get(item.orderId);
    if (!group) {
      group = {
        orderId: item.orderId,
        submittedAt: item.submittedAt,
        submittedDate: item.submittedDate,
        pointType: item.pointType,
        pointCode: item.pointCode,
        pointName: item.pointName,
        customerName: item.customerName,
        sentByName: item.sentByName,
        items: [],
      };
      groups.set(item.orderId, group);
    }
    group.items.push(item);
  }
  const list = Array.from(groups.values());
  const byTime = (a: OrderGroup, b: OrderGroup) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
  return status === "ready" ? list.sort((a, b) => byTime(b, a)) : list.sort(byTime);
}

export function ageMinutes(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

export function formatAge(minutes: number): string {
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `há ${h} h` : `há ${h} h ${String(m).padStart(2, "0")} min`;
}

export type Urgency = "normal" | "attention" | "late";

// 0-10 min normal, 10-20 atenção, 20+ atrasado. Só faz sentido para o que ainda não ficou pronto.
export function urgencyOf(minutes: number): Urgency {
  if (minutes >= 20) return "late";
  if (minutes >= 10) return "attention";
  return "normal";
}

// Ações do card por status do item (o servidor valida a transição).
export function actionsFor(status: ProductionStatus): Array<{ to: "preparing" | "ready"; label: string }> {
  if (status === "pending") {
    return [
      { to: "preparing", label: "Iniciar preparo" },
      { to: "ready", label: "Marcar pronto" },
    ];
  }
  if (status === "preparing") return [{ to: "ready", label: "Marcar pronto" }];
  return [];
}

// Cancelamento recente informado pela fila (evento do banco): o KDS avisa a cozinha.
export interface QueueCancellation {
  id: string;
  quantity: number;
  name: string;
  pointType: "command" | "table";
  pointCode: string;
  reason: string;
  createdAt: string;
}

export interface RawQueueCancellation {
  id: string;
  quantity: number;
  name: string;
  point_type: "command" | "table";
  point_code: string;
  reason: string;
  created_at: string;
}

export function toQueueCancellation(raw: RawQueueCancellation): QueueCancellation {
  return {
    id: raw.id,
    quantity: raw.quantity,
    name: raw.name,
    pointType: raw.point_type,
    pointCode: raw.point_code,
    reason: raw.reason,
    createdAt: raw.created_at,
  };
}

// Eventos que a tela ainda não conhecia. Na PRIMEIRA carga (seen === null) nada é novo: só avisa o
// que acontece com a tela aberta, não o que já estava cancelado antes de abrir.
export function newCancellations(events: QueueCancellation[], seen: Set<string> | null): QueueCancellation[] {
  if (seen === null) return [];
  return events.filter((e) => !seen.has(e.id));
}

export function cancellationText(c: QueueCancellation): string {
  return `Item cancelado — ${c.quantity}x ${c.name} — ${c.pointType === "table" ? "Mesa" : "Comanda"} ${c.pointCode}`;
}

export function pointLabel(group: Pick<OrderGroup, "pointType" | "pointCode">): string {
  return `${group.pointType === "table" ? "Mesa" : "Comanda"} ${group.pointCode}`;
}

// --- Dia operacional --------------------------------------------------------------------------
// O "hoje" e o dia de cada pedido vêm do SERVIDOR (America/Sao_Paulo); aqui só se compara texto
// yyyy-mm-dd. O navegador nunca decide a virada do dia.

function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function daysBefore(today: string, date: string): number {
  return dayNumber(today) - dayNumber(date);
}

// "Pedido de ontem" / "Pedido de 3 dias atrás" para o que ficou sem finalizar; null se for de hoje.
export function previousDayLabel(today: string | null, submittedDate: string): string | null {
  if (!today) return null;
  const days = daysBefore(today, submittedDate);
  if (days <= 0) return null;
  return days === 1 ? "Pedido de ontem" : `Pedido de ${days} dias atrás`;
}

// "Mostrar mais": quantos prontos do dia ainda não estão na tela.
export const READY_PAGE = 15;
export function readyRemaining(readyTotal: number, shown: number): number {
  return Math.max(0, readyTotal - shown);
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
}

// --- Histórico -------------------------------------------------------------------------------

export interface HistoryItem {
  id: string;
  orderId: string;
  quantity: number;
  name: string;
  notes: string | null;
  modifiers: ProductionModifier[];
  sectorName: string | null;
  submittedAt: string;
  readyAt: string;
  // Tempo real de preparo (início -> pronto). null quando o preparo não foi iniciado explicitamente
  // (item foi direto de pendente para pronto): o servidor não inventa duração.
  minutes: number | null;
  pointType: "command" | "table";
  pointCode: string;
  customerName: string | null;
}

export interface RawHistoryItem {
  id: string;
  order_id: string;
  quantity: number;
  name: string;
  notes: string | null;
  modifiers?: RawModifier[] | null;
  sector_name: string | null;
  submitted_at: string;
  ready_at: string;
  minutes: number | null;
  point_type: "command" | "table";
  point_code: string;
  customer_name: string | null;
}

export function toHistoryItem(raw: RawHistoryItem): HistoryItem {
  return {
    id: raw.id,
    orderId: raw.order_id,
    quantity: raw.quantity,
    name: raw.name,
    notes: raw.notes,
    modifiers: toModifiers(raw.modifiers),
    sectorName: raw.sector_name,
    submittedAt: raw.submitted_at,
    readyAt: raw.ready_at,
    minutes: raw.minutes,
    pointType: raw.point_type,
    pointCode: raw.point_code,
    customerName: raw.customer_name,
  };
}

export interface HistorySummary {
  items: number;
  orders: number;
  avgMinutes: number | null;
  bySector: Array<{ name: string; items: number }>;
}

export interface HistoryOrder {
  orderId: string;
  submittedAt: string;
  pointType: "command" | "table";
  pointCode: string;
  customerName: string | null;
  lastReadyAt: string;
  items: HistoryItem[];
}

// Um card por pedido; o mais recentemente concluído primeiro (itens do card também, do mais recente).
export function groupHistory(items: HistoryItem[]): HistoryOrder[] {
  const map = new Map<string, HistoryOrder>();
  for (const item of items) {
    let g = map.get(item.orderId);
    if (!g) {
      g = {
        orderId: item.orderId,
        submittedAt: item.submittedAt,
        pointType: item.pointType,
        pointCode: item.pointCode,
        customerName: item.customerName,
        lastReadyAt: item.readyAt,
        items: [],
      };
      map.set(item.orderId, g);
    }
    g.items.push(item);
    if (item.readyAt > g.lastReadyAt) g.lastReadyAt = item.readyAt;
  }
  const list = Array.from(map.values());
  for (const g of list) g.items.sort((a, b) => (a.readyAt < b.readyAt ? 1 : -1));
  return list.sort((a, b) => (a.lastReadyAt < b.lastReadyAt ? 1 : -1));
}
