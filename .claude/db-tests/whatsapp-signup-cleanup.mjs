// 20261105010000: segredo do Vault de sessão que falhou DENTRO de whatsapp_signup_complete é limpo por fail() e por sweep().
import { loadAll } from "./full-db.mjs";
const { pg, ck, as, su: su0, summary } = await loadAll(undefined, { legacyIaMirror: false });
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const svc = (sql, params) => as("service_role", null, sql, params);
const anon = (sql, params) => as("anon", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
  declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id into v; return v; end $f$;
`);
await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id='1234567890', embedded_signup_config_id='9876543210'");
let seq = 300;
async function mkCo(tag) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "cl-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
  const u = id(++seq);
  await su(`insert into auth.users (id,email) values ('${u}','o-${tag}@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','o-${tag}@x.com','o ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
  await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [c, u]);
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste cleanup', now() + interval '1 day')", [c]);
  return { c, owner: U(u) };
}
const secretOf = async (sid) => (await su("select secret from vault.secrets where id=$1", [sid])).rows[0]?.secret ?? null;
async function ready(co) {
  const b0 = await co.owner("select public.whatsapp_signup_begin($1) j", [co.c]); if (!b0.ok) throw new Error(b0.err);
  const state = b0.rows[0].j.state;
  const r = (await svc("select public.whatsapp_signup_reserve($1) j", [state])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1,$2) j", [r.session_id, "TOKEN-DE-TESTE-" + r.session_id]);
  return r.session_id;
}
const complete = (sid, pnid) => svc("select public.whatsapp_signup_complete($1,'123456789',$2,'+55 44 9','Emp','444555666',now(),now(),'cloud_api') j", [sid, pnid]);
const sess = async (sid) => (await su("select * from whatsapp_signup_sessions where id=$1", [sid])).rows[0];

const A = await mkCo("A"), B = await mkCo("B");
// B já tem o número 910000001
const bSid = await ready(B);
ck("1.1 B conecta o número", (await complete(bSid, "910000001")).rows[0].j.ok === true);
const bConn = (await su("select token_secret_id from company_whatsapp_connections where company_id=$1", [B.c])).rows[0].token_secret_id;

const aSid = await ready(A);
const aRef = (await sess(aSid)).token_secret_id;
const res = (await complete(aSid, "910000001")).rows[0].j;
ck("2.1 complete recusa (phone_in_use) e a sessão fica failed", res.error === "phone_in_use" && (await sess(aSid)).status === "failed");
ck("2.2 (comportamento da 1104) o segredo ficou órfão na sessão failed", (await sess(aSid)).token_secret_id === aRef && (await secretOf(aRef)) !== null);
const f = (await svc("select public.whatsapp_signup_fail($1,'qualquer') j", [aSid])).rows[0].j;
ck("2.3 fail() limpa o segredo da sessão já failed (changed=true)", f.ok && f.changed === true && (await secretOf(aRef)) === null && (await sess(aSid)).token_secret_id === null);
ck("2.4 o código de erro original da sessão é preservado", (await sess(aSid)).error_code === "phone_in_use");
ck("2.5 fail() é idempotente", (await svc("select public.whatsapp_signup_fail($1,'x') j", [aSid])).rows[0].j.changed === false);
ck("2.6 o segredo da conexão de B segue intacto", (await secretOf(bConn)) !== null);

// sweep cobre failed com referência
const C = await mkCo("C");
await su("insert into company_whatsapp_connections (company_id,status,phone_number_id) values ($1,'active','910000002')", [C.c]);
const cSid = await ready(C);
const cRef = (await sess(cSid)).token_secret_id;
ck("3.1 company_has_active_connection deixa segredo na sessão failed", (await complete(cSid, "910000003")).rows[0].j.error === "company_has_active_connection" && (await secretOf(cRef)) !== null);
const sw = (await svc("select public.whatsapp_signup_sweep() j")).rows[0].j;
ck("3.2 sweep apaga o segredo da sessão failed e zera a referência", sw.ok && sw.secrets_removed >= 1 && (await secretOf(cRef)) === null && (await sess(cSid)).token_secret_id === null);
ck("3.3 sweep não toca em segredo ligado a conexão e é idempotente", (await secretOf(bConn)) !== null && (await svc("select public.whatsapp_signup_sweep() j")).rows[0].j.secrets_removed === 0);

// segredo referenciado por conexão nunca é apagado, mesmo numa sessão failed forjada
const D = await mkCo("D");
const dSid = await ready(D);
await su("update whatsapp_signup_sessions set status='failed', error_code='x', token_secret_id=$1 where id=$2", [bConn, dSid]);
await svc("select public.whatsapp_signup_sweep() j");
await svc("select public.whatsapp_signup_fail($1,'x') j", [dSid]);
ck("4.1 segredo de conexão ativa preservado por sweep e fail", (await secretOf(bConn)) !== null);

// trava de nome: segredo que NÃO foi criado pelo signup (sem prefixo wa_token_signup_) nunca é apagado, mesmo órfão
const E = await mkCo("E");
const eSid = await ready(E);
const foreign = (await su("insert into vault.secrets (name, secret) values ('wa_token_manual_antigo','TOKEN-MANUAL-ANTIGO-0000') returning id")).rows[0].id;
await su("update whatsapp_signup_sessions set status='failed', error_code='x', token_secret_id=$1 where id=$2", [foreign, eSid]);
await svc("select public.whatsapp_signup_sweep() j");
ck("6.1 sweep não apaga segredo sem o prefixo do signup (mas limpa a referência)", (await secretOf(foreign)) !== null && (await sess(eSid)).token_secret_id === null);
await su("update whatsapp_signup_sessions set token_secret_id=$1 where id=$2", [foreign, eSid]);
await svc("select public.whatsapp_signup_fail($1,'x') j", [eSid]);
ck("6.2 fail não apaga segredo sem o prefixo do signup", (await secretOf(foreign)) !== null && (await sess(eSid)).token_secret_id === null);

// as funções só mexem em sessões de signup e no Vault: conversas, mensagens e conexões ficam idênticas
const dig = async () => JSON.stringify((await su("select (select md5(coalesce(string_agg(c::text, ';' order by c.id), '')) from company_whatsapp_connections c) k, (select count(*) from whatsapp_conversations) v, (select count(*) from whatsapp_messages) m")).rows[0]);
const F2 = await mkCo("F2");
const fSid = await ready(F2);
const dBefore = await dig();
await svc("select public.whatsapp_signup_fail($1,'x') j", [fSid]);
await su("update whatsapp_signup_sessions set status='reserved', created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id=$1", [fSid]).catch(() => {});
await svc("select public.whatsapp_signup_sweep() j");
ck("6.3 fail/sweep não alteram conexões, conversas nem mensagens", (await dig()) === dBefore);
ck("5.1 ACL inalterada: sweep e fail só service_role", !(await A.owner("select public.whatsapp_signup_sweep() j")).ok && !(await anon("select public.whatsapp_signup_fail($1,'x') j", [aSid])).ok
  && (await su("select has_function_privilege('service_role','public.whatsapp_signup_fail(uuid,text)','execute') a, has_function_privilege('authenticated','public.whatsapp_signup_fail(uuid,text)','execute') b, has_function_privilege('authenticated','public.whatsapp_signup_sweep(uuid)','execute') c")).rows.every((r) => r.a && !r.b && !r.c));
summary("WHATSAPP SIGNUP CLEANUP");
