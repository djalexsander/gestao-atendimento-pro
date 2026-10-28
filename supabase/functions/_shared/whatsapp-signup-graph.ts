// Cliente da Graph API da Meta usado SÓ pelo Embedded Signup v4 (troca do code, validação da WABA/número, registro e
// assinatura do app). Endpoints confirmados na documentação oficial (developers.facebook.com, Embedded Signup v4 / Tech Provider):
//   GET  /{version}/oauth/access_token?client_id&client_secret&code   -> business token (o code vale ~30 s)
//   GET  /{version}/{waba_id}/phone_numbers                           -> números da WABA (id, display_phone_number, verified_name)
//   POST /{version}/{phone_number_id}/register {messaging_product, pin} -> {success}
//   POST /{version}/{waba_id}/subscribed_apps                         -> {success}
//   GET  /{version}/{waba_id}/subscribed_apps                         -> data[].whatsapp_business_api_data.{id,name}
// NÃO confirmados (por isso não usados): redirect_uri na troca do code, debug_token/granular_scopes, validade do business token.
// Nada aqui registra code, token, client_secret, URL (o secret vai na query da troca) nem corpo de resposta da Meta.
import { GRAPH_BASE_URL } from "./whatsapp-graph.ts";

export const SIGNUP_GRAPH_TIMEOUT_MS = 10_000;
const MAX_PHONE_PAGES = 5;

export type SignupGraphFailure = { ok: false; kind: "http" | "timeout" | "network" | "invalid_response"; status?: number; code?: string };
export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface WabaPhone {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

export interface SignupMeta {
  exchangeCode(a: { version: string; appId: string; appSecret: string; code: string }): Promise<{ ok: true; token: string; expiresInSeconds: number | null } | SignupGraphFailure>;
  listWabaPhones(a: { version: string; wabaId: string; token: string }): Promise<{ ok: true; phones: WabaPhone[] } | SignupGraphFailure>;
  registerPhone(a: { version: string; phoneNumberId: string; token: string; pin: string }): Promise<{ ok: true } | SignupGraphFailure>;
  subscribeApp(a: { version: string; wabaId: string; token: string }): Promise<{ ok: true } | SignupGraphFailure>;
  listSubscribedAppIds(a: { version: string; wabaId: string; token: string }): Promise<{ ok: true; appIds: string[] } | SignupGraphFailure>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Código numérico do erro da Meta (error.code) — o único detalhe do corpo que é guardado. */
function metaErrorCode(body: unknown): string | undefined {
  if (!isObj(body) || !isObj(body.error)) return undefined;
  const c = body.error.code;
  return typeof c === "number" && Number.isFinite(c) ? String(c) : undefined;
}

async function request(
  fetchFn: FetchFn,
  url: string,
  init: Record<string, unknown>,
): Promise<{ ok: true; text: string } | SignupGraphFailure> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SIGNUP_GRAPH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = metaErrorCode(JSON.parse(text));
      } catch { /* corpo não-JSON */ }
      return { ok: false, kind: "http", status: res.status, code };
    }
    return { ok: true, text };
  } catch (e) {
    return { ok: false, kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const seg = (v: string) => encodeURIComponent(v);

export function createSignupMeta(fetchFn: FetchFn): SignupMeta {
  return {
    async exchangeCode({ version, appId, appSecret, code }) {
      const q = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
      const r = await request(fetchFn, `${GRAPH_BASE_URL}/${version}/oauth/access_token?${q.toString()}`, { method: "GET" });
      if (!r.ok) return r;
      // A documentação descreve a resposta como o token; aceita-se JSON {access_token[, expires_in]} ou o token puro.
      const body = parseJson(r.text);
      let token: string | null = null;
      let expiresIn: number | null = null;
      if (isObj(body)) {
        token = str(body.access_token);
        if (typeof body.expires_in === "number" && body.expires_in > 0) expiresIn = body.expires_in;
      } else if (typeof body === "string") {
        token = str(body);
      } else {
        const plain = r.text.trim();
        if (plain && !/\s/.test(plain)) token = plain;
      }
      if (!token || token.length < 20) return { ok: false, kind: "invalid_response" };
      return { ok: true, token, expiresInSeconds: expiresIn };
    },

    async listWabaPhones({ version, wabaId, token }) {
      const phones: WabaPhone[] = [];
      let url: string | null = `${GRAPH_BASE_URL}/${version}/${seg(wabaId)}/phone_numbers`;
      for (let page = 0; url && page < MAX_PHONE_PAGES; page += 1) {
        const r = await request(fetchFn, url, { method: "GET", headers: bearer(token) });
        if (!r.ok) return r;
        const body = parseJson(r.text);
        if (!isObj(body) || !Array.isArray(body.data)) return { ok: false, kind: "invalid_response" };
        for (const item of body.data) {
          if (!isObj(item)) continue;
          const id = str(item.id);
          if (id) phones.push({ id, displayPhoneNumber: str(item.display_phone_number), verifiedName: str(item.verified_name) });
        }
        const next = isObj(body.paging) ? str(body.paging.next) : null;
        // só segue paginação para o próprio Graph (o Bearer nunca vai a outro host)
        url = next && next.startsWith(`${GRAPH_BASE_URL}/`) ? next : null;
      }
      return { ok: true, phones };
    },

    async registerPhone({ version, phoneNumberId, token, pin }) {
      const r = await request(fetchFn, `${GRAPH_BASE_URL}/${version}/${seg(phoneNumberId)}/register`, {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      });
      if (!r.ok) return r;
      const body = parseJson(r.text);
      return isObj(body) && body.success === true ? { ok: true } : { ok: false, kind: "invalid_response" };
    },

    async subscribeApp({ version, wabaId, token }) {
      const r = await request(fetchFn, `${GRAPH_BASE_URL}/${version}/${seg(wabaId)}/subscribed_apps`, { method: "POST", headers: bearer(token) });
      if (!r.ok) return r;
      const body = parseJson(r.text);
      return isObj(body) && body.success === true ? { ok: true } : { ok: false, kind: "invalid_response" };
    },

    async listSubscribedAppIds({ version, wabaId, token }) {
      const r = await request(fetchFn, `${GRAPH_BASE_URL}/${version}/${seg(wabaId)}/subscribed_apps`, { method: "GET", headers: bearer(token) });
      if (!r.ok) return r;
      const body = parseJson(r.text);
      if (!isObj(body) || !Array.isArray(body.data)) return { ok: false, kind: "invalid_response" };
      const appIds: string[] = [];
      for (const item of body.data) {
        const api = isObj(item) && isObj(item.whatsapp_business_api_data) ? item.whatsapp_business_api_data : null;
        const id = api ? str(api.id) : null;
        if (id) appIds.push(id);
      }
      return { ok: true, appIds };
    },
  };
}

/**
 * PIN de 6 dígitos da verificação em duas etapas, DERIVADO (HMAC-SHA256 do phone_number_id com um secret do servidor):
 * é o mesmo em toda tentativa para aquele número e dispensa guardar o PIN no banco.
 */
export async function derivePin(secret: string, phoneNumberId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`wa-registration-pin:${phoneNumberId}`)));
  const n = ((sig[0] << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}
