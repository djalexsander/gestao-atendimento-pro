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
}
