// Tipos e regras puras da configuração de impressão (sem React, sem banco).

export const NAME_MAX_LENGTH = 80;
export const PAPER_WIDTHS = [58, 80] as const;
export type PaperWidth = (typeof PAPER_WIDTHS)[number];

export interface PrintSector {
  id: string;
  name: string;
  is_active: boolean;
}

// Impressora LÓGICA do sistema. windows_printer_name é a impressora física do Windows, que só o
// Agente de Impressão (etapa futura) preenche: o navegador nunca a descobre nem a digita.
export type DeviceKind = "receipt" | "label";

// Configuração de uma impressora de ETIQUETAS (tamanho livre, em mm).
export interface LabelConfig {
  width_mm: number;
  height_mm: number;
  gap_mm: number;
  columns: number;
  margin_x_mm: number;
  margin_y_mm: number;
}

export interface LabelPrinterInput extends LabelConfig {
  name: string;
  is_default: boolean;
}

export interface PrintDevice {
  id: string;
  name: string;
  // Toda impressora antiga é 'receipt'. Etiqueta não tem papel 58/80 (paper_width nulo).
  kind: DeviceKind;
  label: LabelConfig | null;
  is_default: boolean;
  paper_width: PaperWidth | null;
  windows_printer_name: string | null;
  // PRONTA = ativa + vinculada a um Agente e a uma impressora do Windows. Só impressora pronta gera jobs
  // (teste, pedido, documentos, reimpressão); cadastrada != pronta.
  ready: boolean;
  // Agente (computador) ao qual a impressora física está vinculada; null = sem vínculo.
  agent_id: string | null;
  // Rotas AUTOMÁTICAS de produção (pedido completo e setores) ...
  full_order: boolean;
  sector_ids: string[];
  // ... e DOCUMENTOS MANUAIS (só imprimem quando o usuário pede: botão ou F8).
  documents: DocumentRoute[];
}

export interface DeviceInput {
  name: string;
  paper_width: PaperWidth;
  full_order: boolean;
  sector_ids: string[];
  documents: DocumentRoute[];
}

export type DocumentRoute = "customer_bill" | "payment_receipt" | "cash_closing";
export const DOCUMENT_ROUTES: Array<{ value: DocumentRoute; label: string }> = [
  { value: "customer_bill", label: "Conta / pré-conta" },
  { value: "payment_receipt", label: "Comprovante de pagamento" },
  { value: "cash_closing", label: "Fechamento de caixa" },
];

export interface PrintEnqueueFailure {
  id: string;
  event_type: "production_order" | "production_cancellation";
  summary: string | null;
  created_at: string;
}

export type JobType =
  | "production_order"
  | "production_cancellation"
  | "test"
  | "customer_bill"
  | "payment_receipt"
  | "cash_closing"
  | "label_product"
  | "label_free"
  | "label_service_point";
export type JobStatus = "pending" | "claimed" | "printed" | "error" | "cancelled";

export interface PrintJobItemSnapshot {
  quantity: number;
  product_name: string;
  notes?: string | null;
  sector?: { id: string; name: string } | null;
}

// O que a tela lê do snapshot (payload). Tudo opcional: o snapshot é do momento do job.
export interface PrintJobPayload {
  printer?: { name?: string };
  service_point?: { label?: string };
  customer_name?: string | null;
  operator?: { name?: string };
  cancelled_by?: { name?: string };
  reason?: string;
  items?: PrintJobItemSnapshot[];
  sent_at?: string;
  cancelled_at?: string;
  requested_at?: string;
  total?: number;
  paid_total?: number;
  net_total?: number;
  difference_label?: string;
  reprint?: { label?: string; requested_at?: string; requested_by?: { name?: string } };
}

export interface PrintJob {
  id: string;
  print_device_id: string;
  job_type: JobType;
  status: JobStatus;
  attempts: number;
  error_message: string | null;
  reprint_of_id: string | null;
  created_at: string;
  payload: PrintJobPayload;
}

// "50 × 30 mm · 2 colunas · gap 3 mm"
export function labelSummary(config: LabelConfig): string {
  const n = (v: number) => String(Number(v)).replace(".", ",");
  return `${n(config.width_mm)} × ${n(config.height_mm)} mm · ${config.columns} ${config.columns === 1 ? "coluna" : "colunas"} · gap ${n(config.gap_mm)} mm`;
}

