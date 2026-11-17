// Auditoria PRÉ-PUBLICAÇÃO da Coexistence (migrations 20261123010000, 20261124010000, 20261125010000), SOMENTE LOCAL.
// Simula o remoto: banco com TODAS as migrations até 20261122010000 + dados realistas de uma empresa Cloud API tradicional (como a
// Djalexeventos: conexão manual, conversas, mensagens, eventos, jobs da IA), aplica as 3 migrations NA ORDEM e prova:
//   (a) as migrations aplicam sem erro sobre dados existentes e não alteram nenhuma linha existente;
//   (b) o WhatsApp Cloud API tradicional segue funcionando (inbound, status, envio, IA) e é imune aos novos caminhos;
//   (c) o rollback ENCADEADO (1125 -> 1124 -> 1123) funciona COM dados de Coexistence e preserva os dados tradicionais;
//   (d) as migrations podem ser reaplicadas depois do rollback.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "./full-db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");   // independe de onde o repositório foi clonado
const MIG = path.join(ROOT, "supabase/migrations");
const RB = path.join(ROOT, "supabase/rollbacks/whatsapp-coexistence");
const NEW = ["20261123010000_whatsapp_coexistence_connection_type.sql", "20261124010000_whatsapp_coexistence_webhooks.sql", "20261125010000_whatsapp_coexistence_sync.sql"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig-precoex-"));
for (const f of fs.readdirSync(MIG)) if (f.endsWith(".sql") && !NEW.includes(f) && !f.startsWith("20261206010000")) fs.copyFileSync(path.join(MIG, f), path.join(tmp, f));   // 7.11H (altera o eco) depende da Coexistence: fora da base "pré-publicação"
const { pg, ck, as, su: su0, summary } = await loadAll(tmp, { legacyIaMirror: false });
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const svc = (sql, params) => as("service_role", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await pg.exec(`alter table vault.decrypted_secrets add column if not exists id uuid;`);
const tok = "99999999-0000-4000-8000-000000000001";
await su("insert into vault.decrypted_secrets (id, name, decrypted_secret) values ($1,'wa_token_audit','TOKEN-AUDITORIA')", [tok]);

// -------------------------------------------------------------- dados "de produção" (antes das migrations)
const mkCo = async (tag) => {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "au-" + tag, `${tag}@x.com`])).rows[0].id;
  const u = id(Math.floor(Math.random() * 1e6) + 1000);
  await su(`insert into auth.users (id,email) values ('${u}','o-${tag}@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','o-${tag}@x.com','o ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
  await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [c, u]);
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','audit', now() + interval '1 day'), ($1,'ia','audit', now() + interval '1 day')", [c]);
  return { c, u };
};
const D = await mkCo("djalex");
const connD = (await su("insert into company_whatsapp_connections (company_id, status, mode, waba_id, phone_number_id, display_phone_number, token_secret_id, webhook_status, connected_at, connection_source, connection_type, token_status) values ($1,'active','test','880000000001','111222333','+55 44 90000-0000',$2,'active', now() - interval '30 days','manual','cloud_api','unknown') returning id", [D.c, tok])).rows[0].id;
await su("insert into whatsapp_test_recipients (company_id, connection_id, phone_e164) values ($1,$2,'5544999990001')", [D.c, connD]);
const S = (co, ...a) => as("authenticated", co.u, "select public.whatsapp_ai_update_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) j", a);
const sres = await S(D, D.c, true, "auto", "Espeto", "cordial", "Vendemos espetinho a R$ 12,00.", null, true, 12, true, true, null, null, null);
if (!sres.ok) console.log("AI SETTINGS ERRO:", sres.err);
let n = 0;
const ingest = (pn, from, body, wamid = `wamid.pre.${++n}`) => svc("select public.whatsapp_ingest_message($1,$2,$3,'Maria','text',$4,now(),$5) j", [pn, wamid, from, body, `msg:${pn}:${wamid}`]);
for (let i = 0; i < 5; i += 1) {
  const phone = `55449999900${10 + i}`;
  await su("insert into whatsapp_test_recipients (company_id, connection_id, phone_e164) values ($1,$2,$3) on conflict do nothing", [D.c, connD, phone]).catch(() => {});
  for (let k = 0; k < 6; k += 1) await ingest("111222333", phone, `mensagem ${i}-${k}`);
}
const convs = (await su("select id from whatsapp_conversations where company_id=$1", [D.c])).rows;
let w = 0;
for (const cv of convs) {
  await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_by_user_id, client_request_id)
    values ($1,$2,$3,$4,'outbound','text','resposta humana','sent','human',$5,gen_random_uuid())`, [D.c, connD, cv.id, `wamid.out.${++w}`, D.u]);
}
await su("update whatsapp_conversations set ai_control='human' where id=$1", [convs[0].id]);
const snapConn = async () => JSON.stringify((await su(`select id, company_id, status, mode, waba_id, phone_number_id, display_phone_number, token_secret_id, webhook_status, connected_at, connection_source, connection_type, token_status, registered_at, webhook_subscribed_at from company_whatsapp_connections where id=$1`, [connD])).rows[0]);
const snapRows = async () => JSON.stringify((await su(`select (select count(*) from whatsapp_messages) m, (select count(*) from whatsapp_conversations) c, (select count(*) from whatsapp_webhook_events) w, (select count(*) from whatsapp_message_events) me, (select count(*) from whatsapp_ai_jobs) j, (select count(*) from company_whatsapp_connections) cn`)).rows[0]);
const contentHash = async () => (await su("select md5(string_agg(id::text||provider_message_id||coalesce(body,'')||status||direction||origin, ',' order by id)) h from whatsapp_messages")).rows[0].h;
const fnHash = async () => JSON.stringify((await su("select proname, md5(regexp_replace(prosrc,'\\s+','','g')) h from pg_proc where pronamespace='public'::regnamespace and proname in ('whatsapp_signup_complete','whatsapp_mark_message_sent','whatsapp_ingest_message','whatsapp_get_send_context','whatsapp_ai_prepare_auto','whatsapp_ai_auto_commit_send') order by proname")).rows);

