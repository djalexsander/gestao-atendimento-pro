import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { randomSlugSuffix, slugify } from "../lib/slug";
import { supabase } from "../lib/supabaseClient";
import type { CompanyMembership, ProfileRow } from "../lib/types";
import type { Session } from "@supabase/supabase-js";
import { AuthContext, type AuthContextValue } from "./authContext";

const ACTIVE_COMPANY_KEY = "orca-facil:active-company-id";

function readStoredCompanyId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_COMPANY_KEY);
  } catch {
    return null;
  }
}

function persistActiveCompanyId(companyId: string | null) {
  try {
    if (companyId) {
      localStorage.setItem(ACTIVE_COMPANY_KEY, companyId);
    } else {
      localStorage.removeItem(ACTIVE_COMPANY_KEY);
    }
  } catch {
    // localStorage indisponível (modo privado, etc.) — segue sem persistir.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [companies, setCompanies] = useState<CompanyMembership[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  // Preferência do usuário (persistida); a empresa efetivamente ativa é derivada
  // abaixo, caindo para a primeira empresa quando a preferência não é (mais) válida.
  const [preferredCompanyId, setPreferredCompanyId] = useState<string | null>(
    readStoredCompanyId,
  );

  const user = session?.user ?? null;

  useEffect(() => {
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const refreshCompanies = useCallback(async (userId: string) => {
    setCompaniesLoading(true);
    const [profileResult, membershipResult] = await Promise.all([
      supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
      supabase
        .from("company_users")
        .select("company_id, role, company:companies(*)")
        .eq("user_id", userId),
    ]);

    setProfile((profileResult.data as ProfileRow | null) ?? null);

    if (membershipResult.error) {
      console.error("Falha ao carregar empresas do usuário:", membershipResult.error);
      setCompanies([]);
    } else {
      const rows = (membershipResult.data ?? []) as unknown as Array<{
        company_id: string;
        role: CompanyMembership["role"];
        // O client sem tipos gerados do schema infere embeds como array;
        // a FK company_users.company_id -> companies.id é N:1, então na prática
        // sempre vem um único objeto (ou array de 1 posição, dependendo da versão).
        company: CompanyMembership["company"] | CompanyMembership["company"][];
      }>;
      setCompanies(
        rows.map((row) => ({
          companyId: row.company_id,
          role: row.role,
          company: Array.isArray(row.company) ? row.company[0] : row.company,
        })),
      );
    }
    setCompaniesLoading(false);
  }, []);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      setCompanies([]);
      setCompaniesLoading(false);
      return;
    }
    void refreshCompanies(user.id);
  }, [user, refreshCompanies]);

  // Empresa efetivamente ativa: a preferência salva, se ainda válida, senão a
  // primeira empresa do usuário. Derivado no render — sem efeito e sem estado
  // duplicado para manter sincronizado.
  const activeCompanyId = useMemo(() => {
    if (companies.length === 0) return null;
    const preferredStillValid = companies.some((c) => c.companyId === preferredCompanyId);
    return preferredStillValid ? preferredCompanyId : companies[0].companyId;
  }, [companies, preferredCompanyId]);

  function setActiveCompanyId(companyId: string) {
    setPreferredCompanyId(companyId);
    persistActiveCompanyId(companyId);
  }

  async function signUp(email: string, password: string) {
    const { error } = await supabase.auth.signUp({ email, password });
    return { error: error?.message ?? null };
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }

  async function signOut() {
    await supabase.auth.signOut();
    persistActiveCompanyId(null);
  }

  async function createCompany(name: string, document: string | null) {
    if (!user) return { error: "Sessão inválida." };

    const baseSlug = slugify(name);
    let lastErrorMessage: string | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSlugSuffix()}`;
      const { data, error } = await supabase.rpc("create_company", {
        p_name: name,
        p_slug: slug,
        p_document: document,
      });

      if (!error) {
        await refreshCompanies(user.id);
        const created = data as { id: string } | null;
        if (created?.id) setActiveCompanyId(created.id);
        return { error: null };
      }

      lastErrorMessage = error.message;
      // 23505 = unique_violation (slug já em uso) — tenta outro slug automaticamente.
      if (error.code !== "23505") break;
    }

    return { error: lastErrorMessage };
  }

  const activeMembership = useMemo(
    () => companies.find((c) => c.companyId === activeCompanyId) ?? null,
    [companies, activeCompanyId],
  );

  const value: AuthContextValue = {
    loading,
    session,
    user,
    profile,
    companies,
    companiesLoading,
    activeCompanyId,
    activeMembership,
    setActiveCompanyId,
    signUp,
    signIn,
    signOut,
    createCompany,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
