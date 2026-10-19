import { useCallback, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { AdminSidebar } from "./AdminSidebar";
import { CompanySwitcher } from "./CompanySwitcher";
import { CommercialBanner } from "../features/commercial/CommercialBanner";
import { isManagedAccount } from "../lib/managedAccount";
import { useAuth } from "./useAuth";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador",
  cashier: "Caixa / Balcão",
  attendant: "Atendente",
  production: "Produção",
  courier: "Entregador",
};

// Páginas com tabelas/listas que pedem a largura maior (demais seguem em 720px).
const WIDE_PATHS = ["/app", "/app/configuracoes/notificacoes", "/app/financeiro/visao", "/app/financeiro/contas-a-receber", "/app/financeiro/contas-a-pagar", "/app/financeiro/caixa", "/app/cadastros/estoque", "/app/cadastros/clientes", "/app/configuracoes/sistema", "/app/financeiro/relatorios", "/app/configuracoes/impressao"];

// Administrativo (owner/admin — a rota /app já garante isso, ver accessRules.ts): sidebar FIXA à esquerda no desktop/notebook
// (acompanha a rolagem da página) e DRAWER no celular/tablet (≤900px): barra compacta fixa no topo com o botão de menu; o drawer
// abre pelo lado, fecha por X, toque fora, ESC ou ao escolher um item. Identidade/papel/sair ficam num topo do CONTEÚDO no
// desktop e no rodapé do drawer no celular (um único componente, mostrado em um lugar por vez via CSS).
function UserCluster({ className }: { className: string }) {
  const { user, profile, activeMembership, isMasterAdmin, signOut } = useAuth();
  // Conta de funcionário: mostra o nome, nunca o e-mail técnico do Auth.
  const identity = isManagedAccount(user) ? (profile?.full_name ?? null) : (user?.email ?? null);
  return (
    <div className={className}>
      <CompanySwitcher />
      <span>{identity}</span>
      {activeMembership && <span className="role-badge">{ROLE_LABEL[activeMembership.role] ?? activeMembership.role}</span>}
      {isMasterAdmin && (
        <Link className="btn-secondary" to="/master">
          Painel Master
        </Link>
      )}
      <button className="btn-secondary" type="button" onClick={() => void signOut()}>
        Sair
      </button>
    </div>
  );
}

export function AppLayout() {
  const { activeMembership } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const closeNav = useCallback(() => setMobileNavOpen(false), []);
  // Só o Financeiro > Caixa (histórico com tabela) usa a largura maior; as demais páginas seguem em 720px.
  const isWidePage = WIDE_PATHS.includes(useLocation().pathname.replace(/\/+$/, ""));

  return (
    <div className="admin-shell">
      <AdminSidebar
        id="admin-sidebar"
        open={mobileNavOpen}
        onClose={closeNav}
        onNavigate={closeNav}
        openerRef={hamburgerRef}
        footer={<UserCluster className="admin-drawer-user" />}
      />
      {mobileNavOpen && <div className="admin-scrim" onClick={closeNav} aria-hidden="true" />}
      <div className="admin-main">
        <div className="admin-mobilebar">
          <button
            ref={hamburgerRef}
            type="button"
            className="admin-hamburger"
            aria-label="Abrir menu"
            aria-expanded={mobileNavOpen}
            aria-controls="admin-sidebar"
            onClick={() => setMobileNavOpen(true)}
          >
            ☰
          </button>
          <span className="admin-mobilebar-title">{activeMembership?.company.name ?? "Gestão Atendimento Pro"}</span>
        </div>
        <header className="admin-topbar">
          <div className="admin-topbar-spacer" />
          <UserCluster className="app-user" />
        </header>
        <CommercialBanner />
        <main className={isWidePage ? "app-body app-body-wide" : "app-body"}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