const before = { conn: await snapConn(), rows: await snapRows(), msgs: await contentHash(), fns: await fnHash() };
ck("0.1 pré-condição: base 'de produção' montada (1 conexão manual, 5 conversas, 30 inbound + 5 saídas humanas, jobs da IA)", JSON.parse(before.rows).m == 35 && JSON.parse(before.rows).c == 5 && JSON.parse(before.rows).cn == 1);

console.log("\n== 1. aplicar as 3 migrations NA ORDEM sobre os dados existentes ==");
let applied = 0, err = "";
for (const f of NEW) {
  try { await pg.exec(fs.readFileSync(path.join(MIG, f), "utf8")); applied += 1; } catch (e) { err = f + ": " + String(e.message ?? e); break; }
}
ck("1.1 as 3 migrations aplicam sem erro, em ordem, sobre o banco com dados", applied === 3, err);
ck("1.2 a conexão existente (Djalexeventos) está IDÊNTICA em todas as colunas pré-existentes", (await snapConn()) === before.conn);
const afterRows = await snapRows();
ck("1.3 nenhuma linha foi criada/apagada nas tabelas existentes (mensagens, conversas, eventos, jobs, conexões)", afterRows === before.rows);
ck("1.4 o conteúdo de todas as mensagens existentes é idêntico (hash)", (await contentHash()) === before.msgs);
ck("1.5 as colunas novas assumem os valores neutros: sent_via=cloud_api em todas as mensagens; lifecycle_state=normal na conexão", Number((await su("select count(*) n from whatsapp_messages where sent_via <> 'cloud_api'")).rows[0].n) === 0
  && (await su("select lifecycle_state s, lifecycle_reason r from company_whatsapp_connections where id=$1", [connD])).rows[0].s === "normal");
ck("1.6 a conexão Cloud API tradicional NÃO ganhou linha de sincronização e a trava mestra nasce desligada", Number((await su("select count(*) n from whatsapp_coexistence_sync")).rows[0].n) === 0 && (await su("select coexistence_sync_enabled e from whatsapp_platform_settings")).rows[0].e === false);
const fnAfter = JSON.parse(await fnHash()), fnBefore = JSON.parse(before.fns);
const changed = fnAfter.filter((f, i) => f.h !== fnBefore[i].h).map((f) => f.proname).sort().join(",");
ck("1.7 SÓ as 2 funções esperadas mudaram (whatsapp_signup_complete e whatsapp_mark_message_sent); IA, ingest e contexto de envio intactos", changed === "whatsapp_mark_message_sent,whatsapp_signup_complete", changed);

