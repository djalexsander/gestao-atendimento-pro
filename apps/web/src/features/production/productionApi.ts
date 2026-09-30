import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import {
  toHistoryItem,
  toProductionItem,
  toQueueCancellation,
  type QueueCancellation,
  type RawQueueCancellation,
  type HistoryItem,
  type HistorySummary,
  type ProductionItem,
  type RawHistoryItem,
  type RawProductionItem,
} from "./productionLogic";

const LOAD_ERROR = "Não foi possível carregar a produção agora. Tente novamente.";
const STATUS_ERROR = "Não foi possível atualizar o item agora. Tente novamente.";

export interface QueueData {
  items: ProductionItem[];
  readyTotal: number;
  today: string;
  // Cancelamentos dos últimos 15 min (por evento): a tela avisa a cozinha dos que forem novos.
  cancellations: QueueCancellation[];
}

export interface HistoryData {
  date: string;
  items: HistoryItem[];
  summary: HistorySummary;
}

export interface ProductionSector {
  id: string;
  name: string;
}

// Fonte de dados da Produção. Recebida por parâmetro (a real, abaixo, é o padrão) para exercitar
// a tela com dados simulados. Mesmo padrão de operations/api.ts e cash/cashApi.ts.
export interface ProductionSource {
  listSectors(companyId: string): Promise<{ data: ProductionSector[] | null; error: string | null }>;
  // Operação ATUAL numa chamada: todos os pendentes/em preparo (de qualquer dia) + os `readyLimit`
  // prontos de HOJE mais recentes; readyTotal = prontos de hoje; today = dia do servidor
  // (America/Sao_Paulo). Filtra pelo setor do item (null = todos).
  loadQueue(
    companyId: string,
    sectorId: string | null,
    readyLimit: number,
  ): Promise<{ data: QueueData | null; error: string | null }>;
  // Histórico de UMA data (yyyy-mm-dd): itens concluídos naquele dia + resumo.
  loadHistory(
    companyId: string,
    date: string,
    sectorId: string | null,
  ): Promise<{ data: HistoryData | null; error: string | null }>;
  updateStatus(itemId: string, status: "preparing" | "ready"): Promise<{ error: string | null }>;
  // Avisa (sem dados) quando um item da empresa entra ou muda de status em qualquer aparelho.
  subscribe(companyId: string, onChange: () => void): () => void;
}

// Diagnóstico do Realtime (temporário): só estados técnicos, nunca token, ids ou dados.
function rtLog(message: string) {
  console.info(`[realtime] ${message}`);
}

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

  async loadQueue(companyId, sectorId, readyLimit) {
    const { data, error } = await supabase.rpc("production_queue", {
      p_company_id: companyId,
      p_sector_id: sectorId,
      p_ready_limit: readyLimit,
    });
    if (error) {
      console.error("Falha ao carregar a fila de produção:", error.code);
      return { data: null, error: describeOrderError(error, LOAD_ERROR) };
    }
    const raw = data as { items: RawProductionItem[]; ready_total: number; today: string; cancellations: RawQueueCancellation[] };
    return {
      data: {
        items: raw.items.map(toProductionItem),
        readyTotal: raw.ready_total,
        today: raw.today,
        cancellations: (raw.cancellations ?? []).map(toQueueCancellation),
      },
      error: null,
    };
  },

  async loadHistory(companyId, date, sectorId) {
    const { data, error } = await supabase.rpc("production_history", {
      p_company_id: companyId,
      p_date: date,
      p_sector_id: sectorId,
    });
    if (error) {
      console.error("Falha ao carregar o histórico de produção:", error.code);
      return { data: null, error: describeOrderError(error, LOAD_ERROR) };
    }
    const raw = data as {
      date: string;
      items: RawHistoryItem[];
      summary: { items: number; orders: number; avg_minutes: number | null; by_sector: Array<{ name: string; items: number }> };
    };
    return {
      data: {
        date: raw.date,
        items: raw.items.map(toHistoryItem),
        summary: {
          items: raw.summary.items,
          orders: raw.summary.orders,
          avgMinutes: raw.summary.avg_minutes,
          bySector: raw.summary.by_sector,
        },
      },
      error: null,
    };
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
