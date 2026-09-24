import type { SubscriptionStatus } from "./types";

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
