import { supabase } from "../../lib/supabaseClient";
import type { RealtimeClientLike } from "../../lib/productsRealtime";
import { subscribeToOpenAttendanceChanges } from "./openSessionsRealtime";
import { toOpenAttendances, type OpenAttendance, type RawOpenSession } from "./openSessions";

const LOAD_ERROR = "Não foi possível carregar os atendimentos abertos agora. Tente novamente.";

// Fonte de dados da tela (por parâmetro, para exercitá-la com dados simulados). Mesmo padrão de
// operations/api.ts.
export interface OpenSessionsSource {
  load(companyId: string): Promise<{ data: OpenAttendance[] | null; error: string | null }>;
  // Avisa (sem dados) que sessão/pedido/item da empresa mudou; devolve o cancelamento.
  subscribe?(companyId: string, onChange: () => void): () => void;
}

export const supabaseOpenSessionsSource: OpenSessionsSource = {
  // SÓ sessões abertas, com o mínimo para o total (quantidades e preço congelado dos itens):
  // nada de histórico fechado, impressão ou produção.
  async load(companyId) {
    const { data, error } = await supabase
      .from("service_sessions")
      .select(
        "id, status, customer_name, opened_at, opened_by, point:service_points(type, code, display_name), " +
          "orders:service_orders(status, items:service_order_items(quantity, cancelled_quantity, unit_price))",
      )
      .eq("company_id", companyId)
      .eq("status", "open");
    if (error) {
      console.error("Falha ao carregar os atendimentos abertos:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    const rows = (data ?? []) as unknown as RawOpenSession[];

    const names = new Map<string, string>();
    const ids = Array.from(new Set(rows.map((r) => r.opened_by)));
    if (ids.length > 0) {
      const res = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
      if (res.error) console.error("Falha ao carregar nomes de perfil:", res.error.code);
      for (const p of (res.data ?? []) as { user_id: string; full_name: string | null }[]) {
        if (p.full_name) names.set(p.user_id, p.full_name);
      }
    }
    return { data: toOpenAttendances(rows, names), error: null };
  },

  subscribe(companyId, onChange) {
    return subscribeToOpenAttendanceChanges(supabase as unknown as RealtimeClientLike, companyId, onChange);
  },
};
