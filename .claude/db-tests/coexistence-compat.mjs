// Coexistence — COMPATIBILIDADE ENTRE VERSÕES durante a publicação (tudo local).
// Matriz: Edge/webhook ANTIGOS (código do HEAD) x banco NOVO (com as 3 migrations) e Edge/webhook NOVOS x banco ANTIGO (sem elas).
// Prova a ordem segura de publicação: migrations -> Edge signup-complete -> webhook -> (só então) assinar os campos na Meta.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAll } from "./full-db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");   // independe de onde o repositório foi clonado
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coexcompat-"));
const tsOut = (code) => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const srcNow = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
// "versão antiga" = último commit ANTES da Coexistence (dc54164). Não usar HEAD: depois do commit da Coexistence, HEAD já é o código novo.
const OLD_REF = process.env.OLD_REF ?? "dc54164";
const srcHead = (rel) => execFileSync("git", ["show", `${OLD_REF}:${rel}`], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const load = async (variant, rel, name, get, rewrites) => {
  let code = tsOut(get(rel));
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  const f = `${variant}-${name}`;
  fs.writeFileSync(path.join(tmp, f), code);
  return import(pathToFileURL(path.join(tmp, f)).href);
};
const rw = (v) => [['"../_shared/whatsapp-signup-graph.ts"', `"./${v}-graph.mjs"`], ['"../_shared/whatsapp-graph.ts"', `"./${v}-wgraph.mjs"`], ['"./whatsapp-graph.ts"', `"./${v}-wgraph.mjs"`]];
const bundle = async (variant, get) => {
  await load(variant, "supabase/functions/_shared/whatsapp-graph.ts", "wgraph.mjs", get, []);
  const G = await load(variant, "supabase/functions/_shared/whatsapp-signup-graph.ts", "graph.mjs", get, rw(variant));
  const SC = await load(variant, "supabase/functions/whatsapp-signup-complete/handler.ts", "signup.mjs", get, rw(variant));
  const WH = await load(variant, "supabase/functions/whatsapp-webhook/handler.ts", "webhook.mjs", get, []);
  return { G, SC, WH };
};
const OLD = await bundle("old", srcHead);
const NEW = await bundle("new", srcNow);

// ---- bancos: NOVO (todas as migrations) e ANTIGO (sem as 3 da Coexistence) ----
const MIG = path.join(root, "supabase/migrations");
const NEWMIG = ["20261123010000", "20261124010000", "20261125010000"];
// migrations POSTERIORES que dependem de objetos da Coexistence (ex.: 7.11H altera whatsapp_ingest_echo): não existem no banco "antigo" por definição
const DEPENDENT = ["20261206010000"];
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-oldcoex-"));
for (const f of fs.readdirSync(MIG)) if (f.endsWith(".sql") && !NEWMIG.some((p) => f.startsWith(p)) && !DEPENDENT.some((p) => f.startsWith(p))) fs.copyFileSync(path.join(MIG, f), path.join(oldDir, f));
const dbNew = await loadAll(undefined, { legacyIaMirror: false });
const dbOld = await loadAll(oldDir, { legacyIaMirror: false });
const { ck, summary } = dbNew;

const APP_ID = "1234567890", APP_SECRET = "APP-SECRET-COMPAT", VERSION = "v99.0";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const logs = [];
const oc = { warn: console.warn, error: console.error, info: console.info };
const capture = async (fn) => { console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a)); try { return await fn(); } finally { Object.assign(console, oc); } };

