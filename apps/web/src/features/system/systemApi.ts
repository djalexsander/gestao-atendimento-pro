import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import {
  DEFAULT_OPERATIONAL_PREFERENCES,
  type DefaultPointType,
  type OperationalPreferences,
  type ServiceModeKey,
  type SettingsPayload,
  type SystemSettings,
} from "./systemLogic";

const LOAD_ERROR = "Não foi possível carregar as configurações agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar as configurações agora. Tente novamente.";

export type Result<T> = { data: T; error: null } | { data: null; error: string };

// Fonte de dados da tela (owner/admin). Recebida por parâmetro para exercitar a tela com dados simulados.
export interface SystemSettingsSource {
  load(companyId: string): Promise<Result<SystemSettings>>;
  save(companyId: string, payload: SettingsPayload): Promise<Result<SystemSettings>>;
}

interface RawSettings {
  company: { name: string; slug: string; document: string | null; phone: string | null; whatsapp: string | null; email: string | null };
  preferences: {
    service_mode: ServiceModeKey;
    default_service_point_type: DefaultPointType;
    allow_quick_customer_create: boolean;
    show_customer_on_service_card: boolean;
    compact_operational_cards: boolean;
    updated_at: string | null;
    updated_by_name: string | null;
  };
  timezone: string;
  currency: string;
}

function parse(raw: RawSettings): SystemSettings {
  return {
    company: raw.company,
    serviceMode: raw.preferences.service_mode,
    preferences: {
      defaultType: raw.preferences.default_service_point_type,
      allowQuickCustomerCreate: raw.preferences.allow_quick_customer_create,
      showCustomerOnCard: raw.preferences.show_customer_on_service_card,
      compactCards: raw.preferences.compact_operational_cards,
    },
    updatedAt: raw.preferences.updated_at,
    updatedByName: raw.preferences.updated_by_name,
    timezone: raw.timezone,
    currency: raw.currency,
  };
}

function fail<T>(error: { code?: string | null; message?: string | null }, fallback: string): Result<T> {
  console.error("Falha em Sistema / Preferências:", error.code ?? "sem código");
  return { data: null, error: describeOrderError(error, fallback) };
}

export const supabaseSystemSettingsSource: SystemSettingsSource = {
  async load(companyId) {
    const { data, error } = await supabase.rpc("get_company_preferences", { p_company_id: companyId });
    if (error) return fail(error, LOAD_ERROR);
    return { data: parse(data as RawSettings), error: null };
  },

  async save(companyId, p) {
    const { data, error } = await supabase.rpc("update_company_preferences", {
      p_company_id: companyId,
      p_name: p.name,
      p_document: p.document,
      p_phone: p.phone,
      p_whatsapp: p.whatsapp,
      p_email: p.email,
      p_default_service_point_type: p.defaultType,
      p_allow_quick_customer_create: p.allowQuickCustomerCreate,
      p_show_customer_on_service_card: p.showCustomerOnCard,
      p_compact_operational_cards: p.compactCards,
    });
    if (error) return fail(error, SAVE_ERROR);
    return { data: parse(data as RawSettings), error: null };
  },
};

// Preferências operacionais lidas pelas telas de atendimento (qualquer papel operacional): leitura direta da
// tabela 1:1 da empresa (RLS: todo vínculo ativo). Falhou ou sem linha = comportamento padrão de sempre.
export async function loadOperationalPreferences(companyId: string): Promise<OperationalPreferences> {
  const { data, error } = await supabase
    .from("company_operational_settings")
    .select("default_service_point_type, allow_quick_customer_create, show_customer_on_service_card, compact_operational_cards")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error || !data) return DEFAULT_OPERATIONAL_PREFERENCES;
  const r = data as {
    default_service_point_type: DefaultPointType;
    allow_quick_customer_create: boolean;
    show_customer_on_service_card: boolean;
    compact_operational_cards: boolean;
  };
  return {
    defaultType: r.default_service_point_type,
    allowQuickCustomerCreate: r.allow_quick_customer_create,
    showCustomerOnCard: r.show_customer_on_service_card,
    compactCards: r.compact_operational_cards,
  };
}
