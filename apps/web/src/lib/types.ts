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

export type SubscriptionStatus =
  | "trialing"
  | 'active'
  | 'past_due'
  | 'grace'
  | 'restricted'
  | 'suspended'
  | 'canceled';

export interface CompanyDetail {
  company: { id: string; name: string; slug: string; document: string | null; created_at: string };
  members: Array<{ user_id: string; email: string | null; full_name: string | null; role: CompanyRole }>;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    billing_day: number;
    started_at: string;
    current_period_start: string;
    current_period_end: string;
    grace_until: string | null;
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
  };
  company: { id: string; name: string };
  subscription: { id: string; status: SubscriptionStatus; billing_day: number; plan_id: string } | null;
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
