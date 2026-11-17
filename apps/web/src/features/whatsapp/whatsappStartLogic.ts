// Lógica PURA do "Iniciar conversa" (Etapa 7.11G): sem React, sem Supabase, sem relógio. Interpreta as respostas das RPCs/Edge da 7.11 (configuração,
// templates, bloqueio do contato, pedidos de início) com defesa, valida o formulário com as MESMAS regras do servidor (para não chamar à toa) e
// decide quando o botão aparece. O servidor continua sendo a autoridade: papel, módulo, empresa, conexão, opt-out, PT402, limite e consentimento.
// Nenhum telefone, token ou texto bruto da Meta passa por aqui: o navegador só informa a REFERÊNCIA do contato (id) e o servidor resolve o telefone.
import type { ContactRow } from "./whatsappContactsLogic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

// ---------------------------------------------------------------------------
// 1) Configuração da empresa (habilitada pelo Master)
// ---------------------------------------------------------------------------
export interface StartSettings {
  enabled: boolean;
  dailyLimit: number;
  minIntervalHours: number;
  usedToday: number;
  canStart: boolean;
}

export function toStartSettings(raw: unknown): StartSettings | null {
  if (!isObj(raw)) return null;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    enabled: raw.enabled === true,
    dailyLimit: n(raw.daily_limit, 0),
    minIntervalHours: n(raw.min_interval_hours, 0),
    usedToday: n(raw.used_today, 0),
    canStart: raw.can_start === true,
  };
}

export const START_ROLES: readonly string[] = ["owner", "admin", "attendant"];
/** Só owner, admin e atendente (o servidor confere de novo). */
export const roleCanStart = (role: string | null | undefined): boolean => !!role && START_ROLES.includes(role);

/** O recurso está disponível para ESTE usuário: papel permitido, habilitado pelo Master e permitido pelo servidor. */
export function startAvailable(role: string | null | undefined, settings: StartSettings | null): boolean {
  return roleCanStart(role) && settings !== null && settings.enabled && settings.canStart;
}

export function dailyLimitReached(s: StartSettings): boolean {
  return s.dailyLimit > 0 && s.usedToday >= s.dailyLimit;
}

// ---------------------------------------------------------------------------
// 2) Templates
// ---------------------------------------------------------------------------
export interface StartTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  bodyText: string;
  variableCount: number;
  eligible: boolean;
  ineligibleReason: string | null;
}

export interface StartTemplates {
  connected: boolean;
  stale: boolean;
  templates: StartTemplate[];
}

export function toStartTemplates(raw: unknown): StartTemplates | null {
  if (!isObj(raw)) return null;
  const list = Array.isArray(raw.templates) ? raw.templates : [];
  const templates: StartTemplate[] = [];
  for (const t of list) {
    if (!isObj(t) || !isUuid(t.id)) continue;
    const name = str(t.name);
    if (!name) continue;
    const count = typeof t.body_variable_count === "number" && Number.isInteger(t.body_variable_count) && t.body_variable_count >= 0 ? t.body_variable_count : null;
    if (count === null) continue;
    templates.push({
      id: t.id,
      name,
      language: str(t.language) ?? "",
      category: str(t.category),
      bodyText: str(t.body_text) ?? "",
      variableCount: count,
      eligible: t.eligible === true,
      ineligibleReason: str(t.ineligible_reason),
    });
  }
  return { connected: raw.connected === true, stale: raw.stale === true, templates };
}

/** Só o que pode ser enviado: elegível e com corpo. (O servidor só devolve APROVADOS e ainda revalida no envio.) */
export const sendableTemplates = (t: StartTemplates | null): StartTemplate[] => (t ? t.templates.filter((x) => x.eligible && x.bodyText.trim() !== "") : []);
export const unsupportedTemplateCount = (t: StartTemplates | null): number => (t ? t.templates.filter((x) => !x.eligible).length : 0);

