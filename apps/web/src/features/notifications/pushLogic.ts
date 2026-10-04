// Regras PURAS das notificações push (sem React, sem Supabase, sem acesso ao navegador): detecção de plataforma
// e de suporte, estado da ativação, conversão da chave VAPID, validação de rotas de deep link, rótulos da lista
// de aparelhos e escolha de setores. O navegador e o Supabase entram só em pushBrowser.ts.
//
// Compatibilidade (sem prometer entrega garantida):
//   * Android Chrome/Edge: push funciona com o app instalado ou aberto no navegador.
//   * iPhone/iPad: SÓ com o PWA instalado na Tela de Início e iOS 16.4 ou superior; a permissão tem de nascer de
//     um toque do usuário. Fora do PWA instalado, não se pede permissão.
//   * Desktop Chrome/Edge: com o navegador aberto ou em segundo plano.

export type PushState = "unsupported" | "ios-not-installed" | "denied" | "not-subscribed" | "subscribed";

export type PushPlatform = "ios" | "android" | "desktop" | "unknown";

// O que o ambiente (navegador) informa; montado em pushBrowser.ts e simulado nos testes.
export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | "unsupported";
  userAgent: string;
  platform: string; // navigator.platform
  maxTouchPoints: number;
  standalone: boolean; // PWA instalado (display-mode standalone / navigator.standalone)
  hasVapidKey: boolean;
}

export const IOS_MIN_VERSION: [number, number] = [16, 4];

export const IOS_INSTALL_MESSAGE = "Instale o Gestão Atendimento Pro na Tela de Início para ativar notificações.";

export function isIos(env: Pick<PushEnv, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  if (/iPhone|iPad|iPod/i.test(env.userAgent)) return true;
  // iPadOS 13+ se apresenta como Macintosh, mas tem tela de toque
  return /Macintosh|MacIntel/i.test(env.userAgent + " " + env.platform) && env.maxTouchPoints > 1;
}

// "OS 16_4" (UA do iPhone) ou "Version/16.4" (UA do Safari). null = não foi possível saber.
export function iosVersion(userAgent: string): [number, number] | null {
  const m = /OS (\d+)[_.](\d+)/.exec(userAgent) ?? /Version\/(\d+)\.(\d+)/.exec(userAgent);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function iosVersionSupported(userAgent: string): boolean {
  const v = iosVersion(userAgent);
  if (!v) return true; // sem como saber: deixa a checagem de PushManager decidir
  return v[0] > IOS_MIN_VERSION[0] || (v[0] === IOS_MIN_VERSION[0] && v[1] >= IOS_MIN_VERSION[1]);
}

export function detectPlatform(env: Pick<PushEnv, "userAgent" | "platform" | "maxTouchPoints">): PushPlatform {
  if (isIos(env)) return "ios";
  if (/Android/i.test(env.userAgent)) return "android";
  if (/Windows|Macintosh|Linux|CrOS|X11/i.test(env.userAgent + " " + env.platform)) return "desktop";
  return "unknown";
}

// Por que a ativação não está disponível (só quando o estado é "unsupported").
export type UnsupportedReason = "browser" | "ios-version" | "not-configured";

export function unsupportedReason(env: PushEnv): UnsupportedReason | null {
  if (isIos(env) && env.standalone && !iosVersionSupported(env.userAgent)) return "ios-version";
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "browser";
  if (!env.hasVapidKey) return "not-configured";
  return null;
}

// Estado do aparelho NESTE navegador. `hasSubscription` = o navegador tem uma assinatura de push.
export function computePushState(env: PushEnv, hasSubscription: boolean): PushState {
  // iOS fora do PWA instalado: nunca pede permissão antes de instalar.
  if (isIos(env) && !env.standalone) return "ios-not-installed";
  if (unsupportedReason(env) !== null) return "unsupported";
  if (env.permission === "denied") return "denied";
  return hasSubscription && env.permission === "granted" ? "subscribed" : "not-subscribed";
}

export const STATE_LABEL: Record<PushState, string> = {
  unsupported: "Não suportado",
  "ios-not-installed": "Instale na Tela de Início",
  denied: "Bloqueado",
  "not-subscribed": "Não configurado",
  subscribed: "Ativado",
};

export const UNSUPPORTED_TEXT: Record<UnsupportedReason, string> = {
  browser: "Este navegador não suporta notificações push.",
  "ios-version": "Notificações exigem iOS 16.4 ou superior. Atualize o aparelho para ativar.",
  "not-configured": "As notificações ainda não estão configuradas neste ambiente.",
};

export const DENIED_TEXT =
  "As notificações estão bloqueadas neste aparelho. Libere nas configurações do navegador/sistema e volte aqui.";

// Chave pública VAPID (base64url) -> bytes para applicationServerKey (snippet padrão da Web Push API).
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// --- Deep link ----------------------------------------------------------------------------------

export const PUSH_NAVIGATE = "PUSH_NAVIGATE";

// Só rota interna do app (começa com uma barra, nunca "//", nunca esquema). Qualquer outra coisa vira null.
export function safeInternalPath(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\") || /[\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed.length > 500 ? null : trimmed;
}

// Mensagem do service worker -> rota. Qualquer outro formato é ignorado.
export function parsePushNavigateMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as { type?: unknown; url?: unknown };
  return msg.type === PUSH_NAVIGATE ? safeInternalPath(msg.url) : null;
}

