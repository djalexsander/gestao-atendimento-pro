// Lógica PURA de duas telas novas do "Iniciar conversa" (Etapa 7.11M): (1) Atualizar templates (Edge whatsapp-templates-sync) e (2) configuração por empresa
// feita pelo Master (RPC whatsapp_set_start_settings). Sem React, sem Supabase, sem relógio. O servidor continua sendo a autoridade (papel, módulo,
// empresa, conexão, intervalo mínimo, lease, Master): aqui só se interpreta a resposta e se conferem os limites ANTES de chamar.
// Nenhum token, telefone ou texto bruto da Meta passa por aqui.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// 1) Atualizar templates
// ---------------------------------------------------------------------------
/** Só owner/admin veem o botão na empresa (o Master usa o painel Master). O servidor revalida o papel. */
export const SYNC_ROLES: readonly string[] = ["owner", "admin"];
export const canSyncTemplates = (role: string | null | undefined): boolean => !!role && SYNC_ROLES.includes(role);

export type SyncOutcome =
  | { kind: "ok"; complete: boolean; pages: number; received: number; removed: number; templateCount: number | null }
  | { kind: "running" }
  | { kind: "error"; message: string; code: string | null };

export const SYNC_TEXT = {
  idle: "Busca na Meta a lista de templates aprovados desta empresa. Só lê: não cria, altera nem envia nada.",
  running: "Atualizando os templates…",
  runningElsewhere: "Já existe uma atualização em andamento para esta empresa. Aguarde alguns instantes e consulte de novo.",
  incomplete: "A lista da Meta veio incompleta: nada foi marcado como removido. Tente novamente.",
  network: "Não foi possível falar com o servidor agora. Tente novamente em instantes.",
  unexpected: "Resposta inesperada do servidor. Tente novamente.",
} as const;

/** Mensagem segura por status HTTP quando o corpo não traz texto próprio. */
export function friendlySyncError(httpStatus: number): string {
  switch (httpStatus) {
    case 400:
      return "Pedido inválido.";
    case 401:
      return "Sessão expirada. Entre novamente.";
    case 403:
      return "Você não tem permissão para atualizar os templates.";
    case 404:
      return "Empresa não encontrada.";
    case 409:
      return "Não foi possível atualizar agora. Confira a conexão do WhatsApp e se o recurso está ativado para a empresa.";
    case 429:
      return "A Meta pediu para aguardar. Tente novamente em alguns minutos.";
    case 503:
      return "Atualização de templates indisponível no momento.";
    case 504:
      return "A Meta demorou para responder. Tente novamente.";
    default:
      return "Não foi possível atualizar os templates agora. Tente novamente em instantes.";
  }
}

export function toSyncOutcome(httpStatus: number, body: unknown): SyncOutcome {
  const b = isObj(body) ? body : null;
  if (httpStatus >= 200 && httpStatus < 300) {
    if (b && b.status === "running") return { kind: "running" };
    if (b && b.status === "ok" && typeof b.complete === "boolean") {
      return { kind: "ok", complete: b.complete, pages: num(b.pages) ?? 0, received: num(b.received) ?? 0, removed: num(b.removed) ?? 0, templateCount: num(b.template_count) };
    }
    return { kind: "error", message: SYNC_TEXT.unexpected, code: null };
  }
  // a mensagem do servidor já é em português e sem dados sensíveis; sem corpo, usa a padrão do status
  const message = b && str(b.error) ? (b.error as string) : friendlySyncError(httpStatus);
  return { kind: "error", message, code: b ? str(b.code) : null };
}

export const NETWORK_SYNC_OUTCOME: SyncOutcome = { kind: "error", message: SYNC_TEXT.network, code: null };

/** Texto do resultado para a tela (nada de contagem de removidos se a lista veio incompleta). */
export function syncSummary(o: SyncOutcome): string {
  if (o.kind === "running") return SYNC_TEXT.runningElsewhere;
  if (o.kind === "error") return o.message;
  const total = o.templateCount === null ? "" : ` Templates no cache: ${o.templateCount}.`;
  if (!o.complete) return `${SYNC_TEXT.incomplete} Recebidos: ${o.received}.`;
  return `Atualização concluída. Recebidos da Meta: ${o.received}${o.removed > 0 ? `; removidos do cache (sumiram da Meta): ${o.removed}` : ""}.${total}`;
}

