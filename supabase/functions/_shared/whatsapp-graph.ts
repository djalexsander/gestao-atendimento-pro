// Adapter da Graph API da Meta (WhatsApp Cloud API) — envio de texto e de DOCUMENTO (upload de mídia + media_id; nunca link).
// A versão da API é CENTRALIZADA aqui:
// vem do secret WHATSAPP_GRAPH_API_VERSION (sem default de propósito: uma versão fixa no código envelhece e a Meta a
// descontinua; sem a variável o envio falha fechado). Nada deste módulo registra token, corpo ou telefone.
export const GRAPH_BASE_URL = "https://graph.facebook.com";
export const GRAPH_SEND_TIMEOUT_MS = 10_000;
export const GRAPH_UPLOAD_TIMEOUT_MS = 20_000;

const VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;
export const isValidGraphVersion = (v: string | undefined | null): v is string => typeof v === "string" && VERSION_RE.test(v);

export interface GraphSendArgs {
  version: string;
  phoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
}

export type GraphFailure = { ok: false; kind: "http" | "timeout" | "network" | "invalid_response"; status?: number; code?: string; subcode?: string };
export type GraphSendResult = { ok: true; messageId: string } | GraphFailure;

export interface GraphUploadArgs {
  version: string;
  phoneNumberId: string;
  accessToken: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}
export type GraphUploadResult = { ok: true; mediaId: string } | GraphFailure;

export interface GraphDocumentArgs {
  version: string;
  phoneNumberId: string;
  accessToken: string;
  to: string;
  mediaId: string;
  filename: string;
  caption: string;
}

export interface GraphSender {
  sendText(args: GraphSendArgs): Promise<GraphSendResult>;
  /** Upload de mídia (POST /{phone_number_id}/media). Opcional: só o envio de documento precisa. */
  uploadMedia?(args: GraphUploadArgs): Promise<GraphUploadResult>;
  /** Mensagem do tipo document por media_id (sem link externo). */
  sendDocument?(args: GraphDocumentArgs): Promise<GraphSendResult>;
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

/** Requisição oficial de upload: multipart com messaging_product + type + file (o Content-Type com boundary é do runtime). */
export function buildUploadRequest(a: GraphUploadArgs): { url: string; init: { method: string; headers: Record<string, string>; body: FormData } } {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", a.mimeType);
  form.append("file", new Blob([new Uint8Array(a.bytes)], { type: a.mimeType }), a.filename);
  return {
    url: `${GRAPH_BASE_URL}/${a.version}/${encodeURIComponent(a.phoneNumberId)}/media`,
    init: { method: "POST", headers: { Authorization: `Bearer ${a.accessToken}` }, body: form },
  };
}

/** Requisição oficial: mensagem do tipo document por media_id (legenda = texto da mensagem). */
export function buildDocumentRequest(a: GraphDocumentArgs): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  return {
    url: `${GRAPH_BASE_URL}/${a.version}/${encodeURIComponent(a.phoneNumberId)}/messages`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${a.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: a.to,
        type: "document",
        document: { id: a.mediaId, filename: a.filename, caption: a.caption },
      }),
    },
  };
}

type FetchImpl = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// Chamada única com timeout; devolve o corpo JSON (objeto) ou a falha já classificada. Nada é logado aqui.
async function callGraph(
  fetchImpl: FetchImpl,
  req: { url: string; init: Record<string, unknown> },
  timeoutMs: number,
): Promise<{ ok: true; status: number; obj: Record<string, unknown> } | GraphFailure> {
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
      const sub = typeof err.error_subcode === "number" || typeof err.error_subcode === "string" ? String(err.error_subcode) : undefined;
      return { ok: false, kind: "http", status: res.status, code, ...(sub && /^[0-9]{1,6}$/.test(sub) ? { subcode: sub } : {}) };
    }
    return { ok: true, status: res.status, obj };
  } catch (e) {
    return { ok: false, kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function messageIdOf(r: { status: number; obj: Record<string, unknown> }): GraphSendResult {
  const first = Array.isArray(r.obj.messages) ? (r.obj.messages[0] as Record<string, unknown> | undefined) : undefined;
  const id = first && typeof first.id === "string" && first.id ? first.id : null;
  return id ? { ok: true, messageId: id } : { ok: false, kind: "invalid_response", status: r.status };
}

export function createGraphSender(fetchImpl: FetchImpl, timeoutMs = GRAPH_SEND_TIMEOUT_MS, uploadTimeoutMs = GRAPH_UPLOAD_TIMEOUT_MS): GraphSender {
  return {
    async sendText(a) {
      const r = await callGraph(fetchImpl, buildSendRequest(a), timeoutMs);
      return r.ok ? messageIdOf(r) : r;
    },
    async uploadMedia(a) {
      const r = await callGraph(fetchImpl, buildUploadRequest(a), uploadTimeoutMs);
      if (!r.ok) return r;
      const id = typeof r.obj.id === "string" && r.obj.id ? r.obj.id : null;
      return id ? { ok: true, mediaId: id } : { ok: false, kind: "invalid_response", status: r.status };
    },
    async sendDocument(a) {
      const r = await callGraph(fetchImpl, buildDocumentRequest(a), timeoutMs);
      return r.ok ? messageIdOf(r) : r;
    },
  };
}