async function world(db, tag) {
  const { pg, as, su: su0 } = db;
  const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
  await pg.exec(`
    do $d$ begin
      if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='vault' and c.relname='decrypted_secrets' and c.relkind='r') then drop table vault.decrypted_secrets; end if;
    end $d$;
    create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
    create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
    create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
    declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id into v; return v; end $f$;`);
  await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id=$1, embedded_signup_config_id='9876543210'", [APP_ID]);
  const cr = await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "cp-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`]);
  if (!cr.ok) throw new Error("companies: " + cr.err);
  const c = cr.rows[0].id;
  const u = id(7000 + tag.length);
  await su(`insert into auth.users (id,email) values ('${u}','o-${tag}@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','o-${tag}@x.com','o') on conflict (user_id) do update set full_name = excluded.full_name`);
  await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [c, u]);
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','compat', now() + interval '1 day')", [c]);
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1, true, now())", [c]);
  const svc = (sql, params) => as("service_role", null, sql, params);
  const NAMED = { whatsapp_signup_reserve: ["p_state"], whatsapp_signup_store_token: ["p_session_id", "p_token", "p_expires_at"], whatsapp_signup_fail: ["p_session_id", "p_error_code"],
    whatsapp_registration_prepare: ["p_session_id", "p_phone_number_id", "p_waba_id"], whatsapp_registration_store_pin: ["p_session_id", "p_registration_id", "p_pin", "p_source"],
    whatsapp_registration_begin_attempt: ["p_session_id", "p_registration_id"], whatsapp_registration_finish_attempt: ["p_attempt_id", "p_outcome", "p_meta_code"], whatsapp_registration_link: ["p_session_id", "p_registration_id"],
    whatsapp_signup_complete: ["p_session_id", "p_waba_id", "p_phone_number_id", "p_display_phone_number", "p_business_name", "p_meta_business_id", "p_registered_at", "p_webhook_subscribed_at", "p_connection_type"] };
  const rpc = async (fn, args) => {
    const keys = NAMED[fn] ?? Object.keys(args);
    const params = keys.map((k) => (args[k] !== null && args[k] !== undefined && typeof args[k] === "object" ? JSON.stringify(args[k]) : (args[k] ?? null)));
    const r = await svc(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${args[k] !== null && args[k] !== undefined && typeof args[k] === "object" ? "::jsonb" : ""}`).join(", ")}) j`, params);
    return r.ok ? { data: r.rows[0].j, error: null } : { data: null, error: { message: r.err, code: r.code } };
  };
  const pnid = String(990000000 + tag.length * 7), waba = String(970000000 + tag.length);
  const calls = [];
  const meta = (mode) => ({
    async exchangeCode(a) { calls.push("exchange"); return { ok: true, token: `EAAB-COMPAT-${a.code}-0123456789`, expiresInSeconds: null }; },
    async listWabaPhones() { calls.push("list"); return { ok: true, phones: [{ id: pnid, displayPhoneNumber: "+55 44 90000-0000", verifiedName: "Loja" }] }; },
    async getPhoneStatus() { calls.push("status"); return { ok: true, isOnBizApp: mode.isOnBizApp, platformType: mode.platformType }; },
    async registerPhone() { calls.push("register"); return { ok: true }; },
    async subscribeApp() { calls.push("subscribe"); return { ok: true }; },
    async listSubscribedAppIds() { return { ok: true, appIds: [APP_ID] }; },
  });
  let n = 0;
  async function signup(Handler, body, mode) {
    const state = (await as("authenticated", u, "select public.whatsapp_signup_begin($1) j", [c])).rows[0].j.state;
    const req = new Request("https://x/functions/v1/whatsapp-signup-complete", { method: "POST", headers: { authorization: `Bearer jwt-${u}`, "content-type": "application/json" }, body: JSON.stringify({ state, code: "AQD-COMPAT-" + ++n, waba_id: waba, ...body }) });
    const m = meta(mode); calls.length = 0;
    const res = await capture(() => Handler.handleWhatsappSignupComplete(req, {
      authenticate: async (a) => { const x = /^Bearer jwt-(.+)$/.exec(a); return x ? { userId: x[1] } : null; }, rpc,
      platform: async () => { const r = (await su("select embedded_signup_enabled e, meta_app_id a from whatsapp_platform_settings")).rows[0]; return { enabled: r.e, appId: r.a }; },
      findPhoneOwner: async (p) => { const r = (await su("select company_id from company_whatsapp_connections where phone_number_id=$1 limit 1", [p])).rows[0]; return r ? { companyId: r.company_id } : null; },
      findActiveConnection: async (cc) => { const r = (await su("select phone_number_id from company_whatsapp_connections where company_id=$1 and status='active' limit 1", [cc])).rows[0]; return r ? { phoneNumberId: r.phone_number_id } : null; },
      pilotAuthorized: async (cc) => { const r = (await su("select authorized from whatsapp_signup_pilot_companies where company_id=$1", [cc])).rows[0]; return r ? r.authorized === true : false; },
      meta: m, graphVersion: VERSION, appSecret: APP_SECRET,
    }));
    const j = await res.json();
    return { status: res.status, j, calls: [...calls], state };
  }
  async function webhook(Handler, payload) {
    const raw = JSON.stringify(payload);
    const req = new Request("https://x/functions/v1/whatsapp-webhook", { method: "POST", headers: { "x-hub-signature-256": "sha256=" + (await Handler.hmacSha256Hex(APP_SECRET, raw)) }, body: raw });
    const res = await capture(() => Handler.handleWhatsappWebhook(req, { verifyToken: "v", appSecret: APP_SECRET, db: { rpc } }));
    return { status: res.status, j: await res.json() };
  }
  return { su, c, u, pnid, waba, signup, webhook, conns: async () => (await su("select * from company_whatsapp_connections where company_id=$1", [c])).rows };
}
const wrap = (waba, field, value) => ({ object: "whatsapp_business_account", entry: [{ id: waba, time: 1700000000, changes: [{ field, value: { messaging_product: "whatsapp", ...value } }] }] });
const mdt = (pn) => ({ display_phone_number: "554490000000", phone_number_id: pn });
const inbound = (pn, w) => wrap("1", "messages", { metadata: mdt(pn), contacts: [{ wa_id: "5544999990001", profile: { name: "M" } }], messages: [{ from: "5544999990001", id: w, timestamp: "1700000001", type: "text", text: { body: "oi" } }] });
const echoPl = (pn, w) => wrap("1", "smb_message_echoes", { metadata: mdt(pn), message_echoes: [{ from: "554490000000", to: "5544999990001", id: w, timestamp: "1700000002", type: "text", text: { body: "eco" } }] });
const acct = (waba) => wrap(waba, "account_update", { event: "PARTNER_REMOVED" });
const hist = (pn) => wrap("1", "history", { metadata: mdt(pn), history: [{ metadata: { phase: 0, chunk_order: 1, progress: 10 }, threads: [] }] });

