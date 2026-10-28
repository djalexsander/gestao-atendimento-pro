// Edge Function whatsapp-signup-complete (verify_jwt = true): conclui a conexão de uma empresa pelo WhatsApp Embedded Signup v4.
//
// Entrada do navegador: { state, code, waba_id, phone_number_id }. NADA daqui é prova de propriedade: o state só localiza a
// sessão criada no banco por whatsapp_signup_begin (empresa + usuário + hash); o code é trocado no servidor; waba_id e
// phone_number_id só são aceitos se a PRÓPRIA Meta, com o token recém-obtido, listar o número naquela WABA. company_id nunca
// vem do corpo: vem da sessão reservada.
//
// Estágios (Graph API e Postgres NÃO formam uma transação distribuída; cada estágio falho encerra a sessão com whatsapp_signup_fail,
// que também apaga o segredo do Vault ainda não ligado a conexão):
//   1 reservar a sessão (consumo atômico, anti-replay)    5 guardar o token no Vault (antes de qualquer efeito na Meta)
//   2 trocar o code pelo business token                   6 registrar o número na Cloud API com o PIN INDIVIDUAL do número
//   3 validar WABA + número listados pela Meta            7 assinar o app na WABA e conferir a assinatura
//   4 conferir conflitos locais + estado do registro      8 concluir no banco (conexão active, modo test) e ligar o registro
// PIN: aleatório por número (CSPRNG), guardado no Vault ANTES de falar com a Meta; número que já tem PIN exige o PIN do cliente
// (campo opcional "pin" do corpo), que nunca sobrescreve nada. Registro duvidoso (timeout/rede/5xx) vira "uncertain" e NÃO é
// repetido sozinho; limite próprio de 3 tentativas/72 h por número; registro concluído nunca é repetido (a reconexão pula o passo).
// Só o estágio 8 cria/atualiza a conexão, e só depois de 5–7 terem dado certo: nunca fica uma conexão "pronta" pela metade.
// Nenhuma chamada externa roda dentro de transação do banco. Nada de code, token, secrets, URLs ou corpo da Meta é logado ou devolvido.
import { classifyRegisterFailure, generatePin, PIN_RE, type SignupMeta } from "../_shared/whatsapp-signup-graph.ts";
import { isValidGraphVersion } from "../_shared/whatsapp-graph.ts";

export interface RpcError {
  code?: string;
  message: string;
}
export interface RpcResult {
  data: unknown;
  error: RpcError | null;
}

