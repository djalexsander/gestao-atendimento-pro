// Regras PURAS da camada comercial do frontend (sem React, sem Supabase): estados de acesso, texto do banner,
// tratamento do PT402 (somente leitura), totais da contratação e estados da tela de pagamento. Testável à parte.
// A AUTORIDADE é sempre o banco (guard_company_writable / RPCs tenant_*); nada aqui é segurança.

// Estados devolvidos por tenant_get_access_state (company_access_state no banco). Nenhum estado novo foi inventado.
export type AccessStateName =
  | "active"
  | "grace"
  | "past_due"
  | "pending_payment"
  | "restricted"
  | "suspended"
  | "trial"
  | "trial_expired"
  | "trial_canceled"
  | "canceled"
  | "unmanaged";

export interface AccessInfo {
  state: AccessStateName;
  write_blocked: boolean;
  is_owner: boolean;
  trial_ends_at: string | null; // só no trial
  grace_until: string | null; // AAAA-MM-DD, último dia com escrita normal
  restriction_from: string | null; // AAAA-MM-DD, primeiro dia somente leitura
}

export const READ_ONLY_MESSAGE = "Esta empresa está em modo somente leitura por causa da assinatura.";
export const BILLING_PATH = "/app/configuracoes/meus-planos";
export const READ_ONLY_EVENT = "gap:read-only";

// --- PT402 ------------------------------------------------------------------------------------------------------------

/** O PostgREST devolve o errcode PT402 da barreira de escrita como HTTP 402 com { code: "PT402", ... }. */
export function isReadOnlyCode(code: unknown): boolean {
  return code === "PT402";
}

/** Reescreve o corpo de erro do PostgREST com a mensagem amigável (mantém code/status para quem precisar). */
export function friendlyReadOnlyBody(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !isReadOnlyCode(parsed.code)) return null;
    return JSON.stringify({ ...parsed, message: READ_ONLY_MESSAGE, details: null, hint: null });
  } catch {
    return null;
  }
}

/**
 * Embrulha o fetch do cliente Supabase: respostas PT402 viram a mensagem amigável (TODAS as telas passam a mostrá-la
 * sem tratamento próprio) e avisam o estado comercial global. Outras respostas passam intactas.
 */
export function wrapFetchForReadOnly(base: typeof fetch, onReadOnly: () => void): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 402) return response;
    let raw: string;
    try {
      raw = await response.clone().text();
    } catch {
      return response;
    }
    const friendly = friendlyReadOnlyBody(raw);
    if (friendly === null) return response;
    try {
      onReadOnly();
    } catch {
      // aviso é só conveniência
    }
    return new Response(friendly, { status: 402, statusText: response.statusText, headers: response.headers });
  };
}

// --- Estado e banner -----------------------------------------------------------------------------------------------------

export const BLOCKED_STATES: readonly AccessStateName[] = [
  "pending_payment", "restricted", "suspended", "trial_expired", "trial_canceled", "canceled",
];
export const isReadOnlyState = (state: AccessStateName | null | undefined): boolean =>
  state != null && BLOCKED_STATES.includes(state);

export const ACCESS_STATE_LABEL: Record<AccessStateName, string> = {
  active: "Ativa",
  grace: "Em carência (pagamento em atraso)",
  past_due: "Pagamento em atraso",
  pending_payment: "Aguardando pagamento",
  restricted: "Restrita (somente leitura)",
  suspended: "Suspensa (somente leitura)",
  trial: "Período grátis",
  trial_expired: "Período grátis encerrado",
  trial_canceled: "Período grátis cancelado",
  canceled: "Assinatura cancelada",
  unmanaged: "Sem assinatura (acesso liberado)",
};

export type BannerTone = "info" | "warn" | "danger";
export interface Banner {
  tone: BannerTone;
  text: string;
  // mostra a ação "Regularizar assinatura" (só o owner pode agir; os demais recebem o aviso para falar com ele)
  action: boolean;
}

