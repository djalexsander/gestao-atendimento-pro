import { subscribeToProductChanges, type RealtimeClientLike } from "../../lib/productsRealtime";
import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import type { MovementKind, StockRow } from "./stockLogic";

const LOAD_ERROR = "Não foi possível carregar o estoque agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";

// Estado de estoque/disponibilidade de UM produto (devolvido pelas RPCs).
export interface ProductStockState {
  stock_control: "none" | "quantity";
  stock_quantity: number;
  minimum_stock_quantity: number;
  available_for_sale: boolean;
}

// Produto na lista de disponibilidade (Produção: "o espeto acabou").
export interface AvailabilityRow {
  id: string;
  name: string;
  code: string;
  available_for_sale: boolean;
  stock_control: "none" | "quantity";
  stock_quantity: number;
}

export interface StockMovement {
  id: string;
  type: MovementKind;
  quantity: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
  createdByName: string | null;
}

// Fonte de dados do estoque. Recebida por parâmetro (a real, abaixo, é o padrão) para exercitar as
// telas com dados simulados. Toda escrita passa por RPC (o cliente não escreve saldo).
export interface StockSource {
  listControlled(companyId: string): Promise<{ data: StockRow[] | null; error: string | null }>;
  setControl(productId: string, mode: "none" | "quantity", minimum: number): Promise<{ data: ProductStockState | null; error: string | null }>;
  move(productId: string, type: "entry" | "adjustment_in" | "adjustment_out", quantity: number, reason: string): Promise<{ error: string | null }>;
  setAvailability(productId: string, available: boolean): Promise<{ data: ProductStockState | null; error: string | null }>;
  history(productId: string): Promise<{ data: StockMovement[] | null; error: string | null }>;
  // Produtos ativos com a disponibilidade manual (owner/admin/production alteram SÓ isso).
  listAvailability(companyId: string): Promise<{ data: AvailabilityRow[] | null; error: string | null }>;
  // Avisa (sem dados) que um produto da empresa mudou (saldo, disponibilidade, controle, ativo). Quem
  // chama recarrega do servidor. Opcional: fontes simuladas podem não ter. Devolve o cancelamento.
  subscribe?(companyId: string, onChange: () => void): () => void;
}

function toState(row: ProductStockState): ProductStockState {
  return {
    stock_control: row.stock_control,
    stock_quantity: row.stock_quantity,
    minimum_stock_quantity: row.minimum_stock_quantity,
    available_for_sale: row.available_for_sale,
  };
}

export const supabaseStockSource: StockSource = {
  subscribe(companyId, onChange) {
    return subscribeToProductChanges(supabase as unknown as RealtimeClientLike, companyId, "stock-products", onChange);
  },

  async listControlled(companyId) {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, code, stock_quantity, minimum_stock_quantity, is_active, available_for_sale")
      .eq("company_id", companyId)
      .eq("stock_control", "quantity")
      .order("name");
    if (error) {
      console.error("Falha ao carregar o estoque:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    return { data: (data ?? []) as StockRow[], error: null };
  },

  async setControl(productId, mode, minimum) {
    const { data, error } = await supabase.rpc("set_product_stock_control", {
      p_product_id: productId,
      p_mode: mode,
      p_minimum: minimum,
    });
    if (error) {
      console.error("Falha ao alterar o controle de estoque:", error.code);
      return { data: null, error: describeOrderError(error, SAVE_ERROR) };
    }
    return { data: toState(data as ProductStockState), error: null };
  },

  async move(productId, type, quantity, reason) {
    const { error } = await supabase.rpc("add_stock_movement", {
      p_product_id: productId,
      p_movement_type: type,
      p_quantity: quantity,
      p_reason: reason,
    });
    if (error) {
      console.error("Falha ao movimentar o estoque:", error.code);
      return { error: describeOrderError(error, SAVE_ERROR) };
    }
    return { error: null };
  },

  async setAvailability(productId, available) {
    const { data, error } = await supabase.rpc("set_product_availability", {
      p_product_id: productId,
      p_available: available,
    });
    if (error) {
      console.error("Falha ao alterar a disponibilidade:", error.code);
      return { data: null, error: describeOrderError(error, SAVE_ERROR) };
    }
    return { data: toState(data as ProductStockState), error: null };
  },

  async listAvailability(companyId) {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, code, available_for_sale, stock_control, stock_quantity")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name");
    if (error) {
      console.error("Falha ao carregar a disponibilidade:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    return { data: (data ?? []) as AvailabilityRow[], error: null };
  },

  async history(productId) {
    const { data, error } = await supabase
      .from("product_stock_movements")
      .select("id, movement_type, quantity, balance_after, reason, created_at, created_by")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      console.error("Falha ao carregar o histórico de estoque:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    const rows = (data ?? []) as {
      id: string;
      movement_type: MovementKind;
      quantity: number;
      balance_after: number;
      reason: string;
      created_at: string;
      created_by: string;
    }[];
    const ids = Array.from(new Set(rows.map((r) => r.created_by)));
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profiles } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
      for (const p of (profiles ?? []) as { user_id: string; full_name: string | null }[]) {
        if (p.full_name) names.set(p.user_id, p.full_name);
      }
    }
    return {
      data: rows.map((r) => ({
        id: r.id,
        type: r.movement_type,
        quantity: r.quantity,
        balanceAfter: r.balance_after,
        reason: r.reason,
        createdAt: r.created_at,
        createdByName: names.get(r.created_by) ?? null,
      })),
      error: null,
    };
  },
};
