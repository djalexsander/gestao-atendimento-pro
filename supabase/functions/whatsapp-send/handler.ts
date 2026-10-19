// Edge Function whatsapp-send (verify_jwt = true): envio MANUAL de texto pelo WhatsApp (Cloud API oficial).
//
// Fluxo (a mensagem existe ANTES da chamada externa):
//   1. JWT do usuário -> RPC whatsapp_prepare_outbound_message: valida papel, módulo, conexão ativa, conversa aberta,
//      janela de 24 h e, no modo 'test', a lista de destinatários; grava a mensagem 'queued' (idempotente por
//      client_request_id). Nada de conexão ou segredo volta ao usuário.
//   2. e 3. (contexto do envio, Graph API e status final) vivem em _shared/whatsapp-dispatch.ts, compartilhado com
//      whatsapp-ai-auto: service_role -> whatsapp_get_send_context (ÚNICA leitura do token no Vault) -> Graph ->
//      whatsapp_mark_message_sent | whatsapp_mark_message_failed (código sanitizado).
//   O corpo recebido é só { conversation_id, client_request_id, body }: o token NUNCA vem do cliente nem volta a ele.
//   Nenhum token, Authorization, telefone ou texto é logado (só nome da etapa e códigos).
import { dispatchQueuedMessage, markMessageFailed, SEND_GENERIC_ERROR } from "../_shared/whatsapp-dispatch.ts";
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

const GENERIC_ERROR = SEND_GENERIC_ERROR;

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

const markFailed = (admin: RpcClient, messageId: string, code: string): Promise<void> => markMessageFailed(admin, messageId, code);

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

  // 2) e 3) contexto do envio (token só aqui) + Graph + status final: fluxo OFICIAL compartilhado (_shared/whatsapp-dispatch.ts)
  const sent = await dispatchQueuedMessage({ admin: deps.admin, graph: deps.graph, graphVersion: deps.graphVersion }, messageId);
  if (sent.ok) return json({ message_id: messageId, status: "sent", idempotent: false });
  return json({ error: sent.friendly, message_id: messageId, status: "failed" }, sent.http);
}