/** "AAAA-MM-DD" -> "DD/MM" (pela própria string: nunca desloca o dia por fuso). */
export function fmtDayMonth(dateOnly: string | null): string {
  if (!dateOnly) return "";
  const [, m, d] = dateOnly.slice(0, 10).split("-");
  return `${d}/${m}`;
}

/** Dias restantes do trial (arredonda para cima; nunca negativo). */
export function trialDaysLeft(endsAt: string | null, now: Date): number | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function bannerFor(info: AccessInfo | null, now: Date): Banner | null {
  if (!info) return null;
  const action = info.is_owner;
  switch (info.state) {
    case "trial": {
      const days = trialDaysLeft(info.trial_ends_at, now);
      const text = days === null ? "Período grátis em andamento."
        : days <= 1 ? "Período grátis: último dia." : `Período grátis: ${days} dias restantes.`;
      return { tone: "info", text, action };
    }
    case "pending_payment":
      return { tone: "warn", text: "Pagamento necessário para liberar a operação.", action };
    case "grace":
    case "past_due": {
      const until = fmtDayMonth(info.grace_until);
      return {
        tone: "warn",
        text: until ? `Pagamento em atraso — regularize até ${until} para evitar bloqueio.` : "Pagamento em atraso — regularize para evitar bloqueio.",
        action,
      };
    }
    case "restricted":
      return { tone: "danger", text: "Empresa em modo somente leitura. Regularize a assinatura para continuar operando.", action };
    case "suspended":
      return { tone: "danger", text: "Assinatura suspensa: a empresa está em modo somente leitura. Fale com o suporte.", action: false };
    case "trial_expired":
      return { tone: "danger", text: "Período grátis encerrado: a empresa está em modo somente leitura. Contrate um plano para voltar a operar.", action };
    case "trial_canceled":
      return { tone: "danger", text: "Período grátis cancelado: a empresa está em modo somente leitura. Fale com o suporte.", action: false };
    case "canceled":
      return { tone: "danger", text: "Assinatura cancelada: a empresa está em modo somente leitura. Contrate novamente para operar.", action };
    default:
      return null; // active e unmanaged: nenhum alerta comercial
  }
}

/** Aviso para quem não é owner: o banner só informa, a ação é do proprietário. */
export const NON_OWNER_HINT = "Peça ao proprietário da empresa para regularizar.";

// --- Contratação ---------------------------------------------------------------------------------------------------------

export interface CatalogPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  included_module_codes: string[];
}
export interface CatalogModule {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
}
export interface Catalog {
  plans: CatalogPlan[];
  modules: CatalogModule[];
}

/** O plano que o cliente contrata: o "base" do catálogo; na falta, o mais barato. Nunca o reservado de trial. */
export function pickContractPlan(catalog: Catalog): CatalogPlan | null {
  const plans = catalog.plans.filter((p) => p.code !== "trial");
  return plans.find((p) => p.code === "base") ?? [...plans].sort((a, b) => a.monthly_price_cents - b.monthly_price_cents)[0] ?? null;
}

/** Módulos que podem ser escolhidos à parte (os já incluídos no plano ficam de fora). */
export function selectableModules(catalog: Catalog, plan: CatalogPlan | null): CatalogModule[] {
  if (!plan) return [];
  return catalog.modules.filter((m) => !plan.included_module_codes.includes(m.code));
}

export function monthlyTotalCents(plan: CatalogPlan | null, modules: CatalogModule[], selected: readonly string[]): number {
  if (!plan) return 0;
  const set = new Set(selected);
  return plan.monthly_price_cents + modules.filter((m) => set.has(m.id)).reduce((sum, m) => sum + m.monthly_price_cents, 0);
}

/** "Completo" NÃO é plano do banco: é só a soma comercial do plano base com todos os módulos opcionais. */
export function fullBundleCents(plan: CatalogPlan | null, modules: CatalogModule[]): number {
  return monthlyTotalCents(plan, modules, modules.map((m) => m.id));
}

/** Dia do mês (1..31) em São Paulo: o vencimento mensal é ancorado no dia da contratação. */
export function contractDayInSaoPaulo(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", day: "numeric" }).format(now));
}

// --- Pagamento -----------------------------------------------------------------------------------------------------------

