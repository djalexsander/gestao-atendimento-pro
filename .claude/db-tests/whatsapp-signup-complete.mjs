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

const { pg, ck, as, su: su0, summary } = await loadAll(undefined, { legacyIaMirror: false });
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
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
const APP_ID = "1234567890", APP_SECRET = "APP-SECRET-DE-TESTE-NAO-REAL-9999", PIN_SECRET = "PIN-SECRET-DE-TESTE-1234567890", VERSION = "v99.0";
await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id=$1, embedded_signup_config_id='9876543210'", [APP_ID]);

// ---------------------------------------------------------------- fixtures
let seq = 700, pn = 920000000;
async function mkCo(tag, { wa = true } = {}) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "sc-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
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
const secrets = async () => Number((await su("select count(*) n from vault.secrets")).rows[0].n);
const conns = async (co) => (await su("select * from company_whatsapp_connections where company_id=$1 order by created_at", [co.c])).rows;
const sessOf = async (co) => (await su("select * from whatsapp_signup_sessions where company_id=$1 order by created_at desc limit 1", [co.c])).rows[0];
const sessByState = async (state) => (await su("select * from whatsapp_signup_sessions where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [state])).rows[0];
const begin = async (co, role = "owner") => (await su("delete from whatsapp_signup_sessions where company_id=$1 and status in ('completed','failed','expired','cancelled')", [co.c]), await co[role]("select public.whatsapp_signup_begin($1) j", [co.c])).rows[0].j.state;

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
    async registerPhone(a) { rec("register", { pin: a.pin, pnid: a.phoneNumberId }); return o.register ? o.register(a) : { ok: true }; },
    async subscribeApp(a) { rec("subscribe", { waba: a.wabaId }); return o.subscribe ? o.subscribe(a) : { ok: true }; },
    async listSubscribedAppIds(a) { rec("listSub"); return o.listSub ? o.listSub(a) : { ok: true, appIds: ["111", APP_ID] }; },
  };
}
const NAMED = { whatsapp_signup_reserve: ["p_state"], whatsapp_signup_store_token: ["p_session_id", "p_token", "p_expires_at"], whatsapp_signup_fail: ["p_session_id", "p_error_code"],
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
    meta, graphVersion: "graphVersion" in o ? o.graphVersion : VERSION, appSecret: "appSecret" in o ? o.appSecret : APP_SECRET, pinSecret: "pinSecret" in o ? o.pinSecret : PIN_SECRET,
    ...(o.deps ?? {}),
  };
  const res = await capture(() => H.handleWhatsappSignupComplete(req, deps));
  const text = await res.text();
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
ck("1.8 sem versão da Graph/ App Secret / secret do PIN (ou curto): 503 e sessão intacta", await cfg({ graphVersion: undefined }) && await cfg({ graphVersion: "99" }) && await cfg({ appSecret: undefined }) && await cfg({ pinSecret: undefined }) && await cfg({ pinSecret: "curto" }));
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
  && r4.j.display_phone_number === "+55 11 90000-1111" && r4.j.business_name === "Loja Teste" && Object.keys(r4.j).sort().join() === "business_name,display_phone_number,idempotent,mode,ok,status");
ck("4.2 ordem das chamadas à Meta: troca → lista da WABA → registro → assinatura → conferência", names(r4.meta) === "exchange,list,register,subscribe,listSub", names(r4.meta));
const cD = await conns(D);
ck("4.3 conexão ÚNICA da empresa da sessão (company_id do corpo ignorado), active, test, embedded_signup, token valid", cD.length === 1 && cD[0].status === "active" && cD[0].mode === "test" && cD[0].connection_source === "embedded_signup"
  && cD[0].token_status === "valid" && cD[0].waba_id === "555000111222" && cD[0].phone_number_id === D.pnid && !!cD[0].registered_at && !!cD[0].webhook_subscribed_at && (await conns(A)).every((c) => c.waba_id !== "555000111222" || c.company_id === A.c));
