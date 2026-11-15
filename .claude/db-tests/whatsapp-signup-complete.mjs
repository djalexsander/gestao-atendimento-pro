// Edge whatsapp-signup-complete: o handler REAL (transpilado) sobre o banco REAL (PGlite com todas as migrations, inclusive as RPCs
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
async function mkCo(tag, { wa = true } = {}) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "sc-" + tag.toLowerCase() + "-" + (++seq), `${tag.toLowerCase()}${seq}@x.com`])).rows[0].id;
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1, true, now())", [c]);
  const out = { c, ids: {}, pnid: String(++pn) };
  for (const role of ["owner", "admin", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u); out.ids[role] = u;
  }
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
    // getPhoneStatus fica FORA de "calls" (as asserções antigas comparam a sequência exata); statusCalls registra à parte.
    async getPhoneStatus(a) { (this.statusCalls ??= []).push({ pnid: a.phoneNumberId, token: a.token }); return o.status ? o.status(a) : { ok: true, isOnBizApp: false, platformType: "NOT_APPLICABLE" }; },
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

const A = await mkCo("A"), B = await mkCo("B"), N = await mkCo("N", { wa: false });

console.log("\n== 1. requisição, autenticação e configuração ==");
ck("1.1 OPTIONS (CORS) 204", (await run(A, { method: "OPTIONS", state: "x".repeat(40) })).status === 204);
ck("1.2 GET 405", (await run(A, { method: "GET", state: "x".repeat(40) })).status === 405);
ck("1.3 sem Authorization: 401 e nada consumido", await (async () => { const s = await begin(A); const r = await run(A, { state: s, auth: null }); return r.status === 401 && (await sessByState(s)).status === "pending"; })());
ck("1.4 JWT inválido/expirado: 401 e a sessão segue pending", await (async () => { const s = await begin(A); const r = await run(A, { state: s, auth: "Bearer jwt-bad" }); return r.status === 401 && (await sessByState(s)).status === "pending" && r.meta.calls.length === 0; })());
ck("1.5 Authorization sem Bearer: 401", (await run(A, { state: "x".repeat(40), auth: "Basic abc" })).status === 401);
ck("1.6 corpo não-JSON, não-objeto e grande: 400/400/413", (await run(A, { rawBody: "{{", state: "x" })).status === 400 && (await run(A, { rawBody: "[1]", state: "x" })).status === 400
  && (await run(A, { rawBody: JSON.stringify({ a: "x".repeat(20000) }), state: "x" })).status === 413);
const s16 = await begin(A);
const bad = async (patch) => (await run(A, { state: s16, rawBody: JSON.stringify({ state: s16, code: "c", waba_id: "555000111222", phone_number_id: A.pnid, ...patch }) })).status;
ck("1.7 campos ausentes/inválidos: 400 e a sessão não é consumida", (await bad({ state: "curto" })) === 400 && (await bad({ code: "" })) === 400 && (await bad({ code: 5 })) === 400
  && (await bad({ waba_id: "abc" })) === 400 && (await bad({ phone_number_id: "1" })) === 400 && (await bad({ waba_id: undefined })) === 400 && (await sessByState(s16)).status === "pending");
const cfg = async (o) => { const s = await begin(A); const r = await run(A, { state: s, ...o }); return r.status === 503 && (await sessByState(s)).status === "pending" && r.meta.calls.length === 0; };
ck("1.8 sem versão da Graph / App Secret no ambiente: 503 e sessão intacta (não existe mais secret de PIN)", await cfg({ graphVersion: undefined }) && await cfg({ graphVersion: "99" }) && await cfg({ appSecret: undefined }));
await su("update whatsapp_platform_settings set embedded_signup_enabled=false");
const sOff = await (async () => { const bTmp = await mkCo("OFF"); await su("update whatsapp_platform_settings set embedded_signup_enabled=true"); const s = await begin(bTmp); await su("update whatsapp_platform_settings set embedded_signup_enabled=false"); const r = await run(bTmp, { state: s }); return { r, s }; })();
ck("1.9 plataforma desligada (flag false): 503, sessão intacta, Meta não chamada", sOff.r.status === 503 && (await sessByState(sOff.s)).status === "pending" && sOff.r.meta.calls.length === 0);
await su("update whatsapp_platform_settings set embedded_signup_enabled=true");

console.log("\n== 2. autorização ==");
ck("2.1 attendant não cria sessão (nunca chega ao backend)", !(await A.attendant("select public.whatsapp_signup_begin($1) j", [A.c])).ok);
ck("2.2 empresa sem módulo whatsapp não cria sessão", !(await N.owner("select public.whatsapp_signup_begin($1) j", [N.c])).ok);
{
  const s = await begin(A);
  const r = await run(A, { state: s, jwtUser: B.ids.owner });
  const row = await sessByState(s);
  ck("2.3 outro usuário (de outra empresa) com state alheio: 403, sessão failed, sem Meta", r.status === 403 && row.status === "failed" && row.error_code === "user_mismatch" && r.meta.calls.length === 0 && (await conns(A)).length === 0 && (await conns(B)).length === 0);
}
{
  const s = await begin(A, "admin");
  const r = await run(A, { state: s, jwtUser: A.ids.owner });
  ck("2.4 colega da MESMA empresa não usa o state de outro: 403", r.status === 403 && (await sessByState(s)).error_code === "user_mismatch");
}
{
  const C1 = await mkCo("C1");
  const s = await begin(C1, "admin");
  await su("update company_users set role='attendant' where company_id=$1 and user_id=$2", [C1.c, C1.ids.admin]);
  const r = await run(C1, { state: s, role: "admin" });
  ck("2.5 papel rebaixado depois de criar a sessão: 403 e Meta não chamada", r.status === 403 && r.meta.calls.length === 0 && (await conns(C1)).length === 0);
}
{
  const C2 = await mkCo("C2");
  const s = await begin(C2);
  await su("delete from company_module_overrides where company_id=$1", [C2.c]);
  const r = await run(C2, { state: s });
  ck("2.6 módulo WhatsApp removido depois de criar a sessão: 403 e Meta não chamada", r.status === 403 && r.meta.calls.length === 0);
}
{
  const C3 = await mkCo("C3");
  const s = await begin(C3, "admin");
  await su("update company_users set status='inactive' where company_id=$1 and user_id=$2", [C3.c, C3.ids.admin]);
  const r = await run(C3, { state: s, role: "admin" });
  ck("2.7 usuário desativado depois de criar a sessão: 403", r.status === 403 && r.meta.calls.length === 0);
}
{
  const s = await begin(A);
  const r = await run(B, { state: s, jwtUser: B.ids.owner, pnid: A.pnid });
  ck("2.8 company_id do corpo é ignorado (nem existe no contrato): usuário de B não afeta A", r.status === 403 && (await conns(A)).length === 0);
}

console.log("\n== 3. state ==");
ck("3.1 state inexistente (formato válido): 400", (await run(A, { state: "a".repeat(64) })).status === 400);
{
  const s = await begin(A);
  await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [s]);
  const r = await run(A, { state: s });
  ck("3.2 state vencido: 410 e Meta não chamada", r.status === 410 && r.meta.calls.length === 0);
}
{
  const s = await begin(A);
  const first = await run(A, { state: s, pnid: A.pnid });
  const again = await run(A, { state: s, pnid: A.pnid });
  ck("3.3 state reutilizado: a primeira conclui, a segunda é 409 (anti-replay) e a Meta não é chamada de novo", first.status === 200 && again.status === 409 && again.meta.calls.length === 0);
}
{
  const s1 = await begin(B);
  await begin(B); // cancela a pendente anterior
  ck("3.4 state de sessão substituída: 410", (await run(B, { state: s1 })).status === 410);
}

console.log("\n== 4. caminho feliz ==");
const D = await mkCo("D");
const sD = await begin(D);
const r4 = await run(D, { state: sD, pnid: D.pnid, extra: { company_id: A.c } });
ck("4.1 200 {ok,status:active,mode:test} com dados NÃO sensíveis", r4.status === 200 && r4.j.ok === true && r4.j.status === "active" && r4.j.mode === "test" && r4.j.idempotent === false
  && r4.j.display_phone_number === "+55 11 90000-1111" && r4.j.business_name === "Loja Teste" && Object.keys(r4.j).sort().join() === "business_name,connection_type,display_phone_number,idempotent,mode,ok,status" && r4.j.connection_type === "cloud_api");
ck("4.2 ordem das chamadas à Meta: troca → lista da WABA → registro → assinatura → conferência", names(r4.meta) === "exchange,list,register,subscribe,listSub", names(r4.meta));
const cD = await conns(D);
ck("4.3 conexão ÚNICA da empresa da sessão (company_id do corpo ignorado), active, test, embedded_signup, token valid", cD.length === 1 && cD[0].status === "active" && cD[0].mode === "test" && cD[0].connection_source === "embedded_signup"
  && cD[0].token_status === "valid" && cD[0].waba_id === "555000111222" && cD[0].phone_number_id === D.pnid && !!cD[0].registered_at && !!cD[0].webhook_subscribed_at && (await conns(A)).every((c) => c.waba_id !== "555000111222" || c.company_id === A.c));
