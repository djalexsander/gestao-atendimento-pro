import { supabase } from "../../lib/supabaseClient";
import { toBusinessProfile, type BusinessProfile, type BusinessProfileInput } from "./whatsappKnowledgeLogic";
import type { AiResult } from "./whatsappAiApi";

// Perfil comercial da empresa (owner/admin). Esta etapa só GUARDA os dados: a IA ainda não os usa (knowledge_enabled segue falso).
export interface KnowledgeSource {
  get(companyId: string): Promise<AiResult<BusinessProfile>>;
  save(companyId: string, input: BusinessProfileInput): Promise<AiResult<BusinessProfile>>;
}

export const supabaseKnowledgeSource: KnowledgeSource = {
  async get(companyId) {
    const { data, error } = await supabase.rpc("whatsapp_ai_get_business_profile", { p_company_id: companyId });
    if (error) {
      console.error("Falha ao carregar o conhecimento da empresa:", error.code ?? "sem código");
      return { data: null, error: "Não foi possível carregar os dados da empresa agora. Tente novamente." };
    }
    return { data: toBusinessProfile(data), error: null };
  },
  async save(companyId, input) {
    const { data, error } = await supabase.rpc("whatsapp_ai_update_business_profile", {
      p_company_id: companyId,
      p_address_text: input.addressText.trim() || null,
      p_timezone: input.timezone,
      p_weekly_hours: input.weeklyHours ?? null,
      p_closed_dates: input.closedDates.length ? input.closedDates.map((c) => (c.label.trim() ? { date: c.date, label: c.label.trim() } : { date: c.date })) : null,
      p_payment_methods: input.paymentMethods,
      p_pix_instructions: input.pixInstructions.trim() || null,
      p_public_notes: input.publicNotes.trim() || null,
      p_ai_availability_mode: input.aiAvailabilityMode,
      p_knowledge_enabled: false,
    });
    if (error) {
      console.error("Falha ao salvar o conhecimento da empresa:", error.code ?? "sem código");
      if (error.code && /^PT40\d$/.test(error.code) && error.message) return { data: null, error: error.message };
      return { data: null, error: "Não foi possível salvar agora. Tente novamente." };
    }
    return { data: toBusinessProfile(data), error: null };
  },
};
