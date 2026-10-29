// Lógica pura da área "WhatsApp" do Painel Master (sem React e sem rede): rótulos, normalização das respostas das RPCs,
// próximo disparo do cron, regras de bloqueio da resolução de registros e validação dos formulários administrativos.
// Nada aqui lê ou guarda token, PIN ou referência do Vault: as RPCs não os devolvem e os campos desconhecidos são descartados.

export type Tone = "ok" | "warn" | "bad" | "muted";

export const SWEEP_PERIOD_HOURS = 6;
export const SWEEP_MINUTE = 7;
export const OVERDUE_AFTER_HOURS = 13;
export const IN_FLIGHT_MINUTES = 30;
export const HISTORY_PAGE_SIZE = 10;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0;
const bool = (v: unknown): boolean => v === true;

// ------------------------------------------------------------------ monitoramento
export type Health = "ok" | "failing" | "overdue" | "never_run";
export type RunStatus = "success" | "failed" | "skipped_concurrent";
export type RunSource = "cron" | "manual";

export interface SweepRun {
  id: string | null;
  source: RunSource;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  checked: number;
  lockedSkipped: number;
  updated: number;
  alertsCreated: number;
  alertsRefreshed: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface FailureInfo {
  source: RunSource;
  startedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface SweepStatus {
  health: Health;
  lastRun: SweepRun | null;
  lastFailure: FailureInfo | null;
  lastSuccessAt: string | null;
  neverRun: boolean;
  overdue: boolean;
  job: { schedule: string; active: boolean } | null;
  lastCronRun: { status: string | null; startTime: string | null; endTime: string | null } | null;
  schedulerOkButSweepFailed: boolean;
  failures24h: number;
  recentFailures: FailureInfo[];
}

const HEALTHS: Health[] = ["ok", "failing", "overdue", "never_run"];
const STATUSES: RunStatus[] = ["success", "failed", "skipped_concurrent"];
const toSource = (v: unknown): RunSource => (v === "cron" ? "cron" : "manual");

export function parseRun(raw: unknown): SweepRun | null {
  if (!isObj(raw)) return null;
  const status = STATUSES.find((s) => s === raw.status);
  if (!status) return null;
  return {
    id: str(raw.id),
    source: toSource(raw.source),
    status,
    startedAt: str(raw.started_at),
    finishedAt: str(raw.finished_at),
    checked: num(raw.checked),
    lockedSkipped: num(raw.locked_skipped),
    updated: num(raw.updated),
    alertsCreated: num(raw.alerts_created),
    alertsRefreshed: num(raw.alerts_refreshed),
    errorCode: str(raw.error_code),
    errorMessage: str(raw.error_message),
  };
}

const parseFailure = (raw: unknown): FailureInfo | null =>
  isObj(raw) ? { source: toSource(raw.source), startedAt: str(raw.started_at), errorCode: str(raw.error_code), errorMessage: str(raw.error_message) } : null;

export function parseSweepStatus(raw: unknown): SweepStatus | null {
  if (!isObj(raw)) return null;
  const health = HEALTHS.find((h) => h === raw.health);
  if (!health) return null;
  const job = isObj(raw.job) ? { schedule: str(raw.job.schedule) ?? "", active: bool(raw.job.active) } : null;
  const cron = isObj(raw.last_cron_run)
    ? { status: str(raw.last_cron_run.status), startTime: str(raw.last_cron_run.start_time), endTime: str(raw.last_cron_run.end_time) }
    : null;
  return {
    health,
    lastRun: parseRun(raw.last_run),
    lastFailure: parseFailure(raw.last_failure),
    lastSuccessAt: str(raw.last_success_at),
    neverRun: bool(raw.never_run),
    overdue: bool(raw.overdue),
    job,
    lastCronRun: cron,
    schedulerOkButSweepFailed: bool(raw.scheduler_ok_but_sweep_failed),
    failures24h: num(raw.failures_24h),
    recentFailures: (Array.isArray(raw.recent_failures) ? raw.recent_failures : []).map(parseFailure).filter((x): x is FailureInfo => x !== null),
  };
}

export const HEALTH_LABEL: Record<Health, string> = { ok: "Em dia", failing: "Com falha", overdue: "Atrasada", never_run: "Nunca executada" };
export const HEALTH_TONE: Record<Health, Tone> = { ok: "ok", failing: "bad", overdue: "warn", never_run: "muted" };
export const RUN_STATUS_LABEL: Record<RunStatus, string> = { success: "Sucesso", failed: "Falha", skipped_concurrent: "Ignorada (já em execução)" };
export const RUN_STATUS_TONE: Record<RunStatus, Tone> = { success: "ok", failed: "bad", skipped_concurrent: "muted" };
export const RUN_SOURCE_LABEL: Record<RunSource, string> = { cron: "Agendador (cron)", manual: "Manual" };

// Próximo disparo da grade do cron (minuto 7 a cada 6 horas; UTC: 00:07, 06:07, 12:07, 18:07), estritamente depois de `from`.
export function nextCronRun(from: Date): Date {
  for (let i = 0; i <= 48; i++) {
    const cand = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours() + i, SWEEP_MINUTE, 0, 0));
    if (cand.getUTCHours() % SWEEP_PERIOD_HOURS === 0 && cand.getTime() > from.getTime()) return cand;
  }
  return new Date(from.getTime() + SWEEP_PERIOD_HOURS * 3600 * 1000);
}

