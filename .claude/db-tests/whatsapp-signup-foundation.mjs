// Embedded Signup v4 — ETAPA 1 (20261104010000): colunas novas, sessões (hash/expiração/anti-replay), RPCs de conclusão,
// conflito de número, reconexão, isolamento, ACL, compatibilidade e rollback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAll } from "./full-db.mjs";

const MIG = "D:/orça facil/supabase/migrations";
const NEW = "20261104010000_whatsapp_embedded_signup_foundation.sql";

// baseline: o mesmo banco SEM a migration nova, para provar que a mudança é aditiva
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig-nosignup-"));
for (const f of fs.readdirSync(MIG)) if (f.endsWith(".sql") && f < NEW) fs.copyFileSync(path.join(MIG, f), path.join(tmp, f));
const inv = `
  select 'col:'||table_name||'.'||column_name k from information_schema.columns where table_schema='public'
  union all select 'idx:'||indexname from pg_indexes where schemaname='public'
  union all select 'con:'||conrelid::regclass::text||':'||conname from pg_constraint where connamespace='public'::regnamespace
  union all select 'pol:'||tablename||':'||policyname from pg_policies where schemaname='public'
  union all select 'fn:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p where pronamespace='public'::regnamespace
  union all select 'trg:'||tgrelid::regclass::text||':'||tgname from pg_trigger where not tgisinternal`;
let BL;
const baseline = await (async () => {
  const b = await loadAll(tmp, { legacyIaMirror: false });
  BL = b;
  const rows = (await b.pg.query(inv)).rows.map((r) => r.k);
  return new Set(rows);
})();

