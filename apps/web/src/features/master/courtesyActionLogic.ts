// Regras PURAS das ações de encerrar / solicitar conversão / autorizar ou converter cortesia (sem React/Supabase). O frontend só ORIENTA
// (qual ação faz sentido, qual impacto esperar, quais campos pedir); quem decide é sempre o banco, cujo erro real é exibido.
//
// Assinaturas reais (migrations locais mais recentes):
//   master_end_courtesy(p_courtesy_id, p_reason, p_request_id, p_billing_starts)                          -- 20261118010000
//   master_request_courtesy_conversion(p_courtesy_id, p_note, p_request_id)                                -- 20261115010000
//   master_convert_courtesy(p_courtesy_id, p_note, p_billing_starts, p_request_id, p_bridge_hours)         -- 20261119010000
// A contratação paga NÃO é uma ação nova: usa o formulário "Contratar plano" já existente (master_subscribe_company).

import { addDaysISO, todaySP, validateReason } from "./courtesyFormLogic";
import type { Courtesy } from "./courtesyLogic";

export const BRIDGE_DEFAULT_HOURS = 72;
export const BRIDGE_MIN_HOURS = 24;
export const BRIDGE_MAX_HOURS = 168;
export const BRIDGE_HOURS_OPTIONS = [24, 48, 72, 96, 120, 144, 168];

/** Resumo da assinatura vigente da empresa (vem de master_get_company; só para orientar a tela). */
export interface SubInfo {
  status: string;
  planId: string;
  extraCodes: string[];
  includedCodes: string[];
}

export function subInfoFrom(sub: { status: string; plan: { id: string }; extra_modules: Array<{ code: string }>; included_modules: Array<{ code: string }> } | null | undefined): SubInfo | null {
  if (!sub) return null;
  return { status: sub.status, planId: sub.plan.id, extraCodes: sub.extra_modules.map((m) => m.code), includedCodes: sub.included_modules.map((m) => m.code) };
}

const OPEN = new Set(["active", "expired_pending_decision"]);
export const isOpenCourtesy = (c: Pick<Courtesy, "effective_state">): boolean => OPEN.has(c.effective_state);

// ---------------------------------------------------------------------------------------------------------------------------
// Qual conversão faz sentido (orientação; o banco recusa o que não valer)
// ---------------------------------------------------------------------------------------------------------------------------
export type ConversionMode = "authorize" | "convert_plan" | "convert_module" | "blocked";
export interface ConversionPlan {
  mode: ConversionMode;
  /** Texto do botão. */
  label: string;
  /** Quando bloqueado (ou como explicação do modo): o que fazer. */
  hint: string;
}

