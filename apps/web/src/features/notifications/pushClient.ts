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

// Operações de push do navegador + RPCs, com TODAS as dependências injetadas (navegador, Supabase, chave VAPID,
// armazenamento local). Sem imports de runtime além de pushLogic: testável à parte. A ligação real fica em
// pushBrowser.ts.
//
// Regras:
//   * Notification.requestPermission() só dentro de enable(), que a tela chama por um clique do usuário, e
//     ANTES de qualquer outro await (iOS exige o gesto do usuário).
//   * Fora do PWA instalado no iOS, ou sem suporte, enable() nem chega a pedir permissão.
//   * O envio de push NUNCA sai do frontend: aqui só se registra o aparelho e se pede a notificação de teste.
//
// Dois níveis separados (aparelho compartilhado entre usuários):
//   A) a ASSINATURA FÍSICA do navegador (permissão + pushManager): sobrevive a logout/login e a troca de usuário;
//   B) a ASSOCIAÇÃO dessa assinatura com o usuário/empresa ATUAL no servidor (register/remove_push_subscription).
//   Logout só desfaz B (por segurança): não cancela a assinatura física, não revoga a permissão e NÃO conta como
//   opt-out. No servidor cada usuário tem a SUA linha em cada aparelho (setores e nome ficam nela, mesmo inativa). Ao entrar de novo, autoRegister() refaz B sozinho, SEM pedir permissão e sem clique, se a permissão já
//   está concedida e a assinatura física existe. O único jeito de ficar desligado é "Desativar neste aparelho"
//   (opt-out local, por usuário), até o usuário clicar em "Ativar notificações" de novo.

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

export const AUTO_REGISTER_FAILED_TEXT = "Não foi possível reativar as notificações neste aparelho. Toque em Ativar notificações para tentar de novo.";

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

// Armazenamento local (localStorage em produção; falhas são engolidas). Guarda SÓ o opt-out manual por usuário. Os
// setores NÃO ficam aqui: o servidor (uma linha por usuário em cada aparelho) é a fonte da verdade.
export interface PushStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const optOutKey = (userId: string) => `gap.push.optout.${userId}`;

export type AutoRegisterResult = "registered" | "already-active" | "detached" | "skipped" | "failed";

export interface PushDeps {
  getEnv(): PushEnv;
  storage: PushStorage;
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

  // Registra (ou reassocia) a assinatura física ao usuário/empresa ATUAIS. O servidor valida o vínculo ativo, desativa
  // qualquer outra associação do mesmo endpoint e nunca recebe user_id do frontend.
  async function registerSubscription(subscription: SubscriptionLike, companyId: string, deviceName: string | null): Promise<string> {
    const env = deps.getEnv();
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
  }

  async function devicesOf(companyId: string): Promise<PushDevice[]> {
    const subscription = await subscriptionOrNull();
    const { data, error } = await deps.rpc("my_push_devices", { p_company_id: companyId, p_endpoint: subscription?.endpoint ?? null });
    if (error || !Array.isArray(data)) return [];
    return (data as RawDevice[]).map(toDevice);
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

    // O usuário desativou ESTE aparelho de propósito? (por usuário; o logout nunca grava isto)
    isOptedOut(userId: string): boolean {
      return deps.storage.get(optOutKey(userId)) === "1";
    },

    // Chamar SOMENTE por um clique do usuário. Limpa o opt-out manual e devolve o id do aparelho registrado.
    async enable(companyId: string, deviceName: string | null = null, userId: string | null = null): Promise<string> {
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

      const deviceId = await registerSubscription(subscription, companyId, deviceName);
      if (userId) deps.storage.remove(optOutKey(userId)); // o clique em "Ativar" desfaz o opt-out manual
      return deviceId;
    },

    // Ao entrar um usuário num navegador que JÁ TEM assinatura física, o estado final tem de ser seguro:
    //   * usuário que deve receber push  -> register_push_subscription (reassocia ao usuário atual e, na MESMA
    //     transação, desativa a associação de qualquer outro usuário naquele endpoint);
    //   * usuário que NÃO deve receber (opt-out manual, permissão não concedida) -> detach_push_endpoint (desativa
    //     QUALQUER associação ativa do endpoint, inclusive a de um usuário anterior cujo logout falhou, e não ativa
    //     ninguém). Nunca registra-e-depois-remove: o usuário atual jamais fica ativo, nem por um instante.
    // NUNCA pede permissão e NUNCA cria assinatura: sem assinatura física conhecida não faz nada (não chama detach).
    //   skipped         sem suporte / iOS fora do PWA / sem assinatura física
    //   already-active  o servidor já tem a associação ATIVA deste aparelho com o usuário atual
    //   registered      reassociou ao usuário atual
    //   detached        usuário atual não deve receber: nenhuma associação ativa ficou no endpoint
    //   failed          tentou e o servidor recusou ou a rede falhou
    async autoRegister(companyId: string, userId: string): Promise<AutoRegisterResult> {
      try {
        const env = deps.getEnv();
        if (unsupportedReason(env) !== null || (isIos(env) && !env.standalone)) return "skipped";
        const subscription = await subscriptionOrNull();
        if (!subscription) return "skipped";

        if (env.permission !== "granted" || deps.storage.get(optOutKey(userId)) === "1") {
          const { error } = await deps.rpc("detach_push_endpoint", { p_company_id: companyId, p_endpoint: subscription.endpoint });
          return error ? "failed" : "detached";
        }

        const current = (await devicesOf(companyId)).find((d) => d.isCurrent);
        if (current?.isActive) return "already-active";
        // O servidor reativa a linha DESTE usuário neste aparelho (com os setores/nome que ele já tinha) ou cria uma.
        await registerSubscription(subscription, companyId, null);
        return "registered";
      } catch {
        return "failed";
      }
    },

    // "Desativar neste aparelho" = opt-out MANUAL: grava o opt-out local deste usuário e desativa a associação no
    // servidor. NÃO cancela a assinatura física (os outros usuários do aparelho seguem independentes). Só um clique
    // em "Ativar notificações" desfaz.
    async disable(userId: string | null = null): Promise<void> {
      if (userId) deps.storage.set(optOutKey(userId), "1");
      const subscription = await subscriptionOrNull();
      if (!subscription) return;
      await deps.rpc("remove_push_subscription", { p_endpoint: subscription.endpoint }).catch(() => undefined);
    },

    // Antes do logout: desativa a associação no servidor (segurança). NUNCA lança e NUNCA passa de `timeoutMs`. NÃO
    // grava opt-out e NÃO cancela a assinatura física: logout é só fim de sessão. O servidor continua protegido de
    // qualquer forma: vínculo inativo/sem associação não recebe push.
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

    devices: devicesOf,

    // Salva as opções do aparelho (setores; null = todos). Só a RPC set_push_device_options, que age na linha do
    // PRÓPRIO usuário e valida vínculo, papel production e setores ativos da empresa. Devolve a mensagem de erro, se houver.
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
