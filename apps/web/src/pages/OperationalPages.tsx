import type { ReactNode } from "react";
import { useAuth } from "../app/useAuth";
import { ROLE_LABEL } from "../features/employees/roles";

// Páginas PROVISÓRIAS das áreas operacionais (mesas, comandas, pedidos e caixa chegam nas
// próximas etapas). Já valem para provar o acesso por papel: cada rota só abre para o papel
// dela (ver accessRules.ts) e nenhuma delas dá caminho ao Administrativo.
function OperationalShell({ title, children }: { title: string; children: ReactNode }) {
  const { activeMembership, profile, signOut } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <div className="brand">OrçaFácil</div>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>{activeMembership?.company.name}</span>
        </div>
        <div className="app-user">
          {/* Nome do funcionário; o e-mail técnico do Auth nunca aparece. */}
          <span>{profile?.full_name}</span>
          {activeMembership && <span className="role-badge">{ROLE_LABEL[activeMembership.role]}</span>}
          <button className="btn-secondary" type="button" onClick={() => void signOut()}>
            Sair
          </button>
        </div>
      </header>
      <main className="app-body">
        <h2>{title}</h2>
        {children}
      </main>
    </div>
  );
}

export function OperationalServicePage() {
  return (
    <OperationalShell title="Área de Atendimento">
      <p style={{ color: "var(--text-muted)" }}>
        Em construção: mesas, comandas e pedidos chegam nas próximas etapas.
      </p>
    </OperationalShell>
  );
}

export function OperationalCashierPage() {
  return (
    <OperationalShell title="Caixa / Balcão">
      <p style={{ color: "var(--text-muted)" }}>
        Em construção: recebimento e fechamento de contas chegam nas próximas etapas.
      </p>
    </OperationalShell>
  );
}