export interface LabelDraft {
  name: string;
  width: string;
  height: string;
  gap: string;
  columns: string;
  marginX: string;
  marginY: string;
  isDefault: boolean;
}

export const DEFAULT_LABEL_DRAFT: LabelDraft = { name: "", width: "50", height: "30", gap: "3", columns: "1", marginX: "1", marginY: "1", isDefault: false };

const parseMm = (raw: string): number | null => {
  const n = Number(raw.trim().replace(",", "."));
  return raw.trim() !== "" && Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
};

export function labelDraftFrom(device: PrintDevice): LabelDraft {
  const c = device.label;
  const t = (v: number) => String(Number(v)).replace(".", ",");
  return c
    ? { name: device.name, width: t(c.width_mm), height: t(c.height_mm), gap: t(c.gap_mm), columns: String(c.columns), marginX: t(c.margin_x_mm), marginY: t(c.margin_y_mm), isDefault: device.is_default }
    : { ...DEFAULT_LABEL_DRAFT, name: device.name };
}

// Mesmos limites do banco (create_label_printer). Tamanho LIVRE: qualquer valor dentro dos limites.
export function validateLabelDraft(d: LabelDraft): { error: string } | { input: LabelPrinterInput } {
  const nameProblem = validateDeviceName(d.name);
  if (nameProblem) return { error: nameProblem };
  const width = parseMm(d.width), height = parseMm(d.height), gap = parseMm(d.gap), mx = parseMm(d.marginX), my = parseMm(d.marginY);
  const columns = Number(d.columns);
  if (width === null || width < 10 || width > 200) return { error: "A largura da etiqueta deve ficar entre 10 e 200 mm." };
  if (height === null || height < 10 || height > 300) return { error: "A altura da etiqueta deve ficar entre 10 e 300 mm." };
  if (gap === null || gap < 0 || gap > 30) return { error: "O espaçamento (gap) deve ficar entre 0 e 30 mm." };
  if (!Number.isInteger(columns) || columns < 1 || columns > 4) return { error: "A quantidade de colunas deve ser de 1 a 4." };
  if (mx === null || my === null || mx < 0 || my < 0 || mx > 20 || my > 20) return { error: "As margens devem ficar entre 0 e 20 mm." };
  if (mx * 2 >= width || my * 2 >= height) return { error: "As margens não podem ocupar toda a etiqueta." };
  return { input: { name: d.name.trim(), width_mm: width, height_mm: height, gap_mm: gap, columns, margin_x_mm: mx, margin_y_mm: my, is_default: d.isDefault } };
}

export function validateDeviceName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "Informe o nome da impressora.";
  if (name.length > NAME_MAX_LENGTH) return `O nome pode ter no máximo ${NAME_MAX_LENGTH} caracteres.`;
  return null;
}

// "Pedido completo, Cozinha, Churrasqueira" — setores na ordem alfabética.
export function destinationLabels(device: PrintDevice, sectors: PrintSector[]): string[] {
  const names = sectors
    .filter((s) => device.sector_ids.includes(s.id))
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  return device.full_order ? ["Pedido completo", ...names] : names;
}

// Quantas impressoras (ativas) atendem o setor, contando a edição em andamento.
export function printersForSector(sectorId: string, devices: PrintDevice[], draft?: { id: string | null; checked: boolean }): number {
  const others = devices.filter((d) => d.id !== draft?.id && d.sector_ids.includes(sectorId)).length;
  return others + (draft?.checked ? 1 : 0);
}

// Documentos manuais atendidos por esta impressora, na ordem de DOCUMENT_ROUTES.
export function documentLabels(device: PrintDevice): string[] {
  return DOCUMENT_ROUTES.filter((d) => device.documents.includes(d.value)).map((d) => d.label);
}

export function physicalPrinterLabel(device: PrintDevice): string {
  return device.windows_printer_name ?? "Não configurada";
}

// Estado da impressora no painel. `ready` (banco) = vinculada a um Agente e a uma impressora do Windows; NÃO diz se o
// computador está ligado. Online/offline vem do heartbeat do Agente (last_seen_at) e é calculado aqui, na UI.
//   sem vínculo                -> "Aguardando Agente de Impressão"
//   vinculada, agente offline  -> "Agente offline"
//   vinculada, agente online   -> "Pronta para imprimir"
export function deviceStatusLabel(device: PrintDevice, agents: PrintAgent[] | null = null, now: number = Date.now()): string {
  if (!device.ready) return "Aguardando Agente de Impressão";
  if (agents === null) return "Verificando agente…";
  const agent = agents.find((a) => a.id === device.agent_id);
  return agent && isAgentOnline(agent, now) ? "Pronta para imprimir" : "Agente offline";
}