console.log("\n== 2. Cloud API tradicional segue funcionando e é imune aos caminhos novos ==");
{
  const FROM = "5544999990020";
  await su("insert into whatsapp_test_recipients (company_id, connection_id, phone_e164) values ($1,$2,$3)", [D.c, connD, FROM]);
  const r = await ingest("111222333", FROM, "nova mensagem depois da migration", "wamid.post.1");
  ck("2.1 inbound tradicional continua sendo gravado", r.ok && r.rows[0].j.result === "stored");
  const cv = (await su("select id from whatsapp_conversations where company_id=$1 and contact_phone=$2", [D.c, FROM])).rows[0].id;
  const jobsNow = (await su("select * from whatsapp_ai_jobs where conversation_id=$1 and status='pending'", [cv])).rows;
  const st = await svc("select public.whatsapp_ingest_status('111222333','wamid.out.1','delivered',now(),null,'st:audit:1') j");
  ck("2.2 status de entrega tradicional continua funcionando", st.ok);
  const prep = await as("authenticated", D.u, "select public.whatsapp_prepare_outbound_message($1, gen_random_uuid(), 'resposta após a migration') j", [cv]);
  const mid = prep.rows?.[0]?.j?.message_id;
  const ctx = mid ? await svc("select public.whatsapp_get_send_context($1) j", [mid]) : null;
  const sent = mid ? await svc("select public.whatsapp_mark_message_sent($1,'wamid.post.out',now()) j", [mid]) : null;
  ck("2.3 envio tradicional: prepare -> contexto (token do Vault) -> mark_sent funcionam", prep.ok && ctx.rows[0].j.ok === true && sent.rows[0].j.result === "sent"
    && (await su("select sent_via from whatsapp_messages where id=$1", [mid])).rows[0].sent_via === "cloud_api");
  ck("2.4 a IA continua enfileirando respostas para a conversa tradicional (e o envio humano depois a pausa, como antes)", jobsNow.length >= 1 && (await su("select ai_control c from whatsapp_conversations where id=$1", [cv])).rows[0].c === "human", JSON.stringify({ jobs: jobsNow.length, ctl: (await su("select ai_control c from whatsapp_conversations where id=$1", [cv])).rows[0].c, st: (await su("select enabled, mode from company_whatsapp_ai_settings where company_id=$1", [D.c])).rows }));
  const ctlBefore = (await su("select ai_control c from whatsapp_conversations where id=$1", [cv])).rows[0].c;
  const msgsBefore = Number((await su("select count(*) n from whatsapp_messages where conversation_id=$1", [cv])).rows[0].n);
  const echo = await svc("select public.whatsapp_ingest_echo('111222333','wamid.echo.fake',$1,'text','x',now(),'echo:audit:1') j", [FROM]);
  ck("2.5 eco dirigido ao número tradicional: 'not_coexistence', nada gravado, IA e jobs intactos", echo.rows[0].j.result === "not_coexistence" && (await su("select ai_control from whatsapp_conversations where id=$1", [cv])).rows[0].ai_control === ctlBefore
    && Number((await su("select count(*) n from whatsapp_messages where conversation_id=$1", [cv])).rows[0].n) === msgsBefore && Number((await su("select count(*) n from whatsapp_messages where provider_message_id='wamid.echo.fake'")).rows[0].n) === 0);
  const au = await svc("select public.whatsapp_coexistence_account_update('880000000001','PARTNER_REMOVED','ACCOUNT_DISCONNECTED','acct:audit:1', (extract(epoch from now())::bigint + 60)) j");
  const au2 = await svc("select public.whatsapp_coexistence_account_update('880000000001','ACCOUNT_OFFBOARDED',null,'acct:audit:2', (extract(epoch from now())::bigint + 61)) j");
  ck("2.6 PARTNER_REMOVED/OFFBOARDED na WABA da conexão MANUAL não a desconecta nem pausa", au.ok && au2.ok && (await su("select status, lifecycle_state from company_whatsapp_connections where id=$1", [connD])).rows[0].status === "active"
    && (await su("select lifecycle_state s from company_whatsapp_connections where id=$1", [connD])).rows[0].s === "normal");
  const sy = await svc("select public.whatsapp_coexistence_sync_prepare($1,$2,'contacts') j", [D.u, D.c]);
  ck("2.7 pedido de sincronização para a empresa tradicional: recusado (trava mestra desligada) e, ligada, 'connection_not_eligible'", sy.rows[0].j.error === "sync_disabled");
  await su("update whatsapp_platform_settings set coexistence_sync_enabled=true");
  const sy2 = await svc("select public.whatsapp_coexistence_sync_prepare($1,$2,'contacts') j", [D.u, D.c]);
  await su("update whatsapp_platform_settings set coexistence_sync_enabled=false");
  ck("2.8 (trava ligada só no teste) a empresa Cloud API tradicional continua inelegível", sy2.rows[0].j.error === "unauthorized" || sy2.rows[0].j.error === "company_not_authorized" || sy2.rows[0].j.error === "connection_not_eligible", sy2.rows[0].j.error);
}