ck("4.4 token gravado no Vault e ligado à conexão; sessão completed", (await su("select secret from vault.secrets where id=$1", [cD[0].token_secret_id])).rows[0].secret === TOKEN_OF(r4.code) && (await sessByState(sD)).status === "completed");
const exch = r4.meta.calls[0], reg = r4.meta.calls[2];
ck("4.5 troca usa o App ID do banco + App Secret do ambiente e o code recebido", exch.appId === APP_ID && exch.appSecret === APP_SECRET && exch.code === r4.code);
ck("4.6 PIN do registro: 6 dígitos, derivado e estável para o número", /^\d{6}$/.test(reg.pin) && reg.pin === await SG.derivePin(PIN_SECRET, D.pnid) && reg.pin !== await SG.derivePin(PIN_SECRET, B.pnid) && reg.pin !== await SG.derivePin(PIN_SECRET + "x", D.pnid) && reg.pnid === D.pnid);
ck("4.7 a Meta recebeu o token do cliente nas chamadas seguintes", r4.meta.calls[1].token === TOKEN_OF(r4.code));
{
  const all = r4.text + logs.join("");
  ck("4.8 resposta e logs NÃO contêm code, token, App Secret nem secret do PIN", ![r4.code, TOKEN_OF(r4.code), APP_SECRET, PIN_SECRET, sD].some((s) => all.includes(s)));
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
await failCase("5.12 falha no registro do número: 502, token removido do Vault, sem conexão", "F12", { register: () => ({ ok: false, kind: "http", status: 400, code: "133005" }) }, 502, "meta_register_failed", "exchange,list,register");
await failCase("5.13 falha ao assinar o webhook: 502, token removido, sem conexão", "F13", { subscribe: () => ({ ok: false, kind: "http", status: 400, code: "100" }) }, 502, "meta_subscribe_failed", "exchange,list,register,subscribe");
await failCase("5.14 assinatura não confirmada (nosso app fora da lista): 502, token removido", "F14", { listSub: () => ({ ok: true, appIds: ["111"] }) }, 502, "meta_subscribe_unverified", "exchange,list,register,subscribe,listSub");
await failCase("5.15 conferência da assinatura com erro: 502/504, token removido", "F15", { listSub: () => ({ ok: false, kind: "timeout" }) }, 504, "meta_subscribe_unverified", "exchange,list,register,subscribe,listSub");
{
  const all = logs.join("");
  ck("5.16 nenhum log de falha contém code, token ou secrets", !all.includes(CODE) && !/EAAB-BIZ-TOKEN/.test(all) && !all.includes(APP_SECRET) && !all.includes(PIN_SECRET));
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
  ck("8.13 derivePin: determinístico, 6 dígitos, distinto por número e por secret", await (async () => { const a = await SG.derivePin("segredo-de-teste-1234567", "111"); return a === await SG.derivePin("segredo-de-teste-1234567", "111") && /^\d{6}$/.test(a) && a !== await SG.derivePin("segredo-de-teste-1234567", "112") && a !== await SG.derivePin("outro-segredo-de-teste-123", "111"); })());
  ck("8.14 isValidGraphVersion reutilizada: v99.0 sim; 99, vazio e injeção não", G.isValidGraphVersion("v99.0") && !G.isValidGraphVersion("99") && !G.isValidGraphVersion("v1/../x") && !G.isValidGraphVersion(undefined));
}

console.log("\n== 9. vazamento e estado final ==");
{
  const all = logs.join("");
  ck("9.1 nenhum log da suíte inteira contém code, token de negócio, App Secret ou secret do PIN", !all.includes("AQD-AUTH-CODE") && !all.includes("EAAB-BIZ-TOKEN") && !all.includes(APP_SECRET) && !all.includes(PIN_SECRET));
  const leaks = (await su(`select (select count(*) from whatsapp_signup_sessions s where s::text like '%EAAB-BIZ-TOKEN%' or s::text like '%AQD-AUTH%')
    + (select count(*) from company_whatsapp_connections c where c::text like '%EAAB-BIZ-TOKEN%')
    + (select count(*) from whatsapp_webhook_events e where e::text like '%EAAB-BIZ-TOKEN%') n`)).rows[0].n;
  ck("9.2 token e code não aparecem em sessões, conexões nem eventos (só no Vault)", Number(leaks) === 0);
  const left = Number((await su("select count(*) n from whatsapp_signup_sessions s where s.status = 'failed' and s.token_secret_id is not null")).rows[0].n);
  ck("9.3 nenhuma sessão failed guarda referência de segredo", left === 0);
  const orphans = Number((await su(`select count(*) n from vault.secrets v where v.name like 'wa_token_signup_%' and not exists (select 1 from company_whatsapp_connections c where c.token_secret_id = v.id)
     and not exists (select 1 from whatsapp_signup_sessions s where s.token_secret_id = v.id and s.status = 'reserved')`)).rows[0].n);
  ck("9.4 nenhum segredo de signup órfão no Vault ao final", orphans === 0, orphans);
}
fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP SIGNUP COMPLETE (EDGE)");
