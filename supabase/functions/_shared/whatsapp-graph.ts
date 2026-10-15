// Adapter da Graph API da Meta (WhatsApp Cloud API) — SÓ envio de texto nesta fase. A versão da API é CENTRALIZADA aqui:
// vem do secret WHATSAPP_GRAPH_API_VERSION (sem default de propósito: uma versão fixa no código envelhece e a Meta a
// descontinua; sem a variável o envio falha fechado). Nada deste módulo registra token, corpo ou telefone.
export const GRAPH_BASE_URL = "https://graph.facebook.com";
export const GRAPH_SEND_TIMEOUT_MS = 10_000;

const VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;
export const isValidGraphVersion = (v: string | undefined | null): v is string => typeof v === "string" && VERSION_RE.test(v);

export interface GraphSendArgs {
  version: string;
  phoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
}

export type GraphSendResult =
  | { ok: true; messageId: string }
  | { ok: false; kind: "http" | "timeout" | "network" | "invalid_response"; status?: number; code?: string };

export interface GraphSender {
  sendText(args: GraphSendArgs): Promise<GraphSendResult>;
}

/** Requisição oficial: POST /{version}/{phone_number_id}/messages (texto, sem preview de link). */
export function buildSendRequest(a: GraphSendArgs): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  return {
    url: `${GRAPH_BASE_URL}/${a.version}/${encodeURIComponent(a.phoneNumberId)}/messages`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${a.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: a.to,
        type: "text",
        text: { preview_url: false, body: a.body },
      }),
    },
  };
}

export function createGraphSender(
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  timeoutMs = GRAPH_SEND_TIMEOUT_MS,
): GraphSender {
  return {
    async sendText(a) {
      const req = buildSendRequest(a);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(req.url, { ...req.init, signal: controller.signal });
        let payload: unknown = null;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (!res.ok) {
          const err = obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : {};
          const code = typeof err.code === "number" || typeof err.code === "string" ? String(err.code) : undefined;
          return { ok: false, kind: "http", status: res.status, code };
        }
        const first = Array.isArray(obj.messages) ? (obj.messages[0] as Record<string, unknown> | undefined) : undefined;
        const id = first && typeof first.id === "string" && first.id ? first.id : null;
        return id ? { ok: true, messageId: id } : { ok: false, kind: "invalid_response", status: res.status };
      } catch (e) {
        return { ok: false, kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
