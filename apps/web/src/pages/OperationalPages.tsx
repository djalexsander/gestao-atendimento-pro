import type { ReactNode } from "react";
import { useAuth } from "../app/useAuth";
import { ROLE_LABEL } from "../features/employees/roles";
import type { ServicePanelSource } from "../features/operations/api";
import { ServicePointsPanel } from "../features/operations/ServicePointsPanel";

// Áreas operacionais. Cada rota só abre para o papel dela (ver accessRules.ts) e nenhuma dá
// caminho ao Administrativo. As duas usam o MESMO painel de Comandas / Mesas; o que muda é o
// cabeçalho e a ênfase da busca (no Caixa, pronta para o leitor de código de barras).
function OperationalShell({ title, children }: { title: string; children: ReactNode }) {
  const { activeMembership, profile, signOut } = useAuth();

  return (
    <div className="app-shell op-shell">
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
      <main className="app-body app-body-wide">
        <h2>{title}</h2>
        {children}
      </main>
    </div>
  );
}

// `source` só existe para exercitar a tela com dados simulados; nas rotas fica o padrão (Supabase).
export function OperationalServicePage({ source }: { source?: ServicePanelSource }) {
  return (
    <OperationalShell title="Área de Atendimento">
      <ServicePointsPanel variant="attendant" source={source} />
    </OperationalShell>
  );
}

export function OperationalCashierPage({ source }: { source?: ServicePanelSource }) {
  return (
    <OperationalShell title="Caixa / Balcão">
      <ServicePointsPanel variant="cashier" source={source} />
    </OperationalShell>
  );
}
