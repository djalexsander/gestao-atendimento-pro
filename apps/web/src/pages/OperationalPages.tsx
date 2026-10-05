import { NotificationsButton } from "../features/notifications/NotificationEntryPoints";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { canOpenOperationalArea, homePathForRole, OPERATIONAL_PATH } from "../app/accessRules";
import { useAuth } from "../app/useAuth";
import { supabaseCashSource } from "../features/cash/cashApi";
import { CashControl } from "../features/cash/CashControl";
import { useMyOpenCash } from "../features/cash/useMyOpenCash";
import { Modal } from "../features/employees/Modal";
import { ROLE_LABEL } from "../features/employees/roles";
import type { ServicePanelSource } from "../features/operations/api";
import type { OpenSessionsSource } from "../features/operations/openSessionsApi";
import { OpenAttendancesBoard } from "../features/operations/OpenAttendancesBoard";
import { LabelsPage } from "../features/labels/LabelsPage";
import { OrdersBoard } from "../features/ordersBoard/OrdersBoard";
import type { OrdersBoardApi } from "../features/ordersBoard/ordersBoardApi";
import { ServicePointsPanel } from "../features/operations/ServicePointsPanel";
import { ProductionBoard } from "../features/production/ProductionBoard";
import type { ProductionSource } from "../features/production/productionApi";
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
  const role = activeMembership?.role ?? null;
  const pathname = useLocation().pathname;
  const onOpenBoard = pathname === OPERATIONAL_PATH.abertos;
  const onOrdersBoard = pathname === OPERATIONAL_PATH.pedidos;
  const canSeeOpenBoard = role !== null && canOpenOperationalArea(role, "abertos");
  const onLabels = pathname === OPERATIONAL_PATH.etiquetas;
  const canSeeLabels = role !== null && canOpenOperationalArea(role, "etiquetas");
  const isAdminRole = role === "owner" || role === "admin";
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
          {canSeeOpenBoard && !onOpenBoard && (
            <Link to={OPERATIONAL_PATH.abertos} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
              Atendimentos abertos
            </Link>
          )}
          {canSeeOpenBoard && !onOrdersBoard && (
            <Link to={OPERATIONAL_PATH.pedidos} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
              Pedidos
            </Link>
          )}
          {canSeeLabels && !onLabels && (
            <Link to={OPERATIONAL_PATH.etiquetas} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
              Etiquetas
            </Link>
          )}
          {(onOpenBoard || onOrdersBoard || onLabels) && role && !isAdminRole && (
            <Link to={homePathForRole(role)} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
              Voltar
            </Link>
          )}
          {isAdminRole && (
            <Link to="/app" className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
              Voltar ao Administrativo
            </Link>
          )}
          <NotificationsButton />
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

// Produção / Cozinha (KDS): pendentes, em preparo e prontos por setor, em tempo real.
export function OperationalProductionPage({ source }: { source?: ProductionSource }) {
  return (
    <OperationalShell title="Produção">
      <ProductionBoard source={source} />
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

// Comandas / Mesas abertas: painel em tempo real de tudo o que está aberto (owner, admin, cashier,
// attendant). `source` só existe para exercitar a tela com dados simulados.
export function OperationalOpenAttendancesPage({ source }: { source?: OpenSessionsSource }) {
  const { activeMembership } = useAuth();
  const role = activeMembership?.role ?? null;
  // "Abrir atendimento" do estado vazio leva ao painel de Comandas / Mesas da área do papel.
  const emptyAction = {
    label: "Abrir atendimento",
    path: role === "attendant" ? OPERATIONAL_PATH.atendimento : OPERATIONAL_PATH.caixa,
  };
  return (
    <OperationalShell title="Comandas / Mesas abertas">
      <OpenAttendancesBoard source={source} emptyAction={emptyAction} />
    </OperationalShell>
  );
}

// Etiquetas e impressão livre (produto, livre, comanda/mesa) pela fila de impressão existente.
export function OperationalLabelsPage() {
  return (
    <OperationalShell title="Etiquetas">
      <LabelsPage />
    </OperationalShell>
  );
}

// Pedidos: histórico operacional (consulta) dos pedidos enviados, por período. `source` só existe para
// exercitar a tela com dados simulados.
export function OperationalOrdersPage({ source }: { source?: OrdersBoardApi }) {
  return (
    <OperationalShell title="Pedidos">
      <OrdersBoard source={source} />
    </OperationalShell>
  );
}
