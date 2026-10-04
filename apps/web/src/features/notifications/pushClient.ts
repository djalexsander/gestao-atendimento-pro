import {
  computePushState,
  detectPlatform,
  isIos,
  unsupportedReason,
  urlBase64ToUint8Array,
  type PushDevice,
  type PushEnv,
  type PushPlatform,
  type PushState,
  type SectorOption,
} from "./pushLogic";

// Operações de push do navegador + RPCs, com TODAS as dependências injetadas (navegador, Supabase, chave VAPID).
// Sem imports de runtime além de pushLogic: testável à parte. A ligação real fica em pushBrowser.ts.
//
// Regras:
//   * Notification.requestPermission() só dentro de enable(), que a tela chama por um clique do usuário, e
//     ANTES de qualquer outro await (iOS exige o gesto do usuário).
//   * Fora do PWA instalado no iOS, ou sem suporte, enable() nem chega a pedir permissão.
//   * O envio de push NUNCA sai do frontend: aqui só se registra o aparelho e se pede a notificação de teste.

export type PushErrorCode =
  | "unsupported"
  | "ios-not-installed"
  | "denied"
  | "no-service-worker"
  | "subscribe-failed"
  | "register-failed"
  | "test-failed";

export class PushError extends Error {
  code: PushErrorCode;
  constructor(code: PushErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const PUSH_ERROR_TEXT: Record<PushErrorCode, string> = {
  unsupported: "Este aparelho não suporta notificações.",
  "ios-not-installed": "Instale o app na Tela de Início para ativar notificações.",
  denied: "Permissão de notificações negada.",
  "no-service-worker": "O aplicativo ainda não está pronto para notificações. Recarregue a página e tente de novo.",
  "subscribe-failed": "Não foi possível ativar as notificações neste aparelho.",
  "register-failed": "Não foi possível registrar este aparelho. Tente novamente.",
  "test-failed": "Não foi possível enviar a notificação de teste.",
};

export interface SubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

export interface RegistrationLike {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<SubscriptionLike>;
  };
}

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface PushDeps {
  getEnv(): PushEnv;
  // Registro do service worker (pode demorar/falhar em dev, onde não há SW).
  getRegistration(): Promise<RegistrationLike>;
  requestPermission(): Promise<NotificationPermission>;
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
  // Edge Function push-test (JWT do usuário).
  invokeTest(deviceId: string): Promise<{ ok: boolean; error: string | null }>;
  vapidPublicKey(): string | undefined;
  listSectors(companyId: string): Promise<SectorOption[]>;
}

interface RawDevice {
  id: string;
  platform: PushPlatform;
  device_name: string | null;
  is_active: boolean;
  sector_ids: string[] | null;
  created_at: string;
  last_used_at: string | null;
  is_current: boolean;
}

export function toDevice(r: RawDevice): PushDevice {
  return {
    id: r.id,
    platform: r.platform,
    deviceName: r.device_name,
    isActive: r.is_active,
    sectorIds: r.sector_ids,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    isCurrent: r.is_current,
  };
}

export function createPushClient(deps: PushDeps) {
  async function subscriptionOrNull(): Promise<SubscriptionLike | null> {
    try {
      const registration = await deps.getRegistration();
      return await registration.pushManager.getSubscription();
    } catch {
      return null;
    }
  }

  return {
    // Estado do navegador (sem tocar no servidor). Nunca pede permissão.
    async state(): Promise<PushState> {
      const env = deps.getEnv();
      const early = computePushState(env, false);
      if (early === "unsupported" || early === "ios-not-installed" || early === "denied") return early;
      return computePushState(env, (await subscriptionOrNull()) !== null);
    },

    async currentEndpoint(): Promise<string | null> {
      return (await subscriptionOrNull())?.endpoint ?? null;
    },

    // Chamar SOMENTE por um clique do usuário. Devolve o id do aparelho registrado.
    async enable(companyId: string, deviceName: string | null = null): Promise<string> {
      const env = deps.getEnv();
      if (isIos(env) && !env.standalone) throw new PushError("ios-not-installed", PUSH_ERROR_TEXT["ios-not-installed"]);
      if (unsupportedReason(env) !== null) throw new PushError("unsupported", PUSH_ERROR_TEXT.unsupported);
      const key = deps.vapidPublicKey();
      if (!key) throw new PushError("unsupported", PUSH_ERROR_TEXT.unsupported);

      // 1º await da função: a permissão tem de nascer do gesto do usuário.
      const permission = env.permission === "granted" ? "granted" : await deps.requestPermission();
      if (permission !== "granted") throw new PushError("denied", PUSH_ERROR_TEXT.denied);

      let registration: RegistrationLike;
      try {
        registration = await deps.getRegistration();
      } catch {
        throw new PushError("no-service-worker", PUSH_ERROR_TEXT["no-service-worker"]);
      }

      let subscription: SubscriptionLike | null;
      try {
        subscription =
          (await registration.pushManager.getSubscription()) ??
          (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
      } catch {
        throw new PushError("subscribe-failed", PUSH_ERROR_TEXT["subscribe-failed"]);
      }

      const json = subscription.toJSON();
      const keys = json.keys ?? {};
      if (!json.endpoint || !keys.p256dh || !keys.auth) throw new PushError("subscribe-failed", PUSH_ERROR_TEXT["subscribe-failed"]);

      const { data, error } = await deps.rpc("register_push_subscription", {
        p_company_id: companyId,
        p_endpoint: json.endpoint,
        p_p256dh: keys.p256dh,
        p_auth: keys.auth,
        p_platform: detectPlatform(env),
        p_user_agent: env.userAgent.slice(0, 500),
        p_device_name: deviceName,
      });
      if (error || typeof data !== "string") throw new PushError("register-failed", PUSH_ERROR_TEXT["register-failed"]);
      return data;
    },

    // "Desativar neste aparelho": desativa no servidor e cancela a assinatura do navegador.
    async disable(): Promise<void> {
      const subscription = await subscriptionOrNull();
      if (!subscription) return;
      await deps.rpc("remove_push_subscription", { p_endpoint: subscription.endpoint }).catch(() => undefined);
      await subscription.unsubscribe().catch(() => undefined);
    },

    // Antes do logout: desativa a associação no servidor. NUNCA lança e NUNCA passa de `timeoutMs` (não bloqueia
    // o logout). O servidor continua protegido de qualquer forma: vínculo inativo não recebe push.
    async deactivateForLogout(timeoutMs = 2000): Promise<void> {
      try {
        const env = deps.getEnv();
        if (unsupportedReason(env) !== null) return;
        await Promise.race([
          (async () => {
            const subscription = await subscriptionOrNull();
            if (subscription) await deps.rpc("remove_push_subscription", { p_endpoint: subscription.endpoint });
          })(),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch {
        /* melhor esforço */
      }
    },

    async devices(companyId: string): Promise<PushDevice[]> {
      const endpoint = await this.currentEndpoint();
      const { data, error } = await deps.rpc("my_push_devices", { p_company_id: companyId, p_endpoint: endpoint });
      if (error || !Array.isArray(data)) return [];
      return (data as RawDevice[]).map(toDevice);
    },

    async setOptions(deviceId: string, sectorIds: string[] | null, deviceName: string | null = null): Promise<string | null> {
      const { error } = await deps.rpc("set_push_device_options", { p_device_id: deviceId, p_sector_ids: sectorIds, p_device_name: deviceName });
      return error ? error.message : null;
    },

    async sendTest(deviceId: string): Promise<{ ok: boolean; error: string | null }> {
      return deps.invokeTest(deviceId);
    },

    listSectors: (companyId: string) => deps.listSectors(companyId),
  };
}

export type PushClient = ReturnType<typeof createPushClient>;
