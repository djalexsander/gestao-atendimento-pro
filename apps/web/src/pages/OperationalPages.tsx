import { NotificationsButton } from "../features/notifications/NotificationEntryPoints";
import { CommercialBanner } from "../features/commercial/CommercialBanner";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { DeliveryBoard } from "../features/delivery/DeliveryBoard";
import type { DeliverySource } from "../features/delivery/deliveryApi";
import { WhatsappInbox } from "../features/whatsapp/WhatsappInbox";
import type { WhatsappSource } from "../features/whatsapp/whatsappApi";
import { moduleAccess } from "../features/commercial/commercialLogic";
import { useCommercial } from "../features/commercial/CommercialProvider";
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

// exportada só para a página de Contatos do WhatsApp reutilizar a MESMA casca (nada muda no cabeçalho)
export function OperationalShell({ title, children }: { title: string; children: ReactNode }) {
  const { activeMembership, user, signOut } = useAuth();
  const navigate = useNavigate();
  const isCashier = activeMembership?.role === "cashier";
  const role = activeMembership?.role ?? null;
  const pathname = useLocation().pathname;
  const onOpenBoard = pathname === OPERATIONAL_PATH.abertos;
  const onOrdersBoard = pathname === OPERATIONAL_PATH.pedidos;
  const canSeeOpenBoard = role !== null && canOpenOperationalArea(role, "abertos");
  const onLabels = pathname === OPERATIONAL_PATH.etiquetas;
  const canSeeLabels = role !== null && canOpenOperationalArea(role, "etiquetas");
  const { entitlements } = useCommercial();
  const onDelivery = pathname === OPERATIONAL_PATH.delivery;
  // a área WhatsApp inclui as telas dentro dela (ex.: /operacional/whatsapp/contatos): o cabeçalho trata todas como "estou no WhatsApp"
  const onWhatsapp = pathname === OPERATIONAL_PATH.whatsapp || pathname.startsWith(`${OPERATIONAL_PATH.whatsapp}/`);
  // WhatsApp só aparece com o módulo liberado (sem oferta comercial: nunca vira "contratar").
  const canSeeWhatsapp = role !== null && canOpenOperationalArea(role, "whatsapp") && moduleAccess(entitlements, "whatsapp") === "allowed";
  // Delivery só aparece quando o módulo está liberado (módulo ainda sem oferta comercial: nada de "contratar").
  const canSeeDelivery = role !== null && canOpenOperationalArea(role, "delivery") && moduleAccess(entitlements, "delivery") === "allowed";
  // "Voltar" leva à tela principal do papel (Dono/Administrador: Administrativo, único ponto de partida deles);
  // não aparece quando já se está nela.
  const homePath = role ? homePathForRole(role) : null;
  const backPath = homePath && homePath !== pathname ? homePath : null;
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
        {/* Cabeçalho enxuto: identificação, perfil (indicador, não clicável), Voltar e Sair. Os atalhos
            entre as telas operacionais ficam na faixa logo abaixo (op-shortcuts). */}
        <div className="app-user">
          {activeMembership && (
            <span className="role-badge" data-testid="op-role-badge">
              {ROLE_LABEL[activeMembership.role]}
            </span>
          )}
          {backPath && (
            <Link to={backPath} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
              Voltar
            </Link>
          )}
          <button className="btn-secondary" type="button" onClick={() => void handleSignOut()}>
            Sair
          </button>
        </div>
      </header>
      <nav className="op-shortcuts" aria-label="Atalhos operacionais">
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
        {canSeeDelivery && !onDelivery && (
          <Link to={OPERATIONAL_PATH.delivery} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
            Delivery
          </Link>
        )}
        {canSeeWhatsapp && !onWhatsapp && (
          <Link to={OPERATIONAL_PATH.whatsapp} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
            WhatsApp
          </Link>
        )}
        {canSeeLabels && !onLabels && (
          <Link to={OPERATIONAL_PATH.etiquetas} className="btn-secondary btn-small" style={{ textDecoration: "none" }}>
            Etiquetas
          </Link>
        )}
        <NotificationsButton />
      </nav>
      <CommercialBanner />
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

// WhatsApp: inbox somente leitura (Fase 2A-1). `source` só existe para exercitar a tela com dados simulados.
export function OperationalWhatsappPage({ source }: { source?: WhatsappSource }) {
  // ?conversation=<id> (vindo de Contatos): a caixa valida e abre; depois o parâmetro sai da URL (replace) para não reabrir ao atualizar
  const [params, setParams] = useSearchParams();
  const requested = params.get("conversation");
  const handled = useCallback(() => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("conversation");
        return next;
      },
      { replace: true },
    );
  }, [setParams]);
  return (
    <OperationalShell title="WhatsApp">
      <WhatsappInbox source={source} requestedConversationId={requested} onRequestHandled={handled} />
    </OperationalShell>
  );
}

// Delivery / Retirada: quadro em tempo real, novo pedido, detalhe e estados. O entregador usa a MESMA tela (o banco
// já devolve só os pedidos atribuídos a ele). `source` só existe para exercitar a tela com dados simulados.
export function OperationalDeliveryPage({ source }: { source?: DeliverySource }) {
  return (
    <OperationalShell title="Delivery">
      <DeliveryBoard source={source} />
    </OperationalShell>
  );
}
