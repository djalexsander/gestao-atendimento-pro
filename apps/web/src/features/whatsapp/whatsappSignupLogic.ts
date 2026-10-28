// Conexão do WhatsApp pelo Embedded Signup v4 da Meta — lógica PURA do front (sem DOM, sem rede, sem Supabase).
// O servidor decide de verdade (RPC whatsapp_signup_begin + Edge whatsapp-signup-complete); aqui só se decide o que MOSTRAR e como
// interpretar o que o navegador recebe. Nada que venha do navegador (postMessage, IDs) é prova de nada: o backend revalida tudo.
import type { ModuleState } from "./whatsappModulesLogic";
import { SIGNUP_UNAVAILABLE_TEXT } from "./whatsappModulesLogic";

/** SDK oficial (documentação do Embedded Signup v4 / Facebook Login for Business). */
export const FACEBOOK_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
/** Versão passada ao FB.init (a da documentação vigente). Fica aqui para ser atualizada num lugar só. */
export const FACEBOOK_SDK_VERSION = "v26.0";
/** Depois que o authorization code chega, o evento FINISH (waba/número) precisa chegar em até este tempo. O code vale ~30 s. */
export const SIGNUP_FINISH_WAIT_MS = 15_000;
/** Limite de envios de PIN numa mesma tela (cada envio é uma ação do usuário; nunca há tentativa automática). */
export const MAX_PIN_SUBMISSIONS = 3;

const ID_RE = /^[0-9]{5,40}$/;
const STATE_RE = /^[0-9a-f]{64}$/;
const PIN_RE = /^[0-9]{6}$/;

// ---------------------------------------------------------------------------------------------------------------------
// Visibilidade do botão
// ---------------------------------------------------------------------------------------------------------------------
export interface ConnectCard {
  /** O botão aparece? Só owner/admin, módulo WhatsApp contratado e SEM conexão ativa. */
  visible: boolean;
  /** O botão está utilizável? Só com a plataforma liberada (flag do operador) e fora do app Desktop. */
  enabled: boolean;
  hint: string | null;
}

export const DESKTOP_UNSUPPORTED_TEXT =
  "Para conectar o WhatsApp, abra o sistema pelo navegador (versão web). A janela da Meta não funciona no aplicativo de computador.";

