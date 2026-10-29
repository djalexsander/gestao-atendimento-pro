// AVISOS AUTOMÁTICOS DO PEDIDO — ponta a ponta: banco REAL (PGlite + todas as migrations) + worker whatsapp-order-notify REAL
// (handler.ts + whatsapp-dispatch.ts transpilados) + Graph API SIMULADA. Sem provedor de IA (o worker não recebe nenhum).
// Prova: segredo/método/kill switch, envio pelo fluxo oficial, falha/retry/Meta 131047/timeout, 2 invocações = 1 envio,
// ai_control=human, modo teste (destinatário equivalente), logs sem PII/token, falha da Meta não mexe na produção.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { loadAll } from "./full-db.mjs";

const root = "D:/orça facil";
const fnRoot = process.env.FN_ROOT ?? root;
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "waonotify-"));
const load = async (src, name, rewrites = []) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(fnRoot, src), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
  return import(pathToFileURL(path.join(tmp, name)).href);
};
await load("supabase/functions/_shared/push-core.ts", "push-core.mjs");
await load("supabase/functions/_shared/whatsapp-graph.ts", "whatsapp-graph.mjs");
await load("supabase/functions/_shared/whatsapp-dispatch.ts", "whatsapp-dispatch.mjs", [['"./whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
const H = await load("supabase/functions/whatsapp-order-notify/handler.ts", "handler.mjs", [
  ['"../_shared/push-core.ts"', '"./push-core.mjs"'], ['"../_shared/whatsapp-dispatch.ts"', '"./whatsapp-dispatch.mjs"'], ['"../_shared/whatsapp-graph.ts"', '"./whatsapp-graph.mjs"'],
]);
const src = fs.readFileSync(path.join(fnRoot, "supabase/functions/whatsapp-order-notify/handler.ts"), "utf8");

const { pg, ck, as, su: su0, summary } = await loadAll();
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const svc = (sql, params) => as("service_role", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const must = (r, what) => { if (!r.ok) { console.log("SETUP FALHOU", what, r.err); process.exit(2); } return r; };
await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
  declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id into v; return v; end $f$;
`);
await su("update modules set is_active = true where code = 'delivery'");

const c = must(await su("insert into companies (name,slug,document,email) values ('Emp N','on-e2e','11222333000181','n@x.com') returning id"), "empresa").rows[0].id;
const owner = id(2001), prodU = id(2002);
for (const [u, role] of [[owner, "owner"], [prodU, "production"]]) {
  await su(`insert into auth.users (id,email) values ('${u}','${role}-n@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-n@x.com','${role}') on conflict (user_id) do update set full_name = excluded.full_name`);
  await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
}
const OWN = U(owner), PROD = U(prodU);
for (const m of ["delivery", "whatsapp", "producao"]) await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,$2,'teste', now() + interval '1 day')", [c, m]);
const sec = must(await su("insert into production_sectors (company_id,name,code) values ($1,'Chur','CHU') returning id", [c]), "setor").rows[0].id;
const cat = must(await su("insert into product_categories (company_id,name,code) values ($1,'Geral','G') returning id", [c]), "cat").rows[0].id;
const P1 = must(await su("insert into products (company_id,category_id,name,code,sale_price,production_sector_id) values ($1,$2,'Burger','BG',50,$3) returning id", [c, cat, sec]), "p1").rows[0].id;
const TOKEN = "EAAG-TOKEN-SECRETO-NOTIFY-1234567890";
const tokId = "99999999-0000-4000-8000-000000000088";
await su("insert into vault.secrets (id, name, secret) values ($1,'on_e2e_token',$2)", [tokId, TOKEN]);
const conn = must(await su("insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, display_phone_number, token_secret_id) values ($1,'active','live','555000222','+55 44 90000-0000',$2) returning id", [c, tokId]), "conexão").rows[0].id;
await su("insert into company_whatsapp_ai_settings (company_id, order_status_notifications_enabled) values ($1,true) on conflict (company_id) do update set order_status_notifications_enabled = true", [c]);

let n = 0, dq = 0, rq = 0;
const SECRET = "segredo-interno-do-worker-com-mais-de-32-chars";
async function order(o = {}) {
  const phone = o.phone ?? `5544998${String(100000 + ++n)}`;
  const conv = must(await su("insert into whatsapp_conversations (company_id, connection_id, contact_phone, last_inbound_at, ai_control) values ($1,$2,$3,now(),$4) returning id", [c, conn, phone, o.ai ?? "inherit"]), "conversa").rows[0].id;
  const draft = `00000000-0000-4000-9200-${String(++dq).padStart(12, "0")}`;
  await su("insert into whatsapp_order_drafts (id, company_id, conversation_id, status, failure_code) values ($1,$2,$3,'failed','test')", [draft, c, conv]);
  const r = must(await su("select public.create_delivery_order_engine($1::uuid,null,'whatsapp_ai',null,$2::uuid,'pickup',$3::jsonb,null,'Maria',$4,null,null,null,null,null,null,null,'whatsapp',$5::uuid,$6::uuid) j",
    [c, `00000000-0000-4000-9100-${String(++rq).padStart(12, "0")}`, JSON.stringify([{ product_id: P1, quantity: 1 }]), phone, conv, draft]), "pedido");
  const d = (await su("select * from delivery_orders where id=$1", [r.rows[0].j.delivery_order_id])).rows[0];
  return { conv, phone, did: d.id, oid: d.service_order_id };
}
const ready = async (oid) => { for (const i of (await su("select id from service_order_items where order_id=$1", [oid])).rows) must(await PROD("select public.update_production_item_status($1,'ready') x", [i.id]), "pronto"); };
const notif = async (oid) => (await su("select * from order_customer_notifications where service_order_id=$1", [oid])).rows[0];
const bridge = {
  async rpc(fn, args) {
    const keys = Object.keys(args);
    const r = await svc(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) as j`, keys.map((k) => args[k]));
    if (!r.ok) return { data: null, error: { code: r.code, message: r.err } };
    return { data: r.rows[0].j, error: null };
  },
};
const rpcLog = [];
const admin = { async rpc(fn, args) { rpcLog.push(fn); return bridge.rpc(fn, args); } };
const sends = [];
let graphScript = () => ({ ok: true, messageId: `wamid.out.${sends.length}` });
const graph = { async sendText(a) { sends.push(a); return graphScript(a); } };
const logs = [];
const orig = { warn: console.warn, error: console.error, info: console.info, log: console.log };
async function tick(over = {}) {
  console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a));
  try {
    const res = await H.handleWhatsappOrderNotify(new Request("https://x.test/fn", { method: over.method ?? "POST", headers: { "x-internal-secret": over.secret ?? SECRET, "content-type": "application/json" }, body: over.method === "GET" ? undefined : "{}" }),
      { internalSecret: SECRET, killSwitch: "true", admin, graph, graphVersion: "v99.0", ...over.deps });
    return { status: res.status, json: await res.json() };
  } finally { Object.assign(console, orig); }
}
const due = (nid) => su("update order_customer_notifications set available_at = now() - interval '1 second' where id=$1", [nid]);

