// Regras PURAS da leitura de cortesias no Painel Master (sem React/Supabase). Somente consulta: nenhuma regra de acesso ou cobrança vive
// aqui (a AUTORIDADE é o banco). Tudo o que chega das RPCs é tratado de forma defensiva.

export type Tone = "ok" | "warn" | "bad" | "muted";

// ---------------------------------------------------------------------------------------------------------------------------
// Formatos devolvidos pelas RPCs master_* de cortesia
// ---------------------------------------------------------------------------------------------------------------------------
export type CourtesyScope = "plan" | "module";
export type CourtesyStatus = "active" | "expired_pending_decision" | "ended" | "converted";

export interface Courtesy {
  id: string;
  company_id: string;
  scope: CourtesyScope;
  plan_id: string | null;
  module_code: string | null;
  status: CourtesyStatus;
  effective_state: CourtesyStatus;
  starts_at: string;
  ends_at: string;
  days_remaining: number | null;
  reference_price_cents: number;
  reason: string;
  conversion_requested_at: string | null;
  conversion_note: string | null;
  conversion_authorized_at: string | null;
  billing_starts_competence: string | null;
  converted_subscription_id: string | null;
  closed_at: string | null;
  close_note: string | null;
}

export type AttentionKind = "bridge_expired" | "expired_pending_decision" | "expiring_soon" | "preserved_pending_payment";
export type AttentionFilter = "all" | AttentionKind;

export interface BridgeItem {
  bridge_id: string;
  company_id: string;
  subscription_id: string;
  courtesy_id: string;
  invoice_id: string;
  starts_at: string;
  until_at: string;
  hours: number;
  subscription_status: string;
  invoice_status: string;
  state: BridgeState;
  remaining_minutes: number | null;
}
export type BridgeState = "active" | "expired" | "paid" | "canceled";

export interface AttentionCourtesy extends Courtesy {
  kind: "expired_pending_decision" | "expiring_soon";
  company_name: string;
  days_overdue?: number | null;
  conversion_requested?: boolean;
}
export interface AttentionBridge extends BridgeItem {
  kind: "bridge_expired";
  company_name: string;
  hours_overdue: number | null;
}
/** F1 (migration 20261122010000): outro plano aguarda pagamento e a cortesia original está preservada. Uma linha por empresa; sem prazo. */
export interface AttentionPreserved extends Courtesy {
  kind: "preserved_pending_payment";
  company_name: string;
  subscription_id: string;
  pending_plan_id: string | null;
  pending_plan_name: string | null;
  pending_since: string;
  days_pending: number;
  conversion_requested?: boolean;
}
export type AttentionItem = AttentionCourtesy | AttentionBridge | AttentionPreserved;

export interface CourtesyCounters {
  within_days: number;
  expiring_soon: number;
  expired_pending_decision: number;
  expired_with_conversion_request: number;
  bridges_expired_unpaid: number;
  bridges_active: number;
  bridges_ending_24h: number;
  /** null = o backend ainda não envia o campo (migration 20261122010000 não aplicada). */
  preserved_pending_payment: number | null;
  preserved_pending_oldest_days: number | null;
}

export interface AttentionPage {
  total: number;
  limit: number;
  offset: number;
  items: AttentionItem[];
}

export interface CourtesyEvent {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  actor_email: string | null;
  created_at: string;
}
export interface CourtesyDetail {
  courtesy: Courtesy;
  created_by_email: string | null;
  events: CourtesyEvent[];
}

export interface BillingRecord {
  id: string;
  competence: string;
  courtesy_id: string;
  item_kind: "plan" | "module";
  module_code: string | null;
  description: string;
  original_cents: number;
  waived_cents: number;
  invoice_id: string | null;
  outcome: "waived_no_invoice" | "discounted_on_invoice";
}

