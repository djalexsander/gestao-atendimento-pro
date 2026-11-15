// Coexistence — JORNADA INTEGRADA (Etapas 2+3+4), tudo local: Edge whatsapp-signup-complete + Edge whatsapp-webhook + Edge
// whatsapp-coexistence-sync (handlers REAIS) sobre o banco REAL (PGlite com TODAS as migrations) e uma Meta simulada.
// Uma empresa em Coexistence faz o onboarding, recebe cliente, o dono responde pelo celular (eco), a IA se cala, a sincronização é pedida na
// ordem certa, a conta é pausada/reativada; ao mesmo tempo uma empresa Cloud API tradicional conecta e opera sem sofrer nenhum efeito.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadAll } from "./full-db.mjs";

const root = "D:/orça facil";
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coexe2e-"));
const loadTs = async (src, name, rewrites = []) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(root, src), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
  return import(pathToFileURL(path.join(tmp, name)).href);
};
await loadTs("supabase/functions/_shared/whatsapp-graph.ts", "whatsapp-graph.mjs");
const SG = await loadTs("supabase/functions/_shared/whatsapp-signup-graph.ts", "whatsapp-signup-graph.mjs", [['"./whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
const rw = [['"../_shared/whatsapp-signup-graph.ts"', '"./whatsapp-signup-graph.mjs"'], ['"../_shared/whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']];
const SC = await loadTs("supabase/functions/whatsapp-signup-complete/handler.ts", "signup.mjs", rw);
const SY = await loadTs("supabase/functions/whatsapp-coexistence-sync/handler.ts", "sync.mjs", rw);
const WH = await loadTs("supabase/functions/whatsapp-webhook/handler.ts", "webhook.mjs");

const { pg, ck, as: as0, su: su00, summary } = await loadAll(undefined, { legacyIaMirror: false });
let chain = Promise.resolve();
const mutex = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r; };
const as = (...a) => mutex(() => as0(...a));
const su = (sql, params) => mutex(async () => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su00(sql, params); });
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
const APP_ID = "1234567890", APP_SECRET = "APP-SECRET-E2E", VERSION = "v99.0";
await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id=$1, embedded_signup_config_id='9876543210'", [APP_ID]);

let seq = 900, pn = 950000000;
async function mkCo(tag) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "e2e-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
  const out = { c, ids: {}, pnid: String(++pn), waba: String(960000000 + seq) };
  for (const role of ["owner", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u); out.ids[role] = u;
  }
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','e2e', now() + interval '1 day'), ($1,'ia','e2e', now() + interval '1 day')", [c]);
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1, true, now())", [c]);
  return out;
}
const conns = async (co) => (await su("select * from company_whatsapp_connections where company_id=$1 order by created_at", [co.c])).rows;

// ---------------------------------------------------------------- Meta simulada (um objeto, comportamento por número)
const modeOf = {}; // phone_number_id -> { isOnBizApp, platformType }
const calls = [];
const TOKEN = (code) => `EAAB-E2E-TOKEN-${code}-0123456789`;
const meta = {
  async exchangeCode(a) { calls.push("exchange"); return { ok: true, token: TOKEN(a.code), expiresInSeconds: null }; },
  async listWabaPhones(a) { calls.push("list"); return { ok: true, phones: Object.keys(modeOf).filter((k) => modeOf[k].waba === a.wabaId).map((k) => ({ id: k, displayPhoneNumber: "+55 44 90000-0000", verifiedName: "Loja" })) }; },
  async getPhoneStatus(a) { calls.push("status:" + a.phoneNumberId); const m = modeOf[a.phoneNumberId]; return { ok: true, isOnBizApp: m.isOnBizApp, platformType: m.platformType }; },
  async registerPhone(a) { calls.push("register:" + a.phoneNumberId); return { ok: true }; },
  async subscribeApp() { calls.push("subscribe"); return { ok: true }; },
  async listSubscribedAppIds() { return { ok: true, appIds: [APP_ID] }; },
};
const NAMED = { whatsapp_signup_reserve: ["p_state"], whatsapp_signup_store_token: ["p_session_id", "p_token", "p_expires_at"], whatsapp_signup_fail: ["p_session_id", "p_error_code"],
  whatsapp_registration_prepare: ["p_session_id", "p_phone_number_id", "p_waba_id"], whatsapp_registration_store_pin: ["p_session_id", "p_registration_id", "p_pin", "p_source"],
  whatsapp_registration_begin_attempt: ["p_session_id", "p_registration_id"], whatsapp_registration_finish_attempt: ["p_attempt_id", "p_outcome", "p_meta_code"], whatsapp_registration_link: ["p_session_id", "p_registration_id"],
  whatsapp_signup_complete: ["p_session_id", "p_waba_id", "p_phone_number_id", "p_display_phone_number", "p_business_name", "p_meta_business_id", "p_registered_at", "p_webhook_subscribed_at", "p_connection_type"] };