export const CATEGORY_LABEL: Record<string, string> = { MARKETING: "Marketing", UTILITY: "Utilidade", AUTHENTICATION: "Autenticação" };
export const categoryLabel = (c: string | null | undefined): string => (c ? (CATEGORY_LABEL[c.toUpperCase()] ?? c) : "Sem categoria");
/** Marketing e utilidade são cobrados pela Meta por conversa iniciada pela empresa; a tela só avisa. */
export const categoryIsBilled = (c: string | null | undefined): boolean => !!c && ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(c.toUpperCase());

// ---------------------------------------------------------------------------
// 2) Acesso por empresa (Master): AUTOMÁTICO pelo módulo WhatsApp; o Master só BLOQUEIA/LIBERA e ajusta os limites
// ---------------------------------------------------------------------------
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 1000;
export const INTERVAL_MIN = 0;
export const INTERVAL_MAX = 720;
export const DEFAULT_DAILY_LIMIT = 50;
export const DEFAULT_INTERVAL_HOURS = 24;

export type StartReason = "available" | "blocked" | "no_module" | "read_only";
export type AccessSource = "subscription" | "courtesy" | "override" | "trial" | "unmanaged" | "none";
const REASONS: readonly string[] = ["available", "blocked", "no_module", "read_only"];
const SOURCES: readonly string[] = ["subscription", "courtesy", "override", "trial", "unmanaged", "none"];

export const REASON_LABEL: Record<StartReason, string> = {
  available: "Disponível",
  blocked: "Bloqueado pelo Master",
  no_module: "Sem módulo WhatsApp",
  read_only: "Somente leitura (assinatura restrita)",
};
export const SOURCE_LABEL: Record<AccessSource, string> = {
  subscription: "Módulo contratado",
  courtesy: "Cortesia",
  override: "Liberado pelo Master (módulo)",
  trial: "Período de teste",
  unmanaged: "Empresa sem gestão de plano",
  none: "Sem direito ao módulo",
};
export const ACTION_LABEL: Record<string, string> = { created: "Configuração criada", blocked: "Bloqueada pelo Master", unblocked: "Liberada pelo Master", limits_changed: "Limites alterados" };

export interface StartOverviewRow {
  companyId: string;
  name: string;
  moduleActive: boolean;
  blocked: boolean;
  readOnly: boolean;
  available: boolean;
  reason: StartReason;
  source: AccessSource;
  dailyLimit: number;
  minIntervalHours: number;
  usedToday: number;
  hasSettings: boolean;
  updatedAt: string | null;
  connection: { type: string; status: string } | null;
}

export interface StartEvent {
  action: string;
  at: string | null;
  actorUserId: string | null;
}

