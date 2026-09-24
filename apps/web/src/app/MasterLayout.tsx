import { Link, NavLink, Outlet } from "react-router-dom";

// Layout deliberadamente separado do AppLayout: o Painel Master não é uma
// empresa nem usa activeCompanyId/CompanySwitcher — é um contexto global à
// parte, só acessível a quem tem privilégio master_admin (ver MasterRoute).
// Empresas, Assinaturas e Faturas entram aqui nas próximas fases.
export function MasterLayout() {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <div className="brand">OrçaFácil</div>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>Painel Master</span>
          <nav className="app-nav">
            <NavLink to="/master" end>
              Visão geral
            </NavLink>
            <NavLink to="/master/planos">Planos</NavLink>
            <NavLink to="/master/modulos">Módulos</NavLink>
          </nav>
        </div>
        <div className="app-user">
          <Link className="btn-secondary" to="/app">
            Voltar ao OrçaFácil
          </Link>
        </div>
      </header>
      <main className="app-body">
        <Outlet />
      </main>
    </div>
  );
}
