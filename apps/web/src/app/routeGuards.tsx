import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./useAuth";
import { FullPageLoader } from "./FullPageLoader";

function postAuthPath(hasCompany: boolean): string {
  return hasCompany ? "/app" : "/onboarding";
}

/** /login e /cadastro — só acessíveis por quem NÃO tem sessão. */
export function GuestOnlyRoute({ children }: { children: ReactNode }) {
  const { loading, session, companiesLoading, companies } = useAuth();

  if (loading) return <FullPageLoader />;
  if (session) {
    if (companiesLoading) return <FullPageLoader />;
    return <Navigate to={postAuthPath(companies.length > 0)} replace />;
  }
  return <>{children}</>;
}

/** /onboarding — exige sessão e exige que o usuário ainda não tenha empresa. */
export function OnboardingRoute({ children }: { children: ReactNode }) {
  const { loading, session, companiesLoading, companies } = useAuth();

  if (loading) return <FullPageLoader />;
  if (!session) return <Navigate to="/login" replace />;
  if (companiesLoading) return <FullPageLoader />;
  if (companies.length > 0) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

/** /app — exige sessão e exige que o usuário já tenha ao menos uma empresa. */
export function AppRoute({ children }: { children: ReactNode }) {
  const { loading, session, companiesLoading, companies } = useAuth();

  if (loading) return <FullPageLoader />;
  if (!session) return <Navigate to="/login" replace />;
  if (companiesLoading) return <FullPageLoader />;
  if (companies.length === 0) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

/**
 * /master — exige sessão E privilégio master_admin validado pelo backend
 * (via is_master_admin(), nunca por e-mail hardcoded ou estado local).
 * Não tem relação com companies/activeCompanyId: um master_admin sem
 * nenhuma empresa ainda acessa /master normalmente.
 */
export function MasterRoute({ children }: { children: ReactNode }) {
  const { loading, session, masterAdminLoading, isMasterAdmin } = useAuth();

  if (loading) return <FullPageLoader />;
  if (!session) return <Navigate to="/login" replace />;
  if (masterAdminLoading) return <FullPageLoader />;
  if (!isMasterAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** "/" — decide para onde mandar com base no estado de autenticação/empresa. */
export function RootRedirect() {
  const { loading, session, companiesLoading, companies } = useAuth();

  if (loading) return <FullPageLoader />;
  if (!session) return <Navigate to="/login" replace />;
  if (companiesLoading) return <FullPageLoader />;
  return <Navigate to={postAuthPath(companies.length > 0)} replace />;
}
