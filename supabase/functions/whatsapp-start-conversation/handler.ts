// Edge Function whatsapp-start-conversation (verify_jwt = true): inicia uma conversa pelo WhatsApp com um TEMPLATE aprovado da Meta (Etapa 7.11F).
//
// Fluxo:
//   1. JWT do usuário -> RPC whatsapp_start_conversation: papel, módulo, PT402, consentimento (origem + referência), opt-out, limite diário, intervalo por
//      contato, telefone resolvido SÓ no servidor, conversa única (nono dígito), ai_control='human', mensagem 'queued'. UMA transação: falhou = nada fica.
//   2. Só se a RPC disser dispatch_required: service_role -> dispatchQueuedTemplate (7.11E: contexto revalidado + claim atômico, UMA tentativa à Meta, sem retry).
//   3. Resposta com o id da conversa (a tela abre ?conversation=<id>). "accepted" = a Meta ACEITOU o envio; NÃO é "entregue" (isso vem do webhook de status).
// Repetir a MESMA chamada (mesmo client_request_id) é seguro: a RPC devolve o mesmo pedido e o despacho não reenvia o que já foi reivindicado.
// Corpo: { company_id, client_request_id, contact_kind, contact_ref, template_id, params, consent_confirmed, consent_origin, consent_ref }.
// Nada de telefone, token, variáveis ou texto bruto da Meta é logado ou devolvido.
import { dispatchQueuedTemplate } from "../_shared/whatsapp-template-dispatch.ts";
import type { DispatchRpcClient } from "../_shared/whatsapp-dispatch.ts";
import { isValidGraphVersion } from "../_shared/whatsapp-graph.ts";
import type { TemplateSender } from "../_shared/whatsapp-template-send.ts";

export interface StartConversationDeps {
  /** Client do supabase-js escopado ao JWT de quem chamou (auth.uid() nas RPCs é o usuário). */
  createUserClient(authorization: string): DispatchRpcClient;
  /** Client com service_role: só as funções internas do despacho. */
  admin: DispatchRpcClient;
  sender: TemplateSender;
  /** WHATSAPP_GRAPH_API_VERSION (obrigatório; sem default). */
  graphVersion: string | undefined;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const GENERIC = "Não foi possível iniciar a conversa agora. Tente novamente em instantes.";
const UNCONFIRMED = "A Meta demorou ou deu uma resposta incerta. O envio pode ter sido aceito: confira a conversa e use a tela de pedidos antes de tentar de novo.";
const IN_PROGRESS = "Este envio já está em andamento.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

export async function handleWhatsappStartConversation(req: Request, deps: StartConversationDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json({ error: "Sessão inválida ou expirada." }, 401);
  if (!isValidGraphVersion(deps.graphVersion)) {
    console.error("whatsapp-start-conversation: WHATSAPP_GRAPH_API_VERSION ausente ou inválida");
    return json({ error: "Iniciar conversas está indisponível." }, 503);                // falha fechada ANTES de criar qualquer coisa
  }
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  if (!isObj(input)) return json({ error: "Requisição inválida." }, 400);
  const uuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);
  const companyId = uuid(input.company_id), clientRequestId = uuid(input.client_request_id), contactRef = uuid(input.contact_ref), templateId = uuid(input.template_id);
  const kind = input.contact_kind === "manual" || input.contact_kind === "customer" ? input.contact_kind : null;
  if (!companyId || !clientRequestId || !contactRef || !templateId || !kind || !Array.isArray(input.params)) return json({ error: "Requisição inválida." }, 400);
  if (input.consent_confirmed !== true) return json({ error: "Confirme que o contato autorizou receber mensagens da empresa." }, 400);
  const origin = typeof input.consent_origin === "string" ? input.consent_origin : "";
  const ref = typeof input.consent_ref === "string" ? input.consent_ref : "";

  // 1) RPC com o JWT do usuário: todas as travas são do banco
  let rpc;
  try {
    rpc = await deps.createUserClient(authorization).rpc("whatsapp_start_conversation", {
      p_company_id: companyId, p_client_request_id: clientRequestId, p_contact_kind: kind, p_contact_ref: contactRef, p_template_id: templateId,
      p_params: input.params, p_consent_confirmed: true, p_consent_origin: origin, p_consent_ref: ref,
    });
  } catch (e) {
    console.error("whatsapp-start-conversation: rpc lançou exceção", { name: e instanceof Error ? e.name : null });
    return json({ error: GENERIC }, 502);
  }
  if (rpc.error) {
    const map: Record<string, number> = { PT400: 400, PT401: 401, PT402: 402, PT403: 403, PT404: 404, PT409: 409 };
    const e = rpc.error;
    if (e.code && map[e.code]) return json({ error: e.message, code: e.code }, map[e.code]);
    console.error("whatsapp-start-conversation: erro inesperado na RPC", { code: e.code ?? null });
    return json({ error: GENERIC }, 500);
  }
  const r = isObj(rpc.data) ? rpc.data : null;
  const requestId = r && typeof r.request_id === "string" ? r.request_id : null;
  const conversationId = r && typeof r.conversation_id === "string" ? r.conversation_id : null;
  const messageId = r && typeof r.message_id === "string" ? r.message_id : null;
  if (!r || !requestId || !conversationId || !messageId) return json({ error: GENERIC }, 500);
  const base = { request_id: requestId, conversation_id: conversationId, idempotent: r.idempotent === true };
  const state = typeof r.state === "string" ? r.state : "";

  // 2) despacho: só quando a mensagem ainda não foi reivindicada
  if (r.dispatch_required === true) {
    const d = await dispatchQueuedTemplate({ admin: deps.admin, sender: deps.sender, graphVersion: deps.graphVersion }, messageId);
    if (d.ok) return json({ ...base, status: "accepted" });
    if (d.outcome === "uncertain") return json({ ...base, status: "unconfirmed", error: d.friendly, code: d.errorCode }, 202);
    if (d.outcome === "skipped") return json({ ...base, status: d.errorCode === "send_unconfirmed" ? "unconfirmed" : "in_progress", error: d.friendly, code: d.errorCode }, 202);
    return json({ ...base, status: "failed", error: d.friendly, code: d.errorCode }, d.http);
  }

  // repetição de um pedido que já passou do despacho: devolve o estado, sem chamar a Meta
  if (state === "accepted") return json({ ...base, status: "accepted" });
  if (state === "unconfirmed") return json({ ...base, status: "unconfirmed", error: UNCONFIRMED }, 202);
  if (state === "in_progress") return json({ ...base, status: "in_progress", error: IN_PROGRESS }, 202);
  if (state === "failed") return json({ ...base, status: "failed", error: "Este pedido já falhou. Faça um novo pedido.", code: typeof r.error_code === "string" ? r.error_code : null }, 409);
  return json({ ...base, status: "in_progress", error: IN_PROGRESS }, 202);
}
