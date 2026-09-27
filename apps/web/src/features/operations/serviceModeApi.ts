import { supabase } from "../../lib/supabaseClient";
import { describeServiceError } from "./adminLogic";
import type { ServiceMode } from "./panel";

const LOAD_ERROR = "Não foi possível carregar o modo de atendimento agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const NO_PERMISSION = "Você não tem permissão para alterar o modo de atendimento.";

// Fonte de dados do modo de atendimento (company_operational_settings.service_mode), separada de
// ServicePointsAdminSource: a tela de Configurações não precisa (nem deve buscar) a lista de
// comandas/mesas só para mostrar o seletor de modo. `source` só existe para exercitar a tela com
// dados simulados; na rota fica o padrão (Supabase).
export interface ServiceModeSource {
  load(companyId: string): Promise<{ mode: ServiceMode | null; error: string | null }>;
  save(companyId: string, mode: ServiceMode): Promise<{ error: string | null }>;
}

// Mesma tabela, mesma coluna, mesmas policies da migration 020000 (owner e admin) — só movida
// para fora de ServicePointsAdminSource, que não usa mais o modo.
export const supabaseServiceModeSource: ServiceModeSource = {
  async load(companyId) {
    const { data, error } = await supabase
      .from("company_operational_settings")
      .select("service_mode")
      .eq("company_id", companyId)
      .maybeSingle();
    if (error || !data) return { mode: null, error: error ? describeServiceError(error, LOAD_ERROR) : LOAD_ERROR };
    return { mode: (data as { service_mode: ServiceMode }).service_mode, error: null };
  },

  async save(companyId, mode) {
    const { data, error } = await supabase
      .from("company_operational_settings")
      .update({ service_mode: mode })
      .eq("company_id", companyId)
      .select("service_mode");
    if (error) return { error: describeServiceError(error, SAVE_ERROR) };
    // O RLS não recusa com erro: um UPDATE sem permissão simplesmente não acha linha.
    return { error: data && data.length > 0 ? null : NO_PERMISSION };
  },
};
