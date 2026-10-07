import type { InvoiceStatus, SubscriptionStatus, TrialState } from "./types";

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  pending_payment: "Aguardando pagamento inicial",
  trialing: "Em teste (legado)",
  active: "Ativa",
  past_due: "Em atraso",
  grace: "Em carência",
  restricted: "Restrita",
  suspended: "Suspensa",
  canceled: "Cancelada",
};

// Status que o Master pode definir manualmente. pending_payment é o estado da
// contratação e só sai dele pelo pagamento da fatura inicial; o período grátis
// não é status de assinatura. O banco recusa o restante.
export const MANUAL_STATUSES: SubscriptionStatus[] = [
  "active",
  "past_due",
  "grace",
  "restricted",
  "suspended",
  "canceled",
];

export const TRIAL_STATE_LABEL: Record<TrialState, string> = {
  none: "Sem período grátis",
  trialing: "Em período grátis",
  expired: "Trial expirado",
  converted: "Convertido em plano pago",
  canceled: "Período grátis cancelado",
};

export const TRIAL_EVENT_LABEL: Record<string, string> = {
  started: "Período grátis iniciado",
  expired: "Período grátis expirado (sem cobrança)",
  converted: "Convertido em plano pago",
  canceled: "Período grátis cancelado",
};

export const EVENT_LABEL: Record<string, string> = {
  subscribed: "Assinatura contratada",
  plan_changed: "Plano alterado",
  module_added: "Módulo adicionado",
  module_removed: "Módulo removido",
  status_changed: "Status alterado",
  billing_day_changed: "Dia de vencimento alterado (ajuste excepcional)",
  modules_change_scheduled: "Alteração de módulos agendada (cliente)",
  modules_change_updated: "Alteração de módulos agendada substituída (cliente)",
  modules_change_canceled: "Alteração de módulos agendada cancelada",
  modules_change_applied: "Alteração de módulos aplicada no novo ciclo",
};

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  open: "Em aberto",
  paid: "Paga",
  overdue: "Vencida",
  void: "Anulada",
};

export const INVOICE_KIND_LABEL: Record<string, string> = {
  initial: "Cobrança inicial",
  recurring: "Mensalidade",
  module_addition: "Adição de módulos (proporcional)",
};

export const INVOICE_EVENT_LABEL: Record<string, string> = {
  generated: "Fatura gerada",
  paid: "Baixa manual (paga)",
  voided: "Fatura anulada",
  overdue: "Fatura vencida (automático)",
};
