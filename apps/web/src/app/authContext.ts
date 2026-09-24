import type { Session, User } from "@supabase/supabase-js";
import { createContext } from "react";
import type { CompanyMembership, ProfileRow } from "../lib/types";

export interface AuthContextValue {
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: ProfileRow | null;
  companies: CompanyMembership[];
  companiesLoading: boolean;
  activeCompanyId: string | null;
  activeMembership: CompanyMembership | null;
  setActiveCompanyId: (companyId: string) => void;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  createCompany: (
    name: string,
    document: string | null,
  ) => Promise<{ error: string | null }>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
