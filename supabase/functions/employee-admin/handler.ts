// Lógica da Edge Function employee-admin: gestão de funcionários (contas
// gerenciadas do Supabase Auth). Separada de index.ts para receber as
// dependências por parâmetro, sem importar o supabase-js.
//
// Regras de segurança:
//   * JWT obrigatório. As RPCs de banco rodam com o JWT REAL do ator, então
//     auth.uid() é o dono/admin e cada RPC reavalia can_manage_company_user()
//     (migration 070000) na hora de escrever. Esta função NUNCA escreve em tabela.
//   * service_role só chega aqui como `authAdmin` (Auth Admin API: criar usuário,
//     trocar credencial, banir, apagar), nunca como client de banco.
//   * A credencial (PIN de 6 dígitos ou senha) só passa pela memória desta
//     requisição, direto para o Auth. Nunca vai a banco, log, evento ou resposta.
//   * O e-mail técnico do Auth só existe aqui dentro: não sai em nenhuma resposta.
//   * Falha parcial nunca deixa acesso indevido (ver a ordem de cada ação abaixo).
//
// Ações (POST { action, ... }):
//   create          company_id, name, login, credential, role
//   update          company_id, user_id, name?, role?
//   reset_password  company_id, user_id, credential
//   set_status      company_id, user_id, status ("active" | "inactive")
//   delete          company_id, user_id

// --- Dependências injetadas (tipos estruturais mínimos) -------------------------

export interface RpcError {
  code?: string;
  message: string;
  status?: number;
}
export interface RpcResult {
  data: unknown;
  error: RpcError | null;
}
export interface UserClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  auth: {
    getUser(jwt: string): PromiseLike<{
      data: { user: { id: string } | null };
      error: { message: string } | null;
    }>;
  };
}

export interface AuthAdminError {
  message: string;
  code?: string;
  status?: number;
}
export interface AuthAdminResult {
  data: unknown;
  error: AuthAdminError | null;
}
export interface AuthAdmin {
  createUser(attributes: {
    email: string;
    password: string;
    email_confirm: boolean;
    user_metadata: Record<string, unknown>;
    app_metadata: Record<string, unknown>;
  }): PromiseLike<AuthAdminResult>;
  updateUserById(
    uid: string,
    attributes: { password?: string; ban_duration?: string },
  ): PromiseLike<AuthAdminResult>;
  deleteUser(id: string): PromiseLike<AuthAdminResult>;
}

export interface HandlerDeps {
  // Client do supabase-js escopado ao JWT de quem chamou (chave anon + Authorization).
  createUserClient(authorization: string): UserClient;
  authAdmin: AuthAdmin;
}

// --- Constantes e validações -------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GENERIC_ERROR = "Não foi possível concluir a operação agora. Tente novamente em instantes.";

// ~100 anos: o único jeito de sair do ban é reativar o funcionário ("none").
const BAN_DURATION = "876000h";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATABLE_ROLES = ["admin", "cashier", "attendant"];

// Credencial = PIN OU senha, um campo só. Só dígitos = PIN, que tem de ter EXATAMENTE
// 6. Qualquer outra coisa é senha, com a política que o Auth aceita hoje: mínimo de 6
// (minimum_password_length padrão) e até 72 bytes (limite do bcrypt). O Auth aplica a
// política do projeto de verdade; esta checagem só dá o retorno imediato.
export const PIN_LENGTH = 6;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_BYTES = 72;

