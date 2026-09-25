import type { CompanyRole } from "@orca-facil/shared";

export type { CompanyRole };

export interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  document: string | null;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
  email: string | null;
}

export interface CompanyMembership {
  companyId: string;
  role: CompanyRole;
  company: CompanyRow;
}

export type InviteStatus = "pending" | "accepted" | "revoked";

export interface CompanyInviteRow {
  id: string;
  company_id: string;
  company_name: string;
  email: string;
  role: CompanyRole;
  status: InviteStatus;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  email_last_sent_at: string | null;
}

export interface TeamMember {
  companyUserId: string;
  userId: string;
  role: CompanyRole;
  fullName: string | null;
  email: string | null;
}

export interface MasterOverview {
  totalCompanies: number;
  totalUsers: number;
}

export interface MasterCompanyRow {
  id: string;
  name: string;
  document: string | null;
  createdAt: string;
  memberCount: number;
  subscriptionStatus: SubscriptionStatus | null;
  planName: string | null;
  // Período grátis (estado efetivo, calculado no banco em tempo real).
  trialState: TrialState | null;
  trialEndsAt: string | null;
}

export interface CatalogModule {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number;
  isActive: boolean;
}

export interface CatalogPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number;
  isActive: boolean;
  // null = ilimitado
  limits: Record<string, number | null>;
  moduleIds: string[];
}

// "trialing" em assinatura é um valor LEGADO (status manual anterior ao período
// grátis oficial): o backend não o cria mais. O teste grátis é CompanyTrial.
export type SubscriptionStatus =
  | "pending_payment"
  | "trialing"
  | 'active'
  | 'past_due'
  | 'grace'
  | 'restricted'
  | 'suspended'
  | 'canceled';

// Estado do período grátis. "expired" é derivado em tempo real pelo banco a
// partir de trial_ends_at (não depende de agendador). converted/canceled são
// definitivos; "none" = a empresa nunca usou.
export type TrialState = "none" | "trialing" | "expired" | "converted" | "canceled";

export interface CompanyTrial {
  state: TrialState;
  has_used_trial: boolean;
  is_active: boolean;
  has_ended: boolean;
  // Pode iniciar agora (nunca usou e sem assinatura vigente). NÃO depende do catálogo de planos.
  can_start: boolean;
  offer_days: number;
  // code do registro de catálogo reservado ao período grátis (apresentação comercial): nunca é contratável;
  // o registro pode até não existir. Serve só para escondê-lo das listas de contratação/troca.
  reserved_plan_code: string;
  trial_id: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  // Datas de calendário em America/Sao_Paulo (sem deslocamento de fuso no cliente).
  trial_started_on: string | null;
  trial_ends_on: string | null;
  trial_days: number | null;
  converted_at: string | null;
  converted_subscription_id: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  events: Array<{
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
    actor_email: string | null;
  }>;
}

export interface CompanyDetail {
  company: { id: string; name: string; slug: string; document: string | null; created_at: string };
  members: Array<{ user_id: string; email: string | null; full_name: string | null; role: CompanyRole }>;
  trial: CompanyTrial;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    billing_day: number;
    started_at: string;
    current_period_start: string;
    current_period_end: string;
    grace_until: string | null;
    // false = contrato cobrado congelado (a inicial não foi paga): plano, módulos e dia não mudam.
    initial_charge_settled: boolean;
    plan: {
      id: string;
      code: string;
      name: string;
      price_cents_snapshot: number;
      catalog_price_cents: number;
      is_active: boolean;
      limits: Record<string, number | null>;
    };
    included_modules: Array<{ id: string; code: string; name: string }>;
    extra_modules: Array<{
      id: string;
      module_id: string;
      code: string;
      name: string;
      price_cents_snapshot: number;
      added_at: string;
    }>;
    module_history: Array<{
      id: string;
      code: string;
      name: string;
      source: "plan" | "extra";
      plan_id: string | null;
      price_cents_snapshot: number;
      added_at: string;
      removed_at: string | null;
    }>;
    events: Array<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: string;
      actor_email: string | null;
    }>;
  } | null;
  past_subscriptions: Array<{
    id: string;
    plan_name: string;
    price_cents_snapshot: number;
    started_at: string;
    canceled_at: string | null;
  }>;
}

export type InvoiceStatus = "open" | "paid" | "overdue" | "void";

export interface InvoiceRow {
  id: string;
  subscription_id: string;
  company_id: string;
  company_name: string;
  plan_description: string | null;
  competence: string; // "YYYY-MM-01"
  due_date: string; // "YYYY-MM-DD"
  amount_cents: number;
  status: InvoiceStatus;
  paid_at: string | null;
  created_at: string;
  days_overdue: number | null;
  kind: "initial" | "recurring";
}

export interface InvoiceDetail {
  invoice: {
    id: string;
    subscription_id: string;
    company_id: string;
    competence: string;
    due_date: string;
    amount_cents: number;
    status: InvoiceStatus;
    paid_at: string | null;
    created_at: string;
    updated_at: string;
    kind: "initial" | "recurring";
  };
  company: { id: string; name: string };
  subscription: {
    id: string;
    status: SubscriptionStatus;
    billing_day: number;
    plan_id: string;
    status_source: "manual" | "billing";
    grace_until: string | null;
  } | null;
  billing: {
    business_date: string;
    // só a mensalidade participa do ciclo carência/restrição; a cobrança inicial não
    applies_to_debt_cycle: boolean;
    days_overdue: number | null;
    grace_until: string | null;
    restriction_from: string | null;
  };
  items: Array<{
    id: string;
    kind: "plan" | "module" | "adjustment";
    ref_id: string | null;
    description: string;
    amount_cents: number;
  }>;
  events: Array<{
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
    actor_email: string | null;
  }>;
}

export interface SubscriptionHistory {
  terms: Array<{
    id: string;
    effective_from_competence: string;
    plan_id: string;
    plan_name: string;
    plan_price_cents: number;
    billing_day: number;
    created_at: string;
    actor_email: string | null;
  }>;
  extras: Array<{
    id: string;
    module_id: string;
    name: string;
    price_cents: number;
    effective_from_competence: string;
    effective_to_competence: string | null; // exclusivo
    added_at: string;
    removed_at: string | null;
  }>;
}

// Situação da dívida RECORRENTE (tipada pelo banco). 'awaiting_initial_payment' vale para toda assinatura que
// nunca foi ativada (aguardando pagamento, ou suspensa antes de pagar) — nunca grace/restricted, mesmo com a
// cobrança inicial vencida: ok/grace/restricted só existem para assinatura ativada.
export type DebtState = "awaiting_initial_payment" | "ok" | "grace" | "restricted";

export interface BillingState {
  business_date: string;
  status: SubscriptionStatus;
  status_source: "manual" | "billing";
  grace_until: string | null;
  debt_state: DebtState;
  oldest_overdue_invoice_id: string | null;
  oldest_due_date: string | null;
  days_overdue: number | null;
  debt_grace_until: string | null;
  restriction_from: string | null;
  overdue_count: number;
  initial_invoice_id: string | null;
  initial_invoice_status: InvoiceStatus | null;
  initial_invoice_due_date: string | null;
  // vencimento da inicial informado à parte, em tempo real (não depende do ciclo diário)
  initial_invoice_overdue: boolean;
  initial_days_overdue: number | null;
}
