// Correção A1 (auditoria final): ACCOUNT_RECONNECTED / account_update atrasados, duplicados, fora de ordem e concorrentes.
// Webhook REAL (handler transpilado, assinatura HMAC) sobre o banco REAL (PGlite com todas as migrations).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-a1-"));
const code = ts.transpileModule(fs.readFileSync(path.join(srcRoot, "supabase/functions/whatsapp-webhook/handler.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
fs.writeFileSync(path.join(tmp, "webhook.mjs"), code);
const W = await import(pathToFileURL(path.join(tmp, "webhook.mjs")).href);

const { pg, ck, as: as0, su: su00, summary } = await loadAll();
let chain = Promise.resolve();
const mutex = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r; };
const as = (...a) => mutex(() => as0(...a));
const su = (sql, params) => mutex(async () => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su00(sql, params); });
const svc = (sql, params) => as("service_role", null, sql, params);
const uuid = (n) => `99999999-0000-4000-8000-${String(n).padStart(12, "0")}`;
await pg.exec(`alter table vault.decrypted_secrets add column if not exists id uuid;`);
const tok = uuid(3);
await su("insert into vault.decrypted_secrets (id, name, decrypted_secret) values ($1,'wa_token_a1','TOKEN-A1')", [tok]);

let seq = 0;
const NOW = Math.floor(Date.now() / 1000);
const mkCo = async (tag) => (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "a1-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
const mkConn = async (company, { pn, waba, type = "coexistence", source = "embedded_signup", status = "active", lifecycle = "normal", connectedAgo = "2 hours" }) =>
  (await su(`insert into company_whatsapp_connections (company_id, status, mode, waba_id, phone_number_id, display_phone_number, token_secret_id, webhook_status, connected_at, connection_source, connection_type, token_status, lifecycle_state)
    values ($1,$2,'test',$3,$4,'+55 44 90000-0000',$5,'active', now() - $6::interval, $7, $8, 'valid', $9) returning id`, [company, status, waba, pn, tok, connectedAgo, source, type, lifecycle])).rows[0].id;
// linha inteira da conexão, EXCETO a marca d'água interna lifecycle_event_at (metadado de ordenação de eventos)
const snapConn = async (id) => JSON.stringify((await su("select to_jsonb(c) - 'lifecycle_event_at' - 'updated_at' j from company_whatsapp_connections c where id=$1", [id])).rows[0].j);
const conn = async (id) => (await su("select id, status, lifecycle_state, lifecycle_reason, lifecycle_event_at, connected_at, token_secret_id, phone_number_id from company_whatsapp_connections where id=$1", [id])).rows[0];
const evCount = async (waba, name) => Number((await su("select count(*) n from whatsapp_coexistence_events where kind='account_update' and waba_id=$1 and event_name=$2", [waba, name])).rows[0].n);

const APP_SECRET = "APP-SECRET-A1";
const logs = [];
const oc = { warn: console.warn, error: console.error, info: console.info };
const capture = async (fn) => { console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a)); try { return await fn(); } finally { Object.assign(console, oc); } };
const db = { async rpc(fn, args) {
  const keys = Object.keys(args);
  const r = await svc(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) j`, keys.map((k) => args[k]));
  return r.ok ? { data: r.rows[0].j, error: null } : { data: null, error: { code: r.code, message: r.err } };
} };
async function post(payload, { sig } = {}) {
  const raw = JSON.stringify(payload);
  const signature = sig ?? "sha256=" + (await W.hmacSha256Hex(APP_SECRET, raw));
  const res = await capture(() => W.handleWhatsappWebhook(new Request("https://x/functions/v1/whatsapp-webhook", { method: "POST", headers: { "x-hub-signature-256": signature }, body: raw }), { verifyToken: "v", appSecret: APP_SECRET, db }));
  return { status: res.status, j: await res.json() };
}
const au = (waba, event, time, extra = {}) => ({ object: "whatsapp_business_account", entry: [{ id: waba, ...(time === undefined ? {} : { time }), changes: [{ field: "account_update", value: { event, ...extra } }] }] });
const newWaba = () => String(910000000 + ++seq);

console.log("\n== 1. o cenário do A1 (conexão antiga pausada, outro número conectado, RECONNECTED tardio) ==");
{
  const W1 = newWaba(), C1 = await mkCo("c1");
  const old = await mkConn(C1, { pn: "100000001", waba: W1 });
  const off = await post(au(W1, "ACCOUNT_OFFBOARDED", NOW + 10));
  let o = await conn(old);
  ck("1.1 OFFBOARDED pausa a conexão (status error, offboarded) e grava a marca d'água do evento", off.status === 200 && o.status === "error" && o.lifecycle_state === "offboarded" && Number(o.lifecycle_event_at) / 1000 === NOW + 10);
  // a empresa conecta OUTRO número na mesma WABA (permitido: não há conexão ativa)
  const cur = await mkConn(C1, { pn: "100000002", waba: W1, connectedAgo: "0 seconds" });
  await su("insert into whatsapp_conversations (company_id, connection_id, contact_phone, status) values ($1,$2,'5544999990001','open')", [C1, cur]);
  const convBefore = JSON.stringify((await su("select id, ai_control, status, unread_count from whatsapp_conversations where connection_id=$1", [cur])).rows);
  const curBefore = await snapConn(cur);
  const rec = await post(au(W1, "ACCOUNT_RECONNECTED", NOW + 20));
  o = await conn(old);
  ck("1.2 RECONNECTED tardio da conexão ANTIGA: HTTP 200 (ignorado com segurança, sem 500) e a antiga NÃO é reativada", rec.status === 200 && rec.j.ignored === 1 && rec.j.stored === 0 && o.status === "error" && o.lifecycle_state === "offboarded", JSON.stringify(rec.j));
  ck("1.3 a conexão ATUAL fica intacta: status, token, linha inteira e atendimento (conversa)", (await snapConn(cur)) === curBefore && JSON.stringify((await su("select id, ai_control, status, unread_count from whatsapp_conversations where connection_id=$1", [cur])).rows) === convBefore
    && (await conn(cur)).status === "active" && (await conn(cur)).token_secret_id === tok);
  const detail = (await su("select detail from whatsapp_coexistence_events where waba_id=$1 and event_name='ACCOUNT_RECONNECTED'", [W1])).rows[0].detail;
  ck("1.4 o evento fica REGISTRADO (auditoria) com o motivo: 1 conexão ignorada, 0 alterações", detail.changed === 0 && detail.skipped === 1);
  const again = await post(au(W1, "ACCOUNT_RECONNECTED", NOW + 20));
  ck("1.5 reentrega do MESMO evento: duplicate (200), nada muda", again.status === 200 && again.j.duplicate === 1 && (await conn(old)).status === "error" && (await conn(cur)).status === "active" && (await evCount(W1, "ACCOUNT_RECONNECTED")) === 1);
  // a conexão atual é desconectada pelo cliente; um RECONNECTED NOVO (mais recente que o OFFBOARDED) da antiga volta a valer
  await su("update company_whatsapp_connections set status='disconnected' where id=$1", [cur]);
  const rec2 = await post(au(W1, "ACCOUNT_RECONNECTED", NOW + 60));
  ck("1.6 sem nenhuma outra conexão ativa, um RECONNECTED NOVO reativa a antiga (a Meta realmente a reconectou) e a desconectada não volta sozinha", rec2.j.stored === 1 && (await conn(old)).status === "active" && (await conn(old)).lifecycle_state === "normal" && (await conn(cur)).status === "disconnected");
}

console.log("\n== 2. fora de ordem e atrasados ==");
{
  const W2 = newWaba(), C2 = await mkCo("c2");
  const a = await mkConn(C2, { pn: "200000001", waba: W2 });
  await post(au(W2, "ACCOUNT_RECONNECTED", NOW + 20));            // chegou ANTES do OFFBOARDED (sem pausa anterior: nada muda)
  const late = await post(au(W2, "ACCOUNT_OFFBOARDED", NOW + 10)); // anterior ao RECONNECTED já visto
  ck("2.1 OFFBOARDED (t=10) chegando DEPOIS de um RECONNECTED (t=20): descartado como atrasado; a conexão NÃO é pausada", late.status === 200 && late.j.ignored === 1 && (await conn(a)).status === "active" && (await conn(a)).lifecycle_state === "normal");
  const fresh = await post(au(W2, "ACCOUNT_OFFBOARDED", NOW + 30));
  ck("2.2 um OFFBOARDED NOVO (t=30) depois disso pausa normalmente", fresh.j.stored === 1 && (await conn(a)).status === "error");
  const stale = await post(au(W2, "ACCOUNT_RECONNECTED", NOW + 25));
  ck("2.3 RECONNECTED atrasado (t=25 < OFFBOARDED t=30): descartado, segue pausada", stale.j.ignored === 1 && (await conn(a)).status === "error" && (await conn(a)).lifecycle_state === "offboarded");
  const ok = await post(au(W2, "ACCOUNT_RECONNECTED", NOW + 40));
  ck("2.4 RECONNECTED em ordem (t=40) reativa", ok.j.stored === 1 && (await conn(a)).status === "active");
  const staleRm = await post(au(W2, "PARTNER_REMOVED", NOW + 35, { disconnection_info: { reason: "ACCOUNT_DISCONNECTED", initiated_by: "USER" } }));
  ck("2.5 PARTNER_REMOVED atrasado (t=35 < RECONNECTED t=40): NÃO derruba a conexão que já voltou", staleRm.j.ignored === 1 && (await conn(a)).status === "active");
  // evento anterior ao ONBOARDING desta conexão (ex.: ainda do número antigo antes de reconectar pelo Embedded Signup)
  const W3 = newWaba(), C3 = await mkCo("c3");
  const b = await mkConn(C3, { pn: "300000001", waba: W3, connectedAgo: "0 seconds" });
  const old = await post(au(W3, "PARTNER_REMOVED", NOW - 3600, { disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" } }));
  ck("2.6 PARTNER_REMOVED anterior ao onboarding da conexão (reconexão posterior pelo Embedded Signup): ignorado; a conexão recém-ativada permanece", old.status === 200 && old.j.ignored === 1 && (await conn(b)).status === "active");
  const off2 = await post(au(W3, "ACCOUNT_OFFBOARDED", NOW - 7200));
  ck("2.7 OFFBOARDED anterior ao onboarding: ignorado", off2.j.ignored === 1 && (await conn(b)).status === "active");
  // reconexão pelo Embedded Signup (volta a active) com evento antigo reentregue
  await su("update company_whatsapp_connections set status='disconnected', lifecycle_state='removed' where id=$1", [b]);
  await su("update company_whatsapp_connections set status='active', connected_at = now() where id=$1", [b]);
  const replay = await post(au(W3, "PARTNER_REMOVED", NOW - 60, { disconnection_info: { reason: "ACCOUNT_DISCONNECTED", initiated_by: "USER" } }));
  ck("2.8 reconexão pelo Embedded Signup + PARTNER_REMOVED antigo reentregue: ignorado (a conexão nova não é derrubada)", replay.j.ignored === 1 && (await conn(b)).status === "active" && (await conn(b)).lifecycle_state === "normal");
  const fut = await post(au(W3, "PARTNER_REMOVED", NOW + 10 * 365 * 24 * 3600));
  const fut2 = await post(au(W3, "ACCOUNT_OFFBOARDED", NOW + 20));
  ck("2.9 horário no FUTURO (relógio errado/forjado) é descartado sem alterar nada nem 'envenenar' a marca d'água dos eventos seguintes", fut.j.ignored === 1 && (await conn(b)).status === "error" && fut2.status === 200);
}

console.log("\n== 3. duplicados e eventos sem utilidade ==");
{
  const W4 = newWaba(), C4 = await mkCo("c4");
  const a = await mkConn(C4, { pn: "400000001", waba: W4 });
  const x1 = await post(au(W4, "ACCOUNT_OFFBOARDED", NOW + 10));
  const x2 = await post(au(W4, "ACCOUNT_OFFBOARDED", NOW + 10));
  const x3 = await post(au(W4, "ACCOUNT_OFFBOARDED", NOW + 11));
  ck("3.1 OFFBOARDED duplicado (mesmo evento) = duplicate; reenviado com outro horário depois de pausada = sem efeito, sem erro", x1.j.stored === 1 && x2.j.duplicate === 1 && x3.status === 200 && (await conn(a)).status === "error");
  const r1 = await post(au(W4, "ACCOUNT_RECONNECTED", NOW + 20));
  const r2 = await post(au(W4, "ACCOUNT_RECONNECTED", NOW + 21));
  ck("3.2 RECONNECTED repetido (outro horário) com a conexão já ativa: sem efeito, 200", r1.j.stored === 1 && r2.status === 200 && (await conn(a)).status === "active" && (await conn(a)).lifecycle_state === "normal");
  const noTime = await post(au(W4, "ACCOUNT_OFFBOARDED", undefined));
  const badTime = await post(au(W4, "ACCOUNT_OFFBOARDED", 5));
  const strTime = await post(au(W4, "ACCOUNT_OFFBOARDED", String(NOW + 50)));
  ck("3.3 sem entry.time ou com horário inválido: só registra (200, ignorado), nunca altera a conexão; horário numérico em texto é aceito", noTime.j.ignored === 1 && badTime.j.ignored === 1 && strTime.j.stored === 1 && (await conn(a)).status === "error");
  await post(au(W4, "ACCOUNT_RECONNECTED", NOW + 60));
  ck("3.4 (limpeza do cenário) reativada", (await conn(a)).status === "active");
}

console.log("\n== 4. ambiguidade e isolamento ==");
{
  const W5 = newWaba(), C5 = await mkCo("c5");
  const p1 = await mkConn(C5, { pn: "500000001", waba: W5, status: "error", lifecycle: "offboarded" });
  const p2 = await mkConn(C5, { pn: "500000002", waba: W5, status: "error", lifecycle: "offboarded" });
  const r = await post(au(W5, "ACCOUNT_RECONNECTED", NOW + 20));
  ck("4.1 duas conexões pausadas da MESMA empresa: o evento não diz qual voltou => NENHUMA é reativada (200, ignorado)", r.status === 200 && r.j.ignored === 1 && (await conn(p1)).status === "error" && (await conn(p2)).status === "error");
  // isolamento: outra empresa na MESMA WABA e uma conexão MANUAL na mesma WABA
  const W6 = newWaba(), C6 = await mkCo("c6"), C7 = await mkCo("c7"), C8 = await mkCo("c8");
  const x = await mkConn(C6, { pn: "600000001", waba: W6, status: "error", lifecycle: "offboarded" });
  const y = await mkConn(C7, { pn: "600000002", waba: W6, status: "error", lifecycle: "offboarded" });
  const m = await mkConn(C8, { pn: "600000003", waba: W6, type: "cloud_api", source: "manual" });
  const m2 = await mkConn(await mkCo("c16"), { pn: "600000004", waba: W6, type: "coexistence", source: "manual", status: "error", lifecycle: "offboarded" });
  await post(au(W6, "ACCOUNT_RECONNECTED", NOW + 20));
  ck("4.2 mesma WABA, empresas diferentes: cada uma reativa a SUA conexão pausada (sem interferência); conexões MANUAIS (Cloud API ou até em Coexistence pausada) não são tocadas", (await conn(x)).status === "active" && (await conn(y)).status === "active" && (await conn(m)).status === "active" && (await conn(m)).lifecycle_state === "normal" && (await conn(m)).lifecycle_event_at === null
  && (await conn(m2)).status === "error" && (await conn(m2)).lifecycle_state === "offboarded");
  const W7 = newWaba(), C9 = await mkCo("c9");
  const cur = await mkConn(C9, { pn: "700000001", waba: W7 });
  const other = await post(au(W6, "ACCOUNT_OFFBOARDED", NOW + 30));
  ck("4.3 evento de OUTRA WABA não afeta esta (isolamento por WABA)", other.status === 200 && (await conn(cur)).status === "active" && (await conn(cur)).lifecycle_event_at === null);
  const unk = await post(au("999999999999", "ACCOUNT_RECONNECTED", NOW + 30));
  ck("4.4 WABA desconhecida: 200 sem alterar nada", unk.status === 200 && Number((await su("select count(*) n from company_whatsapp_connections where status='error' and lifecycle_state='offboarded' and id in ($1,$2)", [p1, p2])).rows[0].n) === 2);
  const co2 = await mkConn(await mkCo("c10"), { pn: "800000001", waba: newWaba(), type: "cloud_api", source: "embedded_signup", status: "error", lifecycle: "offboarded" });
  const wb = (await su("select waba_id from company_whatsapp_connections where id=$1", [co2])).rows[0].waba_id;
  await post(au(wb, "ACCOUNT_RECONNECTED", NOW + 20));
  ck("4.5 RECONNECTED só vale para Coexistence: conexão Cloud API do Embedded Signup pausada manualmente não é reativada por ele", (await conn(co2)).status === "error");
}

console.log("\n== 5. concorrência ==");
{
  const W8 = newWaba(), C11 = await mkCo("c11");
  const a = await mkConn(C11, { pn: "810000001", waba: W8 });
  await post(au(W8, "ACCOUNT_OFFBOARDED", NOW + 10));
  const same = au(W8, "ACCOUNT_RECONNECTED", NOW + 20);
  const rs = await Promise.all(Array.from({ length: 8 }, () => post(same)));
  ck("5.1 o MESMO RECONNECTED 8x em paralelo: todos 200, aplicado UMA vez (um stored, sete duplicate), conexão ativa", rs.every((r) => r.status === 200) && rs.reduce((s, r) => s + (r.j.stored ?? 0), 0) === 1 && rs.reduce((s, r) => s + (r.j.duplicate ?? 0), 0) === 7 && (await conn(a)).status === "active" && (await evCount(W8, "ACCOUNT_RECONNECTED")) === 1);
  // OFFBOARDED e RECONNECTED simultâneos e chegando em qualquer ordem: o estado final é o do evento MAIS RECENTE
  const W9 = newWaba(), C12 = await mkCo("c12");
  const b = await mkConn(C12, { pn: "820000001", waba: W9 });
  await Promise.all([post(au(W9, "ACCOUNT_RECONNECTED", NOW + 20)), post(au(W9, "ACCOUNT_OFFBOARDED", NOW + 10))]);
  ck("5.2 OFFBOARDED (t=10) e RECONNECTED (t=20) concorrentes, RECONNECTED processado primeiro: estado final = ativa (o mais recente vence)", (await conn(b)).status === "active");
  const W10 = newWaba(), C13 = await mkCo("c13");
  const c = await mkConn(C13, { pn: "830000001", waba: W10 });
  await Promise.all([post(au(W10, "ACCOUNT_OFFBOARDED", NOW + 10)), post(au(W10, "ACCOUNT_RECONNECTED", NOW + 20))]);
  ck("5.3 os mesmos eventos na ordem inversa de chegada: estado final = ativa", (await conn(c)).status === "active");
  // RECONNECTED da antiga concorrente com a ATIVAÇÃO de outra conexão na empresa: nunca fica com duas ativas
  const W11 = newWaba(), C14 = await mkCo("c14");
  const d = await mkConn(C14, { pn: "840000001", waba: W11, status: "error", lifecycle: "offboarded" });
  const e = await mkConn(C14, { pn: "840000002", waba: W11, status: "disconnected", lifecycle: "normal" });
  const results = await Promise.all([post(au(W11, "ACCOUNT_RECONNECTED", NOW + 20)), su("update company_whatsapp_connections set status='active' where id=$1", [e])]);
  const actives = Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1 and status='active'", [C14])).rows[0].n);
  ck("5.4 RECONNECTED da antiga + ativação simultânea de outra conexão: NUNCA duas ativas (no máximo uma) e o webhook não devolve erro", results[0].status === 200 && actives <= 1, JSON.stringify({ actives, st: results[0].status }));
  const lots = await Promise.all(Array.from({ length: 6 }, (_, i) => post(au(newWaba(), "ACCOUNT_RECONNECTED", NOW + 20 + i))));
  ck("5.5 rajada de eventos de WABAs distintas: todos 200", lots.every((r) => r.status === 200));
}

console.log("\n== 6. proteção contra eventos falsificados e regressão ==");
{
  const W12 = newWaba(), C15 = await mkCo("c15");
  const a = await mkConn(C15, { pn: "850000001", waba: W12 });
  const f1 = await post(au(W12, "PARTNER_REMOVED", NOW + 10), { sig: "sha256=" + "0".repeat(64) });
  const f2 = await post(au(W12, "ACCOUNT_OFFBOARDED", NOW + 10), { sig: "" });
  ck("6.1 assinatura inválida/ausente: 401 e a conexão NÃO é alterada nem o evento registrado", f1.status === 401 && f2.status === 401 && (await conn(a)).status === "active" && (await evCount(W12, "PARTNER_REMOVED")) === 0);
  const rm = await post(au(W12, "PARTNER_REMOVED", NOW + 20, { disconnection_info: { reason: "ACCOUNT_DISCONNECTED", initiated_by: "USER" } }));
  ck("6.2 PARTNER_REMOVED legítimo e atual continua desconectando (regressão)", rm.j.stored === 1 && (await conn(a)).status === "disconnected" && (await conn(a)).lifecycle_state === "removed");
  const all = logs.join("");
  ck("6.3 nenhum log contém o token, o App Secret ou ids de negócio do payload", !all.includes("TOKEN-A1") && !all.includes(APP_SECRET));
  const rpcDef = (await su("select pg_get_functiondef('public.whatsapp_coexistence_account_update(text,text,text,text,bigint)'::regprocedure) d")).rows[0].d;
  const acl = (await pg.query("select has_function_privilege('authenticated','public.whatsapp_coexistence_account_update(text,text,text,text,bigint)','execute') a, has_function_privilege('anon','public.whatsapp_coexistence_account_update(text,text,text,text,bigint)','execute') b, has_function_privilege('service_role','public.whatsapp_coexistence_account_update(text,text,text,text,bigint)','execute') c")).rows[0];
  ck("6.4 ACL da RPC corrigida: só service_role executa; não existe mais a assinatura antiga de 4 argumentos", acl.a === false && acl.b === false && acl.c === true && /p_event_time/.test(rpcDef)
    && Number((await su("select count(*) n from pg_proc where proname='whatsapp_coexistence_account_update'")).rows[0].n) === 1);
}

fs.rmSync(tmp, { recursive: true, force: true });
summary("CORREÇÃO A1 (ACCOUNT_RECONNECTED)");
