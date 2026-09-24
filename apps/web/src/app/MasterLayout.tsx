import { Link, Outlet } from "react-router-dom";

// Layout deliberadamente separado do AppLayout: o Painel Master não é uma
// empresa nem usa activeCompanyId/CompanySwitcher — é um contexto global à
// parte, só acessível a quem tem privilégio master_admin (ver MasterRoute).
export function MasterLayout() {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <div className="brand">OrçaFácil</div>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>Painel Master</span>
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
