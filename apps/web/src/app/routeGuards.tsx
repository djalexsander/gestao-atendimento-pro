import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { isManagedAccount } from "../lib/managedAccount";
import { decide, pathAllowedForRole, type AuthSnapshot, type GuardedRoute, type OperationalArea } from "./accessRules";
import { FullPageLoader } from "./FullPageLoader";
import { clearReturnPath, peekReturnPath, saveReturnPath } from "./returnTo";
import { useAuth } from "./useAuth";

// Os guards só APLICAM as decisões de accessRules.ts (que ficam testáveis à parte):
// esperar, redirecionar ou mostrar a página. A proteção dos dados continua sendo do backend.
function useAuthSnapshot(): AuthSnapshot {
  const { loading, session, user, companiesLoading, activeMembership, accessDisabled } = useAuth();
  return {
    loading,
    hasSession: session !== null,
    companiesLoading,
    role: activeMembership?.role ?? null,
    accessDisabled,
    isManaged: isManagedAccount(user),
  };
}

function Guard({ route, children }: { route: GuardedRoute; children?: ReactNode }) {
  const snapshot = useAuthSnapshot();
  const decision = decide(route, snapshot);
  const location = useLocation();
  const here = location.pathname + location.search;

  // Destino pretendido (ex.: toque numa notificação com a sessão fora do ar): lembra a rota ao mandar a pessoa
  // para o login e limpa quando ela chega lá. Só rotas internas conhecidas (ver returnTo.ts / accessRules.ts).
  const signedOutRedirect = decision.action === "redirect" && !snapshot.hasSession;
  const arrived = decision.action === "render" && route !== "guest";
  useEffect(() => {
    if (signedOutRedirect) saveReturnPath(here);
    else if (arrived && peekReturnPath() === here) clearReturnPath();
  }, [signedOutRedirect, arrived, here]);

  if (decision.action === "wait") return <FullPageLoader />;
  if (decision.action === "redirect") {
    // Já logada, a caminho da página inicial (login/raiz): volta ao destino lembrado, se o papel puder abri-lo.
    if (snapshot.hasSession && (route === "guest" || route === "root")) {
      const back = peekReturnPath();
      if (back && pathAllowedForRole(snapshot.role, back)) return <Navigate to={back} replace />;
    }
    return <Navigate to={decision.to} replace />;
  }
  return <>{children}</>;
}

/** /login, /cadastro e /funcionario: só acessíveis por quem NÃO tem sessão. */
export function GuestOnlyRoute({ children }: { children: ReactNode }) {
  return <Guard route="guest">{children}</Guard>;
}

/**
 * /onboarding: exige sessão e só serve a conta normal que ainda não tem empresa. Conta de
 * funcionário (ou com acesso desativado) nunca cai aqui e nunca cria empresa.
 */
export function OnboardingRoute({ children }: { children: ReactNode }) {
  return <Guard route="onboarding">{children}</Guard>;
}

/** /app: Administrativo. Só owner e admin; funcionário vai para a área do papel dele. */
export function AppRoute({ children }: { children: ReactNode }) {
  return <Guard route="app">{children}</Guard>;
}

/** /operacional/*: cada rota é só do papel dela (attendant: Atendimento; cashier: Caixa). */
export function OperationalRoute({ area, children }: { area: OperationalArea; children: ReactNode }) {
  return <Guard route={area}>{children}</Guard>;
}

/** /acesso-desativado: só quando o vínculo existe mas está desativado (ou conta de funcionário sem vínculo). */
export function DisabledAccessRoute({ children }: { children: ReactNode }) {
  return <Guard route="disabled">{children}</Guard>;
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

/** "/" — decide para onde mandar com base no estado de autenticação/empresa/papel. */
export function RootRedirect() {
  return <Guard route="root" />;
}
