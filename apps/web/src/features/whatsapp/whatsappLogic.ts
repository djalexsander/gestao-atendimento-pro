// Regras PURAS do inbox de WhatsApp (sem React/Supabase): formatação, filtros, ordenação e mensagens. Fase 2A-1: SOMENTE
// leitura. O telefone no banco é E.164 só com dígitos (ex.: 5544999990001); a máscara é só de exibição.
import type { CompanyRole } from "../../lib/types";

export type ConversationStatus = "open" | "waiting" | "closed";
export type MessageType = "text" | "image" | "audio" | "document" | "location" | "interactive" | "template" | "unknown";
export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";
export type Direction = "inbound" | "outbound";
export type ConversationFilter = "open" | "mine" | "unassigned" | "waiting" | "closed" | "unread" | "all";

export interface RawConversation {
  id: string;
  contact_phone: string;
  contact_display_name: string | null;
  customer_id: string | null;
  status: ConversationStatus;
  assigned_user_id: string | null;
  unread_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  ai_control?: "inherit" | "human" | null;
  ai_handoff_reason?: string | null;
}
export interface ConversationRow {
  id: string;
  phone: string;
  name: string | null;
  customerId: string | null;
  status: ConversationStatus;
  assignedUserId: string | null;
  unread: number;
  preview: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  /** IA (Fase 2): 'human' = IA pausada nesta conversa (assumida por humano ou encaminhada pela IA). */
  aiControl: "inherit" | "human";
  aiHandoffReason: string | null;
}
export interface RawMessage {
  id: string;
  conversation_id: string;
  direction: Direction;
  type: MessageType;
  body: string | null;
  status: MessageStatus;
  provider_timestamp: string | null;
  created_at: string;
  origin?: "human" | "ai_auto" | "system" | null;
}
export interface MessageRow {
  id: string;
  conversationId: string;
  direction: Direction;
  type: MessageType;
  body: string | null;
  status: MessageStatus;
  at: string;
  /** 'ai_auto' = enviada pela IA automática (selo "IA" no balão). */
  origin: "human" | "ai_auto" | "system";
}
export interface CustomerHint {
  id: string;
  name: string;
  phoneLast4: string;
}
export interface Suggestions {
  linked: CustomerHint | null;
  suggestions: CustomerHint[];
}
export interface ConnectionSummary {
  configured: boolean;
  status: string | null;
  mode: "test" | "live" | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
}

export const FILTER_LABEL: Record<ConversationFilter, string> = {
  open: "Abertas",
  mine: "Minhas",
  unassigned: "Não atribuídas",
  waiting: "Aguardando",
  closed: "Fechadas",
  unread: "Não lidas",
  all: "Todas",
};
export const FILTER_ORDER: readonly ConversationFilter[] = ["open", "mine", "unassigned", "unread", "waiting", "closed", "all"];
export const STATUS_LABEL: Record<ConversationStatus, string> = { open: "Aberta", waiting: "Aguardando", closed: "Fechada" };

/** Papéis que enxergam o WhatsApp (espelha o banco: production e courier ficam de fora). */
export const WHATSAPP_ROLES: readonly CompanyRole[] = ["owner", "admin", "attendant", "cashier"];
export const canUseWhatsapp = (role: CompanyRole | null | undefined): boolean => !!role && WHATSAPP_ROLES.includes(role);

// ---------------------------------------------------------------------------
// Excluir conversa (soft delete no banco; só owner/admin)
// ---------------------------------------------------------------------------
/** Quem vê a ação "Excluir conversa" (o banco confere de novo: attendant/cashier nunca excluem). */
export const canDeleteConversation = (role: CompanyRole | null | undefined): boolean => role === "owner" || role === "admin";
export const DELETE_CONVERSATION_TITLE = "Excluir esta conversa?";
export const DELETE_CONVERSATION_TEXT = "Esta ação removerá a conversa do atendimento e não poderá ser desfeita. As mensagens desta conversa também deixarão de aparecer.";
export const DELETE_CONVERSATION_OK = "Conversa excluída.";
export const DELETE_CONVERSATION_ERROR = "Não foi possível excluir a conversa.";
/** Tira a conversa da lista local na hora (sem esperar o recarregamento). */
export function withoutConversation<T extends { id: string }>(list: T[] | null, id: string): T[] | null {
  return list === null ? null : list.filter((c) => c.id !== id);
}
/** Mensagem de falha: recusas do banco (envio/IA em andamento, permissão) seguem; qualquer outra vira o texto padrão. */
export function friendlyDeleteError(message: string | null | undefined): string {
  const m = (message ?? "").trim();
  if (m && m.length <= 160 && !/^(Edge Function|FunctionsHttpError|FunctionsFetchError|Failed to|TypeError|AuthApiError|Não foi possível concluir)/i.test(m)) return m;
  return DELETE_CONVERSATION_ERROR;
}