// --- Aparelhos e setores --------------------------------------------------------------------------

export interface PushDevice {
  id: string;
  platform: PushPlatform;
  deviceName: string | null;
  isActive: boolean;
  sectorIds: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  isCurrent: boolean;
}

export interface SectorOption {
  id: string;
  name: string;
}

export const PLATFORM_LABEL: Record<PushPlatform, string> = {
  ios: "iPhone/iPad",
  android: "Android",
  desktop: "Computador",
  unknown: "Aparelho",
};

export function defaultDeviceName(platform: PushPlatform): string {
  return PLATFORM_LABEL[platform];
}

export function deviceTitle(device: Pick<PushDevice, "deviceName" | "platform">): string {
  return device.deviceName?.trim() || PLATFORM_LABEL[device.platform];
}

export function deviceStatusLabel(device: Pick<PushDevice, "isActive">): string {
  return device.isActive ? "Ativo" : "Desativado";
}

// "Nunca usado", "Usado agora há pouco", "Usado há 3 h", "Usado há 2 dias".
export function describeLastUsed(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Ainda sem notificações recebidas";
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (minutes < 2) return "Última notificação agora há pouco";
  if (minutes < 60) return `Última notificação há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Última notificação há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `Última notificação há ${days} ${days === 1 ? "dia" : "dias"}`;
}

// "Todos os setores" | "Cozinha, Bar" (ignora ids que não existem mais).
export function sectorSummary(sectorIds: string[] | null, sectors: SectorOption[]): string {
  if (sectorIds === null) return "Todos os setores";
  const names = sectorIds.map((id) => sectors.find((s) => s.id === id)?.name).filter((n): n is string => Boolean(n));
  return names.length > 0 ? names.join(", ") : "Setores removidos";
}

// Alterna um setor na seleção. null = todos; ao marcar o último que falta, volta a "todos"; nunca fica vazio
// (o servidor recusa array vazio).
export function toggleSector(current: string[] | null, sectorId: string, allSectors: SectorOption[]): string[] | null {
  const all = allSectors.map((s) => s.id);
  const base = current ?? all;
  const next = base.includes(sectorId) ? base.filter((id) => id !== sectorId) : [...base, sectorId];
  if (next.length === 0) return base; // não permite esvaziar
  return next.length === all.length && all.every((id) => next.includes(id)) ? null : next;
}

export function isSectorChecked(current: string[] | null, sectorId: string): boolean {
  return current === null || current.includes(sectorId);
}

// O que cada papel recebe na v1 (texto da tela).
export function roleNotificationSummary(role: string | null): string {
  switch (role) {
    case "production":
      return "Você recebe novos pedidos e cancelamentos dos setores escolhidos neste aparelho.";
    case "attendant":
      return "Você recebe aviso quando um pedido que você enviou fica completo (pronto).";
    case "owner":
    case "admin":
      return "Você recebe um resumo diário das contas a receber e a pagar (vencendo hoje e atrasadas).";
    default:
      return "Seu papel ainda não recebe notificações automáticas.";
  }
}

// Combina o navegador com o servidor: o aparelho só conta como "Ativado" se o servidor também tem a associação
// ATIVA deste endpoint para o usuário (depois de logout ou de trocar de usuário a assinatura do navegador pode
// continuar existindo sem pertencer a ninguém).
export function reconcileState(browserState: PushState, current: PushDevice | null): PushState {
  if (browserState !== "subscribed") return browserState;
  return current?.isActive ? "subscribed" : "not-subscribed";
}
