// Atualização do PWA SEM trocar a estratégia (vite-plugin-pwa registerType 'autoUpdate' + skipWaiting + clientsClaim):
// o service worker novo já assume sozinho, mas a PÁGINA em execução continua com os assets antigos até recarregar — e o iOS
// mantém o PWA suspenso por muito tempo, sem nova navegação (que é o que dispara a checagem nativa do SW). Esta camada só
//   1) consulta /version.json (gerado no build a partir de apps/web/package.json),
//   2) pede registration.update() ao service worker,
//   3) mostra "Nova versão disponível" quando a versão publicada é MAIOR que a em execução e
//   4) no clique, atualiza o SW e recarrega UMA vez. Nenhum dado de sessão é tocado.
// Tudo que depende do navegador entra por `env`, então a lógica é testável sem DOM.
import { isNewerVersion, parseSemver } from "../../lib/semver";

export const VERSION_URL = "/version.json";
export const CHECK_INTERVAL_MS = 30 * 60 * 1000; // checagem periódica leve
export const MIN_GAP_MS = 15 * 1000; // visibilitychange + focus + online chegam juntos: uma só consulta
export const SNOOZE_MS = 30 * 60 * 1000; // "Depois": silencia a MESMA versão por ~30 min (nunca para sempre)
export const SW_WAIT_MS = 8000; // espera máxima pelo novo service worker assumir antes de recarregar

export type PwaUpdateStatus = "idle" | "available" | "updating";
export interface PwaUpdateState {
  status: PwaUpdateStatus;
  /** versão publicada mais nova (quando status != idle) */
  version: string | null;
  /** "Depois" ainda dentro da janela de silêncio (~30 min) para esta versão: o banner fica oculto */
  dismissed: boolean;
}
export type CheckReason = "initial" | "visible" | "focus" | "online" | "interval";
export type TriggerEvent = "visible" | "focus" | "online";

export interface SwRegistrationLike {
  update(): Promise<unknown>;
  installing?: unknown;
  waiting?: unknown;
}

export interface PwaUpdateEnv {
  /** versão em execução (__APP_VERSION__) */
  runningVersion: string;
  /** Desktop (Tauri): quem atualiza é o updater do Tauri; nada disto roda */
  isDesktop(): boolean;
  /** versão publicada em /version.json; null em qualquer falha (rede, formato, 404) */
  fetchPublishedVersion(): Promise<string | null>;
  getRegistration(): Promise<SwRegistrationLike | undefined>;
  /** true se um novo service worker assumiu (controllerchange) dentro do prazo */
  waitForControllerChange(ms: number): Promise<boolean>;
  reload(): void;
  on(event: TriggerEvent, cb: () => void): () => void;
  every(ms: number, cb: () => void): () => void;
  now(): number;
}

export interface PwaUpdateController {
  start(): () => void;
  getState(): PwaUpdateState;
  subscribe(listener: () => void): () => void;
  check(reason: CheckReason): Promise<void>;
  dismiss(): void;
  applyNow(): Promise<void>;
}

const IDLE: PwaUpdateState = { status: "idle", version: null, dismissed: false };

export function createPwaUpdateController(env: PwaUpdateEnv, opts: { intervalMs?: number; minGapMs?: number; waitMs?: number; snoozeMs?: number } = {}): PwaUpdateController {
  const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
  const minGapMs = opts.minGapMs ?? MIN_GAP_MS;
  const waitMs = opts.waitMs ?? SW_WAIT_MS;
  const snoozeMs = opts.snoozeMs ?? SNOOZE_MS;
  let state: PwaUpdateState = IDLE;
  const listeners = new Set<() => void>();
  let inFlight = false;
  let lastCheckAt = -Infinity;
  let reloading = false;
  let dismissedFor: string | null = null; // memória só em runtime (nada em storage): reabrir o app avisa de novo
  let dismissedAt = -Infinity;
  const snoozed = (version: string) => dismissedFor === version && env.now() - dismissedAt < snoozeMs;

  const set = (next: PwaUpdateState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  async function check(reason: CheckReason): Promise<void> {
    if (env.isDesktop() || inFlight || reloading) return;
    const now = env.now();
    if (reason !== "initial" && now - lastCheckAt < minGapMs) return;
    inFlight = true;
    lastCheckAt = now;
    try {
      // 1) deixa o navegador buscar o service worker novo (retoma de app suspenso não navega, então não checaria sozinho)
      try {
        const reg = await env.getRegistration();
        if (reg) await reg.update().catch(() => undefined);
      } catch {
        /* sem service worker/erro de rede: nunca derruba o app */
      }
      // 2) compara a versão publicada com a em execução
      const published = await env.fetchPublishedVersion().catch(() => null);
      if (published && isNewerVersion(published, env.runningVersion)) {
        if (state.status === "updating") return;
        set({ status: "available", version: published, dismissed: snoozed(published) });
      } else if (state.status === "available") {
        set(IDLE); // já está na versão publicada (ou a publicada deixou de ser maior): some o banner
      }
    } finally {
      inFlight = false;
    }
  }

  function dismiss(): void {
    if (state.status !== "available") return;
    dismissedFor = state.version;
    dismissedAt = env.now();
    set({ ...state, dismissed: true });
  }

  async function applyNow(): Promise<void> {
    if (state.status !== "available" || reloading) return; // clique duplo não recarrega duas vezes
    reloading = true;
    set({ ...state, status: "updating", dismissed: false });
    try {
      const reg = await env.getRegistration();
      if (reg) {
        // escuta ANTES de pedir o update: o novo worker pode assumir (clientsClaim) a qualquer instante
        const took = env.waitForControllerChange(waitMs);
        await reg.update().catch(() => undefined);
        if (reg.installing || reg.waiting) await took;
      }
    } catch {
      /* erro de update não impede o reload controlado */
    }
    env.reload(); // UMA vez; a sessão do Supabase (localStorage) permanece como num reload normal
  }

  function start(): () => void {
    if (env.isDesktop()) return () => undefined;
    const offs = [
      env.on("visible", () => void check("visible")),
      env.on("focus", () => void check("focus")),
      env.on("online", () => void check("online")),
      env.every(intervalMs, () => void check("interval")),
    ];
    void check("initial");
    return () => offs.forEach((off) => off());
  }

  return {
    start,
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    check,
    dismiss,
    applyNow,
  };
}

/** Lê /version.json sem cache (no-store + timestamp). Qualquer falha ou formato inesperado => null. */
export async function fetchPublishedVersion(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<string | null> {
  try {
    const r = await fetchImpl(`${VERSION_URL}?t=${now()}`, { cache: "no-store", headers: { "Cache-Control": "no-cache" } });
    if (!r.ok) return null;
    const body = (await r.json()) as { version?: unknown } | null;
    const v = typeof body?.version === "string" ? body.version.trim() : "";
    return parseSemver(v) ? v : null;
  } catch {
    return null;
  }
}