export function toConversation(r: RawConversation): ConversationRow {
  return {
    id: r.id,
    phone: r.contact_phone,
    name: r.contact_display_name,
    customerId: r.customer_id,
    status: r.status,
    assignedUserId: r.assigned_user_id ?? null,
    unread: Number(r.unread_count) || 0,
    preview: r.last_message_preview,
    lastMessageAt: r.last_message_at,
    lastInboundAt: r.last_inbound_at ?? null,
    aiControl: r.ai_control === "human" ? "human" : "inherit",
    aiHandoffReason: r.ai_handoff_reason ?? null,
  };
}

export function toMessage(r: RawMessage): MessageRow {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    type: r.type,
    body: r.body,
    status: r.status,
    at: r.provider_timestamp ?? r.created_at,
    origin: r.origin === "ai_auto" || r.origin === "system" ? r.origin : "human",
  };
}

/** E.164 só dígitos => "+55 (44) 99999-0001". Fora do padrão brasileiro devolve "+dígitos". */
export function formatWaPhone(digits: string | null | undefined): string {
  const d = String(digits ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    const cut = rest.length - 4;
    return `+55 (${ddd}) ${rest.slice(0, cut)}-${rest.slice(cut)}`;
  }
  return `+${d}`;
}

export function conversationTitle(c: Pick<ConversationRow, "name" | "phone">): string {
  return c.name?.trim() || formatWaPhone(c.phone);
}

export function matchesFilter(c: ConversationRow, filter: ConversationFilter, currentUserId: string | null): boolean {
  switch (filter) {
    case "open":
      return c.status !== "closed"; // "abertas" = tudo que ainda não foi fechado (inclui aguardando)
    case "waiting":
      return c.status === "waiting";
    case "closed":
      return c.status === "closed";
    case "unread":
      return c.unread > 0;
    case "mine":
      return currentUserId !== null && c.assignedUserId === currentUserId && c.status !== "closed";
    case "unassigned":
      return c.assignedUserId === null && c.status !== "closed";
    default:
      return true;
  }
}

export function applyFilter(rows: readonly ConversationRow[], filter: ConversationFilter, search = "", currentUserId: string | null = null): ConversationRow[] {
  const q = search.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  return rows
    .filter((c) => matchesFilter(c, filter, currentUserId))
    .filter((c) => {
      if (!q) return true;
      return (c.name ?? "").toLowerCase().includes(q) || (digits !== "" && c.phone.includes(digits));
    })
    .sort((a, b) => {
      const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return tb - ta || a.id.localeCompare(b.id);
    });
}

export function totalUnread(rows: readonly ConversationRow[]): number {
  return rows.reduce((n, c) => n + c.unread, 0);
}

/** Texto da bolha: o conteúdo textual, ou o rótulo do tipo (mídia ainda não é baixada nesta fase). */
export function messageText(m: Pick<MessageRow, "type" | "body">): string {
  const label: Record<MessageType, string> = {
    text: "Mensagem recebida",
    image: "Imagem recebida",
    audio: "Áudio recebido",
    document: "Documento recebido",
    location: "Localização recebida",
    interactive: "Resposta recebida",
    template: "Mensagem modelo",
    unknown: "Mensagem recebida",
  };
  if (m.type === "text" || m.type === "interactive") return m.body ?? label[m.type];
  return m.body ? `${label[m.type]} — ${m.body}` : label[m.type];
}

export const isMediaType = (t: MessageType): boolean => t === "image" || t === "audio" || t === "document" || t === "location";

const STATUS_TEXT: Partial<Record<MessageStatus, string>> = {
  queued: "Na fila",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};
