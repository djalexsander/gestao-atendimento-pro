// Edge Function whatsapp-templates-sync (verify_jwt = true): atualiza o CACHE de templates da Meta de UMA empresa. SOMENTE leitura na Meta.
//
// Fluxo (cada passo é uma RPC; ver supabase/migrations/20261202010000_whatsapp_templates_sync.sql):
//   1. JWT do usuário -> whatsapp_templates_sync_request: papel (owner/admin ou administrador da plataforma), módulo, funcionalidade ativada, conexão ativa
//      com WABA, saúde do token, intervalo mínimo e LEASE (uma sincronização por conexão). Nada de conexão ou segredo volta ao usuário.
//   2. service_role -> whatsapp_templates_sync_context: ÚNICA leitura do token (Vault), só com o lease válido.
//   3. Graph API (somente GET message_templates, paginado por cursor) -> whatsapp_templates_sync_apply por página (upsert idempotente).
//   4. whatsapp_templates_sync_finish: só com sucesso E lista completa os templates que sumiram da Meta viram DELETED; falha/parcial não remove nada.
// Corpo recebido: { company_id }. O token NUNCA vem do cliente nem volta a ele; nada de token, Authorization, cursor, telefone ou template é logado.
import { classifyGraphAuthFailure } from "../_shared/whatsapp-dispatch.ts";
import { isValidGraphVersion } from "../_shared/whatsapp-graph.ts";
import { classifyTemplatesFailure, TEMPLATES_FRIENDLY, TEMPLATES_GENERIC_ERROR, TEMPLATES_MAX_PAGES, type TemplatesLister } from "../_shared/whatsapp-templates-graph.ts";

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