export const templateLabel = (t: Pick<StartTemplate, "name" | "language">): string => (t.language ? `${t.name} (${t.language})` : t.name);

// ---------------------------------------------------------------------------
// 3) Variáveis e prévia (mesmas regras de whatsapp_template_params_normalize)
// ---------------------------------------------------------------------------
export const PARAM_MAX = 1024;

/** null = válido. Texto aparado, 1..1024 caracteres, sem quebra de linha, tabulação nem 4 espaços seguidos. */
export function validateParam(value: string): string | null {
  const v = value.trim();
  if (v === "") return "Preencha esta variável.";
  if (Array.from(v).length > PARAM_MAX) return `No máximo ${PARAM_MAX} caracteres.`;
  if (/[\t\n\r]/.test(v) || v.includes("    ")) return "Não use quebra de linha, tabulação nem 4 espaços seguidos.";
  return null;
}

export function validateParams(values: readonly string[], expected: number): { ok: boolean; errors: (string | null)[]; params: string[] } {
  const errors = Array.from({ length: expected }, (_, i) => validateParam(values[i] ?? ""));
  return { ok: errors.every((e) => e === null), errors, params: Array.from({ length: expected }, (_, i) => (values[i] ?? "").trim()) };
}

/** Corpo com {{n}} trocados. Variável vazia mantém o marcador para a pessoa ver o que falta. */
export function renderPreview(bodyText: string, values: readonly string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (m, n: string) => {
    const v = (values[Number(n) - 1] ?? "").trim();
    return v === "" ? m : v;
  });
}

// ---------------------------------------------------------------------------
// 4) Consentimento (mesmas regras da RPC)
// ---------------------------------------------------------------------------
export const CONSENT_ORIGINS = [
  { value: "written_consent", label: "Autorização por escrito" },
  { value: "customer_request", label: "O próprio cliente pediu contato" },
  { value: "external_record", label: "Registro em outro sistema" },
  { value: "other_documented", label: "Outra origem (documentada)" },
] as const;
export type ConsentOrigin = (typeof CONSENT_ORIGINS)[number]["value"];
export const isConsentOrigin = (v: unknown): v is ConsentOrigin => CONSENT_ORIGINS.some((o) => o.value === v);

export const CONSENT_REF_MIN = 3;
export const CONSENT_REF_MAX = 80;

/** null = válida. 3 a 80 caracteres e sem sequência de 8 ou mais dígitos (não é o lugar de colocar telefone). */
export function validateConsentRef(ref: string): string | null {
  const r = ref.trim();
  const len = Array.from(r).length;
  if (len < CONSENT_REF_MIN || len > CONSENT_REF_MAX) return `Informe a referência da autorização (de ${CONSENT_REF_MIN} a ${CONSENT_REF_MAX} caracteres).`;
  if (r.replace(/[^0-9]/g, "").length >= 8) return "A referência não pode conter telefone nem sequência de 8 ou mais dígitos.";
  return null;
}

// ---------------------------------------------------------------------------
// 5) Bloqueio do contato (opt-out)
// ---------------------------------------------------------------------------
export interface ContactOptout {
  optedOut: boolean;
  source: string | null;
  since: string | null;
}

export function toContactOptout(raw: unknown): ContactOptout | null {
  if (!isObj(raw) || typeof raw.opted_out !== "boolean") return null;
  return { optedOut: raw.opted_out, source: str(raw.source), since: str(raw.since) };
}

// ---------------------------------------------------------------------------
// 6) Quem pode receber o botão
// ---------------------------------------------------------------------------
export interface StartTarget {
  kind: "manual" | "customer";
  ref: string;
}

/**
 * Contato SEM conversa, ativo e com identidade que o servidor resolve (contato manual ou cliente confiável). Contato com conversa usa
 * "Abrir conversa"; arquivado e ambíguo (vários clientes com o número) não recebem o botão.
 */