/** Só mensagens enviadas pela empresa têm status a mostrar. */
export function statusText(m: Pick<MessageRow, "direction" | "status">): string | null {
  return m.direction === "outbound" ? (STATUS_TEXT[m.status] ?? null) : null;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Hoje: hora; mais antigo: dia/mês. */
export function listTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? formatClock(iso) : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function toSuggestions(raw: unknown): Suggestions {
  const o = (raw && typeof raw === "object" ? raw : {}) as { linked?: unknown; suggestions?: unknown };
  const hint = (v: unknown): CustomerHint | null => {
    if (!v || typeof v !== "object") return null;
    const x = v as { id?: unknown; name?: unknown; phone_last4?: unknown };
    return typeof x.id === "string" && typeof x.name === "string"
      ? { id: x.id, name: x.name, phoneLast4: typeof x.phone_last4 === "string" ? x.phone_last4 : "" }
      : null;
  };
  return {
    linked: hint(o.linked),
    suggestions: Array.isArray(o.suggestions) ? o.suggestions.map(hint).filter((h): h is CustomerHint => h !== null) : [],
  };
}

export function toConnectionSummary(raw: unknown): ConnectionSummary {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    configured: o.configured === true,
    status: typeof o.status === "string" ? o.status : null,
    mode: o.mode === "live" ? "live" : o.mode === "test" ? "test" : null,
    displayPhoneNumber: typeof o.display_phone_number === "string" ? o.display_phone_number : null,
    businessName: typeof o.business_name === "string" ? o.business_name : null,
  };
}

// ---- Janela de atendimento (espelha whatsapp_can_send_freeform; o servidor é quem decide de verdade) ----
export const WINDOW_HOURS = 24;
export interface WindowState {
  open: boolean;
  expiresAt: string | null;
  reason: "no_inbound" | "window_closed" | null;
}
export function windowState(lastInboundAt: string | null | undefined, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { open: false, expiresAt: null, reason: "no_inbound" };
  const t = Date.parse(lastInboundAt);
  if (Number.isNaN(t)) return { open: false, expiresAt: null, reason: "no_inbound" };
  const end = t + WINDOW_HOURS * 3600 * 1000;
  const expiresAt = new Date(end).toISOString();
  return now.getTime() <= end ? { open: true, expiresAt, reason: null } : { open: false, expiresAt, reason: "window_closed" };
}

export const OUTSIDE_WINDOW_TEXT = "Fora da janela de atendimento. Será necessário usar um template aprovado.";
export const MAX_BODY_LENGTH = 4096;

export type ComposerBlock = "closed" | "window" | "empty" | "too_long" | null;
/** Por que o composer não pode enviar agora (null = pode). */
export function composerBlock(c: Pick<ConversationRow, "status" | "lastInboundAt">, body: string, now: Date = new Date()): ComposerBlock {
  if (c.status === "closed") return "closed";
  if (!windowState(c.lastInboundAt, now).open) return "window";
  const text = body.trim();
  if (text.length === 0) return "empty";
  if (text.length > MAX_BODY_LENGTH) return "too_long";
  return null;
}

export function windowLabel(w: WindowState): string {
  return w.open && w.expiresAt ? `Janela aberta até ${formatClock(w.expiresAt)}` : "Janela de atendimento encerrada";
}

// ---- Ações da conversa ----
export interface AgentOption {
  userId: string;
  name: string;
  role: string;
}
const ROLE_LABEL: Record<string, string> = { owner: "Proprietário", admin: "Administrador", attendant: "Atendente", cashier: "Caixa" };
export const agentLabel = (a: AgentOption): string => `${a.name} (${ROLE_LABEL[a.role] ?? a.role})`;

export function toAgents(raw: unknown): AgentOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentOption[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as { user_id?: unknown; name?: unknown; role?: unknown };
    if (typeof o.user_id === "string" && typeof o.name === "string" && typeof o.role === "string") out.push({ userId: o.user_id, name: o.name, role: o.role });
  }
  return out;
}

export interface StatusAction {
  to: ConversationStatus;
  label: string;
}
/** Ações de situação permitidas a partir do estado atual (espelha as transições do banco). */
export function statusActions(status: ConversationStatus): StatusAction[] {
  switch (status) {
    case "open":
      return [{ to: "waiting", label: "Aguardar" }, { to: "closed", label: "Fechar" }];
    case "waiting":
      return [{ to: "open", label: "Retomar" }, { to: "closed", label: "Fechar" }];
    default:
      return [{ to: "open", label: "Reabrir" }];
  }
}

