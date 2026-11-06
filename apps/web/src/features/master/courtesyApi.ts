import { supabase } from "../../lib/supabaseClient";
import {
  asList,
  isRpcMissing,
  parseAttention,
  parseCounters,
  type AttentionFilter,
  type AttentionPage,
  type BillingRecord,
  type BridgeItem,
  type Courtesy,
  type CourtesyCounters,
  type CourtesyDetail,
} from "./courtesyLogic";

// SOMENTE LEITURA das cortesias (RPCs master_* com assert_master_admin no banco). Nenhuma RPC de escrita (conceder, prorrogar, encerrar,
// converter, reconciliar) é chamada por este módulo.
//
// DISPONIBILIDADE: o banco remoto pode ainda não ter as migrations de cortesia. Na primeira resposta "função inexistente" o recurso é
// marcado como indisponível NESTA SESSÃO e nenhuma outra chamada é feita (nada de laço de tentativas); só um clique explícito em
// "Verificar novamente" volta a perguntar.

export type CourtesyResult<T> =
  | { status: "ok"; data: T }
  | { status: "unavailable" }
  | { status: "error"; error: string };

let unavailable = false;

export const courtesyUnavailable = (): boolean => unavailable;
/** Uma chamada (de leitura ou de escrita) descobriu que as RPCs de cortesia não existem neste ambiente. */
export function markCourtesyUnavailable(): void {
  unavailable = true;
}
/** Ação explícita do Master ("Verificar novamente"): volta a permitir UMA nova tentativa. */
export function resetCourtesyAvailability(): void {
  unavailable = false;
}

async function call<T>(fn: string, args: Record<string, unknown>, map: (raw: unknown) => T | null): Promise<CourtesyResult<T>> {
  if (unavailable) return { status: "unavailable" };
  try {
    const { data, error, status } = await supabase.rpc(fn, args);
    if (error) {
      if (isRpcMissing({ code: error.code, message: error.message, status })) {
        unavailable = true;
        return { status: "unavailable" };
      }
      return { status: "error", error: error.message };
    }
    const mapped = map(data);
    return mapped === null ? { status: "error", error: "Resposta inesperada do servidor." } : { status: "ok", data: mapped };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "Falha ao consultar cortesias." };
  }
}

export const getCourtesyCounters = (withinDays = 7) =>
  call<CourtesyCounters>("master_get_courtesy_counters", { p_within_days: withinDays }, parseCounters);

export const listCourtesyAttention = (kind: AttentionFilter, withinDays: number, limit: number, offset: number) =>
  call<AttentionPage>("master_list_courtesy_attention", { p_kind: kind, p_within_days: withinDays, p_limit: limit, p_offset: offset }, parseAttention);

export const listCompanyCourtesies = (companyId: string, includeClosed: boolean) =>
  call<Courtesy[]>("master_list_company_courtesies", { p_company_id: companyId, p_include_closed: includeClosed }, (r) => asList<Courtesy>(r));

export const getCourtesyDetail = (courtesyId: string) =>
  call<CourtesyDetail>("master_get_courtesy", { p_courtesy_id: courtesyId }, (r) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const o = r as Record<string, unknown>;
    return { courtesy: o.courtesy as Courtesy, created_by_email: (o.created_by_email as string | null) ?? null, events: asList(o.events) };
  });

export const getCompanyBridges = (companyId: string) =>
  call<BridgeItem[]>("master_get_courtesy_bridge", { p_company_id: companyId }, (r) => asList<BridgeItem>(r));

export const listCourtesyBilling = (companyId: string) =>
  call<BillingRecord[]>("master_list_courtesy_billing", { p_company_id: companyId }, (r) => asList<BillingRecord>(r));

/** Pontes (ativas e expiradas ainda não resolvidas) de TODAS as empresas: dado real para distinguir ponte 2C de cortesia preservada na lista. */
export const listActiveBridges = () =>
  call<Array<BridgeItem & { company_name?: string }>>("master_list_courtesy_bridges", { p_only_active: true }, (r) => asList<BridgeItem & { company_name?: string }>(r));