// ---------------------------------------------------------------------------------------------------------------------------
// Disponibilidade das RPCs (o remoto pode ainda não ter as migrations de cortesia)
// ---------------------------------------------------------------------------------------------------------------------------
/** Erro de "função inexistente" do PostgREST/Postgres: a migration ainda não foi aplicada neste ambiente. */
export function isRpcMissing(error: { code?: string | null; message?: string | null; status?: number | null } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const msg = String(error.message ?? "").toLowerCase();
  return (
    code === "PGRST202" || // função não encontrada no cache do schema
    code === "42883" || // undefined_function
    error.status === 404 ||
    msg.includes("could not find the function") ||
    msg.includes("schema cache") ||
    (msg.includes("function") && msg.includes("does not exist"))
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
// Rótulos em PT-BR
// ---------------------------------------------------------------------------------------------------------------------------
export const COURTESY_STATE_TEXT: Record<CourtesyStatus, string> = {
  active: "Vigente",
  expired_pending_decision: "Vencida — aguardando decisão",
  ended: "Encerrada",
  converted: "Convertida em contratação",
};
export const COURTESY_STATE_TONE: Record<CourtesyStatus, Tone> = { active: "ok", expired_pending_decision: "bad", ended: "muted", converted: "muted" };

export const BRIDGE_STATE_TEXT: Record<BridgeState, string> = {
  active: "Ponte ativa (acesso temporário)",
  expired: "Ponte expirada sem pagamento",
  paid: "Paga — ponte encerrada",
  canceled: "Cancelada — ponte encerrada",
};
export const BRIDGE_STATE_TONE: Record<BridgeState, Tone> = { active: "warn", expired: "bad", paid: "ok", canceled: "muted" };

/** Modos de entitlement com texto próprio (somente exibição; o acesso é decidido no banco). */
export const ENTITLEMENT_MODE_TEXT: Record<string, string> = {
  courtesy: "Cortesia (acesso operacional)",
  payment_bridge: "Ponte de pagamento (acesso temporário)",
  subscription: "Assinatura",
  trial: "Período grátis",
  unmanaged: "Sem registro comercial",
  courtesy_pending_payment: "Cortesia preservada (outro plano aguarda pagamento)",
  pending_payment: "Aguardando pagamento",
  none: "Sem acesso",
};

/** Dados REAIS de apoio ao rótulo do estado de acesso (vêm das RPCs master_*; nada é deduzido só de write_blocked). */
export interface AccessLabelContext {
  /** Ponte 2C ativa da empresa (master_list_courtesy_bridges / master_get_courtesy_bridge), se houver. */
  bridge?: Pick<BridgeItem, "until_at" | "state"> | null;
  /** A consulta de pontes foi feita com sucesso? Sem ela não dá para distinguir ponte de cortesia preservada. */
  bridgesKnown?: boolean;
  /** Dado EXPLÍCITO do backend (lista de atenção preserved_pending_payment): a empresa está na janela F1. */
  preserved?: boolean;
}

/**
 * Estado de acesso (company_access_state) em PT-BR.
 * pending_payment com escrita liberada tem DUAS origens no banco, e o rótulo só afirma uma delas com dado real:
 *  - ponte 2C (conversão do MESMO plano): existe uma ponte ativa na lista de pontes -> mostra o PRAZO real;
 *  - F1 (cortesia original preservada enquanto OUTRO plano aguarda pagamento): consulta de pontes OK e nenhuma ponte ativa;
 *  - sem a consulta de pontes (RPC ausente/erro): texto neutro, sem afirmar nenhuma das duas.
 */
export function accessStateLabel(state: string, writeBlocked: boolean, base: Record<string, string>, ctx: AccessLabelContext = {}, fmtDate: (iso: string) => string = (s) => s): string {
  if (state === "courtesy") return "Cortesia (acesso operacional liberado)";
  if (state === "pending_payment" && !writeBlocked) {
    if (ctx.bridge && ctx.bridge.state === "active") return `Aguardando pagamento — ponte de acesso até ${fmtDate(ctx.bridge.until_at)}`;
    if (ctx.preserved || ctx.bridgesKnown) return "Aguardando pagamento — cortesia original preservada";
    return "Aguardando pagamento — escrita liberada";
  }
  return base[state] ?? state;
}

/** Índice das pontes ATIVAS por empresa (a lista do banco traz ativas e expiradas; só a ativa libera escrita). */
export function activeBridgeByCompany(bridges: Array<Pick<BridgeItem, "company_id" | "until_at" | "state">>): Record<string, Pick<BridgeItem, "until_at" | "state">> {
  const out: Record<string, Pick<BridgeItem, "until_at" | "state">> = {};
  for (const b of bridges) if (b && b.state === "active" && b.company_id) out[b.company_id] = { until_at: b.until_at, state: b.state };
  return out;
}

/** Avisos do prazo da ponte 2C (texto único, testável). */
export const BRIDGE_ACTIVE_WARNING = "Se o prazo vencer sem pagamento, a operação da empresa será bloqueada (a empresa volta ao bloqueio normal de assinatura aguardando pagamento).";

export const EVENT_TEXT: Record<string, string> = {
  granted: "Cortesia concedida",
  extended: "Cortesia prorrogada",
  ended: "Cortesia encerrada",
  expired: "Cortesia vencida (aguardando decisão)",
  conversion_requested: "Intenção de conversão registrada",
  conversion_authorized: "Conversão autorizada",
  converted: "Convertida em contratação",
};

export const SCOPE_TEXT: Record<CourtesyScope, string> = { plan: "Plano base", module: "Módulo" };

export const ATTENTION_FILTER_TEXT: Record<AttentionFilter, string> = {
  all: "Tudo que exige atenção",
  bridge_expired: "Pontes expiradas sem pagamento",
  expired_pending_decision: "Vencidas aguardando decisão",
  expiring_soon: "Vencem em até 7 dias",
  preserved_pending_payment: "Cortesia preservada aguardando pagamento",
};

// ---------------------------------------------------------------------------------------------------------------------------
// Item, urgência e prazos
// ---------------------------------------------------------------------------------------------------------------------------
interface NamedPlan { id: string; name: string }
interface NamedModule { code: string; name: string }

/** "Plano base — X" ou "Módulo — Y" (nome do catálogo; cai no código/identificador se o catálogo não carregou). */
export function itemLabel(c: Pick<Courtesy, "scope" | "plan_id" | "module_code">, plans: NamedPlan[], modules: NamedModule[]): string {
  if (c.scope === "plan") {
    const p = plans.find((x) => x.id === c.plan_id);
    return `Plano base — ${p?.name ?? "plano não identificado"}`;
  }
  const m = modules.find((x) => x.code === c.module_code);
  return `Módulo — ${m?.name ?? c.module_code ?? "não identificado"}`;
}

export interface Urgency {
  level: "critical" | "high" | "medium" | "low";
  label: string;
  tone: Tone;
}
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function urgencyOf(item: AttentionItem): Urgency {
  if (item.kind === "preserved_pending_payment") {
    // informativo (a F1 não tem teto): quanto mais tempo pendente, mais visível
    const d = Math.max(0, item.days_pending ?? 0);
    const label = d <= 0 ? "Contratação pendente desde hoje" : `Contratação pendente há ${plural(d, "dia", "dias")}`;
    if (d >= 30) return { level: "high", tone: "bad", label: `Alta — ${label.toLowerCase()}` };
    if (d >= 7) return { level: "medium", tone: "warn", label: `Média — ${label.toLowerCase()}` };
    return { level: "low", tone: "muted", label: `Baixa — ${label.toLowerCase()}` };
  }
  if (item.kind === "bridge_expired") {
    const h = item.hours_overdue ?? 0;
    return { level: "critical", tone: "bad", label: h > 0 ? `Crítica — ponte expirada há ${plural(h, "hora", "horas")}` : "Crítica — ponte expirada" };
  }
  if (item.kind === "expired_pending_decision") {
    const d = item.days_overdue ?? 0;
    return { level: "high", tone: "bad", label: d > 0 ? `Alta — vencida há ${plural(d, "dia", "dias")}` : "Alta — venceu hoje" };
  }
  const left = item.days_remaining ?? 0;
  if (left <= 1) return { level: "high", tone: "bad", label: left <= 0 ? "Alta — vence hoje" : "Alta — vence amanhã" };
  if (left <= 3) return { level: "medium", tone: "warn", label: `Média — vence em ${plural(left, "dia", "dias")}` };
  return { level: "low", tone: "muted", label: `Baixa — vence em ${plural(left, "dia", "dias")}` };
}

/** 125 -> "2 h 5 min"; 3000 -> "2 d 2 h"; < 1 min -> "menos de 1 min". */
export function fmtRemaining(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) return "menos de 1 min";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return mi > 0 ? `${h} h ${mi} min` : `${h} h`;
  return `${mi} min`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Leitura defensiva das respostas
// ---------------------------------------------------------------------------------------------------------------------------
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

export function parseCounters(raw: unknown): CourtesyCounters | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    within_days: num(r.within_days) || 7,
    expiring_soon: num(r.expiring_soon),
    expired_pending_decision: num(r.expired_pending_decision),
    expired_with_conversion_request: num(r.expired_with_conversion_request),
    bridges_expired_unpaid: num(r.bridges_expired_unpaid),
    bridges_active: num(r.bridges_active),
    bridges_ending_24h: num(r.bridges_ending_24h),
    preserved_pending_payment: "preserved_pending_payment" in r ? num(r.preserved_pending_payment) : null,
    preserved_pending_oldest_days: "preserved_pending_oldest_days" in r ? num(r.preserved_pending_oldest_days) : null,
  };
}