const { pg, ck, as, su: su0, errHas, summary } = await loadAll(undefined, { legacyIaMirror: false });
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const anon = (sql, params) => as("anon", null, sql, params);
const svc = (sql, params) => as("service_role", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Vault de teste: secrets + view decrypted_secrets + create_secret (o Supabase real tem os três)
await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
  declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id into v; return v; end $f$;
`);
const secretOf = async (sid) => (await su("select secret from vault.secrets where id=$1", [sid])).rows[0]?.secret ?? null;
const secretCount = async () => Number((await su("select count(*) n from vault.secrets")).rows[0].n);
await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id='1234567890', embedded_signup_config_id='9876543210'");

const TOKEN = "EAAB-TOKEN-SECRETO-DE-TESTE-0001";
let seq = 100, pn = 810000000;
async function mkCo(tag, { wa = true } = {}) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "sg-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1, true, now())", [c]);
  const out = { c, ids: {} };
  for (const role of ["owner", "admin", "attendant", "cashier"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u); out.ids[role] = u;
  }
  if (wa) await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste signup', now() + interval '1 day')", [c]);
  return out;
}
const mkConn = async (co, { status = "active", mode = "live", tokenValue = "TOKEN-ANTIGO-" + (seq + 1) } = {}) => {
  const pnid = String(++pn);
  const sid = (await su("insert into vault.secrets (name, secret) values ($1,$2) returning id", ["wa_token_" + pnid, tokenValue])).rows[0].id;
  const cid = (await su("insert into company_whatsapp_connections (company_id,status,mode,phone_number_id,waba_id,display_phone_number,token_secret_id,webhook_status) values ($1,$2,$3,$4,'555000111','+55 44 90000-0000',$5,'active') returning id", [co.c, status, mode, pnid, sid])).rows[0].id;
  return { pnid, sid, cid };
};
const begin = async (co, role = "owner") => (await co[role]("select public.whatsapp_signup_begin($1) j", [co.c]));
const startSession = async (co, role = "owner") => { const r = await begin(co, role); return r.rows[0].j.state; };
const reserve = async (state) => (await svc("select public.whatsapp_signup_reserve($1) j", [state])).rows?.[0]?.j;
const store = async (sid, tok = TOKEN, exp = null) => (await svc("select public.whatsapp_signup_store_token($1,$2,$3) j", [sid, tok, exp])).rows?.[0]?.j;
const complete = (sid, o = {}) => svc(
  "select public.whatsapp_signup_complete($1,$2,$3,$4,$5,$6,$7,$8,$9) j",
  [sid, o.waba ?? "123456789", o.pnid ?? "777000111", o.display ?? "+55 44 99999-0000", o.name ?? "Empresa X", o.biz ?? "444555666",
    "registered_at" in o ? o.registered_at : new Date().toISOString(), "subscribed_at" in o ? o.subscribed_at : new Date().toISOString(), o.type ?? "cloud_api"]);
// fluxo feliz até a reserva (+ token); devolve ids
async function ready(co, { token = true, role = "owner" } = {}) {
  const state = await startSession(co, role);
  const r = await reserve(state);
  if (token && r.ok) await store(r.session_id, TOKEN + ":" + r.session_id);
  return { state, sid: r.session_id, r };
}
const sess = async (sid) => (await su("select * from whatsapp_signup_sessions where id=$1", [sid])).rows[0];

const A = await mkCo("A");
const B = await mkCo("B");
const NOWA = await mkCo("N", { wa: false });
const OTHER = await mkCo("O");

console.log("\n== 1. aditiva: nada existente foi removido ==");
const after = new Set((await pg.query(inv)).rows.map((r) => r.k));
const missing = [...baseline].filter((k) => !after.has(k));
ck("1.1 todo objeto pré-existente (colunas, índices, constraints, políticas, funções, triggers) continua", missing.length === 0, missing.join(", "));
const added = [...after].filter((k) => !baseline.has(k));
ck("1.2 o que foi criado é só da migration nova (nada inesperado)", added.every((k) => /signup|registration|pin_reveal|pilot|token_alert|token_health|token_effective|report_token|report_send|master_whatsapp|connection_alert|connection_set_health|connections|connection_(source|type)|meta_business|token_|registered_at|webhook_subscribed|last_error/.test(k)), added.join(", "));

console.log("\n== 2. conexões antigas: defaults seguros ==");
const old = await mkConn(A, { mode: "live" });
const oc = (await su("select * from company_whatsapp_connections where id=$1", [old.cid])).rows[0];
ck("2.1 antiga: manual/cloud_api/unknown, demais campos nulos", oc.connection_source === "manual" && oc.connection_type === "cloud_api" && oc.token_status === "unknown"
  && oc.meta_business_id === null && oc.token_expires_at === null && oc.registered_at === null && oc.webhook_subscribed_at === null && oc.last_error_code === null, JSON.stringify(oc));
ck("2.2 status/modo/token/ids originais intactos", oc.status === "active" && oc.mode === "live" && oc.phone_number_id === old.pnid && oc.token_secret_id === old.sid && oc.waba_id === "555000111");
ck("2.3 CHECK rejeita source/type/token_status/meta_business/error_code inválidos", [
  "connection_source='x'", "connection_type='x'", "token_status='x'", "meta_business_id='abc'", "last_error_code='com espaco'",
].every((set) => true) && (await Promise.all(["connection_source='x'", "connection_type='x'", "token_status='x'", "meta_business_id='abc'", "last_error_code='com espaco'"]
  .map((set) => su(`update company_whatsapp_connections set ${set} where id='${old.cid}'`)))).every((r) => !r.ok && r.code === "23514"));
ck("2.4 índice de uma conexão ativa por empresa continua valendo", !(await su("insert into company_whatsapp_connections (company_id,status,phone_number_id) values ($1,'active','999111222')", [A.c])).ok);
ck("2.5 phone_number_id continua único globalmente", !(await su("insert into company_whatsapp_connections (company_id,status,phone_number_id) values ($1,'disconnected',$2)", [B.c, old.pnid])).ok);
const ing = await svc("select public.whatsapp_ingest_message($1,'wamid.sg.1','5544999990001','Maria','text','oi',now(),'msg:sg:1') j", [old.pnid]);
ck("2.6 webhook/ingestão da conexão antiga segue funcionando", ing.ok && ing.rows[0].j.result === "stored", JSON.stringify(ing));
const sum = await A.owner("select public.whatsapp_get_connection_summary($1) j", [A.c]);
ck("2.7 resumo da conexão inalterado (sem token nem ref)", sum.ok && sum.rows[0].j.status === "active" && !JSON.stringify(sum.rows[0].j).match(/token|secret|waba/i), JSON.stringify(sum));

console.log("\n== 3. criar sessão (whatsapp_signup_begin) ==");
const b1 = await begin(A);
const st1 = b1.rows?.[0]?.j;
ck("3.1 owner cria; state de 64 hex; devolve app_id/config_id/expires_at", b1.ok && /^[0-9a-f]{64}$/.test(st1.state) && st1.meta_app_id === "1234567890" && st1.config_id === "9876543210" && !!st1.expires_at, JSON.stringify(b1));
const row1 = (await su("select * from whatsapp_signup_sessions where company_id=$1 order by created_at desc limit 1", [A.c])).rows[0];
ck("3.2 só o HASH é gravado (state em claro não aparece na linha)", row1.state_hash.length === 64 && row1.state_hash !== st1.state && !JSON.stringify(row1).includes(st1.state));
ck("3.3 sessão vinculada à empresa e ao usuário; pending; TTL = 10 min", row1.company_id === A.c && row1.user_id === A.ids.owner && row1.status === "pending"
  && Math.abs((new Date(row1.expires_at) - new Date(row1.created_at)) / 60000 - 10) < 0.5);
ck("3.4 admin também cria", (await begin(A, "admin")).ok);
ck("3.5 attendant e cashier: PT403", errHas(await begin(A, "attendant"), /permiss|proprietário/i, "PT403") && errHas(await begin(A, "cashier"), /proprietário/i, "PT403"));
ck("3.6 usuário de OUTRA empresa: PT404", errHas(await B.owner("select public.whatsapp_signup_begin($1) j", [A.c]), /não encontrada/i, "PT404"));
ck("3.7 sem módulo whatsapp: PT403", errHas(await begin(NOWA), /não está contratado/i, "PT403"));
ck("3.8 anon negado", !(await anon("select public.whatsapp_signup_begin($1) j", [A.c])).ok);
ck("3.9 service_role não executa begin", !(await svc("select public.whatsapp_signup_begin($1) j", [A.c])).ok);
const pend = Number((await su("select count(*) n from whatsapp_signup_sessions where company_id=$1 and status='pending'", [A.c])).rows[0].n);
ck("3.10 sessão nova cancela a pendente anterior (só 1 pending por empresa)", pend === 1);
await su("update whatsapp_platform_settings set embedded_signup_enabled=false");
ck("3.11 plataforma desligada: PT409 e nada criado", errHas(await begin(B), /aprovação da Meta/i, "PT409") && Number((await su("select count(*) n from whatsapp_signup_sessions where company_id=$1", [B.c])).rows[0].n) === 0);
await su("update whatsapp_platform_settings set embedded_signup_enabled=true");
for (let i = 0; i < 12; i++) await begin(B);
ck("3.12 limite de 10 sessões/hora por empresa: PT429", errHas(await begin(B), /Muitas tentativas/i, "PT429"));
const attempts = Number((await su("select count(*) n from whatsapp_signup_attempts")).rows[0].n);
ck("3.13 tabela antiga whatsapp_signup_attempts intacta e sem uso", attempts === 0);
ck("3.14 tabela de sessões inacessível ao cliente (RLS/ACL)", !(await A.owner("select * from whatsapp_signup_sessions")).ok && !(await anon("select * from whatsapp_signup_sessions")).ok);
ck("3.15 constraints: hash inválido e TTL > 30 min rejeitados", !(await su("insert into whatsapp_signup_sessions (company_id,user_id,state_hash) values ($1,$2,'abc')", [A.c, A.ids.owner])).ok
  && !(await su("insert into whatsapp_signup_sessions (company_id,user_id,state_hash,expires_at) values ($1,$2,repeat('a',64), now() + interval '2 hours')", [A.c, A.ids.owner])).ok);

console.log("\n== 4. reservar/consumir (anti-replay) ==");
const C1 = await mkCo("C1");
const s4 = await startSession(C1);
const r1 = await reserve(s4);
ck("4.1 primeira reserva ok (devolve sessão/empresa/usuário)", r1.ok && r1.company_id === C1.c && r1.user_id === C1.ids.owner, JSON.stringify(r1));
ck("4.2 segunda reserva do MESMO state: already_used", (await reserve(s4)).error === "already_used");
ck("4.3 state inexistente / curto / nulo: invalid_state", (await reserve("a".repeat(64))).error === "invalid_state" && (await reserve("curto")).error === "invalid_state"
  && (await svc("select public.whatsapp_signup_reserve(null) j")).rows[0].j.error === "invalid_state");
const s4b = await startSession(C1);
await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [s4b]);
ck("4.4 sessão expirada: expired (e marcada expired)", (await reserve(s4b)).error === "expired");
const hashRow = (await su("select status from whatsapp_signup_sessions where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [s4b])).rows[0];
ck("4.5 status gravado como expired", hashRow.status === "expired");
const s4c = await startSession(C1); // cancela pendentes anteriores
const s4d = await startSession(C1);
ck("4.6 state de sessão cancelada (substituída): cancelled", (await reserve(s4c)).error === "cancelled");
ck("4.7 reserva é negada ao cliente e ao anon", !(await C1.owner("select public.whatsapp_signup_reserve($1) j", [s4d])).ok && !(await anon("select public.whatsapp_signup_reserve($1) j", [s4d])).ok);
const C2 = await mkCo("C2");
const s4e = await startSession(C2, "admin");
await su("update company_users set status='inactive' where company_id=$1 and user_id=$2", [C2.c, C2.ids.admin]);
ck("4.8 usuário desativado antes do consumo: unauthorized (sessão failed)", (await reserve(s4e)).error === "unauthorized");
const C3 = await mkCo("C3");
const s4f = await startSession(C3, "admin");
await su("update company_users set role='attendant' where company_id=$1 and user_id=$2", [C3.c, C3.ids.admin]);
ck("4.9 rebaixado a attendant antes do consumo: unauthorized", (await reserve(s4f)).error === "unauthorized");
const C4 = await mkCo("C4");
const s4g = await startSession(C4);
await su("delete from company_module_overrides where company_id=$1", [C4.c]);
ck("4.10 módulo whatsapp perdido antes do consumo: unauthorized", (await reserve(s4g)).error === "unauthorized");

console.log("\n== 5. token no Vault ==");
const D = await mkCo("D");
const sD = await startSession(D);
const rD = await reserve(sD);
ck("5.1 antes de reservar nada de token; store em sessão não reservada falha", (await store("00000000-0000-4000-8000-0000000000ff")).error === "session_not_found");
const before = await secretCount();
const tk = await store(rD.session_id, TOKEN, new Date(Date.now() + 3600e3).toISOString());
ck("5.2 store devolve só {ok:true}: nem token nem referência saem do banco", tk.ok === true && Object.keys(tk).length === 1, JSON.stringify(tk));
const tokRefD = (await sess(rD.session_id)).token_secret_id;
ck("5.3 segredo gravado no Vault; sessão guarda a referência e a validade", (await secretCount()) === before + 1 && (await secretOf(tokRefD)) === TOKEN
  && !!tokRefD && !!(await sess(rD.session_id)).token_expires_at);
const leak = (await su(`select (select count(*) from whatsapp_signup_sessions s where s::text like '%${TOKEN}%')
  + (select count(*) from company_whatsapp_connections c where c::text like '%${TOKEN}%')
  + (select count(*) from whatsapp_webhook_events e where e::text like '%${TOKEN}%') n`)).rows[0].n;
ck("5.4 token em claro NÃO aparece em sessões/conexões/eventos", Number(leak) === 0);
ck("5.5 segundo store: token_already_stored (sem novo segredo)", (await store(rD.session_id)).error === "token_already_stored" && (await secretCount()) === before + 1);
ck("5.6 token curto/nulo: PT400", errHas(await svc("select public.whatsapp_signup_store_token($1,'curto') j", [rD.session_id]), /Token inválido/, "PT400"));
ck("5.7 validade já vencida recusada", (await (async () => { const E = await mkCo("E"); const r = await reserve(await startSession(E)); return store(r.session_id, TOKEN + "xxxxx", new Date(Date.now() - 1000).toISOString()); })()).error === "token_already_expired");
ck("5.8 store só para service_role", !(await D.owner("select public.whatsapp_signup_store_token($1,$2) j", [rD.session_id, TOKEN])).ok && !(await anon("select public.whatsapp_signup_store_token($1,$2) j", [rD.session_id, TOKEN])).ok);
const sD2 = await startSession(D); // sessão pending (não reservada)
const pD2 = (await su("select id from whatsapp_signup_sessions where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [sD2])).rows[0].id;
ck("5.9 store em sessão pending (não reservada): session_not_reserved", (await store(pD2)).error === "session_not_reserved");

console.log("\n== 6. concluir: empresa nova ==");
const F = await mkCo("F");
const fr = await ready(F);
const c6 = await complete(fr.sid, { pnid: "777000111" });
const j6 = c6.rows?.[0]?.j;
ck("6.1 conclusão ok, ativa, modo test, nova conexão", c6.ok && j6.ok && j6.status === "active" && j6.mode === "test" && j6.idempotent === false, JSON.stringify(c6));
const cn = (await su("select * from company_whatsapp_connections where id=$1", [j6.connection_id])).rows[0];
ck("6.2 campos: embedded_signup/cloud_api/valid, waba, business, registered/subscribed, created_by", cn.connection_source === "embedded_signup" && cn.connection_type === "cloud_api" && cn.token_status === "valid"
  && cn.waba_id === "123456789" && cn.meta_business_id === "444555666" && !!cn.registered_at && !!cn.webhook_subscribed_at && cn.webhook_status === "active" && cn.created_by === F.ids.owner && cn.company_id === F.c);
ck("6.3 a referência do token é a da PRÓPRIA sessão", cn.token_secret_id === (await sess(fr.sid)).token_secret_id && (await secretOf(cn.token_secret_id)).startsWith(TOKEN));
const s6 = await sess(fr.sid);
ck("6.4 sessão completed, com conexão e data", s6.status === "completed" && s6.connection_id === cn.id && !!s6.completed_at);
const c6b = await complete(fr.sid, { pnid: "777000111" });
ck("6.5 repetir a conclusão é idempotente (mesma conexão, sem duplicar)", c6b.rows[0].j.ok && c6b.rows[0].j.idempotent === true && c6b.rows[0].j.connection_id === cn.id
  && Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1", [F.c])).rows[0].n) === 1);
ck("6.6 sessão concluída não é reaproveitada para outro número", (await complete(fr.sid, { pnid: "777000222" })).rows[0].j.error === "already_used");
ck("6.7 state de sessão concluída não reserva de novo", (await reserve(fr.state)).error === "already_used");
ck("6.8 whatsapp_signup_fail em sessão concluída não muda nada", (await svc("select public.whatsapp_signup_fail($1,'x') j", [fr.sid])).rows[0].j.changed === false && (await sess(fr.sid)).status === "completed");
ck("6.9 conexão criada recebe mensagens (webhook resolve a empresa)", (await svc("select public.whatsapp_ingest_message('777000111','wamid.sg.2','5544999990002','Joao','text','oi',now(),'msg:sg:2') j")).rows[0].j.result === "stored");
ck("6.10 conclusão só pelo service_role", !(await F.owner("select public.whatsapp_signup_complete($1,'123456','111222','x','x',null,now(),now(),'cloud_api') j", [fr.sid])).ok
  && !(await anon("select public.whatsapp_signup_complete($1,'123456','111222','x','x',null,now(),now(),'cloud_api') j", [fr.sid])).ok);

console.log("\n== 7. validações da conclusão ==");
const G = await mkCo("G");
const gr = await ready(G);
ck("7.1 ids da Meta inválidos: PT400", errHas(await complete(gr.sid, { waba: "abc" }), /inválidos/, "PT400") && errHas(await complete(gr.sid, { pnid: "12" }), /inválidos/, "PT400")
  && errHas(await complete(gr.sid, { biz: "xx" }), /inválidos/, "PT400"));
ck("7.2 coexistence ainda não suportado: PT400", errHas(await complete(gr.sid, { type: "coexistence" }), /não suportado/, "PT400"));
ck("7.3 sem registro do número ou sem assinatura do webhook: PT400", errHas(await complete(gr.sid, { registered_at: null }), /registrado/, "PT400") && errHas(await complete(gr.sid, { subscribed_at: null }), /registrado/, "PT400"));
ck("7.4 após erros de validação a sessão segue reservada e nenhuma conexão foi criada", (await sess(gr.sid)).status === "reserved"
  && Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1", [G.c])).rows[0].n) === 0);
const H = await mkCo("H");
const hr = await ready(H, { token: false });
ck("7.5 sem token guardado: token_not_stored", (await complete(hr.sid)).rows[0].j.error === "token_not_stored");
ck("7.6 sessão inexistente: session_not_found", (await complete("00000000-0000-4000-8000-0000000000ee")).rows[0].j.error === "session_not_found");
const I = await mkCo("I");
const ir = await ready(I);
await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' where id=$1", [ir.sid]);
ck("7.7 expirou entre reservar e concluir: expired (nada criado)", (await complete(ir.sid)).rows[0].j.error === "expired"
  && Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1", [I.c])).rows[0].n) === 0);
const J = await mkCo("J");
const jr = await ready(J, { role: "admin" });
await su("update company_users set role='cashier' where company_id=$1 and user_id=$2", [J.c, J.ids.admin]);
ck("7.8 usuário rebaixado entre reservar e concluir: unauthorized (sessão failed, nada criado)", (await complete(jr.sid)).rows[0].j.error === "unauthorized" && (await sess(jr.sid)).status === "failed");
const K = await mkCo("K");
const kr = await ready(K);
await su("delete from company_module_overrides where company_id=$1", [K.c]);
ck("7.9 módulo perdido entre reservar e concluir: unauthorized", (await complete(kr.sid)).rows[0].j.error === "unauthorized");
const Lc = await mkCo("L");
const lr = await ready(Lc);
const stP = (await su("select status from whatsapp_signup_sessions where id=$1", [lr.sid])).rows[0].status;
ck("7.10 sessão pending (não reservada) não conclui", (await (async () => { const s = await startSession(Lc); const sid = (await su("select id from whatsapp_signup_sessions where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [s])).rows[0].id; return complete(sid); })()).rows[0].j.error === "session_not_reserved" && stP !== "pending");

console.log("\n== 8. conflito de número com outra empresa ==");
const M = await mkCo("M");
const mConn = await mkConn(M, { mode: "live" });
const mBefore = (await su("select * from company_whatsapp_connections where id=$1", [mConn.cid])).rows[0];
const N2 = await mkCo("N2");
const nr = await ready(N2);
const secBefore = await secretCount();
const c8 = await complete(nr.sid, { pnid: mConn.pnid });
ck("8.1 número de outra empresa: phone_in_use", c8.rows[0].j.error === "phone_in_use", JSON.stringify(c8));
const mAfter = (await su("select * from company_whatsapp_connections where id=$1", [mConn.cid])).rows[0];
ck("8.2 a conexão da outra empresa NÃO foi tocada (nem token)", JSON.stringify(mBefore) === JSON.stringify(mAfter));
ck("8.3 a empresa solicitante não ganhou conexão; sessão failed/phone_in_use", Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1", [N2.c])).rows[0].n) === 0
  && (await sess(nr.sid)).status === "failed" && (await sess(nr.sid)).error_code === "phone_in_use");
ck("8.4 conflito também vale para número de conexão DESCONECTADA de outra empresa", await (async () => {
  const P = await mkCo("P"); const pc = await mkConn(P, { status: "disconnected" });
  const Q = await mkCo("Q"); const q = await ready(Q);
  return (await complete(q.sid, { pnid: pc.pnid })).rows[0].j.error === "phone_in_use";
})());

console.log("\n== 9. limite de uma conexão ativa por empresa ==");
const R = await mkCo("R");
const rc = await mkConn(R, { mode: "live" });
const rr = await ready(R);
const c9 = await complete(rr.sid, { pnid: "888000999" });
ck("9.1 empresa com outra conexão ativa: company_has_active_connection", c9.rows[0].j.error === "company_has_active_connection", JSON.stringify(c9));
const rcAfter = (await su("select status, mode, token_secret_id, phone_number_id from company_whatsapp_connections where id=$1", [rc.cid])).rows[0];
ck("9.2 a conexão atual segue ativa, no mesmo modo e com o mesmo token", rcAfter.status === "active" && rcAfter.mode === "live" && rcAfter.token_secret_id === rc.sid && rcAfter.phone_number_id === rc.pnid);
ck("9.3 nenhuma conexão extra foi criada", Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1", [R.c])).rows[0].n) === 1);

console.log("\n== 10. reconexão do MESMO número na mesma empresa ==");
const S = await mkCo("S");
const sc = await mkConn(S, { status: "disconnected", mode: "live" });
await su("select public.whatsapp_ingest_message($1,'wamid.sg.s1','5544999990003','Ana','text','oi',now(),'msg:sg:s1') j", [sc.pnid]).catch(() => {});
await su("update company_whatsapp_connections set status='active' where id=$1", [sc.cid]);
await su("select public.whatsapp_ingest_message($1,'wamid.sg.s1','5544999990003','Ana','text','oi',now(),'msg:sg:s1') j", [sc.pnid]);
await su("update company_whatsapp_connections set status='disconnected', disconnected_at=now() where id=$1", [sc.cid]);
const convBefore = Number((await su("select count(*) n from whatsapp_conversations where company_id=$1", [S.c])).rows[0].n);
const sr = await ready(S);
const c10 = await complete(sr.sid, { pnid: sc.pnid, waba: "314159265" });
const j10 = c10.rows?.[0]?.j;
ck("10.1 reconecta reaproveitando a MESMA linha (mesmo id, ativa)", j10?.ok && j10.connection_id === sc.cid && j10.status === "active", JSON.stringify(c10));
const rcn = (await su("select * from company_whatsapp_connections where id=$1", [sc.cid])).rows[0];
ck("10.2 modo anterior (live) preservado; origem passa a embedded_signup; disconnected_at limpo", rcn.mode === "live" && rcn.connection_source === "embedded_signup" && rcn.disconnected_at === null && rcn.waba_id === "314159265");
ck("10.3 token rotacionado: referência nova, segredo novo; o antigo foi removido do Vault", rcn.token_secret_id !== sc.sid && (await secretOf(rcn.token_secret_id)).startsWith(TOKEN) && (await secretOf(sc.sid)) === null);
ck("10.4 histórico (conversas/mensagens) preservado", Number((await su("select count(*) n from whatsapp_conversations where company_id=$1", [S.c])).rows[0].n) === convBefore && convBefore >= 1);
ck("10.5 continua com uma única linha para o número", Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1 and phone_number_id=$2", [S.c, sc.pnid])).rows[0].n) === 1);
// reconexão por cima de uma conexão ATIVA do mesmo número (rotação de token)
const T = await mkCo("T");
const tc = await mkConn(T, { mode: "live" });
const tr = await ready(T);
const c10b = await complete(tr.sid, { pnid: tc.pnid });
ck("10.6 número ativo reconectado: token rotacionado, sem segunda conexão ativa", c10b.rows[0].j.ok && c10b.rows[0].j.connection_id === tc.cid
  && (await secretOf(tc.sid)) === null && Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1", [T.c])).rows[0].n) === 1);
// segredo antigo compartilhado por outra conexão NÃO pode ser apagado
const U1 = await mkCo("U1");
const u1 = await mkConn(U1, { status: "disconnected" });
const U2 = await mkCo("U2");
const u2 = await mkConn(U2, { status: "disconnected" });
await su("update company_whatsapp_connections set token_secret_id=$1 where id=$2", [u1.sid, u2.cid]);
const ur = await ready(U1);
await complete(ur.sid, { pnid: u1.pnid });
ck("10.7 segredo ainda referenciado por outra conexão não é apagado", (await secretOf(u1.sid)) !== null);

console.log("\n== 11. falha da sessão ==");
const V = await mkCo("V");
const vr = await ready(V);
const tokRef = (await sess(vr.sid)).token_secret_id;
const f1 = (await svc("select public.whatsapp_signup_fail($1,'meta_error_190') j", [vr.sid])).rows[0].j;
ck("11.1 fail marca failed, guarda o código e remove o segredo não ligado", f1.ok && f1.changed && (await sess(vr.sid)).status === "failed" && (await sess(vr.sid)).error_code === "meta_error_190" && (await secretOf(tokRef)) === null);
ck("11.2 fail é idempotente", (await svc("select public.whatsapp_signup_fail($1,'outro') j", [vr.sid])).rows[0].j.changed === false && (await sess(vr.sid)).error_code === "meta_error_190");
ck("11.3 sessão failed não reserva nem conclui", (await reserve(vr.state)).error === "already_used" && (await complete(vr.sid)).rows[0].j.error === "session_not_reserved");
ck("11.4 código de erro com formato inválido é normalizado", await (async () => { const W2 = await mkCo("W2"); const r = await ready(W2); await svc("select public.whatsapp_signup_fail($1,'com espaco; drop') j", [r.sid]); return (await sess(r.sid)).error_code === "invalid_code"; })());
ck("11.5 fail só pelo service_role", !(await V.owner("select public.whatsapp_signup_fail($1,'x') j", [vr.sid])).ok);

console.log("\n== 12. saúde do token ==");
const hp = await svc("select public.whatsapp_connection_set_health($1,'expired','190',null) j", [old.cid]);
const hc = (await su("select status, token_status, last_error_code, mode from company_whatsapp_connections where id=$1", [old.cid])).rows[0];
ck("12.1 registra token_status e erro SEM mudar status/modo da conexão", hp.rows[0].j.ok && hc.token_status === "expired" && hc.last_error_code === "190" && hc.status === "active" && hc.mode === "live");
await svc("select public.whatsapp_connection_set_health($1,'valid',null,$2) j", [old.cid, new Date(Date.now() + 86400e3).toISOString()]);
const hc2 = (await su("select token_status, last_error_code, token_expires_at from company_whatsapp_connections where id=$1", [old.cid])).rows[0];
ck("12.2 recuperação limpa o erro e grava a validade", hc2.token_status === "valid" && hc2.last_error_code === null && !!hc2.token_expires_at);
ck("12.3 status/código inválidos: PT400; conexão inexistente: connection_not_found", errHas(await svc("select public.whatsapp_connection_set_health($1,'xx') j", [old.cid]), /inválido/, "PT400")
  && errHas(await svc("select public.whatsapp_connection_set_health($1,'error','com espaco') j", [old.cid]), /inválido/, "PT400")
  && (await svc("select public.whatsapp_connection_set_health('00000000-0000-4000-8000-0000000000dd','error') j")).rows[0].j.error === "connection_not_found");
ck("12.4 set_health só pelo service_role", !(await A.owner("select public.whatsapp_connection_set_health($1,'valid') j", [old.cid])).ok && !(await anon("select public.whatsapp_connection_set_health($1,'valid') j", [old.cid])).ok);

console.log("\n== 13. isolamento e ACL ==");
const acl = (await su(`select p.proname, p.prosecdef, p.proconfig::text cfg,
  has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') au, has_function_privilege('service_role', p.oid, 'execute') s
  from pg_proc p where pronamespace='public'::regnamespace and proname in ('whatsapp_signup_begin','whatsapp_signup_reserve','whatsapp_signup_store_token','whatsapp_signup_fail','whatsapp_signup_sweep','whatsapp_signup_complete','whatsapp_connection_set_health','whatsapp_signup_user_can_manage')`)).rows;
const by = Object.fromEntries(acl.map((r) => [r.proname, r]));
ck("13.1 todas SECURITY DEFINER com search_path fixo", acl.length === 8 && acl.every((r) => r.prosecdef && /search_path=public/.test(r.cfg)));
ck("13.2 begin: só authenticated", by.whatsapp_signup_begin.au && !by.whatsapp_signup_begin.a && !by.whatsapp_signup_begin.s);
ck("13.3 reserve/store/fail/complete/set_health: só service_role", ["whatsapp_signup_reserve", "whatsapp_signup_store_token", "whatsapp_signup_fail", "whatsapp_signup_sweep", "whatsapp_signup_complete", "whatsapp_connection_set_health"].every((n) => by[n].s && !by[n].au && !by[n].a));
ck("13.4 helper interno: ninguém executa", !by.whatsapp_signup_user_can_manage.s && !by.whatsapp_signup_user_can_manage.au && !by.whatsapp_signup_user_can_manage.a);
const grants = (await su("select has_table_privilege('authenticated','public.whatsapp_signup_sessions','select') s, has_table_privilege('anon','public.whatsapp_signup_sessions','select') a, (select relrowsecurity from pg_class where oid='public.whatsapp_signup_sessions'::regclass) rls")).rows[0];
ck("13.5 sessões: RLS ligada, sem grant para anon/authenticated", grants.rls && !grants.s && !grants.a);
ck("13.6 colunas novas da conexão seguem sem leitura direta do cliente", !(await A.owner("select token_status from company_whatsapp_connections")).ok);
const crossBefore = (await su("select count(*) n from company_whatsapp_connections where company_id=$1", [OTHER.c])).rows[0].n;
const xr = await ready(F.c ? A : A); // sessão da empresa A não cria nada na OTHER
await complete(xr.sid, { pnid: "999000333" });
ck("13.7 a conclusão só afeta a empresa da sessão (outras intactas)", (await su("select count(*) n from company_whatsapp_connections where company_id=$1", [OTHER.c])).rows[0].n === crossBefore);

console.log("\n== 14. desconectar continua funcionando ==");
const dis = await F.owner("select public.whatsapp_disconnect($1,'DESCONECTAR') j", [F.c]);
ck("14.1 whatsapp_disconnect desconecta a conexão criada pelo signup, mantendo o histórico", dis.ok && dis.rows[0].j.status === "disconnected"
  && (await su("select status from company_whatsapp_connections where id=$1", [j6.connection_id])).rows[0].status === "disconnected");

console.log("\n== 14b. sessões travadas e segredos órfãos ==");
const X = await mkCo("X");
const sx = await ready(X);
const xRef = (await sess(sx.sid)).token_secret_id;
ck("14b.1 backend 'caiu' após store_token: segredo existe e a sessão está reservada", !!xRef && (await secretOf(xRef)) !== null && (await sess(sx.sid)).status === "reserved");
const x2 = await startSession(X);
ck("14b.2 sessão reservada pendurada NÃO bloqueia nova tentativa da empresa", /^[0-9a-f]{64}$/.test(x2));
await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id=$1", [sx.sid]);
const sw = (await svc("select public.whatsapp_signup_sweep($1) j", [X.c])).rows[0].j;
ck("14b.3 sweep expira a sessão vencida e apaga o segredo órfão", sw.ok && sw.sessions_expired === 1 && sw.secrets_removed === 1 && (await secretOf(xRef)) === null
  && (await sess(sx.sid)).status === "expired" && (await sess(sx.sid)).token_secret_id === null, JSON.stringify(sw));
ck("14b.4 sweep é idempotente", (await svc("select public.whatsapp_signup_sweep($1) j", [X.c])).rows[0].j.sessions_expired === 0);
const Y = await mkCo("Y");
const yr = await ready(Y);
const yRef = (await sess(yr.sid)).token_secret_id;
await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id=$1", [yr.sid]);
await startSession(Y);
ck("14b.5 criar nova sessão já limpa o segredo órfão da empresa", (await secretOf(yRef)) === null && (await sess(yr.sid)).status === "expired");
const Z = await mkCo("Z");
const zc = await mkConn(Z, { mode: "live" });
const zr = await ready(Z);
await su("update whatsapp_signup_sessions set token_secret_id=$1, created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id=$2", [zc.sid, zr.sid]);
await svc("select public.whatsapp_signup_sweep() j");
ck("14b.6 segredo ligado a uma conexão nunca é apagado pela varredura", (await secretOf(zc.sid)) !== null);
ck("14b.7 sweep global funciona sem empresa", (await svc("select public.whatsapp_signup_sweep() j")).rows[0].j.ok === true);
ck("14b.8 sweep negado a authenticated e anon", !(await X.owner("select public.whatsapp_signup_sweep() j")).ok && !(await anon("select public.whatsapp_signup_sweep() j")).ok);
const W3 = await mkCo("W3");
const wr = await ready(W3);
const wRef = (await sess(wr.sid)).token_secret_id;
await su("update whatsapp_signup_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' where id=$1", [wr.sid]);
ck("14b.9 concluir após o vencimento: expired e segredo órfão removido", (await complete(wr.sid)).rows[0].j.error === "expired" && (await secretOf(wRef)) === null);
const stateJ = JSON.stringify((await A.owner("select public.whatsapp_get_module_state($1) j", [A.c])).rows?.[0]?.j ?? null);
const sumJ = JSON.stringify((await A.owner("select public.whatsapp_get_connection_summary($1) j", [A.c])).rows?.[0]?.j ?? null);
ck("14b.10 RPCs do cliente (estado do módulo, resumo, begin) não expõem token nem referência", !/token|secret/i.test(stateJ + sumJ) && !/token|secret/i.test(JSON.stringify((await begin(A)).rows[0].j)));


console.log("\n== 15. rollback seguro ==");
const snap = async () => JSON.stringify((await su(`select c.id, c.company_id, c.status, c.mode, c.waba_id, c.phone_number_id, c.display_phone_number, c.business_name, c.token_secret_id, c.webhook_status, c.connected_at
  from company_whatsapp_connections c order by c.id`)).rows);
const msgs = async () => Number((await su("select (select count(*) from whatsapp_messages) + (select count(*) from whatsapp_conversations) n")).rows[0].n);
const snapBefore = await snap(), msgsBefore = await msgs();
await pg.exec(fs.readFileSync("D:/orça facil/.claude/db-tests/whatsapp-token-sweep.rollback.sql", "utf8")); // desfaz 1109 (varredura dos tokens)
await pg.exec(fs.readFileSync("D:/orça facil/.claude/db-tests/whatsapp-token-health.rollback.sql", "utf8")); // desfaz 1108 (saúde do token)
await pg.exec(fs.readFileSync("D:/orça facil/.claude/db-tests/whatsapp-signup-pilot.rollback.sql", "utf8")); // desfaz 1107 (allowlist do piloto)
await pg.exec(fs.readFileSync("D:/orça facil/.claude/db-tests/whatsapp-registration-pin.rollback.sql", "utf8")); // desfaz 1106 (a 1104 não é desfeita antes)
await pg.exec(fs.readFileSync("D:/orça facil/.claude/db-tests/whatsapp-signup-foundation.rollback.sql", "utf8"));
ck("15.1 rollback preserva todas as conexões (colunas originais idênticas) e mensagens", (await snap()) === snapBefore && (await msgs()) === msgsBefore);
const afterRb = new Set((await pg.query(inv)).rows.map((r) => r.k));
ck("15.2 após o rollback o schema volta ao baseline (nada a mais, nada a menos)", [...afterRb].filter((k) => !baseline.has(k)).length === 0 && [...baseline].filter((k) => !afterRb.has(k)).length === 0,
  [...afterRb].filter((k) => !baseline.has(k)).concat([...baseline].filter((k) => !afterRb.has(k))).join(", "));
const oldBegin = await A.owner("select public.whatsapp_signup_begin($1) j", [A.c]);
ck("15.3 whatsapp_signup_begin volta ao comportamento anterior (usa whatsapp_signup_attempts)", oldBegin.ok && /^[0-9a-f]{64}$/.test(oldBegin.rows[0].j.state)
  && Number((await su("select count(*) n from whatsapp_signup_attempts")).rows[0].n) === 1);

console.log("\n== 16. aplicação sobre banco existente (conexão como a da Djalexeventos) ==");
{
  const b = BL;
  const q = (sql, params) => b.pg.query(sql, params);
  await b.pg.exec("select set_config('request.jwt.claim.sub','',false)");
  const co = (await q("insert into companies (name,slug,document,email) values ('Djalex-like','djalex-like','11222333000181','d@x.com') returning id")).rows[0].id;
  await q("insert into vault.decrypted_secrets (name, decrypted_secret) values ('wa_token_real_like','SEGREDO-DE-TESTE-NAO-REAL')").catch(() => {});
  const conn = (await q("insert into company_whatsapp_connections (company_id,status,mode,waba_id,phone_number_id,display_phone_number,business_name,token_secret_id,webhook_status,connected_at) values ($1,'active','test','100200300','900800700','+55 44 90000-0000','Djalexeventos',gen_random_uuid(),'active',now()) returning id", [co])).rows[0].id;
  const cols = "id,company_id,status,mode,waba_id,phone_number_id,display_phone_number,business_name,token_secret_id,webhook_status,connected_at,created_at";
  const before = JSON.stringify((await q(`select ${cols} from company_whatsapp_connections where id=$1`, [conn])).rows[0]);
  const sqlText = fs.readFileSync(path.join(MIG, NEW), "utf8");
  await b.pg.exec(sqlText);
  const rowAfter = (await q("select * from company_whatsapp_connections where id=$1", [conn])).rows[0];
  const pick = (r) => JSON.stringify(Object.fromEntries(cols.split(",").map((c) => [c, r[c]])));
  ck("16.1 conexão pré-existente: colunas originais idênticas após aplicar a migration", pick(rowAfter) === before);
  ck("16.2 continua active e em modo test; novas colunas com defaults seguros", rowAfter.status === "active" && rowAfter.mode === "test" && rowAfter.connection_source === "manual"
    && rowAfter.connection_type === "cloud_api" && rowAfter.token_status === "unknown" && rowAfter.last_error_code === null);
  const invB = async () => JSON.stringify((await q(inv)).rows.map((r) => r.k).sort());
  const snapOk = await invB();
  const again = await b.pg.exec(sqlText).then(() => ({ ok: true }), (e) => ({ ok: false, err: e.message }));
  ck("16.3 segunda execução falha limpa (não é reaplicável) e não altera nada", !again.ok && (await invB()) === snapOk
    && pick((await q("select * from company_whatsapp_connections where id=$1", [conn])).rows[0]) === before, JSON.stringify(again));
  const active = (await q("select count(*) n from company_whatsapp_connections where company_id=$1 and status='active' and mode='test'", [co])).rows[0].n;
  ck("16.4 sem sessões nem conexões criadas pela migration", Number(active) === 1 && Number((await q("select count(*) n from whatsapp_signup_sessions")).rows[0].n) === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP SIGNUP FOUNDATION");
