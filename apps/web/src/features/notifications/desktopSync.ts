import { desktopRoute, type DesktopNativeStatus } from "./desktopNotify";

// Cliente do canal Desktop (puro: tudo injetado). O servidor decide QUEM recebe QUÊ (push_role_receives) e cria as
// entregas; aqui o Desktop só registra este computador, reivindica as entregas válidas (claim), mostra o toast nativo e
// confirma. O Realtime só ACORDA o app; a entrega confiável é o claim por RPC.

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface DesktopDeviceState {
  isEnabled: boolean;
  isActive: boolean;
  lastSeenAt: string | null;
  // Setores acompanhados (só production). null = todos.
  sectorIds: string[] | null;
}

export interface Claimed {
  id: string;
  title: string;
  body: string;
  url: string;
}

export interface DesktopSyncDeps {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
  show(n: { title: string; body: string; url: string | null }): Promise<boolean>;
  nativeStatus(): Promise<DesktopNativeStatus>;
  deviceId(): string;
}

const MAX_ROUNDS = 5; // proteção contra laço (5 x 20)

function toState(data: unknown): DesktopDeviceState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return {
    isEnabled: d.is_enabled === true,
    isActive: d.is_active === true,
    lastSeenAt: typeof d.last_seen_at === "string" ? d.last_seen_at : null,
    sectorIds: Array.isArray(d.sector_ids) ? d.sector_ids.map(String) : null,
  };
}

export function createDesktopSync(deps: DesktopSyncDeps) {
  let draining: Promise<number> | null = null;

  async function register(companyId: string, deviceName: string | null): Promise<DesktopDeviceState | null> {
    const { data, error } = await deps.rpc("register_desktop_notification_device", { p_company_id: companyId, p_device_id: deps.deviceId(), p_device_name: deviceName });
    return error ? null : toState(data);
  }

  async function heartbeat(companyId: string): Promise<DesktopDeviceState | null> {
    const { data, error } = await deps.rpc("heartbeat_desktop_notification_device", { p_company_id: companyId, p_device_id: deps.deviceId() });
    return error ? null : toState(data);
  }

  async function setEnabled(companyId: string, enabled: boolean): Promise<DesktopDeviceState | null> {
    const { data, error } = await deps.rpc("set_desktop_notification_enabled", { p_company_id: companyId, p_device_id: deps.deviceId(), p_enabled: enabled });
    return error ? null : toState(data);
  }

  // Salva os setores deste Desktop (null = todos). O servidor valida papel, setores ativos e da mesma empresa.
  async function setSectors(companyId: string, sectorIds: string[] | null): Promise<{ state: DesktopDeviceState | null; error: string | null }> {
    const { data, error } = await deps.rpc("set_desktop_notification_sectors", { p_company_id: companyId, p_device_id: deps.deviceId(), p_sector_ids: sectorIds });
    return error ? { state: null, error: error.message } : { state: toState(data), error: null };
  }

  async function deactivate(): Promise<void> {
    await deps.rpc("deactivate_desktop_notification_device", { p_device_id: deps.deviceId() }).catch(() => undefined);
  }

  // Reivindica e mostra TUDO que está pendente e válido. Uma execução por vez (chamadas simultâneas esperam a atual), então
  // o mesmo sinal (Realtime + timer + foco) nunca gera dois toasts. Devolve quantos toasts foram mostrados.
  function drain(companyId: string): Promise<number> {
    if (draining) return draining;
    draining = (async () => {
      let shown = 0;
      try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          const { data, error } = await deps.rpc("claim_desktop_notifications", { p_company_id: companyId, p_device_id: deps.deviceId(), p_limit: 20 });
          if (error || !Array.isArray(data) || data.length === 0) break;
          const status = await deps.nativeStatus();
          for (const raw of data as Array<Record<string, unknown>>) {
            const item: Claimed = { id: String(raw.id), title: String(raw.title ?? ""), body: String(raw.body ?? ""), url: String(raw.url ?? "/") };
            // O Windows bloqueou os toasts do app: não finge entrega.
            const ok = status === "blocked" ? false : await deps.show({ title: item.title, body: item.body, url: desktopRoute(item.url) });
            await deps.rpc("complete_desktop_notification", { p_delivery_id: item.id, p_ok: ok });
            if (ok) shown += 1;
          }
          if (data.length < 20) break;
        }
      } catch {
        /* melhor esforço: o próximo sinal/timer tenta de novo */
      } finally {
        draining = null;
      }
      return shown;
    })();
    return draining;
  }

  return { register, heartbeat, setEnabled, setSectors, deactivate, drain };
}

export type DesktopSync = ReturnType<typeof createDesktopSync>;

export const HEARTBEAT_MS = 60_000; // fallback leve se o Realtime cair: batimento + claim por minuto

export function newDeviceId(random: () => string = () => crypto.randomUUID()): string {
  return random();
}

export const DEVICE_ID_KEY = "gap.desktop.device-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// device_id gerado UMA vez e preservado localmente. Valor corrompido é regerado.
export function readOrCreateDeviceId(
  store: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null,
  random: () => string = () => crypto.randomUUID(),
): string {
  try {
    const current = store?.getItem(DEVICE_ID_KEY) ?? null;
    if (current && UUID.test(current)) return current;
  } catch {
    /* sem armazenamento */
  }
  const created = random();
  try {
    store?.setItem(DEVICE_ID_KEY, created);
  } catch {
    /* sem armazenamento: o id vale só nesta execução */
  }
  return created;
}
