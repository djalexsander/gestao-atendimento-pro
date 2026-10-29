// WhatsApp e IA como módulos independentes: estado, orientações e textos das telas de Conexão e de IA.
// O servidor decide de verdade (RPCs com assert_company_module); aqui só se decide o que MOSTRAR.

export interface SignupAvailability {
  available: boolean;
  /** pending_meta_approval = a plataforma ainda não liberou o cadastro integrado (aprovação da Meta pendente). */
  reason: string | null;
}

/** Aviso de saúde do token para owner/admin (nunca traz token nem segredo). */
export interface TokenAlert {
  kind: "expiring" | "expired" | "revoked";
  level: "warning" | "critical";
  daysLeft: number | null;
  reconnect: boolean;
}

export interface ModuleState {
  whatsapp: boolean;
  ia: boolean;
  aiAllowed: boolean;
  connectionActive: boolean;
  hasHistory: boolean;
  canManage: boolean;
  signup: SignupAvailability;
  tokenAlert: TokenAlert | null;
}

export interface AiIndicators {
  periodDays: number;
  jobsByOutcome: Record<string, number>;
  aiReplies: number;
  handoffs: number;
  conversationsUnderHuman: number;
  ordersByAi: number;
}

export function toModuleState(raw: unknown): ModuleState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (o.signup && typeof o.signup === "object" ? o.signup : {}) as Record<string, unknown>;
  const whatsapp = o.whatsapp === true;
  const ia = o.ia === true;
  return {
    whatsapp,
    ia,
    // nunca confia só no que veio: a automação exige os dois
    aiAllowed: whatsapp && ia && o.ai_allowed === true,
    connectionActive: o.connection_active === true,
    hasHistory: o.has_history === true,
    canManage: o.can_manage === true,
    signup: { available: s.available === true, reason: typeof s.reason === "string" ? s.reason : null },
    tokenAlert: toTokenAlert(o.connection_alert),
  };
}

export function toTokenAlert(raw: unknown): TokenAlert | null {
  const o = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!o) return null;
  const kind = o.kind;
  if (kind !== "expiring" && kind !== "expired" && kind !== "revoked") return null;
  const days = typeof o.days_left === "number" && Number.isFinite(o.days_left) ? Math.max(0, Math.floor(o.days_left)) : null;
  return { kind, level: kind === "expiring" ? "warning" : "critical", daysLeft: kind === "expiring" ? days : null, reconnect: o.reconnect === true };
}

/** Texto do aviso. Nunca menciona token, PIN ou credencial (só o que o usuário precisa fazer). */
export function tokenAlertText(a: TokenAlert): string {
  if (a.kind === "expiring") {
    const d = a.daysLeft;
    const when = d === null ? "em breve" : d <= 0 ? "hoje" : d === 1 ? "em 1 dia" : `em ${d} dias`;
    return `A autorização da conexão do WhatsApp vence ${when}. Refaça a conexão antes disso para não interromper o envio de mensagens.`;
  }
  if (a.kind === "expired") {
    return "A autorização da conexão do WhatsApp expirou. O recebimento de mensagens continua, mas o envio está pausado até a conexão ser refeita.";
  }
  return "A autorização da conexão do WhatsApp foi revogada ou ficou inválida. O recebimento de mensagens continua, mas o envio está pausado até a conexão ser refeita.";
}

export const TOKEN_RECONNECT_SUPPORT_TEXT =
  "A reconexão automática ainda não está liberada para a sua empresa. Fale com a equipe da Alex Pro Apps para refazer a conexão do número; o histórico é mantido.";

export function toAiIndicators(raw: unknown): AiIndicators {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const jobs: Record<string, number> = {};
  if (o.jobs_by_outcome && typeof o.jobs_by_outcome === "object") {
    for (const [k, v] of Object.entries(o.jobs_by_outcome as Record<string, unknown>)) jobs[k] = num(v);
  }
  return {
    periodDays: num(o.period_days) || 30,
    jobsByOutcome: jobs,
    aiReplies: num(o.ai_replies),
    handoffs: num(o.handoffs),
    conversationsUnderHuman: num(o.conversations_under_human),
    ordersByAi: num(o.orders_by_ai),
  };
}

/** O que a tela de IA deve mostrar: configuração, orientação de dependência ou convite. */
export type AiPanelKind = "ready" | "needs_whatsapp" | "not_contracted";
export function aiPanelKind(s: Pick<ModuleState, "whatsapp" | "ia">): AiPanelKind {
  if (!s.ia) return "not_contracted";
  if (!s.whatsapp) return "needs_whatsapp";
  return "ready";
}

export const AI_NEEDS_WHATSAPP_TEXT =
  "O módulo Inteligência Artificial atende pelo WhatsApp. Para usá-lo, a empresa também precisa do módulo WhatsApp. Seu contrato não foi alterado.";
export const AI_NOT_CONTRACTED_TEXT = "O módulo Inteligência Artificial ainda não está disponível para a sua empresa.";
export const WHATSAPP_NOT_CONTRACTED_TEXT = "O módulo WhatsApp ainda não está disponível para a sua empresa.";

export const SIGNUP_UNAVAILABLE_TEXT =
  "A conexão automática pela Meta (Cadastro Integrado) ainda depende de aprovação da Meta e não está liberada. Enquanto isso, o número é conectado pela equipe da Alex Pro Apps.";

export const SIGNUP_NOT_AUTHORIZED_TEXT =
  "A conexão automática pela Meta ainda não foi liberada para a sua empresa. Fale com a equipe da Alex Pro Apps para participar do piloto; enquanto isso, o número é conectado por eles.";

/** Palavra que o usuário digita para confirmar a desconexão (o banco confere de novo). */
export const DISCONNECT_CONFIRM_WORD = "DESCONECTAR";
export const DISCONNECT_WARNING =
  "Ao desconectar, o sistema deixa de receber e enviar mensagens por este número. O histórico de conversas e as configurações são mantidos.";

export function connectionStatusLabel(status: string | null, configured: boolean): string {
  if (!configured) return "Não conectado";
  switch (status) {
    case "active":
      return "Conectado";
    case "pending":
      return "Aguardando conexão";
    case "disconnected":
      return "Desconectado";
    case "error":
      return "Com erro";
    default:
      return "Indisponível";
  }
}

export const OUTCOME_LABEL: Record<string, string> = {
  replied: "Respondidas pela IA",
  handoff: "Transferidas para humano",
  ignored: "Ignoradas",
  aborted_human: "Interrompidas (humano assumiu)",
  aborted_mode: "Interrompidas (IA desligada)",
  aborted_closed: "Interrompidas (conversa fechada)",
  provider_error: "Falha do provedor",
};

export function friendlyModuleError(message: string | null | undefined): string {
  return message && message.length <= 200 ? message : "Não foi possível concluir agora. Tente novamente.";
}