ck("4.4 token gravado no Vault e ligado à conexão; sessão completed", (await su("select secret from vault.secrets where id=$1", [cD[0].token_secret_id])).rows[0].secret === TOKEN_OF(r4.code) && (await sessByState(sD)).status === "completed");
const exch = r4.meta.calls[0], reg = r4.meta.calls[2];
ck("4.5 troca usa o App ID do banco + App Secret do ambiente e o code recebido", exch.appId === APP_ID && exch.appSecret === APP_SECRET && exch.code === r4.code);
ck("4.6 PIN do registro: 6 dígitos, aleatório, guardado no Vault e igual ao enviado à Meta; reg.pnid correto", /^\d{6}$/.test(reg.pin) && reg.pnid === D.pnid && (await su("select s.secret from vault.secrets s join whatsapp_number_registrations r on r.pin_secret_id = s.id where r.phone_number_id=$1", [D.pnid])).rows[0].secret === reg.pin);
ck("4.7 a Meta recebeu o token do cliente nas chamadas seguintes", r4.meta.calls[1].token === TOKEN_OF(r4.code));
{
  const all = r4.text + logs.join("");
  ck("4.8 resposta e logs NÃO contêm code, token, App Secret nem o PIN", ![r4.code, TOKEN_OF(r4.code), APP_SECRET, reg.pin, sD].some((s) => all.includes(s)));
}
ck("4.9 validade informada pela Meta vira token_expires_at", await (async () => { const E = await mkCo("E"); const r = await run(E, { pnid: E.pnid, metaOpts: { expiresIn: 3600 } }); const c = (await conns(E))[0]; return r.status === 200 && Math.abs(new Date(c.token_expires_at) - Date.now() - 3600e3) < 60e3; })());
ck("4.10 sem validade informada: token_expires_at nulo (a Meta não confirma prazo)", cD[0].token_expires_at === null);

console.log("\n== 5. falhas por estágio (sessão encerrada, sem conexão, sem segredo órfão) ==");
const failCase = async (label, tag, metaOpts, expectStatus, expectCode, expectCalls, extra = {}) => {
  const F = await mkCo(tag);
  const before = await secrets();
  const s = await begin(F);
  const r = await run(F, { state: s, pnid: F.pnid, metaOpts: typeof metaOpts === "function" ? metaOpts(F) : metaOpts, ...extra });
  const row = await sessByState(s);
  const okCalls = expectCalls === undefined || names(r.meta) === expectCalls;
  ck(label, r.status === expectStatus && row.status === "failed" && row.error_code === expectCode && (await conns(F)).length === 0 && (await secrets()) === before && okCalls && row.token_secret_id === null,
    `${r.status} ${row.status} ${row.error_code} calls=${names(r.meta)} secrets=${before}->${await secrets()}`);
  const again = await run(F, { state: s, pnid: F.pnid });
  return { r, row, again };
};
const rr = await failCase("5.1 code inválido (Meta 400): 400/meta_code_exchange, nada mais é chamado", "F1", { exchange: () => ({ ok: false, kind: "http", status: 400, code: "100" }) }, 400, "meta_code_exchange", "exchange");
ck("5.1b sessão falha não pode ser reutilizada: 409", rr.again.status === 409);
await failCase("5.2 troca do code com timeout: 504", "F2", { exchange: () => ({ ok: false, kind: "timeout" }) }, 504, "meta_code_exchange", "exchange");
await failCase("5.3 troca do code com erro de rede/5xx: 502", "F3", { exchange: () => ({ ok: false, kind: "http", status: 500 }) }, 502, "meta_code_exchange", "exchange");
await failCase("5.4 WABA inacessível com o token (Meta 4xx): 400/meta_waba_lookup", "F4", { list: () => ({ ok: false, kind: "http", status: 403, code: "200" }) }, 400, "meta_waba_lookup", "exchange,list");
await failCase("5.5 Graph fora do ar ao listar a WABA: 502", "F5", { list: () => ({ ok: false, kind: "network" }) }, 502, "meta_waba_lookup", "exchange,list");
await failCase("5.6 WABA incompatível (número não está na WABA): 400/phone_not_in_waba", "F6", { phones: [{ id: "999999999", displayPhoneNumber: "x", verifiedName: "y" }] }, 400, "phone_not_in_waba", "exchange,list");
await failCase("5.7 lista vazia de números: 400/phone_not_in_waba", "F7", { phones: [] }, 400, "phone_not_in_waba", "exchange,list");
{
  const F = await mkCo("F8");
  const s = await begin(F);
  const r = await run(F, { state: s, pnid: "12" , rawBody: JSON.stringify({ state: s, code: "c", waba_id: "555000111222", phone_number_id: "abc" }) });
  ck("5.8 Phone Number ID inválido: 400 antes de consumir a sessão", r.status === 400 && (await sessByState(s)).status === "pending");
}
{
  const F = await mkCo("F9");
  const own = await mkCo("OWN");
  await su("insert into company_whatsapp_connections (company_id,status,phone_number_id,token_secret_id) values ($1,'active',$2,null)", [own.c, F.pnid]);
  const ownBefore = JSON.stringify((await conns(own))[0]);
  const before = await secrets();
  const s = await begin(F);
  const r = await run(F, { state: s, pnid: F.pnid });
  const row = await sessByState(s);
  ck("5.9 número de OUTRA empresa: 409/phone_in_use, sem token no Vault, sem registro nem assinatura na Meta", r.status === 409 && row.error_code === "phone_in_use" && names(r.meta) === "exchange,list" && (await secrets()) === before && (await conns(F)).length === 0);
  ck("5.9b a conexão da outra empresa não foi tocada", JSON.stringify((await conns(own))[0]) === ownBefore);
}
{
  const F = await mkCo("F10");
  await su("insert into company_whatsapp_connections (company_id,status,phone_number_id) values ($1,'active','930000001')", [F.c]);
  const before = await secrets();
  const s = await begin(F);
  const r = await run(F, { state: s, pnid: F.pnid });
  ck("5.10 empresa já com número ativo diferente: 409/company_has_active_connection, sem efeito na Meta", r.status === 409 && (await sessByState(s)).error_code === "company_has_active_connection" && names(r.meta) === "exchange,list" && (await secrets()) === before
    && (await conns(F)).length === 1 && (await conns(F))[0].phone_number_id === "930000001");
}
{
  const F = await mkCo("F11");
  const before = await secrets();
  const s = await begin(F);
  const failing = async (fn, args) => (fn === "whatsapp_signup_store_token" ? { data: null, error: { message: "vault indisponível", code: "XX000" } } : realRpc(fn, args));
  const r = await run(F, { state: s, pnid: F.pnid, rpc: failing });
  const row = await sessByState(s);
  ck("5.11 erro ao guardar o token: 500/token_store_failed, nada registrado nem assinado na Meta, sem conexão", r.status === 500 && row.status === "failed" && row.error_code === "token_store_failed" && names(r.meta) === "exchange,list" && (await conns(F)).length === 0 && (await secrets()) === before);
  ck("5.11b a mensagem de erro ao usuário não vaza o erro interno", !/vault|XX000/.test(r.text));
}
await failCase("5.12 falha no registro do número: 502, token removido do Vault, sem conexão", "F12", { register: () => ({ ok: false, kind: "http", status: 400, code: "131000" }) }, 502, "meta_register_failed", "exchange,list,register");
await failCase("5.13 falha ao assinar o webhook: 502, token removido, sem conexão", "F13", { subscribe: () => ({ ok: false, kind: "http", status: 400, code: "100" }) }, 502, "meta_subscribe_failed", "exchange,list,register,subscribe");
await failCase("5.14 assinatura não confirmada (nosso app fora da lista): 502, token removido", "F14", { listSub: () => ({ ok: true, appIds: ["111"] }) }, 502, "meta_subscribe_unverified", "exchange,list,register,subscribe,listSub");
await failCase("5.15 conferência da assinatura com erro: 502/504, token removido", "F15", { listSub: () => ({ ok: false, kind: "timeout" }) }, 504, "meta_subscribe_unverified", "exchange,list,register,subscribe,listSub");
{
  const all = logs.join("");
  ck("5.16 nenhum log de falha contém code, token ou secrets", !all.includes(CODE) && !/EAAB-BIZ-TOKEN/.test(all) && !all.includes(APP_SECRET));
}

