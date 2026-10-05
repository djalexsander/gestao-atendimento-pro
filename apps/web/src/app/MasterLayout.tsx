import { Link, NavLink, Outlet } from "react-router-dom";

// Layout deliberadamente separado do AppLayout: o Painel Master não é uma
// empresa nem usa activeCompanyId/CompanySwitcher — é um contexto global à
// parte, só acessível a quem tem privilégio master_admin (ver MasterRoute).
// Pagamentos e cobrança automática entram aqui nas próximas fases.
export function MasterLayout() {
  return (
    <div className="app-shell">
      <header className="app-topbar master-topbar">
        <div className="app-topbar-left">
          <div className="brand">Gestão Atendimento Pro</div>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>Painel Master</span>
          <nav className="app-nav">
            <NavLink to="/master" end>
              Visão geral
            </NavLink>
            <NavLink to="/master/empresas">Empresas</NavLink>
            <NavLink to="/master/faturas">Faturas</NavLink>
            <NavLink to="/master/planos">Planos</NavLink>
            <NavLink to="/master/modulos">Módulos</NavLink>
            <NavLink to="/master/configuracoes">Configurações</NavLink>
          </nav>
        </div>
        <div className="app-user">
          <Link className="btn-secondary" to="/app">
            Voltar ao Gestão Atendimento Pro
          </Link>
        </div>
      </header>
      <main className="app-body app-body-master">
        <Outlet />
      </main>
    </div>
  );
}