/** Mensagem do erro do envio sem expor nada técnico. */
export function friendlySendError(message: string | null | undefined): string {
  const m = (message ?? "").trim();
  if (m && !/^(Edge Function|FunctionsHttpError|FunctionsFetchError|Failed to|TypeError|AuthApiError)/i.test(m) && m.length <= 200) return m;
  return "Não foi possível enviar a mensagem agora. Tente novamente.";
}

// ---- IA do WhatsApp (Fase 1: SÓ sugestão; o envio continua manual) ----
export const AI_SUGGEST_ERROR = "Não foi possível gerar a sugestão agora. Você pode continuar respondendo manualmente.";
export const AI_BADGE_TEXT = "Sugestão da IA — ainda não enviada";
export const AI_BADGE_EDITED_TEXT = "Sugestão da IA — editada";

/** Modo efetivo vindo do banco ('auto' só com todos os requisitos). Qualquer outra coisa = desligado. */
export type AiMode = "off" | "suggest" | "auto";
export function toAiMode(raw: unknown): AiMode {
  const o = typeof raw === "object" && raw !== null ? (raw as { effective_mode?: unknown }) : {};
  return o.effective_mode === "suggest" || o.effective_mode === "auto" ? o.effective_mode : "off";
}

/** Mostra/habilita o botão: modo suggest OU auto (em conversa assumida por humano), conversa aberta e dentro da janela. O botão só SUGERE. */
export function aiSuggestAvailable(mode: AiMode, block: ComposerBlock): boolean {
  return (mode === "suggest" || mode === "auto") && block !== "closed" && block !== "window";
}

// ---- IA automática por conversa (Fase 2) ----
export const AI_AUTO_ACTIVE_TEXT = "IA ativa";
export const AI_PAUSED_TEXT = "IA pausada — atendimento humano";
export const AI_HANDOFF_REASON_LABEL: Record<string, string> = {
  human_requested: "o cliente pediu um atendente",
  complaint: "reclamação do cliente",
  legal: "assunto jurídico ou sensível",
  billing_sensitive: "cobrança sensível",
  out_of_scope: "assunto fora das instruções",
  missing_info: "faltou informação para responder",
  low_confidence: "a IA não teve certeza",
  prompt_injection: "mensagem suspeita",
  action_required: "o pedido exige uma ação no sistema",
  unsupported_media: "mensagem de áudio, imagem ou arquivo",
  unsupported_commercial_claim: "a resposta trazia preço, oferta ou condição que as instruções não sustentam",
  unauthorized_offer: "a resposta continha oferta não autorizada",
  invented_value: "a resposta continha valor não autorizado",
  invalid_output: "a IA não conseguiu responder",
  timeout: "a IA demorou para responder",
  provider_error: "erro no serviço de IA",
  rate_limited: "serviço de IA ocupado",
  too_many_changes: "o cliente continuou escrevendo",
  other: "motivo não informado",
};
export function aiHandoffReasonLabel(code: string | null | undefined): string {
  return (code && AI_HANDOFF_REASON_LABEL[code]) || AI_HANDOFF_REASON_LABEL.other;
}

export type AiConversationState =
  | { kind: "none" }
  | { kind: "active"; label: string }
  | { kind: "paused"; label: string }
  | { kind: "handoff"; label: string };

/**
 * Situação da IA numa conversa. Só existe com a empresa em 'auto'. Conversa atribuída a alguém conta como atendimento humano
 * (a IA não responde); 'Devolver para IA' também desatribui, então o estado exibido nunca contradiz o que o banco faz.
 */
export function aiConversationState(mode: AiMode, c: Pick<ConversationRow, "aiControl" | "aiHandoffReason" | "assignedUserId">): AiConversationState {
  if (mode !== "auto") return { kind: "none" };
  if (c.aiControl === "human" && c.aiHandoffReason) {
    return { kind: "handoff", label: `Encaminhada para humano: ${aiHandoffReasonLabel(c.aiHandoffReason)}` };
  }
  if (c.aiControl === "human" || c.assignedUserId) return { kind: "paused", label: AI_PAUSED_TEXT };
  return { kind: "active", label: AI_AUTO_ACTIVE_TEXT };
}