console.log("\n== 6. estágio final: respostas perdidas, corridas e recuperação ==");
{
  const F = await mkCo("G1");
  let n = 0;
  const flaky = async (fn, args) => (fn === "whatsapp_signup_complete" && ++n === 1 ? { data: null, error: { message: "timeout de rede" } } : realRpc(fn, args));
  const r = await run(F, { pnid: F.pnid, rpc: flaky });
  ck("6.1 a conclusão falha uma vez e a nova tentativa interna conclui: 200, uma conexão", r.status === 200 && n === 2 && (await conns(F)).length === 1);
}
{
  const F = await mkCo("G2");
  let n = 0;
  const lostResponse = async (fn, args) => { if (fn !== "whatsapp_signup_complete") return realRpc(fn, args); const real = await realRpc(fn, args); return ++n === 1 ? { data: null, error: { message: "resposta perdida" } } : real; };
  const r = await run(F, { pnid: F.pnid, rpc: lostResponse });
  ck("6.2 conclusão gravada mas resposta perdida: a repetição é idempotente (200, idempotent=true, UMA conexão)", r.status === 200 && r.j.idempotent === true && (await conns(F)).length === 1);
}
{
  const F = await mkCo("G3");
  const before = await secrets();
  const dead = async (fn, args) => (fn === "whatsapp_signup_complete" ? { data: null, error: { message: "fora do ar" } } : realRpc(fn, args));
  const s = await begin(F);
  const r = await run(F, { state: s, pnid: F.pnid, rpc: dead });
  const row = await sessByState(s);
  ck("6.3 banco indisponível no fim: 503, a sessão NÃO é encerrada (estado incerto) e nenhuma conexão pronta é anunciada", r.status === 503 && row.status === "reserved" && (await conns(F)).length === 0);
  const sw = (await svc("select public.whatsapp_signup_sweep($1) j", [F.c])).rows[0].j;
  await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id=$1", [row.id]);
  const sw2 = (await svc("select public.whatsapp_signup_sweep($1) j", [F.c])).rows[0].j;
  ck("6.4 depois do vencimento a varredura expira a sessão e apaga o token órfão", sw.ok && sw2.secrets_removed === 1 && (await secrets()) === before && (await sessByState(s)).status === "expired");
}
{
  const F = await mkCo("G4"), RIVAL = await mkCo("RIVAL");
  const before = await secrets();
  const s = await begin(F);
  // outra empresa "ganha" o número entre a conferência local e a conclusão
  const r = await run(F, { state: s, pnid: F.pnid, metaOpts: { subscribe: async () => { await su("insert into company_whatsapp_connections (company_id,status,phone_number_id) values ($1,'disconnected',$2)", [RIVAL.c, F.pnid]); return { ok: true }; } } });
  const row = await sessByState(s);
  ck("6.5 corrida pelo mesmo número no último instante: 409/phone_in_use, sem conexão", r.status === 409 && row.error_code === "phone_in_use" && (await conns(F)).length === 0);
  ck("6.6 e o token (gravado antes) é apagado pela limpeza de sessão failed — sem segredo órfão", (await secrets()) === before && row.token_secret_id === null);
}
{
  const F = await mkCo("G5");
  const s = await begin(F);
  const r = await run(F, { state: s, pnid: F.pnid, metaOpts: { listSub: async () => { await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [s]); return { ok: true, appIds: [APP_ID] }; } } });
  ck("6.7 sessão vence durante o fluxo: 410 e nenhuma conexão", r.status === 410 && (await conns(F)).length === 0);
}

console.log("\n== 7. reconexão e preservação ==");
{
  const R1 = await mkCo("R1");
  const oldSecret = (await su("insert into vault.secrets (name, secret) values ('wa_token_old','TOKEN-ANTIGO-DE-TESTE-0000') returning id")).rows[0].id;
  const connId = (await su("insert into company_whatsapp_connections (company_id,status,mode,phone_number_id,waba_id,token_secret_id,disconnected_at) values ($1,'disconnected','live',$2,'111222333',$3,now()) returning id", [R1.c, R1.pnid, oldSecret])).rows[0].id;
  await su("update company_whatsapp_connections set status='active' where id=$1", [connId]);
  await su("select public.whatsapp_ingest_message($1,'wamid.rc.1','5544999990001','Ana','text','oi',now(),'msg:rc:1') j", [R1.pnid]);
  await su("update company_whatsapp_connections set status='disconnected', disconnected_at=now() where id=$1", [connId]);
  const convs = Number((await su("select (select count(*) from whatsapp_conversations where company_id=$1) + (select count(*) from whatsapp_messages where company_id=$1) n", [R1.c])).rows[0].n);
  const r = await run(R1, { pnid: R1.pnid });
  const c = (await conns(R1));
  ck("7.1 reconexão do mesmo número na mesma empresa: 200, MESMA linha, ativa, modo anterior (live) preservado", r.status === 200 && c.length === 1 && c[0].id === connId && c[0].status === "active" && c[0].mode === "live" && c[0].waba_id === "555000111222");
  ck("7.2 histórico (conversas/mensagens) preservado e token antigo substituído e apagado", Number((await su("select (select count(*) from whatsapp_conversations where company_id=$1) + (select count(*) from whatsapp_messages where company_id=$1) n", [R1.c])).rows[0].n) === convs
    && c[0].token_secret_id !== oldSecret && (await su("select 1 from vault.secrets where id=$1", [oldSecret])).rows.length === 0);
}
{
  const R2 = await mkCo("R2");
  await su("insert into company_whatsapp_connections (company_id,status,mode,phone_number_id,waba_id,display_phone_number,business_name,webhook_status) values ($1,'active','test',$2,'100200300','+55 44 90000-0000','Djalex-like','active')", [R2.c, R2.pnid]);
  const r = await run(R2, { pnid: R2.pnid });
  const c = await conns(R2);
  ck("7.3 conexão ATIVA existente do mesmo número é atualizada (rotação), continua active/test, sem duplicar", r.status === 200 && c.length === 1 && c[0].status === "active" && c[0].mode === "test");
}
{
  const R3 = await mkCo("R3");
  await su("insert into company_whatsapp_connections (company_id,status,mode,phone_number_id,waba_id) values ($1,'active','live','930000009','999888777')", [R3.c]);
  const before = JSON.stringify((await conns(R3))[0]);
  const r = await run(R3, { pnid: R3.pnid });
  ck("7.4 conexão atual de OUTRO número nunca é sobrescrita nem desconectada", r.status === 409 && JSON.stringify((await conns(R3))[0]) === before);
}

console.log("\n== 8. cliente da Graph API (URLs, métodos, headers, parsing) ==");
{
  const seen = [];
  const mkFetch = (handler) => async (url, init = {}) => { seen.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body }); return handler(url, init); };
  const R = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const T = "EAAB-TOKEN-DE-TESTE-DO-CLIENTE-123";

  let m = SG.createSignupMeta(mkFetch(() => R(200, { access_token: T, expires_in: 5184000 })));
  let x = await m.exchangeCode({ version: "v99.0", appId: "111", appSecret: "SEC", code: "CODE123" });
  let u = new URL(seen[0].url);
  ck("8.1 troca do code: GET /v99.0/oauth/access_token com client_id, client_secret e code; sem Authorization", seen[0].method === "GET" && u.origin === "https://graph.facebook.com" && u.pathname === "/v99.0/oauth/access_token"
    && u.searchParams.get("client_id") === "111" && u.searchParams.get("client_secret") === "SEC" && u.searchParams.get("code") === "CODE123" && !u.searchParams.has("redirect_uri") && !seen[0].headers.Authorization && x.ok && x.token === T && x.expiresInSeconds === 5184000);
  m = SG.createSignupMeta(mkFetch(() => R(200, JSON.stringify(T))));
  ck("8.2 resposta como string JSON ou texto puro também é aceita", (await m.exchangeCode({ version: "v99.0", appId: "1", appSecret: "s", code: "c" })).token === T
    && (await SG.createSignupMeta(mkFetch(() => R(200, T))).exchangeCode({ version: "v99.0", appId: "1", appSecret: "s", code: "c" })).token === T);
  ck("8.3 resposta vazia, curta, com espaços ou sem access_token: invalid_response", [(R(200, "")), R(200, "curto"), R(200, "duas palavras bem longas aqui ok"), R(200, { foo: 1 })].every(async () => true)
    && (await Promise.all(["", "curto", "duas palavras bem longas aqui ok", '{"foo":1}'].map((b) => SG.createSignupMeta(mkFetch(() => R(200, b))).exchangeCode({ version: "v99.0", appId: "1", appSecret: "s", code: "c" })))).every((r) => !r.ok && r.kind === "invalid_response"));
  m = SG.createSignupMeta(mkFetch(() => R(400, { error: { message: "Invalid code SEGREDO-NO-CORPO", code: 100, fbtrace_id: "abc" } })));
  const e = await m.exchangeCode({ version: "v99.0", appId: "1", appSecret: "s", code: "c" });
  ck("8.4 erro HTTP: só status e código numérico da Meta são guardados (mensagem/corpo descartados)", !e.ok && e.kind === "http" && e.status === 400 && e.code === "100" && !JSON.stringify(e).includes("SEGREDO"));
  ck("8.5 rede e timeout classificados", (await SG.createSignupMeta(async () => { throw new Error("falhou"); }).exchangeCode({ version: "v99.0", appId: "1", appSecret: "s", code: "c" })).kind === "network"
    && (await SG.createSignupMeta(async () => { const er = new Error("abort"); er.name = "AbortError"; throw er; }).exchangeCode({ version: "v99.0", appId: "1", appSecret: "s", code: "c" })).kind === "timeout");

  seen.length = 0;
  m = SG.createSignupMeta(mkFetch((url) => R(200, url.includes("page2") ? { data: [{ id: "2", display_phone_number: "b" }] } : { data: [{ id: "1", display_phone_number: "a", verified_name: "N" }, { foo: 1 }], paging: { next: "https://graph.facebook.com/v99.0/W/phone_numbers?page2=1" } })));
  const lp = await m.listWabaPhones({ version: "v99.0", wabaId: "W1", token: T });
  ck("8.6 lista números: GET /W1/phone_numbers com Bearer (token fora da URL), segue a paginação do Graph", seen[0].url === "https://graph.facebook.com/v99.0/W1/phone_numbers" && seen[0].headers.Authorization === `Bearer ${T}` && !seen.some((s) => s.url.includes(T))
    && lp.ok && lp.phones.length === 2 && lp.phones[0].verifiedName === "N" && lp.phones[1].id === "2");
  seen.length = 0;
  m = SG.createSignupMeta(mkFetch(() => R(200, { data: [{ id: "1" }], paging: { next: "https://evil.example.com/steal" } })));
  await m.listWabaPhones({ version: "v99.0", wabaId: "W1", token: T });
  ck("8.7 paginação para outro host NÃO é seguida (o Bearer nunca sai do Graph)", seen.length === 1);
  seen.length = 0;
  m = SG.createSignupMeta(mkFetch(() => R(200, { success: true })));
  await m.registerPhone({ version: "v99.0", phoneNumberId: "P1", token: T, pin: "123456" });
  ck("8.8 registro: POST /P1/register JSON {messaging_product:'whatsapp', pin} com Bearer", seen[0].method === "POST" && seen[0].url === "https://graph.facebook.com/v99.0/P1/register" && seen[0].headers.Authorization === `Bearer ${T}`
    && JSON.parse(seen[0].body).messaging_product === "whatsapp" && JSON.parse(seen[0].body).pin === "123456");
  seen.length = 0;
  await m.subscribeApp({ version: "v99.0", wabaId: "W1", token: T });
  ck("8.9 assinatura: POST /W1/subscribed_apps com Bearer e sem corpo", seen[0].method === "POST" && seen[0].url === "https://graph.facebook.com/v99.0/W1/subscribed_apps" && seen[0].headers.Authorization === `Bearer ${T}` && seen[0].body === undefined);
  ck("8.10 success diferente de true: invalid_response", (await SG.createSignupMeta(mkFetch(() => R(200, { success: false }))).registerPhone({ version: "v99.0", phoneNumberId: "P1", token: T, pin: "123456" })).kind === "invalid_response"
    && (await SG.createSignupMeta(mkFetch(() => R(200, {}))).subscribeApp({ version: "v99.0", wabaId: "W1", token: T })).kind === "invalid_response");
  m = SG.createSignupMeta(mkFetch(() => R(200, { data: [{ whatsapp_business_api_data: { id: "777", name: "App" } }, { whatsapp_business_api_data: { name: "sem id" } }, 5] })));
  ck("8.11 apps assinados: GET /W1/subscribed_apps → ids de data[].whatsapp_business_api_data.id", JSON.stringify((await m.listSubscribedAppIds({ version: "v99.0", wabaId: "W1", token: T })).appIds) === '["777"]');
  ck("8.12 ids com caracteres perigosos são codificados na URL", await (async () => { seen.length = 0; await SG.createSignupMeta(mkFetch(() => R(200, { data: [] }))).listWabaPhones({ version: "v99.0", wabaId: "../x?y=1", token: T }); return !seen[0].url.includes("/../") && !seen[0].url.includes("?y=1"); })());
