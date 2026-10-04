import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { isManagedAccount } from "../lib/managedAccount";
import { randomSlugSuffix, slugify } from "../lib/slug";
import { staffEmail } from "../lib/staffAuth";
import { supabase } from "../lib/supabaseClient";
import type { CompanyMembership, ProfileRow } from "../lib/types";
import type { Session } from "@supabase/supabase-js";
import { pushClient } from "../features/notifications/pushBrowser";
import { AuthContext, type AuthContextValue } from "./authContext";
import { clearReturnPath } from "./returnTo";

const ACTIVE_COMPANY_KEY = "orca-facil:active-company-id";

// Falha de create_company que NÃO é uma mensagem amigável escrita na própria RPC:
// o erro técnico do banco não vai para a tela.
const CREATE_COMPANY_FALLBACK_ERROR =
  "Não foi possível criar a empresa agora. Tente novamente em instantes.";

// Login do funcionário: uma mensagem única para credencial errada, que não revela se o
// erro foi do código da empresa, do login ou do PIN/senha.
const EMPLOYEE_LOGIN_ERROR = "Código da empresa, login ou PIN/senha incorretos.";
const EMPLOYEE_INACTIVE_MESSAGE = "Acesso desativado. Procure o administrador da empresa.";
const EMPLOYEE_RATE_LIMIT_MESSAGE = "Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.";
const EMPLOYEE_GENERIC_ERROR = "Não foi possível entrar agora. Verifique a conexão e tente novamente.";

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
  // Tem vínculo(s) com empresa, mas nenhum ativo (funcionário desativado): a tela mostra
  // "Acesso desativado" em vez de mandar para o onboarding.
  const [accessDisabled, setAccessDisabled] = useState(false);
  // Começam "true" de propósito: enquanto a sessão inicial ainda está sendo
  // resolvida, existe uma janela entre `session` já vir preenchida e o efeito
  // que dispara a busca real ainda não ter rodado. Se esses loadings
  // começassem em `false`, um guard de rota veria momentaneamente "sessão ok,
  // nada carregando, lista vazia" e navegaria para o destino errado (ex.:
  // expulsar um master_admin de /master) antes da checagem real terminar —
  // e como <Navigate> troca a URL, esse redirecionamento não se desfaz
  // sozinho depois. Bug real observado e corrigido durante os testes do
  // Painel Master.
  const [companiesLoading, setCompaniesLoading] = useState(true);
  const [isMasterAdmin, setIsMasterAdmin] = useState(false);
  const [masterAdminLoading, setMasterAdminLoading] = useState(true);
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
        .select("company_id, role, status, company:companies(*)")
        .eq("user_id", userId),
    ]);

    setProfile((profileResult.data as ProfileRow | null) ?? null);

    if (membershipResult.error) {
      console.error("Falha ao carregar empresas do usuário:", membershipResult.error);
      setCompanies([]);
      setAccessDisabled(false);
    } else {
      const rows = (membershipResult.data ?? []) as unknown as Array<{
        company_id: string;
        role: CompanyMembership["role"];
        status: "active" | "inactive";
        // O client sem tipos gerados do schema infere embeds como array;
        // a FK company_users.company_id -> companies.id é N:1, então na prática
        // sempre vem um único objeto (ou array de 1 posição, dependendo da versão).
        // Para vínculo INATIVO o RLS esconde a empresa: o embed volta nulo.
        company: CompanyMembership["company"] | CompanyMembership["company"][] | null;
      }>;
      const active = rows.flatMap((row) => {
        const company = Array.isArray(row.company) ? (row.company[0] ?? null) : row.company;
        return row.status === "active" && company
          ? [{ companyId: row.company_id, role: row.role, company }]
          : [];
      });
      setCompanies(active);
      // Só vínculos desativados: a tela mostra "Acesso desativado", nunca o onboarding.
      setAccessDisabled(rows.length > 0 && active.length === 0);
    }
    setCompaniesLoading(false);
  }, []);

  // Privilégio global, independente das empresas do usuário — por isso é uma
  // busca separada de refreshCompanies, não misturada com o resultado dela.
  // Esta chamada só decide o que a UI mostra; a autoridade real é a própria
  // RPC verificando de novo a cada chamada administrativa.
  const refreshMasterStatus = useCallback(async () => {
    setMasterAdminLoading(true);
    const { data, error } = await supabase.rpc("is_master_admin");
    if (error) {
      console.error("Falha ao verificar privilégio master_admin:", error);
      setIsMasterAdmin(false);
    } else {
      setIsMasterAdmin(Boolean(data));
    }
    setMasterAdminLoading(false);
  }, []);

  // Depende de user?.id (não do objeto `user`) de propósito: o supabase-js
  // emite um novo objeto de sessão/usuário em eventos como refresh de token
  // ou a aba voltar a ficar visível, mesmo sendo a mesma pessoa. Reagir à
  // referência do objeto faria a UI inteira cair para o loading de novo a
  // cada um desses eventos, mesmo sem o usuário ter realmente mudado.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      // Enquanto a sessão inicial ainda está sendo resolvida (loading), não
      // marcamos "terminou de carregar": senão os guards de rota veriam
      // "sem loading + sem dados" antes da sessão real chegar.
      if (loading) return;
      setProfile(null);
      setCompanies([]);
      setAccessDisabled(false);
      setCompaniesLoading(false);
      setIsMasterAdmin(false);
      setMasterAdminLoading(false);
      return;
    }
    void refreshCompanies(userId);
    void refreshMasterStatus();
  }, [userId, loading, refreshCompanies, refreshMasterStatus]);

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

  // Login operacional: código da empresa + login + PIN/senha. O e-mail técnico só existe
  // aqui dentro; a pessoa nunca o vê e nenhuma mensagem o repete. Depois do login, quem
  // leva o funcionário à área do papel dele são as rotas (accessRules.ts).
  async function signInEmployee(accessCode: string, login: string, credential: string) {
    const { error } = await supabase.auth.signInWithPassword({
      email: staffEmail(accessCode, login),
      password: credential,
    });
    if (!error) return { error: null };

    switch (error.code) {
      case "invalid_credentials":
        return { error: EMPLOYEE_LOGIN_ERROR };
      case "user_banned":
        // Ban do Auth: o funcionário foi desativado.
        return { error: EMPLOYEE_INACTIVE_MESSAGE };
      case "over_request_rate_limit":
        return { error: EMPLOYEE_RATE_LIMIT_MESSAGE };
    }
    console.error("Falha no login do funcionário:", error.code ?? error.name);
    return { error: EMPLOYEE_GENERIC_ERROR };
  }

  async function signOut() {
    // Melhor esforço (máx. 2 s, nunca bloqueia nem falha o logout): desativa este aparelho para notificações. Se
    // não der, o servidor continua protegido: vínculo inativo/sem sessão não recebe push.
    await pushClient.deactivateForLogout();
    clearReturnPath();
    await supabase.auth.signOut();
    setPreferredCompanyId(null);
    persistActiveCompanyId(null);
  }

  async function refreshMemberships() {
    if (!user) return;
    await refreshCompanies(user.id);
  }

  async function createCompany(name: string, accessCode: string, document: string | null) {
    if (!user) return { error: "Sessão inválida." };
    // Conta de funcionário nunca cria empresa (o banco também recusa).
    if (isManagedAccount(user)) return { error: "Contas de funcionário não podem criar empresas." };

    const baseSlug = slugify(name);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSlugSuffix()}`;
      const { data, error } = await supabase.rpc("create_company", {
        p_name: name,
        p_slug: slug,
        p_access_code: accessCode,
        p_document: document,
      });

      if (!error) {
        await refreshCompanies(user.id);
        const created = data as { id: string } | null;
        if (created?.id) setActiveCompanyId(created.id);
        return { error: null };
      }

      // 23505 = unique_violation em companies_slug_key (slug já em uso) — tenta outro
      // slug automaticamente. Código da empresa em uso/inválido NÃO chega aqui como
      // 23505: a RPC responde P0001 com uma mensagem amigável, mostrada como veio.
      if (error.code === "23505") continue;
      if (error.code === "P0001" || error.code === "PT403") return { error: error.message };

      console.error("Falha ao criar empresa:", error);
      return { error: CREATE_COMPANY_FALLBACK_ERROR };
    }

    return { error: CREATE_COMPANY_FALLBACK_ERROR };
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
    accessDisabled,
    isMasterAdmin,
    masterAdminLoading,
    activeCompanyId,
    activeMembership,
    setActiveCompanyId,
    signUp,
    signIn,
    signInEmployee,
    signOut,
    createCompany,
    refreshMemberships,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
