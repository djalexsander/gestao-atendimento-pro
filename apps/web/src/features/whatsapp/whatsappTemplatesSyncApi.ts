import { supabase } from "../../lib/supabaseClient";
import {
  mapSetSettingsError,
  NETWORK_SYNC_OUTCOME,
  toSavedStartSettings,
  toSyncOutcome,
  type SavedStartSettings,
  type StartSettingsFormIssues,
  type SyncOutcome,
} from "./whatsappTemplatesSyncLogic";

// Chamadas das duas telas da 7.11M. SEMPRE com a sessão do usuário (JWT): nada de service_role aqui. O corpo da Edge leva só o id da empresa; o token da
// Meta nunca passa pelo navegador. Quem pode o quê é decidido no servidor (RPC whatsapp_templates_sync_request e whatsapp_set_start_settings).

export type SettingsResult = { ok: true; data: SavedStartSettings } | { ok: false; message: string };

export interface TemplatesSyncSource {
  sync(companyId: string): Promise<SyncOutcome>;
}

export interface StartSettingsSource {
  /** Lê o estado. Falha (null) quando o Master não participa da empresa: a tela mostra isso, não inventa um estado. */
  read(companyId: string): Promise<SavedStartSettings | null>;
  save(companyId: string, value: NonNullable<StartSettingsFormIssues["value"]>): Promise<SettingsResult>;
}

/** Erro HTTP da Edge: FunctionsHttpError.context é a Response (status e corpo). Sem Response = a conexão falhou. */
async function edgeFailure(error: unknown): Promise<SyncOutcome> {
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown> } } | null)?.context;
  if (!ctx || typeof ctx.status !== "number") return NETWORK_SYNC_OUTCOME;
  let body: unknown = null;
  try {
    body = ctx.json ? await ctx.json() : null;
  } catch {
    body = null;
  }
  return toSyncOutcome(ctx.status, body);
}

export const supabaseTemplatesSync: TemplatesSyncSource = {
  async sync(companyId) {
    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-templates-sync", { body: { company_id: companyId } });
      if (error) {
        console.error("Falha ao atualizar os templates do WhatsApp");
        return edgeFailure(error);
      }
      return toSyncOutcome(200, data); // 200 e 202 chegam aqui; o status vem no corpo
    } catch {
      return NETWORK_SYNC_OUTCOME;
    }
  },
};

export const supabaseStartSettings: StartSettingsSource = {
  async read(companyId) {
    try {
      const { data, error } = await supabase.rpc("whatsapp_get_start_settings", { p_company_id: companyId });
      return error ? null : toSavedStartSettings(data);
    } catch {
      return null;
    }
  },
  async save(companyId, value) {
    try {
      const { data, error } = await supabase.rpc("whatsapp_set_start_settings", {
        p_company_id: companyId,
        p_enabled: value.enabled,
        p_daily_limit: value.dailyLimit,
        p_min_interval_hours: value.minIntervalHours,
      });
      if (error) {
        console.error("Falha ao salvar a configuração de iniciar conversa:", error.code ?? "sem código");
        return { ok: false, message: mapSetSettingsError(error) };
      }
      const saved = toSavedStartSettings(data);
      return saved ? { ok: true, data: saved } : { ok: false, message: "Resposta inesperada do servidor. Confira o estado antes de tentar de novo." };
    } catch {
      return { ok: false, message: mapSetSettingsError({}) };
    }
  },
};