ck("8.13 o cliente da Meta não exporta mais derivePin (sem HMAC)", SG.derivePin === undefined && typeof SG.generatePin === "function");
  ck("8.14 isValidGraphVersion reutilizada: v99.0 sim; 99, vazio e injeção não", G.isValidGraphVersion("v99.0") && !G.isValidGraphVersion("99") && !G.isValidGraphVersion("v1/../x") && !G.isValidGraphVersion(undefined));
}

console.log("\n== 10. PIN individual por número (Vault), PIN já existente, limites e incerteza ==");
const regOf = async (pnid) => (await su("select * from whatsapp_number_registrations where phone_number_id=$1", [pnid])).rows[0];
const pinOfReg = async (pnid) => { const r = await regOf(pnid); return r?.pin_secret_id ? await secretOf(r.pin_secret_id) : null; };
const attemptsOf = async (pnid) => (await su("select a.status, a.meta_code from whatsapp_registration_attempts a join whatsapp_number_registrations r on r.id=a.registration_id where r.phone_number_id=$1 order by a.started_at", [pnid])).rows;
const registers = (m) => m.calls.filter((c) => c.fn === "register");
const secretOf = async (sid) => (await su("select secret from vault.secrets where id=$1", [sid])).rows[0]?.secret ?? null;
const FAIL = (status, code) => () => ({ ok: false, kind: "http", status, code });
{
  const P1 = await mkCo("P1");
  const r = await run(P1, { pnid: P1.pnid });
  const reg1 = await regOf(P1.pnid);
  const seenPin = registers(r.meta)[0]?.pin;
  ck("10.1 número novo: PIN de 6 dígitos gerado, enviado à Meta e guardado no Vault (fonte 'generated'); registro 'registered' e ligado à conexão", r.status === 200 && /^\d{6}$/.test(seenPin) && (await pinOfReg(P1.pnid)) === seenPin
    && reg1.pin_source === "generated" && reg1.state === "registered" && reg1.connection_id === (await conns(P1))[0].id && !r.text.includes(seenPin));
  ck("10.2 auditoria: 1 tentativa 'success' sem PIN; token e PIN são segredos distintos no Vault", JSON.stringify((await attemptsOf(P1.pnid)).map((a) => a.status)) === '["success"]' && (await conns(P1))[0].token_secret_id !== reg1.pin_secret_id);
  PINS.add(seenPin);
  const P2 = await mkCo("P2");
  const r2 = await run(P2, { pnid: P2.pnid });
  PINS.add(registers(r2.meta)[0].pin);
  ck("10.3 números diferentes recebem PINs diferentes, cada um no seu segredo", r2.status === 200 && registers(r2.meta)[0].pin !== seenPin && (await regOf(P2.pnid)).pin_secret_id !== reg1.pin_secret_id);
  const P3 = await mkCo("P3");
  const r3 = await run(P3, { pnid: P3.pnid, deps: { randomPin: () => "000042" } });
  ck("10.4 PIN com zeros à esquerda ('000042') vai à Meta e ao Vault intacto", r3.status === 200 && registers(r3.meta)[0].pin === "000042" && (await pinOfReg(P3.pnid)) === "000042");
}
{
  // número que JÁ tem PIN: a Meta recusa o gerado (133005)
  const Q = await mkCo("Q1");
  const before = await secrets();
  const r = await run(Q, { pnid: Q.pnid, metaOpts: { register: FAIL(400, "133005") } });
  const reg = await regOf(Q.pnid);
  ck("10.5 133005 com PIN gerado: 409 {code:'pin_required'}, sessão failed, registro pin_required, PIN gerado apagado, sem conexão nem assinatura", r.status === 409 && r.j.code === "pin_required" && reg.state === "pin_required" && reg.pin_secret_id === null
    && (await conns(Q)).length === 0 && !r.meta.calls.some((c) => c.fn === "subscribe") && (await secrets()) === before);
  ck("10.6 a mensagem pede o PIN atual e não diz qual PIN foi tentado", /PIN atual/.test(r.j.error) && !PINS_TEXT_HIT(r.text));
  const pre = await secrets();
  const r2 = await run(Q, { pnid: Q.pnid });
  ck("10.7 nova tentativa SEM PIN do cliente: 409 pin_required antes de falar com a Meta (sem Vault, sem consumir cota)", r2.status === 409 && r2.j.code === "pin_required" && registers(r2.meta).length === 0 && (await secrets()) === pre && (await attemptsOf(Q.pnid)).length === 1);
  const r3 = await run(Q, { pnid: Q.pnid, extra: { pin: "482913" } });
  PINS.add("482913");
  ck("10.8 com o PIN do cliente: 200; a Meta recebe o PIN do cliente; fonte 'customer' no Vault; resposta sem PIN", r3.status === 200 && registers(r3.meta)[0].pin === "482913" && (await pinOfReg(Q.pnid)) === "482913" && (await regOf(Q.pnid)).pin_source === "customer" && !r3.text.includes("482913"));
}
{
  const W = await mkCo("W1");
  await run(W, { pnid: W.pnid, metaOpts: { register: FAIL(400, "133005") } });
  const r = await run(W, { pnid: W.pnid, extra: { pin: "135790" }, metaOpts: { register: FAIL(400, "133005") } });
  PINS.add("135790");
  const reg = await regOf(W.pnid);
  ck("10.9 PIN do cliente incorreto: 409 pin_incorrect, PIN descartado do Vault, registro volta a pin_required; nada sobrescrito", r.status === 409 && r.j.code === "pin_incorrect" && reg.state === "pin_required" && reg.pin_secret_id === null && (await conns(W)).length === 0
    && !r.text.includes("135790"));
}
{
  const V = await mkCo("V1");
  const out = [];
  for (const bad of ["12345", "abcdef", "1234567", "12 456", 123456, true, {}]) {
    const s = await begin(V);
    const r = await run(V, { state: s, pnid: V.pnid, extra: { pin: bad } });
    out.push(r.status === 400 && (await sessByState(s)).status === "pending" && r.meta.calls.length === 0 && !r.text.includes(String(bad)));
  }
  ck("10.10 PIN do cliente com formato inválido: 400, sessão intacta, Meta não chamada, valor não ecoado", out.every(Boolean), JSON.stringify(out));
  const ok = await run(V, { pnid: V.pnid, extra: { pin: null } });
  ck("10.11 pin nulo/ausente equivale a 'sem PIN do cliente'", ok.status === 200);
}
{
  const L = await mkCo("L1");
  const r = await run(L, { pnid: L.pnid, metaOpts: { register: FAIL(400, "133016") } });
  const reg = await regOf(L.pnid);
  ck("10.12 133016: 429 registration_blocked, estado blocked por ~72 h, PIN mantido", r.status === 429 && r.j.code === "registration_blocked" && reg.state === "blocked" && Math.abs((new Date(reg.blocked_until) - Date.now()) / 3600e3 - 72) < 0.2 && !!reg.pin_secret_id);
  const pre = await secrets();
  const r2 = await run(L, { pnid: L.pnid });
  ck("10.13 sem retentativa automática: nova sessão é barrada (429) sem tocar na Meta nem no Vault", r2.status === 429 && registers(r2.meta).length === 0 && (await secrets()) === pre && (await attemptsOf(L.pnid)).length === 1);
  await su("update whatsapp_number_registrations set blocked_until = now() - interval '1 minute' where id=$1", [reg.id]);
  const r3 = await run(L, { pnid: L.pnid });
  ck("10.14 bloqueio vencido: nova tentativa permitida, reaproveita o MESMO PIN e conclui", r3.status === 200 && registers(r3.meta)[0].pin === (await pinOfReg(L.pnid)) && (await attemptsOf(L.pnid)).length === 2);
}
{
  const T2 = await mkCo("T2");
  const r = await run(T2, { pnid: T2.pnid, metaOpts: { register: () => ({ ok: false, kind: "timeout" }) } });
  const reg = await regOf(T2.pnid);
  ck("10.15 timeout no registro: 504 registration_uncertain; estado 'uncertain'; PIN mantido (pode ter sido aplicado)", r.status === 504 && r.j.code === "registration_uncertain" && reg.state === "uncertain" && !!reg.pin_secret_id && (await conns(T2)).length === 0);
  const pre = await secrets();
  const r2 = await run(T2, { pnid: T2.pnid });
  ck("10.16 resultado incerto: nenhuma nova tentativa automática (409), Meta não chamada, token não gravado", r2.status === 409 && r2.j.code === "registration_uncertain" && registers(r2.meta).length === 0 && (await secrets()) === pre);
  await svc("select public.whatsapp_registration_resolve($1,'registered') j", [reg.id]);
  const r3 = await run(T2, { pnid: T2.pnid });
  ck("10.17 após conferência humana (resolve 'registered'): a conexão conclui SEM registrar de novo", r3.status === 200 && registers(r3.meta).length === 0 && (await conns(T2))[0]?.status === "active");
  const U2 = await mkCo("U2");
  const r5 = await run(U2, { pnid: U2.pnid, metaOpts: { register: () => ({ ok: false, kind: "http", status: 500 }) } });
  const r6 = await run(U2, { pnid: U2.pnid, metaOpts: { register: () => ({ ok: true }) } });
  ck("10.18 5xx também é incerto (não repete); resposta inesperada idem", r5.status === 502 && (await regOf(U2.pnid)).state === "uncertain" && r6.status === 409);
}
{
  const S = await mkCo("S1");
  const r = await run(S, { pnid: S.pnid, metaOpts: { subscribe: FAIL(400, "100") } });
  const reg = await regOf(S.pnid);
  const pinBefore = await pinOfReg(S.pnid);
  ck("10.19 falha DEPOIS do registro (assinatura): 502, mas o registro fica 'registered' com o PIN guardado", r.status === 502 && reg.state === "registered" && !!pinBefore && (await conns(S)).length === 0);
  const r2 = await run(S, { pnid: S.pnid });
  ck("10.20 a retentativa NÃO registra de novo (sem gastar cota) e conclui; PIN do Vault inalterado", r2.status === 200 && registers(r2.meta).length === 0 && (await pinOfReg(S.pnid)) === pinBefore && (await attemptsOf(S.pnid)).length === 1);
  const r3 = await run(S, { pnid: S.pnid, extra: { pin: "246810" } });
  PINS.add("246810");
  ck("10.21 reconexão com PIN enviado por engano: ignorado (nunca sobrescreve o PIN de um número registrado)", r3.status === 200 && registers(r3.meta).length === 0 && (await pinOfReg(S.pnid)) === pinBefore);
}
{
  const F2 = await mkCo("F2");
  let n = 0;
  const flaky = async (fn, args) => (fn === "whatsapp_registration_finish_attempt" ? { data: null, error: { message: "banco fora", code: "XX000" } } : realRpc(fn, args));
  const r = await run(F2, { pnid: F2.pnid, rpc: flaky });
  ck("10.22 Meta aceitou mas o resultado não pôde ser gravado: 503 registration_uncertain; registro 'in_progress' (não repete)", r.status === 503 && r.j.code === "registration_uncertain" && (await regOf(F2.pnid)).state === "in_progress" && registers(r.meta).length === 1);
  const r2 = await run(F2, { pnid: F2.pnid });
  ck("10.23 logo depois: 409 registration_in_progress sem nova chamada à Meta", r2.status === 409 && r2.j.code === "registration_in_progress" && registers(r2.meta).length === 0);
}
{
  const G2 = await mkCo("G2");
  const pre = (await su("select count(*) n from vault.secrets where starts_with(name,'wa_pin_')")).rows[0].n;
  const failing = async (fn, args) => (fn === "whatsapp_registration_store_pin" ? { data: null, error: { message: "vault indisponível", code: "XX000" } } : realRpc(fn, args));
  const r = await run(G2, { pnid: G2.pnid, rpc: failing });
  ck("10.24 falha ao guardar o PIN no Vault: 500 pin_store_failed, Meta NÃO chamada, nenhuma tentativa aberta, erro interno não vaza", r.status === 500 && r.j.code === "pin_store_failed" && registers(r.meta).length === 0 && (await attemptsOf(G2.pnid)).length === 0 && !/vault|XX000/.test(r.text)
    && (await su("select count(*) n from vault.secrets where starts_with(name,'wa_pin_')")).rows[0].n === pre);
}
{
  const X2 = await mkCo("X2");
  const reg0 = await run(X2, { pnid: X2.pnid, metaOpts: { register: FAIL(400, "131000") } });
  ck("10.25 falha definitiva da Meta (4xx qualquer): 502 meta_register_failed, estado failed, PIN mantido, 1 tentativa auditada com o código", reg0.status === 502 && reg0.j.code === "meta_register_failed" && (await regOf(X2.pnid)).state === "failed" && !!(await pinOfReg(X2.pnid)) && (await attemptsOf(X2.pnid))[0].meta_code === "131000");
  const keep = await pinOfReg(X2.pnid);
  const again = await run(X2, { pnid: X2.pnid });
  ck("10.26 tentativa seguinte: mesmo PIN, uma única chamada, conclui", again.status === 200 && registers(again.meta).length === 1 && registers(again.meta)[0].pin === keep);
  const Y2 = await mkCo("Y2");
  await run(Y2, { pnid: Y2.pnid, metaOpts: { register: FAIL(400, "131000") } });
  const rid2 = (await regOf(Y2.pnid)).id;
  await su("delete from whatsapp_registration_attempts where registration_id=$1", [rid2]);
  await su("insert into whatsapp_registration_attempts (registration_id, status, finished_at) select $1, 'failed', now() from generate_series(1,3)", [rid2]);
  const lim = await run(Y2, { pnid: Y2.pnid });
  ck("10.27 limite próprio de 3 tentativas em 72 h: 429 attempts_exhausted sem chamar a Meta", lim.status === 429 && lim.j.code === "attempts_exhausted" && registers(lim.meta).length === 0);
}
{
  const Z1 = await mkCo("Z1"), Z2 = await mkCo("Z2");
  await su("insert into whatsapp_number_registrations (company_id, phone_number_id, state) values ($1,$2,'pending')", [Z1.c, Z2.pnid]);
  const pre = await secrets();
  const r = await run(Z2, { pnid: Z2.pnid });
  ck("10.28 número com registro de OUTRA empresa (mesmo sem conexão): 409 phone_in_use; sem token no Vault, sem Meta de registro", r.status === 409 && r.j.code === "phone_in_use" && registers(r.meta).length === 0 && (await secrets()) === pre && (await regOf(Z2.pnid)).company_id === Z1.c);
}
{
  const K1 = await mkCo("K1"), K2 = await mkCo("K2");
  const shared = String(++pn + 1000);
  const [stK1, stK2] = [await begin(K1), await begin(K2)];
  const [ra, rb] = await Promise.all([run(K1, { state: stK1, pnid: shared, metaOpts: { phones: [{ id: shared, displayPhoneNumber: "+55 1", verifiedName: "A" }] } }), run(K2, { state: stK2, pnid: shared, metaOpts: { phones: [{ id: shared, displayPhoneNumber: "+55 1", verifiedName: "A" }] } })]);
  const sts = [ra.status, rb.status].sort();
  ck("10.29 concorrência (duas empresas, mesmo número): exatamente uma conclui (200) e a outra recebe 409; um registro e uma conexão", JSON.stringify(sts) === "[200,409]" && Number((await su("select count(*) n from whatsapp_number_registrations where phone_number_id=$1", [shared])).rows[0].n) === 1
    && Number((await su("select count(*) n from company_whatsapp_connections where phone_number_id=$1", [shared])).rows[0].n) === 1 && registers(ra.meta).length + registers(rb.meta).length === 1, JSON.stringify(sts));
  const K3 = await mkCo("K3");
  const sx = await begin(K3), sy = await begin(K3);
  const sn = String(++pn + 2000);
  const metaOpts = { phones: [{ id: sn, displayPhoneNumber: "+55 2", verifiedName: "B" }] };
  const [r1, r2] = await Promise.all([run(K3, { state: sx, pnid: sn, metaOpts }), run(K3, { state: sy, pnid: sn, metaOpts })]);
  ck("10.30 concorrência (mesma empresa, duas sessões, mesmo número): a Meta recebe no máximo UM registro, nenhum 5xx, uma conexão", registers(r1.meta).length + registers(r2.meta).length <= 1 && ![r1.status, r2.status].some((s) => s >= 500)
    && Number((await su("select count(*) n from company_whatsapp_connections where phone_number_id=$1", [sn])).rows[0].n) <= 1, JSON.stringify([r1.status, r2.status]));
  const pinNow = await pinOfReg(sn);
  const used = [...registers(r1.meta), ...registers(r2.meta)].map((c) => c.pin);
  ck("10.31 o PIN usado na Meta é exatamente o que ficou no Vault", used.length === 0 || used.every((p) => p === pinNow));
}
ck("10.32 cliente nunca recebe o PIN: nenhuma resposta da suíte contém um PIN usado", !PINS_TEXT_HIT(ALL_TEXT.join("\n")));
{
  const srcH = fs.readFileSync(path.join(root, "supabase/functions/whatsapp-signup-complete/handler.ts"), "utf8");
  const srcG = fs.readFileSync(path.join(root, "supabase/functions/_shared/whatsapp-signup-graph.ts"), "utf8");
  const srcI = fs.readFileSync(path.join(root, "supabase/functions/whatsapp-signup-complete/index.ts"), "utf8");
  ck("10.33 sem HMAC/derivePin/WHATSAPP_REGISTRATION_PIN_SECRET/Math.random em nenhum código da Edge", ![srcH, srcG, srcI].some((t) => /derivePin|HMAC|REGISTRATION_PIN_SECRET|pinSecret|Math\.random/.test(t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))));
  ck("10.34 PIN só entra em log por nenhuma chamada de console no handler/index", !/console\.(log|error|warn|info)\([^)]*\bpin\b/i.test(srcH));
}
{
  const draw = (vals) => { let i = 0; return SG.generatePin((b) => { b[0] = vals[Math.min(i++, vals.length - 1)]; }); };
  ck("10.35 generatePin: zeros à esquerda e limites (0→000000, 42→000042, 999999→999999, 1234567→234567)", draw([0]) === "000000" && draw([42]) === "000042" && draw([999999]) === "999999" && draw([1234567]) === "234567");
  ck("10.36 generatePin: amostragem por rejeição (valores ≥ 4.294.000.000 são descartados e o seguinte é usado)", draw([4294000000, 7]) === "000007" && draw([4294967295, 4294000001, 4293999999]) === String(4293999999 % 1_000_000).padStart(6, "0"));
  const pins = Array.from({ length: 60000 }, () => SG.generatePin());
  const first = new Array(10).fill(0); for (const p of pins) first[Number(p[0])]++;
  ck("10.37 generatePin: formato sempre 6 dígitos e primeiro dígito uniforme (±10%) com CSPRNG real", pins.every((p) => /^\d{6}$/.test(p)) && first.every((n) => Math.abs(n - 6000) < 600) && new Set(pins).size > 55000, JSON.stringify(first));
  ck("10.38 generatePin: RNG que só devolve valores rejeitados falha fechado (não devolve PIN fraco)", (() => { try { SG.generatePin((b) => { b[0] = 4294967295; }); return false; } catch { return true; } })());
  ck("10.39 classifyRegisterFailure: 133005/133016/133008/133009/4xx/5xx/timeout/rede/resposta inesperada", SG.classifyRegisterFailure({ kind: "http", status: 400, code: "133005" }) === "pin_incorrect" && SG.classifyRegisterFailure({ kind: "http", status: 400, code: "133016" }) === "rate_limited"
    && SG.classifyRegisterFailure({ kind: "http", status: 400, code: "133008" }) === "too_many_guesses" && SG.classifyRegisterFailure({ kind: "http", status: 400, code: "133009" }) === "too_many_guesses" && SG.classifyRegisterFailure({ kind: "http", status: 403 }) === "failed"
    && SG.classifyRegisterFailure({ kind: "http", status: 500 }) === "uncertain" && SG.classifyRegisterFailure({ kind: "timeout" }) === "uncertain" && SG.classifyRegisterFailure({ kind: "network" }) === "uncertain" && SG.classifyRegisterFailure({ kind: "invalid_response" }) === "uncertain");
}



