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

export interface ProductionItem {
  id: string;
  orderId: string;
  quantity: number;
  name: string;
  notes: string | null;
  sectorId: string | null;
  sectorName: string | null;
  status: ProductionStatus;
  startedAt: string | null;
  readyAt: string | null;
  submittedAt: string;
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
  sector_id: string | null;
  sector_name: string | null;
  status: ProductionStatus;
  started_at: string | null;
  ready_at: string | null;
  submitted_at: string;
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
    sectorId: raw.sector_id,
    sectorName: raw.sector_name,
    status: raw.status,
    startedAt: raw.started_at,
    readyAt: raw.ready_at,
    submittedAt: raw.submitted_at,
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

export function pointLabel(group: Pick<OrderGroup, "pointType" | "pointCode">): string {
  return `${group.pointType === "table" ? "Mesa" : "Comanda"} ${group.pointCode}`;
}
