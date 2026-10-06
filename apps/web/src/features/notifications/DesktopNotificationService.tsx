import { useEffect } from "react";
import { useAuth } from "../../app/useAuth";
import { isTauri } from "../../lib/appVersion";
import { desktopSync, subscribeDeliveries } from "./desktopSyncBrowser";
import { HEARTBEAT_MS } from "./desktopSync";

// Só no Desktop (Tauri), com o app ABERTO: registra este computador, reivindica as entregas pendentes válidas, acorda por
// Realtime e confere de novo por minuto/foco (fallback leve). Nenhuma regra de destinatário aqui: o servidor decide.
export function DesktopNotificationService() {
  const { user, activeMembership } = useAuth();
  const userId = user?.id ?? null;
  const companyId = activeMembership?.companyId ?? null;

  useEffect(() => {
    if (!isTauri() || !userId || !companyId) return;
    let disposed = false;
    const tick = () => {
      if (disposed) return;
      void desktopSync.heartbeat(companyId).then(() => (disposed ? 0 : desktopSync.drain(companyId)));
    };
    void desktopSync.register(companyId, "Gestão Atendimento Pro Desktop").then(() => {
      if (!disposed) void desktopSync.drain(companyId);
    });
    const unsubscribe = subscribeDeliveries(() => {
      if (!disposed) void desktopSync.drain(companyId);
    });
    const timer = window.setInterval(tick, HEARTBEAT_MS);
    const onFocus = () => tick();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [userId, companyId]);

  return null;
}