export interface SignupDeps {
  /** Valida o JWT e devolve o id do usuário (null = inválido/expirado). */
  authenticate(authorization: string): Promise<{ userId: string } | null>;
  /** service_role: RPCs whatsapp_signup_*. */
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  /** service_role: leituras mínimas. */
  platform(): Promise<{ enabled: boolean; appId: string | null } | null>;
  findPhoneOwner(phoneNumberId: string): Promise<{ companyId: string } | null>;
  findActiveConnection(companyId: string): Promise<{ phoneNumberId: string | null } | null>;
  meta: SignupMeta;
  /** WHATSAPP_GRAPH_API_VERSION (mesmo secret do envio; sem default). */
  graphVersion: string | undefined;
  /** WHATSAPP_APP_SECRET (o mesmo App Secret que assina o webhook). */
  appSecret: string | undefined;
  /** Gerador de PIN (padrão: CSPRNG). Só os testes substituem. */
  randomPin?: () => string;
  now?: () => Date;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY_BYTES = 16 * 1024;
const ID_RE = /^[0-9]{5,40}$/;
const STATE_RE = /^[A-Za-z0-9]{32,128}$/;
const GENERIC = "Não foi possível concluir a conexão do WhatsApp. Tente novamente.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function rpc(deps: SignupDeps, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    return await deps.rpc(fn, args);
  } catch {
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

const SESSION_ERRORS: Record<string, [number, string]> = {
  invalid_state: [400, "Sessão de conexão inválida. Inicie a conexão novamente."],
  expired: [410, "A sessão de conexão expirou. Inicie a conexão novamente."],
  cancelled: [410, "Esta sessão de conexão foi substituída por outra. Inicie novamente."],
  already_used: [409, "Esta sessão de conexão já foi utilizada."],
  unauthorized: [403, "Você não tem permissão para conectar o WhatsApp desta empresa."],
};

export async function handleWhatsappSignupComplete(req: Request, deps: SignupDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json({ error: "Sessão inválida ou expirada." }, 401);

  // configuração do servidor (falha fechada, sem detalhar qual item falta)
  const version = deps.graphVersion;
  if (!isValidGraphVersion(version) || !deps.appSecret) {
    console.error("whatsapp-signup-complete: configuração incompleta");
    return json({ error: "Conexão automática indisponível no momento." }, 503);
  }

  // corpo
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Requisição inválida." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }
  if (!isObj(body)) return json({ error: "Requisição inválida." }, 400);
  const state = body.state;
  const code = body.code;
  const wabaId = body.waba_id;
  const phoneNumberId = body.phone_number_id;
  // PIN de verificação em duas etapas JÁ existente no número (opcional). Só circula no corpo HTTPS; nunca é logado nem devolvido.
  const customerPin = body.pin;
  if (typeof state !== "string" || !STATE_RE.test(state) || typeof code !== "string" || code.length < 1 || code.length > 2000
      || typeof wabaId !== "string" || !ID_RE.test(wabaId) || typeof phoneNumberId !== "string" || !ID_RE.test(phoneNumberId)
      || (customerPin !== undefined && customerPin !== null && (typeof customerPin !== "string" || !PIN_RE.test(customerPin)))) {
    return json({ error: "Requisição inválida." }, 400);
  }

  // 0) usuário (o gateway já exige JWT; aqui se obtém o id) e plataforma liberada
  let auth: { userId: string } | null = null;
  try {
    auth = await deps.authenticate(authorization);
  } catch {
    auth = null;
  }
  if (!auth || !auth.userId) return json({ error: "Sessão inválida ou expirada." }, 401);

  const platform = await deps.platform().catch(() => null);
  if (!platform || !platform.enabled || !platform.appId) {
    return json({ error: "A conexão automática ainda não está disponível." }, 503);
  }
  const appId = platform.appId;

  // 1) reservar (única vez, atômico). O state em claro só existe nesta requisição.
  const reserved = await rpc(deps, "whatsapp_signup_reserve", { p_state: state });
  if (reserved.error || !isObj(reserved.data)) {
    console.error("whatsapp-signup-complete: falha ao reservar", { code: reserved.error?.code ?? null });
    return json({ error: GENERIC }, 500);
  }
  if (reserved.data.ok !== true) {
    const [status, message] = SESSION_ERRORS[String(reserved.data.error)] ?? [400, GENERIC];
    return json({ error: message }, status);
  }
  const sessionId = String(reserved.data.session_id);
  const companyId = String(reserved.data.company_id);

  /** Encerra a sessão (e limpa o segredo ainda não ligado) e responde sem detalhes da Meta. */
  const abort = async (stage: string, errorCode: string, status: number, message: string, detail?: unknown): Promise<Response> => {
    console.error("whatsapp-signup-complete: falha", { stage, errorCode, detail: detail ?? null });
    const f = await rpc(deps, "whatsapp_signup_fail", { p_session_id: sessionId, p_error_code: errorCode });
    if (f.error) console.error("whatsapp-signup-complete: falha ao encerrar a sessão", { stage });
    return json({ error: message, code: errorCode }, status);
  };
  const metaDetail = (r: { kind: string; status?: number; code?: string }) => ({ kind: r.kind, status: r.status ?? null, meta_code: r.code ?? null });
  const metaStatus = (r: { kind: string }) => (r.kind === "timeout" ? 504 : 502);

  // a sessão pertence a quem a criou
  if (String(reserved.data.user_id) !== auth.userId) {
    return abort("session_owner", "user_mismatch", 403, SESSION_ERRORS.unauthorized[1]);
  }

  // 2) trocar o code (vale ~30 s; nada de logar o code)
  const ex = await deps.meta.exchangeCode({ version, appId, appSecret: deps.appSecret, code });
  if (!ex.ok) {
    const invalid = ex.kind === "http" && ex.status !== undefined && ex.status >= 400 && ex.status < 500;
    return abort("code_exchange", "meta_code_exchange", invalid ? 400 : metaStatus(ex),
      invalid ? "Autorização da Meta inválida ou expirada. Inicie a conexão novamente." : "A Meta não respondeu. Tente novamente.", metaDetail(ex));
  }
  const token = ex.token;

  // 3) validar com dados da Meta: o número precisa estar listado na WABA, lido com o token do próprio cliente
  const phones = await deps.meta.listWabaPhones({ version, wabaId, token });
  if (!phones.ok) {
    const denied = phones.kind === "http" && phones.status !== undefined && phones.status >= 400 && phones.status < 500;
    return abort("waba_lookup", "meta_waba_lookup", denied ? 400 : metaStatus(phones),
      denied ? "Não foi possível validar a conta do WhatsApp Business informada." : "A Meta não respondeu. Tente novamente.", metaDetail(phones));
  }
  const phone = phones.phones.find((p) => p.id === phoneNumberId);
  if (!phone) return abort("phone_validation", "phone_not_in_waba", 400, "O número informado não pertence à conta do WhatsApp Business conectada.");

  // 4) conflitos locais ANTES de qualquer efeito na Meta (o banco decide de novo, de forma atômica, no estágio 8)
  const owner = await deps.findPhoneOwner(phoneNumberId).catch(() => undefined);
  const active = await deps.findActiveConnection(companyId).catch(() => undefined);
  if (owner === undefined || active === undefined) return abort("conflict_check", "conflict_check_failed", 500, GENERIC);
  if (owner && owner.companyId !== companyId) {
    return abort("conflict_check", "phone_in_use", 409, "Este número já está conectado a outra empresa.");
  }
  if (active && active.phoneNumberId !== phoneNumberId) {
    return abort("conflict_check", "company_has_active_connection", 409, "Esta empresa já tem um número conectado. Desconecte-o antes de conectar outro.");
  }

  // 4b) estado do registro do número na Meta (decide: pular, registrar ou exigir o PIN do cliente). Não devolve PIN.
  const prep = await rpc(deps, "whatsapp_registration_prepare", { p_session_id: sessionId, p_phone_number_id: phoneNumberId, p_waba_id: wabaId });
  if (prep.error || !isObj(prep.data)) return abort("registration_prepare", "registration_prepare_failed", 500, GENERIC, { rpc_code: prep.error?.code ?? null });
  if (prep.data.ok !== true) {
    const e = String(prep.data.error);
    if (e === "phone_in_use") return abort("registration_prepare", "phone_in_use", 409, "Este número já está conectado a outra empresa.");
    if (e === "registration_blocked") return abort("registration_prepare", "registration_blocked", 429, "O registro deste número está temporariamente bloqueado pela Meta. Tente novamente mais tarde.");
    if (e === "registration_in_progress") return abort("registration_prepare", "registration_in_progress", 409, "Já existe um registro deste número em andamento. Aguarde alguns minutos.");
    if (e === "registration_uncertain") return abort("registration_prepare", "registration_uncertain", 409, "O registro anterior deste número não foi confirmado. Não tente novamente; contate o suporte.");
    return abort("registration_prepare", "registration_prepare_failed", 500, GENERIC, { result: e.slice(0, 40) });
  }
  const registrationId = String(prep.data.registration_id);
  const action = String(prep.data.action);
  const hasCustomerPin = typeof customerPin === "string";
  if (action === "need_customer_pin" && !hasCustomerPin) {
    return abort("registration_prepare", "pin_required", 409, "Este número já tem verificação em duas etapas. Informe o PIN atual de 6 dígitos e conecte novamente.");
  }

  // 5) token no Vault (antes de registrar/assinar: se o Vault falhar nada foi alterado na Meta)
  const expiresAt = ex.expiresInSeconds ? new Date((deps.now?.() ?? new Date()).getTime() + ex.expiresInSeconds * 1000).toISOString() : null;
  const stored = await rpc(deps, "whatsapp_signup_store_token", { p_session_id: sessionId, p_token: token, p_expires_at: expiresAt });
  if (stored.error || !isObj(stored.data) || stored.data.ok !== true) {
    return abort("token_store", "token_store_failed", 500, GENERIC, { rpc_code: stored.error?.code ?? null });
  }

  // 6) registrar o número na Cloud API com o PIN DESTE número (nunca derivado de secret mestre)
  let registeredAt: string;
  if (action === "skip") {
    // já registrado por nós: não gasta a cota da Meta (10 registros/72 h por número) e ignora qualquer PIN enviado
    registeredAt = typeof prep.data.registered_at === "string" ? prep.data.registered_at : (deps.now?.() ?? new Date()).toISOString();
  } else {
    // 6a) garantir que existe um PIN no Vault ANTES de falar com a Meta (uma queda não pode perder um PIN que a Meta aceitou).
    //      PIN do cliente: substitui o candidato ainda não registrado. Sem PIN guardado: gera um aleatório (CSPRNG). Se outra sessão
    //      do mesmo número guardou um primeiro (pin_already_stored), vale o que está no Vault.
    if (hasCustomerPin) {
      const sp = await rpc(deps, "whatsapp_registration_store_pin", { p_session_id: sessionId, p_registration_id: registrationId, p_pin: customerPin as string, p_source: "customer" });
      if (sp.error || !isObj(sp.data) || sp.data.ok !== true) return abort("pin_store", "pin_store_failed", 500, GENERIC, { rpc_code: sp.error?.code ?? null });
    } else if (prep.data.has_stored_pin !== true) {
      const sp = await rpc(deps, "whatsapp_registration_store_pin", { p_session_id: sessionId, p_registration_id: registrationId, p_pin: (deps.randomPin ?? generatePin)(), p_source: "generated" });
      const already = !sp.error && isObj(sp.data) && sp.data.error === "pin_already_stored";
      if (!already && (sp.error || !isObj(sp.data) || sp.data.ok !== true)) return abort("pin_store", "pin_store_failed", 500, GENERIC, { rpc_code: sp.error?.code ?? null });
    }

    // 6b) UMA tentativa auditada e limitada (3 por número em 72 h); devolve o PIN do Vault para ESTA chamada. Nada é repetido sozinho.
    const ba = await rpc(deps, "whatsapp_registration_begin_attempt", { p_session_id: sessionId, p_registration_id: registrationId });
    if (ba.error || !isObj(ba.data)) return abort("registration_attempt", "registration_attempt_failed", 500, GENERIC, { rpc_code: ba.error?.code ?? null });
    if (ba.data.ok !== true) {
      const e = String(ba.data.error);
      if (e === "attempts_exhausted") return abort("registration_attempt", "attempts_exhausted", 429, "Limite de tentativas de registro deste número atingido. Tente novamente mais tarde.");
      if (e === "registration_blocked") return abort("registration_attempt", "registration_blocked", 429, "O registro deste número está temporariamente bloqueado pela Meta. Tente novamente mais tarde.");
      if (e === "registration_in_progress") return abort("registration_attempt", "registration_in_progress", 409, "Já existe um registro deste número em andamento. Aguarde alguns minutos.");
      if (e === "registration_uncertain") return abort("registration_attempt", "registration_uncertain", 409, "O registro anterior deste número não foi confirmado. Não tente novamente; contate o suporte.");
      if (e === "pin_required") return abort("registration_attempt", "pin_required", 409, "Este número já tem verificação em duas etapas. Informe o PIN atual de 6 dígitos e conecte novamente.");
      return abort("registration_attempt", "registration_attempt_failed", 500, GENERIC, { result: e.slice(0, 40) });
    }
    const pin = ba.data.pin;
    if (typeof pin !== "string" || !PIN_RE.test(pin)) return abort("registration_attempt", "registration_attempt_failed", 500, GENERIC);
    const attemptId = String(ba.data.attempt_id);
    const reg = await deps.meta.registerPhone({ version, phoneNumberId, token, pin });
    const outcome = reg.ok ? "success" : classifyRegisterFailure(reg);
    const metaCode = reg.ok ? null : reg.code ?? null;
    let fin = await rpc(deps, "whatsapp_registration_finish_attempt", { p_attempt_id: attemptId, p_outcome: outcome, p_meta_code: metaCode });
    if (fin.error) fin = await rpc(deps, "whatsapp_registration_finish_attempt", { p_attempt_id: attemptId, p_outcome: outcome, p_meta_code: metaCode });
    if (fin.error) {
      // a Meta respondeu mas o resultado não foi gravado: o registro fica 'in_progress' (vira 'uncertain') e NÃO é repetido
      return abort("registration_finish", "registration_uncertain", 503, "Não foi possível confirmar o registro do número. Não tente novamente agora; contate o suporte.", { outcome });
    }
    if (!reg.ok) {
      const d = metaDetail(reg);
      if (outcome === "pin_incorrect") {
        return hasCustomerPin
          ? abort("register", "pin_incorrect", 409, "O PIN informado está incorreto. Confira o PIN de verificação em duas etapas do número.", d)
          : abort("register", "pin_required", 409, "Este número já tem verificação em duas etapas. Informe o PIN atual de 6 dígitos e conecte novamente.", d);
      }
      if (outcome === "rate_limited") return abort("register", "registration_blocked", 429, "O limite de registros deste número na Meta foi atingido. Tente novamente mais tarde.", d);
      if (outcome === "too_many_guesses") return abort("register", "registration_blocked", 429, "Muitas tentativas de PIN para este número. Aguarde antes de tentar novamente.", d);
      if (outcome === "uncertain") return abort("register", "registration_uncertain", metaStatus(reg), "Não foi possível confirmar o registro do número na Meta. Não tente novamente agora; contate o suporte.", d);
      return abort("register", "meta_register_failed", 502, "Não foi possível registrar o número na Meta. Tente novamente mais tarde.", d);
    }
    registeredAt = (deps.now?.() ?? new Date()).toISOString();
  }

  // 7) assinar o app na WABA do cliente e conferir (idempotente na Meta)
  const sub = await deps.meta.subscribeApp({ version, wabaId, token });
  if (!sub.ok) return abort("subscribe", "meta_subscribe_failed", metaStatus(sub), "Não foi possível ativar o recebimento de mensagens na Meta. Tente novamente.", metaDetail(sub));
  const apps = await deps.meta.listSubscribedAppIds({ version, wabaId, token });
  if (!apps.ok || !apps.appIds.includes(appId)) {
    return abort("subscribe_verify", "meta_subscribe_unverified", apps.ok ? 502 : metaStatus(apps), "Não foi possível confirmar o recebimento de mensagens na Meta. Tente novamente.", apps.ok ? null : metaDetail(apps));
  }
  const subscribedAt = (deps.now?.() ?? new Date()).toISOString();

  // 8) concluir (atômico no banco). A repetição é idempotente: uma segunda tentativa após falha de rede não duplica nada.
  const args = {
    p_session_id: sessionId,
    p_waba_id: wabaId,
    p_phone_number_id: phoneNumberId,
    p_display_phone_number: phone.displayPhoneNumber,
    p_business_name: phone.verifiedName,
    p_meta_business_id: null, // não verificável sem debug_token (pendência documentada)
    p_registered_at: registeredAt,
    p_webhook_subscribed_at: subscribedAt,
    p_connection_type: "cloud_api",
  };
  let done = await rpc(deps, "whatsapp_signup_complete", args);
  if (done.error) done = await rpc(deps, "whatsapp_signup_complete", args);
  if (done.error || !isObj(done.data)) {
    // resultado desconhecido: NÃO encerra a sessão (a conclusão pode ter sido gravada); a varredura trata o que sobrar
    console.error("whatsapp-signup-complete: conclusão sem resposta", { code: done.error?.code ?? null });
    return json({ error: "Não foi possível confirmar a conexão. Verifique o status em Configurações antes de tentar novamente." }, 503);
  }
  if (done.data.ok !== true) {
    const e = String(done.data.error);
    if (e === "phone_in_use") return abort("complete", "phone_in_use", 409, "Este número já está conectado a outra empresa.");
    if (e === "company_has_active_connection") return abort("complete", "company_has_active_connection", 409, "Esta empresa já tem um número conectado. Desconecte-o antes de conectar outro.");
    if (e === "expired") return abort("complete", "expired", 410, SESSION_ERRORS.expired[1]);
    if (e === "unauthorized") return abort("complete", "unauthorized", 403, SESSION_ERRORS.unauthorized[1]);
    return abort("complete", "complete_failed", 500, GENERIC, { result: e.slice(0, 40) });
  }

  // associa o registro (PIN) à conexão criada; se falhar, a associação continua localizável por (empresa, número)
  const linked = await rpc(deps, "whatsapp_registration_link", { p_session_id: sessionId, p_registration_id: registrationId });
  if (linked.error) console.error("whatsapp-signup-complete: associação do registro pendente");

  return json({
    ok: true,
    status: String(done.data.status ?? "active"),
    mode: String(done.data.mode ?? "test"),
    idempotent: done.data.idempotent === true,
    display_phone_number: phone.displayPhoneNumber,
    business_name: phone.verifiedName,
  });
}
