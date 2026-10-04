import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { AdminSidebar } from "./AdminSidebar";
import { CompanySwitcher } from "./CompanySwitcher";
import { isManagedAccount } from "../lib/managedAccount";
import { useAuth } from "./useAuth";

const ROLE_LABEL: Record<string, string> = {
  owner: "Dono(a)",
  admin: "Administrador",
  cashier: "Caixa / Balcão",
  attendant: "Atendente",
  production: "Produção",
};

// Páginas com tabelas/listas que pedem a largura maior (demais seguem em 720px).
const WIDE_PATHS = ["/app/financeiro/visao", "/app/financeiro/contas-a-receber", "/app/financeiro/contas-a-pagar", "/app/financeiro/caixa", "/app/cadastros/estoque", "/app/financeiro/relatorios", "/app/configuracoes/impressao"];

// Administrativo (owner/admin — a rota /app já garante isso, ver accessRules.ts): sidebar fixa
// à esquerda no desktop/tablet, vira drawer no mobile. Identidade/papel/sair ficam num topo
// simples do CONTEÚDO (não na sidebar, que é só navegação + marca/empresa).
export function AppLayout() {
  const { user, profile, activeMembership, isMasterAdmin, signOut } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Só o Financeiro > Caixa (histórico com tabela) usa a largura maior; as demais páginas seguem em 720px.
  const isWidePage = WIDE_PATHS.includes(useLocation().pathname.replace(/\/+$/, ""));
  // Conta de funcionário: mostra o nome, nunca o e-mail técnico do Auth.
  const identity = isManagedAccount(user) ? (profile?.full_name ?? null) : (user?.email ?? null);

  return (
    <div className="admin-shell">
      <AdminSidebar open={mobileNavOpen} onNavigate={() => setMobileNavOpen(false)} />
      {mobileNavOpen && (
        <div className="admin-scrim" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
      )}
      <div className="admin-main">
        <header className="admin-topbar">
          <button
            type="button"
            className="admin-hamburger"
            aria-label="Abrir menu"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            ☰
          </button>
          <div className="admin-topbar-spacer" />
          <div className="app-user">
            <CompanySwitcher />
            <span>{identity}</span>
            {activeMembership && (
              <span className="role-badge">
                {ROLE_LABEL[activeMembership.role] ?? activeMembership.role}
              </span>
            )}
            {isMasterAdmin && (
              <Link className="btn-secondary" to="/master">
                Painel Master
              </Link>
            )}
            <button className="btn-secondary" type="button" onClick={() => void signOut()}>
              Sair
            </button>
          </div>
        </header>
        <main className={isWidePage ? "app-body app-body-wide" : "app-body"}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