console.log("\n== 11. Coexistence (app WhatsApp Business + Cloud API) — Etapa 2 ==");
const COEX = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
const coexStatus = { status: async () => ({ ok: true, isOnBizApp: true, platformType: "CLOUD_API" }) };
const regRows = async (co) => Number((await su("select count(*) n from whatsapp_number_registrations where company_id=$1", [co.c])).rows[0].n);
const pinSecrets = async () => Number((await su("select count(*) n from vault.secrets where starts_with(name, 'wa_pin_')")).rows[0].n);
{
  const K1 = await mkCo("K1");
  const pins0 = await pinSecrets();
  const r = await run(K1, { extra: { signup_event: COEX }, metaOpts: coexStatus });
  const c = await conns(K1);
  ck("11.1 Coexistence (id presente): 200, connection_type=coexistence, registered_at nulo, webhook assinado, token válido no Vault", r.status === 200 && r.j.ok === true && r.j.connection_type === "coexistence" && c.length === 1
    && c[0].connection_type === "coexistence" && c[0].registered_at === null && !!c[0].webhook_subscribed_at && c[0].token_status === "valid" && c[0].connection_source === "embedded_signup" && c[0].mode === "test" && c[0].status === "active", r.text);
  ck("11.2 NÃO chama /register nem gera PIN, nem cria registro de número (sequência: troca, lista, assinatura, conferência)", names(r.meta) === "exchange,list,subscribe,listSub" && (await regRows(K1)) === 0 && (await pinSecrets()) === pins0, names(r.meta));
  ck("11.3 o modo vem do Graph com o token do CLIENTE (getPhoneStatus chamado com o token trocado)", r.meta.statusCalls?.length === 1 && r.meta.statusCalls[0].token === TOKEN_OF(r.code) && r.meta.statusCalls[0].pnid === K1.pnid);
  ck("11.4 resposta sem PIN/token", !/pin/i.test(r.text) && !r.text.includes("EAAB-BIZ-TOKEN"));
}
{
  const K2 = await mkCo("K2");
  const r = await run(K2, { extra: { signup_event: COEX, phone_number_id: undefined }, metaOpts: coexStatus });
  const c = await conns(K2);
  ck("11.5 sem phone_number_id no evento: o número é descoberto pela WABA e conectado como coexistence", r.status === 200 && c.length === 1 && c[0].phone_number_id === K2.pnid && c[0].connection_type === "coexistence" && !names(r.meta).includes("register"), r.text);
}
{
  const K3 = await mkCo("K3");
  const other = String(++pn);
  const r = await run(K3, { extra: { signup_event: COEX, phone_number_id: undefined }, metaOpts: {
    phones: [{ id: other, displayPhoneNumber: "+55 11 91111-0000", verifiedName: "Outro" }, { id: K3.pnid, displayPhoneNumber: "+55 11 90000-1111", verifiedName: "Loja Teste" }],
    status: async (a) => ({ ok: true, isOnBizApp: a.phoneNumberId === K3.pnid, platformType: a.phoneNumberId === K3.pnid ? "CLOUD_API" : "NOT_APPLICABLE" }) } });
  const c = await conns(K3);
  ck("11.6 WABA com 2 números: escolhe o ÚNICO em Coexistence (o outro, só Cloud API, é ignorado)", r.status === 200 && c.length === 1 && c[0].phone_number_id === K3.pnid && c[0].connection_type === "coexistence", r.text);
}
{
  const K4 = await mkCo("K4");
  const o2 = String(++pn);
  const both = { phones: [{ id: K4.pnid, displayPhoneNumber: "1", verifiedName: "A" }, { id: o2, displayPhoneNumber: "2", verifiedName: "B" }], ...coexStatus };
  const s4 = await begin(K4);
  const r = await run(K4, { state: s4, extra: { signup_event: COEX, phone_number_id: undefined }, metaOpts: both });
  ck("11.7 dois números em Coexistence na WABA (ambíguo): 400 phone_not_resolved, nada gravado, sessão failed, sem assinatura", r.status === 400 && r.j.code === "phone_not_resolved" && (await conns(K4)).length === 0 && (await sessByState(s4)).status === "failed" && !names(r.meta).includes("subscribe"));
  const K5 = await mkCo("K5");
  const r5 = await run(K5, { extra: { signup_event: COEX, phone_number_id: undefined }, metaOpts: { status: async () => ({ ok: true, isOnBizApp: false, platformType: "NOT_APPLICABLE" }) } });
  ck("11.8 nenhum número em Coexistence na WABA: 400 phone_not_resolved e nada gravado", r5.status === 400 && r5.j.code === "phone_not_resolved" && (await conns(K5)).length === 0 && !names(r5.meta).includes("register"));
  const K6 = await mkCo("K6");
  const r6 = await run(K6, { extra: { signup_event: COEX, phone_number_id: undefined }, metaOpts: { phones: [], ...coexStatus } });
  ck("11.9 WABA sem números: 400 phone_not_resolved", r6.status === 400 && r6.j.code === "phone_not_resolved");
}
{
  const K7 = await mkCo("K7");
  const r = await run(K7, { extra: { phone_number_id: undefined } });
  ck("11.10 sem phone_number_id e SEM o evento de Coexistence: 400 (a sessão não é consumida)", r.status === 400 && (await sessByState(r.state)).status === "pending" && r.meta.calls.length === 0);
  const r2 = await run(K7, { state: r.state, extra: { signup_event: "FINISH_ONLY_WABA" } });
  ck("11.11 signup_event desconhecido: 400 e sessão intacta", r2.status === 400 && (await sessByState(r.state)).status === "pending");
}
{
  const K8 = await mkCo("K8");
  const s8 = await begin(K8);
  const r = await run(K8, { state: s8, extra: { signup_event: COEX }, metaOpts: { status: async () => ({ ok: true, isOnBizApp: false, platformType: "NOT_APPLICABLE" }) } });
  ck("11.12 navegador diz Coexistence mas o Graph diz que NÃO é: 409 mode_mismatch, sem /register, nada gravado, sessão failed", r.status === 409 && r.j.code === "mode_mismatch" && !names(r.meta).includes("register") && !names(r.meta).includes("subscribe") && (await conns(K8)).length === 0 && (await sessByState(s8)).status === "failed");
}
{
  const K9 = await mkCo("K9");
  const pins0 = await pinSecrets();
  const r = await run(K9, { extra: { signup_event: "FINISH" }, metaOpts: coexStatus });
  const c = await conns(K9);
  ck("11.13 navegador diz FINISH normal mas o Graph diz Coexistence: o Graph vence — sem /register, sem PIN, connection_type=coexistence", r.status === 200 && c[0].connection_type === "coexistence" && !names(r.meta).includes("register") && (await pinSecrets()) === pins0 && (await regRows(K9)) === 0, r.text);
  const K10 = await mkCo("K10");
  const r10 = await run(K10, { extra: { pin: "482917", signup_event: COEX }, metaOpts: coexStatus });
  ck("11.14 PIN enviado pelo cliente numa Coexistence é IGNORADO (nunca vai à Meta nem ao Vault)", r10.status === 200 && !names(r10.meta).includes("register") && (await pinSecrets()) === pins0 && !JSON.stringify(r10.meta.calls).includes("482917"));
}
{
  const bad = [
    ["11.15 Graph não responde (timeout) ao consultar o modo: 504 mode_check_failed, falha fechada (sem /register, nada gravado)", { status: async () => ({ ok: false, kind: "timeout" }) }, 504, "mode_check_failed"],
    ["11.16 Graph 4xx ao consultar o modo: 502 mode_check_failed", { status: async () => ({ ok: false, kind: "http", status: 400, code: "100" }) }, 502, "mode_check_failed"],
    ["11.17 campo is_on_biz_app ausente: modo indeterminado => 409 connection_mode_unknown (não registra por palpite)", { status: async () => ({ ok: true, isOnBizApp: null, platformType: "CLOUD_API" }) }, 409, "connection_mode_unknown"],
    ["11.18 is_on_biz_app=true com platform_type diferente de CLOUD_API: 409 connection_mode_unknown", { status: async () => ({ ok: true, isOnBizApp: true, platformType: "ON_PREMISE" }) }, 409, "connection_mode_unknown"],
  ];
  for (const [label, mo, st, code] of bad) {
    const K = await mkCo("KB"); const sb = await begin(K);
    const r = await run(K, { state: sb, metaOpts: mo });
    ck(label, r.status === st && r.j.code === code && !names(r.meta).includes("register") && !names(r.meta).includes("subscribe") && (await conns(K)).length === 0 && (await sessByState(sb)).status === "failed" && (await regRows(K)) === 0, r.text);
  }
}
{
  // isolamento e allowlist no ramo Coexistence
  const KA = await mkCo("KA"), KB2 = await mkCo("KB2");
  const rA = await run(KA, { extra: { signup_event: COEX }, metaOpts: coexStatus });
  const rB = await run(KB2, { pnid: KA.pnid, extra: { signup_event: COEX }, metaOpts: { phones: [{ id: KA.pnid, displayPhoneNumber: "x", verifiedName: "y" }], ...coexStatus } });
  ck("11.19 número em Coexistence já conectado à empresa A: empresa B recebe 409 phone_in_use e a conexão de A fica intacta", rA.status === 200 && rB.status === 409 && rB.j.code === "phone_in_use" && (await conns(KB2)).length === 0 && (await conns(KA))[0].connection_type === "coexistence");
  const KP = await mkCo("KP"); const sp = await begin(KP);
  await su("update whatsapp_signup_pilot_companies set authorized=false where company_id=$1", [KP.c]);
  const rp = await run(KP, { state: sp, extra: { signup_event: COEX }, metaOpts: coexStatus });
  ck("11.20 empresa fora da allowlist: 403 antes de qualquer chamada à Meta (inclui o Graph de modo)", rp.status === 403 && rp.meta.calls.length === 0 && !(rp.meta.statusCalls?.length) && (await conns(KP)).length === 0);
  const KR = await mkCo("KR"); const sr = await begin(KR);
  const rr = await run(KR, { state: sr, extra: { signup_event: COEX }, metaOpts: { ...coexStatus, subscribe: async () => { await su("update whatsapp_signup_pilot_companies set authorized=false where company_id=$1", [KR.c]); return { ok: true }; } } });
  ck("11.21 allowlist revogada no meio do caminho (Coexistence): a conexão NÃO é ativada", (await conns(KR)).every((x) => x.status !== "active"), rr.text);
}
{
  // idempotência / reconexão
  const KI = await mkCo("KI");
  const r1 = await run(KI, { extra: { signup_event: COEX }, metaOpts: coexStatus });
  const c1 = (await conns(KI))[0];
  const r2 = await run(KI, { extra: { signup_event: COEX }, metaOpts: coexStatus });
  const c2 = await conns(KI);
  ck("11.22 reconexão do mesmo número (Coexistence): mesma linha, token rotacionado, registered_at segue nulo, token antigo apagado do Vault", r1.status === 200 && r2.status === 200 && c2.length === 1 && c2[0].id === c1.id && c2[0].connection_type === "coexistence" && c2[0].registered_at === null
    && c2[0].token_secret_id !== c1.token_secret_id && Number((await su("select count(*) n from vault.secrets where id=$1", [c1.token_secret_id])).rows[0].n) === 0, r2.text);
  const r3 = await run(KI, { state: r1.state, extra: { signup_event: COEX }, metaOpts: coexStatus });
  ck("11.23 reutilizar o state já consumido: recusado (anti-replay) e nenhuma chamada à Meta", r3.status === 409 && r3.meta.calls.length === 0);
}
{
  // fluxo tradicional preservado
  const KT = await mkCo("KT");
  const r = await run(KT, { extra: { signup_event: "FINISH" } });
  const c = await conns(KT);
  ck("11.24 fluxo Cloud API tradicional preservado: connection_type=cloud_api, registered_at preenchido, /register chamado com PIN do Vault", r.status === 200 && r.j.connection_type === "cloud_api" && c[0].connection_type === "cloud_api" && !!c[0].registered_at && names(r.meta) === "exchange,list,register,subscribe,listSub" && (await regRows(KT)) === 1, r.text);
  const KT2 = await mkCo("KT2");
  const r2 = await run(KT2);
  ck("11.25 sem signup_event (cliente antigo) segue o fluxo Cloud API tradicional", r2.status === 200 && r2.j.connection_type === "cloud_api");
}
{
  // banco: regras da RPC (chamada direta do service_role)
  const KD = await mkCo("KD"); const sdb = await begin(KD);
  const base = { p_session_id: null, p_waba_id: "555000111222", p_phone_number_id: KD.pnid, p_display_phone_number: "x", p_business_name: "y", p_meta_business_id: null, p_registered_at: null, p_webhook_subscribed_at: new Date().toISOString() };
  const call = (o) => realRpc("whatsapp_signup_complete", { ...base, ...o });
  const sess = (await sessByState(sdb)).id;
  const bad1 = await call({ p_session_id: sess, p_connection_type: "coexistence", p_registered_at: new Date().toISOString() });
  const bad2 = await call({ p_session_id: sess, p_connection_type: "cloud_api", p_registered_at: null });
  const bad3 = await call({ p_session_id: sess, p_connection_type: "on_premise" });
  const bad4 = await call({ p_session_id: sess, p_connection_type: null });
  ck("11.26 RPC: coexistence com registered_at, cloud_api sem registered_at, tipo desconhecido ou nulo => erro PT400", [bad1, bad2, bad3, bad4].every((x) => x.error && x.error.code === "PT400"), JSON.stringify([bad1, bad2, bad3, bad4].map((x) => x.error)));
  const sig = "public.whatsapp_signup_complete(uuid,text,text,text,text,text,timestamptz,timestamptz,text)";
  const acl = (await su(`select has_function_privilege('authenticated','${sig}','execute') a, has_function_privilege('anon','${sig}','execute') b, has_function_privilege('service_role','${sig}','execute') c`)).rows[0];
  ck("11.27 ACL da RPC preservada: só service_role executa", acl.a === false && acl.b === false && acl.c === true);
  const cc = (await su("select pg_get_constraintdef(oid) d from pg_constraint where conname='company_whatsapp_connections_type_check'")).rows[0].d;
  ck("11.28 CHECK do banco aceita exatamente cloud_api e coexistence", /cloud_api/.test(cc) && /coexistence/.test(cc));
}
{
  // Graph client: URL, método, header e parsing de getPhoneStatus
  const seen = [];
  const meta = SG.createSignupMeta(async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ is_on_biz_app: true, platform_type: "CLOUD_API", id: "1" }) }; });
  const g = await meta.getPhoneStatus({ version: "v99.0", phoneNumberId: "123456789", token: "TOKEN-DE-TESTE-ABCDEFGHIJKL" });
  ck("11.29 getPhoneStatus: GET /{versão}/{phone}?fields=is_on_biz_app,platform_type com Bearer; parse correto", seen.length === 1 && seen[0].url === "https://graph.facebook.com/v99.0/123456789?fields=is_on_biz_app,platform_type" && seen[0].init.method === "GET"
    && seen[0].init.headers.Authorization === "Bearer TOKEN-DE-TESTE-ABCDEFGHIJKL" && g.ok && g.isOnBizApp === true && g.platformType === "CLOUD_API", JSON.stringify(seen[0]?.url));
  const odd = SG.createSignupMeta(async () => ({ ok: true, status: 200, text: async () => "não é json" }));
  const g2 = await odd.getPhoneStatus({ version: "v99.0", phoneNumberId: "123456789", token: "T" });
  const odd2 = SG.createSignupMeta(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ is_on_biz_app: "true" }) }));
  const g3 = await odd2.getPhoneStatus({ version: "v99.0", phoneNumberId: "123456789", token: "T" });
  ck("11.30 getPhoneStatus: corpo inválido => invalid_response; is_on_biz_app não booleano => null (indeterminado)", g2.ok === false && g2.kind === "invalid_response" && g3.ok === true && g3.isOnBizApp === null);
  ck("11.31 decideConnectionMode: true+CLOUD_API=coexistence; false=cloud_api; ausente/true+outra plataforma=null", SG.decideConnectionMode({ isOnBizApp: true, platformType: "CLOUD_API" }) === "coexistence" && SG.decideConnectionMode({ isOnBizApp: false, platformType: null }) === "cloud_api"
    && SG.decideConnectionMode({ isOnBizApp: null, platformType: "CLOUD_API" }) === null && SG.decideConnectionMode({ isOnBizApp: true, platformType: "ON_PREMISE" }) === null && SG.decideConnectionMode({ isOnBizApp: true, platformType: null }) === null);
}