// ---------------------------------------------------------------- fixtures desta suíte
const attU = id(2003), otherOwner = id(2005), master = id(2006);
for (const [u, role] of [[attU, "attendant"]]) {
  await su(`insert into auth.users (id,email) values ('${u}','${role}-n@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-n@x.com','${role}') on conflict (user_id) do update set full_name = excluded.full_name`);
  await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
}
const ATT = U(attU);
// outra empresa (isolamento)
const c2 = must(await su("insert into companies (name,slug,document,email) values ('Emp Outra','on-e2e-2','11222333000181','o@x.com') returning id"), "empresa 2").rows[0].id;
await su(`insert into auth.users (id,email) values ('${otherOwner}','owner-o@x.com'), ('${master}','master@x.com')`);
await su(`insert into public.profiles (user_id,email,full_name) values ('${otherOwner}','owner-o@x.com','o'), ('${master}','master@x.com','m') on conflict (user_id) do nothing`);
await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [c2, otherOwner]);
await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste', now() + interval '1 day')", [c2]);
await su("insert into platform_admins (user_id) values ($1)", [master]);
const OWN2 = U(otherOwner), MASTER = U(master);

const connRow = async () => (await su("select * from company_whatsapp_connections where id=$1", [conn])).rows[0];
const connHash = async () => (await su("select md5(row(c.*)::text) h from company_whatsapp_connections c where id=$1", [conn])).rows[0].h;
const setConn = (sql, params = []) => su(`update company_whatsapp_connections set ${sql} where id = $1`, [conn, ...params]);
const eff = async () => (await su("select public.whatsapp_token_effective_status(c) s from company_whatsapp_connections c where id=$1", [conn])).rows[0].s;
const resetConn = () => setConn("token_status='unknown', token_expires_at=null, token_checked_at=null, last_error_code=null");
const alertsOf = async () => (await su("select * from whatsapp_token_alerts where connection_id=$1 order by first_seen_at", [conn])).rows;
const msgOf = async (mid) => (await su("select status, error_code from whatsapp_messages where id=$1", [mid])).rows[0];
const dispatchMod = await load("supabase/functions/_shared/whatsapp-dispatch.ts", "wd2.mjs", [['"./whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
let seqPhone = 0;
/** mensagem manual: usuário (attendant) -> RPC oficial -> despacho oficial com a Graph simulada */
async function manualSend(script) {
  const conv = must(await su("insert into whatsapp_conversations (company_id, connection_id, contact_phone, last_inbound_at, ai_control) values ($1,$2,$3,now(),'human') returning id", [c, conn, `5544997${String(200000 + ++seqPhone)}`]), "conv manual").rows[0].id;
  const prep = must(await ATT("select public.whatsapp_prepare_outbound_message($1,$2,'Olá! Teste de saúde do token') j", [conv, `00000000-0000-4000-8000-${String(900000 + seqPhone).padStart(12, "0")}`]), "prepare").rows[0].j;
  const calls = [];
  const g = { async sendText(a) { calls.push(a); return script(a); }, async uploadMedia(a) { calls.push({ upload: true, ...a }); return script(a, "upload"); }, async sendDocument(a) { calls.push({ doc: true, ...a }); return script(a, "doc"); } };
  const out = await dispatchMod.dispatchQueuedMessage({ admin, graph: g, graphVersion: "v99.0" }, prep.message_id);
  return { out, calls, mid: prep.message_id, conv };
}
const OK = () => ({ ok: true, messageId: `wamid.${++seqPhone}` });
const HTTP = (status, code, subcode) => () => ({ ok: false, kind: "http", status, ...(code ? { code } : {}), ...(subcode ? { subcode } : {}) });

console.log("\n== 1. estado efetivo do token ==");
{
  const cases = [
    ["sem prazo e nunca confirmado = unknown (nem válido nem inválido)", "token_status='unknown', token_expires_at=null", "unknown"],
    ["confirmado (valid) sem prazo = valid", "token_status='valid', token_expires_at=null", "valid"],
    ["prazo conhecido a 30 dias = valid", "token_status='valid', token_expires_at=now()+interval '30 days'", "valid"],
    ["prazo a 5 dias = expiring", "token_status='valid', token_expires_at=now()+interval '5 days'", "expiring"],
    ["prazo a exatamente 10 dias = expiring", "token_status='valid', token_expires_at=now()+interval '10 days' - interval '1 minute'", "expiring"],
    ["prazo a 11 dias = valid", "token_status='valid', token_expires_at=now()+interval '11 days'", "valid"],
    ["prazo vencido = expired (mesmo armazenado como valid)", "token_status='valid', token_expires_at=now()-interval '1 minute'", "expired"],
    ["revogado confirmado pela Graph = revoked (prevalece sobre prazo futuro)", "token_status='revoked', token_expires_at=now()+interval '30 days'", "revoked"],
    ["expired armazenado (confirmado) = expired", "token_status='expired', token_expires_at=null", "expired"],
    ["error = error", "token_status='error', token_expires_at=null", "error"],
    ["'expiring' armazenado SEM prazo conhecido = unknown (não inventa)", "token_status='expiring', token_expires_at=null", "unknown"],
  ];
  let i = 0;
  for (const [label, sql, want] of cases) { await resetConn(); await setConn(sql); ck(`1.${++i} ${label}`, (await eff()) === want, await eff()); }
  await resetConn();
}

console.log("\n== 2. compatibilidade: conexão sem metadados de validade (tipo Djalexeventos) ==");
{
  await resetConn();
  const before = await connHash();
  const a = await order(); await ready(a.oid);
  const t = await tick(); const nf = await notif(a.oid);
  ck("2.1 token 'unknown' (sem prazo): o aviso do pedido é ENVIADO normalmente (nada bloqueia por falta de metadados)", t.status === 200 && nf.status === "sent");
  ck("2.2 a linha da conexão fica BYTE A BYTE igual depois de um envio bem-sucedido (nenhuma escrita de saúde)", (await connHash()) === before);
  const m = await manualSend(OK);
  ck("2.3 envio manual também passa e não altera a conexão", m.out.ok === true && m.calls.length === 1 && (await connHash()) === before && (await msgOf(m.mid)).status === "sent");
  ck("2.4 sem aviso para o administrador (unknown não gera alerta)", (await alertsOf()).length === 0 && (await OWN("select public.whatsapp_get_module_state($1) j", [c])).rows[0].j.connection_alert === null);
}

console.log("\n== 3. token válido / próximo do vencimento / expirado pelo prazo ==");
{
  await resetConn(); await setConn("token_status='valid', token_expires_at=now()+interval '30 days'");
  let m = await manualSend(OK);
  ck("3.1 válido com prazo: envia", m.out.ok === true && m.calls.length === 1);
  await setConn("token_expires_at=now()+interval '4 days 2 hours'");
  m = await manualSend(OK);
  const st = (await OWN("select public.whatsapp_get_module_state($1) j", [c])).rows[0].j;
  ck("3.2 expirando (<=10 dias): ainda ENVIA e o owner recebe aviso 'expiring' com os dias restantes", m.out.ok === true && st.connection_alert?.kind === "expiring" && st.connection_alert.level === "warning" && st.connection_alert.days_left === 5 && st.connection_alert.reconnect === true);
  await setConn("token_expires_at=now()-interval '1 minute'");
  const callsBefore = sends.length;
  m = await manualSend(OK);
  ck("3.3 vencido pelo prazo: NENHUMA chamada à Graph, mensagem registrada como falha 'token_expired', mensagem amigável", m.out.ok === false && m.out.errorCode === "token_expired" && m.out.http === 409 && /expirou ou foi revogada/.test(m.out.friendly) && m.calls.length === 0 && (await msgOf(m.mid)).error_code === "token_expired");
  const st2 = (await OWN("select public.whatsapp_get_module_state($1) j", [c])).rows[0].j;
  ck("3.4 aviso 'expired' crítico para o owner", st2.connection_alert?.kind === "expired" && st2.connection_alert.level === "critical");
  const b = await order(); await ready(b.oid);
  await tick();
  const nb = await notif(b.oid);
  ck("3.5 notificação de pedido com token vencido: não chama a Graph, fica pendente com o código, pedido/produção intactos", sends.length === callsBefore && nb.status === "pending" && nb.error_code === "token_expired" && (await su("select count(*) n from service_order_items where order_id=$1 and production_status='ready'", [b.oid])).rows[0].n == 1);
  ck("3.6 o bloqueio por prazo é firme (sem sondagem): mesmo após 1 hora continua sem chamar a Graph", await (async () => { await setConn("token_checked_at = now() - interval '2 hours'"); const r = await manualSend(OK); return r.calls.length === 0 && r.out.errorCode === "token_expired"; })());
  ck("3.7 a conexão continua ACTIVE, o token do Vault não foi apagado e as mensagens/conversas seguem", (await connRow()).status === "active" && (await su("select count(*) n from vault.decrypted_secrets where id=$1", [tokId])).rows[0].n == 1);
  await resetConn();
}

console.log("\n== 4. erros da Graph: só 190 confirma token inválido ==");
{
  const cases = [
    ["4.1 HTTP 500 temporário", HTTP(500, "131000"), "unknown"],
    ["4.2 HTTP 401 SEM código 190 (não é prova de revogação)", HTTP(401, undefined), "unknown"],
    ["4.3 timeout", () => ({ ok: false, kind: "timeout" }), "unknown"],
    ["4.4 erro de rede", () => ({ ok: false, kind: "network" }), "unknown"],
    ["4.5 429 limite de taxa", HTTP(429, "130429"), "unknown"],
    ["4.6 resposta inválida", () => ({ ok: false, kind: "invalid_response", status: 200 }), "unknown"],
    ["4.7 outro erro 4xx (permissão 200)", HTTP(403, "200"), "unknown"],
  ];
  for (const [label, script, want] of cases) {
    await resetConn(); const h = await connHash();
    const m = await manualSend(script);
    ck(`${label}: mensagem falha mas a saúde do token NÃO muda e nada bloqueia`, m.out.ok === false && m.calls.length === 1 && (await eff()) === want && (await connHash()) === h);
  }
  {
    const GM = await load("supabase/functions/_shared/whatsapp-graph.ts", "wg3.mjs");
    const sender = (status, body) => GM.createGraphSender(async () => ({ ok: false, status, json: async () => body }));
    const f1 = await sender(401, { error: { code: 190, error_subcode: 463, message: "SEGREDO-DA-META" } }).sendText({ version: "v99.0", phoneNumberId: "1", accessToken: "t", to: "5", body: "x" });
    const f2 = await sender(401, { error: { code: 190 } }).sendText({ version: "v99.0", phoneNumberId: "1", accessToken: "t", to: "5", body: "x" });
    const f3 = await sender(500, { error: { code: 131000, error_subcode: "abc", message: "x" } }).sendText({ version: "v99.0", phoneNumberId: "1", accessToken: "t", to: "5", body: "x" });
    ck("4.7b adaptador real da Graph: lê code e error_subcode (só dígitos); sem subcódigo não inventa; nunca devolve a mensagem da Meta", f1.code === "190" && f1.subcode === "463" && f2.code === "190" && !("subcode" in f2) && !("subcode" in f3) && !JSON.stringify([f1, f2, f3]).includes("SEGREDO-DA-META"));
    ck("4.7c classificação: só o 190 (com ou sem subcódigo, exceto checkpoint) confirma token inválido", dispatchMod.classifyGraphAuthFailure(f1) === "invalid" && dispatchMod.classifyGraphAuthFailure(f2) === "invalid" && dispatchMod.classifyGraphAuthFailure({ kind: "http", status: 401, code: "190", subcode: "459" }) === "error"
      && dispatchMod.classifyGraphAuthFailure({ kind: "http", status: 401 }) === null && dispatchMod.classifyGraphAuthFailure({ kind: "http", status: 500, code: "131000" }) === null && dispatchMod.classifyGraphAuthFailure({ kind: "timeout" }) === null && dispatchMod.classifyGraphAuthFailure({ kind: "network" }) === null);
  }
  // 3 erros temporários seguidos não bloqueiam o quarto envio
  await resetConn();
  await manualSend(HTTP(500, "131000")); await manualSend(() => ({ ok: false, kind: "timeout" })); await manualSend(HTTP(401, undefined));
  const ok4 = await manualSend(OK);
  ck("4.8 vários erros temporários seguidos NUNCA bloqueiam: o próximo envio chega à Graph e passa", ok4.out.ok === true && ok4.calls.length === 1 && (await eff()) === "unknown");

  // 190 confirmado
  await resetConn();
  let m = await manualSend(HTTP(401, "190", "463"));
  let row = await connRow();
  ck("4.9 erro 190 (subcódigo 463) CONFIRMADO: token_status=revoked, código e data da checagem gravados, conexão segue active", m.out.ok === false && m.out.errorCode === "graph_auth" && /reconectada/.test(m.out.friendly) && row.token_status === "revoked" && /^190:463$/.test(row.last_error_code) && row.token_checked_at !== null && row.status === "active" && (await msgOf(m.mid)).error_code === "graph_auth");
  ck("4.10 aviso 'revoked' para o owner e UMA linha de alerta (dedupe por credencial)", (await OWN("select public.whatsapp_get_module_state($1) j", [c])).rows[0].j.connection_alert?.kind === "revoked" && (await alertsOf()).length === 1 && (await alertsOf())[0].kind === "revoked" && (await alertsOf())[0].occurrences === 1);
  const before = sends.length;
  m = await manualSend(OK);
  ck("4.11 logo depois: BLOQUEADO sem chamar a Graph (tentativa inútil evitada), falha 'token_revoked'", m.calls.length === 0 && m.out.errorCode === "token_revoked" && (await msgOf(m.mid)).error_code === "token_revoked");
  const b = await order(); await ready(b.oid); await tick();
  ck("4.12 notificação de pedido também bloqueada pelo MESMO controle (sem Graph)", sends.length === before && (await notif(b.oid)).error_code === "token_revoked");
  ck("4.13 alertas não se repetem a cada envio bloqueado (continua 1 linha, 1 ocorrência)", (await alertsOf()).length === 1 && (await alertsOf())[0].occurrences === 1);

  console.log("\n== 5. sondagem: erro transitório da Meta não bloqueia para sempre ==");
  await setConn("token_checked_at = now() - interval '31 minutes'");
  m = await manualSend(HTTP(401, "190"));
  row = await connRow();
  ck("5.1 passados 30 min: UMA sondagem chega à Graph; se ela confirma de novo (190), segue revoked, nova janela de 30 min e a ocorrência do alerta sobe", m.calls.length === 1 && row.token_status === "revoked" && (await alertsOf())[0].occurrences === 2 && (await alertsOf()).length === 1);
  m = await manualSend(OK);
  ck("5.2 logo após a sondagem volta a bloquear sem Graph", m.calls.length === 0 && m.out.errorCode === "token_revoked");
  await setConn("token_checked_at = now() - interval '31 minutes'");
  const [pa, pb] = await Promise.all([manualSend(OK), manualSend(OK)]);
  ck("5.3 duas sondagens simultâneas: só UMA chega à Graph (reivindicação atômica)", pa.calls.length + pb.calls.length === 1);
  row = await connRow();
  ck("5.4 sondagem bem-sucedida RESTAURA a saúde (a Meta estava só instável): token_status=valid, erro limpo", row.token_status === "valid" && row.last_error_code === null && (await eff()) === "valid");
  m = await manualSend(OK);
  ck("5.5 depois de restaurado, envia normalmente", m.out.ok === true && m.calls.length === 1);

  console.log("\n== 6. 190 com checkpoint e erro não confirmado ==");
  await resetConn();
  m = await manualSend(HTTP(401, "190", "459"));
  row = await connRow();
  ck("6.1 190 com subcódigo 459 (checkpoint da conta, não do token): status 'error', NÃO bloqueia", row.token_status === "error" && (await eff()) === "error" && (await alertsOf()).length === 1);
  m = await manualSend(OK);
  ck("6.2 o envio seguinte passa e, sendo bem-sucedido, restaura 'valid'", m.out.ok === true && m.calls.length === 1 && (await connRow()).token_status === "valid");
  await resetConn();
  await setConn("token_status='revoked'");
  await manualSend(HTTP(401, "190", "459")); // não rebaixa um estado confirmado
  ck("6.3 falha 'error' não sobrescreve um estado confirmado (revoked continua)", (await connRow()).token_status === "revoked");
  await resetConn();
}

console.log("\n== 7. canais de envio e caminho do documento ==");
{
  await resetConn(); await setConn("token_status='revoked', token_checked_at=now()");
  const conv = must(await su("insert into whatsapp_conversations (company_id, connection_id, contact_phone, last_inbound_at, ai_control) values ($1,$2,'5544997777777',now(),'human') returning id", [c, conn]), "conv doc").rows[0].id;
  const prep = must(await ATT("select public.whatsapp_prepare_outbound_message($1,$2,'Cardápio em anexo') j", [conv, "00000000-0000-4000-8000-000000a00001"]), "prep doc").rows[0].j;
  const calls = [];
  const g = { async uploadMedia(a) { calls.push("upload"); return { ok: true, mediaId: "m1" }; }, async sendDocument(a) { calls.push("doc"); return OK(); }, async sendText() { calls.push("text"); return OK(); } };
  const out = await dispatchMod.dispatchQueuedMessage({ admin, graph: g, graphVersion: "v99.0" }, prep.message_id, { bytes: new Uint8Array([1, 2, 3]), filename: "cardapio.pdf", mimeType: "application/pdf" });
  ck("7.1 envio de DOCUMENTO (cardápio da IA) com token revogado: nem upload nem envio, mesmo controle", out.ok === false && out.errorCode === "token_revoked" && calls.length === 0);
  await resetConn();
  const out2 = await dispatchMod.dispatchQueuedMessage({ admin, graph: { ...g, async uploadMedia() { calls.push("upload2"); return { ok: false, kind: "http", status: 401, code: "190", subcode: "467" }; } }, graphVersion: "v99.0" },
    (must(await ATT("select public.whatsapp_prepare_outbound_message($1,$2,'Cardápio 2') j", [conv, "00000000-0000-4000-8000-000000a00002"]), "prep doc2").rows[0].j).message_id,
    { bytes: new Uint8Array([1]), filename: "c.pdf", mimeType: "application/pdf" });
  ck("7.2 falha 190 no UPLOAD do documento também confirma o token inválido (e orienta a reconectar)", out2.ok === false && /reconectada/.test(out2.friendly) && (await connRow()).token_status === "revoked");
  await resetConn();
  // ponto único: nenhum outro código lê o token
  const fnDir = path.join(fnRoot, "supabase/functions");
  const files = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } }; walk(fnDir);
  const readers = files.filter((f) => /whatsapp_get_send_context|decrypted_secrets/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")) && !/asaas/.test(f)).map((f) => path.relative(fnDir, f).replace(/\\/g, "/"));
  ck("7.3 ÚNICO ponto que lê o token do WhatsApp nas Edges: _shared/whatsapp-dispatch.ts", readers.every((f) => f === "_shared/whatsapp-dispatch.ts" || /signup/.test(f)) && readers.includes("_shared/whatsapp-dispatch.ts"), readers.join(","));
  const users = ["whatsapp-send", "whatsapp-ai-auto", "whatsapp-order-notify"].map((n) => fs.readFileSync(path.join(fnDir, n, "handler.ts"), "utf8"));
  ck("7.4 envio manual, IA e notificações usam o MESMO dispatchQueuedMessage (e nenhum chama a Graph por fora)", users.every((s) => /dispatchQueuedMessage\(/.test(s)) && users.every((s) => !/graph\.sendText\(|graph\.sendDocument\(/.test(s.replace(/\/\/.*$/gm, ""))));
  const ctxSql = (await su("select prosrc from pg_proc where proname='whatsapp_get_send_context'")).rows[0].prosrc;
  ck("7.5 contexto de envio: bloqueio só para expired/revoked, antes de ler o Vault; unknown/error/expiring não bloqueiam", /v_eff in \('expired', 'revoked'\)/.test(ctxSql) && ctxSql.indexOf("v_eff in") < ctxSql.indexOf("decrypted_secrets"));
  ck("7.6 o recebimento (webhook) não depende do token: nenhum arquivo da Edge de webhook referencia saúde do token", !/token_status|token_expires|get_send_context/.test(fs.readFileSync(path.join(fnDir, "whatsapp-webhook/handler.ts"), "utf8")));
}

console.log("\n== 8. avisos: isolamento, papéis e dedupe ==");
{
  await resetConn(); await setConn("token_status='valid', token_expires_at=now()+interval '3 days'");
  const own = (await OWN("select public.whatsapp_get_module_state($1) j", [c])).rows[0].j;
  const att = (await ATT("select public.whatsapp_get_module_state($1) j", [c])).rows[0].j;
  ck("8.1 owner recebe o aviso; attendant (sem permissão) recebe null", own.connection_alert?.kind === "expiring" && att.connection_alert === null);
  ck("8.2 owner de OUTRA empresa não enxerga o estado desta empresa e a sua própria não tem aviso", !(await OWN2("select public.whatsapp_get_module_state($1) j", [c])).ok && (await OWN2("select public.whatsapp_get_module_state($1) j", [c2])).rows[0].j.connection_alert === null);
  const blob = JSON.stringify(own);
  ck("8.3 o aviso não contém token, segredo, id de segredo nem PIN", !blob.includes(TOKEN) && !/secret|token_secret|access_token|pin/i.test(JSON.stringify(own.connection_alert)));
  ck("8.4 funções de aviso/estado efetivo e relatórios não executáveis por usuários comuns", !(await OWN("select public.whatsapp_token_alert_for($1)", [c])).ok && !(await OWN("select public.whatsapp_connection_report_token_failure($1,'invalid',null,null)", [conn])).ok
    && !(await OWN("select public.whatsapp_get_send_context($1)", [id(1)])).ok && !(await OWN("select public.whatsapp_token_health_sweep()")).ok);
  // varredura
  await resetConn();
  const keep = await connHash();
  const c3 = must(await su("insert into companies (name,slug,document,email) values ('Emp Prazo','on-e2e-3','11222333000181','p@x.com') returning id"), "empresa 3").rows[0].id;
  const exp = must(await su("insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, token_status, token_expires_at) values ($1,'active','live','555000333','valid', now()+interval '2 days') returning id", [c3]), "conn exp").rows[0].id;
  const sw = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0].j;
  ck("8.5 varredura: marca 'expiring' só onde há prazo conhecido, cria o alerta uma vez e NÃO toca na conexão sem prazo", sw.expiring >= 1 && (await su("select token_status s from company_whatsapp_connections where id=$1", [exp])).rows[0].s === "expiring" && (await connHash()) === keep);
  await svc("select public.whatsapp_token_health_sweep() j");
  ck("8.6 varredura repetida não duplica o alerta (dedupe)", Number((await su("select count(*) n from whatsapp_token_alerts where connection_id=$1", [exp])).rows[0].n) === 1);
  await su("update company_whatsapp_connections set token_expires_at = now() - interval '1 hour' where id=$1", [exp]);
  await svc("select public.whatsapp_token_health_sweep() j");
  ck("8.7 prazo vencido: a varredura passa para 'expired' e registra o novo tipo de aviso", (await su("select token_status s from company_whatsapp_connections where id=$1", [exp])).rows[0].s === "expired" && Number((await su("select count(*) n from whatsapp_token_alerts where connection_id=$1", [exp])).rows[0].n) === 2);
  // restauração e varredura: limites exatos
  {
    const c4 = must(await su("insert into companies (name,slug,document,email) values ('Emp Lim','on-e2e-4','11222333000181','l@x.com') returning id"), "empresa 4").rows[0].id;
    const mk = async (pn, st, exp) => must(await su("insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, token_status, token_expires_at) values ($1,$2,'live',$3,$4,$5) returning id", [c4, pn === "a" ? "active" : "disconnected", pn === "a" ? "555000444" : "555000445", st, exp]), "conn lim").rows[0].id;
    const unk = await mk("a", "unknown", null);
    const hashOf = async (id2) => (await su("select md5(row(c.*)::text) h from company_whatsapp_connections c where id=$1", [id2])).rows[0].h;
    const h0 = await hashOf(unk);
    const r1 = (await svc("select public.whatsapp_connection_report_send_ok($1) j", [unk])).rows[0].j;
    ck("8.7a envio ok em conexão 'unknown' NÃO altera nada (nem a marca como válida: ausência de metadados não é prova de validade)", r1.restored === false && (await hashOf(unk)) === h0);
    const dead = await mk("d", "revoked", new Date(Date.now() - 3600_000).toISOString());
    const r2 = (await svc("select public.whatsapp_connection_report_send_ok($1) j", [dead])).rows[0].j;
    ck("8.7b envio ok NÃO restaura token cujo prazo conhecido já venceu", r2.restored === false && (await su("select token_status s from company_whatsapp_connections where id=$1", [dead])).rows[0].s === "revoked");
    const r3 = (await svc("select public.whatsapp_connection_report_send_ok($1) j", [id(424242)])).rows[0].j;
    ck("8.7c envio ok em conexão inexistente é inócuo", r3.ok === true && r3.restored === false);
    await su("update company_whatsapp_connections set token_status='expired' where id=$1", [unk]);
    const al0 = Number((await su("select count(*) n from whatsapp_token_alerts where connection_id=$1", [unk])).rows[0].n);
    const before = await hashOf(unk);
    await svc("select public.whatsapp_token_health_sweep() j");
    ck("8.7d varredura ignora conexão SEM prazo conhecido (mesmo marcada 'expired' antes): não cria aviso nem altera a linha", Number((await su("select count(*) n from whatsapp_token_alerts where connection_id=$1", [unk])).rows[0].n) === al0 && (await hashOf(unk)) === before);
    ck("8.7e relatórios de saúde não executáveis por usuários (nem o de envio ok)", !(await OWN("select public.whatsapp_connection_report_send_ok($1)", [unk])).ok && !(await OWN2("select public.whatsapp_connection_report_send_ok($1)", [unk])).ok && !(await as("anon", null, "select public.whatsapp_connection_report_send_ok($1)", [unk])).ok);
  }
  // master
  const mh = (await MASTER("select public.master_whatsapp_token_health() j")).rows[0].j;
  ck("8.8 Admin Master vê a saúde por empresa (sem credenciais); usuário comum e anon não", Array.isArray(mh) && mh.some((x) => x.company_id === c3 && x.status === "expired") && !JSON.stringify(mh).includes(TOKEN) && !/token_secret|access_token/.test(JSON.stringify(mh))
    && !(await OWN("select public.master_whatsapp_token_health()")).ok && !(await as("anon", null, "select public.master_whatsapp_token_health()")).ok);
  ck("8.9 tabela de alertas sem acesso do cliente", !(await OWN("select * from whatsapp_token_alerts")).ok && !(await OWN2("select * from whatsapp_token_alerts")).ok);
  await resetConn();
}

console.log("\n== 9. reconexão: preserva o número e só troca a credencial depois de confirmada ==");
{
  await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id='1234567890', embedded_signup_config_id='9876543210'");
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1,true,now())", [c]);
  await setConn("token_status='revoked', token_checked_at=now(), last_error_code='190:463', webhook_status='active'");
  const oldSecret = (await connRow()).token_secret_id;
  const s1 = (await OWN("select public.whatsapp_signup_begin($1) j", [c]));
  ck("9.1 empresa com conexão ativa e token revogado PODE iniciar o Embedded Signup (reconectar sem desconectar)", s1.ok === true);
  // 1ª tentativa FALHA antes de confirmar: a credencial antiga continua intacta
  const rs1 = (await svc("select public.whatsapp_signup_reserve($1) j", [s1.rows[0].j.state])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1,'EAAB-NOVO-TOKEN-NAO-CONFIRMADO-0123456789',null)", [rs1.session_id]);
  await svc("select public.whatsapp_signup_fail($1,'meta_failed')", [rs1.session_id]);
  const afterFail = await connRow();
  ck("9.2 tentativa que NÃO se confirma: credencial antiga, número e histórico intactos; o token novo não confirmado some do Vault", afterFail.token_secret_id === oldSecret && afterFail.token_status === "revoked" && (await su("select count(*) n from vault.decrypted_secrets where id=$1", [oldSecret])).rows[0].n == 1);
  const s2 = (await OWN("select public.whatsapp_signup_begin($1) j", [c])).rows[0].j;
  const rs2 = (await svc("select public.whatsapp_signup_reserve($1) j", [s2.state])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1,'EAAB-NOVO-TOKEN-CONFIRMADO-0123456789ab', now() + interval '60 days')", [rs2.session_id]);
  const cr = (await svc("select public.whatsapp_signup_complete($1,'555000111222','555000222','+55 44 90000-0000','Emp N',null,now(),now(),'cloud_api') j", [rs2.session_id])).rows[0].j;
  const after = await connRow();
  ck("9.3 reconexão confirmada: MESMA linha/número, credencial trocada, token_status=valid, erro limpo, prazo novo, histórico mantido", cr.ok === true && after.id === conn && after.phone_number_id === "555000222" && after.token_secret_id !== oldSecret && after.token_status === "valid" && after.last_error_code === null && after.token_expires_at !== null && after.status === "active");
  ck("9.4 só agora a credencial antiga foi removida; o envio volta a funcionar (sem sondagem, sem bloqueio)", (await su("select count(*) n from vault.decrypted_secrets where id=$1", [oldSecret])).rows[0].n == 0 && (await eff()) === "valid");
  ck("9.5 mensagens e conversas anteriores preservadas", Number((await su("select count(*) n from whatsapp_messages where company_id=$1", [c])).rows[0].n) > 0 && Number((await su("select count(*) n from whatsapp_conversations where company_id=$1", [c])).rows[0].n) > 0);
  await su("update whatsapp_platform_settings set embedded_signup_enabled=false");
  await su("delete from whatsapp_signup_pilot_companies where company_id=$1", [c]);
}

console.log("\n== 10. registros incertos: análise e resolução administrativa ==");
{
  // monta um registro 'uncertain' com PIN e token retido (fluxo real do banco)
  const co = must(await su("insert into companies (name,slug,document,email) values ('Emp Reg','on-e2e-reg','11222333000181','r@x.com') returning id"), "empresa reg").rows[0].id;
  const ow = id(2010);
  await su(`insert into auth.users (id,email) values ('${ow}','owner-reg@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${ow}','owner-reg@x.com','r') on conflict (user_id) do nothing`);
  await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [co, ow]);
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste', now() + interval '1 day')", [co]);
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1,true,now())", [co]);
  await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id='1234567890', embedded_signup_config_id='9876543210'");
  const OWR = U(ow);
  async function mkUncertain(pn, finish = "uncertain") {
    const st = (await OWR("select public.whatsapp_signup_begin($1) j", [co])).rows[0].j.state;
    const rs = (await svc("select public.whatsapp_signup_reserve($1) j", [st])).rows[0].j;
    await svc("select public.whatsapp_signup_store_token($1,$2,null)", [rs.session_id, `EAAB-TOKEN-REG-${pn}-0123456789abcdef`]);
    const prep = (await svc("select public.whatsapp_registration_prepare($1,$2,'555000111222') j", [rs.session_id, pn])).rows[0].j;
    await svc("select public.whatsapp_registration_store_pin($1,$2,'246810','generated') j", [rs.session_id, prep.registration_id]);
    const ba = (await svc("select public.whatsapp_registration_begin_attempt($1,$2) j", [rs.session_id, prep.registration_id])).rows[0].j;
    if (finish) await svc("select public.whatsapp_registration_finish_attempt($1,$2,'timeout') j", [ba.attempt_id, finish]);
    await svc("select public.whatsapp_signup_fail($1,'registration_uncertain') j", [rs.session_id]);
    return { reg: prep.registration_id, sid: rs.session_id, attempt: ba.attempt_id };
  }
  const u1 = await mkUncertain("777000111");
  const tokAlive = async (sid) => Number((await su("select count(*) n from vault.secrets where name = 'wa_token_signup_' || $1", [sid])).rows[0].n);
  const pinAlive = async (reg) => Number((await su("select count(*) n from vault.secrets v join whatsapp_number_registrations r on r.pin_secret_id=v.id where r.id=$1", [reg])).rows[0].n);
  ck("10.1 pré-condição: registro 'uncertain' com token e PIN preservados", (await su("select state from whatsapp_number_registrations where id=$1", [u1.reg])).rows[0].state === "uncertain" && (await tokAlive(u1.sid)) === 1 && (await pinAlive(u1.reg)) === 1);
  await svc("select public.whatsapp_signup_sweep() j");
  ck("10.2 enquanto não resolvido, a varredura NÃO apaga token nem PIN", (await tokAlive(u1.sid)) === 1 && (await pinAlive(u1.reg)) === 1);

  const lst = (await MASTER("select public.master_whatsapp_registration_list() j")).rows[0].j;
  const it = lst.find((x) => x.registration_id === u1.reg);
  ck("10.3 listagem do Admin Master: dados operacionais e código do erro, sem PIN/token", !!it && it.state === "uncertain" && it.company_name === "Emp Reg" && it.phone_number_id === "777000111" && it.pin_stored === true && it.token_retained === true && it.last_attempt.status === "uncertain" && it.last_attempt.meta_code === "timeout"
    && !/246810|EAAB-TOKEN|pin_secret|token_secret/.test(JSON.stringify(lst)));
  ck("10.4 owner da empresa, owner de outra empresa e anon NÃO listam nem resolvem", !(await OWR("select public.master_whatsapp_registration_list()")).ok && !(await OWN2("select public.master_whatsapp_registration_list()")).ok && !(await as("anon", null, "select public.master_whatsapp_registration_list()")).ok
    && !(await OWR("select public.master_whatsapp_registration_resolve($1,'failed','meta_dashboard','motivo suficiente aqui','evidência suficiente aqui')", [u1.reg])).ok && !(await svc("select public.master_whatsapp_registration_resolve($1,'failed','meta_dashboard','motivo suficiente aqui','evidência suficiente aqui')", [u1.reg])).ok);
  const R = (reg, outcome, type = "meta_dashboard", reason = "Conferido no painel da Meta pelo suporte", evid = "Número aparece como CONECTADO no WhatsApp Manager em 29/10") => MASTER("select public.master_whatsapp_registration_resolve($1,$2,$3,$4,$5) j", [reg, outcome, type, reason, evid]);
  ck("10.5 exige evidência: motivo/evidência curtos ou ausentes, tipo de evidência e resultado inválidos são recusados", !(await R(u1.reg, "registered", "meta_dashboard", "curto", "evidência suficiente aqui")).ok && !(await R(u1.reg, "registered", "meta_dashboard", "motivo suficiente aqui", "")).ok && !(await R(u1.reg, "registered", "palpite", "motivo suficiente aqui", "evidência suficiente aqui")).ok && !(await R(u1.reg, "pending")).ok
    && (await su("select state from whatsapp_number_registrations where id=$1", [u1.reg])).rows[0].state === "uncertain" && Number((await su("select count(*) n from whatsapp_registration_resolutions")).rows[0].n) === 0);
  const res = (await R(u1.reg, "registered")).rows[0].j;
  const row = (await su("select * from whatsapp_registration_resolutions where registration_id=$1", [u1.reg])).rows[0];
  ck("10.6 resolução com evidência: state=registered; auditoria com quem, quando, motivo, tipo e texto da evidência e o estado anterior", res.ok === true && (await su("select state from whatsapp_number_registrations where id=$1", [u1.reg])).rows[0].state === "registered" && row.resolved_by === master && !!row.resolved_at && row.prior_state === "uncertain" && row.evidence_type === "meta_dashboard" && /painel da Meta/.test(row.reason) && /CONECTADO/.test(row.evidence));
  ck("10.7 limpeza segura SÓ depois da resolução: token da sessão encerrada removido; PIN do número registrado PRESERVADO", (await tokAlive(u1.sid)) === 0 && (await pinAlive(u1.reg)) === 1 && res.secrets_removed >= 1);
  ck("10.8 nenhuma nova chamada de registro: nenhuma tentativa 'started' nova (só a manual de auditoria)", Number((await su("select count(*) n from whatsapp_registration_attempts where registration_id=$1 and status='started'", [u1.reg])).rows[0].n) === 0 && (await su("select count(*) n from whatsapp_registration_attempts where registration_id=$1 and status='manual_registered'", [u1.reg])).rows[0].n == 1);
  ck("10.9 resolver de novo (agora 'registered') é recusado e não gera outra auditoria", (await R(u1.reg, "failed")).rows[0].j.error === "state_not_allowed" && Number((await su("select count(*) n from whatsapp_registration_resolutions where registration_id=$1", [u1.reg])).rows[0].n) === 1);
  ck("10.10 auditoria sem acesso do cliente", !(await OWR("select * from whatsapp_registration_resolutions")).ok && !(await OWN2("select * from whatsapp_registration_resolutions")).ok);

  // resolver como FAILED
  const u2 = await mkUncertain("777000222");
  const res2 = (await R(u2.reg, "failed", "graph_api_check", "Consulta à Graph mostra o número NÃO registrado", "GET do phone_number não retornou status CONNECTED")).rows[0].j;
  ck("10.11 resolução 'failed': state=failed, token limpo, PIN mantido pela política própria (varredura de 7 dias) e auditoria registrada", res2.ok === true && (await su("select state from whatsapp_number_registrations where id=$1", [u2.reg])).rows[0].state === "failed" && (await tokAlive(u2.sid)) === 0 && (await pinAlive(u2.reg)) === 1
    && (await su("select evidence_type from whatsapp_registration_resolutions where registration_id=$1", [u2.reg])).rows[0].evidence_type === "graph_api_check");

  // in_progress: só se a tentativa estiver parada há mais de 30 min
  const u3 = await mkUncertain("777000333", null);
  ck("10.12 tentativa EM CURSO (iniciada agora): resolução recusada — a chamada à Meta pode estar em andamento — e token/PIN preservados", (await R(u3.reg, "failed")).rows[0].j.error === "operation_may_be_in_flight" && (await su("select state from whatsapp_number_registrations where id=$1", [u3.reg])).rows[0].state === "in_progress" && (await tokAlive(u3.sid)) === 1 && (await pinAlive(u3.reg)) === 1);
  await su("update whatsapp_registration_attempts set started_at = now() - interval '31 minutes' where id=$1", [u3.attempt]);
  const res3 = (await R(u3.reg, "failed", "meta_support", "Suporte da Meta confirmou que não houve registro", "Ticket do suporte confirmando ausência de registro para o número")).rows[0].j;
  ck("10.13 tentativa parada há mais de 30 min: pode ser resolvida (evidência do suporte) e então o token é limpo", res3.ok === true && (await tokAlive(u3.sid)) === 0);
  ck("10.14 a RPC antiga whatsapp_registration_resolve continua só para service_role, sem ator/evidência (por isso NÃO é o caminho do administrador)", (await svc("select public.whatsapp_registration_resolve($1,'failed') j", [u1.reg])).ok && !(await MASTER("select public.whatsapp_registration_resolve($1,'failed')", [u1.reg])).ok);
  await su("update whatsapp_platform_settings set embedded_signup_enabled=false");
  await su("delete from whatsapp_signup_pilot_companies where company_id=$1", [co]);
}

console.log("\n== 11. ausência de exposição de credenciais ==");
{
  const all = logs.join("\n");
  ck("11.1 logs da suíte inteira sem token do Vault, telefone ou texto das mensagens", !all.includes(TOKEN) && !all.includes("EAAB-") && !/5544997\d{6}/.test(all) && !all.includes("Teste de saúde do token"));
  const leak = (await su(`select (select count(*) from company_whatsapp_connections c where c::text like '%'||$1||'%')
     + (select count(*) from whatsapp_token_alerts a where a::text like '%EAAB-%' or a::text like '%'||$1||'%')
     + (select count(*) from whatsapp_registration_resolutions r where r::text like '%EAAB-%' or r::text like '%246810%')
     + (select count(*) from whatsapp_messages m where m::text like '%'||$1||'%') n`, [TOKEN])).rows[0].n;
  ck("11.2 token e PIN não aparecem em conexões, alertas, auditoria de resolução nem mensagens", Number(leak) === 0);
}

summary("WHATSAPP TOKEN HEALTH + RECUPERAÇÃO DE REGISTROS");
