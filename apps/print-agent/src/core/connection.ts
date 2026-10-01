// Estado de conexão com o servidor (online/offline) e da credencial (revogada).

export type ConnectionState = "unknown" | "online" | "offline" | "revoked";

export class ConnectionTracker {
  private current: ConnectionState = "unknown";
  private failures = 0;
  private listeners = new Set<(state: ConnectionState) => void>();

  get state(): ConnectionState {
    return this.current;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: ConnectionState): boolean {
    if (next === this.current) return false;
    this.current = next;
    for (const l of this.listeners) l(next);
    return true;
  }

  // Qualquer resposta do servidor (inclusive recusa de negócio) prova que há conexão.
  reachable(): boolean {
    this.failures = 0;
    return this.current === "revoked" ? false : this.set("online");
  }

  unreachable(): boolean {
    this.failures += 1;
    return this.current === "revoked" ? false : this.set("offline");
  }

  revoked(): boolean {
    return this.set("revoked");
  }

  reset(): void {
    this.failures = 0;
    this.set("unknown");
  }
}

// Intervalo entre ciclos: 2 s normal; offline recua (4, 8, 15, 30 s) e volta a 2 s ao reconectar.
export function pollDelayMs(state: ConnectionState, failures: number): number {
  if (state === "revoked") return 60_000;
  if (state !== "offline") return 2_000;
  const steps = [4_000, 8_000, 15_000, 30_000];
  return steps[Math.min(Math.max(failures, 1) - 1, steps.length - 1)];
}
