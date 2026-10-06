import { supabase } from "../../lib/supabaseClient";
import { readDesktopStatus, showDesktopNotification } from "./desktopNotify";
import { createDesktopSync, readOrCreateDeviceId } from "./desktopSync";

// Ligação REAL do canal Desktop: Supabase (RPCs e Realtime), toast nativo (Rust) e localStorage (só o device_id).
function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let cachedId: string | null = null;
export function desktopDeviceId(): string {
  cachedId ??= readOrCreateDeviceId(storage());
  return cachedId;
}

export const desktopSync = createDesktopSync({
  rpc: async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    return { data, error: error ? { message: error.message } : null };
  },
  show: showDesktopNotification,
  nativeStatus: readDesktopStatus,
  deviceId: desktopDeviceId,
});

// Realtime só ACORDA: ao chegar uma entrega nova deste dispositivo, chama onSignal (que faz o claim por RPC).
// A RLS da tabela limita cada usuário às próprias linhas.
export function subscribeDeliveries(onSignal: () => void): () => void {
  const channel = supabase
    .channel(`desktop-notifications:${desktopDeviceId()}:${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "desktop_notification_deliveries", filter: `device_id=eq.${desktopDeviceId()}` }, () => onSignal())
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
