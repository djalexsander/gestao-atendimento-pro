import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "../employees/Modal";
import { NotificationSettings } from "./NotificationSettings";
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
