import { AgentApi, type Credentials, type LogicalDevice, OFFLINE_MESSAGE } from "./api.ts";
import { isPaired, loadOrCreateState, parseState, saveState, SECRET_ERROR_MESSAGE, type KeyValueStore, type SecretStore, type StoredState } from "./config.ts";
import { ConnectionTracker, pollDelayMs, type ConnectionState } from "./connection.ts";
import type { JobModel } from "./model.ts";
import { Poller, type Timers } from "./poller.ts";
import { processJob } from "./processor.ts";
import { SimulationPrinterTransport, type PrinterTransport, type PrintMode } from "./transport.ts";

export interface WindowsPrinter {
  name: string;
  isDefault: boolean;
}

export interface LogLine {
  at: Date;
  text: string;
}

export type Phase = "booting" | "unpaired" | "paired" | "revoked";

export interface Snapshot {
  phase: Phase;
  connection: ConnectionState;
  computerName: string;
  agentName: string | null;
  companyName: string | null;
  printers: WindowsPrinter[];
  devices: LogicalDevice[];
  log: LogLine[];
  simulation: boolean;
  printMode: PrintMode;
  preview: string[] | null;
  message: string | null;
}

export interface AppDeps {
  api: AgentApi;
  store: KeyValueStore;
  secrets: SecretStore;
  listPrinters(): Promise<WindowsPrinter[]>;
  hostName(): Promise<string>;
  newId(): string;
  now?(): Date;
  timers?: Timers;
  claimLimit?: number;
}

const HEARTBEAT_MS = 30_000;
const LOG_MAX = 200;