/** Ação do atendente: 'take' (Assumir atendimento) quando a IA está ativa; 'return' (Devolver para IA) quando está pausada. */
export function aiTakeoverAction(state: AiConversationState): { to: "human" | "inherit"; label: string } | null {
  if (state.kind === "active") return { to: "human", label: "Assumir atendimento" };
  if (state.kind === "paused" || state.kind === "handoff") return { to: "inherit", label: "Devolver para IA" };
  return null;
}

export interface AiDraftState {
  status: "idle" | "loading" | "ready";
  /** Última sugestão colocada no composer. */
  suggestion: string | null;
  /** Rascunho que existia antes da primeira sugestão (restaurado em Descartar). */
  previousDraft: string;
}
export const AI_IDLE: AiDraftState = { status: "idle", suggestion: null, previousDraft: "" };

export function aiLoading(prev: AiDraftState, currentDraft: string): AiDraftState {
  // gerar outra mantém o rascunho ORIGINAL (não a sugestão anterior)
  return { status: "loading", suggestion: prev.suggestion, previousDraft: prev.suggestion === null ? currentDraft : prev.previousDraft };
}
export function aiReady(prev: AiDraftState, suggestion: string): AiDraftState {
  return { status: "ready", suggestion, previousDraft: prev.previousDraft };
}
/** Falha: volta ao estado anterior ao pedido (o rascunho nunca é apagado). */
export function aiFailed(prev: AiDraftState): AiDraftState {
  return prev.suggestion === null ? AI_IDLE : { ...prev, status: "ready" };
}
/** Selo: some quando não há sugestão; muda para "editada" se o texto do composer deixou de ser o sugerido. */
export function aiBadge(state: AiDraftState, draft: string): "none" | "suggested" | "edited" {
  if (state.suggestion === null) return "none";
  return draft === state.suggestion ? "suggested" : "edited";
}
// ---------------------------------------------------------------------------
// Erro de ENVIO do WhatsApp (separado do erro da sugestão por IA e do erro de ações)
// ---------------------------------------------------------------------------
/** Recusa da tentativa de envio mais recente, presa à conversa em que aconteceu. */
export interface SendErrorState {
  conversationId: string;
  message: string;
  /** Saídas já aceitas (sent/delivered/read) quando a falha ocorreu: qualquer outra que apareça depois supera o erro. */
  acceptedIds: string[];
}

const ACCEPTED: ReadonlySet<MessageStatus> = new Set(["sent", "delivered", "read"]);
export const acceptedOutboundIds = (messages: MessageRow[] | null): string[] =>
  (messages ?? []).filter((m) => m.direction === "outbound" && ACCEPTED.has(m.status)).map((m) => m.id);

export function makeSendError(conversationId: string, message: string, messages: MessageRow[] | null): SendErrorState {
  return { conversationId, message, acceptedIds: acceptedOutboundIds(messages) };
}

/**
 * Banner vermelho de envio: só enquanto a tentativa é a atual. Some se a conversa aberta é outra ou se, depois da falha, uma saída
 * foi aceita pelo WhatsApp (envio bem-sucedido por qualquer caminho). Um 'failed' antigo no histórico NUNCA recria o banner:
 * a falha vive na própria mensagem ("Falhou" + Reenviar).
 */
export function visibleSendError(err: SendErrorState | null, selectedId: string | null, messages: MessageRow[] | null): string | null {
  if (!err || err.conversationId !== selectedId) return null;
  const known = new Set(err.acceptedIds);
  return acceptedOutboundIds(messages).some((id) => !known.has(id)) ? null : err.message;
}

/**
 * Enter envia apenas texto DIGITADO. Rascunho vindo de "Sugerir resposta com IA" (sugerido ou editado) só sai pelo botão Enviar,
 * como o próprio fluxo promete ("a IA só sugere; o envio é pelo botão"): Enter nele é quebra de linha, nunca envio.
 */
export function enterSends(state: AiDraftState): boolean {
  return state.suggestion === null && state.status !== "loading";
}

export function friendlyAiError(message: string | null | undefined): string {
  const m = (message ?? "").trim();
  if (m && !/^(Edge Function|FunctionsHttpError|FunctionsFetchError|Failed to|TypeError|AuthApiError)/i.test(m) && m.length <= 200) return m;
  return AI_SUGGEST_ERROR;
}