export function startTargetOf(c: Pick<ContactRow, "conversationId" | "archivedAt" | "isManual" | "manualContactId" | "customerId" | "customerMatches">): StartTarget | null {
  if (c.conversationId !== null || c.archivedAt !== null) return null;
  if (c.isManual && isUuid(c.manualContactId)) return { kind: "manual", ref: c.manualContactId };
  if (c.customerId !== null && c.customerMatches <= 1 && isUuid(c.customerId)) return { kind: "customer", ref: c.customerId };
  return null;
}

export function canShowStart(role: string | null | undefined, settings: StartSettings | null, c: Parameters<typeof startTargetOf>[0]): boolean {
  return startAvailable(role, settings) && startTargetOf(c) !== null;
}

// ---------------------------------------------------------------------------
// 7) Resultado do envio (Edge whatsapp-start-conversation)
// ---------------------------------------------------------------------------
export type StartStatus = "accepted" | "unconfirmed" | "in_progress" | "failed";

export interface StartOutcome {
  status: StartStatus;
  conversationId: string | null;
  requestId: string | null;
  message: string | null;
  code: string | null;
  /** O pedido pode já existir no servidor (rede caiu/resposta incerta): repetir o MESMO client_request_id é seguro; um novo não é. */
  keepRequestId: boolean;
}

export const OUTCOME_TEXT: Record<StartStatus, { title: string; detail: string }> = {
  accepted: { title: "Mensagem aceita pela Meta", detail: "Aceita não significa entregue: a entrega aparece na conversa quando a Meta confirmar." },
  unconfirmed: { title: "Resultado incerto", detail: "A Meta demorou ou deu uma resposta incerta. A mensagem pode ter sido aceita. Confira a conversa e use as solicitações antes de tentar de novo; nada é reenviado automaticamente." },
  in_progress: { title: "Envio em andamento", detail: "Este envio já está em andamento. Aguarde alguns instantes e confira a conversa." },
  failed: { title: "Não foi possível enviar", detail: "A mensagem não foi enviada." },
};

export const NETWORK_OUTCOME: StartOutcome = {
  status: "unconfirmed",
  conversationId: null,
  requestId: null,
  message: "Não foi possível confirmar se o envio foi feito (a conexão falhou). Confira as solicitações antes de tentar de novo; repetir agora é seguro porque o pedido é o mesmo.",
  code: null,
  keepRequestId: true,
};

const SERVER_STATUSES: readonly string[] = ["accepted", "unconfirmed", "in_progress", "failed"];

/** Interpreta o corpo da Edge (sucesso 200/202 ou erro). `httpStatus` = 0 quando não houve resposta. */
export function toStartOutcome(httpStatus: number, body: unknown): StartOutcome {
  if (httpStatus === 0) return NETWORK_OUTCOME;
  const o = isObj(body) ? body : {};
  const status = typeof o.status === "string" && SERVER_STATUSES.includes(o.status) ? (o.status as StartStatus) : null;
  const conversationId = isUuid(o.conversation_id) ? o.conversation_id : null;
  const requestId = isUuid(o.request_id) ? o.request_id : null;
  const message = str(o.error);
  const code = str(o.code);
  if (httpStatus >= 200 && httpStatus < 300) {
    // sucesso só vale com conversa e pedido: resposta sem eles não prova nada
    if (status && conversationId && requestId) return { status, conversationId, requestId, message, code, keepRequestId: status !== "failed" };
    return { ...NETWORK_OUTCOME, message: "Resposta inesperada do servidor. Confira as solicitações antes de tentar de novo." };
  }
  if (status === "unconfirmed" || status === "in_progress") return { status, conversationId, requestId, message, code, keepRequestId: true };
  // 5xx/502/504 sem corpo conhecido: o servidor pode ter criado o pedido
  if (httpStatus >= 500 && !status && !conversationId) {
    // 502/504 (gateway): o servidor pode ter continuado sem nós → incerto; outros 5xx: nada foi despachado. Nos dois casos repetir o MESMO pedido é seguro
    const uncertain = httpStatus === 502 || httpStatus === 504;
    return { status: uncertain ? "unconfirmed" : "failed", conversationId: null, requestId: null, message: message ?? GENERIC_FAILURE, code, keepRequestId: true };
  }
  return { status: "failed", conversationId, requestId, message: friendlyStartError(httpStatus, code, message), code, keepRequestId: false };
}