// Orquestra o agente: estado local, pareamento, heartbeat, polling da fila e processamento sequencial.
// Dois pollers independentes (claim a cada 2 s, heartbeat a cada 30 s); cada um sem concorrência dupla.
export class PrintAgentApp {
  private readonly deps: AppDeps;
  private state: StoredState | null = null;
  private computerName = "";
  private phase: Phase = "booting";
  private printers: WindowsPrinter[] = [];
  private devices: LogicalDevice[] = [];
  private logLines: LogLine[] = [];
  private preview: string[] | null = null;
  private message: string | null = null;
  private readonly connection = new ConnectionTracker();
  private readonly listeners = new Set<() => void>();
  private claimPoller: Poller;
  private heartbeatPoller: Poller;
  // Jobs do servidor SEMPRE em simulação nesta etapa (nenhum papel sai). Não há como ligar o modo real daqui.
  private readonly printMode: PrintMode = "simulation";
  private readonly transport: PrinterTransport = new SimulationPrinterTransport();

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.claimPoller = new Poller(
      () => this.claimCycle(),
      () => pollDelayMs(this.connection.state, this.connection.consecutiveFailures),
      deps.timers,
      (e) => this.log(`Erro inesperado: ${e instanceof Error ? e.message : String(e)}`),
    );
    this.heartbeatPoller = new Poller(
      () => this.heartbeatCycle(),
      () => HEARTBEAT_MS,
      deps.timers,
      (e) => this.log(`Erro inesperado: ${e instanceof Error ? e.message : String(e)}`),
    );
    this.connection.subscribe((s) => {
      if (s === "offline") this.log(OFFLINE_MESSAGE);
      if (s === "online" && this.wasOffline) this.log("Conexão restabelecida");
      this.wasOffline = s === "offline";
      this.emit();
    });
  }

  private wasOffline = false;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  snapshot(): Snapshot {
    return {
      phase: this.phase,
      connection: this.connection.state,
      computerName: this.state?.computerName ?? this.computerName,
      agentName: this.state?.agentName ?? null,
      companyName: this.state?.companyName ?? null,
      printers: this.printers,
      devices: this.devices,
      log: this.logLines,
      simulation: this.printMode === "simulation",
      printMode: this.printMode,
      preview: this.preview,
      message: this.message,
    };
  }

  log(text: string): void {
    this.logLines = [...this.logLines, { at: (this.deps.now ?? (() => new Date()))(), text }].slice(-LOG_MAX);
    this.emit();
  }

  private creds(): Credentials | null {
    return this.state && isPaired(this.state) ? { agentId: this.state.agentId!, token: this.state.token! } : null;
  }

  async init(): Promise<void> {
    this.computerName = await this.deps.hostName().catch(() => "");
    try {
      this.state = await loadOrCreateState(this.deps.store, this.deps.secrets, this.deps.newId);
    } catch {
      // Cofre indisponível: NÃO cai para texto puro. Fica sem credencial e avisa.
      const parsed = parseState(await this.deps.store.load());
      this.state = parsed
        ? { ...parsed, agentId: null, token: null, agentName: null, companyName: null }
        : { machineId: this.deps.newId(), agentId: null, token: null, agentName: null, companyName: null, computerName: null };
      this.message = SECRET_ERROR_MESSAGE;
    }
    await this.refreshPrinters();
    this.phase = isPaired(this.state) ? "paired" : "unpaired";
    this.emit();
    if (this.phase === "paired") this.startLoops();
  }

  private startLoops(): void {
    this.heartbeatPoller.start();
    this.claimPoller.start();
  }

  stop(): void {
    this.heartbeatPoller.stop();
    this.claimPoller.stop();
  }

  async refreshPrinters(): Promise<void> {
    try {
      this.printers = await this.deps.listPrinters();
      this.log(`${this.printers.length} impressora${this.printers.length === 1 ? "" : "s"} Windows encontrada${this.printers.length === 1 ? "" : "s"}`);
    } catch (e) {
      this.log(`Não foi possível listar as impressoras do Windows: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async pair(code: string, name: string): Promise<boolean> {
    if (!this.state) return false;
    this.message = null;
    const trimmed = name.trim();
    if (!trimmed) {
      this.message = "Informe o nome deste computador.";
      this.emit();
      return false;
    }
    const res = await this.deps.api.pair(code, this.state.machineId, trimmed);
    if (!res.ok) {
      this.message = res.message;
      if (res.kind === "offline") this.connection.unreachable();
      else this.connection.reachable();
      this.emit();
      return false;
    }
    // Primeiro o token vai para o cofre. Se falhar, o pareamento NÃO continua (nada de token exposto).
    try {
      await this.deps.secrets.set(res.data.token);
    } catch {
      this.message = SECRET_ERROR_MESSAGE;
      this.log("Erro: não foi possível guardar a credencial no cofre do Windows. Gere um novo código para tentar de novo.");
      this.emit();
      return false;
    }
    this.state = { ...this.state, agentId: res.data.agentId, token: res.data.token, agentName: res.data.agentName, companyName: res.data.companyName, computerName: trimmed };
    await saveState(this.deps.store, this.state);
    this.connection.reset();
    this.phase = "paired";
    this.log(`Computador conectado: ${res.data.agentName} (${res.data.companyName})`);
    this.startLoops();
    this.emit();
    return true;
  }

  async bindDevice(deviceId: string, windowsPrinter: string): Promise<boolean> {
    const c = this.creds();
    if (!c) return false;
    this.message = null;
    const res = await this.deps.api.bind(c, deviceId, windowsPrinter);
    if (!res.ok) {
      this.message = res.message;
      this.noteFailure(res.kind);
      this.emit();
      return false;
    }
    this.connection.reachable();
    this.log(`Impressora vinculada: ${this.devices.find((d) => d.id === deviceId)?.name ?? "impressora"} → ${windowsPrinter}`);
    await this.refreshDevices();
    return true;
  }

  async refreshDevices(): Promise<void> {
    const c = this.creds();
    if (!c) return;
    const res = await this.deps.api.listDevices(c);
    if (res.ok) {
      this.devices = res.data;
      this.connection.reachable();
    } else {
      this.noteFailure(res.kind);
    }
    this.emit();
  }

  private noteFailure(kind: "offline" | "unauthorized" | "rate_limited" | "rejected"): void {
    if (kind === "offline") this.connection.unreachable();
    else if (kind === "unauthorized") void this.handleRevoked();
    else this.connection.reachable();
  }

  // Credencial recusada: o agente foi revogado (ou o token trocado). Para tudo e pede novo pareamento;
  // o machine_id é mantido.
  private async handleRevoked(): Promise<void> {
    if (this.phase === "revoked") return;
    this.connection.revoked();
    this.stop();
    this.phase = "revoked";
    this.log("Este computador foi desconectado pelo sistema. Conecte novamente.");
    await this.clearCredential();
    this.emit();
  }

  // Remove o token do cofre e o vínculo do arquivo; mantém o machine_id.
  private async clearCredential(): Promise<void> {
    try {
      await this.deps.secrets.delete();
    } catch {
      this.log("Aviso: não foi possível remover a credencial do cofre do Windows.");
    }
    if (this.state) {
      this.state = { ...this.state, agentId: null, token: null, agentName: null, companyName: null };
      await saveState(this.deps.store, this.state);
    }
  }

  // "Desconectar este computador" (ação do usuário). O agente continua listado no painel até ser revogado lá.
  async disconnect(): Promise<void> {
    this.stop();
    await this.clearCredential();
    this.connection.reset();
    this.phase = "unpaired";
    this.devices = [];
    this.message = null;
    this.log("Computador desconectado deste agente. Para remover do sistema, revogue em Configurações → Impressão → Agentes.");
    this.emit();
  }

  // "Conectar novamente" depois de revogado.
  startOver(): void {
    this.connection.reset();
    this.phase = "unpaired";
    this.devices = [];
    this.message = null;
    this.emit();
  }

  private async heartbeatCycle(): Promise<void> {
    const c = this.creds();
    if (!c || this.phase !== "paired") return;
    const res = await this.deps.api.heartbeat(c);
    if (res.ok) {
      const first = this.connection.state === "unknown";
      this.connection.reachable();
      if (first) this.log("Conectado ao servidor");
      if (this.state && this.state.companyName !== res.data.companyName && res.data.companyName) {
        this.state = { ...this.state, companyName: res.data.companyName, agentName: res.data.agentName || this.state.agentName };
        await saveState(this.deps.store, this.state);
      }
      await this.refreshDevices();
    } else {
      this.noteFailure(res.kind);
    }
  }

  private async claimCycle(): Promise<void> {
    const c = this.creds();
    if (!c || this.phase !== "paired") return;
    const res = await this.deps.api.claim(c, this.deps.claimLimit ?? 5);
    if (!res.ok) {
      this.noteFailure(res.kind);
      return;
    }
    this.connection.reachable();
    if (res.data.invalid > 0) this.log(`${res.data.invalid} job(s) com formato inválido ignorado(s)`);
    for (const job of res.data.jobs) {
      if (this.phase !== "paired") return;
      await this.process(c, job);
    }
  }

  private async process(c: Credentials, job: JobModel): Promise<void> {
    await processJob(job, {
      creds: c,
      complete: (cr, id) => this.deps.api.complete(cr, id),
      fail: (cr, id, err) => this.deps.api.fail(cr, id, err),
      transport: this.transport,
      log: (line) => this.log(line),
      onPreview: (_j, lines) => {
        this.preview = lines;
        this.emit();
      },
    });
  }
}
