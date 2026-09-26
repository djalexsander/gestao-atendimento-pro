// Lógica PURA do painel de Comandas / Mesas: tipos, status, busca, filtros, ordenação e
// formatação de horário. Sem React e sem Supabase, de propósito: é testada à parte e serve
// às duas áreas operacionais (Atendimento e Caixa / Balcão).

export type ServicePointType = "command" | "table";
export type ServiceMode = "command" | "table" | "both";

export interface OpenSession {
  id: string;
  customer_name: string | null;
  opened_at: string;
  opened_by: string;
  opened_by_name: string | null;
}

// Um ponto (comanda ou mesa) já com o atendimento aberto, se houver.
export interface ServicePoint {
  id: string;
  type: ServicePointType;
  code: string;
  display_name: string;
  barcode: string | null;
  is_active: boolean;
  open_session: OpenSession | null;
}

export interface ServicePanelData {
  service_mode: ServiceMode;
  points: ServicePoint[];
}

export type PointStatus = "free" | "busy" | "inactive";
export type StatusFilter = "all" | "free" | "busy";
export type TypeFilter = ServicePointType | null;

export interface PointFilters {
  query: string;
  status: StatusFilter;
  type: TypeFilter;
}

export const STATUS_LABEL: Record<PointStatus, string> = {
  free: "Livre",
  busy: "Em atendimento",
  inactive: "Inativo",
};

export const TYPE_LABEL: Record<ServicePointType, string> = {
  command: "Comandas",
  table: "Mesas",
};

export function statusOf(point: ServicePoint): PointStatus {
  if (!point.is_active) return "inactive";
  return point.open_session ? "busy" : "free";
}

// Minúsculas e sem acento: "João" casa com "joao".
function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
const TYPE_ORDER: Record<ServicePointType, number> = { command: 0, table: 1 };

// Ativos antes dos inativos; comandas antes das mesas; e o código em ordem natural
// (CMD2 antes de CMD10).
// Só olha o que a ordem precisa: serve ao painel operacional e à tela administrativa.
type PointOrder = Pick<ServicePoint, "type" | "code" | "is_active">;

export function comparePoints(a: PointOrder, b: PointOrder): number {
  if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
  if (a.type !== b.type) return TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  return collator.compare(a.code, b.code);
}

export function sortPoints<T extends PointOrder>(points: T[]): T[] {
  return [...points].sort(comparePoints);
}

function matchesQuery(point: ServicePoint, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  return [point.code, point.display_name, point.barcode ?? "", point.open_session?.customer_name ?? ""].some((field) =>
    normalize(field).includes(q),
  );
}

// Filtra pelo tipo, pelo status e pela busca (código, nome, cliente do atendimento aberto
// ou código de barras). "Livres" e "Em atendimento" deixam os inativos de fora.
export function filterPoints(points: ServicePoint[], filters: PointFilters): ServicePoint[] {
  return points.filter((point) => {
    if (filters.type && point.type !== filters.type) return false;
    const status = statusOf(point);
    if (filters.status === "free" && status !== "free") return false;
    if (filters.status === "busy" && status !== "busy") return false;
    return matchesQuery(point, filters.query);
  });
}

// Quantos pontos cada filtro de status mostraria, dentro do tipo e da busca atuais.
export function countByStatus(
  points: ServicePoint[],
  filters: Pick<PointFilters, "query" | "type">,
): Record<StatusFilter, number> {
  const scoped = filterPoints(points, { ...filters, status: "all" });
  return {
    all: scoped.length,
    free: scoped.filter((p) => statusOf(p) === "free").length,
    busy: scoped.filter((p) => statusOf(p) === "busy").length,
  };
}

// Enter na busca (leitor de código de barras USB digita o código e manda Enter): acha o
// ponto na hora. Ordem: código de barras EXATO, código EXATO (sem diferenciar caixa) e, por
// fim, o único ponto que a busca comum devolve. Ambíguo ou sem resultado = null.
export function resolveScan(points: ServicePoint[], raw: string): ServicePoint | null {
  const value = raw.trim();
  if (!value) return null;

  const byBarcode = points.find((p) => p.barcode !== null && p.barcode === value);
  if (byBarcode) return byBarcode;

  const upper = value.toUpperCase();
  const byCode = points.find((p) => p.code === upper);
  if (byCode) return byCode;

  const matches = filterPoints(points, { query: value, status: "all", type: null });
  return matches.length === 1 ? matches[0] : null;
}

// Horários no fuso comercial (como o resto do sistema), não no do aparelho.
const SP = "America/Sao_Paulo";
const timeFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: SP, hour: "2-digit", minute: "2-digit" });
const dayMonthFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: SP, day: "2-digit", month: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: SP, day: "2-digit", month: "2-digit", year: "numeric" });
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: SP });

// Card: "Aberta às 19:42" (hoje) ou "Aberta em 25/09 às 19:42".
export function formatOpenedShort(iso: string, now: Date = new Date()): string {
  const opened = new Date(iso);
  const time = timeFormat.format(opened);
  return dayKeyFormat.format(opened) === dayKeyFormat.format(now)
    ? `Aberta às ${time}`
    : `Aberta em ${dayMonthFormat.format(opened)} às ${time}`;
}

// Detalhe: "26/09/2026 às 19:42".
export function formatOpenedFull(iso: string): string {
  const opened = new Date(iso);
  return `${dateFormat.format(opened)} às ${timeFormat.format(opened)}`;
}