export function parseAttention(raw: unknown): AttentionPage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const items = Array.isArray(r.items) ? (r.items as AttentionItem[]).filter((i) => i && typeof i === "object" && "kind" in i) : [];
  return { total: num(r.total), limit: num(r.limit) || 20, offset: num(r.offset), items };
}

export function asList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

/** A chave da linha de atenção (cortesia e ponte têm ids próprios). */
// a F1 usa a assinatura pendente como chave: a MESMA cortesia pode aparecer também como vencida/a vencer (tipos distintos)
export const attentionKey = (i: AttentionItem): string => (i.kind === "bridge_expired" ? `b-${i.bridge_id}` : i.kind === "preserved_pending_payment" ? `p-${i.subscription_id}` : `c-${i.id}`);

/** Resumo por empresa para o selo da lista de empresas: cortesias vencidas, pontes Pix expiradas e as que vencem em breve. */
export interface CompanyFlags {
  expired: number;
  soon: number;
  bridge: number;
  preserved: number;
}
export function summarizeByCompany(items: AttentionItem[]): Record<string, CompanyFlags> {
  const out: Record<string, CompanyFlags> = {};
  for (const i of items) {
    const s = (out[i.company_id] ??= { expired: 0, soon: 0, bridge: 0, preserved: 0 });
    if (i.kind === "preserved_pending_payment") s.preserved += 1;
    else if (i.kind === "expiring_soon") s.soon += 1;
    else if (i.kind === "bridge_expired") s.bridge += 1;
    else s.expired += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Paginação
// ---------------------------------------------------------------------------------------------------------------------------
export interface PageInfo {
  from: number;
  to: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevOffset: number;
  nextOffset: number;
}
export function pageInfo(total: number, limit: number, offset: number): PageInfo {
  const lim = Math.max(1, limit);
  const off = Math.max(0, offset);
  const to = Math.min(total, off + lim);
  return {
    from: total === 0 ? 0 : off + 1,
    to,
    total,
    hasPrev: off > 0,
    hasNext: off + lim < total,
    prevOffset: Math.max(0, off - lim),
    nextOffset: off + lim,
  };
}

/** Texto curto de um evento do histórico (sem expor nada além do que a RPC já devolve). */
export function eventDetail(e: CourtesyEvent): string | null {
  const p = e.payload ?? {};
  const parts: string[] = [];
  if (typeof p.reason === "string" && p.reason) parts.push(p.reason);
  if (typeof p.note === "string" && p.note) parts.push(p.note);
  if (typeof p.bridge_hours === "number") parts.push(`ponte de ${p.bridge_hours} h`);
  if (typeof p.source === "string") parts.push(p.source === "billing_cycle" ? "ciclo diário" : "Master");
  return parts.length ? parts.join(" · ") : null;
}
