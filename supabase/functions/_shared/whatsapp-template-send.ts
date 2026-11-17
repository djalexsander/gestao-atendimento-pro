// Adapter de ENVIO de template da Meta (WhatsApp Cloud API): POST /{version}/{phone_number_id}/messages com type "template".
// ISOLADO do envio de texto/documento (whatsapp-graph.ts não foi alterado). Só texto: o corpo recebe as variáveis numeradas ({{1}}, {{2}}…) como parâmetros
// de texto; sem variáveis, nenhum componente é enviado. Idioma e nome vêm do cadastro validado no banco. Nada deste módulo registra token, telefone,
// parâmetros nem resposta bruta. Reutiliza a versão e a classificação de falha do adapter existente (somente leitura desses exports).
import { GRAPH_BASE_URL, GRAPH_SEND_TIMEOUT_MS, type GraphFailure } from "./whatsapp-graph.ts";

export interface SendTemplateArgs {
  version: string;
  phoneNumberId: string;
  accessToken: string;
  to: string;
  name: string;
  language: string;
  /** valores de {{1}}, {{2}}… (já normalizados pelo banco) */
  parameters: string[];
}

export type SendTemplateResult = { ok: true; messageId: string } | GraphFailure;

export interface TemplateSender {
  sendTemplate(args: SendTemplateArgs): Promise<SendTemplateResult>;
}

type FetchImpl = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Requisição oficial de template. `language.code` é o idioma do cadastro (ex.: pt_BR). */
export function buildSendTemplateRequest(a: SendTemplateArgs): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  const template: Record<string, unknown> = { name: a.name, language: { code: a.language } };
  if (a.parameters.length > 0) {
    template.components = [{ type: "body", parameters: a.parameters.map((text) => ({ type: "text", text })) }];
  }
  return {
    url: `${GRAPH_BASE_URL}/${a.version}/${encodeURIComponent(a.phoneNumberId)}/messages`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${a.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: a.to, type: "template", template }),
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createTemplateSender(fetchImpl: FetchImpl, timeoutMs = GRAPH_SEND_TIMEOUT_MS): TemplateSender {
  return {
    async sendTemplate(a) {
      const req = buildSendTemplateRequest(a);
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
        // HTTP 200 sem id da mensagem = resposta ambígua (a Meta pode ter aceitado)
        const first = Array.isArray(obj.messages) ? (obj.messages[0] as unknown) : undefined;
        const id = isObj(first) && typeof first.id === "string" && first.id ? first.id : null;
        return id ? { ok: true, messageId: id } : { ok: false, kind: "invalid_response", status: res.status };
      } catch (e) {
        return { ok: false, kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