export interface InvoicePayment {
  invoice: { id: string; kind: "initial" | "recurring" | "module_addition"; due_date: string; amount_cents: number; status: string };
  payment:
    | null
    | { state: "not_created" | "creating" | "paid_awaiting_settlement" | "under_review" }
    | {
        state: "ready";
        status: string;
        invoice_url: string | null;
        pix_payload: string | null;
        pix_qr: string | null;
        gateway_due_date: string;
        amount_cents: number;
      };
}

export type PaymentView = "paid" | "void" | "ready" | "generating" | "settling" | "review";

/** O que a tela de pagamento mostra. Fatura aberta sem Pix = "gerando" (a criação é assíncrona e recuperável). */
export function paymentView(p: InvoicePayment | null): PaymentView | null {
  if (!p) return null;
  if (p.invoice.status === "paid") return "paid";
  if (p.invoice.status === "void") return "void";
  if (!p.payment) return null;
  switch (p.payment.state) {
    case "ready": return "ready";
    case "paid_awaiting_settlement": return "settling";
    case "under_review": return "review";
    default: return "generating";
  }
}

/** Atualização automática enquanto algo pode mudar (Pix sendo gerado ou aguardando pagamento). */
export function pollIntervalMs(view: PaymentView | null): number | null {
  if (view === "generating" || view === "settling") return 4000;
  if (view === "ready") return 8000;
  return null;
}

