// Regras PURAS dos formulários de conceder/prorrogar cortesia (sem React/Supabase). As validações aqui espelham as do banco apenas para
// avisar cedo e evitar viagem inútil; a AUTORIDADE é o banco (master_grant_courtesy / master_extend_courtesy), cujo erro real é sempre
// mostrado. Fuso comercial fixo: America/Sao_Paulo (sem horário de verão desde 2019, UTC-03:00).

export type GrantScope = "plan" | "module";
export type DurationChoice = "30" | "60" | "90" | "custom";

export interface GrantForm {
  scope: GrantScope;
  planId: string;
  moduleCode: string;
  duration: DurationChoice;
  /** AAAA-MM-DD (só usado quando duration === "custom") */
  endDate: string;
  reason: string;
}

export const EMPTY_GRANT_FORM: GrantForm = { scope: "module", planId: "", moduleCode: "", duration: "30", endDate: "", reason: "" };

export const REASON_MIN = 3;
export const REASON_MAX = 200;
/** Prazo máximo aceito pelo banco: até 1095 dias à frente. */
export const MAX_DAYS_AHEAD = 1095;
export const DURATION_OPTIONS: Array<{ value: DurationChoice; label: string }> = [
  { value: "30", label: "30 dias" },
  { value: "60", label: "60 dias" },
  { value: "90", label: "90 dias" },
  { value: "custom", label: "Data personalizada" },
];

/** Aviso fixo exibido na seção e nos formulários (regra de negócio: decisão sempre manual). */
export const EXPIRY_NOTICE =
  "O vencimento não encerra o acesso nem inicia cobrança: a cortesia vencida continua valendo até uma decisão manual do Master (prorrogar, encerrar ou converter).";
export const NO_BILLING_NOTICE = "Conceder cortesia não cria assinatura, fatura, Pix nem cobrança.";

