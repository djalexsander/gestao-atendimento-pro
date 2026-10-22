import { supabase } from "../../lib/supabaseClient";
import {
  friendlyModuleError,
  toAiIndicators,
  toModuleState,
  type AiIndicators,
  type ModuleState,
} from "./whatsappModulesLogic";
import { toConnectionSummary, type ConnectionSummary } from "./whatsappLogic";

export type ModResult<T> = { data: T; error: null } | { data: null; error: string };

export interface WhatsappModulesSource {
  state(companyId: string): Promise<ModResult<ModuleState>>;
  summary(companyId: string): Promise<ModResult<ConnectionSummary>>;
  disconnect(companyId: string, confirm: string): Promise<ModResult<true>>;
  indicators(companyId: string): Promise<ModResult<AiIndicators>>;
}

const GENERIC = "Não foi possível carregar agora. Tente novamente.";

// Mensagens PT4xx do banco já vêm em português amigável; qualquer outra coisa vira texto genérico (sem vazar detalhe técnico).
function fail(error: { code?: string; message?: string }): { data: null; error: string } {
  console.error("WhatsApp/IA:", error.code ?? "sem código");
  return { data: null, error: error.code && /^PT40\d$/.test(error.code) ? friendlyModuleError(error.message) : GENERIC };
}

export const supabaseWhatsappModulesSource: WhatsappModulesSource = {
  async state(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_get_module_state", { p_company_id: companyId });
    if (error) return fail(error);
    return { data: toModuleState(data), error: null };
  },
  async summary(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_get_connection_summary", { p_company_id: companyId });
    if (error) return fail(error);
    return { data: toConnectionSummary(data), error: null };
  },
  async disconnect(companyId, confirm) {
    const { error } = await supabase.rpc("whatsapp_disconnect", { p_company_id: companyId, p_confirm: confirm });
    if (error) return fail(error);
    return { data: true, error: null };
  },
  async indicators(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_ia_indicators", { p_company_id: companyId });
    if (error) return fail(error);
    return { data: toAiIndicators(data), error: null };
  },
};