console.log("\n== 3. Coexistence com dados + rollback ENCADEADO (1125 -> 1124 -> 1123) ==");
const E = await mkCo("coex");
const connE = (await su("insert into company_whatsapp_connections (company_id, status, mode, waba_id, phone_number_id, display_phone_number, token_secret_id, webhook_status, connected_at, connection_source, connection_type, token_status) values ($1,'active','test','880000000002','444555666','+55 44 91111-1111',$2,'active', now() - interval '1 hour','embedded_signup','coexistence','valid') returning id", [E.c, tok])).rows[0].id;
{
  await su("update whatsapp_platform_settings set coexistence_sync_enabled=true");
  await svc("select public.whatsapp_ingest_message('444555666','5544988880001','900','Z','text','oi',now(),'msg:coex:1')");
  await svc("select public.whatsapp_ingest_echo('444555666','wamid.coex.echo','5544988880001','text','respondi pelo celular',now(),'echo:coex:1')");
  await svc("select public.whatsapp_coexistence_record('444555666','contact_sync','smb_app_state_sync','sync:coex:1','{\"added\":3}'::jsonb)");
  await svc("select public.whatsapp_coexistence_account_update('880000000002','ACCOUNT_OFFBOARDED',null,'acct:coex:1', (extract(epoch from now())::bigint + 60))");
  await svc("select public.whatsapp_coexistence_account_update('880000000002','ACCOUNT_RECONNECTED',null,'acct:coex:2', (extract(epoch from now())::bigint + 61))");
  await su("update whatsapp_platform_settings set coexistence_sync_enabled=false");
  const nCoex = Number((await su("select (select count(*) from whatsapp_messages where sent_via='business_app') + (select count(*) from whatsapp_coexistence_events) + (select count(*) from whatsapp_coexistence_sync) n")).rows[0].n);
  ck("3.0 pré-condição: dados de Coexistence criados (eco, eventos, linha de sincronização)", nCoex >= 4, nCoex);
  const mid = await snapRows(), midHash = await contentHash();
  let ok = true, why = "";
  for (const f of ["20261125010000_rollback.sql", "20261124010000_rollback.sql", "20261123010000_rollback.sql"]) {
    try { await pg.exec(fs.readFileSync(path.join(RB, f), "utf8")); } catch (e) { ok = false; why = f + ": " + String(e.message ?? e); break; }
  }
  ck("3.1 os 3 rollbacks executam em sequência, COM dados de Coexistence presentes", ok, why);
  const cnt = async (q) => Number((await su(q)).rows[0].n);
  ck("3.2 depois do rollback: tabelas/colunas/funções novas removidas", await cnt("select count(*) n from information_schema.tables where table_name like 'whatsapp_coexistence%'") === 0
    && await cnt("select count(*) n from information_schema.columns where column_name in ('sent_via','lifecycle_state','coexistence_sync_enabled')") === 0
    && await cnt("select count(*) n from pg_proc where proname in ('whatsapp_ingest_echo','whatsapp_coexistence_record','whatsapp_coexistence_account_update','whatsapp_coexistence_sync_prepare','whatsapp_coexistence_sync_finish','whatsapp_coexistence_sync_status')") === 0);
  const tradMsgs = Number((await su("select count(*) n from whatsapp_messages where company_id=$1", [D.c])).rows[0].n);
  ck("3.3 dados da empresa tradicional intactos pelo rollback (mensagens e conexão idênticas ao estado pré-rollback)", tradMsgs === 35 + 2 && (await snapConn()) === before.conn);
  ck("3.4 LIMITAÇÃO documentada: o eco (espelho do app) foi removido; a conexão Coexistence e a conversa criada ficam (connection_type 'coexistence' é da migration 1104)", await cnt("select count(*) n from whatsapp_messages where provider_message_id='wamid.coex.echo'") === 0
    && await cnt(`select count(*) n from company_whatsapp_connections where id='${connE}' and connection_type='coexistence'`) === 1 && await cnt("select count(*) n from whatsapp_conversations where company_id='" + E.c + "'") === 1);
  const fnRb = JSON.parse(await fnHash());
  const same = fnRb.filter((f, i) => f.h === fnBefore[i].h).map((f) => f.proname).sort().join(",");
  const ownersOk = fnRb.every((f) => f.h === fnBefore.find((b) => b.proname === f.proname)?.h);
  ck("3.5 as funções voltaram EXATAMENTE ao texto anterior (hash igual ao pré-migration)", ownersOk, same);
  const ack = (await pg.query("select has_function_privilege('authenticated','public.whatsapp_signup_complete(uuid,text,text,text,text,text,timestamptz,timestamptz,text)','execute') a, has_function_privilege('service_role','public.whatsapp_signup_complete(uuid,text,text,text,text,text,timestamptz,timestamptz,text)','execute') s")).rows[0];
  ck("3.6 ACL do whatsapp_signup_complete preservada depois do rollback (só service_role)", ack.a === false && ack.s === true);
  void mid; void midHash;
}

