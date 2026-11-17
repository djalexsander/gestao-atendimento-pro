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
// 2) Configuração por empresa (Master)
// ---------------------------------------------------------------------------
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 1000;
export const INTERVAL_MIN = 0;
export const INTERVAL_MAX = 720;
export const DEFAULT_DAILY_LIMIT = 50;
export const DEFAULT_INTERVAL_HOURS = 24;

export interface SavedStartSettings {
  enabled: boolean;
  dailyLimit: number;
  minIntervalHours: number;
}

/** Resposta de whatsapp_set_start_settings (e, quando o Master pertence à empresa, de whatsapp_get_start_settings). */
export function toSavedStartSettings(raw: unknown): SavedStartSettings | null {
  if (!isObj(raw) || typeof raw.enabled !== "boolean") return null;
  const limit = num(raw.daily_limit);
  const interval = num(raw.min_interval_hours);
  if (limit === null || interval === null) return null;
  return { enabled: raw.enabled, dailyLimit: limit, minIntervalHours: interval };
}

export interface StartSettingsFormInput {
  companyId: string;
  enabled: boolean;
  dailyLimit: string;
  minIntervalHours: string;
}

export interface StartSettingsFormIssues {
  ok: boolean;
  company: string | null;
  dailyLimit: string | null;
  minIntervalHours: string | null;
  value: { enabled: boolean; dailyLimit: number; minIntervalHours: number } | null;
}

const WHOLE = /^\d{1,5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return { ok, company, dailyLimit, minIntervalHours, value: ok ? { enabled: i.enabled, dailyLimit: limit, minIntervalHours: interval } : null };
}

/** Habilitar (ou manter habilitado com outro limite/intervalo) pede confirmação; desabilitar não. */
export const needsEnableConfirmation = (enabled: boolean, current: SavedStartSettings | null): boolean => enabled && !(current && current.enabled);

export const ENABLE_CONFIRM_TEXT = {
  title: "Habilitar Iniciar conversa",
  body: "Com isto ligado, owner, admin e atendentes desta empresa poderão iniciar conversas por template aprovado da Meta. Cada conversa iniciada pela empresa pode ser cobrada pela Meta e depende do consentimento do contato.",
  confirm: "Habilitar para esta empresa",
} as const;

export const STATE_UNKNOWN_TEXT =
  "Não foi possível ler o estado atual desta empresa (o Master só lê o estado das empresas das quais participa). O que vale é o que o servidor confirmar ao salvar.";

export function startSettingsLine(s: SavedStartSettings): string {
  return `${s.enabled ? "Habilitado" : "Desabilitado"} · limite de ${s.dailyLimit} por dia · intervalo mínimo de ${s.minIntervalHours} h por contato`;
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
