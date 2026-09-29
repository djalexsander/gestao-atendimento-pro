import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../app/useAuth";
import { supabaseCashSource } from "../features/cash/cashApi";
import { CashControl } from "../features/cash/CashControl";
import { useMyOpenCash } from "../features/cash/useMyOpenCash";
import { Modal } from "../features/employees/Modal";
import { ROLE_LABEL } from "../features/employees/roles";
import type { ServicePanelSource } from "../features/operations/api";
import { ServicePointsPanel } from "../features/operations/ServicePointsPanel";
import { SessionOrderScreen } from "../features/orders/SessionOrderScreen";
import type { OrdersSource } from "../features/orders/ordersApi";

// Áreas operacionais. Cada rota só abre para o papel dela (ver accessRules.ts) e nenhuma dá
// caminho ao Administrativo. As duas usam o MESMO painel de Comandas / Mesas; o que muda é o
// cabeçalho e a ênfase da busca (no Caixa, pronta para o leitor de código de barras).
const CASH_CHECK_TIMEOUT_MS = 8000;

function OperationalShell({ title, children }: { title: string; children: ReactNode }) {
  const { activeMembership, user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const isCashier = activeMembership?.role === "cashier";
  const { cash: myCash } = useMyOpenCash(isCashier);
  const [logoutBlocked, setLogoutBlocked] = useState<"open-cash" | "unverified" | null>(null);

  // Proteção extra (não é a segurança real: o caixa segue OPEN no banco): enquanto o cashier tem
  // caixa aberto, fechar/atualizar a janela pede confirmação. O listener só existe nesse caso.
  const hasOpenCash = isCashier && myCash !== null;
  useEffect(() => {
    if (!hasOpenCash) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasOpenCash]);

  // Cashier: FAIL CLOSED. Confere no banco na hora do clique (não confia em estado local) e só sai
  // se confirmar que NÃO há caixa aberto. Caixa aberto, erro ou demora na consulta = não sai.
  async function handleSignOut() {
    if (isCashier) {
      if (!activeMembership || !user) {
        setLogoutBlocked("unverified");
        return;
      }
      const timeout = new Promise<{ data: null; error: string }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: "timeout" }), CASH_CHECK_TIMEOUT_MS),
      );
      const result = await Promise.race([supabaseCashSource.getMyOpenCash(activeMembership.companyId, user.id), timeout]).catch(
        () => ({ data: null, error: "falha" }),
      );
      if (result.error) {
        setLogoutBlocked("unverified");
        return;
      }
      if (result.data) {
        setLogoutBlocked("open-cash");
        return;
      }
    }
    await signOut();
  }

  return (
    <div className="app-shell op-shell">
      <header className="app-topbar">
        <div className="app-topbar-left">
          <div className="brand">Gestão Atendimento Pro</div>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>{activeMembership?.company.name}</span>
        </div>
        <div className="app-user">
          {(activeMembership?.role === "owner" || activeMembership?.role === "admin") && (
            <Link to="/app" className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
              Voltar ao Administrativo
            </Link>
          )}
          {/* Nome do funcionário; o e-mail técnico do Auth nunca aparece. */}
          <span>{profile?.full_name}</span>
          {activeMembership && <span className="role-badge">{ROLE_LABEL[activeMembership.role]}</span>}
          <button className="btn-secondary" type="button" onClick={() => void handleSignOut()}>
            Sair
          </button>
        </div>
      </header>
      <main className="app-body app-body-wide">
        <h2>{title}</h2>
        {children}
      </main>
      {logoutBlocked && (
        <Modal title="Caixa" onClose={() => setLogoutBlocked(null)}>
          <p className="modal-text">
            {logoutBlocked === "open-cash"
              ? "Feche seu caixa antes de sair do sistema."
              : "Não foi possível confirmar se o seu caixa está fechado. Verifique sua conexão e tente novamente."}
          </p>
          <div className="modal-actions">
            <button className="btn-secondary" type="button" onClick={() => setLogoutBlocked(null)}>
              Continuar aqui
            </button>
            {logoutBlocked === "open-cash" && (
              <button
                className="btn-primary btn-auto"
                type="button"
                autoFocus
                onClick={() => {
                  setLogoutBlocked(null);
                  navigate("/operacional/caixa");
                }}
              >
                Ir para o caixa
              </button>
            )}
          </div>
        </Modal>
      )}
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
      <CashControl />
      <ServicePointsPanel variant="cashier" source={source} />
    </OperationalShell>
  );
}

// Tela real do atendimento (catálogo + cesta + envio de pedido), aberta a partir de uma comanda/
// mesa "Em atendimento" no painel. `variant` só muda a ênfase de busca/leitor e a rota de volta;
// é o MESMO componente para Atendimento e Caixa (ver SessionOrderScreen.tsx).
export function OperationalServiceOrderPage({ source }: { source?: OrdersSource }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  return (
    <OperationalShell title="Área de Atendimento">
      {sessionId && <SessionOrderScreen sessionId={sessionId} variant="attendant" source={source} />}
    </OperationalShell>
  );
}

export function OperationalCashierOrderPage({ source }: { source?: OrdersSource }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  return (
    <OperationalShell title="Caixa / Balcão">
      {sessionId && <SessionOrderScreen sessionId={sessionId} variant="cashier" source={source} />}
    </OperationalShell>
  );
}
