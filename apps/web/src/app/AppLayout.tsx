import { Link, NavLink, Outlet } from "react-router-dom";
import { CompanySwitcher } from "./CompanySwitcher";
import { isManagedAccount } from "../lib/managedAccount";
import { useAuth } from "./useAuth";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador",
  cashier: "Caixa / Balcão",
  attendant: "Atendente",
};

export function AppLayout() {
  const { user, profile, activeMembership, isMasterAdmin, signOut } = useAuth();
  // Conta de funcionário: mostra o nome, nunca o e-mail técnico do Auth.
  const identity = isManagedAccount(user) ? (profile?.full_name ?? null) : (user?.email ?? null);

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <div className="brand">OrçaFácil</div>
          <nav className="app-nav">
            <NavLink to="/app" end>
              Início
            </NavLink>
            <NavLink to="/app/equipe">Funcionários</NavLink>
            <NavLink to="/app/configuracoes">Configurações</NavLink>
          </nav>
        </div>
        <div className="app-user">
          <CompanySwitcher />
          <span>{identity}</span>
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
      <main className="app-body">
        <Outlet />
      </main>
    </div>
  );
}
