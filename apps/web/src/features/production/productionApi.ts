import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import { toProductionItem, type ProductionItem, type RawProductionItem } from "./productionLogic";

const LOAD_ERROR = "Não foi possível carregar a produção agora. Tente novamente.";
const STATUS_ERROR = "Não foi possível atualizar o item agora. Tente novamente.";

export interface ProductionSector {
  id: string;
  name: string;
}

// Fonte de dados da Produção. Recebida por parâmetro (a real, abaixo, é o padrão) para exercitar
// a tela com dados simulados. Mesmo padrão de operations/api.ts e cash/cashApi.ts.
export interface ProductionSource {
  listSectors(companyId: string): Promise<{ data: ProductionSector[] | null; error: string | null }>;
  // Uma chamada: pendentes + em preparo + prontos recentes (últimos 60 min), filtrando pelo setor
  // do item (null = todos).
  loadQueue(companyId: string, sectorId: string | null): Promise<{ data: ProductionItem[] | null; error: string | null }>;
  updateStatus(itemId: string, status: "preparing" | "ready"): Promise<{ error: string | null }>;
  // Avisa (sem dados) quando um item da empresa entra ou muda de status em qualquer aparelho.
  subscribe(companyId: string, onChange: () => void): () => void;
}

// Diagnóstico do Realtime (temporário): só estados técnicos, nunca token, ids ou dados.
function rtLog(message: string) {
  console.info(`[realtime] ${message}`);
}

export const READY_WINDOW_MINUTES = 60;

export const supabaseProductionSource: ProductionSource = {
  async listSectors(companyId) {
    const { data, error } = await supabase
      .from("production_sectors")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name");
    if (error) {
      console.error("Falha ao carregar os setores:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    return { data: (data ?? []) as ProductionSector[], error: null };
  },

  async loadQueue(companyId, sectorId) {
    const { data, error } = await supabase.rpc("production_queue", {
      p_company_id: companyId,
      p_sector_id: sectorId,
      p_ready_minutes: READY_WINDOW_MINUTES,
    });
    if (error) {
      console.error("Falha ao carregar a fila de produção:", error.code);
      return { data: null, error: describeOrderError(error, LOAD_ERROR) };
    }
    return { data: ((data ?? []) as RawProductionItem[]).map(toProductionItem), error: null };
  },

  async updateStatus(itemId, status) {
    const { error } = await supabase.rpc("update_production_item_status", { p_item_id: itemId, p_status: status });
    if (error) {
      console.error("Falha ao atualizar o item:", error.code);
      return { error: describeOrderError(error, STATUS_ERROR) };
    }
    return { error: null };
  },

  subscribe(companyId, onChange) {
    let disposed = false;
    let channel: RealtimeChannel | null = null;

    void (async () => {
      // 1) sessão autenticada -> 2) Realtime autenticado -> 3) só então o canal.
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) throw new Error("sem sessão");
        await supabase.realtime.setAuth();
        rtLog("production auth ready");
      } catch {
        rtLog("production auth failed (foco/visibilidade seguem como fallback)");
        return;
      }
      if (disposed) return;

      // INSERT = item novo (o pedido grava todos os itens na mesma transação); UPDATE = mudança de status.
      channel = supabase
        .channel(`production:${companyId}:${Math.random().toString(36).slice(2)}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "service_order_items", filter: `company_id=eq.${companyId}` },
          () => {
            rtLog("production change received");
            onChange();
          },
        )
        .subscribe((status) => rtLog(`production ${status}`)); // SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED
    })();

    return () => {
      disposed = true;
      if (channel) void supabase.removeChannel(channel);
    };
  },
};
