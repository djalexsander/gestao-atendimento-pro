// Cola entre o Realtime e a tela de Impressão (sem React, testável com relógio falso):
//   evento Realtime -> reload COALESCIDO (debounce curto + no máximo um reload ativo, mais um se chegar evento
//   durante a busca) da parte certa da tela; visibilitychange -> UM reload; relógio de UI -> só recalcula
//   Online/Offline (nunca consulta o servidor). Nenhum polling de banco.
import type { PrintTable } from "./printingRealtime";

export interface LiveTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: LiveTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export const LIVE_DEBOUNCE_MS = 200;
export const UI_CLOCK_MS = 10_000;

// trigger(): vários eventos dentro da janela viram UM reload; se chegar outro durante o reload, roda mais um.
export function createLiveRunner(run: () => Promise<unknown>, delayMs: number, timers: LiveTimers = realTimers) {
  let timer: unknown = null;
  let running = false;
  let again = false;
  let stopped = false;

  async function execute(): Promise<void> {
    running = true;
    try {
      await run();
    } catch {
      // a tela trata o próprio erro; o runner nunca trava
    } finally {
      running = false;
    }
    if (again && !stopped) {
      again = false;
      await execute();
    }
  }

  return {
    trigger() {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      if (timer !== null) return;
      timer = timers.setTimeout(() => {
        timer = null;
        void execute();
      }, delayMs);
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

export interface VisibilityTarget {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface LiveDeps {
  companyId: string;
  subscribe?: (companyId: string, onChange: (table: PrintTable) => void) => () => void;
  reload: {
    config(): Promise<unknown>; // impressoras (cards)
    agents(): Promise<unknown>;
    queue(): Promise<unknown>;
    failures(): Promise<unknown>;
  };
  // A fila só é recarregada se já foi aberta/carregada.
  isQueueActive(): boolean;
  timers?: LiveTimers;
  visibility?: VisibilityTarget;
  debounceMs?: number;
}

// Liga tudo e devolve o cleanup (remove o channel, o listener de visibilidade e os timers pendentes).
export function startPrintLive(deps: LiveDeps): () => void {
  const timers = deps.timers ?? realTimers;
  const ms = deps.debounceMs ?? LIVE_DEBOUNCE_MS;
  const runners = {
    config: createLiveRunner(deps.reload.config, ms, timers),
    agents: createLiveRunner(deps.reload.agents, ms, timers),
    queue: createLiveRunner(deps.reload.queue, ms, timers),
    failures: createLiveRunner(deps.reload.failures, ms, timers),
  };

  const unsubscribe = deps.subscribe?.(deps.companyId, (table) => {
    if (table === "print_jobs") {
      if (deps.isQueueActive()) runners.queue.trigger();
    } else if (table === "print_devices") runners.config.trigger();
    else if (table === "print_agents") runners.agents.trigger();
    else runners.failures.trigger();
  });

  // Notebook suspenso / PWA em segundo plano: ao voltar, UM reload de cada parte (sem polling).
  const target = deps.visibility ?? (typeof document !== "undefined" ? document : undefined);
  const onVisible = () => {
    if (target?.visibilityState !== "visible") return;
    runners.config.trigger();
    runners.agents.trigger();
    runners.failures.trigger();
    if (deps.isQueueActive()) runners.queue.trigger();
  };
  target?.addEventListener("visibilitychange", onVisible);

  return () => {
    unsubscribe?.();
    target?.removeEventListener("visibilitychange", onVisible);
    for (const r of Object.values(runners)) r.stop();
  };
}

// Relógio LOCAL da UI: só chama onTick (que recalcula Online/Offline com Date.now()). NÃO consulta o servidor.
export function startUiClock(onTick: () => void, intervalMs: number = UI_CLOCK_MS, timers: LiveTimers = realTimers): () => void {
  const handle = timers.setInterval(onTick, intervalMs);
  return () => timers.clearInterval(handle);
}
