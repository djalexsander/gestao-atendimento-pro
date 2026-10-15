// Edge Function whatsapp-ai-suggest (verify_jwt = true): SUGESTÃO de resposta por IA para o atendente (Fase 1).
//
// A IA só devolve TEXTO. Esta função NUNCA envia mensagem, NUNCA chama whatsapp-send, NÃO grava em whatsapp_messages,
// NÃO altera conversa/status/cliente e não executa ferramentas.
//
// Fluxo:
//   1. JWT do usuário -> RPC whatsapp_ai_prepare_suggestion: valida papel, módulo, empresa, modo (só 'suggest'; 'auto' =
//      bloqueado), janela, conversa aberta e COTA; devolve só o contexto mínimo (já redigido). company_id vem do banco.
//   2. AiSuggester (provedor injetado; chave só em Edge Secret). Timeout 12 s, sem retry.
//   3. service_role -> whatsapp_ai_record_usage: SÓ métricas (provider, model, status, tokens, latência).
//   4. Resposta: { suggestion }.
// Nada de mensagem, prompt, telefone ou sugestão é logado (só etapa e código).
import {
  AI_SUGGEST_MAX_CHARS,
  AI_SUGGEST_TIMEOUT_MS,
  buildConversationBlock,
  buildSystemPrompt,
  sanitizeSuggestion,
  type AiSuggester,
  type SuggestionContext,
} from "../_shared/ai-suggester.ts";

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

export interface SuggestDeps {
  /** Client do supabase-js escopado ao JWT de quem chamou (auth.uid() nas RPCs é o usuário). */
  createUserClient(authorization: string): RpcClient;
  /** Client com service_role: só o registro de uso. */
  admin: RpcClient;
  /** null = provedor não configurado (falha fechada). */
  suggester: AiSuggester | null;
  /** Relógio injetável (latência). */
  now?: () => number;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_ERROR = "Não foi possível gerar a sugestão agora. Você pode continuar respondendo manualmente.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("whatsapp-ai-suggest: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

// As RPCs do usuário levantam PT400/401/403/404/409/429 com mensagem amigável em português.
function userRpcFailure(e: RpcError): Response {
  const map: Record<string, number> = { PT400: 400, PT401: 401, PT403: 403, PT404: 404, PT409: 409, PT429: 429 };
  if (e.code && map[e.code]) return json({ error: e.message }, map[e.code]);
  if (e.status === 401 || e.code === "PGRST301") return json({ error: "Sessão inválida ou expirada." }, 401);
  console.error("whatsapp-ai-suggest: erro inesperado na preparação", { code: e.code ?? null });
  return json({ error: GENERIC_ERROR }, 500);
}

function isContext(v: unknown): v is SuggestionContext & { company_id: string; conversation_id: string; user_id: string | null; mode: string } {
  return (
    isObj(v) &&
    typeof v.company_id === "string" &&
    typeof v.conversation_id === "string" &&
    Array.isArray(v.messages) &&
    v.messages.every((m) => isObj(m) && typeof m.text === "string" && (m.direction === "inbound" || m.direction === "outbound"))
  );
}

async function recordUsage(
  deps: SuggestDeps,
  ctx: { company_id: string; conversation_id: string; user_id: string | null },
  s: AiSuggester,
  status: "ok" | "timeout" | "provider_error" | "rate_limited" | "invalid_output",
  inputTokens: number | null,
  outputTokens: number | null,
  latencyMs: number,
): Promise<void> {
  const r = await call(deps.admin, "whatsapp_ai_record_usage", {
    p_company_id: ctx.company_id,
    p_conversation_id: ctx.conversation_id,
    p_user_id: ctx.user_id,
    p_provider: s.provider,
    p_model: s.model,
    p_status: status,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_latency_ms: Math.max(0, Math.round(latencyMs)),
  });
  if (r.error) console.error("whatsapp-ai-suggest: não registrou o uso", { code: r.error.code ?? null });
}

export async function handleWhatsappAiSuggest(req: Request, deps: SuggestDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json({ error: "Sessão inválida ou expirada." }, 401);

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  if (!isObj(input)) return json({ error: "Requisição inválida." }, 400);
  const conversationId = typeof input.conversation_id === "string" && UUID_RE.test(input.conversation_id) ? input.conversation_id : null;
  if (!conversationId) return json({ error: "Requisição inválida." }, 400);

  // 1) valida e monta o contexto com o JWT do usuário (nenhum dado do corpo além do conversation_id é usado)
  const user = deps.createUserClient(authorization);
  const prep = await call(user, "whatsapp_ai_prepare_suggestion", { p_conversation_id: conversationId });
  if (prep.error) return userRpcFailure(prep.error);
  if (!isContext(prep.data)) {
    console.error("whatsapp-ai-suggest: contexto inesperado");
    return json({ error: GENERIC_ERROR }, 500);
  }
  const ctx = prep.data;
  // defesa em profundidade: só o modo 'suggest' passa ('off' e 'auto' falham fechados)
  if (ctx.mode !== "suggest") return json({ error: "A sugestão por IA não está ativada para esta empresa." }, 409);

  const suggester = deps.suggester;
  if (!suggester) {
    console.error("whatsapp-ai-suggest: provedor de IA não configurado");
    return json({ error: "A sugestão por IA está indisponível no momento." }, 503);
  }

  // 2) provedor (timeout, sem retry)
  const now = deps.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, kind: "timeout" });
    }, AI_SUGGEST_TIMEOUT_MS);
  });
  let result;
  try {
    result = await Promise.race([
      suggester.suggest({
        system: buildSystemPrompt(ctx),
        user: buildConversationBlock(ctx),
        maxOutputChars: AI_SUGGEST_MAX_CHARS,
        timeoutMs: AI_SUGGEST_TIMEOUT_MS,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } catch (e) {
    console.error("whatsapp-ai-suggest: provedor lançou exceção", { name: e instanceof Error ? e.name : null });
    result = { ok: false as const, kind: "provider_error" as const };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const latency = now() - started;

  if (!result.ok) {
    await recordUsage(deps, ctx, suggester, result.kind, null, null, latency);
    console.error("whatsapp-ai-suggest: geração falhou", { kind: result.kind });
    if (result.kind === "rate_limited") {
      return json({ error: "O serviço de sugestões está ocupado. Tente novamente em instantes." }, 429);
    }
    if (result.kind === "timeout") return json({ error: GENERIC_ERROR }, 504);
    return json({ error: GENERIC_ERROR }, 502);
  }

  const suggestion = sanitizeSuggestion(result.text, AI_SUGGEST_MAX_CHARS);
  if (!suggestion) {
    await recordUsage(deps, ctx, suggester, "invalid_output", result.inputTokens, result.outputTokens, latency);
    return json({ error: GENERIC_ERROR }, 502);
  }

  // 3) uso (só métricas) e 4) resposta
  await recordUsage(deps, ctx, suggester, "ok", result.inputTokens, result.outputTokens, latency);
  return json({ suggestion });
}
