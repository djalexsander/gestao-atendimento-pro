// Adapter OpenAI (Responses API) para o contrato AiSuggester. SÓ texto: sem tools, sem web/file search, sem function calling.
//
// Config por Edge Secrets (nunca no frontend/banco de tenant): WHATSAPP_AI_PROVIDER=openai, WHATSAPP_AI_MODEL (modelo técnico
// recomendado: gpt-5.4-mini; não há default no código nem fallback para outro modelo) e WHATSAPP_AI_API_KEY.
// fetch nativo, Authorization Bearer, timeout pelo AbortSignal do handler (12 s), sem retry. Nada aqui registra chave,
// prompt, mensagens, resposta ou telefone: erros viram só um "kind".
import { DECISION_JSON_SCHEMA, type AiDecider, type DecideRequest, type DecideResult } from "./ai-auto.ts";
import type { AiSuggester, SuggestRequest, SuggestResult } from "./ai-suggester.ts";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
// ~1000 caracteres cabem em ~300 tokens; folga para modelos com raciocínio interno.
export const OPENAI_MAX_OUTPUT_TOKENS = 800;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const tok = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** Corpo mínimo e previsível da Responses API (sem tools, sem armazenar a resposta na OpenAI). */
export function buildOpenAiRequestBody(model: string, req: Pick<SuggestRequest, "system" | "user">): Record<string, unknown> {
  return {
    model,
    instructions: req.system,
    input: req.user,
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    store: false,
  };
}

/** Extrai SÓ texto: junta os blocos output_text das mensagens do assistente. */
export function extractOutputText(body: unknown): string | null {
  if (!isObj(body) || !Array.isArray(body.output)) return null;
  const parts: string[] = [];
  for (const item of body.output) {
    if (!isObj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (isObj(c) && c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  const text = parts.join("").trim();
  return text.length > 0 ? text : null;
}

export function createOpenAiSuggester(cfg: { model: string; apiKey: string; fetch: FetchLike }): AiSuggester {
  return {
    provider: "openai",
    model: cfg.model,
    async suggest(req: SuggestRequest): Promise<SuggestResult> {
      let res;
      try {
        res = await cfg.fetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(buildOpenAiRequestBody(cfg.model, req)),
          signal: req.signal,
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        return { ok: false, kind: name === "AbortError" || name === "TimeoutError" || req.signal.aborted ? "timeout" : "provider_error" };
      }
      if (res.status === 429) return { ok: false, kind: "rate_limited" };
      if (!res.ok) return { ok: false, kind: "provider_error" }; // 401/403 (chave), 4xx, 5xx: nada do corpo é propagado
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { ok: false, kind: "provider_error" };
      }
      const text = extractOutputText(body);
      // vazio / incompleto sem texto: o handler registra como invalid_output
      const usage = isObj(body) && isObj(body.usage) ? body.usage : {};
      return { ok: true, text: text ?? "", inputTokens: tok(usage.input_tokens), outputTokens: tok(usage.output_tokens) };
    },
  };
}

/** Provedor a partir dos secrets. Qualquer item ausente/desconhecido = null (a Edge responde 503, fechada). */
export function resolveSuggester(
  env: { provider?: string | null; model?: string | null; apiKey?: string | null },
  fetchImpl: FetchLike,
): AiSuggester | null {
  const provider = (env.provider ?? "").trim();
  const model = (env.model ?? "").trim();
  const apiKey = (env.apiKey ?? "").trim();
  if (!provider || !model || !apiKey) return null;
  if (provider === "openai") return createOpenAiSuggester({ model, apiKey, fetch: fetchImpl });
  return null;
}

// ---------------------------------------------------------------------------
// Modo AUTOMÁTICO (Fase 2): decisão estruturada. Mesmo provedor/modelo/chave/Secrets da sugestão; SEM tools. A saída é JSON
// (json_schema strict) e é validada pelo servidor; o adapter só devolve o TEXTO bruto (quem valida é ai-auto.ts).
// ---------------------------------------------------------------------------
export const OPENAI_DECISION_MAX_OUTPUT_TOKENS = 1000;

export function buildOpenAiDecisionBody(model: string, req: Pick<DecideRequest, "system" | "user">): Record<string, unknown> {
  return {
    model,
    instructions: req.system,
    input: req.user,
    max_output_tokens: OPENAI_DECISION_MAX_OUTPUT_TOKENS,
    store: false,
    text: { format: { type: "json_schema", name: "whatsapp_auto_decision", strict: true, schema: DECISION_JSON_SCHEMA } },
  };
}

export function createOpenAiDecider(cfg: { model: string; apiKey: string; fetch: FetchLike }): AiDecider {
  return {
    provider: "openai",
    model: cfg.model,
    async decide(req: DecideRequest): Promise<DecideResult> {
      let res;
      try {
        res = await cfg.fetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(buildOpenAiDecisionBody(cfg.model, req)),
          signal: req.signal,
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        return { ok: false, kind: name === "AbortError" || name === "TimeoutError" || req.signal.aborted ? "timeout" : "provider_error" };
      }
      if (res.status === 429) return { ok: false, kind: "rate_limited" };
      if (!res.ok) return { ok: false, kind: "provider_error" };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { ok: false, kind: "provider_error" };
      }
      const text = extractOutputText(body);
      const usage = isObj(body) && isObj(body.usage) ? body.usage : {};
      return { ok: true, text: text ?? "", inputTokens: tok(usage.input_tokens), outputTokens: tok(usage.output_tokens) };
    },
  };
}

/** Mesma configuração (Secrets) da sugestão: WHATSAPP_AI_PROVIDER / WHATSAPP_AI_MODEL / WHATSAPP_AI_API_KEY. */
export function resolveDecider(
  env: { provider?: string | null; model?: string | null; apiKey?: string | null },
  fetchImpl: FetchLike,
): AiDecider | null {
  const provider = (env.provider ?? "").trim();
  const model = (env.model ?? "").trim();
  const apiKey = (env.apiKey ?? "").trim();
  if (!provider || !model || !apiKey) return null;
  if (provider === "openai") return createOpenAiDecider({ model, apiKey, fetch: fetchImpl });
  return null;
}
