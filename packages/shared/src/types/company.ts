export type CompanyRole = "owner" | "admin" | "agent";

export interface Company {
  id: string;
  name: string;
  slug: string;
  document: string | null;
  logoUrl: string | null;
  createdAt: string;
}