export interface TemplatesSyncDeps {
  /** Client do supabase-js escopado ao JWT de quem chamou (auth.uid() nas RPCs é o usuário). */
  createUserClient(authorization: string): RpcClient;
  /** Client com service_role: só as funções internas da sincronização. */
  admin: RpcClient;
  graph: TemplatesLister;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("whatsapp-templates-sync: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

function userRpcFailure(e: RpcError): Response {
  const map: Record<string, number> = { PT400: 400, PT401: 401, PT403: 403, PT404: 404, PT409: 409 };
  if (e.code && map[e.code]) return json({ error: e.message }, map[e.code]);
  if (e.status === 401 || e.code === "PGRST301") return json({ error: "Sessão inválida ou expirada." }, 401);
  console.error("whatsapp-templates-sync: erro inesperado no pedido", { code: e.code ?? null });
  return json({ error: TEMPLATES_GENERIC_ERROR }, 500);
}

export async function handleWhatsappTemplatesSync(req: Request, deps: TemplatesSyncDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json({ error: "Sessão inválida ou expirada." }, 401);
  if (!isValidGraphVersion(deps.graphVersion)) {
    console.error("whatsapp-templates-sync: WHATSAPP_GRAPH_API_VERSION ausente ou inválida");
    return json({ error: "Atualização de templates indisponível." }, 503);
  }
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  const companyId = isObj(input) && typeof input.company_id === "string" && UUID_RE.test(input.company_id) ? input.company_id : null;
  if (!companyId) return json({ error: "Requisição inválida." }, 400);

  // 1) pedido com o JWT do usuário (todas as travas são do banco)
  const reqRes = await call(deps.createUserClient(authorization), "whatsapp_templates_sync_request", { p_company_id: companyId });
  if (reqRes.error) return userRpcFailure(reqRes.error);
  const r = isObj(reqRes.data) ? reqRes.data : {};
  const connectionId = typeof r.connection_id === "string" ? r.connection_id : null;
  if (r.acquired === false) return json({ status: "running" }, 202);                 // outra sincronização já está em andamento: nada a fazer
  const runId = typeof r.run_id === "string" ? r.run_id : null;
  if (!connectionId || !runId) return json({ error: TEMPLATES_GENERIC_ERROR }, 500);

  const finish = async (ok: boolean, complete: boolean, code: string | null) => {
    const f = await call(deps.admin, "whatsapp_templates_sync_finish", { p_connection_id: connectionId, p_run_id: runId, p_ok: ok, p_complete: complete, p_error_code: code });
    if (f.error) console.error("whatsapp-templates-sync: não encerrou a sincronização", { code: f.error.code ?? null });
  };
  const fail = async (code: string, http: number): Promise<Response> => {
    await finish(false, false, code);
    return json({ error: TEMPLATES_FRIENDLY[code] ?? TEMPLATES_GENERIC_ERROR, code }, http);
  };

  // 2) contexto (token só aqui)
  const ctxRes = await call(deps.admin, "whatsapp_templates_sync_context", { p_connection_id: connectionId, p_run_id: runId });
  const ctx = isObj(ctxRes.data) ? ctxRes.data : null;
  if (ctxRes.error || !ctx || ctx.ok !== true) {
    console.error("whatsapp-templates-sync: contexto indisponível", { code: ctxRes.error?.code ?? null, reason: typeof ctx?.error === "string" ? ctx.error : null });
    return fail("context_error", 502);
  }
  const wabaId = typeof ctx.waba_id === "string" ? ctx.waba_id : "";
  const token = typeof ctx.access_token === "string" ? ctx.access_token : "";
  if (!wabaId || !token) return fail("context_error", 502);

  // 3) Graph: páginas por cursor, upsert por página
  let after: string | null = null;
  let pages = 0;
  let received = 0;
  let complete = false;
  for (;;) {
    const page = await deps.graph.listPage({ version: deps.graphVersion, wabaId, accessToken: token, after });
    if (!page.ok) {
      const code = classifyTemplatesFailure(page);
      console.error("whatsapp-templates-sync: Graph falhou", { kind: page.kind, status: page.status ?? null, code });
      if (code === "token_invalid") {
        const k = classifyGraphAuthFailure(page);
        if (k) {
          const rep = await call(deps.admin, "whatsapp_connection_report_token_failure", { p_connection_id: connectionId, p_kind: k, p_code: page.code ?? null, p_subcode: page.subcode ?? null });
          if (rep.error) console.error("whatsapp-templates-sync: não registrou a saúde do token", { code: rep.error.code ?? null });
        }
      }
      const http = code === "timeout" ? 504 : code === "token_invalid" ? 409 : code === "missing_permission" ? 403 : code === "rate_limited" ? 429 : 502;
      return fail(code, http);
    }
    pages++;
    received += page.templates.length;
    if (page.templates.length > 0) {
      const ap = await call(deps.admin, "whatsapp_templates_sync_apply", { p_connection_id: connectionId, p_run_id: runId, p_templates: page.templates });
      if (ap.error) {
        console.error("whatsapp-templates-sync: não gravou a página", { code: ap.error.code ?? null });
        return fail("apply_error", 502);
      }
    }
    if (!page.next) {
      complete = true;
      break;
    }
    if (pages >= TEMPLATES_MAX_PAGES) break;                                      // teto de páginas: lista INCOMPLETA (nada será marcado como removido)
    after = page.next;
  }

  // 4) encerra: só uma lista COMPLETA remove o que sumiu da Meta
  const fin = await call(deps.admin, "whatsapp_templates_sync_finish", { p_connection_id: connectionId, p_run_id: runId, p_ok: true, p_complete: complete, p_error_code: null });
  if (fin.error) {
    console.error("whatsapp-templates-sync: não encerrou a sincronização", { code: fin.error.code ?? null });
    return json({ error: TEMPLATES_GENERIC_ERROR }, 500);
  }
  const f = isObj(fin.data) ? fin.data : {};
  return json({ status: "ok", complete, pages, received, removed: typeof f.removed === "number" ? f.removed : 0, template_count: typeof f.template_count === "number" ? f.template_count : null });
}