console.log("\n== A. código ANTIGO (HEAD) x banco NOVO (migrations aplicadas ANTES dos deploys) ==");
{
  const W = await world(dbNew, "A");
  const r = await W.signup(OLD.SC, { phone_number_id: W.pnid }, { isOnBizApp: false, platformType: "NOT_APPLICABLE" });
  const c = (await W.conns())[0];
  ck("A.1 Edge signup-complete ANTIGA com a RPC NOVA: fluxo Cloud API tradicional conclui (registra, assina, grava cloud_api)", r.status === 200 && c.connection_type === "cloud_api" && !!c.registered_at && r.calls.includes("register"), JSON.stringify(r.j));
  const w1 = await W.webhook(OLD.WH, inbound(W.pnid, "wamid.a.in"));
  ck("A.2 webhook ANTIGO com o banco NOVO: inbound continua sendo gravado", w1.status === 200 && w1.j.stored === 1);
  const before = Number((await W.su("select count(*) n from whatsapp_messages")).rows[0].n);
  const w2 = await W.webhook(OLD.WH, echoPl(W.pnid, "wamid.a.echo"));
  const w3 = await W.webhook(OLD.WH, acct(W.waba));
  const w4 = await W.webhook(OLD.WH, hist(W.pnid));
  ck("A.3 webhook ANTIGO recebendo os 4 campos novos: responde 200 e IGNORA (nada gravado, conexão intacta) — por isso o webhook novo precisa estar no ar ANTES de assinar os campos na Meta", w2.status === 200 && w3.status === 200 && w4.status === 200
    && w2.j.stored === 0 && Number((await W.su("select count(*) n from whatsapp_messages")).rows[0].n) === before && (await W.conns())[0].status === "active");
  const bodyNewFront = await W.signup(OLD.SC, { phone_number_id: W.pnid, signup_event: "FINISH" }, { isOnBizApp: false, platformType: "NOT_APPLICABLE" });
  ck("A.4 frontend NOVO (envia signup_event) com Edge ANTIGA: o campo extra é ignorado (200 ou recusa normal, nunca 5xx)", bodyNewFront.status < 500, String(bodyNewFront.status));
  const coexFront = await W.signup(OLD.SC, { signup_event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" }, { isOnBizApp: true, platformType: "CLOUD_API" });
  ck("A.5 frontend NOVO em modo Coexistence (sem phone_number_id) com Edge ANTIGA: recusado com 400, sem chamar a Meta e sem registrar nada", coexFront.status === 400 && !coexFront.calls.includes("register") && coexFront.calls.length === 0);
}

console.log("\n== B. código NOVO x banco ANTIGO (deploy ANTES das migrations: ordem errada) ==");
{
  const W = await world(dbOld, "B");
  const r = await W.signup(NEW.SC, { phone_number_id: W.pnid, signup_event: "FINISH" }, { isOnBizApp: false, platformType: "NOT_APPLICABLE" });
  const c = (await W.conns())[0];
  ck("B.1 Edge signup NOVA com a RPC ANTIGA: fluxo Cloud API tradicional AINDA conclui (a RPC antiga aceita cloud_api)", r.status === 200 && c.connection_type === "cloud_api" && !!c.registered_at, JSON.stringify(r.j));
  const W2 = await world(dbOld, "BB");
  const rc = await W2.signup(NEW.SC, { phone_number_id: W2.pnid, signup_event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" }, { isOnBizApp: true, platformType: "CLOUD_API" });
  ck("B.2 Edge NOVA em Coexistência com a RPC ANTIGA: falha FECHADA (sem /register, nenhuma conexão criada) — por isso as migrations vão ANTES", rc.status >= 400 && !rc.calls.includes("register") && (await W2.conns()).length === 0, JSON.stringify(rc.j));
  const w1 = await W.webhook(NEW.WH, inbound(W.pnid, "wamid.b.in"));
  ck("B.3 webhook NOVO com banco ANTIGO: inbound continua funcionando", w1.status === 200 && w1.j.stored === 1);
  const w2 = await W.webhook(NEW.WH, echoPl(W.pnid, "wamid.b.echo"));
  ck("B.4 webhook NOVO + banco ANTIGO + evento de eco: 500 transitório (a Meta reentrega depois das migrations) — nunca perde nem grava errado", w2.status === 500);
  const w3 = await W.webhook(NEW.WH, acct(W.waba));
  ck("B.5 webhook NOVO + banco ANTIGO + account_update: 500 transitório (nenhuma conexão alterada)", w3.status === 500 && (await W.conns())[0].status === "active");
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(oldDir, { recursive: true, force: true });
summary("COEXISTENCE — COMPATIBILIDADE ENTRE VERSÕES");
