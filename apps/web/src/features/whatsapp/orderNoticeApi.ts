import { supabase } from "../../lib/supabaseClient";
import { toNotice, type OrderNotice, type RawNotice } from "./orderNoticeLogic";

export interface OrderNoticeSource {
  list(serviceOrderId: string): Promise<OrderNotice[]>;
  /** Assina mudanças das notificações DESTE pedido. Devolve a função que cancela a assinatura. */
  subscribe(serviceOrderId: string, onChange: () => void): () => void;
}

// Só LEITURA (RLS: owner/admin/cashier/attendant/production com o módulo whatsapp). Qualquer falha vira "sem selo":
// o aviso nunca atrapalha a operação.
export const supabaseOrderNoticeSource: OrderNoticeSource = {
  async list(serviceOrderId) {
    const { data, error } = await supabase
      .from("order_customer_notifications")
      .select("notification_type,status,attempts,created_at,sent_at,delivered_at")
      .eq("service_order_id", serviceOrderId);
    if (error || !data) return [];
    return (data as RawNotice[]).map(toNotice);
  },
  subscribe(serviceOrderId, onChange) {
    const channel = supabase
      .channel(`order-notice:${serviceOrderId}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "order_customer_notifications", filter: `service_order_id=eq.${serviceOrderId}` }, onChange)
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  },
};