const GENERIC_FAILURE = "Não foi possível iniciar a conversa agora. Tente novamente em instantes.";

/** Mensagem para a pessoa: as do servidor já são em português e sem dados sensíveis; só se completa o que falta. */
export function friendlyStartError(httpStatus: number, code: string | null, message: string | null): string {
  if (code === "PT402" || httpStatus === 402) return message ?? "A empresa está em modo somente leitura. Regularize a assinatura para iniciar conversas.";
  if (message && message.trim() !== "") return message;
  if (httpStatus === 401) return "Sessão expirada. Entre novamente.";
  if (httpStatus === 403) return "Você não tem permissão para iniciar conversas.";
  if (httpStatus === 404) return "Contato ou template não encontrado.";
  if (httpStatus === 409) return "Não foi possível iniciar a conversa agora.";
  return GENERIC_FAILURE;
}

// ---------------------------------------------------------------------------
// 8) Pedidos de início (acompanhamento e resolução)
// ---------------------------------------------------------------------------
export type RequestState = "pending_dispatch" | "in_progress" | "unconfirmed" | "accepted" | "failed";
export const REQUEST_STATES: readonly RequestState[] = ["pending_dispatch", "in_progress", "unconfirmed", "accepted", "failed"];
export type Resolution = "confirmed_sent" | "confirmed_not_sent" | "cancelled_unsent";

export interface StartRequest {
  requestId: string;
  createdAt: string | null;
  conversationId: string | null;
  contactName: string | null;
  templateName: string | null;
  requestedByMe: boolean;
  state: RequestState;
  deliveryStatus: string | null;
  errorCode: string | null;
  resolution: string | null;
}

export function toStartRequests(raw: unknown): StartRequest[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StartRequest[] = [];
  for (const r of raw) {
    if (!isObj(r) || !isUuid(r.request_id)) continue;
    const state = REQUEST_STATES.find((s) => s === r.state);
    if (!state) continue;
    out.push({
      requestId: r.request_id,
      createdAt: str(r.created_at),
      conversationId: isUuid(r.conversation_id) ? r.conversation_id : null,
      contactName: str(r.contact_name),
      templateName: str(r.template_name),
      requestedByMe: r.requested_by_me === true,
      state,
      deliveryStatus: str(r.delivery_status),
      errorCode: str(r.error_code),
      resolution: str(r.resolution),
    });
  }
  return out;
}

export const STATE_LABEL: Record<RequestState, string> = {
  pending_dispatch: "Aguardando envio",
  in_progress: "Envio em andamento",
  unconfirmed: "Resultado incerto",
  accepted: "Aceita pela Meta",
  failed: "Não enviada",
};

export const STATE_HELP: Record<RequestState, string> = {
  pending_dispatch: "O envio não chegou a sair. Você pode cancelar este pedido.",
  in_progress: "Outra chamada está falando com a Meta. Aguarde alguns minutos.",
  unconfirmed: "Confira no WhatsApp se a mensagem saiu e registre o resultado. Nada é reenviado automaticamente.",
  accepted: "A Meta aceitou o envio. Aceita não significa entregue.",
  failed: "Nenhuma mensagem foi enviada.",
};

/** Precisa de uma decisão da pessoa. */
export const needsAttention = (r: Pick<StartRequest, "state">): boolean => r.state === "pending_dispatch" || r.state === "unconfirmed";

/** Resoluções permitidas por estado (o servidor confere de novo). */
export function allowedResolutions(state: RequestState): Resolution[] {
  if (state === "unconfirmed") return ["confirmed_sent", "confirmed_not_sent"];
  if (state === "pending_dispatch") return ["cancelled_unsent"];
  return [];
}