export interface MonitoringView {
  tone: Tone;
  headline: string;
  /** o disparo automático só é considerado confirmado quando o próprio pg_cron registrou uma execução */
  cronConfirmed: boolean;
  nextRunAt: Date | null;
  notices: string[];
}

export function describeMonitoring(s: SweepStatus, now: Date): MonitoringView {
  const cronConfirmed = s.lastCronRun !== null;
  const jobActive = s.job?.active === true;
  const notices: string[] = [];
  if (!s.job) notices.push("O agendamento da varredura não foi encontrado no banco (pg_cron ausente ou removido).");
  else if (!s.job.active) notices.push("O agendamento da varredura está desativado.");
  if (s.job && s.job.active && !cronConfirmed) {
    notices.push(
      s.lastRun?.source === "manual"
        ? "Disparo automático ainda não confirmado: a execução registrada foi manual e não prova que o agendador funciona. Aguarde o próximo horário da grade."
        : "Disparo automático ainda não confirmado: o agendador ainda não registrou nenhuma execução.",
    );
  }
  if (s.schedulerOkButSweepFailed) {
    notices.push("Atenção: o agendador (pg_cron) terminou com sucesso, mas a varredura registrou falha. O resultado que vale é o da varredura.");
  }
  if (s.health === "failing" && s.lastFailure?.errorCode) {
    notices.push(`Última falha: ${s.lastFailure.errorCode}${s.lastFailure.errorMessage ? ` — ${s.lastFailure.errorMessage}` : ""}`);
  }
  return {
    tone: HEALTH_TONE[s.health],
    headline: HEALTH_LABEL[s.health],
    cronConfirmed,
    nextRunAt: jobActive ? nextCronRun(now) : null,
    notices,
  };
}

// ------------------------------------------------------------------ histórico
export interface HistoryPage {
  total: number;
  limit: number;
  offset: number;
  rows: SweepRun[];
}

export function parseHistory(raw: unknown): HistoryPage | null {
  if (!isObj(raw) || !Array.isArray(raw.rows)) return null;
  return {
    total: num(raw.total),
    limit: Math.max(1, num(raw.limit) || HISTORY_PAGE_SIZE),
    offset: Math.max(0, num(raw.offset)),
    rows: raw.rows.map(parseRun).filter((r): r is SweepRun => r !== null),
  };
}

export const pageCount = (total: number, limit: number): number => Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, limit)));
export const offsetForPage = (page: number, limit: number): number => Math.max(0, (Math.max(1, page) - 1) * Math.max(1, limit));
export const pageOfOffset = (offset: number, limit: number): number => Math.floor(Math.max(0, offset) / Math.max(1, limit)) + 1;

// ------------------------------------------------------------------ saúde dos tokens
export type TokenState = "valid" | "expiring" | "expired" | "revoked" | "error" | "unknown";
export interface TokenHealthRow {
  companyId: string;
  companyName: string;
  connectionId: string;
  mode: "test" | "live";
  state: TokenState;
  tokenExpiresAt: string | null;
  tokenCheckedAt: string | null;
  lastErrorCode: string | null;
}
const TOKEN_STATES: TokenState[] = ["valid", "expiring", "expired", "revoked", "error", "unknown"];
export const TOKEN_STATE_LABEL: Record<TokenState, string> = {
  valid: "Válido",
  expiring: "Vence em breve",
  expired: "Expirado",
  revoked: "Revogado",
  error: "Erro de autenticação",
  unknown: "Sem prazo conhecido",
};
export const TOKEN_STATE_TONE: Record<TokenState, Tone> = { valid: "ok", expiring: "warn", expired: "bad", revoked: "bad", error: "warn", unknown: "muted" };
export const needsReconnect = (s: TokenState): boolean => s === "expiring" || s === "expired" || s === "revoked";
/** ordem da tabela: o que precisa de ação primeiro */
const TOKEN_RANK: Record<TokenState, number> = { revoked: 0, expired: 1, expiring: 2, error: 3, unknown: 4, valid: 5 };

