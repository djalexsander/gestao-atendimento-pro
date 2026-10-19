import { supabase } from "../../lib/supabaseClient";
import { toAiSettings, type AiSettings } from "./whatsappLogic";

export type AiResult<T> = { data: T; error: null } | { data: null; error: string };

export interface AiSettingsInput {
  enabled: boolean;
  mode: "off" | "suggest" | "auto";
  businessName: string;
  tone: string;
  customInstructions: string;
  businessHours: string;
  fallbackToHuman: boolean;
  maxContextMessages: number;
  acknowledge: boolean;
  /** Confirmação específica do modo automático (exigida na primeira ativação; o banco confere de novo). */
  acknowledgeAuto: boolean;
  /** Repassados como estão (ainda sem tela própria): salvar nunca pode apagar horário/política configurados. */
  afterHoursPolicy: "ai_continues" | "silent" | "message";
  afterHoursMessage: string;
  businessSchedule: unknown;
}

// Configuração da IA do WhatsApp (owner/admin). Provider/modelo NÃO são configuráveis aqui (vêm de Edge Secrets).
export interface AiSettingsSource {
  get(companyId: string): Promise<AiResult<AiSettings>>;
  save(companyId: string, input: AiSettingsInput): Promise<AiResult<AiSettings>>;
}

const GENERIC = "Não foi possível carregar a configuração da IA agora. Tente novamente.";

export const supabaseAiSettingsSource: AiSettingsSource = {
  async get(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_ai_get_settings", { p_company_id: companyId });
    if (error) {
      console.error("Falha na configuração da IA do WhatsApp:", error.code ?? "sem código");
      return { data: null, error: GENERIC };
    }
    return { data: toAiSettings(data), error: null };
  },
  async save(companyId, input) {
    const { data, error } = await supabase.rpc("whatsapp_ai_update_settings", {
      p_company_id: companyId,
      p_enabled: input.enabled,
      p_mode: input.mode,
      p_business_name: input.businessName,
      p_tone: input.tone,
      p_custom_instructions: input.customInstructions,
      p_business_hours: input.businessHours.trim() ? { text: input.businessHours.trim() } : null,
      p_fallback_to_human: input.fallbackToHuman,
      p_max_context_messages: input.maxContextMessages,
      p_acknowledge: input.acknowledge,
      p_acknowledge_auto: input.acknowledgeAuto,
      p_after_hours_policy: input.afterHoursPolicy,
      p_after_hours_message: input.afterHoursMessage,
      p_business_schedule: input.businessSchedule ?? null,
    });
    if (error) {
      console.error("Falha ao salvar a IA do WhatsApp:", error.code ?? "sem código");
      // PT400/403/409 do banco já vêm em português amigável
      if (error.code && /^PT40\d$/.test(error.code) && error.message) return { data: null, error: error.message };
      return { data: null, error: "Não foi possível salvar agora. Tente novamente." };
    }
    return { data: toAiSettings(data), error: null };
  },
};