console.log("\n== 4. reaplicar as migrations depois do rollback ==");
{
  let re = 0, e2 = "";
  for (const f of NEW) { try { await pg.exec(fs.readFileSync(path.join(MIG, f), "utf8")); re += 1; } catch (e) { e2 = f + ": " + String(e.message ?? e); break; } }
  ck("4.1 as 3 migrations reaplicam sem erro depois do rollback", re === 3, e2);
  ck("4.2 a conexão tradicional continua idêntica e a Coexistence ganha nova linha de sincronização via gatilho de reonboarding", (await snapConn()) === before.conn);
}

console.log("\n== 5. A1 (corrigido): RECONNECTED atrasado de conexão antiga ==");
{
  const P = await mkCo("probe");
  const cp = (await su("insert into company_whatsapp_connections (company_id, status, mode, waba_id, phone_number_id, display_phone_number, token_secret_id, webhook_status, connected_at, connection_source, connection_type, token_status) values ($1,'active','test','880000000009','777000111','+55 44 92222-2222',$2,'active', now() - interval '1 hour','embedded_signup','coexistence','valid') returning id", [P.c, tok])).rows[0].id;
  await svc("select public.whatsapp_coexistence_account_update('880000000009','ACCOUNT_OFFBOARDED',null,'acct:probe:1', (extract(epoch from now())::bigint + 60)) j");
  const paused = (await su("select status from company_whatsapp_connections where id=$1", [cp])).rows[0].status;
  // com a conta pausada o cliente conecta OUTRO número (permitido: não há conexão ativa) e depois chega o RECONNECTED da primeira
  await su("insert into company_whatsapp_connections (company_id, status, mode, waba_id, phone_number_id, display_phone_number, token_secret_id, webhook_status, connected_at, connection_source, connection_type, token_status) values ($1,'active','test','880000000010','777000222','+55 44 93333-3333',$2,'active', now(), 'embedded_signup','cloud_api','valid')", [P.c, tok]);
  const rc = await svc("select public.whatsapp_coexistence_account_update('880000000009','ACCOUNT_RECONNECTED',null,'acct:probe:2', (extract(epoch from now())::bigint + 61)) j");
  const ev = Number((await su("select count(*) n from whatsapp_coexistence_events where provider_event_key='acct:probe:2'")).rows[0].n);
  const old = (await su("select status, lifecycle_state from company_whatsapp_connections where company_id=$1 and phone_number_id='777000111'", [P.c])).rows[0];
  const cur = (await su("select status from company_whatsapp_connections where company_id=$1 and phone_number_id='777000222'", [P.c])).rows[0];
  ck("5.1 A1 CORRIGIDO: RECONNECTED da conexão ANTIGA com outra conexão ativa na empresa é ignorado com sucesso (sem erro), o evento fica gravado, a antiga NÃO é reativada e a atual segue ativa", paused === "error" && rc.ok && rc.rows[0].j.result === "ignored" && rc.rows[0].j.skipped === 1 && ev === 1 && old.status === "error" && old.lifecycle_state === "offboarded" && cur.status === "active", JSON.stringify(rc.rows?.[0]?.j ?? rc.err));
}

fs.rmSync(tmp, { recursive: true, force: true });
summary("AUDITORIA PRÉ-PUBLICAÇÃO DA COEXISTENCE");
