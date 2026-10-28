import { supabase } from "../../lib/supabaseClient";
import { loadFacebookSdk } from "./facebookSdk";
import type { BeginResult, CompletePayload, CompleteResult, FlowDeps } from "./whatsappSignupFlow";
import { mapBeginFailure, mapCompleteFailure, signupFailure, toSignupSession } from "./whatsappSignupLogic";

// Integração real do cadastro integrado: RPC whatsapp_signup_begin (usuário autenticado) e Edge whatsapp-signup-complete.
// Nada daqui registra code, PIN, token ou corpo de resposta: os logs têm só texto fixo.

async function begin(companyId: string): Promise<BeginResult> {
  const { data, error } = await supabase.rpc("whatsapp_signup_begin", { p_company_id: companyId });
  if (error) {
    console.error("Cadastro integrado do WhatsApp: falha ao iniciar", error.code ?? "sem código");
    return { ok: false, failure: mapBeginFailure(error.code) };
  }
  const session = toSignupSession(data);
  if (!session) {
    console.error("Cadastro integrado do WhatsApp: resposta de início inválida");
    return { ok: false, failure: signupFailure("generic") };
  }
  return { ok: true, session };
}

async function errorBody(error: unknown): Promise<{ status: number | null; code: string | null }> {
  try {
    const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown> } }).context;
    const status = typeof ctx?.status === "number" ? ctx.status : null;
    let code: string | null = null;
    if (ctx?.json) {
      const body = (await ctx.json()) as { code?: unknown } | null;
      code = typeof body?.code === "string" ? body.code : null;
    }
    return { status, code };
  } catch {
    return { status: null, code: null };
  }
}

async function complete(payload: CompletePayload): Promise<CompleteResult> {
  const { data, error } = await supabase.functions.invoke("whatsapp-signup-complete", { body: payload });
  if (error) {
    const e = await errorBody(error);
    console.error("Cadastro integrado do WhatsApp: falha ao concluir", e.status ?? "sem status", e.code ?? "sem código");
    return { ok: false, failure: mapCompleteFailure(e.status, e.code) };
  }
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (o.ok !== true) return { ok: false, failure: signupFailure("generic") };
  return {
    ok: true,
    displayPhoneNumber: typeof o.display_phone_number === "string" ? o.display_phone_number : null,
    businessName: typeof o.business_name === "string" ? o.business_name : null,
  };
}

/** Dependências reais do fluxo para uma empresa. */
export function realSignupDeps(companyId: string): FlowDeps {
  return {
    begin: () => begin(companyId),
    loadSdk: (appId) => loadFacebookSdk(appId),
    listen: (handler) => {
      const fn = (e: MessageEvent) => handler({ origin: e.origin, data: e.data });
      window.addEventListener("message", fn);
      return () => window.removeEventListener("message", fn);
    },
    complete,
    setTimer: (fn, ms) => {
      const h = window.setTimeout(fn, ms);
      return () => window.clearTimeout(h);
    },
  };
}
