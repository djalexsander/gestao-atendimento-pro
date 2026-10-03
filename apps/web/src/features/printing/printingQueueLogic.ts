// Fila de impressão: período, "Atenção" (abertos/problemáticos) x "Histórico do período" (paginado por cursor).
// Lógica PURA (sem React, sem Supabase) + um controlador testável com fonte falsa. Datas SEMPRE no dia civil de
// America/Sao_Paulo (nunca UTC bruto). Nenhuma regra de banco aqui: só o que a tela mostra e como pagina.
import type { JobStatus, PrintJob } from "./printingLogic";

const SP = "America/Sao_Paulo";

export const HISTORY_PAGE_SIZE = 50;
export const ATTENTION_LIMIT = 100;
export const MAX_RANGE_DAYS = 31;

export type QueueFilter = "today" | "yesterday" | "week" | "custom";
export interface QueueRange {
  from: string; // yyyy-mm-dd (dia em São Paulo, inclusivo)
  to: string;
}
// Cursor keyset (created_at desc, id desc): o próximo lote é "estritamente mais antigo" que este par.
export interface QueueCursor {
  created_at: string;
  id: string;
}

export const FILTER_LABEL: Record<QueueFilter, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  week: "Últimos 7 dias",
  custom: "Período",
};

// ---- Datas (São Paulo) ----------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: SP, year: "numeric", month: "2-digit", day: "2-digit" });

// Dia civil em São Paulo (yyyy-mm-dd) de um instante.
export function spDay(input: Date | string): string {
  return dayFmt.format(typeof input === "string" ? new Date(input) : input);
}

export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function formatDayBR(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: SP,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// Instante UTC (ISO) em que começa o dia `isoDate` em São Paulo (00:00 local). Calcula o deslocamento pelo
// Intl (não assume -03:00 fixo), então continua certo se o horário de verão voltar.
export function spDayStartUtc(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, 3, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(partsFmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const wanted = Date.UTC(y, m - 1, d, 0, 0, 0);
    if (local === wanted) break;
    guess += wanted - local;
  }
  return new Date(guess).toISOString();
}

export function rangeFor(filter: QueueFilter, today: string, custom: QueueRange): QueueRange {
  if (filter === "today") return { from: today, to: today };
  if (filter === "yesterday") {
    const y = addDaysIso(today, -1);
    return { from: y, to: y };
  }
  if (filter === "week") return { from: addDaysIso(today, -6), to: today };
  return custom;
}

export function validateRange(range: QueueRange): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) return "Informe a data inicial e a final.";
  if (range.from > range.to) return "A data inicial não pode ser depois da final.";
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1;
  if (days > MAX_RANGE_DAYS) return `O período pode ter no máximo ${MAX_RANGE_DAYS} dias.`;
  return null;
}

// Limites [início, fim) em UTC para a consulta de created_at.
export function rangeBoundsUtc(range: QueueRange): { startIso: string; endIso: string } {
  return { startIso: spDayStartUtc(range.from), endIso: spDayStartUtc(addDaysIso(range.to, 1)) };
}

export function rangeIncludesToday(range: QueueRange, today: string): boolean {
  return range.from <= today && today <= range.to;
}

// ---- Atenção x Histórico ----------------------------------------------------------------------

export const ATTENTION_STATUSES: readonly JobStatus[] = ["pending", "claimed", "error"];
export const HISTORY_STATUSES: readonly JobStatus[] = ["printed", "cancelled", "error"];

const ATTENTION_RANK: Record<string, number> = { error: 0, claimed: 1, pending: 2 };

