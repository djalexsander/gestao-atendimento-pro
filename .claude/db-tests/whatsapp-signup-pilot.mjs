// Allowlist do piloto do Embedded Signup (20261107010000): banco REAL (PGlite) + handler REAL da Edge + Meta SIMULADA.
// (scaffold herdado de whatsapp-signup-complete.mjs) Edge whatsapp-signup-complete: o handler REAL (transpilado) sobre o banco REAL (PGlite com todas as migrations, inclusive as RPCs
// whatsapp_signup_* e a correção de limpeza 20261105010000) e uma Meta SIMULADA. Cobre autenticação/autorização, state, cada estágio
// de falha com recuperação, reconexão, isolamento, o cliente da Graph API (URLs/headers) e a ausência de vazamento de segredos.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadAll } from "./full-db.mjs";

const root = "D:/orça facil";
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const srcRoot = process.env.SRC_ROOT ?? root;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wasignup-"));
const load = async (src, name, rewrites = []) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(srcRoot, src), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
  return import(pathToFileURL(path.join(tmp, name)).href);
};
const G = await load("supabase/functions/_shared/whatsapp-graph.ts", "whatsapp-graph.mjs");
const SG = await load("supabase/functions/_shared/whatsapp-signup-graph.ts", "whatsapp-signup-graph.mjs", [['"./whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
const H = await load("supabase/functions/whatsapp-signup-complete/handler.ts", "handler.mjs", [['"../_shared/whatsapp-signup-graph.ts"', '"./whatsapp-signup-graph.mjs"'], ['"../_shared/whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);

const { pg, ck, as: as0, su: su00, summary } = await loadAll(undefined, { legacyIaMirror: false });
// PGlite tem UMA conexão: cada operação (set role + query + reset) vira atômica para que handlers concorrentes só se intercalem entre operações
let chain = Promise.resolve();
const mutex = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r; };
const as = (...a) => mutex(() => as0(...a));
const su0 = (...a) => mutex(() => su00(...a));
const su = async (sql, params) => mutex(async () => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su00(sql, params); });
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const svc = (sql, params) => as("service_role", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
  declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id into v; return v; end $f$;
`);
const APP_ID = "1234567890", APP_SECRET = "APP-SECRET-DE-TESTE-NAO-REAL-9999", VERSION = "v99.0";
await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id=$1, embedded_signup_config_id='9876543210'", [APP_ID]);

// ---------------------------------------------------------------- fixtures
let seq = 700, pn = 920000000;
async function mkCo(tag, { wa = true, pilot = false } = {}) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "sc-" + tag.toLowerCase() + "-" + (++seq), `${tag.toLowerCase()}${seq}@x.com`])).rows[0].id;
  const out = { c, ids: {}, pnid: String(++pn) };
  for (const role of ["owner", "admin", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u); out.ids[role] = u;
  }
  if (pilot) await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1, true, now())", [c]);
  if (wa) await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste signup edge', now() + interval '1 day')", [c]);
  return out;
}
const secrets = async () => Number((await su("select count(*) n from vault.secrets where not starts_with(name, 'wa_pin_')")).rows[0].n);
const PINS = new Set();
const ALL_TEXT = [];
const PINS_TEXT_HIT = (t) => [...PINS].some((p) => new RegExp(`(?<![0-9])${p}(?![0-9])`).test(t));
const conns = async (co) => (await su("select * from company_whatsapp_connections where company_id=$1 order by created_at", [co.c])).rows;
const sessOf = async (co) => (await su("select * from whatsapp_signup_sessions where company_id=$1 order by created_at desc limit 1", [co.c])).rows[0];
const sessByState = async (state) => (await su("select * from whatsapp_signup_sessions where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [state])).rows[0];
const begin = async (co, role = "owner") => (await su("delete from whatsapp_signup_sessions where company_id=$1 and status in ('completed','failed','expired','cancelled') and token_secret_id is null", [co.c]), await co[role]("select public.whatsapp_signup_begin($1) j", [co.c])).rows[0].j.state;

// ---------------------------------------------------------------- Meta simulada
const TOKEN_OF = (code) => `EAAB-BIZ-TOKEN-${code}-0123456789`;
function mkMeta(co, o = {}) {
  const calls = [];
  const rec = (fn, extra = {}) => calls.push({ fn, ...extra });
  const phones = o.phones ?? [{ id: co.pnid, displayPhoneNumber: "+55 11 90000-1111", verifiedName: "Loja Teste" }];
  return {
    calls,
    async exchangeCode(a) { rec("exchange", { code: a.code, appId: a.appId, appSecret: a.appSecret }); return o.exchange ? o.exchange(a) : { ok: true, token: TOKEN_OF(a.code), expiresInSeconds: o.expiresIn ?? null }; },
    async listWabaPhones(a) { rec("list", { waba: a.wabaId, token: a.token }); return o.list ? o.list(a) : { ok: true, phones }; },
    async registerPhone(a) { rec("register", { pin: a.pin, pnid: a.phoneNumberId }); PINS.add(a.pin); return o.register ? o.register(a) : { ok: true }; },
    async subscribeApp(a) { rec("subscribe", { waba: a.wabaId }); return o.subscribe ? o.subscribe(a) : { ok: true }; },
    async listSubscribedAppIds(a) { rec("listSub"); return o.listSub ? o.listSub(a) : { ok: true, appIds: ["111", APP_ID] }; },
  };
}
const NAMED = { whatsapp_signup_reserve: ["p_state"], whatsapp_signup_store_token: ["p_session_id", "p_token", "p_expires_at"], whatsapp_signup_fail: ["p_session_id", "p_error_code"],
  whatsapp_registration_prepare: ["p_session_id", "p_phone_number_id", "p_waba_id"], whatsapp_registration_store_pin: ["p_session_id", "p_registration_id", "p_pin", "p_source"],
  whatsapp_registration_begin_attempt: ["p_session_id", "p_registration_id"], whatsapp_registration_finish_attempt: ["p_attempt_id", "p_outcome", "p_meta_code"], whatsapp_registration_link: ["p_session_id", "p_registration_id"],
  whatsapp_signup_complete: ["p_session_id", "p_waba_id", "p_phone_number_id", "p_display_phone_number", "p_business_name", "p_meta_business_id", "p_registered_at", "p_webhook_subscribed_at", "p_connection_type"] };
const realRpc = async (fn, args) => {
  const keys = NAMED[fn];
  const r = await svc(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) j`, keys.map((k) => args[k] ?? null));
  return r.ok ? { data: r.rows[0].j, error: null } : { data: null, error: { message: r.err, code: r.code } };
};

const logs = [];
const orig = { warn: console.warn, error: console.error, info: console.info, log: console.log };
async function capture(fn) {
  console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a));
  try { return await fn(); } finally { Object.assign(console, orig); }
}
const CODE = "AQD-AUTH-CODE-SECRETO-";
let codeN = 0;
/** Roda uma requisição completa. role: quem cria a sessão e chama; opts.jwtUser sobrescreve quem chama. */
async function run(co, o = {}) {
  const state = o.state ?? (await begin(co, o.role ?? "owner"));
  const code = o.code ?? CODE + ++codeN;
  const meta = o.meta ?? mkMeta(co, o.metaOpts);
  const uid = o.jwtUser ?? co.ids[o.role ?? "owner"];
  const body = o.rawBody ?? JSON.stringify({ state, code, waba_id: o.waba ?? "555000111222", phone_number_id: o.pnid ?? co.pnid, ...(o.extra ?? {}) });
  const headers = { "content-type": "application/json" };
  if (o.auth !== null) headers.authorization = o.auth ?? `Bearer jwt-${uid}`;
  const req = new Request("https://x.supabase.co/functions/v1/whatsapp-signup-complete", { method: o.method ?? "POST", headers, body: (o.method ?? "POST") === "POST" ? body : undefined });
  const deps = {
    authenticate: async (a) => { const m = /^Bearer jwt-(.+)$/.exec(a); return m && m[1] !== "bad" ? { userId: m[1] } : null; },
    rpc: o.rpc ?? realRpc,
    platform: async () => { const r = (await su("select embedded_signup_enabled e, meta_app_id a from whatsapp_platform_settings")).rows[0]; return { enabled: r.e, appId: r.a }; },
    findPhoneOwner: async (p) => { const r = (await su("select company_id from company_whatsapp_connections where phone_number_id=$1 limit 1", [p])).rows[0]; return r ? { companyId: r.company_id } : null; },
    findActiveConnection: async (c) => { const r = (await su("select phone_number_id from company_whatsapp_connections where company_id=$1 and status='active' limit 1", [c])).rows[0]; return r ? { phoneNumberId: r.phone_number_id } : null; },
    pilotAuthorized: async (c) => { const r = (await su("select authorized from whatsapp_signup_pilot_companies where company_id=$1", [c])).rows[0]; return r ? r.authorized === true : false; },
    meta, graphVersion: "graphVersion" in o ? o.graphVersion : VERSION, appSecret: "appSecret" in o ? o.appSecret : APP_SECRET,
    ...(o.deps ?? {}),
  };
  const res = await capture(() => H.handleWhatsappSignupComplete(req, deps));
  const text = await res.text();
  ALL_TEXT.push(text);
  let j = null; try { j = JSON.parse(text); } catch { /* sem corpo */ }
  return { res, status: res.status, j, text, meta, state, code };
}
const names = (m) => m.calls.map((c) => c.fn).join(",");


// ---------------------------------------------------------------- fixtures do piloto
const MASTER = id(9001), OTHER = id(9002);
await su(`insert into auth.users (id,email) values ('${MASTER}','master@x.com'), ('${OTHER}','other@x.com')`);
await su(`insert into public.profiles (user_id,email,full_name) values ('${MASTER}','master@x.com','Master'), ('${OTHER}','other@x.com','Outro') on conflict (user_id) do nothing`);
await su(`insert into public.platform_admins (user_id) values ('${MASTER}')`);
const M = U(MASTER);
const pilotRow = async (c) => (await su("select * from whatsapp_signup_pilot_companies where company_id=$1", [c])).rows[0];
const events = async (c) => (await su("select * from whatsapp_signup_pilot_events where company_id=$1 order by created_at, id", [c])).rows;
const stateOf = async (co, role = "owner") => (await co[role]("select public.whatsapp_get_module_state($1) j", [co.c])).rows[0].j;
const beginRaw = (co, role = "owner") => co[role]("select public.whatsapp_signup_begin($1) j", [co.c]);
const setFlag = (v) => su("update whatsapp_platform_settings set embedded_signup_enabled=$1", [v]);
const snapConn = async () => (await su("select md5(string_agg(concat_ws('|', id, company_id, status, mode, waba_id, phone_number_id, token_secret_id, token_status, connected_at), ';' order by id)) h, count(*) n from company_whatsapp_connections")).rows[0];
const snapSecrets = async () => (await su("select md5(string_agg(concat_ws('|', id, name, secret), ';' order by id)) h, count(*) n from vault.secrets")).rows[0];
const mset = (c, on, note = "motivo do teste") => M("select public.master_whatsapp_pilot_set($1, $2, $3) j", [c, on, note]);
const insertSession = (co, hex) => su("insert into whatsapp_signup_sessions (company_id, user_id, state_hash) values ($1,$2,encode(sha256(convert_to($3,'UTF8')),'hex'))", [co.c, co.ids.owner, hex]);

console.log("\n== 1. estrutura e valores iniciais ==");
ck("1.1 a allowlist nasce VAZIA (nenhuma empresa é autorizada automaticamente)", Number((await su("select count(*) n from whatsapp_signup_pilot_companies")).rows[0].n) === 0 && Number((await su("select count(*) n from whatsapp_signup_pilot_events")).rows[0].n) === 0);
const migText = fs.readFileSync("D:/orça facil/supabase/migrations/20261107010000_whatsapp_signup_pilot_allowlist.sql", "utf8");
const masterPart = migText.slice(migText.indexOf("create function public.master_whatsapp_pilot_set"), migText.indexOf("-- 8) ACL explícita"));
ck("1.2 as RPCs do master não inserem na allowlist em lote nem tocam em conexões/mensagens/registros/Vault (só revogam sessões via whatsapp_signup_fail)", !/(update|delete from|insert into) public\.(company_whatsapp_connections|whatsapp_messages|whatsapp_conversations|whatsapp_number_registrations)/i.test(masterPart) && !/vault\./.test(masterPart) && !/insert into public\.whatsapp_signup_pilot_companies[^;]*select/i.test(migText));
{
  const p = (await su("select has_table_privilege('authenticated','public.whatsapp_signup_pilot_companies','select') a, has_table_privilege('anon','public.whatsapp_signup_pilot_events','select') b, has_table_privilege('authenticated','public.whatsapp_signup_pilot_events','insert') c, (select count(*) from pg_class where relname in ('whatsapp_signup_pilot_companies','whatsapp_signup_pilot_events') and relrowsecurity) rls")).rows[0];
  ck("1.3 RLS ligada e nenhum acesso de anon/authenticated às duas tabelas", Number(p.rls) === 2 && p.a === false && p.b === false && p.c === false);
}

ck("1.4 coluna authorized nasce FALSE (inserir sem informar nunca autoriza)", (await su("select column_default d from information_schema.columns where table_name='whatsapp_signup_pilot_companies' and column_name='authorized'")).rows[0].d === "false");
console.log("\n== 2. begin / estado: flag global x allowlist ==");
const A = await mkCo("A"), B = await mkCo("B"), N = await mkCo("N", { wa: false }), D = await mkCo("D");
await setFlag(false);
let r = await beginRaw(A);
ck("2.1 flag desligada: begin recusado (PT409) e estado 'pending_meta_approval'", !r.ok && r.code === "PT409" && (await stateOf(A)).signup.reason === "pending_meta_approval");
await setFlag(true);
r = await beginRaw(A);
ck("2.2 flag ligada + allowlist VAZIA: begin recusado (PT409, 'não foi liberada') e nenhuma sessão criada", !r.ok && r.code === "PT409" && /não foi liberada/.test(r.err) && Number((await su("select count(*) n from whatsapp_signup_sessions where company_id=$1", [A.c])).rows[0].n) === 0);
{
  const st = await stateOf(A);
  ck("2.3 estado da tela: indisponível com reason 'company_not_authorized' e SEM app_id/config_id", st.signup.available === false && st.signup.reason === "company_not_authorized" && !("meta_app_id" in st.signup) && !JSON.stringify(st).includes(APP_ID));
}
await mset(A.c, true, "piloto A");
{
  const st = await stateOf(A); const b = await beginRaw(A);
  ck("2.4 flag ligada + empresa autorizada: estado disponível e begin cria a sessão", st.signup.available === true && st.signup.meta_app_id === APP_ID && b.ok && /^[0-9a-f]{64}$/.test(b.rows[0].j.state));
}
ck("2.5 autorizar A não libera B (isolamento da allowlist)", !(await beginRaw(B)).ok && (await stateOf(B)).signup.reason === "company_not_authorized");
await setFlag(false);
ck("2.6 empresa autorizada mas flag global desligada: continua bloqueada (a flag é trava adicional)", !(await beginRaw(A)).ok && (await stateOf(A)).signup.available === false);
await setFlag(true);

console.log("\n== 3. papéis e módulo continuam obrigatórios ==");
ck("3.1 attendant da empresa autorizada: PT403", (await beginRaw(A, "attendant")).code === "PT403");
ck("3.2 admin da empresa autorizada: permitido", (await beginRaw(A, "admin")).ok);
await mset(N.c, true);
ck("3.3 empresa autorizada SEM módulo WhatsApp: recusada", !(await beginRaw(N)).ok);
ck("3.4 usuário de outra empresa não inicia sessão para A", !(await beginRaw({ c: A.c, owner: B.owner })).ok);
ck("3.5 attendant vê o estado, mas can_manage=false", (await stateOf(A, "attendant")).can_manage === false);

console.log("\n== 4. mecanismo administrativo (Admin Master) ==");
ck("4.1 owner/admin/usuário avulso NÃO usam set/list/events", !(await A.owner("select public.master_whatsapp_pilot_set($1, true, null)", [B.c])).ok && !(await A.admin("select public.master_whatsapp_pilot_list()")).ok
  && !(await A.owner("select public.master_whatsapp_pilot_events($1)", [A.c])).ok && !(await U(OTHER)("select public.master_whatsapp_pilot_set($1, true, null)", [B.c])).ok && !(await pilotRow(B.c)));
ck("4.2 anon e service_role sem EXECUTE nas RPCs master", !(await as("anon", null, "select public.master_whatsapp_pilot_list()")).ok && !(await svc("select public.master_whatsapp_pilot_set($1, true, null)", [B.c])).ok && !(await svc("select public.master_whatsapp_pilot_list()")).ok);
ck("4.3 helpers internos sem EXECUTE para clientes e service_role", !(await A.owner("select public.whatsapp_signup_pilot_allowed($1)", [A.c])).ok && !(await svc("select public.whatsapp_signup_pilot_allowed($1)", [A.c])).ok
  && !(await A.owner("select public.whatsapp_signup_availability_for_company($1)", [A.c])).ok);
ck("4.4 owner não lê as tabelas diretamente (sem grant)", !(await A.owner("select * from whatsapp_signup_pilot_companies")).ok && !(await A.owner("select * from whatsapp_signup_pilot_events")).ok);
{
  const row = await pilotRow(A.c);
  ck("4.5 autorização grava quem e quando", row.authorized === true && row.authorized_by === MASTER && !!row.authorized_at && row.revoked_by === null && row.note === "piloto A");
  const ev = await events(A.c);
  ck("4.6 evento 'authorized' com ator e data", ev.length === 1 && ev[0].action === "authorized" && ev[0].actor_user_id === MASTER && !!ev[0].created_at);
}
ck("4.7 autorizar de novo é idempotente (sem novo evento)", (await mset(A.c, true)).rows[0].j.changed === false && (await events(A.c)).length === 1);
ck("4.8 empresa inexistente / parâmetros nulos: erro", !(await mset(id(777777), true)).ok && !(await M("select public.master_whatsapp_pilot_set($1, null, null)", [A.c])).ok && !(await M("select public.master_whatsapp_pilot_set(null, true, null)")).ok);
ck("4.9 nota acima de 500 caracteres é RECUSADA (PT400), sem gravar (Etapa 10.1)", (await mset(D.c, true, "x".repeat(900))).code === "PT400" && !(await pilotRow(D.c)) && (await mset(D.c, true, "x".repeat(500))).ok && (await pilotRow(D.c)).note.length === 500);
{
  const list = (await M("select public.master_whatsapp_pilot_list() j")).rows[0].j;
  ck("4.10 listagem do master: só empresas da allowlist, campos mínimos, sem segredos/tokens/PINs", Array.isArray(list) && list.length === 3 && list.every((x) => ["company_id", "company_name", "authorized", "authorized_by", "authorized_at", "revoked_by", "revoked_at", "note", "connection_active"].every((k) => k in x)) && !JSON.stringify(list).match(/token|secret|pin|state/i) && !list.some((x) => x.company_id === B.c));
  const evs = (await M("select public.master_whatsapp_pilot_events($1) j", [A.c])).rows[0].j;
  ck("4.11 eventos de A não trazem dados de outras empresas", evs.length === 1 && evs[0].action === "authorized" && !JSON.stringify(evs).includes(B.c));
}

console.log("\n== 5. Edge: autorização verificada no backend ==");
{
  const s = await begin(A); const before = (await conns(A)).length;
  const r1 = await run(A, { state: s });
  ck("5.1 empresa autorizada conclui normalmente (200, ativa, modo test)", r1.status === 200 && r1.j?.ok === true && (await conns(A)).length === before + 1 && (await conns(A))[0].mode === "test");
}
{
  // B não autorizada: begin já recusa; cria a sessão por fora do begin para provar que reserve e a Edge recusam sozinhos
  const bs = "b".repeat(64);
  await insertSession(B, bs);
  const r2 = await run(B, { state: bs });
  const row = await sessByState(bs);
  ck("5.2 sessão de empresa NÃO autorizada: 403 company_not_authorized, sessão failed, Meta nunca chamada, nada criado", r2.status === 403 && r2.j?.code === "company_not_authorized" && row.status === "failed" && row.error_code === "company_not_authorized" && r2.meta.calls.length === 0 && (await conns(B)).length === 0);
}
{
  const C = await mkCo("C", { pilot: true }); const s = await begin(C);
  const r3 = await run(C, { state: s, deps: { pilotAuthorized: async () => false } });
  ck("5.3 backend recusa mesmo com o banco liberado (allowlist conferida de novo na Edge): 403 e Meta não chamada", r3.status === 403 && r3.j?.code === "company_not_authorized" && r3.meta.calls.length === 0 && (await sessByState(s)).status === "failed");
  const s2 = await begin(C);
  const r4 = await run(C, { state: s2, deps: { pilotAuthorized: async () => { throw new Error("boom"); } } });
  const s3 = await begin(C);
  const r5 = await run(C, { state: s3, deps: { pilotAuthorized: async () => null } });
  ck("5.4 falha na leitura da allowlist = falha fechada (erro ou null): 403 e Meta não chamada", r4.status === 403 && r5.status === 403 && r4.meta.calls.length === 0 && r5.meta.calls.length === 0);
}
{
  // revogação no meio do caminho: a 1ª checagem passa, a 2ª (antes de registrar) já vê a revogação
  const C = await mkCo("C2", { pilot: true }); const s = await begin(C);
  let n = 0;
  const r = await run(C, { state: s, deps: { pilotAuthorized: async () => ++n === 1 } });
  const row = await sessByState(s);
  ck("5.5 revogada entre a troca do code e o registro: 403, a Meta NÃO recebe registro nem assinatura, sessão failed, nenhuma conexão", r.status === 403 && !r.meta.calls.some((c) => c.fn === "register" || c.fn === "subscribe") && r.meta.calls.some((c) => c.fn === "exchange") && row.status === "failed" && (await conns(C)).length === 0);
  ck("5.6 o token da sessão revogada some do Vault (não fica órfão)", row.token_secret_id === null && Number((await su("select count(*) n from vault.secrets where name = 'wa_token_signup_' || $1", [row.id])).rows[0].n) === 0);
}

console.log("\n== 6. revogação ==");
{
  const C = await mkCo("R");
  await mset(C.c, true, "piloto R");
  const ok1 = await run(C, { state: await begin(C) });
  ck("6.0 pré-condição: empresa conectou", ok1.status === 200 && (await conns(C)).length === 1);
  await su("update company_whatsapp_connections set status='disconnected', disconnected_at=now() where company_id=$1", [C.c]);
  const sPending = await begin(C);
  const sReserved = await begin(C);
  const rs = (await svc("select public.whatsapp_signup_reserve($1) j", [sReserved])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1, $2, null)", [rs.session_id, "EAAB-TOKEN-DE-SESSAO-REVOGADA-0123456789"]);
  const connBefore = await snapConn();
  const msgCount = async () => Number((await su("select (select count(*) from whatsapp_messages)+(select count(*) from whatsapp_conversations) n")).rows[0].n);
  const msgBefore = await msgCount();
  const keepSecrets = async () => (await su("select name from vault.secrets where not starts_with(name,'wa_token_signup_') order by name")).rows.map((x) => x.name).join(",");
  const secretsBefore = await keepSecrets();
  const rv = (await mset(C.c, false, "fim do piloto")).rows[0].j;
  const row = await pilotRow(C.c);
  ck("6.1 revogar: changed=true, grava quem revogou e quando, mantém quem autorizou", rv.changed === true && row.authorized === false && row.revoked_by === MASTER && !!row.revoked_at && row.authorized_by === MASTER);
  const evs = await events(C.c);
  ck("6.2 trilha: authorized depois revoked, com atores", evs.map((e) => e.action).join(",") === "authorized,revoked" && evs.every((e) => e.actor_user_id === MASTER));
  const sess = (await su("select status, error_code, token_secret_id from whatsapp_signup_sessions where company_id=$1 and error_code='pilot_revoked'", [C.c])).rows;
  ck("6.3 sessões em andamento encerradas (failed/pilot_revoked) e o token da reservada apagado", rv.sessions_closed >= 1 && sess.length >= 1 && sess.every((x) => x.status === "failed" && x.token_secret_id === null) && Number((await su("select count(*) n from vault.secrets where name = 'wa_token_signup_' || $1", [rs.session_id])).rows[0].n) === 0);
  ck("6.4 novas sessões impedidas (begin PT409) e o estado mostra 'company_not_authorized'", (await beginRaw(C)).code === "PT409" && (await stateOf(C)).signup.reason === "company_not_authorized");
  const cr = (await svc("select public.whatsapp_signup_complete($1,'555000111222',$2,'+55','x',null,now(),now(),'cloud_api') j", [rs.session_id, C.pnid])).rows[0].j;
  ck("6.5 concluir a sessão que estava reservada depois da revogação é impossível", cr.ok === false);
  void sPending;
  const conn2 = await snapConn();
  ck("6.6 conexões (inclusive a antiga) e seus tokens ficam intactos", connBefore.h === conn2.h && connBefore.n === conn2.n);
  ck("6.7 mensagens/conversas e demais segredos (inclusive PINs) preservados", (await msgCount()) === msgBefore && (await keepSecrets()) === secretsBefore);
  ck("6.8 revogar de novo é idempotente (sem novo evento)", (await mset(C.c, false)).rows[0].j.changed === false && (await events(C.c)).length === 2);
  await mset(C.c, true, "volta");
  const row2 = await pilotRow(C.c);
  ck("6.9 reautorizar zera a revogação atual, mantém a trilha completa e volta a permitir sessões", row2.authorized === true && row2.revoked_by === null && row2.revoked_at === null && (await events(C.c)).map((e) => e.action).join(",") === "authorized,revoked,authorized" && (await beginRaw(C)).ok);
}
{
  // revogação "por fora" (UPDATE direto, sem fechar sessões): o banco ainda recusa reserve e complete
  const C = await mkCo("R2", { pilot: true });
  const s = await begin(C);
  const rs = (await svc("select public.whatsapp_signup_reserve($1) j", [s])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1, $2, null)", [rs.session_id, "EAAB-TOKEN-OUTRA-SESSAO-0123456789ab"]);
  await su("update whatsapp_signup_pilot_companies set authorized=false where company_id=$1", [C.c]);
  const cr = (await svc("select public.whatsapp_signup_complete($1,'555000111222',$2,'+55','x',null,now(),now(),'cloud_api') j", [rs.session_id, C.pnid])).rows[0].j;
  ck("6.10 revogada com a sessão já reservada: complete devolve company_not_authorized, sessão failed e nenhuma conexão", cr.error === "company_not_authorized" && (await sessOf(C)).status === "failed" && (await conns(C)).length === 0);
  const s2 = "c".repeat(64);
  await insertSession(C, s2);
  ck("6.11 reserve de sessão antiga com a empresa revogada: company_not_authorized", (await svc("select public.whatsapp_signup_reserve($1) j", [s2])).rows[0].j.error === "company_not_authorized");
}

{
  // a allowlist não substitui o gate de papel: empresa autorizada, mas o usuário foi rebaixado depois de reservar
  const C = await mkCo("R3", { pilot: true });
  const s = await begin(C, "admin");
  const rs = (await svc("select public.whatsapp_signup_reserve($1) j", [s])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1, $2, null)", [rs.session_id, "EAAB-TOKEN-ROLE-GATE-0123456789abcdef"]);
  await su("update company_users set role='attendant' where company_id=$1 and user_id=$2", [C.c, C.ids.admin]);
  const cr = (await svc("select public.whatsapp_signup_complete($1,'555000111222',$2,'+55','x',null,now(),now(),'cloud_api') j", [rs.session_id, C.pnid])).rows[0].j;
  ck("6.12 empresa autorizada, mas usuário rebaixado depois da reserva: complete recusa por papel (a allowlist não substitui o gate de papel)", cr.error === "unauthorized" && (await conns(C)).length === 0);
}
console.log("\n== 7. simultaneidade, reconexão e isolamento ==");
{
  const P = await mkCo("P", { pilot: true }), Q = await mkCo("Q", { pilot: true });
  const sp = await begin(P), sq = await begin(Q);
  const [rp, rq] = await Promise.all([run(P, { state: sp }), run(Q, { state: sq })]);
  ck("7.1 duas empresas autorizadas conectando ao mesmo tempo: ambas ativas, cada uma com o seu número e o seu token", rp.status === 200 && rq.status === 200
    && (await conns(P)).length === 1 && (await conns(Q)).length === 1 && (await conns(P))[0].phone_number_id === P.pnid && (await conns(Q))[0].phone_number_id === Q.pnid && (await conns(P))[0].token_secret_id !== (await conns(Q))[0].token_secret_id);
  const U1 = await mkCo("U1", { pilot: true }), W1 = await mkCo("W1");
  const su1 = await begin(U1);
  const bs = "d".repeat(64);
  await insertSession(W1, bs);
  const [ru, rw] = await Promise.all([run(U1, { state: su1 }), run(W1, { state: bs })]);
  ck("7.2 autorizada e NÃO autorizada ao mesmo tempo: só a autorizada conecta, a outra não deixa rastro", ru.status === 200 && rw.status === 403 && (await conns(U1)).length === 1 && (await conns(W1)).length === 0 && rw.meta.calls.length === 0);
  await su("update company_whatsapp_connections set status='disconnected', disconnected_at=now() where company_id=$1", [P.c]);
  const oldId = (await conns(P))[0].id;
  const rr = await run(P, { state: await begin(P) });
  ck("7.3 reconexão do mesmo número (empresa autorizada): reaproveita a linha e reativa", rr.status === 200 && (await conns(P)).length === 1 && (await conns(P))[0].id === oldId && (await conns(P))[0].status === "active");
  await su("update company_whatsapp_connections set status='disconnected', disconnected_at=now() where company_id=$1", [P.c]);
  await mset(P.c, false);
  ck("7.4 reconexão com a empresa REVOGADA é recusada e a conexão antiga fica", (await beginRaw(P)).code === "PT409" && (await conns(P)).length === 1 && (await conns(P))[0].status === "disconnected");
}

console.log("\n== 8. compatibilidade com conexão existente (tipo Djalexeventos) ==");
{
  const J = await mkCo("J"); // NÃO autorizada, com conexão manual ativa
  await su("insert into company_whatsapp_connections (company_id,status,mode,waba_id,phone_number_id,display_phone_number,business_name,webhook_status,connected_at) values ($1,'active','test','111222333444555','999888777666','+55 11 98888-0000','Djalex-like','active',now())", [J.c]);
  const hash = async () => (await su("select md5(row(c.*)::text) h from company_whatsapp_connections c where company_id=$1", [J.c])).rows[0].h;
  const before = await hash();
  const stJ = await stateOf(J);
  ck("8.1 empresa com conexão manual ativa fora do piloto: estado normal, sem signup", stJ.connection_active === true && stJ.whatsapp === true && stJ.signup.available === false && stJ.can_manage === true);
  const secrets0 = await snapSecrets();
  await mset(J.c, true); await mset(J.c, false);
  ck("8.2 autorizar/revogar não altera nenhuma coluna da conexão existente", (await hash()) === before);
  ck("8.3 resumo da conexão segue funcionando para a empresa fora do piloto", (await J.owner("select public.whatsapp_get_connection_summary($1) j", [J.c])).ok);
  ck("8.4 Vault intacto por autorizar/revogar", (await snapSecrets()).h === secrets0.h);
}


console.log("\n== 10. revogação DURANTE o onboarding (a resposta da Meta chega depois) ==");
const regOf = async (co) => (await su("select * from whatsapp_number_registrations where company_id=$1", [co.c])).rows[0];
const attemptsOf = async (co) => Number((await su("select count(*) n from whatsapp_registration_attempts a join whatsapp_number_registrations r on r.id=a.registration_id where r.company_id=$1", [co.c])).rows[0].n);
const vaultByPrefix = async (prefix, sid) => Number((await su("select count(*) n from vault.secrets where name = $1 || $2", [prefix, sid])).rows[0].n);
const pinSecrets = async (co) => Number((await su("select count(*) n from vault.secrets v join whatsapp_number_registrations r on r.pin_secret_id = v.id where r.company_id=$1", [co.c])).rows[0].n);
{
  // A) revogada enquanto a Meta registrava; a Meta responde SUCESSO depois da revogação
  const C = await mkCo("RV1", { pilot: true });
  const s = await begin(C);
  const meta = mkMeta(C, { register: async () => { await mset(C.c, false, "revogado no meio"); return { ok: true }; } });
  const r = await run(C, { state: s, meta });
  const row = await sessByState(s); const reg = await regOf(C);
  ck("10.1 sucesso da Meta depois da revogação: 403, conexão NÃO criada, sessão failed", r.status === 403 && r.j?.code === "company_not_authorized" && (await conns(C)).length === 0 && row.status === "failed");
  ck("10.2 o efeito na Meta foi registrado e é recuperável: registro 'registered' com PIN preservado no Vault", reg.state === "registered" && !!reg.registered_at && reg.pin_secret_id !== null && (await pinSecrets(C)) === 1);
  ck("10.3 o webhook NÃO foi assinado depois da revogação (nenhum efeito novo na Meta) e o registro foi chamado uma única vez", !r.meta.calls.some((c) => c.fn === "subscribe") && r.meta.calls.filter((c) => c.fn === "register").length === 1 && (await attemptsOf(C)) === 1);
  ck("10.4 nenhuma retentativa automática: reenviar o mesmo state é recusado e a Meta não é chamada", await (async () => { const r2 = await run(C, { state: s }); return r2.status >= 400 && r2.meta.calls.length === 0 && (await attemptsOf(C)) === 1; })());
  // reautorizar e reconectar: o registro já concluído NÃO é repetido
  await mset(C.c, true, "reautorizada");
  const r3 = await run(C, { state: await begin(C) });
  ck("10.5 reautorizada: reconecta sem registrar de novo (registro concluído é reaproveitado) e a conexão fica ativa em modo test", r3.status === 200 && !r3.meta.calls.some((c) => c.fn === "register") && (await conns(C)).length === 1 && (await conns(C))[0].status === "active" && (await attemptsOf(C)) === 1);
}
{
  // B) revogada enquanto a Meta registrava; a Meta NÃO responde (timeout): resultado incerto
  const C = await mkCo("RV2", { pilot: true });
  const s = await begin(C);
  const meta = mkMeta(C, { register: async () => { await mset(C.c, false, "revogado no meio"); return { ok: false, kind: "timeout" }; } });
  const r = await run(C, { state: s, meta });
  const row = await sessByState(s); const reg = await regOf(C);
  ck("10.6 resultado incerto + revogação: sem conexão, registro 'uncertain' (estado recuperável) e a resposta ao usuário não promete nada", (await conns(C)).length === 0 && reg.state === "uncertain" && r.status >= 400 && r.meta.calls.filter((c) => c.fn === "register").length === 1);
  ck("10.7 token e PIN PRESERVADOS enquanto o registro está incerto (a sessão encerra, o token fica no Vault)", row.status === "failed" && row.token_secret_id !== null && (await vaultByPrefix("wa_token_signup_", row.id)) === 1 && (await pinSecrets(C)) === 1);
  const sw = (await svc("select public.whatsapp_signup_sweep() j")).rows[0].j;
  ck("10.8 a varredura (sweep) também respeita: não apaga o token nem o PIN de registro incerto", (await vaultByPrefix("wa_token_signup_", row.id)) === 1 && (await pinSecrets(C)) === 1 && sw.ok === true);
  ck("10.9 sem retentativa automática: nova chamada com o mesmo state não chega à Meta e as tentativas continuam em 1", await (async () => { const r2 = await run(C, { state: s }); return r2.meta.calls.length === 0 && (await attemptsOf(C)) === 1; })());
  // reautorizada: registro 'uncertain' continua bloqueando novo registro (exige conferência humana)
  await mset(C.c, true, "volta");
  const r4 = await run(C, { state: await begin(C) });
  ck("10.10 reautorizada: o registro incerto NÃO é repetido sozinho (409) e nada é registrado na Meta", r4.status === 409 && !r4.meta.calls.some((c) => c.fn === "register") && (await attemptsOf(C)) === 1);
  // conferência humana resolve; só então a limpeza remove o token
  const reg2 = await regOf(C);
  await svc("select public.whatsapp_registration_resolve($1, 'failed') j", [reg2.id]);
  await svc("select public.whatsapp_signup_sweep() j");
  ck("10.11 depois de resolvido o registro, a varredura remove o token órfão (e o PIN segue conforme a política própria)", (await vaultByPrefix("wa_token_signup_", row.id)) === 0);
}
{
  // C) revogação direta no banco com tentativa em curso (started/in_progress): o banco não conclui
  const C = await mkCo("RV3", { pilot: true });
  const s = await begin(C);
  const rs = (await svc("select public.whatsapp_signup_reserve($1) j", [s])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1, $2, null)", [rs.session_id, "EAAB-TOKEN-EM-CURSO-0123456789abcdef"]);
  const prep = (await svc("select public.whatsapp_registration_prepare($1, $2, '555000111222') j", [rs.session_id, C.pnid])).rows[0].j;
  await svc("select public.whatsapp_registration_store_pin($1, $2, '482913', 'customer') j", [rs.session_id, prep.registration_id]);
  const ba = (await svc("select public.whatsapp_registration_begin_attempt($1, $2) j", [rs.session_id, prep.registration_id])).rows[0].j;
  await mset(C.c, false, "durante a tentativa");
  ck("10.12 revogar com tentativa em curso: sessão failed, token PRESERVADO (operação externa em aberto) e registro continua in_progress", ba.ok === true && (await sessOf(C)).status === "failed" && (await sessOf(C)).token_secret_id !== null && (await regOf(C)).state === "in_progress" && (await vaultByPrefix("wa_token_signup_", rs.session_id)) === 1);
  const cr = (await svc("select public.whatsapp_signup_complete($1,'555000111222',$2,'+55','x',null,now(),now(),'cloud_api') j", [rs.session_id, C.pnid])).rows[0].j;
  ck("10.13 resposta tardia da Meta: o banco recusa a conclusão e nenhuma conexão é ativada", cr.ok === false && (await conns(C)).length === 0);
  const fin = (await svc("select public.whatsapp_registration_finish_attempt($1, 'success', null) j", [ba.attempt_id])).rows[0].j;
  ck("10.14 o resultado tardio da tentativa ainda é gravado (registro 'registered'), sem reabrir a sessão", fin.ok === true && (await regOf(C)).state === "registered" && (await sessOf(C)).status === "failed");
  const again = (await svc("select public.whatsapp_registration_begin_attempt($1, $2) j", [rs.session_id, prep.registration_id])).rows[0].j;
  ck("10.15 com a sessão encerrada o banco não permite NOVA tentativa de registro", again.ok === false);
  await svc("select public.whatsapp_signup_sweep() j");
  ck("10.16 resolvida a operação externa (registered), a varredura limpa o token da sessão encerrada", (await vaultByPrefix("wa_token_signup_", rs.session_id)) === 0 && (await regOf(C)).pin_secret_id !== null);
}
{
  // D) sessão VENCIDA com registro em curso: a varredura marca 'expired' mas preserva o token até a operação ser resolvida
  const C = await mkCo("RV4", { pilot: true });
  const s = await begin(C);
  const rs = (await svc("select public.whatsapp_signup_reserve($1) j", [s])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1, $2, null)", [rs.session_id, "EAAB-TOKEN-VENCIDA-0123456789abcdefgh"]);
  const prep = (await svc("select public.whatsapp_registration_prepare($1, $2, '555000111222') j", [rs.session_id, C.pnid])).rows[0].j;
  await svc("select public.whatsapp_registration_store_pin($1, $2, '135790', 'customer') j", [rs.session_id, prep.registration_id]);
  const ba = (await svc("select public.whatsapp_registration_begin_attempt($1, $2) j", [rs.session_id, prep.registration_id])).rows[0].j;
  await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id = $1", [rs.session_id]);
  await svc("select public.whatsapp_signup_sweep() j");
  const mid = await sessOf(C);
  ck("10.17 sessão vencida com tentativa em curso: varredura marca 'expired' mas PRESERVA o token e o PIN", ba.ok === true && mid.status === "expired" && mid.token_secret_id !== null && (await vaultByPrefix("wa_token_signup_", rs.session_id)) === 1 && (await pinSecrets(C)) === 1);
  await svc("select public.whatsapp_registration_finish_attempt($1, 'success', null) j", [ba.attempt_id]);
  await svc("select public.whatsapp_signup_sweep() j");
  ck("10.18 resolvida a operação, a próxima varredura remove o token da sessão vencida (e o PIN do registro concluído permanece)", (await vaultByPrefix("wa_token_signup_", rs.session_id)) === 0 && (await sessOf(C)).token_secret_id === null && (await pinSecrets(C)) === 1);
}
console.log("\n== 9. vazamento entre empresas e limpeza ==");
{
  const X = await mkCo("X"), Y = await mkCo("Y", { pilot: true });
  const sx = await stateOf(X), sy = await stateOf(Y);
  ck("9.1 o estado de uma empresa não revela ids/nomes de outra nem se ela está no piloto", !JSON.stringify(sx).includes(Y.c) && !JSON.stringify(sy).includes(X.c) && sx.signup.reason === "company_not_authorized");
  ck("9.2 owner de X não consegue consultar o estado de Y", !(await X.owner("select public.whatsapp_get_module_state($1)", [Y.c])).ok);
  const dc = await mkCo("DEL"); await mset(dc.c, true); await mset(dc.c, false);
  await su("delete from companies where id=$1", [dc.c]);
  ck("9.3 excluir a empresa remove a linha da allowlist e a trilha (cascade)", !(await pilotRow(dc.c)) && (await events(dc.c)).length === 0);
}
{
  const bundle = ALL_TEXT.join("\n") + logs.join("\n");
  ck("9.4 nenhuma resposta/log da Edge contém code, token do cliente ou App Secret", !bundle.includes(APP_SECRET) && !/AQD-AUTH-CODE/.test(bundle) && !/EAAB-BIZ-TOKEN/.test(bundle));
}

fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP SIGNUP PILOT (ALLOWLIST)");
