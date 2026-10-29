import { supabase } from "../../../lib/supabaseClient";
import {
  friendlyRpcError,
  parseHistory,
  parsePilotEvents,
  parsePilotList,
  parseRegistrations,
  parseSignupAvailable,
  parseSweepStatus,
  parseTokenHealth,
  type EvidenceType,
  type HistoryPage,
  type Outcome,
  type PilotEvent,
  type PilotRow,
  type RegistrationRow,
  type RunSource,
  type RunStatus,
  type SweepStatus,
  type TokenHealthRow,
} from "./whatsappMasterLogic";

// Toda chamada vai por RPC SECURITY DEFINER que reautentica o Admin Master no banco (assert_master_admin()).
// Nenhuma tabela é lida diretamente e nenhum company_id daqui é confiado: o backend revalida tudo.
// Erros viram mensagens seguras (friendlyRpcError); falhas de rede nunca derrubam a tela.

export type RpcClient = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export interface ApiResult<T> {
  data: T;
  error: string | null;
}

export function createWhatsappMasterApi(client: RpcClient) {
  async function call(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: string | null }> {
    try {
      const { data, error } = await client.rpc(fn, args);
      if (error) return { data: null, error: friendlyRpcError(error.message) };
      return { data, error: null };
    } catch (e) {
      return { data: null, error: friendlyRpcError(e instanceof Error ? e.message : "network") };
    }
  }
  const bad = "Resposta inesperada do servidor.";

  return {
    async sweepStatus(): Promise<ApiResult<SweepStatus | null>> {
      const r = await call("master_whatsapp_token_sweep_status");
      if (r.error) return { data: null, error: r.error };
      const s = parseSweepStatus(r.data);
      return { data: s, error: s ? null : bad };
    },
    async sweepHistory(f: { status?: RunStatus | null; source?: RunSource | null; limit: number; offset: number }): Promise<ApiResult<HistoryPage | null>> {
      const r = await call("master_whatsapp_token_sweep_history", { p_status: f.status ?? null, p_source: f.source ?? null, p_limit: f.limit, p_offset: f.offset });
      if (r.error) return { data: null, error: r.error };
      const h = parseHistory(r.data);
      return { data: h, error: h ? null : bad };
    },
    async tokenHealth(): Promise<ApiResult<TokenHealthRow[]>> {
      const r = await call("master_whatsapp_token_health");
      return r.error ? { data: [], error: r.error } : { data: parseTokenHealth(r.data), error: null };
    },
    async pilotList(): Promise<ApiResult<PilotRow[]>> {
      const r = await call("master_whatsapp_pilot_list");
      return r.error ? { data: [], error: r.error } : { data: parsePilotList(r.data), error: null };
    },
    async pilotEvents(companyId: string): Promise<ApiResult<PilotEvent[]>> {
      const r = await call("master_whatsapp_pilot_events", { p_company_id: companyId });
      return r.error ? { data: [], error: r.error } : { data: parsePilotEvents(r.data), error: null };
    },
    /** Autoriza/revoga UMA empresa. A flag global NÃO é alterada por aqui (não existe RPC para isso). */
    async pilotSet(companyId: string, authorized: boolean, note: string): Promise<ApiResult<boolean>> {
      const r = await call("master_whatsapp_pilot_set", { p_company_id: companyId, p_authorized: authorized, p_note: note.trim() });
      return r.error ? { data: false, error: r.error } : { data: true, error: null };
    },
    /** Só o booleano "o Embedded Signup está liberado globalmente?" (somente leitura). */
    async signupAvailable(): Promise<ApiResult<boolean | null>> {
      const r = await call("whatsapp_signup_availability");
      return r.error ? { data: null, error: r.error } : { data: parseSignupAvailable(r.data), error: null };
    },
    async registrations(): Promise<ApiResult<RegistrationRow[]>> {
      const r = await call("master_whatsapp_registration_list");
      return r.error ? { data: [], error: r.error } : { data: parseRegistrations(r.data), error: null };
    },
    /** Resolução administrativa auditada. NUNCA repete o registro na Meta. */
    async resolveRegistration(p: { registrationId: string; outcome: Outcome; evidenceType: EvidenceType; reason: string; evidence: string }): Promise<ApiResult<boolean>> {
      const r = await call("master_whatsapp_registration_resolve", {
        p_registration_id: p.registrationId,
        p_outcome: p.outcome,
        p_evidence_type: p.evidenceType,
        p_reason: p.reason.trim(),
        p_evidence: p.evidence.trim(),
      });
      if (r.error) return { data: false, error: r.error };
      const ok = !!r.data && typeof r.data === "object" && (r.data as { ok?: unknown }).ok === true;
      if (ok) return { data: true, error: null };
      const code = r.data && typeof r.data === "object" ? String((r.data as { error?: unknown }).error ?? "") : "";
      const msg =
        code === "operation_may_be_in_flight"
          ? "A tentativa ainda pode estar em andamento na Meta (menos de 30 minutos). Tente novamente depois."
          : code === "state_not_allowed"
            ? "Este registro já não está mais pendente de resolução."
            : code === "registration_not_found"
              ? "Registro não encontrado."
              : "Não foi possível resolver o registro.";
      return { data: false, error: msg };
    },
  };
}

export const whatsappMasterApi = createWhatsappMasterApi(supabase as unknown as RpcClient);