// error primeiro, depois claimed, depois pending; dentro do status, o mais antigo primeiro (job travado).
export function sortAttention<T extends Pick<PrintJob, "status" | "created_at" | "id">>(jobs: T[]): T[] {
  return [...jobs].sort(
    (a, b) =>
      (ATTENTION_RANK[a.status] ?? 9) - (ATTENTION_RANK[b.status] ?? 9) ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
}

// Mais recente primeiro (created_at desc, id desc): a mesma ordem do cursor.
export function sortHistory<T extends Pick<PrintJob, "created_at" | "id">>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

// Erro "resolvido" = já existe uma reimpressão IMPRESSA dele: sai da Atenção (continua no histórico).
export function unresolvedErrors<T extends { id: string }>(errors: T[], printedReprintOf: Iterable<string>): T[] {
  const done = new Set(printedReprintOf);
  return errors.filter((e) => !done.has(e.id));
}

// Junta pending/claimed (todos) + erros em aberto, ordena por prioridade e limita (avisa se passou).
export function buildAttention<T extends Pick<PrintJob, "status" | "created_at" | "id">>(
  open: T[],
  errors: T[],
  limit: number = ATTENTION_LIMIT,
): { jobs: T[]; total: number; truncated: boolean } {
  const all = sortAttention([...open, ...errors]);
  return { jobs: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

export function nextCursor(page: Array<Pick<PrintJob, "created_at" | "id">>): QueueCursor | null {
  const last = page[page.length - 1];
  return last ? { created_at: last.created_at, id: last.id } : null;
}

// "Carregar mais": anexa o próximo lote sem duplicar (ids já presentes são ignorados).
export function appendPage<T extends Pick<PrintJob, "id" | "created_at">>(existing: T[], page: T[]): T[] {
  const seen = new Set(existing.map((j) => j.id));
  return sortHistory([...existing, ...page.filter((j) => !seen.has(j.id))]);
}

// Recarga da CABEÇA do histórico (Realtime/visibilidade): troca o que há de mais recente pelo lote novo e mantém
// o que já foi paginado mais abaixo (mais antigo que o último item do lote novo).
export function mergeHead<T extends Pick<PrintJob, "id" | "created_at">>(existing: T[], head: T[], headHasMore: boolean): T[] {
  if (!headHasMore) return sortHistory(head); // o lote novo cobre o período inteiro
  const last = head[head.length - 1];
  if (!last) return existing.filter(() => false);
  const older = existing.filter((j) => j.created_at < last.created_at || (j.created_at === last.created_at && j.id < (last as { id: string }).id));
  return appendPage(head, older);
}

// O que a tela mostra no histórico: nunca repete um job que já está em Atenção.
export function visibleHistory<T extends Pick<PrintJob, "id">>(history: T[], attention: Array<Pick<PrintJob, "id">>): T[] {
  const ids = new Set(attention.map((j) => j.id));
  return history.filter((j) => !ids.has(j.id));
}

export interface DayGroup<T> {
  day: string; // yyyy-mm-dd (SP)
  label: string; // dd/mm/aaaa
  jobs: T[];
}

// Cabeçalho por dia (mais recente primeiro) quando o período tem mais de um dia.
export function groupByDay<T extends Pick<PrintJob, "created_at">>(jobs: T[]): Array<DayGroup<T>> {
  const groups: Array<DayGroup<T>> = [];
  for (const job of jobs) {
    const day = spDay(job.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.jobs.push(job);
    else groups.push({ day, label: formatDayBR(day), jobs: [job] });
  }
  return groups;
}

export function attentionCounts(attention: Array<Pick<PrintJob, "status">>): { pending: number; claimed: number; error: number } {
  return {
    pending: attention.filter((j) => j.status === "pending").length,
    claimed: attention.filter((j) => j.status === "claimed").length,
    error: attention.filter((j) => j.status === "error").length,
  };
}

// ---- Controlador (estado + requisições) ----------------------------------------------------------

export interface AttentionResult {
  jobs: PrintJob[];
  total: number;
  truncated: boolean;
}
export interface HistoryResult {
  jobs: PrintJob[];
  nextCursor: QueueCursor | null; // null = não há mais
}
export interface QueueSource {
  loadAttention(companyId: string): Promise<{ data: AttentionResult | null; error: string | null }>;
  loadHistory(
    companyId: string,
    range: QueueRange,
    cursor: QueueCursor | null,
    limit: number,
  ): Promise<{ data: HistoryResult | null; error: string | null }>;
}

export interface QueueState {
  filter: QueueFilter;
  custom: QueueRange;
  range: QueueRange;
  rangeError: string | null;
  attention: PrintJob[] | null;
  attentionTotal: number;
  attentionTruncated: boolean;
  history: PrintJob[] | null;
  cursor: QueueCursor | null;
  hasMore: boolean;
  loadingHistory: boolean;
  loadingMore: boolean;
  error: string | null;
}

const QUEUE_ERROR = "Não foi possível carregar a fila de impressão agora. Tente novamente.";

export function createQueueController(deps: {
  source: QueueSource;
  companyId: string;
  now?: () => Date;
  pageSize?: number;
  onChange: (state: QueueState) => void;
}) {
  const pageSize = deps.pageSize ?? HISTORY_PAGE_SIZE;
  const now = deps.now ?? (() => new Date());
  let disposed = false;
  let generation = 0; // sobe a cada troca de período/Atualizar: respostas de gerações antigas são ignoradas
  let attentionSeq = 0;

  const today = spDay(now());
  const state: QueueState = {
    filter: "today",
    custom: { from: today, to: today },
    range: { from: today, to: today },
    rangeError: null,
    attention: null,
    attentionTotal: 0,
    attentionTruncated: false,
    history: null,
    cursor: null,
    hasMore: false,
    loadingHistory: false,
    loadingMore: false,
    error: null,
  };

  function emit() {
    if (!disposed) deps.onChange({ ...state });
  }

  async function reloadAttention(): Promise<void> {
    const seq = ++attentionSeq;
    const result = await deps.source.loadAttention(deps.companyId);
    if (disposed || seq !== attentionSeq) return;
    if (result.error || !result.data) {
      state.error = result.error ?? QUEUE_ERROR;
      emit();
      return;
    }
    state.attention = result.data.jobs;
    state.attentionTotal = result.data.total;
    state.attentionTruncated = result.data.truncated;
    emit();
  }

  // Primeira página do período atual (reseta cursor e lista). Respostas antigas (período trocado) são descartadas.
  async function reloadHistoryFirstPage(): Promise<void> {
    if (state.rangeError) return;
    const gen = ++generation;
    state.loadingHistory = true;
    state.loadingMore = false;
    emit();
    const result = await deps.source.loadHistory(deps.companyId, state.range, null, pageSize);
    if (disposed || gen !== generation) return;
    state.loadingHistory = false;
    if (result.error || !result.data) {
      state.error = result.error ?? QUEUE_ERROR;
      emit();
      return;
    }
    state.error = null;
    state.history = sortHistory(result.data.jobs);
    state.cursor = result.data.nextCursor;
    state.hasMore = result.data.nextCursor !== null;
    emit();
  }

  // Realtime / visibilidade: só a cabeça do histórico, preservando o que já foi paginado.
  async function reloadHistoryHead(): Promise<void> {
    if (state.rangeError || state.history === null) return;
    const gen = generation; // NÃO sobe a geração: se o período mudar no meio, a resposta é descartada
    const range = state.range;
    const result = await deps.source.loadHistory(deps.companyId, range, null, pageSize);
    if (disposed || gen !== generation || range !== state.range) return;
    if (result.error || !result.data) return;
    const headHasMore = result.data.nextCursor !== null;
    state.history = mergeHead(state.history ?? [], sortHistory(result.data.jobs), headHasMore);
    // O cursor sempre aponta para o último item da lista final (o próximo lote é o mais antigo que ele).
    state.cursor = headHasMore ? nextCursor(state.history) : null;
    state.hasMore = headHasMore;
    emit();
  }

  async function loadMore(): Promise<void> {
    if (!state.hasMore || !state.cursor || state.loadingMore || state.loadingHistory || state.rangeError) return;
    const gen = generation;
    const cursor = state.cursor;
    state.loadingMore = true;
    emit();
    const result = await deps.source.loadHistory(deps.companyId, state.range, cursor, pageSize);
    if (disposed || gen !== generation) return;
    state.loadingMore = false;
    if (result.error || !result.data) {
      state.error = result.error ?? QUEUE_ERROR;
      emit();
      return;
    }
    state.history = appendPage(state.history ?? [], result.data.jobs);
    state.cursor = result.data.nextCursor;
    state.hasMore = result.data.nextCursor !== null;
    emit();
  }

  function applyRange(): void {
    state.range = rangeFor(state.filter, spDay(now()), state.custom);
    state.rangeError = state.filter === "custom" ? validateRange(state.range) : null;
    // troca de período: invalida respostas em voo, zera lista/cursor
    generation += 1;
    state.history = null;
    state.cursor = null;
    state.hasMore = false;
    state.loadingMore = false;
    state.loadingHistory = false;
  }

  return {
    getState: () => ({ ...state }),
    // Abertura da aba: Atenção + primeira página de Hoje.
    async init() {
      applyRange();
      emit();
      await Promise.all([reloadAttention(), reloadHistoryFirstPage()]);
    },
    async setFilter(filter: QueueFilter) {
      state.filter = filter;
      applyRange();
      emit();
      if (!state.rangeError) await reloadHistoryFirstPage();
    },
    async setCustom(from: string, to: string) {
      state.custom = { from, to };
      state.filter = "custom";
      applyRange();
      emit();
      if (!state.rangeError) await reloadHistoryFirstPage();
    },
    // Botão Atualizar: Atenção + primeira página do período atual (sem acumular).
    async refresh() {
      if (state.filter !== "custom") state.range = rangeFor(state.filter, spDay(now()), state.custom); // virou a meia-noite
      await Promise.all([reloadAttention(), reloadHistoryFirstPage()]);
    },
    reloadAttention,
    reloadHistoryHead,
    loadMore,
    // Voltou a ficar visível: Atenção sempre; histórico (cabeça) só se já carregado.
    async onVisible() {
      await Promise.all([reloadAttention(), reloadHistoryHead()]);
    },
    dispose() {
      disposed = true;
    },
  };
}