export function conversionPlan(c: Pick<Courtesy, "scope" | "plan_id" | "module_code" | "conversion_authorized_at">, sub: SubInfo | null): ConversionPlan {
  if (c.scope === "plan") {
    if (!sub) {
      return c.conversion_authorized_at
        ? { mode: "blocked", label: "Conversão autorizada", hint: "Já autorizada. Para contratar o plano pago, use \"Contratar plano\" (fluxo existente); a cortesia só é convertida na contratação." }
        : { mode: "authorize", label: "Autorizar conversão", hint: "Só autoriza: não cria assinatura, fatura, Pix nem cobrança. A empresa segue com o acesso da cortesia até o Master contratar o plano." };
    }
    if (sub.planId !== c.plan_id) return { mode: "blocked", label: "Converter", hint: "A assinatura atual é de outro plano: esta cortesia não a isenta. Encerre a cortesia." };
    if (sub.status === "pending_payment") return { mode: "blocked", label: "Converter", hint: "A cobrança inicial da assinatura ainda não foi paga. Pague-a antes de converter." };
    return { mode: "convert_plan", label: "Converter (retomar a cobrança)", hint: "Encerra a cortesia como convertida e a cobrança do plano volta na competência definida. Não cria Pix nem fatura agora." };
  }
  if (!sub) return { mode: "blocked", label: "Converter módulo", hint: "A empresa não tem assinatura: contrate o plano antes (a conversão não cria contratação)." };
  if (c.module_code && sub.includedCodes.includes(c.module_code)) return { mode: "blocked", label: "Converter módulo", hint: "O módulo já está incluído no plano da assinatura. Encerre a cortesia." };
  if (!c.module_code || !sub.extraCodes.includes(c.module_code)) return { mode: "blocked", label: "Converter módulo", hint: "Adicione primeiro o módulo como extra da assinatura (Alterar módulos). A conversão não ativa módulo pago nem gera Pix proporcional." };
  if (!["active", "grace", "past_due"].includes(sub.status)) return { mode: "blocked", label: "Converter módulo", hint: "A assinatura não está em um estado que aceite a conversão do módulo." };
  return { mode: "convert_module", label: "Converter módulo", hint: "O módulo já é extra da assinatura: a conversão só marca a decisão e define quando a cobrança começa. Não ativa módulo pago nem gera Pix proporcional." };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Início da cobrança (competência) e prazo da ponte
// ---------------------------------------------------------------------------------------------------------------------------
/** AAAA-MM (campo month) -> AAAA-MM-01; vazio -> null. */
export function monthToDate(month: string): string | null {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? `${month}-01` : null;
}

/** Competência opcional: a partir do mês corrente (SP), no máximo 24 meses à frente. O piso real (primeira competência ainda não decidida) é do banco. */
export function validateBillingStart(month: string, now: Date): string | null {
  if (!month) return null;
  const d = monthToDate(month);
  if (!d) return "Competência inválida.";
  const today = todaySP(now);
  const cur = `${today.slice(0, 7)}-01`;
  if (d < cur) return "O início da cobrança não pode ser anterior ao mês atual (nada é cobrado retroativamente).";
  const max = addDaysISO(cur, 24 * 31);
  if (d > max.slice(0, 7) + "-01") return "O início da cobrança pode ser no máximo 24 meses à frente.";
  return null;
}

export function validateBridgeHours(h: number): string | null {
  return Number.isInteger(h) && h >= BRIDGE_MIN_HOURS && h <= BRIDGE_MAX_HOURS ? null : `O prazo da ponte deve estar entre ${BRIDGE_MIN_HOURS} e ${BRIDGE_MAX_HOURS} horas.`;
}

export const validateNote = validateReason; // mesmas regras do banco (3 a 200 caracteres) para motivo/nota

// ---------------------------------------------------------------------------------------------------------------------------
// Impacto esperado de ENCERRAR (estimativa para o Master; o banco confirma com avisos ao executar)
// ---------------------------------------------------------------------------------------------------------------------------
export interface Impact {
  /** true = o acesso termina na hora; "maybe" = depende de override/contrato que o painel não enxerga; false = não corta acesso. */
  accessEndsNow: boolean | "maybe";
  lines: string[];
}

export function endImpact(c: Pick<Courtesy, "scope" | "plan_id" | "module_code">, sub: SubInfo | null): Impact {
  const lines: string[] = [];
  if (c.scope === "plan") {
    if (!sub) {
      lines.push("O acesso operacional da empresa termina IMEDIATAMENTE: ela volta ao estado anterior à cortesia (somente leitura, se o período grátis já acabou).");
      lines.push("Para manter o acesso sem corte, use Autorizar conversão e depois contrate o plano.");
      return { accessEndsNow: true, lines };
    }
    if (sub.planId !== c.plan_id) {
      lines.push("Esta cortesia não isentava o plano atual da assinatura: a cobrança e o acesso não mudam.");
      return { accessEndsNow: false, lines };
    }
    lines.push("As próximas mensalidades deixam de ser isentas a partir da competência definida abaixo; faturas já emitidas não mudam.");
    return { accessEndsNow: false, lines };
  }
  const code = c.module_code ?? "";
  if (sub && (sub.includedCodes.includes(code) || sub.extraCodes.includes(code))) {
    lines.push(sub.extraCodes.includes(code)
      ? "O módulo continua pelo contrato (extra da assinatura) e volta a ser cobrado a partir da competência definida abaixo."
      : "O módulo está incluído no plano da assinatura e continua disponível.");
    return { accessEndsNow: false, lines };
  }
  lines.push("O módulo não está contratado: o acesso a ele termina IMEDIATAMENTE, a menos que exista uma concessão (override) ativa, que o painel não mostra aqui.");
  return { accessEndsNow: "maybe", lines };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Payloads EXATOS (só os parâmetros relevantes)
// ---------------------------------------------------------------------------------------------------------------------------
export function buildEndArgs(courtesyId: string, reason: string, billingStartsMonth: string, requestId: string): Record<string, unknown> {
  const args: Record<string, unknown> = { p_courtesy_id: courtesyId, p_reason: reason.trim(), p_request_id: requestId };
  const d = monthToDate(billingStartsMonth);
  if (d) args.p_billing_starts = d;
  return args;
}

export function buildRequestArgs(courtesyId: string, note: string, requestId: string): Record<string, unknown> {
  return { p_courtesy_id: courtesyId, p_note: note.trim(), p_request_id: requestId };
}

/** authorize: só o prazo da ponte (sem início de cobrança). convert_*: só o início de cobrança opcional (sem prazo de ponte). */
export function buildConvertArgs(courtesyId: string, note: string, mode: Exclude<ConversionMode, "blocked">, opts: { billingStartsMonth?: string; bridgeHours?: number }, requestId: string): Record<string, unknown> {
  const args: Record<string, unknown> = { p_courtesy_id: courtesyId, p_note: note.trim(), p_request_id: requestId };
  if (mode === "authorize") args.p_bridge_hours = opts.bridgeHours ?? BRIDGE_DEFAULT_HOURS;
  else {
    const d = monthToDate(opts.billingStartsMonth ?? "");
    if (d) args.p_billing_starts = d;
  }
  return args;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------------------------------------------------------
export interface EndResult {
  changed: boolean;
  replayed: boolean;
  billingStarts: string | null;
  warnings: string[];
}
export interface RequestResult {
  changed: boolean;
  replayed: boolean;
}
export interface ConvertResult {
  changed: boolean;
  replayed: boolean;
  converted: boolean;
  authorized: boolean;
  bridgeHours: number | null;
  billingStarts: string | null;
}

const obj = (raw: unknown): Record<string, unknown> | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);

export function parseEndResult(raw: unknown): EndResult | null {
  const r = obj(raw);
  if (!r || typeof r.changed !== "boolean" || !r.courtesy) return null;
  return {
    changed: r.changed,
    replayed: r.replayed === true,
    billingStarts: typeof r.billing_starts_competence === "string" ? r.billing_starts_competence : null,
    warnings: Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [],
  };
}
export function parseRequestResult(raw: unknown): RequestResult | null {
  const r = obj(raw);
  if (!r || typeof r.changed !== "boolean" || !r.courtesy) return null;
  return { changed: r.changed, replayed: r.replayed === true };
}
export function parseConvertResult(raw: unknown): ConvertResult | null {
  const r = obj(raw);
  if (!r || typeof r.changed !== "boolean" || !r.courtesy) return null;
  return {
    changed: r.changed,
    replayed: r.replayed === true,
    converted: r.converted === true,
    authorized: r.authorized === true,
    bridgeHours: typeof r.bridge_hours === "number" ? r.bridge_hours : null,
    billingStarts: typeof r.billing_starts_competence === "string" ? r.billing_starts_competence : null,
  };
}

export const END_WARNING_TEXT: Record<string, string> = {
  access_ends_immediately_no_subscription: "O acesso operacional da empresa terminou agora (sem assinatura, ela voltou ao estado anterior).",
  courtesy_was_not_exempting_current_plan: "Esta cortesia não isentava o plano atual da assinatura: a cobrança não mudou.",
  module_access_ends: "O acesso ao módulo terminou agora (ele não está contratado e não há concessão ativa).",
};

const fmtCompetence = (d: string): string => `${d.slice(5, 7)}/${d.slice(0, 4)}`;

export interface Message {
  tone: "ok" | "info";
  text: string;
}
export function endResultMessage(r: EndResult): Message {
  if (r.replayed) return { tone: "info", text: "Este encerramento já havia sido registrado (envio repetido). Nada foi duplicado." };
  if (!r.changed) return { tone: "info", text: "A cortesia já estava encerrada; nada foi alterado." };
  return { tone: "ok", text: r.billingStarts ? `Cortesia encerrada. A cobrança volta a seguir o contrato a partir de ${fmtCompetence(r.billingStarts)}; nada é cobrado retroativamente.` : "Cortesia encerrada. Nenhuma cobrança foi criada." };
}
export function requestResultMessage(r: RequestResult): Message {
  if (r.replayed) return { tone: "info", text: "Este pedido já havia sido registrado (envio repetido). Nada foi duplicado." };
  if (!r.changed) return { tone: "info", text: "Já existe um pedido de conversão registrado para esta cortesia; nada foi alterado." };
  return { tone: "ok", text: "Pedido de conversão registrado. É só um registro: não autoriza nada, não cria assinatura e não altera acesso nem cobrança." };
}
export function convertResultMessage(r: ConvertResult): Message {
  if (r.replayed) return { tone: "info", text: "Esta decisão já havia sido registrada (envio repetido). Nada foi duplicado." };
  if (!r.changed) return { tone: "info", text: "Nada foi alterado: a cortesia já estava nesse estado." };
  if (r.authorized && !r.converted) {
    return {
      tone: "ok",
      text: `Conversão autorizada${r.bridgeHours ? ` (ponte de acesso de ${r.bridgeHours} h na contratação)` : ""}. Nenhuma assinatura, fatura, Pix ou cobrança foi criada: a empresa segue com o acesso da cortesia. Para contratar o plano pago, use "Contratar plano" abaixo.`,
    };
  }
  return { tone: "ok", text: r.billingStarts ? `Cortesia convertida. A cobrança passa a valer a partir de ${fmtCompetence(r.billingStarts)}. Nenhum Pix foi gerado agora.` : "Cortesia convertida." };
}

/** Prazo da ponte registrado na autorização (evento conversion_authorized do histórico), em horas. */
export function bridgeHoursFromEvents(events: Array<{ event_type: string; payload: Record<string, unknown> }>): number | null {
  const e = events.find((x) => x.event_type === "conversion_authorized");
  const h = e?.payload?.bridge_hours;
  return typeof h === "number" ? h : null;
}

/** A contratação pelo fluxo existente só faz sentido para cortesia de plano autorizada e sem assinatura vigente. */
export function canStartContract(c: Pick<Courtesy, "scope" | "plan_id" | "conversion_authorized_at" | "effective_state">, sub: SubInfo | null): boolean {
  return c.scope === "plan" && !!c.plan_id && !!c.conversion_authorized_at && isOpenCourtesy(c) && sub === null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// F1 (migration 20261121010000): cortesia original PRESERVADA enquanto OUTRO plano aguarda pagamento
// ---------------------------------------------------------------------------------------------------------------------------
export interface PreservedWindow {
  courtesy: Courtesy;
  pendingPlanId: string;
  openModuleCourtesies: number;
}

/**
 * Orienta a tela (a AUTORIDADE é o banco: company_write_blocked / company_entitlement). Usa SÓ dados reais já lidos das RPCs:
 * assinatura vigente (master_get_company), cortesias abertas (master_list_company_courtesies) e pontes (master_get_courtesy_bridge).
 * Espelha a regra do banco: assinatura em pending_payment + cortesia de PLANO aberta de plano DIFERENTE + nenhuma ponte ativa.
 * `bridges === null` = consulta de pontes indisponível: sem ela não se afirma nada (devolve null).
 */
export function preservedWindow(courtesies: Courtesy[], sub: SubInfo | null, bridges: Array<{ state: string }> | null): PreservedWindow | null {
  if (!sub || sub.status !== "pending_payment" || bridges === null) return null;
  if (bridges.some((b) => b.state === "active")) return null; // a ponte 2C tem prioridade
  const open = courtesies.filter(isOpenCourtesy);
  const plan = open.find((c) => c.scope === "plan" && !!c.plan_id && c.plan_id !== sub.planId);
  if (!plan) return null;
  return { courtesy: plan, pendingPlanId: sub.planId, openModuleCourtesies: open.filter((c) => c.scope === "module").length };
}

export interface PreservedNotice {
  title: string;
  lines: string[];
}
/** Texto do aviso do Painel Master. NÃO fala em prazo de ponte: não existe prazo adicional; vale enquanto a cortesia estiver aberta. */
export function preservedNotice(w: PreservedWindow, names: { pendingPlan: string; courtesyItem: string }): PreservedNotice {
  const expired = w.courtesy.effective_state === "expired_pending_decision";
  return {
    title: "Cortesia original preservada enquanto outro plano aguarda pagamento",
    lines: [
      `O plano “${names.pendingPlan}” foi contratado e a fatura inicial ainda não foi paga. Enquanto isso a empresa mantém SOMENTE o acesso da cortesia “${names.courtesyItem}”`
        + `${w.openModuleCourtesies === 0 ? "" : w.openModuleCourtesies === 1 ? ", da cortesia de módulo aberta" : `, das ${w.openModuleCourtesies} cortesias de módulo abertas`} e dos overrides válidos. Nenhum módulo do plano contratado é liberado antes do pagamento.`,
      expired
        ? "A cortesia está vencida aguardando decisão: o acesso continua, sem prazo adicional, até você decidir (encerrar, prorrogar ou converter)."
        : "Não há prazo de ponte: o acesso vale enquanto a cortesia estiver aberta (vigente ou vencida aguardando decisão).",
      "Termina ao pagar a fatura inicial (passa a valer o plano contratado), ao cancelar a contratação pendente (volta o acesso normal da cortesia) ou ao encerrar a cortesia (a empresa fica bloqueada até o pagamento).",
    ],
  };
}
