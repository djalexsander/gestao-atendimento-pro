import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import type { ReportData, ReportPeriod } from "./reportsLogic";

const LOAD_ERROR = "Não foi possível gerar o relatório agora. Tente novamente.";

export interface ReportFilterOption {
  id: string;
  name: string;
}

export interface ReportFilters {
  categoryId: string | null;
  sectorId: string | null;
}

// Fonte de dados dos relatórios. O servidor agrega (report_period): o navegador nunca baixa os
// pedidos do período para somar. Recebida por parâmetro para exercitar a tela com dados simulados.
export interface ReportsSource {
  load(companyId: string, period: ReportPeriod, filters: ReportFilters): Promise<{ data: ReportData | null; error: string | null }>;
  listCategories(companyId: string): Promise<ReportFilterOption[]>;
  listSectors(companyId: string): Promise<ReportFilterOption[]>;
}

export const supabaseReportsSource: ReportsSource = {
  async load(companyId, period, filters) {
    const { data, error } = await supabase.rpc("report_period", {
      p_company_id: companyId,
      p_from: period.from,
      p_to: period.to,
      p_category_id: filters.categoryId,
      p_sector_id: filters.sectorId,
    });
    if (error) {
      console.error("Falha ao gerar o relatório:", error.code);
      return { data: null, error: describeOrderError(error, LOAD_ERROR) };
    }
    return { data: data as ReportData, error: null };
  },

  async listCategories(companyId) {
    const { data } = await supabase.from("product_categories").select("id, name").eq("company_id", companyId).order("name");
    return (data ?? []) as ReportFilterOption[];
  },

  async listSectors(companyId) {
    const { data } = await supabase.from("production_sectors").select("id, name").eq("company_id", companyId).order("name");
    return (data ?? []) as ReportFilterOption[];
  },
};
