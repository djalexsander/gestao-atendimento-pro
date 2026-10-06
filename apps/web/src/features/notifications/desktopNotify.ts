// Notificações do DESKTOP (Tauri). O WebView2 não tem Web Push (sem serviço de push; Notification.permission fica
// "denied"), então no Desktop o canal é o toast nativo do Windows, mostrado pelo Rust. As REGRAS de quem recebe o quê
// continuam no servidor (push_role_receives); aqui só há estado e a chamada que mostra o toast. A preferência
// "Desativar neste computador" é do servidor (desktop_notification_devices.is_enabled).

export type DesktopNativeStatus = "enabled" | "blocked" | "unavailable";
export type DesktopNotifyState = "active" | "disabled" | "blocked" | "unavailable";

export const DESKTOP_STATE_LABEL: Record<DesktopNotifyState, string> = {
  active: "Ativas",
  disabled: "Desativadas",
  blocked: "Bloqueadas no Windows",
  unavailable: "Indisponíveis",
};

export const DESKTOP_BLOCKED_TEXT =
  "O Windows está bloqueando as notificações deste aplicativo. Abra Configurações do Windows → Sistema → Notificações, libere o Gestão Atendimento Pro e toque em Verificar novamente.";
export const DESKTOP_UNAVAILABLE_TEXT = "Não foi possível acessar as notificações do Windows neste computador.";
export const DESKTOP_SCOPE_TEXT =
  "O Desktop recebe as notificações do seu papel enquanto o aplicativo estiver aberto. Com o aplicativo fechado, os avisos que ainda estiverem válidos aparecem quando você abrir de novo; os vencidos são descartados.";

// Rota interna PERMITIDA no Desktop (espelha o Rust): só /app... e /operacional..., sem esquema, "//", barra invertida, caracteres
// de controle ou mais de 500 caracteres. Tudo o mais (http, https, //x, javascript:, file:) é rejeitado: o clique só foca o app.
export function desktopRoute(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const t = url.trim();
  // eslint-disable-next-line no-control-regex
  if (t.startsWith("//") || t.includes("\\") || /[\u0000-\u001f]/.test(t) || t.length > 500) return null;
  return /^\/(app|operacional)(\/|\?|$)/.test(t) ? t : null;
}

export const DESKTOP_TEST = { title: "Gestão Atendimento Pro", body: "Notificações do Desktop ativadas com sucesso.", url: "/app/configuracoes/notificacoes" } as const;

// Estado mostrado: o Windows manda (bloqueado vence), depois a escolha do usuário neste computador.
export function desktopState(status: DesktopNativeStatus, optedOut: boolean): DesktopNotifyState {
  if (status === "unavailable") return "unavailable";
  if (status === "blocked") return "blocked";
  return optedOut ? "disabled" : "active";
}

// Rótulo do tipo de aparelho na lista "Meus aparelhos" (a assinatura de push é do NAVEGADOR/PWA, nunca do Desktop).
export const DEVICE_KIND_LABEL = {
  ios: "iPhone/iPad (PWA instalado)",
  android: "Android (navegador/PWA)",
  desktop: "Navegador no computador (Chrome/Edge ou PWA)",
  unknown: "Aparelho",
} as const;

export interface DesktopNotifyDeps {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

async function defaultInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// Rota pendente do clique no toast (app iniciado pelo clique): o Rust guarda em memória e o frontend pronto consome UMA vez.
export async function takePendingRoute(deps: DesktopNotifyDeps = {}): Promise<string | null> {
  try {
    return desktopRoute(await (deps.invoke ?? defaultInvoke)("take_pending_route"));
  } catch {
    return null;
  }
}

export async function readDesktopStatus(deps: DesktopNotifyDeps = {}): Promise<DesktopNativeStatus> {
  try {
    const r = await (deps.invoke ?? defaultInvoke)("desktop_notification_status");
    return r === "blocked" ? "blocked" : r === "enabled" ? "enabled" : "unavailable";
  } catch {
    return "unavailable";
  }
}

// Mostra um toast nativo (a rota, se vier, é validada de novo no Rust). Devolve false se o Windows recusar.
export async function showDesktopNotification(n: { title: string; body: string; url?: string | null }, deps: DesktopNotifyDeps = {}): Promise<boolean> {
  try {
    await (deps.invoke ?? defaultInvoke)("desktop_notify", { title: n.title, body: n.body, url: n.url ?? null });
    return true;
  } catch {
    return false;
  }
}