export function parseTokenHealth(raw: unknown): TokenHealthRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: TokenHealthRow[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const state = TOKEN_STATES.find((s) => s === r.status);
    const companyId = str(r.company_id);
    const connectionId = str(r.connection_id);
    if (!state || !companyId || !connectionId) continue;
    rows.push({
      companyId,
      companyName: str(r.company_name) ?? "—",
      connectionId,
      mode: r.mode === "live" ? "live" : "test",
      state,
      tokenExpiresAt: str(r.token_expires_at),
      tokenCheckedAt: str(r.token_checked_at),
      lastErrorCode: str(r.last_error_code),
    });
  }
  return rows.sort((a, b) => TOKEN_RANK[a.state] - TOKEN_RANK[b.state] || a.companyName.localeCompare(b.companyName, "pt-BR"));
}

/** O backend não devolve o telefone, só identificadores da Meta. Mostra apenas o final, nunca o valor inteiro. */
export function maskId(value: string | null | undefined): string {
  const v = (value ?? "").replace(/\s+/g, "");
  if (v.length === 0) return "—";
  if (v.length <= 4) return "••••";
  return `•••• ${v.slice(-4)}`;
}
export const shortUserId = (v: string | null | undefined): string => (v ? `${v.slice(0, 8)}…` : "—");

// ------------------------------------------------------------------ piloto
export interface PilotRow {
  companyId: string;
  companyName: string;
  authorized: boolean;
  authorizedBy: string | null;
  authorizedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  note: string | null;
  connectionActive: boolean;
}
export interface PilotEvent {
  action: "authorized" | "revoked";
  actorUserId: string | null;
  note: string | null;
  at: string | null;
}

export function parsePilotList(raw: unknown): PilotRow[] {
  if (!Array.isArray(raw)) return [];
  const out: PilotRow[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const companyId = str(r.company_id);
    if (!companyId) continue;
    out.push({
      companyId,
      companyName: str(r.company_name) ?? "—",
      authorized: bool(r.authorized),
      authorizedBy: str(r.authorized_by),
      authorizedAt: str(r.authorized_at),
      revokedBy: str(r.revoked_by),
      revokedAt: str(r.revoked_at),
      note: str(r.note),
      connectionActive: bool(r.connection_active),
    });
  }
  return out;
}

export function parsePilotEvents(raw: unknown): PilotEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: PilotEvent[] = [];
  for (const r of raw) {
    if (!isObj(r) || (r.action !== "authorized" && r.action !== "revoked")) continue;
    out.push({ action: r.action, actorUserId: str(r.actor_user_id), note: str(r.note), at: str(r.at) });
  }
  return out;
}

export const PILOT_NOTE_MIN = 5;
export const PILOT_NOTE_MAX = 500;
/** A nota é obrigatória na tela e também no banco (migration 20261111010000: 5 a 500 caracteres úteis, mesmas regras daqui). */
export function validatePilotNote(note: string): string | null {
  const n = note.trim();
  if (n.length < PILOT_NOTE_MIN) return `Informe o motivo (mínimo ${PILOT_NOTE_MIN} caracteres).`;
  if (n.length > PILOT_NOTE_MAX) return `O motivo aceita no máximo ${PILOT_NOTE_MAX} caracteres.`;
  return null;
}

/** Só o booleano da trava global: ids da Meta e motivos internos são descartados. */
export function parseSignupAvailable(raw: unknown): boolean | null {
  return isObj(raw) && typeof raw.available === "boolean" ? raw.available : null;
}

// ------------------------------------------------------------------ registros incertos
export type RegistrationState = "uncertain" | "in_progress";
export interface RegistrationRow {
  registrationId: string;
  companyId: string;
  companyName: string;
  phoneNumberId: string | null;
  state: RegistrationState;
  lastErrorCode: string | null;
  updatedAt: string | null;
  tokenRetained: boolean;
  attemptsTotal: number;
  lastAttempt: { status: string | null; metaCode: string | null; startedAt: string | null; finishedAt: string | null } | null;
  resolutions: number;
}

export function parseRegistrations(raw: unknown): RegistrationRow[] {
  if (!Array.isArray(raw)) return [];
  const out: RegistrationRow[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const registrationId = str(r.registration_id);
    const companyId = str(r.company_id);
    if (!registrationId || !companyId || (r.state !== "uncertain" && r.state !== "in_progress")) continue;
    const la = isObj(r.last_attempt)
      ? { status: str(r.last_attempt.status), metaCode: str(r.last_attempt.meta_code), startedAt: str(r.last_attempt.started_at), finishedAt: str(r.last_attempt.finished_at) }
      : null;
    out.push({
      registrationId,
      companyId,
      companyName: str(r.company_name) ?? "—",
      phoneNumberId: str(r.phone_number_id),
      state: r.state,
      lastErrorCode: str(r.last_error_code),
      updatedAt: str(r.updated_at),
      tokenRetained: bool(r.token_retained),
      attemptsTotal: num(r.attempts_total),
      lastAttempt: la,
      resolutions: num(r.resolutions),
    });
  }
  return out;
}

