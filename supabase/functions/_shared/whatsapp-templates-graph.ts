// Adapter de LEITURA dos templates da Meta (WhatsApp Business Management API): GET /{version}/{waba_id}/message_templates.
// SOMENTE leitura: nenhuma criação, edição ou exclusão de template. O token vai só no header Authorization (nunca na URL) e a paginação usa o cursor
// `after` reconstruído por nós: a URL `paging.next` que a Meta devolve CARREGA o access_token na query string e por isso nunca é seguida nem registrada.
// Nada deste módulo registra token, corpo ou resposta bruta.
import { GRAPH_BASE_URL, type GraphFailure } from "./whatsapp-graph.ts";

export const TEMPLATES_PAGE_LIMIT = 100;
export const TEMPLATES_TIMEOUT_MS = 15_000;
export const TEMPLATES_MAX_PAGES = 50;
const CURSOR_RE = /^[A-Za-z0-9+/=_-]{1,512}$/;

export interface ListTemplatesArgs {
  version: string;
  wabaId: string;
  accessToken: string;
  /** cursor `after` da página anterior (omitido na primeira) */
  after?: string | null;
  limit?: number;
}

export type TemplatesPage = { ok: true; templates: unknown[]; next: string | null } | GraphFailure;

export interface TemplatesLister {
  listPage(args: ListTemplatesArgs): Promise<TemplatesPage>;
}

type FetchImpl = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Requisição oficial de leitura (campos mínimos necessários; sem token na URL). */
export function buildListTemplatesRequest(a: ListTemplatesArgs): { url: string; init: { method: string; headers: Record<string, string> } } {
  const params = new URLSearchParams({ fields: "id,name,language,category,status,components", limit: String(a.limit ?? TEMPLATES_PAGE_LIMIT) });
  if (a.after) params.set("after", a.after);
  return {
    url: `${GRAPH_BASE_URL}/${a.version}/${encodeURIComponent(a.wabaId)}/message_templates?${params.toString()}`,
    init: { method: "GET", headers: { Authorization: `Bearer ${a.accessToken}` } },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createTemplatesLister(fetchImpl: FetchImpl, timeoutMs = TEMPLATES_TIMEOUT_MS): TemplatesLister {
  return {
    async listPage(a) {
      const req = buildListTemplatesRequest(a);
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
        const obj = isObj(payload) ? payload : {};
        if (!res.ok) {
          const err = isObj(obj.error) ? obj.error : {};
          const code = typeof err.code === "number" || typeof err.code === "string" ? String(err.code) : undefined;
          const sub = typeof err.error_subcode === "number" || typeof err.error_subcode === "string" ? String(err.error_subcode) : undefined;
          return { ok: false, kind: "http", status: res.status, code, ...(sub && /^[0-9]{1,6}$/.test(sub) ? { subcode: sub } : {}) };
        }
        // resposta incompleta: sem lista `data` NÃO é "zero templates" (isso apagaria o cache); é falha
        if (!Array.isArray(obj.data)) return { ok: false, kind: "invalid_response", status: res.status };
        const paging = isObj(obj.paging) ? obj.paging : {};
        const cursors = isObj(paging.cursors) ? paging.cursors : {};
        const after = typeof cursors.after === "string" && CURSOR_RE.test(cursors.after) ? cursors.after : null;
        // há próxima página só se a Meta disse (paging.next) E deu um cursor utilizável; `next` sem cursor válido = resposta incompleta
        const hasNext = typeof paging.next === "string" && paging.next.length > 0;
        if (hasNext && !after) return { ok: false, kind: "invalid_response", status: res.status };
        return { ok: true, templates: obj.data, next: hasNext ? after : null };
      } catch (e) {
        return { ok: false, kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Classifica a falha da Graph em um código curto, sem dado sensível (vai para o estado da sincronização e para a mensagem ao usuário).
 *  190 -> token_invalid (ver classifyGraphAuthFailure para o subcódigo de checkpoint) · 10 e 200..299 -> missing_permission ·
 *  4, 17, 32, 613, 80004 (e HTTP 429) -> rate_limited · timeout/network -> timeout/network · HTTP 5xx -> meta_unavailable ·
 *  100 (parâmetro/ID inválido) e HTTP 404 -> waba_not_found · resposta sem `data` -> invalid_response · demais -> meta_http_<status>.
 */
export function classifyTemplatesFailure(f: GraphFailure): string {
  if (f.kind === "timeout") return "timeout";
  if (f.kind === "network") return "network";
  if (f.kind === "invalid_response") return "invalid_response";
  const code = f.code ?? "";
  if (code === "190") return "token_invalid";
  const n = Number(code);
  if (code === "10" || (Number.isInteger(n) && n >= 200 && n <= 299)) return "missing_permission";
  if (["4", "17", "32", "613", "80004"].includes(code) || f.status === 429) return "rate_limited";
  if (code === "100" || f.status === 404) return "waba_not_found";
  if (typeof f.status === "number" && f.status >= 500) return "meta_unavailable";
  return `meta_http_${f.status ?? "error"}`.slice(0, 64);
}

export const TEMPLATES_FRIENDLY: Record<string, string> = {
  token_invalid: "A conexão do WhatsApp expirou ou foi revogada e precisa ser refeita. Procure o administrador da empresa.",
  missing_permission: "A conexão do WhatsApp não tem permissão para consultar templates. Reconecte o WhatsApp concedendo o acesso ao gerenciamento da conta.",
  rate_limited: "A Meta limitou as consultas por agora. Tente novamente em alguns minutos.",
  timeout: "A Meta demorou para responder. Tente novamente em instantes.",
  network: "Não foi possível falar com a Meta agora. Tente novamente em instantes.",
  meta_unavailable: "A Meta está indisponível no momento. Tente novamente mais tarde.",
  waba_not_found: "A conta do WhatsApp Business desta conexão não foi encontrada na Meta. Procure o administrador.",
  invalid_response: "A Meta devolveu uma resposta incompleta. Nenhum template foi alterado. Tente novamente.",
};
export const TEMPLATES_GENERIC_ERROR = "Não foi possível atualizar os templates agora. Tente novamente em instantes.";
