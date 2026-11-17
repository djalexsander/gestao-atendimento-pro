import { supabase } from "../../lib/supabaseClient";
import {
  isConsentOrigin,
  isUuid,
  mapStartRpcError,
  roleCanStart,
  toContactOptout,
  toStartOutcome,
  toStartRequests,
  toStartSettings,
  toStartTemplates,
  validateConsentRef,
  validateParams,
  NETWORK_OUTCOME,
  type ConsentOrigin,
  type ContactOptout,
  type Resolution,
  type StartOutcome,
  type StartRequest,
  type StartRpcError,
  type StartSettings,
  type StartTemplates,
} from "./whatsappStartLogic";

// Iniciar conversa (Etapa 7.11G): chamadas às RPCs de leitura da 7.11 e à Edge whatsapp-start-conversation, mais um controlador que impede envio
// duplicado e confere o formulário. O navegador NUNCA envia telefone nem token: só o id do contato/cliente; o servidor resolve o telefone, confere
// papel, módulo, PT402, conexão, opt-out, limite e consentimento. Nada aqui é reenviado sozinho.

export type StartResult<T> = { ok: true; data: T } | { ok: false; message: string };

export interface StartInput {
  companyId: string;
  /** Idempotência: o MESMO id repete o MESMO pedido (seguro); outro id é um novo pedido (novo envio, nova cobrança). */
  clientRequestId: string;
  contactKind: "manual" | "customer";
  contactRef: string;
  templateId: string;
  params: string[];
  consentOrigin: ConsentOrigin;
  consentRef: string;
}

export interface StartSource {
  settings(companyId: string): Promise<StartResult<StartSettings>>;
  templates(companyId: string): Promise<StartResult<StartTemplates>>;
  optout(companyId: string, kind: "manual" | "customer", ref: string): Promise<StartResult<ContactOptout>>;
  start(input: StartInput): Promise<StartOutcome>;
  requests(companyId: string, onlyAttention: boolean): Promise<StartResult<StartRequest[]>>;
  resolve(requestId: string, resolution: Resolution, attested: boolean): Promise<StartResult<true>>;
}

const UNEXPECTED = "Resposta inesperada do servidor. Tente novamente.";

function fail(error: StartRpcError): { ok: false; message: string } {
  // nunca registra nome, telefone nem o conteúdo da mensagem
  console.error("Falha ao iniciar conversa no WhatsApp:", error.code ?? "sem código");
  return { ok: false, message: mapStartRpcError(error) };
}

async function rpc<T>(call: PromiseLike<{ data: unknown; error: StartRpcError | null }>, map: (raw: unknown) => T | null): Promise<StartResult<T>> {
  try {
    const { data, error } = await call;
    if (error) return fail(error);
    const mapped = map(data);
    return mapped === null ? { ok: false, message: UNEXPECTED } : { ok: true, data: mapped };
  } catch {
    return { ok: false, message: mapStartRpcError({}) };
  }
}

/** Erro HTTP da Edge: FunctionsHttpError.context é a Response (status e corpo). Sem Response = a conexão falhou. */
async function edgeFailure(error: unknown): Promise<StartOutcome> {
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown> } } | null)?.context;
  if (!ctx || typeof ctx.status !== "number") return NETWORK_OUTCOME;
  let body: unknown = null;
  try {
    body = ctx.json ? await ctx.json() : null;
  } catch {
    body = null;
  }
  return toStartOutcome(ctx.status, body);
}

export const supabaseStartSource: StartSource = {
  settings: (companyId) => rpc(supabase.rpc("whatsapp_get_start_settings", { p_company_id: companyId }), toStartSettings),
  templates: (companyId) => rpc(supabase.rpc("whatsapp_list_start_templates", { p_company_id: companyId }), toStartTemplates),
  optout: (companyId, kind, ref) => rpc(supabase.rpc("whatsapp_get_contact_optout", { p_company_id: companyId, p_contact_kind: kind, p_contact_ref: ref }), toContactOptout),
  requests: (companyId, onlyAttention) => rpc(supabase.rpc("whatsapp_list_start_requests", { p_company_id: companyId, p_only_attention: onlyAttention, p_limit: 50 }), toStartRequests),
  resolve: (requestId, resolution, attested) => rpc(supabase.rpc("whatsapp_start_request_resolve", { p_request_id: requestId, p_resolution: resolution, p_attested: attested }), (raw) => (raw ? true : null)),
  async start(input) {
    try {
      // corpo SEM telefone/token: só ids, variáveis e a prova de consentimento
      const { data, error } = await supabase.functions.invoke("whatsapp-start-conversation", {
        body: {
          company_id: input.companyId,
          client_request_id: input.clientRequestId,
          contact_kind: input.contactKind,
          contact_ref: input.contactRef,
          template_id: input.templateId,
          params: input.params,
          consent_confirmed: true,
          consent_origin: input.consentOrigin,
          consent_ref: input.consentRef,
        },
      });
      if (error) {
        console.error("Falha ao iniciar conversa no WhatsApp");
        return edgeFailure(error);
      }
      // 200 e 202 chegam aqui; o status vem no corpo
      return toStartOutcome(200, data);
    } catch {
      return NETWORK_OUTCOME;
    }
  },
};

// ---------------------------------------------------------------------------
// Controlador: um envio por vez, formulário conferido antes de chamar o servidor
// ---------------------------------------------------------------------------
export type StartAttempt = { kind: "outcome"; outcome: StartOutcome } | { kind: "blocked"; message: string } | { kind: "duplicate" };

export function createStartController({ source, companyId, role }: { source: StartSource; companyId: string; role: string | null }) {
  let inflight = false;
  let generation = 0;
  return {
    get busy(): boolean {
      return inflight;
    },
    /** Invalida respostas em andamento (tela fechada ou empresa trocada): o resultado é descartado. */
    invalidate(): void {
      generation++;
    },
    async start(input: Omit<StartInput, "companyId">, expectedVariables: number): Promise<StartAttempt | { kind: "stale" }> {
      if (inflight) return { kind: "duplicate" };
      if (!roleCanStart(role)) return { kind: "blocked", message: "Seu perfil não pode iniciar conversas pelo WhatsApp." };
      if (!isUuid(input.clientRequestId) || !isUuid(input.contactRef) || !isUuid(input.templateId)) return { kind: "blocked", message: "Pedido inválido. Feche e abra de novo." };
      if (!isConsentOrigin(input.consentOrigin)) return { kind: "blocked", message: "Informe a origem da autorização." };
      const refError = validateConsentRef(input.consentRef);
      if (refError) return { kind: "blocked", message: refError };
      const p = validateParams(input.params, expectedVariables);
      if (!p.ok) return { kind: "blocked", message: "Confira as variáveis da mensagem." };
      inflight = true;
      const gen = generation;
      try {
        const outcome = await source.start({ ...input, companyId, consentRef: input.consentRef.trim(), params: p.params });
        return gen === generation ? { kind: "outcome", outcome } : { kind: "stale" };
      } finally {
        inflight = false;
      }
    },
  };
}
