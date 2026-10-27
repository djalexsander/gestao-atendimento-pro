// Despacho OFICIAL de uma mensagem outbound 'queued' (compartilhado por whatsapp-send e whatsapp-ai-auto).
//
// Cobre as etapas 2 e 3 do envio, SEM mudar nada do comportamento manual:
//   2. service_role -> whatsapp_get_send_context: ÚNICA leitura do token (Vault); revalida conexão/destinatário.
//   3. Graph API (adapter) -> whatsapp_mark_message_sent (1 retry) ou whatsapp_mark_message_failed (código sanitizado).
// A criação da mensagem 'queued' (etapa 1) fica com quem chama: o envio manual usa whatsapp_prepare_outbound_message com o
// JWT do usuário; o automático usa whatsapp_ai_auto_commit_send (revalidação final sob lock). Nenhum token, telefone ou
// texto é logado aqui.
import type { GraphSender } from "./whatsapp-graph.ts";

export interface DispatchRpcError {
  code?: string;
  message: string;
  status?: number;
}
export interface DispatchRpcResult {
  data: unknown;
  error: DispatchRpcError | null;
}
export interface DispatchRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<DispatchRpcResult>;
}

export const SEND_GENERIC_ERROR = "Não foi possível enviar a mensagem agora. Tente novamente em instantes.";

export type DispatchResult =
  | { ok: true }
  | { ok: false; errorCode: string; http: number; friendly: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function call(client: DispatchRpcClient, fn: string, args: Record<string, unknown>): Promise<DispatchRpcResult> {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("whatsapp-dispatch: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

export async function markMessageFailed(admin: DispatchRpcClient, messageId: string, code: string): Promise<void> {
  const r = await call(admin, "whatsapp_mark_message_failed", { p_message_id: messageId, p_error_code: code });
  if (r.error) console.error("whatsapp-dispatch: não registrou a falha", { code: r.error.code ?? null });
}

/** Anexo de uma mensagem 'queued' do tipo document: o texto da mensagem vira a LEGENDA. */
export interface DispatchDocument {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** Envia a mensagem 'queued' pelo fluxo oficial e deixa o status final registrado (sent ou failed). Com `document`, envia por media_id. */
export async function dispatchQueuedMessage(
  deps: { admin: DispatchRpcClient; graph: GraphSender; graphVersion: string },
  messageId: string,
  document?: DispatchDocument,
): Promise<DispatchResult> {
  const { admin, graph, graphVersion } = deps;

  // 2) contexto do envio (token só aqui)
  const ctxRes = await call(admin, "whatsapp_get_send_context", { p_message_id: messageId });
  const ctx = isObj(ctxRes.data) ? ctxRes.data : null;
  if (ctxRes.error || !ctx) {
    console.error("whatsapp-dispatch: contexto indisponível", { code: ctxRes.error?.code ?? null });
    await markMessageFailed(admin, messageId, "context_error");
    return { ok: false, errorCode: "context_error", http: 502, friendly: SEND_GENERIC_ERROR };
  }
  if (ctx.ok !== true) {
    const reason = typeof ctx.error === "string" ? ctx.error : "context_error";
    await markMessageFailed(admin, messageId, reason);
    if (reason === "test_recipient_blocked") {
      return { ok: false, errorCode: reason, http: 403, friendly: "Destinatário não autorizado no modo de teste." };
    }
    if (reason === "connection_inactive") {
      return { ok: false, errorCode: reason, http: 409, friendly: "O WhatsApp desta empresa não está conectado." };
    }
    if (reason === "module_inactive") {
      return { ok: false, errorCode: reason, http: 403, friendly: "O módulo WhatsApp não está contratado. O histórico continua disponível para consulta." };
    }
    return { ok: false, errorCode: reason, http: 503, friendly: "A conexão do WhatsApp não está disponível. Procure o administrador." };
  }
  const phoneNumberId = typeof ctx.phone_number_id === "string" ? ctx.phone_number_id : "";
  const recipient = typeof ctx.recipient_phone === "string" ? ctx.recipient_phone : "";
  const text = typeof ctx.body === "string" ? ctx.body : "";
  const token = typeof ctx.access_token === "string" ? ctx.access_token : "";
  if (!phoneNumberId || !recipient || !text || !token) {
    await markMessageFailed(admin, messageId, "context_error");
    return { ok: false, errorCode: "context_error", http: 502, friendly: SEND_GENERIC_ERROR };
  }

  // 3) Graph API
  let result;
  if (document) {
    if (!graph.uploadMedia || !graph.sendDocument) {
      await markMessageFailed(admin, messageId, "context_error");
      return { ok: false, errorCode: "context_error", http: 502, friendly: SEND_GENERIC_ERROR };
    }
    // upload ANTES; só com o media_id aceito pela Meta a mensagem de documento é enviada
    const up = await graph.uploadMedia({ version: graphVersion, phoneNumberId, accessToken: token, bytes: document.bytes, mimeType: document.mimeType, filename: document.filename });
    if (!up.ok) {
      const upCode = (up.kind === "http" ? `media_${up.code ?? up.status ?? "error"}` : `media_${up.kind}`).slice(0, 64);
      console.error("whatsapp-dispatch: upload da mídia falhou", { kind: up.kind, status: up.status ?? null, code: upCode });
      await markMessageFailed(admin, messageId, upCode);
      return { ok: false, errorCode: upCode, http: up.kind === "timeout" ? 504 : 502, friendly: SEND_GENERIC_ERROR };
    }
    result = await graph.sendDocument({ version: graphVersion, phoneNumberId, accessToken: token, to: recipient, mediaId: up.mediaId, filename: document.filename, caption: text });
  } else {
    result = await graph.sendText({ version: graphVersion, phoneNumberId, accessToken: token, to: recipient, body: text });
  }

  if (result.ok) {
    let mark = await call(admin, "whatsapp_mark_message_sent", { p_message_id: messageId, p_provider_message_id: result.messageId });
    if (mark.error) mark = await call(admin, "whatsapp_mark_message_sent", { p_message_id: messageId, p_provider_message_id: result.messageId });
    if (mark.error) console.error("whatsapp-dispatch: enviada, mas não registrou o id", { code: mark.error.code ?? null });
    return { ok: true };
  }

  let errorCode: string;
  let http = 502;
  let friendly = "O WhatsApp recusou a mensagem. Tente novamente.";
  if (result.kind === "timeout") {
    errorCode = "timeout";
    http = 504;
    friendly = "O WhatsApp demorou para responder. Confira o status da mensagem antes de reenviar.";
  } else if (result.kind === "network") {
    errorCode = "network";
    friendly = "Não foi possível falar com o WhatsApp agora. Tente novamente.";
  } else if (result.kind === "invalid_response") {
    errorCode = "invalid_response";
  } else if (result.status === 401 || result.code === "190") {
    errorCode = "graph_auth";
    friendly = "A conexão do WhatsApp precisa ser reconectada. Procure o administrador.";
  } else if (result.status === 429 || result.code === "130429" || result.code === "80007") {
    errorCode = "graph_rate_limit";
    http = 429;
    friendly = "Muitas mensagens em pouco tempo. Aguarde um instante e tente de novo.";
  } else {
    errorCode = `graph_${result.code ?? result.status ?? "error"}`;
  }
  console.error("whatsapp-dispatch: envio falhou", { kind: result.kind, status: result.status ?? null, code: errorCode });
  await markMessageFailed(admin, messageId, errorCode);
  return { ok: false, errorCode, http, friendly };
}
