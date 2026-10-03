import { supabase } from "../../lib/supabaseClient";
import type { RealtimeClientLike } from "../../lib/productsRealtime";
import { rangeBoundsUtc, toBoardOrders, type BoardCursor, type OrderDetail, type OrdersBoardSource, type RawBoardOrder } from "./ordersBoardLogic";
import { subscribeToOrdersBoardChanges } from "./ordersBoardRealtime";

const LOAD_ERROR = "Não foi possível carregar os pedidos agora. Tente novamente.";
const DETAIL_ERROR = "Não foi possível carregar os detalhes do pedido agora. Tente novamente.";

// Fonte de dados da tela. Por parâmetro (a real, abaixo, é o padrão) para exercitar com dados simulados.
export interface OrdersBoardApi extends OrdersBoardSource {
  // Detalhe SOB DEMANDA (modificadores, observações, cancelamentos): a lista não os carrega.
  loadDetail(orderId: string): Promise<{ data: OrderDetail | null; error: string | null }>;
  // Avisa (sem dados) que sessão/pedido/item da empresa mudou; devolve o cancelamento. Opcional.
  subscribe?(companyId: string, onChange: () => void): () => void;
}

async function loadNames(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return map;
  const { data, error } = await supabase.from("profiles").select("user_id, full_name").in("user_id", unique);
  if (error) console.error("Falha ao carregar nomes de perfil:", error.code);
  for (const p of (data ?? []) as { user_id: string; full_name: string | null }[]) {
    if (p.full_name) map.set(p.user_id, p.full_name);
  }
  return map;
}

// Colunas enxutas da lista: só o necessário para a linha, o total e o status (sem modificadores,
// observações nem cancelamentos). Os itens vêm no MESMO select (sem N+1).
const LIST_COLUMNS =
  "id, submitted_at, status, created_by, " +
  "session:service_sessions(id, status, customer_name, point:service_points(type, code, display_name)), " +
  "items:service_order_items(id, product_name_snapshot, quantity, cancelled_quantity, unit_price, production_status, sector:production_sectors(name))";

export const supabaseOrdersBoardApi: OrdersBoardApi = {
  async loadPage(companyId, range, cursor: BoardCursor | null, limit) {
    const { startIso, endIso } = rangeBoundsUtc(range);
    let query = supabase
      .from("service_orders")
      .select(LIST_COLUMNS)
      .eq("company_id", companyId)
      .gte("submitted_at", startIso)
      .lt("submitted_at", endIso)
      .order("submitted_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor) {
      // keyset: estritamente mais antigo que (submitted_at, id) do último pedido já carregado
      query = query.or(`submitted_at.lt.${cursor.submittedAt},and(submitted_at.eq.${cursor.submittedAt},id.lt.${cursor.id})`);
    }
    const { data, error } = await query;
    if (error) {
      console.error("Falha ao carregar os pedidos:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    const rows = (data ?? []) as unknown as RawBoardOrder[];
    const pageRows = rows.slice(0, limit);
    const names = await loadNames(pageRows.map((r) => r.created_by));
    const orders = toBoardOrders(pageRows, names);
    // O cursor sai da última LINHA da página (mesmo que ela seja descartada por falta de sessão legível).
    const last = pageRows[pageRows.length - 1];
    return {
      data: { orders, nextCursor: rows.length > limit && last ? { submittedAt: last.submitted_at, id: last.id } : null },
      error: null,
    };
  },

  async loadDetail(orderId) {
    const { data, error } = await supabase
      .from("service_order_items")
      .select(
        "id, product_name_snapshot, quantity, cancelled_quantity, unit_price, production_status, notes, created_at, sector:production_sectors(name), " +
          "modifiers:service_order_item_modifiers(group_name, option_name, modifier_type, price_delta, position)",
      )
      .eq("order_id", orderId)
      .order("created_at")
      .order("id");
    if (error) {
      console.error("Falha ao carregar o detalhe do pedido:", error.code);
      return { data: null, error: DETAIL_ERROR };
    }
    type Raw = {
      id: string;
      product_name_snapshot: string;
      quantity: number;
      cancelled_quantity: number;
      unit_price: number | string;
      production_status: "pending" | "preparing" | "ready";
      notes: string | null;
      sector: { name: string } | Array<{ name: string }> | null;
      modifiers: Array<{ group_name: string; option_name: string; modifier_type: "add" | "remove"; price_delta: number | string; position: number }> | null;
    };
    const rows = (data ?? []) as unknown as Raw[];

    // Eventos de cancelamento só dos itens que têm algo cancelado (uma consulta).
    const cancelledIds = rows.filter((r) => r.cancelled_quantity > 0).map((r) => r.id);
    type RawCancel = { service_order_item_id: string; quantity: number; reason: string; created_at: string; cancelled_by: string };
    let cancels: RawCancel[] = [];
    if (cancelledIds.length > 0) {
      const res = await supabase
        .from("service_order_item_cancellations")
        .select("service_order_item_id, quantity, reason, created_at, cancelled_by")
        .in("service_order_item_id", cancelledIds)
        .order("created_at", { ascending: true });
      if (res.error) {
        console.error("Falha ao carregar os cancelamentos:", res.error.code);
        return { data: null, error: DETAIL_ERROR };
      }
      cancels = (res.data ?? []) as RawCancel[];
    }
    const names = await loadNames(cancels.map((c) => c.cancelled_by));

    return {
      data: {
        id: orderId,
        items: rows.map((r) => {
          const sector = Array.isArray(r.sector) ? r.sector[0] : r.sector;
          return {
            id: r.id,
            name: r.product_name_snapshot,
            quantity: r.quantity,
            cancelledQuantity: r.cancelled_quantity,
            unitPrice: Number(r.unit_price),
            productionStatus: r.production_status,
            sector: sector?.name ?? null,
            notes: r.notes,
            modifiers: [...(r.modifiers ?? [])]
              .sort((a, b) => a.position - b.position)
              .map((m) => ({ groupName: m.group_name, name: m.option_name, type: m.modifier_type, priceDelta: Number(m.price_delta) })),
            cancellations: cancels
              .filter((c) => c.service_order_item_id === r.id)
              .map((c) => ({ quantity: c.quantity, reason: c.reason, createdAt: c.created_at, byName: names.get(c.cancelled_by) ?? null })),
          };
        }),
      },
      error: null,
    };
  },

  subscribe(companyId, onChange) {
    return subscribeToOrdersBoardChanges(supabase as unknown as RealtimeClientLike, companyId, onChange);
  },
};
