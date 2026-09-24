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
}

export interface CompanyMembership {
  companyId: string;
  role: CompanyRole;
  company: CompanyRow;
}
