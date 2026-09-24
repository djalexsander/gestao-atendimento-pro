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