const rpcNamed = async (fn, args) => {
  const keys = NAMED[fn] ?? Object.keys(args);
  const params = keys.map((k) => (args[k] !== null && args[k] !== undefined && typeof args[k] === "object" ? JSON.stringify(args[k]) : (args[k] ?? null)));
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${args[k] !== null && args[k] !== undefined && typeof args[k] === "object" ? "::jsonb" : ""}`).join(", ")}) j`;
  const r = await svc(sql, params);
  return r.ok ? { data: r.rows[0].j, error: null } : { data: null, error: { message: r.err, code: r.code } };
};
const logs = [];
const oc = { warn: console.warn, error: console.error, info: console.info };
const capture = async (fn) => { console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a)); try { return await fn(); } finally { Object.assign(console, oc); } };
const begin = async (co) => (await co.owner("select public.whatsapp_signup_begin($1) j", [co.c])).rows[0].j.state;
let codeN = 0;
async function signup(co, { pnid = co.pnid, event }) {
  const state = await begin(co);
  const code = "AQD-E2E-CODE-" + ++codeN;
  const body = JSON.stringify({ state, code, waba_id: co.waba, ...(pnid ? { phone_number_id: pnid } : {}), ...(event ? { signup_event: event } : {}) });
  const req = new Request("https://x/functions/v1/whatsapp-signup-complete", { method: "POST", headers: { authorization: `Bearer jwt-${co.ids.owner}`, "content-type": "application/json" }, body });
  const deps = {
    authenticate: async (a) => { const m = /^Bearer jwt-(.+)$/.exec(a); return m ? { userId: m[1] } : null; }, rpc: rpcNamed,
    platform: async () => { const r = (await su("select embedded_signup_enabled e, meta_app_id a from whatsapp_platform_settings")).rows[0]; return { enabled: r.e, appId: r.a }; },
    findPhoneOwner: async (p) => { const r = (await su("select company_id from company_whatsapp_connections where phone_number_id=$1 limit 1", [p])).rows[0]; return r ? { companyId: r.company_id } : null; },
    findActiveConnection: async (c) => { const r = (await su("select phone_number_id from company_whatsapp_connections where company_id=$1 and status='active' limit 1", [c])).rows[0]; return r ? { phoneNumberId: r.phone_number_id } : null; },
    pilotAuthorized: async (c) => { const r = (await su("select authorized from whatsapp_signup_pilot_companies where company_id=$1", [c])).rows[0]; return r ? r.authorized === true : false; },
    meta, graphVersion: VERSION, appSecret: APP_SECRET,
  };
  const n0 = calls.length;
  const res = await capture(() => SC.handleWhatsappSignupComplete(req, deps));
  return { status: res.status, j: await res.json(), calls: calls.slice(n0), code };
}
async function webhook(payload) {
  const raw = JSON.stringify(payload);
  const req = new Request("https://x/functions/v1/whatsapp-webhook", { method: "POST", headers: { "x-hub-signature-256": "sha256=" + (await WH.hmacSha256Hex(APP_SECRET, raw)) }, body: raw });
  const res = await capture(() => WH.handleWhatsappWebhook(req, { verifyToken: "v", appSecret: APP_SECRET, db: { rpc: rpcNamed } }));
  return { status: res.status, j: await res.json() };
}
const syncFetch = []; let syncPlan = [];
const syncMeta = SG.createSmbSyncMeta(async (url, init) => { syncFetch.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); const s = syncPlan.shift() ?? { status: 200, body: { messaging_product: "whatsapp", request_id: "req-e2e-" + syncFetch.length } }; return { ok: s.status < 300, status: s.status, text: async () => JSON.stringify(s.body ?? {}) }; });
async function sync(co, type) {
  const req = new Request("https://x/functions/v1/whatsapp-coexistence-sync", { method: "POST", headers: { authorization: `Bearer jwt-${co.ids.owner}`, "content-type": "application/json" }, body: JSON.stringify({ company_id: co.c, type }) });
  const res = await capture(() => SY.handleWhatsappCoexistenceSync(req, { authenticate: async (a) => { const m = /^Bearer jwt-(.+)$/.exec(a); return m ? { userId: m[1] } : null; }, rpc: rpcNamed, meta: syncMeta, graphVersion: VERSION }));
  return { status: res.status, j: await res.json() };
}
const wrap = (waba, field, value, time = 1700000000) => ({ object: "whatsapp_business_account", entry: [{ id: waba, time, changes: [{ field, value: { messaging_product: "whatsapp", ...value } }] }] });
const mdt = (pnid) => ({ display_phone_number: "554490000000", phone_number_id: pnid });
const FROM = "5544999990001";
const ingest = (pnid, from, body, wamid) => webhook(wrap("x", "messages", { metadata: mdt(pnid), contacts: [{ wa_id: from, profile: { name: "Maria" } }], messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] }));
const aiS = (co, ...a) => co.owner("select public.whatsapp_ai_update_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) j", a);
const aiBase = (c) => [c, true, "auto", "Espeto do Alex", "cordial", "Vendemos espetinho a R$ 12,00.", null, true, 12, true, true, null, null, null];
const convOf = async (co) => (await su("select * from whatsapp_conversations where company_id=$1 and deleted_at is null order by created_at limit 1", [co.c])).rows[0];
const jobs = async (cid, w = "true") => (await su(`select * from whatsapp_ai_jobs where conversation_id=$1 and ${w}`, [cid])).rows;