export function validateCredential(value: string): string | null {
  if (value.length === 0) return "Informe o PIN ou a senha.";
  if (value !== value.trim()) return "O PIN ou a senha não pode começar nem terminar com espaço.";
  if (/^[0-9]+$/.test(value)) {
    return value.length === PIN_LENGTH ? null : `O PIN deve ter exatamente ${PIN_LENGTH} números.`;
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `A senha deve ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) {
    return `A senha pode ter no máximo ${PASSWORD_MAX_BYTES} caracteres.`;
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asUuid = (v: unknown): string | null =>
  typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;

// --- Erros ---------------------------------------------------------------------------

// As RPCs levantam PT400/401/403/404/409 com mensagem amigável em português (o
// PT### vira o status HTTP). Só essas mensagens saem para o usuário; qualquer outro
// erro do banco vira uma resposta genérica.
function rpcFailure(fn: string, e: RpcError): Response {
  switch (e.code) {
    case "PT400":
      return json({ error: e.message }, 400);
    case "PT401":
      return json({ error: e.message }, 401);
    case "PT403":
      return json({ error: e.message }, 403);
    case "PT404":
      return json({ error: e.message }, 404);
    case "PT409":
      return json({ error: e.message }, 409);
  }
  if (e.status === 401 || e.code === "PGRST301") {
    return json({ error: "Sessão inválida ou expirada." }, 401);
  }
  console.error("employee-admin: erro inesperado em rpc", { fn, code: e.code ?? null });
  return json({ error: GENERIC_ERROR }, 500);
}

// Só código e status vão para o log: nunca a credencial nem o e-mail técnico.
function logAuthError(step: string, e: AuthAdminError | null): void {
  console.error("employee-admin: falha na Auth Admin API", {
    step,
    code: e?.code ?? null,
    status: e?.status ?? null,
  });
}

function authFailure(step: string, e: AuthAdminError | null): Response {
  const code = e?.code ?? "";
  if (code === "email_exists" || code === "user_already_exists") {
    return json({ error: "Este login já está em uso." }, 409);
  }
  if (code === "weak_password") {
    return json(
      { error: "O PIN ou a senha não foi aceito pela política de senha do sistema. Tente outro." },
      400,
    );
  }
  if (e?.status === 429 || code === "over_request_rate_limit") {
    return json({ error: "Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo." }, 429);
  }
  logAuthError(step, e);
  return json(
    { error: "Não foi possível concluir a operação no serviço de autenticação. Tente novamente." },
    502,
  );
}

// --- Acesso às dependências ----------------------------------------------------------

async function callRpc(client: UserClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    return await client.rpc(fn, args);
  } catch (e) {
    console.error("employee-admin: rpc lançou exceção", { fn, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

// Repete UMA vez um passo final de registro (a mutação no Auth já aconteceu).
async function callRpcTwice(client: UserClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const first = await callRpc(client, fn, args);
  return first.error ? await callRpc(client, fn, args) : first;
}

async function callAdmin(
  step: string,
  run: () => PromiseLike<AuthAdminResult>,
): Promise<AuthAdminResult> {
  try {
    return await run();
  } catch (e) {
    console.error("employee-admin: Auth Admin API lançou exceção", { step, name: e instanceof Error ? e.name : null });
    return { data: null, error: { message: "falha de comunicação" } };
  }
}

// Apaga uma conta do Auth (compensação/limpeza). "Já não existe" também é sucesso.
async function deleteAuthUser(authAdmin: AuthAdmin, userId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await callAdmin("deleteUser", () => authAdmin.deleteUser(userId));
    if (!result.error || result.error.code === "user_not_found") return true;
  }
  return false;
}

const userOf = (result: AuthAdminResult): { id: string } | null =>
  (result.data as { user?: { id: string } | null } | null)?.user ?? null;

// --- Ações ------------------------------------------------------------------------------

type Body = Record<string, unknown>;

async function createEmployee(deps: HandlerDeps, client: UserClient, b: Body): Promise<Response> {
  const companyId = asUuid(b.company_id);
  const name = asString(b.name);
  const login = asString(b.login);
  const credential = asString(b.credential);
  const role = asString(b.role);
  if (!companyId || name === null || login === null || credential === null || role === null) {
    return json({ error: "Dados incompletos." }, 400);
  }
  if (role === "owner") return json({ error: "Não é possível cadastrar um proprietário por aqui." }, 403);
  if (!CREATABLE_ROLES.includes(role)) return json({ error: "Função inválida." }, 400);
  const credentialError = validateCredential(credential);
  if (credentialError) return json({ error: credentialError }, 400);

  // 1) Valida tudo no banco (permissão, nome, login, código da empresa, e-mail
  //    técnico livre) ANTES de criar qualquer coisa no Auth.
  const prepared = await callRpc(client, "employee_prepare_create", {
    p_company_id: companyId,
    p_login: login,
    p_role: role,
    p_name: name,
  });
  if (prepared.error) return rpcFailure("employee_prepare_create", prepared.error);
  const prep = prepared.data as {
    login: string;
    email: string;
    access_code: string;
    reclaim_user_id: string | null;
  };

  // Sobra de uma tentativa anterior que criou a conta e não conseguiu vincular nem
  // apagar: sai agora, para o login não ficar preso.
  if (prep.reclaim_user_id && !(await deleteAuthUser(deps.authAdmin, prep.reclaim_user_id))) {
    console.error("employee-admin: conta órfã anterior não removida", { user_id: prep.reclaim_user_id });
    return json({ error: "Este login está indisponível no momento. Tente novamente em instantes." }, 502);
  }

  // 2) Conta no Auth: e-mail técnico já confirmado (sem envio de e-mail), a
  //    credencial e a marca de conta gerenciada (só a Admin API grava app_metadata).
  const created = await callAdmin("createUser", () =>
    deps.authAdmin.createUser({
      email: prep.email,
      password: credential,
      email_confirm: true,
      user_metadata: { full_name: name.trim() },
      app_metadata: { managed: true, company_id: companyId, access_code: prep.access_code },
    })
  );
  const authUser = userOf(created);
  if (created.error || !authUser) return authFailure("createUser", created.error);

  // 3) Vínculo, perfil e auditoria. Se falhar, a conta do Auth criada agora é apagada.
  const linked = await callRpc(client, "employee_create_member", {
    p_company_id: companyId,
    p_user_id: authUser.id,
    p_login: prep.login,
    p_name: name,
    p_role: role,
  });
  if (linked.error) {
    if (!(await deleteAuthUser(deps.authAdmin, authUser.id))) {
      console.error("employee-admin: conta de acesso órfã não removida", { user_id: authUser.id });
    }
    return rpcFailure("employee_create_member", linked.error);
  }
  return json({ ok: true, member: linked.data });
}

async function updateEmployee(client: UserClient, b: Body): Promise<Response> {
  const companyId = asUuid(b.company_id);
  const userId = asUuid(b.user_id);
  if (!companyId || !userId) return json({ error: "Dados incompletos." }, 400);
  if (b.name !== undefined && typeof b.name !== "string") return json({ error: "Nome inválido." }, 400);
  let role: string | null = null;
  if (b.role !== undefined) {
    if (typeof b.role !== "string") return json({ error: "Função inválida." }, 400);
    if (b.role === "owner") return json({ error: "Não é possível atribuir a função de proprietário por aqui." }, 403);
    if (!CREATABLE_ROLES.includes(b.role)) return json({ error: "Função inválida." }, 400);
    role = b.role;
  }

  const result = await callRpc(client, "employee_update", {
    p_company_id: companyId,
    p_target_user_id: userId,
    p_name: typeof b.name === "string" ? b.name : null,
    p_role: role,
  });
  if (result.error) return rpcFailure("employee_update", result.error);
  return json({ ok: true, member: result.data });
}

async function resetCredential(deps: HandlerDeps, client: UserClient, b: Body): Promise<Response> {
  const companyId = asUuid(b.company_id);
  const userId = asUuid(b.user_id);
  const credential = asString(b.credential);
  if (!companyId || !userId || credential === null) return json({ error: "Dados incompletos." }, 400);
  const credentialError = validateCredential(credential);
  if (credentialError) return json({ error: credentialError }, 400);

  // 1) Autoriza ANTES de tocar no Auth.
  const prepared = await callRpc(client, "employee_prepare_manage", {
    p_company_id: companyId,
    p_target_user_id: userId,
  });
  if (prepared.error) return rpcFailure("employee_prepare_manage", prepared.error);

  // 2) Nova credencial direto no Auth. Nada de e-mail, link ou mensagem.
  const updated = await callAdmin("updateUserById", () =>
    deps.authAdmin.updateUserById(userId, { password: credential })
  );
  if (updated.error) return authFailure("updateUserById", updated.error);

  // 3) Auditoria (sem a credencial). A troca já aconteceu: se o registro falhar
  //    mesmo após uma nova tentativa, o aviso diz isso.
  const recorded = await callRpcTwice(client, "employee_record_password_reset", {
    p_company_id: companyId,
    p_target_user_id: userId,
  });
  if (recorded.error) {
    console.error("employee-admin: troca de credencial sem registro de auditoria", {
      company_id: companyId,
      user_id: userId,
      code: recorded.error.code ?? null,
    });
    return json(
      { error: "O PIN/senha foi alterado, mas o registro da alteração não foi concluído. Repita a operação.", partial: true },
      500,
    );
  }
  return json({ ok: true, member: recorded.data });
}

async function setEmployeeStatus(deps: HandlerDeps, client: UserClient, b: Body): Promise<Response> {
  const companyId = asUuid(b.company_id);
  const userId = asUuid(b.user_id);
  const status = asString(b.status);
  if (!companyId || !userId || (status !== "active" && status !== "inactive")) {
    return json({ error: "Dados incompletos." }, 400);
  }
  const args = { p_company_id: companyId, p_target_user_id: userId };

  if (status === "inactive") {
    // Banco primeiro: com status inactive o RLS já corta o acesso, mesmo com uma
    // sessão ainda aberta. Só depois o Auth passa a barrar novo login e renovação.
    const changed = await callRpc(client, "employee_set_status", { ...args, p_status: "inactive" });
    if (changed.error) return rpcFailure("employee_set_status", changed.error);
    const banned = await callAdmin("updateUserById", () =>
      deps.authAdmin.updateUserById(userId, { ban_duration: BAN_DURATION })
    );
    if (banned.error) {
      logAuthError("ban", banned.error);
      return json(
        {
          error: "O acesso foi desativado no sistema, mas o bloqueio de login não foi concluído. Tente desativar de novo.",
          partial: true,
        },
        502,
      );
    }
    return json({ ok: true, member: (changed.data as { member: unknown }).member });
  }

  // Reativar: autoriza, tira o ban e só então volta o status. Se algo falhar no
  // meio, o funcionário continua inativo.
  const prepared = await callRpc(client, "employee_prepare_manage", args);
  if (prepared.error) return rpcFailure("employee_prepare_manage", prepared.error);
  const unbanned = await callAdmin("updateUserById", () =>
    deps.authAdmin.updateUserById(userId, { ban_duration: "none" })
  );
  if (unbanned.error) {
    logAuthError("unban", unbanned.error);
    return json({ error: "Não foi possível reativar o login agora. O funcionário continua desativado.", partial: true }, 502);
  }
  const changed = await callRpc(client, "employee_set_status", { ...args, p_status: "active" });
  if (changed.error) {
    if (changed.error.code?.startsWith("PT")) return rpcFailure("employee_set_status", changed.error);
    console.error("employee-admin: reativação sem status", { user_id: userId, code: changed.error.code ?? null });
    return json({ error: "Não foi possível concluir a reativação. O funcionário continua desativado.", partial: true }, 500);
  }
  return json({ ok: true, member: (changed.data as { member: unknown }).member });
}

async function deleteEmployee(deps: HandlerDeps, client: UserClient, b: Body): Promise<Response> {
  const companyId = asUuid(b.company_id);
  const userId = asUuid(b.user_id);
  if (!companyId || !userId) return json({ error: "Dados incompletos." }, 400);

  // 1) Autoriza, recusa quem tem movimentação e pega o snapshot da auditoria.
  const prepared = await callRpc(client, "employee_prepare_delete", {
    p_company_id: companyId,
    p_target_user_id: userId,
  });
  if (prepared.error) return rpcFailure("employee_prepare_delete", prepared.error);
  const snapshot = (prepared.data as { snapshot: Record<string, unknown> }).snapshot;

  // 2) Apaga a conta do Auth; a cascata leva vínculo e perfil. Se falhar aqui,
  //    nada mudou e dá para repetir.
  const deleted = await callAdmin("deleteUser", () => deps.authAdmin.deleteUser(userId));
  if (deleted.error && deleted.error.code !== "user_not_found") return authFailure("deleteUser", deleted.error);

  // 3) Auditoria com o snapshot. A exclusão já aconteceu: repete uma vez e, se ainda
  //    assim falhar, deixa rastro no log (sem a credencial nem o nome) e avisa.
  const recorded = await callRpcTwice(client, "employee_record_deleted", {
    p_company_id: companyId,
    p_target_user_id: userId,
    p_snapshot: snapshot,
  });
  if (recorded.error) {
    console.error("employee-admin: exclusão sem registro de auditoria", {
      company_id: companyId,
      user_id: userId,
      login: snapshot.login ?? null,
      role: snapshot.role ?? null,
      code: recorded.error.code ?? null,
    });
    return json({ error: "O funcionário foi excluído, mas o registro de auditoria não foi concluído.", partial: true }, 500);
  }
  return json({ ok: true });
}

// --- Entrada ----------------------------------------------------------------------------

export async function handleEmployeeAdmin(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!bearer) return json({ error: "Não autenticado." }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }
  const b = body as Body;

  const client = deps.createUserClient(authorization.trim());
  const { data, error } = await client.auth.getUser(bearer[1]);
  if (error || !data.user) return json({ error: "Sessão inválida ou expirada." }, 401);

  switch (b.action) {
    case "create":
      return await createEmployee(deps, client, b);
    case "update":
      return await updateEmployee(client, b);
    case "reset_password":
      return await resetCredential(deps, client, b);
    case "set_status":
      return await setEmployeeStatus(deps, client, b);
    case "delete":
      return await deleteEmployee(deps, client, b);
    default:
      return json({ error: "Ação inválida." }, 400);
  }
}
