// Estado de prontidão de um canal de Broadcast. O aviso "order-submitted" nunca é enviado antes
// de o canal estar SUBSCRIBED e nunca é perdido só por isso: durante a conexão (ou uma queda
// temporária) fica no máximo UM aviso pendente, enviado assim que o status virar SUBSCRIBED.
// Nada aqui espera ou bloqueia o fluxo de quem chamou; sem timers e sem Promises presas.
export type GateState = "connecting" | "subscribed" | "error" | "closed";

export interface BroadcastGate {
  onStatus(status: string): void;
  notify(): void;
  dispose(): void;
  state(): GateState;
  hasPending(): boolean;
}

export function createBroadcastGate(send: () => void): BroadcastGate {
  let state: GateState = "connecting";
  let pending = false;
  let disposed = false;

  return {
    onStatus(status) {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        state = "subscribed";
        if (pending) {
          pending = false;
          send();
        }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        state = "error";
      } else if (status === "CLOSED") {
        state = "closed";
      }
    },
    notify() {
      if (disposed) return;
      if (state === "subscribed") send();
      else pending = true; // vários avisos viram um só
    },
    dispose() {
      disposed = true;
      pending = false;
    },
    state: () => state,
    hasPending: () => pending,
  };
}