export const REGISTRATION_STATE_LABEL: Record<RegistrationState, string> = { uncertain: "Incerto", in_progress: "Em andamento" };

export interface ResolveGate {
  allowed: boolean;
  reason: string | null;
  /** quando uma tentativa em andamento passa a poder ser resolvida */
  availableAt: Date | null;
}

/** Espelha a regra do backend: 'uncertain' sempre; 'in_progress' só com a última tentativa parada há mais de 30 min (sem tentativa = nunca). */
export function resolveGate(row: Pick<RegistrationRow, "state" | "lastAttempt">, now: Date): ResolveGate {
  if (row.state === "uncertain") return { allowed: true, reason: null, availableAt: null };
  const started = row.lastAttempt?.startedAt ? new Date(row.lastAttempt.startedAt) : null;
  if (!started || Number.isNaN(started.getTime())) {
    return { allowed: false, reason: "Sem tentativa registrada: não há evidência de que a operação parou. Investigue na Meta antes de qualquer ação.", availableAt: null };
  }
  const at = new Date(started.getTime() + IN_FLIGHT_MINUTES * 60 * 1000);
  if (now.getTime() <= at.getTime()) {
    return {
      allowed: false,
      reason: `Tentativa em andamento: a chamada à Meta pode ainda estar em curso. Liberada após ${IN_FLIGHT_MINUTES} minutos sem atividade.`,
      availableAt: at,
    };
  }
  return { allowed: true, reason: null, availableAt: null };
}

export type Outcome = "registered" | "failed";
export type EvidenceType = "meta_dashboard" | "graph_api_check" | "meta_support" | "customer_confirmation";
export const OUTCOME_LABEL: Record<Outcome, string> = {
  registered: "O número ESTÁ registrado na Meta",
  failed: "O número NÃO está registrado (registro falhou)",
};
export const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  meta_dashboard: "Painel da Meta (WhatsApp Manager)",
  graph_api_check: "Consulta à Graph API",
  meta_support: "Suporte da Meta",
  customer_confirmation: "Confirmação do cliente",
};
export const EVIDENCE_TYPES = Object.keys(EVIDENCE_LABEL) as EvidenceType[];
export const REASON_MIN = 10;
export const REASON_MAX = 500;
export const EVIDENCE_MIN = 10;
export const EVIDENCE_MAX = 1000;

export interface ResolveForm {
  outcome: Outcome | "";
  evidenceType: EvidenceType | "";
  reason: string;
  evidence: string;
  confirmed: boolean;
}
export const EMPTY_RESOLVE_FORM: ResolveForm = { outcome: "", evidenceType: "", reason: "", evidence: "", confirmed: false };

export function validateResolveForm(f: ResolveForm): string[] {
  const errs: string[] = [];
  if (f.outcome !== "registered" && f.outcome !== "failed") errs.push("Escolha o estado de destino.");
  if (!f.evidenceType || !EVIDENCE_TYPES.includes(f.evidenceType)) errs.push("Escolha o tipo de evidência.");
  const r = f.reason.trim();
  const e = f.evidence.trim();
  if (r.length < REASON_MIN || r.length > REASON_MAX) errs.push(`O motivo precisa ter de ${REASON_MIN} a ${REASON_MAX} caracteres.`);
  if (e.length < EVIDENCE_MIN || e.length > EVIDENCE_MAX) errs.push(`A descrição da evidência precisa ter de ${EVIDENCE_MIN} a ${EVIDENCE_MAX} caracteres.`);
  if (!f.confirmed) errs.push("Confirme que a conferência foi feita na Meta antes de resolver.");
  return errs;
}

// ------------------------------------------------------------------ erros de RPC
/** Mensagem segura para a tela: nunca ecoa texto de rede ou de banco fora das recusas conhecidas. */
export function friendlyRpcError(message: string | null | undefined): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("acesso restrito")) return "Acesso restrito a administradores da plataforma.";
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("fetch")) return "Falha de conexão. Verifique a internet e tente novamente.";
  if (m.includes("não encontrada") || m.includes("nao encontrada")) return "Registro ou empresa não encontrada.";
  if (m.includes("motivo") || m.includes("evid")) return "Dados inválidos: confira o motivo e a evidência.";
  return "Não foi possível concluir a operação. Tente novamente.";
}
