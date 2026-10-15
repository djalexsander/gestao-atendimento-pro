// Edge Function whatsapp-send (verify_jwt = true): envio MANUAL de texto pelo WhatsApp (Cloud API oficial).
//
// Fluxo (a mensagem existe ANTES da chamada externa):
//   1. JWT do usuário -> RPC whatsapp_prepare_outbound_message: valida papel, módulo, conexão ativa, conversa aberta,
//      janela de 24 h e, no modo 'test', a lista de destinatários; grava a mensagem 'queued' (idempotente por
//      client_request_id). Nada de conexão ou segredo volta ao usuário.
//   2. service_role -> whatsapp_get_send_context: ÚNICA leitura do token (Vault). Revalida conexão/destinatário.
//   3. Graph API (adapter). Sucesso -> whatsapp_mark_message_sent; falha -> whatsapp_mark_message_failed (código sanitizado).
//   O corpo recebido é só { conversation_id, client_request_id, body }: o token NUNCA vem do cliente nem volta a ele.
//   Nenhum token, Authorization, telefone ou texto é logado (só nome da etapa e códigos).
import { type GraphSender, isValidGraphVersion } from "../_shared/whatsapp-graph.ts";

export interface RpcError {
  code?: string;
  message: string;
  status?: number;
}
export interface RpcResult {
  data: unknown;
  error: RpcError | null;
}
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface SendDeps {
  /** Client do supabase-js escopado ao JWT de quem chamou (auth.uid() nas RPCs é o usuário). */
  createUserClient(authorization: string): RpcClient;
  /** Client com service_role: só as funções internas de envio. */
  admin: RpcClient;
  graph: GraphSender;
  /** WHATSAPP_GRAPH_API_VERSION (obrigatório; sem default). */
  graphVersion: string | undefined;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mensagem 'queued' além disto sem resposta = envio interrompido: libera para o usuário tentar de novo.
export const STALE_QUEUED_SECONDS = 120;

const GENERIC_ERROR = "Não foi possível enviar a mensagem agora. Tente novamente em instantes.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("whatsapp-send: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

// As RPCs do usuário levantam PT400/401/403/404/409 com mensagem amigável em português.
function userRpcFailure(e: RpcError): Response {
  const map: Record<string, number> = { PT400: 400, PT401: 401, PT403: 403, PT404: 404, PT409: 409 };
  if (e.code && map[e.code]) return json({ error: e.message }, map[e.code]);
  if (e.status === 401 || e.code === "PGRST301") return json({ error: "Sessão inválida ou expirada." }, 401);
  console.error("whatsapp-send: erro inesperado na preparação", { code: e.code ?? null });
  return json({ error: GENERIC_ERROR }, 500);
}

async function markFailed(admin: RpcClient, messageId: string, code: string): Promise<void> {
  const r = await call(admin, "whatsapp_mark_message_failed", { p_message_id: messageId, p_error_code: code });
  if (r.error) console.error("whatsapp-send: não registrou a falha", { code: r.error.code ?? null });
}

export async function handleWhatsappSend(req: Request, deps: SendDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json({ error: "Sessão inválida ou expirada." }, 401);

  if (!isValidGraphVersion(deps.graphVersion)) {
    console.error("whatsapp-send: WHATSAPP_GRAPH_API_VERSION ausente ou inválida");
    return json({ error: "Envio indisponível." }, 503);
  }

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  if (!isObj(input)) return json({ error: "Requisição inválida." }, 400);
  const conversationId = typeof input.conversation_id === "string" && UUID_RE.test(input.conversation_id) ? input.conversation_id : null;
  const requestId = typeof input.client_request_id === "string" && UUID_RE.test(input.client_request_id) ? input.client_request_id : null;
  const body = typeof input.body === "string" ? input.body : null;
  if (!conversationId || !requestId || body === null) return json({ error: "Requisição inválida." }, 400);

  // 1) valida e grava 'queued' com o JWT do usuário
  const user = deps.createUserClient(authorization);
  const prep = await call(user, "whatsapp_prepare_outbound_message", {
    p_conversation_id: conversationId,
    p_client_request_id: requestId,
    p_body: body,
  });
  if (prep.error) return userRpcFailure(prep.error);
  const p = isObj(prep.data) ? prep.data : {};
  const messageId = typeof p.message_id === "string" ? p.message_id : null;
  const status = typeof p.status === "string" ? p.status : null;
  if (!messageId || !status) return json({ error: GENERIC_ERROR }, 500);

  // reenvio do mesmo pedido: nunca manda duas vezes
  if (p.idempotent === true) {
    if (status !== "queued") return json({ message_id: messageId, status, idempotent: true });
    const age = typeof p.queued_age_seconds === "number" ? p.queued_age_seconds : 0;
    if (age >= STALE_QUEUED_SECONDS) {
      await markFailed(deps.admin, messageId, "send_interrupted");
      return json({ message_id: messageId, status: "failed", idempotent: true });
    }
    return json({ message_id: messageId, status: "queued", idempotent: true });
  }

  // 2) contexto do envio (token só aqui)
  const ctxRes = await call(deps.admin, "whatsapp_get_send_context", { p_message_id: messageId });
  const ctx = isObj(ctxRes.data) ? ctxRes.data : null;
  if (ctxRes.error || !ctx) {
    console.error("whatsapp-send: contexto indisponível", { code: ctxRes.error?.code ?? null });
    await markFailed(deps.admin, messageId, "context_error");
    return json({ error: GENERIC_ERROR, message_id: messageId, status: "failed" }, 502);
  }
  if (ctx.ok !== true) {
    const reason = typeof ctx.error === "string" ? ctx.error : "context_error";
    await markFailed(deps.admin, messageId, reason);
    if (reason === "test_recipient_blocked") {
      return json({ error: "Destinatário não autorizado no modo de teste.", message_id: messageId, status: "failed" }, 403);
    }
    if (reason === "connection_inactive") {
      return json({ error: "O WhatsApp desta empresa não está conectado.", message_id: messageId, status: "failed" }, 409);
    }
    return json({ error: "A conexão do WhatsApp não está disponível. Procure o administrador.", message_id: messageId, status: "failed" }, 503);
  }
  const phoneNumberId = typeof ctx.phone_number_id === "string" ? ctx.phone_number_id : "";
  const recipient = typeof ctx.recipient_phone === "string" ? ctx.recipient_phone : "";
  const text = typeof ctx.body === "string" ? ctx.body : "";
  const token = typeof ctx.access_token === "string" ? ctx.access_token : "";
  if (!phoneNumberId || !recipient || !text || !token) {
    await markFailed(deps.admin, messageId, "context_error");
    return json({ error: GENERIC_ERROR, message_id: messageId, status: "failed" }, 502);
  }

  // 3) Graph API
  const result = await deps.graph.sendText({ version: deps.graphVersion, phoneNumberId, accessToken: token, to: recipient, body: text });

  if (result.ok) {
    let mark = await call(deps.admin, "whatsapp_mark_message_sent", { p_message_id: messageId, p_provider_message_id: result.messageId });
    if (mark.error) mark = await call(deps.admin, "whatsapp_mark_message_sent", { p_message_id: messageId, p_provider_message_id: result.messageId });
    if (mark.error) console.error("whatsapp-send: enviada, mas não registrou o id", { code: mark.error.code ?? null });
    return json({ message_id: messageId, status: "sent", idempotent: false });
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
  console.error("whatsapp-send: envio falhou", { kind: result.kind, status: result.status ?? null, code: errorCode });
  await markFailed(deps.admin, messageId, errorCode);
  return json({ error: friendly, message_id: messageId, status: "failed" }, http);
}
