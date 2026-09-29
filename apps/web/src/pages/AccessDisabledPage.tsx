import { useAuth } from "../app/useAuth";

// Vínculo desativado (ou conta de funcionário sem vínculo): nunca cai no onboarding.
export function AccessDisabledPage() {
  const { signOut } = useAuth();

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">Gestão Atendimento Pro</div>
        <h1 style={{ fontSize: 22 }}>Acesso desativado.</h1>
        <p style={{ color: "var(--text-muted)" }}>Procure o administrador da empresa.</p>
        <button className="btn-secondary" type="button" onClick={() => void signOut()}>
          Sair
        </button>
      </div>
    </div>
  );
}
