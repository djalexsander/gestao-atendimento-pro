// Realtime da tela de Pedidos: as MESMAS três tabelas da empresa (service_orders: pedido novo/cancelado;
// service_order_items: produção e cancelamento de item; service_sessions: o atendimento abriu/fechou) num
// único channel, com company_id no filtro. Reaproveita a assinatura validada da tela de atendimentos
// abertos (getSession -> setAuth -> channel; cleanup remove o channel); só muda o nome do channel/log.
import type { RealtimeClientLike } from "../../lib/productsRealtime";
import { subscribeToOpenAttendanceChanges } from "../operations/openSessionsRealtime";

export function subscribeToOrdersBoardChanges(client: RealtimeClientLike, companyId: string, onChange: () => void): () => void {
  return subscribeToOpenAttendanceChanges(client, companyId, onChange, "orders-board");
}
