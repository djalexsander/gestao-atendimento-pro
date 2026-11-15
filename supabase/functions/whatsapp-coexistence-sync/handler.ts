// Edge Function whatsapp-coexistence-sync (verify_jwt = true): pede à Meta a sincronização INICIAL de contatos e histórico de um número em
// Coexistence (POST /{phone_number_id}/smb_app_data), conforme o contrato oficial (docs/whatsapp-coexistence-contrato-meta.md).
//
// Entrada: { company_id, type: "contacts" | "history" }. Quem pede é owner/admin ativo da empresa (confirmado no banco).
// TODAS as travas ficam no banco (RPC whatsapp_coexistence_sync_prepare): trava mestra do operador (default DESLIGADA), empresa no piloto,
// conexão em Coexistence ativa, token utilizável, janela de 24 h desde o onboarding, ORDEM (contatos antes do histórico) e UM pedido por
// tipo e ciclo (índice único parcial). Esta função só faz a chamada externa e grava o resultado:
//   accepted  -> pedido aceito (request_id guardado só para suporte)
//   rejected  -> a Meta recusou (4xx): pode haver nova tentativa (máx. 3 por tipo)
//   uncertain -> timeout/rede/5xx/corpo estranho: NUNCA é repetido sozinho (a Meta pode ter aceito; o pedido só vale uma vez)
// NÃO importa conversas/contatos: o histórico que chegar pelos webhooks continua sendo só CONTADO (Etapa 3).
// Nada de token, request_id, corpo da Meta ou telefone é logado ou devolvido ao navegador.
import { classifySyncResult, type SmbSyncMeta, type SmbSyncType } from "../_shared/whatsapp-signup-graph.ts";
import { isValidGraphVersion } from "../_shared/whatsapp-graph.ts";

export interface RpcError {
  code?: string;
  message: string;
}
export interface RpcResult {
  data: unknown;
  error: RpcError | null;
}
export interface SyncDeps {
  authenticate(authorization: string): Promise<{ userId: string } | null>;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  meta: SmbSyncMeta;
  graphVersion: string | undefined;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC = "Não foi possível solicitar a sincronização agora.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const PREPARE_ERRORS: Record<string, [number, string]> = {
  invalid: [400, "Requisição inválida."],
  sync_disabled: [503, "A sincronização inicial ainda não está disponível."],
  unauthorized: [403, "Você não tem permissão para solicitar a sincronização desta empresa."],
  company_not_authorized: [403, "Sua empresa ainda não foi liberada para esta função."],
  connection_not_eligible: [409, "Não há uma conexão do WhatsApp Business (Coexistence) ativa nesta empresa."],
  token_unavailable: [409, "A conexão do WhatsApp precisa ser refeita antes de sincronizar."],
  window_expired: [410, "O prazo de 24 horas para a sincronização inicial terminou. Será necessário reconectar o WhatsApp."],
  contacts_first: [409, "Solicite primeiro a sincronização dos contatos."],
  already_requested: [409, "Esta sincronização já foi solicitada e só pode ser pedida uma vez."],
  in_progress: [409, "Já existe um pedido de sincronização em andamento."],
  uncertain_manual: [409, "O resultado do pedido anterior não foi confirmado. Não repita; aguarde ou contate o suporte."],
  attempts_exhausted: [429, "Limite de tentativas atingido para esta sincronização."],
};

export async function handleWhatsappCoexistenceSync(req: Request, deps: SyncDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json({ error: "Sessão inválida ou expirada." }, 401);
  if (!isValidGraphVersion(deps.graphVersion)) {
    console.error("whatsapp-coexistence-sync: configuração incompleta");
    return json({ error: "Sincronização indisponível no momento." }, 503);
  }
  const version = deps.graphVersion;

  const raw = await req.text();
  if (raw.length > 2048) return json({ error: "Requisição inválida." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  if (!isObj(body) || typeof body.company_id !== "string" || !UUID_RE.test(body.company_id) || (body.type !== "contacts" && body.type !== "history")) {
    return json({ error: "Requisição inválida." }, 400);
  }
  const companyId = body.company_id;
  const type: SmbSyncType = body.type;

  let auth: { userId: string } | null = null;
  try {
    auth = await deps.authenticate(authorization);
  } catch {
    auth = null;
  }
  if (!auth || !auth.userId) return json({ error: "Sessão inválida ou expirada." }, 401);

  // todas as travas + reserva atômica do pedido (e o token do cliente, lido do Vault só pelo service_role)
  let prep: RpcResult;
  try {
    prep = await deps.rpc("whatsapp_coexistence_sync_prepare", { p_user_id: auth.userId, p_company_id: companyId, p_type: type });
  } catch {
    prep = { data: null, error: { message: "falha de comunicação" } };
  }
  if (prep.error || !isObj(prep.data)) {
    console.error("whatsapp-coexistence-sync: falha ao preparar", { code: prep.error?.code ?? null });
    return json({ error: GENERIC }, 500);
  }
  if (prep.data.ok !== true) {
    const [status, message] = PREPARE_ERRORS[String(prep.data.error)] ?? [400, GENERIC];
    return json({ error: message, code: String(prep.data.error) }, status);
  }
  const attemptId = String(prep.data.attempt_id);
  const phoneNumberId = String(prep.data.phone_number_id);
  const token = String(prep.data.access_token);

  // chamada externa (fora de qualquer transação). Nunca é repetida aqui.
  const res = await deps.meta.requestSync({ version, phoneNumberId, token, type });
  const outcome = classifySyncResult(res);
  const requestId = res.ok ? res.requestId : null;
  const metaCode = !res.ok && res.kind === "http" ? (res.code ?? null) : null;
  if (!res.ok) console.error("whatsapp-coexistence-sync: Meta não aceitou", { type, kind: res.kind, status: res.status ?? null, meta_code: res.code ?? null, outcome });

  const args = { p_attempt_id: attemptId, p_outcome: outcome, p_request_id: requestId, p_meta_code: metaCode };
  let fin: RpcResult = await deps.rpc("whatsapp_coexistence_sync_finish", args);
  if (fin.error) fin = await deps.rpc("whatsapp_coexistence_sync_finish", args);
  if (fin.error) {
    // resultado da Meta conhecido mas não gravado: o pedido fica 'em andamento' e vira 'incerto' sozinho (nunca é repetido)
    console.error("whatsapp-coexistence-sync: resultado não gravado", { outcome });
    return json({ error: "Não foi possível confirmar o pedido. Não tente novamente agora; aguarde ou contate o suporte.", code: "uncertain" }, 503);
  }

  if (outcome === "accepted") return json({ ok: true, type, status: "requested" });
  if (outcome === "rejected") return json({ error: "A Meta não aceitou o pedido. Você pode tentar novamente.", code: "rejected" }, 502);
  return json({ error: "Não foi possível confirmar o pedido na Meta. Não tente novamente agora; aguarde ou contate o suporte.", code: "uncertain" }, 504);
}