// Vinculada mas com o computador offline: continua aceitando jobs (ficam pendentes até o Agente voltar).
export function isDeviceAgentOffline(device: PrintDevice, agents: PrintAgent[] | null, now: number = Date.now()): boolean {
  if (!device.ready || agents === null) return false;
  const agent = agents.find((a) => a.id === device.agent_id);
  return !agent || !isAgentOnline(agent, now);
}

// "Há impressões aguardando o Agente X ficar online." — um aviso por agente offline com jobs pendentes.
export function offlinePendingNotices(
  jobs: Array<Pick<PrintJob, "status" | "print_device_id">>,
  devices: PrintDevice[],
  agents: PrintAgent[] | null,
  now: number = Date.now(),
): string[] {
  if (agents === null) return [];
  const names = new Set<string>();
  for (const job of jobs) {
    if (job.status !== "pending") continue;
    const device = devices.find((d) => d.id === job.print_device_id);
    if (!device || !isDeviceAgentOffline(device, agents, now)) continue;
    const agent = agents.find((a) => a.id === device.agent_id);
    if (agent) names.add(agent.name);
  }
  return [...names].map((name) => `Há impressões aguardando o Agente ${name} ficar online.`);
}

const JOB_TYPE_LABEL: Record<JobType, string> = {
  production_order: "Pedido",
  production_cancellation: "Cancelamento",
  test: "Teste",
  customer_bill: "Conta / pré-conta",
  payment_receipt: "Comprovante",
  cash_closing: "Fechamento de caixa",
  label_product: "Etiqueta de produto",
  label_free: "Etiqueta livre",
  label_service_point: "Comanda / mesa",
};

export function jobTypeLabel(job: Pick<PrintJob, "job_type" | "reprint_of_id">): string {
  const base = JOB_TYPE_LABEL[job.job_type];
  return job.reprint_of_id ? `${base} (reimpressão)` : base;
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  pending: "Pendente",
  claimed: "Imprimindo",
  printed: "Impresso",
  error: "Erro",
  cancelled: "Cancelado",
};

export function jobOrderLabel(job: PrintJob): string {
  if (job.job_type === "cash_closing") return job.payload.operator?.name ? `Caixa de ${job.payload.operator.name}` : "Caixa";
  return job.payload.service_point?.label ?? "—";
}

export function jobPrinterName(job: PrintJob): string {
  return job.payload.printer?.name ?? "—";
}

export function describePrintError(
  error: { code?: string | null; message?: string | null },
  fallback: string,
): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code.startsWith("PT") && message) return message;
  return fallback;
}

export function describeEnqueueFailure(failure: PrintEnqueueFailure): string {
  return failure.summary ?? (failure.event_type === "production_order" ? "Pedido" : "Cancelamento de item");
}

// ---- Agentes de Impressão (computadores Windows pareados)
export interface PrintAgent {
  id: string;
  name: string;
  machine_name: string | null;
  is_active: boolean;
  last_seen_at: string | null;
  created_at: string;
}

export interface PairingCode {
  code: string;
  expires_at: string;
}

// O agente envia heartbeat a cada 30 s: sem sinal por 90 s = offline. Online NÃO significa que toda
// impressora está pronta (is_ready é por impressora).
export const AGENT_ONLINE_WINDOW_MS = 90_000;

export function isAgentOnline(agent: Pick<PrintAgent, "last_seen_at">, now: number = Date.now()): boolean {
  if (!agent.last_seen_at) return false;
  const seen = new Date(agent.last_seen_at).getTime();
  return !Number.isNaN(seen) && now - seen <= AGENT_ONLINE_WINDOW_MS;
}

export function lastContactLabel(agent: Pick<PrintAgent, "last_seen_at">, now: number = Date.now()): string {
  if (!agent.last_seen_at) return "Nunca";
  const seen = new Date(agent.last_seen_at).getTime();
  if (Number.isNaN(seen)) return "—";
  const seconds = Math.max(0, Math.round((now - seen) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} d`;
}

// "48273105" -> "4827 3105"
export function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

export function secondsLeft(expiresAt: string, now: number = Date.now()): number {
  const end = new Date(expiresAt).getTime();
  return Number.isNaN(end) ? 0 : Math.max(0, Math.ceil((end - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
