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
  // Tem vínculo(s) com empresa, mas nenhum ativo (funcionário desativado). Não é "sem
  // empresa": a tela mostra "Acesso desativado" e nunca leva ao onboarding.
  accessDisabled: boolean;
  // Privilégio GLOBAL da plataforma, independente de qualquer empresa — não
  // confundir com o papel (owner/admin/attendant/cashier) dentro de activeMembership.
  isMasterAdmin: boolean;
  masterAdminLoading: boolean;
  activeCompanyId: string | null;
  activeMembership: CompanyMembership | null;
  setActiveCompanyId: (companyId: string) => void;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  // Reenvio do e-mail de confirmação do cadastro (método oficial do Supabase Auth). O cooldown é da tela.
  resendSignupConfirmation: (email: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  // Recuperação de senha (Supabase Auth oficial). requestPasswordReset nunca revela se o e-mail existe.
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>;
  // Define a nova senha da sessão de recuperação e ENCERRA a sessão (volta ao login normal).
  completePasswordReset: (password: string) => Promise<{ error: string | null }>;
  // Login operacional (código da empresa + login + PIN/senha), separado do login por e-mail.
  signInEmployee: (
    accessCode: string,
    login: string,
    credential: string,
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  createCompany: (
    name: string,
    accessCode: string,
    document: string | null,
  ) => Promise<{ error: string | null }>;
  refreshMemberships: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