console.log("\n== 12. Etapa 4: /register só com evidência EXPLÍCITA de Cloud API convencional ==");
{
  const absent = (pt) => ({ status: async () => ({ ok: true, isOnBizApp: null, platformType: pt }) });
  const attemptsCount = async (co) => Number((await su("select count(*) n from whatsapp_registration_attempts a join whatsapp_number_registrations r on r.id=a.registration_id where r.company_id=$1", [co.c])).rows[0].n);
  const noReg = (r, K) => !names(r.meta).includes("register") && !names(r.meta).includes("subscribe");
  // 12.1-12.4: campo ausente NUNCA vira Cloud API (nem com a dica FINISH): interrompe com erro claro e nada é registrado
  for (const [label, extra, pt] of [
    ["12.1 campo ausente + dica FINISH + NOT_APPLICABLE", { signup_event: "FINISH" }, "NOT_APPLICABLE"],
    ["12.2 campo ausente + dica de Coexistence", { signup_event: COEX }, "CLOUD_API"],
    ["12.3 campo ausente + FINISH + ON_PREMISE", { signup_event: "FINISH" }, "ON_PREMISE"],
    ["12.4 campo ausente SEM dica (cliente antigo)", {}, "NOT_APPLICABLE"],
  ]) {
    const K = await mkCo("I9"); const sx = await begin(K);
    const r = await run(K, { state: sx, extra, metaOpts: absent(pt) });
    ck(label + ": falha fechada 409 connection_mode_unknown, SEM /register, sem PIN, sem tentativa, nada gravado e mensagem clara", r.status === 409 && r.j.code === "connection_mode_unknown" && /interrompida/.test(r.j.error) && noReg(r, K)
      && (await conns(K)).length === 0 && (await regRows(K)) === 0 && (await attemptsCount(K)) === 0 && (await sessByState(sx)).status === "failed", r.text);
  }
  {
    const K = await mkCo("I9e");
    const r = await run(K, { extra: { signup_event: "FINISH" }, metaOpts: { status: async () => ({ ok: true, isOnBizApp: true, platformType: "CLOUD_API" }) } });
    ck("12.5 resposta EXPLÍCITA true+CLOUD_API com dica FINISH => coexistence, sem /register (a Meta decide, não o navegador)", r.status === 200 && (await conns(K))[0].connection_type === "coexistence" && !names(r.meta).includes("register"));
  }
  {
    // rechecagem imediatamente antes do /register: 1ª consulta (modo) = false, 2ª (guarda) = true => NÃO registra
    let calls = 0;
    const K = await mkCo("G1"); const sx = await begin(K);
    const r = await run(K, { state: sx, extra: { signup_event: "FINISH" }, metaOpts: { status: async () => ({ ok: true, isOnBizApp: ++calls === 1 ? false : true, platformType: "CLOUD_API" }) } });
    ck("12.6 o número virou Coexistence entre a decisão e o registro (rechecagem): 409 register_blocked_not_cloud_api, SEM /register e SEM gastar tentativa", r.status === 409 && r.j.code === "register_blocked_not_cloud_api" && !names(r.meta).includes("register") && !names(r.meta).includes("subscribe")
      && calls === 2 && (await attemptsCount(K)) === 0 && (await conns(K)).length === 0 && (await sessByState(sx)).status === "failed", r.text);
    let c2 = 0;
    const K2 = await mkCo("G2"); const s2 = await begin(K2);
    const r2 = await run(K2, { state: s2, extra: { signup_event: "FINISH" }, metaOpts: { status: async () => (++c2 === 1 ? { ok: true, isOnBizApp: false, platformType: "NOT_APPLICABLE" } : { ok: true, isOnBizApp: null, platformType: null }) } });
    ck("12.7 rechecagem sem o campo (ambígua): bloqueia o registro", r2.status === 409 && r2.j.code === "register_blocked_not_cloud_api" && !names(r2.meta).includes("register") && (await attemptsCount(K2)) === 0);
    let c3 = 0;
    const K3 = await mkCo("G3"); const s3 = await begin(K3);
    const r3 = await run(K3, { state: s3, extra: { signup_event: "FINISH" }, metaOpts: { status: async () => (++c3 === 1 ? { ok: true, isOnBizApp: false, platformType: "NOT_APPLICABLE" } : { ok: false, kind: "timeout" }) } });
    ck("12.8 rechecagem indisponível (timeout): bloqueia (504 register_guard_unavailable), nada registrado, nenhuma tentativa contada", r3.status === 504 && r3.j.code === "register_guard_unavailable" && !names(r3.meta).includes("register") && (await attemptsCount(K3)) === 0);
  }
  {
    // caminho feliz do fluxo convencional: 2 consultas explícitas (false), registra UMA vez com PIN do Vault
    const K = await mkCo("G4");
    const r = await run(K, { extra: { signup_event: "FINISH" } });
    ck("12.9 Cloud API convencional (false explícito nas duas consultas): registra normalmente (regressão do fluxo existente)", r.status === 200 && r.j.connection_type === "cloud_api" && names(r.meta) === "exchange,list,register,subscribe,listSub" && r.meta.statusCalls.length === 2 && (await regRows(K)) === 1);
    const K2 = await mkCo("G5"); const s5 = await begin(K2);
    const r1 = await run(K2, { state: s5, extra: { signup_event: "FINISH" } });
    const sx2 = await begin(K2);
    const r2 = await run(K2, { state: sx2, extra: { signup_event: "FINISH" } });
    ck("12.10 reconexão de número JÁ registrado por nós: não registra de novo (action skip) e, sem /register, não precisa da rechecagem", r1.status === 200 && r2.status === 200 && !names(r2.meta).includes("register") && r2.meta.statusCalls.length === 1);
  }
  {
    // Coexistence nunca passa pela guarda (não há /register)
    const K = await mkCo("G6");
    const r = await run(K, { extra: { signup_event: COEX }, metaOpts: coexStatus });
    ck("12.11 Coexistence: sem /register e sem rechecagem de registro (uma só consulta de modo)", r.status === 200 && !names(r.meta).includes("register") && r.meta.statusCalls.length === 1);
  }
  ck("12.12 o código não infere mais Cloud API por campo ausente (a função de inferência foi REMOVIDA)", typeof SG.decideConnectionModeWithHint === "undefined" && SG.decideConnectionMode({ isOnBizApp: null, platformType: "NOT_APPLICABLE" }) === null);
}