export function connectCard(state: Pick<ModuleState, "whatsapp" | "canManage" | "connectionActive" | "signup">, desktop = false): ConnectCard {
  const visible = state.canManage && state.whatsapp && !state.connectionActive;
  if (!visible) return { visible: false, enabled: false, hint: null };
  if (desktop) return { visible: true, enabled: false, hint: DESKTOP_UNSUPPORTED_TEXT };
  if (!state.signup.available) return { visible: true, enabled: false, hint: SIGNUP_UNAVAILABLE_TEXT };
  return { visible: true, enabled: true, hint: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// PIN de verificação em duas etapas (6 dígitos)
// ---------------------------------------------------------------------------------------------------------------------
export const isValidPin = (v: unknown): v is string => typeof v === "string" && PIN_RE.test(v);
/** Mantém só dígitos (até 6) enquanto o usuário digita/cola. */
export const sanitizePinInput = (v: string): string => v.replace(/\D/g, "").slice(0, 6);

// ---------------------------------------------------------------------------------------------------------------------
// Sessão (retorno de whatsapp_signup_begin)
// ---------------------------------------------------------------------------------------------------------------------
export interface SignupSession {
  state: string;
  appId: string;
  configId: string;
}

/** Valida o contrato real: { state: 64 hex, meta_app_id, config_id } (o servidor só devolve isso com a plataforma liberada). */
export function toSignupSession(raw: unknown): SignupSession | null {
  const o = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!o) return null;
  const { state, meta_app_id: appId, config_id: configId } = o;
  if (typeof state !== "string" || !STATE_RE.test(state)) return null;
  if (typeof appId !== "string" || !ID_RE.test(appId) || typeof configId !== "string" || !ID_RE.test(configId)) return null;
  return { state, appId, configId };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mensagens do popup da Meta (window.postMessage)
// ---------------------------------------------------------------------------------------------------------------------
/** Origem estritamente da Meta: https + facebook.com ou subdomínio (www., web.). "evilfacebook.com" e http NÃO passam. */
export function isMetaOrigin(origin: unknown): boolean {
  if (typeof origin !== "string") return false;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.port === "" && (u.hostname === "facebook.com" || u.hostname.endsWith(".facebook.com"));
  } catch {
    return false;
  }
}

export type SignupMessage =
  | { kind: "finish"; wabaId: string; phoneNumberId: string }
  | { kind: "cancel" }
  | { kind: "error" }
  | { kind: "unsupported" };

/**
 * Interpreta um evento WA_EMBEDDED_SIGNUP. Devolve null para qualquer coisa que não seja dele (outra origem, outro tipo, lixo).
 * Os IDs são só DICAS para o backend: ele confirma na Meta, com o token do cliente, que o número pertence à WABA.
 * Mensagens de erro e códigos da Meta são descartados (não são mostrados nem registrados).
 */
export function parseSignupMessage(origin: unknown, data: unknown): SignupMessage | null {
  if (!isMetaOrigin(origin)) return null;
  let d: unknown = data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (o.type !== "WA_EMBEDDED_SIGNUP") return null;
  const event = typeof o.event === "string" ? o.event : "";
  const payload = (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
  if (event === "FINISH") {
    const waba = payload.waba_id;
    const phone = payload.phone_number_id;
    if (typeof waba !== "string" || !ID_RE.test(waba) || typeof phone !== "string" || !ID_RE.test(phone)) return { kind: "error" };
    return { kind: "finish", wabaId: waba, phoneNumberId: phone };
  }
  if (event.startsWith("FINISH_")) return { kind: "unsupported" }; // Coexistence/apenas WABA etc.: fora desta etapa
  if (event === "ERROR") return { kind: "error" };
  if (event === "CANCEL") return typeof payload.error_message === "string" ? { kind: "error" } : { kind: "cancel" };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Falhas e mensagens amigáveis
// ---------------------------------------------------------------------------------------------------------------------
export type SignupFailureKind =
  | "unavailable"
  | "forbidden"
  | "session_invalid"
  | "state_invalid"
  | "state_expired"
  | "state_used"
  | "phone_in_use"
  | "company_connected"
  | "pin_required"
  | "pin_incorrect"
  | "blocked"
  | "uncertain"
  | "meta_unreachable"
  | "meta_authorization"
  | "meta_account"
  | "meta_failed"
  | "sdk_unavailable"
  | "meta_error"
  | "unsupported"
  | "incomplete"
  | "cancelled"
  | "generic";

export interface SignupFailure {
  kind: SignupFailureKind;
  message: string;
  /** Mostra o formulário do PIN de 6 dígitos. */
  pinNeeded: boolean;
  /** Oferece "Tentar novamente"? Sempre exige um clique do usuário (nunca automático). Falso = contate o suporte / aguarde. */
  canRetry: boolean;
}

const F = (kind: SignupFailureKind, message: string, canRetry = true, pinNeeded = false): SignupFailure => ({ kind, message, canRetry, pinNeeded });

export const SIGNUP_TEXT = {
  unavailable: SIGNUP_UNAVAILABLE_TEXT,
  forbidden: "Você não tem permissão para conectar o WhatsApp desta empresa.",
  sessionInvalid: "Sua sessão expirou. Entre novamente e tente de novo.",
  stateInvalid: "A sessão de conexão é inválida. Inicie a conexão novamente.",
  stateExpired: "A sessão de conexão expirou. Inicie a conexão novamente.",
  stateUsed: "Esta sessão de conexão já foi utilizada. Inicie a conexão novamente.",
  phoneInUse: "Este número já está conectado a outra empresa. Se ele é seu, fale com o suporte da Alex Pro Apps.",
  companyConnected: "Esta empresa já tem um número conectado. Desconecte-o antes de conectar outro.",
  pinRequired: "Este número já tem verificação em duas etapas no WhatsApp. Informe o PIN atual de 6 dígitos para continuar.",
  pinIncorrect: "O PIN informado está incorreto. Confira o PIN de verificação em duas etapas do número e tente de novo.",
  blocked: "O registro deste número está temporariamente bloqueado pela Meta. Aguarde e tente novamente mais tarde.",
  uncertain: "Não foi possível confirmar o registro deste número. Não tente novamente agora; fale com o suporte da Alex Pro Apps.",
  metaUnreachable: "A Meta não respondeu. Tente novamente em instantes.",
  metaAuthorization: "A autorização da Meta expirou ou é inválida. Inicie a conexão novamente.",
  metaAccount: "Não foi possível validar a conta do WhatsApp Business informada. Tente novamente.",
  metaFailed: "A Meta não concluiu a configuração do número. Tente novamente mais tarde.",
  sdkUnavailable: "Não foi possível carregar o cadastro da Meta. Verifique sua conexão e se algum bloqueador impede facebook.com, e tente de novo.",
  metaError: "A Meta informou um erro durante o cadastro. Tente novamente.",
  unsupported: "Este tipo de conexão ainda não é suportado. Escolha a opção de número novo na janela da Meta.",
  incomplete: "O cadastro da Meta não foi concluído por completo. Inicie a conexão novamente.",
  cancelled: "Conexão cancelada. Se a janela da Meta não abriu, libere pop-ups para este site e tente novamente.",
  generic: "Não foi possível concluir a conexão do WhatsApp. Tente novamente.",
} as const;

/** Falha ao criar a sessão (RPC whatsapp_signup_begin): os erros PT4xx do banco. */
export function mapBeginFailure(code: string | null | undefined): SignupFailure {
  switch (code) {
    case "PT409": return F("unavailable", SIGNUP_TEXT.unavailable, false);
    case "PT401": return F("session_invalid", SIGNUP_TEXT.sessionInvalid, false);
    case "PT403": case "PT404": return F("forbidden", SIGNUP_TEXT.forbidden, false);
    case "PT429": return F("blocked", "Muitas tentativas de conexão. Aguarde alguns minutos e tente novamente.", false);
    default: return F("generic", SIGNUP_TEXT.generic);
  }
}

/** Resposta de erro da Edge: { error, code? } + status HTTP. Só o código/status decidem; o texto vem daqui (nunca da Meta). */
export function mapCompleteFailure(status: number | null, code: string | null | undefined): SignupFailure {
  switch (code) {
    case "pin_required": return F("pin_required", SIGNUP_TEXT.pinRequired, true, true);
    case "pin_incorrect": return F("pin_incorrect", SIGNUP_TEXT.pinIncorrect, true, true);
    case "phone_in_use": return F("phone_in_use", SIGNUP_TEXT.phoneInUse, false);
    case "company_has_active_connection": return F("company_connected", SIGNUP_TEXT.companyConnected, false);
    case "registration_blocked": case "attempts_exhausted": return F("blocked", SIGNUP_TEXT.blocked, false);
    case "registration_uncertain": case "registration_in_progress": return F("uncertain", SIGNUP_TEXT.uncertain, false);
    case "user_mismatch": return F("forbidden", SIGNUP_TEXT.forbidden, false);
    case "meta_code_exchange": return status !== null && status >= 500 ? F("meta_unreachable", SIGNUP_TEXT.metaUnreachable) : F("meta_authorization", SIGNUP_TEXT.metaAuthorization);
    case "meta_waba_lookup": case "phone_not_in_waba": return status !== null && status >= 500 ? F("meta_unreachable", SIGNUP_TEXT.metaUnreachable) : F("meta_account", SIGNUP_TEXT.metaAccount);
    case "meta_register_failed": case "meta_subscribe_failed": case "meta_subscribe_unverified": return F("meta_failed", SIGNUP_TEXT.metaFailed);
    default: break;
  }
  switch (status) {
    case 401: return F("session_invalid", SIGNUP_TEXT.sessionInvalid, false);
    case 403: return F("forbidden", SIGNUP_TEXT.forbidden, false);
    case 400: return F("state_invalid", SIGNUP_TEXT.stateInvalid);
    case 409: return F("state_used", SIGNUP_TEXT.stateUsed);
    case 410: return F("state_expired", SIGNUP_TEXT.stateExpired);
    case 503: return F("unavailable", SIGNUP_TEXT.unavailable, false);
    default: return F("generic", SIGNUP_TEXT.generic);
  }
}

export const signupFailure = (kind: Exclude<SignupFailureKind, "pin_required" | "pin_incorrect">): SignupFailure => {
  switch (kind) {
    case "sdk_unavailable": return F(kind, SIGNUP_TEXT.sdkUnavailable);
    case "meta_error": return F(kind, SIGNUP_TEXT.metaError);
    case "unsupported": return F(kind, SIGNUP_TEXT.unsupported, false);
    case "incomplete": return F(kind, SIGNUP_TEXT.incomplete);
    case "cancelled": return F(kind, SIGNUP_TEXT.cancelled);
    default: return F("generic", SIGNUP_TEXT.generic);
  }
};