// ---------------------------------------------------------------------------------------------------------------------------
// Datas (America/Sao_Paulo)
// ---------------------------------------------------------------------------------------------------------------------------
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Dia de hoje em São Paulo, AAAA-MM-DD. */
export function todaySP(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isValidISODate(iso: string): boolean {
  if (!ISO_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Instante em que a data deixa de valer: início do dia SEGUINTE em São Paulo (o banco usa o fim do dia escolhido). */
export function endOfDayInstantSP(iso: string): Date {
  return new Date(`${addDaysISO(iso, 1)}T00:00:00-03:00`);
}

/** AAAA-MM-DD -> DD/MM/AAAA (sem passar por Date: nunca desloca o dia). */
export function fmtISO(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Último dia (SP) em que o vencimento ainda vale: o dia do instante menos 1 ms (vencimento à meia-noite pertence ao dia anterior). */
export function lastDayOfInstantSP(instantIso: string): string {
  return todaySP(new Date(new Date(instantIso).getTime() - 1));
}

/** Menor data final que o formulário de prorrogação aceita: depois do vencimento atual e nunca no passado. */
export function minExtendDate(currentEndsAtIso: string, now: Date): string {
  let candidate = lastDayOfInstantSP(currentEndsAtIso);
  if (endOfDayInstantSP(candidate).getTime() <= new Date(currentEndsAtIso).getTime()) candidate = addDaysISO(candidate, 1);
  const today = todaySP(now);
  return candidate > today ? candidate : today;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Validações
// ---------------------------------------------------------------------------------------------------------------------------
export function validateReason(text: string): string | null {
  const n = text.trim().length;
  if (n < REASON_MIN) return `Informe o motivo (de ${REASON_MIN} a ${REASON_MAX} caracteres).`;
  if (n > REASON_MAX) return `O motivo pode ter no máximo ${REASON_MAX} caracteres (agora ${n}).`;
  return null;
}

/** Data final personalizada: válida, de hoje até hoje + 1094 dias (o fim do dia escolhido tem de caber nos 1095 dias do banco). */
export function validateEndDate(iso: string, now: Date, mustEndAfterInstant?: string | null): string | null {
  if (!iso) return "Informe a data final.";
  if (!isValidISODate(iso)) return "Data inválida.";
  const today = todaySP(now);
  if (iso < today) return "A data final não pode estar no passado.";
  if (iso > addDaysISO(today, MAX_DAYS_AHEAD - 1)) return `A data final pode ser no máximo ${MAX_DAYS_AHEAD} dias à frente.`;
  if (mustEndAfterInstant && endOfDayInstantSP(iso).getTime() <= new Date(mustEndAfterInstant).getTime()) {
    return `A nova data deve ser posterior ao vencimento atual (${fmtISO(lastDayOfInstantSP(mustEndAfterInstant))}).`;
  }
  return null;
}

export interface OpenItem {
  scope: GrantScope;
  plan_id: string | null;
  module_code: string | null;
  status: string;
}
const isOpen = (c: OpenItem): boolean => c.status === "active" || c.status === "expired_pending_decision";

/** Já existe cortesia ABERTA (vigente ou vencida aguardando decisão) deste item? */
export function hasOpenCourtesy(list: OpenItem[], scope: GrantScope, key: string): boolean {
  return list.some((c) => isOpen(c) && c.scope === scope && (scope === "plan" ? c.plan_id === key : c.module_code === key));
}
export function hasOpenPlanCourtesy(list: OpenItem[]): boolean {
  return list.some((c) => isOpen(c) && c.scope === "plan");
}

export interface GrantContext {
  now: Date;
  open: OpenItem[];
}

export interface GrantErrors {
  item?: string;
  duration?: string;
  endDate?: string;
  reason?: string;
}

export function validateGrant(f: GrantForm, ctx: GrantContext): GrantErrors {
  const e: GrantErrors = {};
  if (f.scope === "plan") {
    if (!f.planId) e.item = "Escolha o plano.";
    else if (hasOpenCourtesy(ctx.open, "plan", f.planId)) e.item = "Este plano já tem cortesia aberta: use Prorrogar.";
  } else {
    if (!f.moduleCode) e.item = "Escolha o módulo.";
    else if (hasOpenCourtesy(ctx.open, "module", f.moduleCode)) e.item = "Este módulo já tem cortesia aberta: use Prorrogar.";
  }
  if (f.duration === "custom") {
    const d = validateEndDate(f.endDate, ctx.now);
    if (d) e.endDate = d;
  }
  const r = validateReason(f.reason);
  if (r) e.reason = r;
  return e;
}
export const hasErrors = (e: object): boolean => Object.keys(e).length > 0;

// ---------------------------------------------------------------------------------------------------------------------------
// Payloads EXATOS das RPCs (assinaturas auditadas em 20261115010000_company_courtesies.sql)
//   master_grant_courtesy(p_company_id, p_scope, p_reason, p_module_code, p_plan_id, p_days, p_end_date, p_request_id)
//   master_extend_courtesy(p_courtesy_id, p_reason, p_days, p_end_date, p_request_id)
// Só os parâmetros relevantes são enviados (os demais ficam no default do banco).
// ---------------------------------------------------------------------------------------------------------------------------
export function buildGrantArgs(companyId: string, f: GrantForm, requestId: string): Record<string, unknown> {
  const args: Record<string, unknown> = { p_company_id: companyId, p_scope: f.scope, p_reason: f.reason.trim(), p_request_id: requestId };
  if (f.scope === "plan") args.p_plan_id = f.planId;
  else args.p_module_code = f.moduleCode;
  if (f.duration === "custom") args.p_end_date = f.endDate;
  else args.p_days = Number(f.duration);
  return args;
}

export function buildExtendArgs(courtesyId: string, endDate: string, reason: string, requestId: string): Record<string, unknown> {
  return { p_courtesy_id: courtesyId, p_reason: reason.trim(), p_end_date: endDate, p_request_id: requestId };
}

export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // fallback v4 (ambientes sem randomUUID)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Resumo antes de confirmar
// ---------------------------------------------------------------------------------------------------------------------------
export interface SummaryLine {
  label: string;
  value: string;
}
export function grantEndText(f: GrantForm, now: Date): string {
  if (f.duration === "custom") return f.endDate && isValidISODate(f.endDate) ? `até o fim de ${fmtISO(f.endDate)} (horário de Brasília)` : "—";
  const end = new Date(now.getTime() + Number(f.duration) * 86_400_000);
  return `${f.duration} dias, até ${end.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export function grantSummary(f: GrantForm, companyName: string, itemName: string, now: Date): SummaryLine[] {
  return [
    { label: "Empresa", value: companyName },
    { label: "Tipo", value: f.scope === "plan" ? "Plano base" : "Módulo" },
    { label: "Item", value: itemName },
    { label: "Duração", value: grantEndText(f, now) },
    { label: "Motivo", value: f.reason.trim() },
  ];
}

/** O que a cortesia faz de verdade, por escopo (texto de orientação; o banco é quem aplica). */
export function scopeEffectText(scope: GrantScope): string {
  return scope === "plan"
    ? "Cortesia de plano base: sem assinatura vigente, dá acesso operacional e os módulos incluídos no plano; com assinatura do MESMO plano, isenta as próximas mensalidades do plano. Não isenta outro plano."
    : "Cortesia de módulo: dá acesso somente a este módulo e isenta só ele enquanto houver assinatura. Não concede módulos relacionados e não afeta os demais.";
}

export const WARNING_TEXT: Record<string, string> = {
  company_has_active_subscription: "A empresa tem assinatura vigente: a cortesia não altera a assinatura nem faturas já emitidas.",
  module_already_in_subscription: "O módulo já faz parte da assinatura contratada.",
  plan_already_in_subscription: "O plano já é o da assinatura: as próximas mensalidades desse plano ficam isentas; faturas já emitidas não mudam.",
  module_override_active: "Existe uma concessão (override) ativa para este módulo; ela continua independente da cortesia.",
};

// ---------------------------------------------------------------------------------------------------------------------------
// Resultado das RPCs
// ---------------------------------------------------------------------------------------------------------------------------
export interface GrantResult {
  created: boolean;
  replayed: boolean;
  warnings: string[];
}
export interface ExtendResult {
  changed: boolean;
  replayed: boolean;
}

export function parseGrantResult(raw: unknown): GrantResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.created !== "boolean" || !r.courtesy) return null;
  return { created: r.created, replayed: r.replayed === true, warnings: Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [] };
}
export function parseExtendResult(raw: unknown): ExtendResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.changed !== "boolean" || !r.courtesy) return null;
  return { changed: r.changed, replayed: r.replayed === true };
}

export function grantResultMessage(r: GrantResult): { tone: "ok" | "info"; text: string } {
  if (r.replayed) return { tone: "info", text: "Esta concessão já havia sido registrada (envio repetido). Nada foi duplicado." };
  if (!r.created) return { tone: "info", text: "Esta empresa já tinha cortesia aberta para este item; nada foi alterado. Use Prorrogar para mudar o prazo." };
  return { tone: "ok", text: "Cortesia concedida. Nenhuma assinatura, fatura, Pix ou cobrança foi criada." };
}
export function extendResultMessage(r: ExtendResult): { tone: "ok" | "info"; text: string } {
  if (r.replayed) return { tone: "info", text: "Esta prorrogação já havia sido registrada (envio repetido). Nada foi duplicado." };
  if (!r.changed) return { tone: "info", text: "A cortesia já termina nessa data; nada foi alterado." };
  return { tone: "ok", text: "Cortesia prorrogada. Nenhuma cobrança foi criada." };
}

/** Planos selecionáveis: tudo do catálogo, menos o registro reservado do período grátis. */
export function selectablePlans<T extends { code: string }>(plans: T[], reservedCode: string | null | undefined): T[] {
  return plans.filter((p) => !reservedCode || p.code !== reservedCode);
}

/** Cortesia aberta pode ser prorrogada (vigente ou vencida aguardando decisão). */
export const canExtend = (c: { effective_state: string }): boolean => c.effective_state === "active" || c.effective_state === "expired_pending_decision";