console.log("\n== 9. vazamento e estado final ==");
{
  const all = logs.join("");
  ck("9.1 nenhum log da suíte inteira contém code, token de negócio, App Secret nem PIN", !all.includes("AQD-AUTH-CODE") && !all.includes("EAAB-BIZ-TOKEN") && !all.includes(APP_SECRET) && !PINS_TEXT_HIT(all));
  const leaks = (await su(`select (select count(*) from whatsapp_signup_sessions s where s::text like '%EAAB-BIZ-TOKEN%' or s::text like '%AQD-AUTH%')
    + (select count(*) from company_whatsapp_connections c where c::text like '%EAAB-BIZ-TOKEN%')
    + (select count(*) from whatsapp_webhook_events e where e::text like '%EAAB-BIZ-TOKEN%') n`)).rows[0].n;
  ck("9.2 token e code não aparecem em sessões, conexões nem eventos (só no Vault)", Number(leaks) === 0);
  const left = Number((await su("select count(*) n from whatsapp_signup_sessions s where s.status = 'failed' and s.token_secret_id is not null and not public.whatsapp_signup_external_op_open(s.id)")).rows[0].n);
  ck("9.3 nenhuma sessão failed guarda referência de segredo (exceto token preservado por registro incerto/em curso)", left === 0);
  const orphans = Number((await su(`select count(*) n from vault.secrets v where v.name like 'wa_token_signup_%' and not exists (select 1 from company_whatsapp_connections c where c.token_secret_id = v.id)
     and not exists (select 1 from whatsapp_signup_sessions s where s.token_secret_id = v.id and (s.status = 'reserved' or public.whatsapp_signup_external_op_open(s.id)))`)).rows[0].n);
  ck("9.4 nenhum segredo de signup órfão no Vault ao final", orphans === 0, orphans);
}
fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP SIGNUP COMPLETE (EDGE)");