export interface StartOverview {
  companies: StartOverviewRow[];
  events: StartEvent[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resposta de master_whatsapp_start_overview. Linha malformada é descartada; formato estranho = null (a tela diz que não leu). */
export function toStartOverview(raw: unknown): StartOverview | null {
  if (!isObj(raw) || !Array.isArray(raw.companies)) return null;
  const companies: StartOverviewRow[] = [];
  for (const c of raw.companies) {
    if (!isObj(c) || typeof c.company_id !== "string" || !UUID.test(c.company_id)) continue;
    const name = str(c.name);
    const reason = typeof c.reason === "string" && REASONS.includes(c.reason) ? (c.reason as StartReason) : null;
    const source = typeof c.source === "string" && SOURCES.includes(c.source) ? (c.source as AccessSource) : null;
    const daily = num(c.daily_limit);
    const interval = num(c.min_interval_hours);
    if (!name || !reason || !source || daily === null || interval === null) continue;
    if (typeof c.available !== "boolean" || typeof c.blocked !== "boolean" || typeof c.module_active !== "boolean") continue;
    const k = isObj(c.connection) && typeof c.connection.type === "string" && typeof c.connection.status === "string" ? { type: c.connection.type, status: c.connection.status } : null;
    companies.push({
      companyId: c.company_id,
      name,
      moduleActive: c.module_active,
      blocked: c.blocked,
      readOnly: c.read_only === true,
      available: c.available,
      reason,
      source,
      dailyLimit: daily,
      minIntervalHours: interval,
      usedToday: num(c.used_today) ?? 0,
      hasSettings: c.has_settings === true,
      updatedAt: str(c.updated_at),
      connection: k,
    });
  }
  const events: StartEvent[] = [];
  for (const e of Array.isArray(raw.events) ? raw.events : []) {
    if (!isObj(e)) continue;
    const action = str(e.action);
    if (action) events.push({ action, at: str(e.at), actorUserId: str(e.actor_user_id) });
  }
  return { companies, events };
}

/** Resposta de whatsapp_set_start_settings: enabled=true significa LIBERADA; false, BLOQUEADA pelo Master. */
export interface SavedStartSettings {
  blocked: boolean;
  dailyLimit: number;
  minIntervalHours: number;
}
export function toSavedStartSettings(raw: unknown): SavedStartSettings | null {
  if (!isObj(raw) || typeof raw.enabled !== "boolean") return null;
  const limit = num(raw.daily_limit);
  const interval = num(raw.min_interval_hours);
  if (limit === null || interval === null) return null;
  return { blocked: !raw.enabled, dailyLimit: limit, minIntervalHours: interval };
}

export interface StartSettingsFormInput {
  companyId: string;
  blocked: boolean;
  dailyLimit: string;
  minIntervalHours: string;
}

export interface StartSettingsFormIssues {
  ok: boolean;
  company: string | null;
  dailyLimit: string | null;
  minIntervalHours: string | null;
  value: { blocked: boolean; dailyLimit: number; minIntervalHours: number } | null;
}

const WHOLE = /^\d{1,5}$/;

/** MESMOS limites do servidor: limite diário de 1 a 1000, intervalo de 0 a 720 horas, números inteiros. */
export function validateStartSettings(i: StartSettingsFormInput): StartSettingsFormIssues {
  const company = UUID.test(i.companyId) ? null : "Selecione a empresa.";
  const limitText = i.dailyLimit.trim();
  const intervalText = i.minIntervalHours.trim();
  const limit = WHOLE.test(limitText) ? Number(limitText) : NaN;
  const interval = WHOLE.test(intervalText) ? Number(intervalText) : NaN;
  const dailyLimit = Number.isInteger(limit) && limit >= LIMIT_MIN && limit <= LIMIT_MAX ? null : `Informe um número inteiro de ${LIMIT_MIN} a ${LIMIT_MAX}.`;
  const minIntervalHours = Number.isInteger(interval) && interval >= INTERVAL_MIN && interval <= INTERVAL_MAX ? null : `Informe um número inteiro de ${INTERVAL_MIN} a ${INTERVAL_MAX} horas.`;
  const ok = company === null && dailyLimit === null && minIntervalHours === null;
  return { ok, company, dailyLimit, minIntervalHours, value: ok ? { blocked: i.blocked, dailyLimit: limit, minIntervalHours: interval } : null };
}

/** BLOQUEAR pede confirmação (derruba o recurso da empresa); liberar e ajustar limites não. */
export const needsBlockConfirmation = (blocked: boolean, current: { blocked: boolean } | null): boolean => blocked && !(current && current.blocked);

export const BLOCK_CONFIRM_TEXT = {
  title: "Bloquear Iniciar conversa",
  body: "Com o bloqueio, esta empresa NÃO poderá iniciar conversas por template, mesmo tendo o módulo WhatsApp ativo. As conversas já abertas e o atendimento normal continuam. Você pode liberar de novo a qualquer momento.",
  confirm: "Bloquear esta empresa",
} as const;

export const ACCESS_RULE_TEXT =
  "Iniciar conversa faz parte do módulo WhatsApp: fica disponível sozinho para toda empresa com direito ativo ao módulo (assinatura, cortesia válida ou liberação do Master). Aqui você só pode bloquear uma empresa, liberar de novo e ajustar os limites. Sem configuração, vale 50 por dia e 24 h por contato.";

export function startRowLine(r: Pick<StartOverviewRow, "blocked" | "dailyLimit" | "minIntervalHours">): string {
  return `${r.blocked ? "Bloqueado" : "Liberado"} · limite de ${r.dailyLimit} por dia · intervalo mínimo de ${r.minIntervalHours} h por contato`;
}

/** Erros do servidor na gravação: o texto do banco já é em português; sem ele, mensagem padrão. */
export function mapSetSettingsError(e: { code?: string | null; message?: string | null }): string {
  switch (e.code) {
    case "PT401":
      return "Sessão expirada. Entre novamente.";
    case "PT403":
      return "Somente o administrador da plataforma pode alterar esta configuração.";
    case "PT404":
      return "Empresa não encontrada.";
    case "PT400":
      return e.message || "Configuração inválida.";
    default:
      return "Não foi possível salvar agora. Tente novamente.";
  }
}