export function pixImageSrc(qr: string | null): string | null {
  if (!qr) return null;
  return qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`;
}

export const INVOICE_STATUS_TEXT: Record<string, string> = {
  open: "Em aberto",
  overdue: "Vencida",
  paid: "Paga",
  void: "Anulada",
};
export const INVOICE_KIND_TEXT: Record<string, string> = { initial: "Contratação", recurring: "Mensalidade", module_addition: "Módulos adicionais" };

// --- Meus Planos (autogestão comercial da empresa) -------------------------------------------------------------------

export type ChipTone = "info" | "ok" | "warn" | "danger" | "muted";

/** Rótulo visual do estado REAL do backend (nada inventado). */
export function planChip(state: AccessStateName | null | undefined): { label: string; tone: ChipTone } {
  switch (state) {
    case "trial": return { label: "Trial", tone: "info" };
    case "pending_payment": return { label: "Aguardando pagamento", tone: "warn" };
    case "active": return { label: "Ativo", tone: "ok" };
    case "grace":
    case "past_due": return { label: "Em carência", tone: "warn" };
    case "restricted":
    case "suspended":
    case "trial_expired":
    case "trial_canceled": return { label: "Somente leitura", tone: "danger" };
    case "canceled": return { label: "Cancelado", tone: "muted" };
    case "unmanaged": return { label: "Sem assinatura", tone: "muted" };
    default: return { label: "…", tone: "muted" };
  }
}

export interface PageAlert {
  tone: BannerTone;
  text: string;
  /** destaca o botão "Pagar mensalidade" */
  emphasizePay: boolean;
}

/** Avisos DENTRO de Meus Planos (a tela permanece sempre acessível). */
export function pageAlertFor(info: AccessInfo | null, now: Date): PageAlert | null {
  if (!info) return null;
  switch (info.state) {
    case "trial": {
      const days = trialDaysLeft(info.trial_ends_at, now);
      const left = days === null ? "em andamento" : days <= 1 ? "último dia" : `${days} dias restantes`;
      return { tone: "info", text: `Teste gratuito — ${left}.`, emphasizePay: false };
    }
    case "pending_payment":
      return { tone: "warn", text: "Pagamento necessário para liberar a operação.", emphasizePay: true };
    case "grace":
    case "past_due": {
      const until = fmtDayMonth(info.grace_until);
      return {
        tone: "warn",
        text: until ? `Mensalidade vencida. Regularize até ${until} para evitar bloqueio.` : "Mensalidade vencida. Regularize para evitar bloqueio.",
        emphasizePay: true,
      };
    }
    case "restricted":
      return { tone: "danger", text: "Empresa em modo somente leitura.", emphasizePay: true };
    case "trial_expired":
      return { tone: "danger", text: "Teste gratuito encerrado: a empresa está em modo somente leitura. Escolha seu plano para continuar.", emphasizePay: false };
    case "suspended":
    case "trial_canceled":
      return { tone: "danger", text: "Empresa em modo somente leitura. Fale com o suporte.", emphasizePay: false };
    case "canceled":
      return { tone: "danger", text: "Assinatura cancelada: a empresa está em modo somente leitura. Contrate novamente para operar.", emphasizePay: false };
    default:
      return null;
  }
}

export const TRIAL_CHOOSE_HINT = "Após o período de teste, escolha seu plano e módulos para continuar usando o sistema.";
export const NEXT_CYCLE_NOTE = "Esta alteração entrará em vigor na próxima mensalidade.";

export interface InvoiceLike {
  id: string;
  kind: "initial" | "recurring" | "module_addition";
  competence: string;
  due_date: string;
  amount_cents: number;
  status: "open" | "overdue" | "paid" | "void";
}

export const needsPayment = (inv: Pick<InvoiceLike, "status">): boolean => inv.status === "open" || inv.status === "overdue";

/**
 * Mensalidade atual = a fatura de CICLO em aberto/vencida MAIS ANTIGA (a que manda na carência); sem pendência, nenhuma.
 * A cobrança proporcional de módulos adicionais NÃO é mensalidade: tem cartão próprio ("aguardando pagamento").
 */
export function currentInvoice<T extends InvoiceLike>(invoices: readonly T[]): T | null {
  const open = invoices.filter((i) => needsPayment(i) && i.kind !== "module_addition").sort((a, b) => a.due_date.localeCompare(b.due_date) || a.competence.localeCompare(b.competence));
  return open[0] ?? null;
}

export function monthlySituation(inv: Pick<InvoiceLike, "status" | "due_date"> | null): string {
  if (!inv) return "Em dia";
  if (inv.status === "overdue") return `Vencida em ${fmtDayMonth(inv.due_date)}`;
  if (inv.status === "open") return `Em aberto — vence em ${fmtDayMonth(inv.due_date)}`;
  if (inv.status === "paid") return "Paga";
  return "Anulada";
}

export type ModuleState = "contracted" | "available" | "included" | "awaiting_payment" | "removal_scheduled";
export interface ModuleCard {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  state: ModuleState;
}

/**
 * Módulos do catálogo com o estado para a empresa: contratado (extra ATIVO), incluído no plano, disponível ou aguardando
 * pagamento da cobrança proporcional (ainda BLOQUEADO: nunca aparece como contratado antes da baixa).
 */
export function moduleCards(
  catalog: Catalog,
  sub: { modules: Array<{ id: string; code: string; source: "plan" | "extra" }> } | null,
  awaitingPaymentIds: readonly string[] = [],
  removalScheduledIds: readonly string[] = [],
): ModuleCard[] {
  return catalog.modules.map((m) => {
    const owned = sub?.modules.find((x) => x.id === m.id || x.code === m.code);
    const state: ModuleState = owned
      ? owned.source === "plan" ? "included" : removalScheduledIds.includes(m.id) ? "removal_scheduled" : "contracted"
      : awaitingPaymentIds.includes(m.id) ? "awaiting_payment" : "available";
    return { id: m.id, code: m.code, name: m.name, description: m.description, monthly_price_cents: m.monthly_price_cents, state };
  });
}

export const MODULE_STATE_LABEL: Record<ModuleState, string> = { contracted: "Contratado", available: "Disponível", included: "Incluído no plano", awaiting_payment: "Aguardando pagamento", removal_scheduled: "Remoção agendada" };

/** Prévia (só exibição) de uma alteração de módulos numa assinatura vigente. O total confirmado é sempre o do servidor. */
export function changePreview(cards: readonly ModuleCard[], selectedExtraIds: readonly string[]) {
  const selected = new Set(selectedExtraIds);
  const added = cards.filter((c) => c.state === "available" && selected.has(c.id));
  const removed = cards.filter((c) => c.state === "contracted" && !selected.has(c.id));
  return { added, removed, changed: added.length + removed.length > 0 };
}

/** Linhas do resumo "Base + módulos = total". */
export interface SummaryLine { label: string; cents: number }
export function summaryLines(plan: { name: string; monthly_price_cents: number }, modules: ReadonlyArray<{ name: string; monthly_price_cents: number }>): SummaryLine[] {
  return [{ label: plan.name, cents: plan.monthly_price_cents }, ...modules.map((m) => ({ label: m.name, cents: m.monthly_price_cents }))];
}

// --- Entitlement de módulos ---------------------------------------------------------------------------------------------
// Fonte da verdade: o BANCO (tenant_get_entitlements / assert_company_module). Aqui só se decide o que MOSTRAR; a barreira real
// das operações exclusivas é do backend. Mapa módulo -> recurso (o mesmo documentado na migration 20261007020000).
export type ModuleCode = "financeiro" | "producao" | "estoque" | "impressao";
export const MODULE_NAME: Record<ModuleCode, string> = {
  financeiro: "Financeiro",
  producao: "Produção / KDS",
  estoque: "Estoque",
  impressao: "Impressão Avançada",
};
/** Rotas exclusivas de módulo (prefixo -> módulo). Tudo o que não está aqui é núcleo do Plano Base. */
export const MODULE_ROUTES: ReadonlyArray<readonly [string, ModuleCode]> = [
  ["/app/financeiro/visao", "financeiro"],
  ["/app/financeiro/contas-a-receber", "financeiro"],
  ["/app/financeiro/contas-a-pagar", "financeiro"],
  ["/app/cadastros/estoque", "estoque"],
  ["/app/cadastros/setores", "producao"],
  ["/operacional/producao", "producao"],
  ["/operacional/etiquetas", "impressao"],
  ["/app/configuracoes/impressao", "impressao"],
];
export function moduleForPath(pathname: string): ModuleCode | null {
  const hit = MODULE_ROUTES.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix + "/"));
  return hit ? hit[1] : null;
}
/** "loading" enquanto o entitlement não chegou (nunca libera nem bloqueia por palpite). */
export function moduleAccess(entitlements: { modules: readonly string[] } | null, code: ModuleCode): "loading" | "allowed" | "locked" {
  if (!entitlements) return "loading";
  return entitlements.modules.includes(code) ? "allowed" : "locked";
}
export function lockedModuleText(code: ModuleCode, isOwner: boolean): string {
  return isOwner
    ? `O módulo ${MODULE_NAME[code]} não está contratado. Adicione-o em Meus Planos para usar este recurso.`
    : `O módulo ${MODULE_NAME[code]} não está contratado. Peça ao proprietário da empresa para adicioná-lo.`;
}
/** Texto do módulo no catálogo: durante o teste vale a regra do teste; depois da contratação, preço e ação reais. */
export function moduleOfferText(mode: string | null | undefined, state: ModuleState, monthlyCents: number, money: (c: number) => string): string {
  if (mode === "trial") return "Incluído durante o período de teste";
  if (state === "contracted") return "Ativo";
  if (state === "awaiting_payment") return "Aguardando pagamento";
  return `${money(monthlyCents)}/mês`;
}

// --- Alteração de módulos ------------------------------------------------------------------------------------------------
// ADIÇÃO: cobrança PROPORCIONAL imediata (Pix); o módulo só é liberado depois do pagamento e o vencimento principal não muda.
// REMOÇÃO: sem estorno; o módulo continua ativo até o fim do ciclo já pago. Tudo calculado pelo servidor (modo, valores, datas).

export const REMOVAL_NOTE = "Sem estorno: o módulo continua ativo até o fim do ciclo já pago e não será cobrado na próxima mensalidade.";
export const FOLLOWING_CYCLE_NOTE = "Como sua próxima mensalidade já foi gerada, esta alteração entrará em vigor no ciclo seguinte.";
export const LOCKED_PENDING_NOTE = "A mensalidade deste ciclo já foi gerada com esta alteração: ela não pode mais ser trocada nem cancelada.";
export const DEFERRED_ADD_NOTE = "Abaixo do valor mínimo do Pix: sem cobrança agora. O módulo entra no próximo ciclo e a mensalidade já virá com o valor cheio.";
export const PENDING_ADDITION_BLOCK = "Existe uma alteração de módulos aguardando pagamento.";

export type ModuleChangeMode = "identical" | "mixed" | "remove_next_cycle" | "add_now" | "add_deferred";

/** Estados em que o owner pode alterar módulos (espelha o servidor; o banco confere de novo). */
export const MODULE_CHANGE_STATES = ["active", "grace", "past_due"] as const;
export function moduleChangeBlockedReason(subStatus: string | null | undefined): string | null {
  if (!subStatus) return "Contrate um plano para escolher módulos.";
  if ((MODULE_CHANGE_STATES as readonly string[]).includes(subStatus)) return null;
  if (subStatus === "pending_payment") return "Pague a cobrança inicial para ativar a assinatura antes de alterar os módulos.";
  if (subStatus === "restricted") return "Regularize a mensalidade em atraso antes de alterar os módulos.";
  if (subStatus === "suspended") return "A assinatura está suspensa. Fale com o suporte para alterar os módulos.";
  return "A assinatura não aceita alteração de módulos no estado atual.";
}

/** "10/11/2026" a partir de AAAA-MM-DD (sem passar por Date). */
export function fmtFullDate(dateOnly: string | null | undefined): string {
  if (!dateOnly) return "";
  const [y, m, d] = dateOnly.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Texto de vigência da REMOÇÃO (e da adição agendada): a data e o "ciclo seguinte" vêm do servidor. */
export function effectiveNote(q: { effective_at: string; deferred_to_following_cycle: boolean }): string {
  return q.deferred_to_following_cycle
    ? `${FOLLOWING_CYCLE_NOTE} Início em ${fmtFullDate(q.effective_at)}.`
    : `${REMOVAL_NOTE} Sai da mensalidade a partir de ${fmtFullDate(q.effective_at)}.`;
}

/** Cobrança proporcional abaixo do mínimo do Pix: explica ao cliente, sem inventar cobrança. */
export function belowMinimumNote(q: { prorated_total_cents: number; min_charge_cents: number; effective_at: string }, money: (cents: number) => string): string {
  return `O valor proporcional (${money(q.prorated_total_cents)}) é menor que o mínimo de ${money(q.min_charge_cents)} para gerar um Pix. ${DEFERRED_ADD_NOTE} Início em ${fmtFullDate(q.effective_at)}.`;
}

/** O que o botão de confirmação diz em cada modo. */
export function confirmLabel(mode: ModuleChangeMode | undefined, submitting: boolean, replacing: boolean): string {
  if (submitting) return mode === "add_now" ? "Gerando Pix…" : "Agendando…";
  if (mode === "add_now") return "Gerar Pix e contratar";
  if (mode === "add_deferred") return "Agendar para o próximo ciclo";
  return replacing ? "Atualizar alteração agendada" : "Agendar remoção";
}

/** Texto de confirmação da REMOÇÃO (tudo vem do servidor: datas e valores). */
export function removalConfirmText(q: { effective_at: string; previous_monthly_cents: number; new_monthly_cents: number; deferred_to_following_cycle: boolean }, money: (cents: number) => string): string {
  const until = fmtFullDate(q.effective_at);
  const head = q.deferred_to_following_cycle
    ? `Como sua próxima mensalidade já foi gerada, o módulo continuará disponível até ${until} (ciclo seguinte).`
    : `O módulo continuará disponível até ${until}.`;
  return `${head} Não haverá estorno do período já pago. A partir do próximo ciclo, sua mensalidade passará de ${money(q.previous_monthly_cents)} para ${money(q.new_monthly_cents)}.`;
}

/** Ids dos módulos extras da composição de uma alteração pendente (para "Alterar" reabrir a seleção). */
export const pendingSelection = (p: { new_modules: Array<{ module_id: string }> } | null): string[] | null =>
  p ? p.new_modules.map((m) => m.module_id) : null;
