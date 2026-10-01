// Loop de polling SEM concorrência: o próximo ciclo só é agendado depois que o anterior termina
// (nunca dois claims ao mesmo tempo). Erros do ciclo nunca matam o loop.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Poller {
  private running = false;
  private inFlight = false;
  private handle: unknown = null;
  private readonly task: () => Promise<void>;
  private readonly delay: () => number;
  private readonly timers: Timers;
  private readonly onError: (error: unknown) => void;

  constructor(task: () => Promise<void>, delay: () => number, timers: Timers = realTimers, onError: (error: unknown) => void = () => {}) {
    this.task = task;
    this.delay = delay;
    this.timers = timers;
    this.onError = onError;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get busy(): boolean {
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.handle = this.timers.setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.handle = null;
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    } finally {
      this.inFlight = false;
    }
    this.schedule(this.delay());
  }
}
