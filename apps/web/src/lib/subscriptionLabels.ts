import type { InvoiceStatus, SubscriptionStatus } from "./types";

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trialing: "Em teste",
  active: "Ativa",
  past_due: "Em atraso",
  grace: "Em carência",
  restricted: "Restrita",
  suspended: "Suspensa",
  canceled: "Cancelada",
};

export const EVENT_LABEL: Record<string, string> = {
  subscribed: "Assinatura contratada",
  plan_changed: "Plano alterado",
  module_added: "Módulo adicionado",
  module_removed: "Módulo removido",
  status_changed: "Status alterado",
  billing_day_changed: "Dia de vencimento alterado",
};

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  open: "Em aberto",
  paid: "Paga",
  overdue: "Vencida",
  void: "Anulada",
};

export const INVOICE_EVENT_LABEL: Record<string, string> = {
  generated: "Fatura gerada",
  paid: "Baixa manual (paga)",
  voided: "Fatura anulada",
};
