import { supabase } from "../../lib/supabaseClient";
import { createPushClient, type RegistrationLike } from "./pushClient";
import type { PushEnv, SectorOption } from "./pushLogic";

// Ligação REAL do cliente de push: navegador (service worker, Notification, display-mode), Supabase (RPCs e a
// Edge Function push-test) e a chave pública VAPID (VITE_VAPID_PUBLIC_KEY; a privada só existe na Edge).

const REGISTRATION_TIMEOUT_MS = 4000;

function vapidKey(): string | undefined {
  const key = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined)?.trim();
  return key ? key : undefined;
}

export function readPushEnv(): PushEnv {
  const hasWindow = typeof window !== "undefined" && typeof navigator !== "undefined";
  const standalone =
    hasWindow &&
    ((window.matchMedia?.("(display-mode: standalone)").matches ?? false) ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true);
  return {
    hasServiceWorker: hasWindow && "serviceWorker" in navigator,
    hasPushManager: hasWindow && "PushManager" in window,
    hasNotification: hasWindow && "Notification" in window,
    permission: hasWindow && "Notification" in window ? Notification.permission : "unsupported",
    userAgent: hasWindow ? navigator.userAgent : "",
    platform: hasWindow ? navigator.platform : "",
    maxTouchPoints: hasWindow ? navigator.maxTouchPoints : 0,
    standalone,
    hasVapidKey: vapidKey() !== undefined,
  };
}

async function getRegistration(): Promise<RegistrationLike> {
  // Em desenvolvimento não há service worker: navigator.serviceWorker.ready nunca resolve, daí o timeout.
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("service worker indisponível")), REGISTRATION_TIMEOUT_MS)),
  ]);
  return registration as unknown as RegistrationLike;
}

export const SESSION_EXPIRED_TEXT = "Sua sessão expirou ou foi encerrada em outro aparelho. Saia e entre novamente.";

async function invokeTest(deviceId: string): Promise<{ ok: boolean; error: string | null }> {
  // O JWT guardado no navegador pode continuar "válido" (assinatura/validade) depois que a SESSÃO foi encerrada em
  // outro aparelho; a Edge valida a sessão no Auth. Conferir antes dá a mensagem certa (e o supabase-js limpa a
  // sessão morta) em vez de um erro genérico.
  const { error: sessionError } = await supabase.auth.getUser();
  if (sessionError) {
    console.error("push-test: sessão inválida no Auth:", (sessionError as { code?: string }).code ?? sessionError.name);
    return { ok: false, error: SESSION_EXPIRED_TEXT };
  }
  const { error } = await supabase.functions.invoke("push-test", { body: { device_id: deviceId } });
  if (!error) return { ok: true, error: null };
  // Erros HTTP da função trazem uma mensagem amigável no corpo ({ error }); nunca texto técnico.
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === "function") {
    const body = (await context.json().catch(() => null)) as { error?: string; reason?: string } | null;
    if (body?.reason) console.error("push-test: recusado pela função:", body.reason);
    if (body?.error) return { ok: false, error: body.error };
  }
  return { ok: false, error: "Não foi possível enviar a notificação de teste." };
}

async function listSectors(companyId: string): Promise<SectorOption[]> {
  const { data } = await supabase.from("production_sectors").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name");
  return (data ?? []) as SectorOption[];
}

// localStorage com try/catch (modo privado ou armazenamento bloqueado: segue sem lembrar nada).
const storage = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const pushClient = createPushClient({
  getEnv: readPushEnv,
  storage,
  getRegistration,
  requestPermission: () => Notification.requestPermission(),
  rpc: async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    return { data, error: error ? { message: error.message } : null };
  },
  invokeTest,
  vapidPublicKey: vapidKey,
  listSectors,
});
