import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../app/useAuth";
import { Modal } from "../employees/Modal";
import { NotificationSettings } from "./NotificationSettings";
import { pushClient } from "./pushBrowser";
import { desktopRoute, takePendingRoute } from "./desktopNotify";
import { isTauri } from "../../lib/appVersion";
import { parsePushNavigateMessage } from "./pushLogic";

// Página administrativa: Configurações → Notificações (/app/configuracoes/notificacoes).
export function NotificationSettingsPage() {
  return (
    <div className="fin-page">
      <div className="page-header">
        <h2>Notificações</h2>
      </div>
      <NotificationSettings />
    </div>
  );
}

// Acesso discreto nas telas operacionais (cashier/attendant/production não têm o menu /app): abre o MESMO painel
// num modal, sem dar acesso a nenhuma outra configuração administrativa.
export function NotificationsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-secondary btn-small" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Notificações
      </button>
      {open && (
        <Modal title="Notificações" onClose={() => setOpen(false)}>
          <NotificationSettings />
          <div className="modal-actions">
            <button className="btn-secondary btn-auto" type="button" onClick={() => setOpen(false)}>
              Fechar
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// Deep link: recebe { type: "PUSH_NAVIGATE", url } do service worker (clique na notificação com o app já aberto)
// e navega pelo router. Só aceita rota interna; qualquer outra mensagem é ignorada.
export function PushNavigationListener() {
  const navigate = useNavigate();
  // Desktop (Tauri): o clique no toast nativo (protocolo do app) vira ROTA INTERNA do router, nunca URL web. O Rust valida a
  // rota e dispara o evento (app aberto) ou a guarda como pendente (app iniciado pelo clique); aqui valida de novo.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const go = (raw: unknown) => {
      const path = desktopRoute(raw);
      if (path && !disposed) navigate(path);
    };
    const onDesktop = (event: Event) => {
      go((event as CustomEvent).detail);
      void takePendingRoute(); // já navegou pelo evento: limpa a pendente para não repetir
    };
    window.addEventListener("gap:desktop-navigate", onDesktop);
    void takePendingRoute().then(go); // partida a frio: consome a rota pendente UMA vez
    return () => {
      disposed = true;
      window.removeEventListener("gap:desktop-navigate", onDesktop);
    };
  }, [navigate]);
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const path = parsePushNavigateMessage(event.data);
      if (path) navigate(path);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);
  return null;
}

// Depois do login (ou da troca de usuário no mesmo aparelho): se a permissão já foi concedida e a assinatura física
// existe, reassocia SOZINHA ao usuário/empresa atuais, sem pedir permissão e sem clique. Respeita o opt-out manual
// ("Desativar neste aparelho"). Uma vez por usuário/empresa a cada carregamento; falha silenciosa (a tela de
// Notificações mostra o estado e permite tentar de novo).
export function PushAutoRegister() {
  const { user, activeMembership } = useAuth();
  const userId = user?.id ?? null;
  const companyId = activeMembership?.companyId ?? null;
  useEffect(() => {
    if (!userId || !companyId) return;
    void pushClient.autoRegister(companyId, userId);
  }, [userId, companyId]);
  return null;
}