export interface AiSettings {
  effectiveMode: AiMode;
  enabled: boolean;
  mode: "off" | "suggest" | "auto";
  businessName: string;
  tone: string;
  customInstructions: string;
  businessHours: string;
  fallbackToHuman: boolean;
  maxContextMessages: number;
  acknowledgedAt: string | null;
  /** Fase 2: ciência específica do modo automático. */
  autoAcknowledgedAt: string | null;
  /** Fase 2: repassados sem alteração ao salvar (a tela ainda não os edita; não podem ser apagados). */
  afterHoursPolicy: "ai_continues" | "silent" | "message";
  afterHoursMessage: string;
  businessSchedule: unknown;
}

export const AI_DEFAULT_SETTINGS: AiSettings = {
  effectiveMode: "off", enabled: false, mode: "off", businessName: "", tone: "", customInstructions: "", businessHours: "",
  fallbackToHuman: true, maxContextMessages: 12, acknowledgedAt: null,
  autoAcknowledgedAt: null, afterHoursPolicy: "ai_continues", afterHoursMessage: "", businessSchedule: null,
};

export const AI_AUTO_WARNING =
  "A IA poderá responder seus clientes automaticamente com base nas instruções configuradas. Conversas que exigirem atendimento humano poderão ser encaminhadas para sua equipe.";

export function toAiSettings(raw: unknown): AiSettings {
  if (typeof raw !== "object" || raw === null) return AI_DEFAULT_SETTINGS;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const hours = typeof o.business_hours === "object" && o.business_hours !== null ? str((o.business_hours as { text?: unknown }).text) : "";
  const max = typeof o.max_context_messages === "number" ? o.max_context_messages : 12;
  return {
    effectiveMode: toAiMode(o),
    enabled: o.enabled === true,
    mode: o.mode === "suggest" || o.mode === "auto" ? o.mode : "off",
    businessName: str(o.business_name),
    tone: str(o.tone),
    customInstructions: str(o.custom_instructions),
    businessHours: hours,
    fallbackToHuman: o.fallback_to_human !== false,
    maxContextMessages: Math.min(30, Math.max(1, Math.round(max))),
    acknowledgedAt: typeof o.acknowledged_at === "string" ? o.acknowledged_at : null,
    autoAcknowledgedAt: typeof o.auto_acknowledged_at === "string" ? o.auto_acknowledged_at : null,
    afterHoursPolicy: o.after_hours_policy === "silent" || o.after_hours_policy === "message" ? o.after_hours_policy : "ai_continues",
    afterHoursMessage: str(o.after_hours_message),
    businessSchedule: typeof o.business_schedule === "object" && o.business_schedule !== null ? o.business_schedule : null,
  };
}

/** Erros de validação da tela de configuração (o banco confere de novo). */
export function aiSettingsError(
  s: Pick<AiSettings, "businessName" | "tone" | "customInstructions" | "businessHours" | "maxContextMessages" | "enabled">,
  acknowledged: boolean,
  auto?: { mode: "off" | "suggest" | "auto"; autoAcknowledged: boolean },
): string | null {
  if (s.businessName.length > 120) return "O nome do estabelecimento pode ter no máximo 120 caracteres.";
  if (s.tone.length > 80) return "O tom de voz pode ter no máximo 80 caracteres.";
  if (s.businessHours.length > 300) return "O horário de atendimento pode ter no máximo 300 caracteres.";
  if (s.customInstructions.length > 2000) return "As instruções podem ter no máximo 2000 caracteres.";
  if (!Number.isInteger(s.maxContextMessages) || s.maxContextMessages < 1 || s.maxContextMessages > 30) return "O contexto deve ter entre 1 e 30 mensagens.";
  if (s.enabled && !acknowledged) return "Confirme a ciência sobre o tratamento dos dados para ativar.";
  if (s.enabled && auto?.mode === "auto") {
    if (!s.customInstructions.trim()) return "Preencha as instruções da IA (produtos, preços e regras) antes de ativar o modo automático.";
    if (!auto.autoAcknowledged) return "Confirme que a IA poderá responder seus clientes automaticamente para ativar o modo automático.";
  }
  return null;
}