const X = await mkCo("COEX"), T = await mkCo("TRAD");
modeOf[X.pnid] = { waba: X.waba, isOnBizApp: true, platformType: "CLOUD_API" };
modeOf[T.pnid] = { waba: T.waba, isOnBizApp: false, platformType: "NOT_APPLICABLE" };

console.log("\n== 1. onboarding: Coexistence e Cloud API tradicional lado a lado ==");
const sx = await signup(X, { event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", pnid: null });
const cx = (await conns(X))[0];
ck("1.1 Coexistence (evento sem phone_number_id): número descoberto pela WABA e modo confirmado pelo Graph; SEM /register, SEM PIN", sx.status === 200 && sx.j.connection_type === "coexistence" && cx.phone_number_id === X.pnid && cx.connection_type === "coexistence"
  && cx.registered_at === null && !sx.calls.some((c) => c.startsWith("register")) && Number((await su("select count(*) n from vault.secrets where name like 'wa_pin_%'")).rows[0].n) === 0, JSON.stringify(sx));
const st = await signup(T, { event: "FINISH" });
const ct = (await conns(T))[0];
ck("1.2 Cloud API tradicional: dois Graph (modo + guarda) e /register UMA vez com PIN no Vault; connection_type=cloud_api, registered_at preenchido", st.status === 200 && ct.connection_type === "cloud_api" && !!ct.registered_at
  && st.calls.filter((c) => c.startsWith("status")).length === 2 && st.calls.filter((c) => c.startsWith("register")).length === 1 && Number((await su("select count(*) n from vault.secrets where name like 'wa_pin_%'")).rows[0].n) === 1);
const syncRowX = (await su("select * from whatsapp_coexistence_sync where connection_id=$1", [cx.id])).rows[0];
ck("1.3 o onboarding da Coexistence abriu a janela de 24 h (e SÓ ele: a empresa tradicional não tem linha de sincronização)", !!syncRowX && syncRowX.cycle === 1 && !(await su("select 1 from whatsapp_coexistence_sync where connection_id=$1", [ct.id])).rows.length
  && new Date(syncRowX.deadline_at) - new Date(syncRowX.onboarded_at) === 24 * 3600 * 1000);
ck("1.4 isolamento: cada empresa só enxerga a própria conexão; tokens distintos no Vault, nenhum no corpo das respostas", (await conns(X)).length === 1 && (await conns(T)).length === 1 && cx.token_secret_id !== ct.token_secret_id && !JSON.stringify(sx.j).includes("EAAB") && !JSON.stringify(st.j).includes("EAAB"));

console.log("\n== 2. atendimento: cliente escreve, dono responde pelo celular, a IA se cala ==");
for (const co of [X, T]) { const r = await aiS(co, ...aiBase(co.c)); if (!r.ok) console.log("IA settings erro", r.err); }
await su("insert into whatsapp_test_recipients (company_id, connection_id, phone_e164) values ($1,$2,$3), ($4,$5,$3)", [X.c, cx.id, FROM, T.c, ct.id]);
await ingest(X.pnid, FROM, "oi, tem espetinho?", "wamid.x.in1");
await ingest(T.pnid, FROM, "oi, tem espetinho?", "wamid.t.in1");
const cvX = await convOf(X), cvT = await convOf(T);
ck("2.1 pré-condição: as duas empresas têm job da IA pendente e IA ativa", (await jobs(cvX.id, "status='pending'")).length === 1 && (await jobs(cvT.id, "status='pending'")).length === 1 && cvX.ai_control === "inherit");
const e1 = await webhook(wrap(X.waba, "smb_message_echoes", { metadata: mdt(X.pnid), message_echoes: [{ from: "554490000000", to: FROM, id: "wamid.x.echo1", timestamp: String(Math.floor(Date.now() / 1000) + 5), type: "text", text: { body: "Oi! Já te respondo por aqui." } }] }));
ck("2.2 eco (resposta no celular): gravado como saída humana pelo app; IA da Coexistence PAUSADA e job cancelado", e1.status === 200 && e1.j.stored === 1 && (await convOf(X)).ai_control === "human" && (await jobs(cvX.id, "status='pending'")).length === 0
  && (await su("select sent_via, origin, sent_by_user_id from whatsapp_messages where provider_message_id='wamid.x.echo1'")).rows[0].sent_via === "business_app");
const eT = await webhook(wrap(T.waba, "smb_message_echoes", { metadata: mdt(T.pnid), message_echoes: [{ from: "554490000000", to: FROM, id: "wamid.t.echo1", timestamp: String(Math.floor(Date.now() / 1000) + 5), type: "text", text: { body: "eco indevido" } }] }));
ck("2.3 empresa Cloud API tradicional: o mesmo tipo de evento NÃO a afeta (IA ativa, job pendente, nada gravado)", eT.status === 200 && (await convOf(T)).ai_control === "inherit" && (await jobs(cvT.id, "status='pending'")).length === 1 && !(await su("select 1 from whatsapp_messages where provider_message_id='wamid.t.echo1'")).rows.length);
await ingest(X.pnid, FROM, "e o preço?", "wamid.x.in2");
const j2 = (await jobs(cvX.id, "status in ('pending','processing')"))[0];
let blocked = true;
if (j2) { await su("update whatsapp_ai_jobs set run_after = now() - interval '1 second' where id=$1", [j2.id]); const p = await svc("select public.whatsapp_ai_prepare_auto($1) j", [j2.id]); blocked = p.ok && p.rows[0].j.proceed === false; }
ck("2.4 nova pergunta do cliente depois do eco: a IA NÃO prossegue (nenhuma resposta automática por cima do humano)", blocked && (await su("select count(*) n from whatsapp_messages where conversation_id=$1 and origin='ai_auto'", [cvX.id])).rows[0].n == 0);
const back = await X.owner("select public.whatsapp_set_conversation_ai_control($1,'inherit') j", [cvX.id]);
ck("2.5 o dono devolve a conversa para a IA e ela volta a poder responder", back.ok && (await convOf(X)).ai_control === "inherit");

console.log("\n== 3. sincronização inicial controlada (sem importar) ==");
const convBefore = Number((await su("select (select count(*) from whatsapp_conversations) + (select count(*) from whatsapp_messages) + (select count(*) from customers) n")).rows[0].n);
const off = await sync(X, "contacts");
ck("3.1 trava mestra desligada (padrão): pedido recusado e a Meta não é chamada", off.status === 503 && off.j.code === "sync_disabled" && syncFetch.length === 0);
await su("update whatsapp_platform_settings set coexistence_sync_enabled=true");
const hFirst = await sync(X, "history");
const c1 = await sync(X, "contacts");
const c2 = await sync(X, "contacts");
const h1 = await sync(X, "history");
ck("3.2 ordem e unicidade: histórico antes dos contatos recusado; contatos aceitos UMA vez; histórico depois dos contatos aceito; chamadas exatas na Meta", hFirst.j.code === "contacts_first" && c1.status === 200 && c2.j.code === "already_requested" && h1.status === 200
  && syncFetch.length === 2 && syncFetch[0].body.sync_type === "smb_app_state_sync" && syncFetch[1].body.sync_type === "history" && syncFetch.every((f) => f.url === `https://graph.facebook.com/v99.0/${X.pnid}/smb_app_data` && f.auth === `Bearer ${TOKEN(sx.code)}`));
const tsy = await sync(T, "contacts");
ck("3.3 a empresa Cloud API tradicional não consegue pedir sincronização (inelegível) e nada foi enviado à Meta por ela", tsy.status === 409 && tsy.j.code === "connection_not_eligible" && syncFetch.length === 2);
await webhook(wrap(X.waba, "smb_app_state_sync", { metadata: mdt(X.pnid), state_sync: [{ type: "contact", action: "add", contact: { full_name: "Fulano", phone_number: "5544977776666" }, metadata: { timestamp: "1" } }] }));
await webhook(wrap(X.waba, "history", { metadata: mdt(X.pnid), history: [{ metadata: { phase: 0, chunk_order: 1, progress: 50 }, threads: [{ id: "5544977776666", messages: [{ id: "wamid.h1", type: "text", text: { body: "SEGREDO-HISTORICO" } }] }] }] }, 1700000100));
await webhook(wrap(X.waba, "history", { metadata: mdt(X.pnid), history: [{ metadata: { phase: 2, chunk_order: 2, progress: 100 }, threads: [] }] }, 1700000200));
const s3 = (await su("select * from whatsapp_coexistence_sync where connection_id=$1", [cx.id])).rows[0];
ck("3.4 webhooks atualizam o estado (contatos synced, histórico completed 100%) e NADA é importado para o Inbox", s3.contacts_status === "synced" && s3.history_status === "completed" && s3.history_progress === 100
  && Number((await su("select (select count(*) from whatsapp_conversations) + (select count(*) from whatsapp_messages) + (select count(*) from customers) n")).rows[0].n) === convBefore
  && !(await su("select 1 from whatsapp_messages where provider_message_id='wamid.h1'")).rows.length);
await su("update whatsapp_platform_settings set coexistence_sync_enabled=false");

console.log("\n== 4. ciclo de vida da conta e bloqueio de envio ==");
const q = (await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_by_user_id, client_request_id)
  values ($1,$2,$3,null,'outbound','text','na fila','queued','human',$4,gen_random_uuid()) returning id`, [X.c, cx.id, cvX.id, X.ids.owner])).rows[0].id;
ck("4.0 pré-condição: envio liberado com a conexão ativa", (await svc("select public.whatsapp_get_send_context($1) j", [q])).rows[0].j.ok === true);
const NOW = Math.floor(Date.now() / 1000);
await webhook(wrap(X.waba, "account_update", { event: "ACCOUNT_OFFBOARDED" }, NOW + 10));
ck("4.1 ACCOUNT_OFFBOARDED: envio bloqueado (contexto recusa); a empresa tradicional segue enviando", (await svc("select public.whatsapp_get_send_context($1) j", [q])).rows[0].j.error === "connection_inactive"
  && (await conns(T))[0].status === "active");
await webhook(wrap(X.waba, "account_update", { event: "ACCOUNT_RECONNECTED" }, NOW + 20));
ck("4.2 ACCOUNT_RECONNECTED: envio liberado de novo", (await svc("select public.whatsapp_get_send_context($1) j", [q])).rows[0].j.ok === true);
await webhook(wrap(X.waba, "account_update", { event: "PARTNER_REMOVED", disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" } }, NOW + 30));
ck("4.3 PARTNER_REMOVED: desconectada e sem envio; só reconectando pelo Embedded Signup (novo ciclo de sincronização)", (await conns(X))[0].status === "disconnected" && (await svc("select public.whatsapp_get_send_context($1) j", [q])).rows[0].j.ok === false);
modeOf[X.pnid] = { waba: X.waba, isOnBizApp: true, platformType: "CLOUD_API" };
const re = await signup(X, { event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", pnid: X.pnid });
const cx2 = (await conns(X))[0];
const s4 = (await su("select cycle, contacts_status from whatsapp_coexistence_sync where connection_id=$1", [cx.id])).rows[0];
ck("4.4 reconexão pelo Embedded Signup: mesma linha reativada (status active, ciclo de vida normal) e NOVO ciclo de sincronização zerado", re.status === 200 && cx2.id === cx.id && cx2.status === "active" && cx2.lifecycle_state === "normal" && s4.cycle === 2 && s4.contacts_status === "not_requested");

console.log("\n== 5. vazamentos e estado final ==");
const all = logs.join("");
ck("5.1 nenhum log contém token do cliente, App Secret, texto de mensagem, telefone ou request_id", !all.includes("EAAB-E2E") && !all.includes(APP_SECRET) && !all.includes("Oi! Já te respondo") && !all.includes(FROM) && !all.includes("SEGREDO-HISTORICO") && !all.includes("req-e2e"));
const dump = JSON.stringify((await su("select * from whatsapp_coexistence_events")).rows) + JSON.stringify((await su("select * from whatsapp_coexistence_sync_attempts")).rows) + JSON.stringify((await su("select * from whatsapp_webhook_events")).rows);
ck("5.2 trilhas (eventos, tentativas, webhook_events) sem texto, telefone nem token", !/SEGREDO|Oi! Já|5544977776666|EAAB/.test(dump));
ck("5.3 tokens só no Vault: nenhuma coluna de conexão/sessão contém o token", !JSON.stringify((await su("select * from company_whatsapp_connections")).rows).includes("EAAB-E2E") && !JSON.stringify((await su("select * from whatsapp_signup_sessions")).rows).includes("EAAB-E2E"));

fs.rmSync(tmp, { recursive: true, force: true });
summary("COEXISTENCE E2E (JORNADA INTEGRADA)");
