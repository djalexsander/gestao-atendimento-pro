import { useAuth } from "../app/useAuth";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador(a)",
  agent: "Agente",
};

export function AppHomePage() {
  const { user, activeMembership, signOut } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="brand">OrçaFácil</div>
        <div className="app-user">
          <span>{activeMembership?.company.name}</span>
          <span>{user?.email}</span>
          {activeMembership && (
            <span className="role-badge">
              {ROLE_LABEL[activeMembership.role] ?? activeMembership.role}
            </span>
          )}
          <button className="btn-secondary" type="button" onClick={() => void signOut()}>
            Sair
          </button>
        </div>
      </header>
      <main className="app-body">
        <h2>Bem-vindo(a) ao {activeMembership?.company.name}</h2>
        <p style={{ color: "var(--text-muted)" }}>
          O painel completo ainda está em construção. Esta é a base de autenticação e
          multiempresa do OrçaFácil.
        </p>
      </main>
    </div>
  );
}