export const RESOLUTION_LABEL: Record<Resolution, string> = {
  confirmed_sent: "Conferi: a mensagem foi enviada",
  confirmed_not_sent: "Conferi: a mensagem NÃO foi enviada",
  cancelled_unsent: "Cancelar este pedido",
};

export const RESOLUTION_DONE: Record<string, string> = {
  confirmed_sent: "Marcada como enviada.",
  confirmed_not_sent: "Marcada como não enviada.",
  cancelled_unsent: "Pedido cancelado.",
};

export const DELIVERY_LABEL: Record<string, string> = { sent: "enviada", delivered: "entregue", read: "lida", failed: "falhou" };

/** "Entrega" só quando a Meta já avisou algo além de "aceita". */
export const deliveryText = (r: Pick<StartRequest, "state" | "deliveryStatus">): string | null =>
  r.state === "accepted" && r.deliveryStatus && (r.deliveryStatus === "delivered" || r.deliveryStatus === "read" || r.deliveryStatus === "failed") ? DELIVERY_LABEL[r.deliveryStatus] : null;

// ---------------------------------------------------------------------------
// 9) Erros das RPCs de leitura/resolução
// ---------------------------------------------------------------------------
export interface StartRpcError {
  code?: string | null;
  message?: string | null;
}

export function mapStartRpcError(e: StartRpcError): string {
  switch (e.code) {
    case "PT401":
      return "Sessão expirada. Entre novamente.";
    case "PT402":
      return e.message || "A empresa está em modo somente leitura.";
    case "PT403":
      return e.message || "Você não tem permissão para esta ação.";
    case "PT404":
      return e.message || "Não encontrado.";
    case "PT409":
      return e.message || "Esta ação não está disponível agora.";
    case "PT400":
      return e.message || "Dados inválidos.";
    default:
      return "Não foi possível concluir agora. Tente novamente.";
  }
}

// ---------------------------------------------------------------------------
// 10) Formulário: o que impede o envio
// ---------------------------------------------------------------------------
export interface StartFormInput {
  template: StartTemplate | null;
  values: readonly string[];
  consent: boolean;
  origin: ConsentOrigin | "";
  ref: string;
  /** null = ainda não verificado (ou a verificação falhou: o envio fica bloqueado, como no servidor). */
  optout: ContactOptout | null;
  limitReached: boolean;
}

export interface StartFormIssues {
  /** Impedimento geral (bloqueio do contato, verificação pendente, limite do dia). */
  blocker: string | null;
  template: string | null;
  params: (string | null)[];
  consent: string | null;
  origin: string | null;
  ref: string | null;
  ok: boolean;
}

export const OPTOUT_TEXT = "Este contato pediu para não receber mensagens da empresa. Não é possível iniciar a conversa.";
export const OPTOUT_PENDING_TEXT = "Verificando se o contato pode receber mensagens…";
export const LIMIT_TEXT = "O limite diário de conversas iniciadas foi atingido. Tente amanhã.";

export function startFormIssues(i: StartFormInput): StartFormIssues {
  const blocker = i.optout === null ? OPTOUT_PENDING_TEXT : i.optout.optedOut ? OPTOUT_TEXT : i.limitReached ? LIMIT_TEXT : null;
  const template = i.template === null ? "Escolha um template." : !i.template.eligible ? "Este template ainda não é compatível com o envio pelo aplicativo." : null;
  const p = i.template ? validateParams(i.values, i.template.variableCount) : { errors: [] as (string | null)[], ok: true };
  const consent = i.consent ? null : "Confirme que o contato autorizou receber mensagens da empresa.";
  const origin = i.origin === "" || !isConsentOrigin(i.origin) ? "Informe a origem da autorização." : null;
  const ref = validateConsentRef(i.ref);
  return { blocker, template, params: p.errors, consent, origin, ref, ok: blocker === null && template === null && p.ok && consent === null && origin === null && ref === null };
}
