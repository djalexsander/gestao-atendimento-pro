import { Link, NavLink, Outlet } from "react-router-dom";
import { CompanySwitcher } from "./CompanySwitcher";
import { PendingInvitesBanner } from "./PendingInvitesBanner";
import { useAuth } from "./useAuth";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador(a)",
  agent: "Agente",
};

export function AppLayout() {
  const { user, activeMembership, isMasterAdmin, signOut } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <div className="brand">OrçaFácil</div>
          <nav className="app-nav">
            <NavLink to="/app" end>
              Início
            </NavLink>
            <NavLink to="/app/equipe">Equipe</NavLink>
            <NavLink to="/app/configuracoes">Configurações</NavLink>
          </nav>
        </div>
        <div className="app-user">
          <CompanySwitcher />
          <span>{user?.email}</span>
          {activeMembership && (
            <span className="role-badge">
              {ROLE_LABEL[activeMembership.role] ?? activeMembership.role}
            </span>
          )}
          {isMasterAdmin && (
            <Link className="btn-secondary" to="/master">
              Painel Master
            </Link>
          )}
          <button className="btn-secondary" type="button" onClick={() => void signOut()}>
            Sair
          </button>
        </div>
      </header>
      <PendingInvitesBanner />
      <main className="app-body">
        <Outlet />
      </main>
    </div>
  );
}
