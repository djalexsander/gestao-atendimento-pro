// Coexistence, Etapa 3 (20261124010000): webhook REAL (handler transpilado) sobre o banco REAL (PGlite com todas as migrations).
// Cobre: eco do app Business (smb_message_echoes) com deduplicação e pausa da IA, sincronização (smb_app_state_sync/history) só como
// contagens, account_update (desconexão/reconexão) com bloqueio de envio, isolamento entre empresas, Cloud API tradicional intacta,
// concorrência, idempotência, assinatura, ACL e ausência de vazamento.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wacoex-"));
const loadTs = async (src, name) => {
  const code = ts.transpileModule(fs.readFileSync(path.join(srcRoot, src), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  fs.writeFileSync(path.join(tmp, name), code);
  return import(pathToFileURL(path.join(tmp, name)).href);
};
const W = await loadTs("supabase/functions/whatsapp-webhook/handler.ts", "webhook.mjs");

const { pg, ck, as: as0, su: su00, errHas, summary } = await loadAll();
let chain = Promise.resolve();
const mutex = (fn) => { const r = chain.then(fn, fn); chain = r.then(() => {}, () => {}); return r; };
const as = (...a) => mutex(() => as0(...a));
const su = (sql, params) => mutex(async () => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su00(sql, params); });
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const svc = (sql, params) => as("service_role", null, sql, params);
const anon = (sql, params) => as("anon", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uuid = (n) => `99999999-0000-4000-8000-${String(n).padStart(12, "0")}`;
await pg.exec(`alter table vault.decrypted_secrets add column if not exists id uuid;`);

// ---------------------------------------------------------------- fixtures
let seq = 500;
async function mkCo(tag) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "cx-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
  const out = { c, ids: {} };
  for (const role of ["owner", "admin", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u); out.ids[role] = u;
  }
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste coexistence', now() + interval '1 day')", [c]);
  return out;
}
const A = await mkCo("A"), B = await mkCo("B"), C = await mkCo("C"), D = await mkCo("D");
const tok = uuid(1);
await su("insert into vault.decrypted_secrets (id, name, decrypted_secret) values ($1,'wa_token_cx','TOKEN-SECRETO-DE-TESTE')", [tok]);
const WABA_A = "900000000001", WABA_B = "900000000002", WABA_D = "900000000004";
const mkConn = async (co, pn, { type = "coexistence", source = "embedded_signup", waba, status = "active" } = {}) =>
  (await su("insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, display_phone_number, token_secret_id, connection_type, connection_source, waba_id) values ($1,$2,'test',$3,'+55 44 90000-0000',$4,$5,$6,$7) returning id",
    [co.c, status, pn, tok, type, source, waba]));
const connA = (await mkConn(A, "111000111", { waba: WABA_A })).rows[0].id;
const connB = (await mkConn(B, "222000222", { waba: WABA_B })).rows[0].id;
// C = empresa Cloud API TRADICIONAL (conexão manual, como a Djalexeventos) na MESMA WABA que A: nunca pode ser afetada
const connC = (await mkConn(C, "333000333", { type: "cloud_api", source: "manual", waba: WABA_A })).rows[0].id;
const connD = (await mkConn(D, "444000444", { waba: WABA_D })).rows[0].id;
for (const [co, conn] of [[A, connA], [B, connB], [C, connC], [D, connD]]) {
  await su("insert into whatsapp_test_recipients (company_id, connection_id, phone_e164) values ($1,$2,'5544999990001')", [co.c, conn]);
}
const S = (co, role, ...a) => co[role]("select public.whatsapp_ai_update_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) j", a);
const base = (c) => [c, true, "auto", "Espeto do Alex", "cordial", "Vendemos espetinho a R$ 12,00.", null, true, 12, true, true, null, null, null];
for (const co of [A, B, C, D]) await S(co, "owner", ...base(co.c));

const FROM = "5544999990001";
let n = 0;
const ingest = (pn, from, body = "oi", wamid = `wamid.in.${++n}`) =>
  svc("select public.whatsapp_ingest_message($1,$2,$3,'Maria','text',$4,now(),$5) j", [pn, wamid, from, body, `msg:${pn}:${wamid}`]);
const convOf = async (co) => (await su("select * from whatsapp_conversations where company_id=$1 and deleted_at is null order by created_at limit 1", [co.c])).rows[0];
const jobsOf = async (cid, w = "true") => (await su(`select * from whatsapp_ai_jobs where conversation_id=$1 and ${w} order by created_at, id`, [cid])).rows;
const msgs = async (cid, w = "true") => (await su(`select * from whatsapp_messages where conversation_id=$1 and ${w} order by created_at, id`, [cid])).rows;
const evs = async (co, kind) => (await su("select * from whatsapp_coexistence_events where (company_id=$1 or company_id is null) and kind=$2 order by created_at", [co.c, kind])).rows;

// ---------------------------------------------------------------- webhook
const APP_SECRET = "APP-SECRET-DE-TESTE-COEX";
const logs = [];
const origC = { warn: console.warn, error: console.error, info: console.info };
async function capture(fn) {
  console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a));
  try { return await fn(); } finally { Object.assign(console, origC); }
}
const rpcCalls = [];
let failRpc = null;
const db = {
  async rpc(fn, args) {
    rpcCalls.push(fn);
    if (failRpc && failRpc === fn) return { data: null, error: { code: "XX000", message: "falha simulada" } };
    const keys = Object.keys(args);
    const params = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === "object" ? "::jsonb" : ""}`).join(", ")}) j`;
    const r = await svc(sql, params);
    return r.ok ? { data: r.rows[0].j, error: null } : { data: null, error: { code: r.code, message: r.err } };
  },
};
async function post(payload, { sig, secret = APP_SECRET, raw } = {}) {
  const body = raw ?? JSON.stringify(payload);
  const signature = sig ?? "sha256=" + (await W.hmacSha256Hex(secret, body));
  const req = new Request("https://x.supabase.co/functions/v1/whatsapp-webhook", { method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body });
  const res = await capture(() => W.handleWhatsappWebhook(req, { verifyToken: "vt", appSecret: APP_SECRET, db }));
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { /* */ }
  return { status: res.status, j, text };
}
const wrap = (waba, changes, time = 1700000000) => ({ object: "whatsapp_business_account", entry: [{ id: waba, time, changes }] });
const meta = (pn) => ({ display_phone_number: "554490000000", phone_number_id: pn });
const echo = (pn, waba, items, contacts) => wrap(waba, [{ field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: meta(pn), ...(contacts ? { contacts } : {}), message_echoes: items } }]);
const echoMsg = (id, to, text = "Já estou indo aí!", extra = {}) => ({ from: "554490000000", ...(to ? { to } : {}), id, timestamp: String(Math.floor(Date.now() / 1000) + 5), type: "text", text: { body: text }, ...extra });

// ---------------------------------------------------------------- AI helpers (mesmo pipeline real)
const makeDue = (jid) => su("update whatsapp_ai_jobs set run_after = now() - interval '1 second' where id=$1", [jid]);
const claim = (lim = 5, lease = 120) => svc("select * from public.whatsapp_ai_claim_jobs($1,$2)", [lim, lease]);
const prep = (jid) => svc("select public.whatsapp_ai_prepare_auto($1) j", [jid]);
const commit = (jid, ctx, body = "Temos espetinho a R$ 12,00.") => svc("select public.whatsapp_ai_auto_commit_send($1,$2,$3) j", [jid, ctx, body]);
const lastInbound = async (cid) => (await su("select id from whatsapp_messages where conversation_id=$1 and direction='inbound' order by created_at desc, id desc limit 1", [cid])).rows[0].id;
const activeJob = async (cid) => (await jobsOf(cid, "status in ('pending','processing')"))[0];

// primeira inbound em cada empresa
await ingest("111000111", FROM, "primeira A", "wamid.seed.A");
await ingest("222000222", FROM, "primeira B", "wamid.seed.B");
await ingest("333000333", FROM, "primeira C", "wamid.seed.C");
await ingest("444000444", FROM, "primeira D", "wamid.seed.D");
let cA = await convOf(A), cB = await convOf(B), cC = await convOf(C), cD = await convOf(D);

console.log("\n== 1. eco do app Business: grava, deduplica e pausa a IA ==");
{
  const job = await activeJob(cA.id);
  ck("1.0 pré-condição: a inbound enfileirou um job da IA e a conversa está com a IA ativa", !!job && job.status === "pending" && cA.ai_control === "inherit");
  const before = await convOf(A);
  const r = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.1", FROM, "Já estou indo aí!")]));
  const m = await msgs(cA.id, "provider_message_id='wamid.echo.1'");
  const after = await convOf(A);
  ck("1.1 200 e o eco é GRAVADO como saída humana pelo app (sent_via=business_app, origin=human, sem usuário, status sent)", r.status === 200 && r.j.stored === 1 && m.length === 1
    && m[0].direction === "outbound" && m[0].origin === "human" && m[0].sent_via === "business_app" && m[0].sent_by_user_id === null && m[0].status === "sent" && m[0].body === "Já estou indo aí!", r.text);
  ck("1.2 a IA é PAUSADA na conversa (ai_control=human) e o job pendente é cancelado (aborted_human/business_app_message)", after.ai_control === "human" && (await jobsOf(cA.id, "status='cancelled'")).some((j) => j.id === job.id && j.outcome === "aborted_human" && j.reason_code === "business_app_message") && !(await activeJob(cA.id)));
  const ev = (await su("select * from whatsapp_conversation_events where conversation_id=$1 and event_type='ai_paused'", [cA.id])).rows;
  ck("1.3 evento ai_paused com motivo business_app_message (não 'manual_send')", ev.length === 1 && ev[0].new_value.reason === "business_app_message" && ev[0].actor_user_id === null, JSON.stringify(ev.map((e) => e.new_value)));
  ck("1.4 o eco NÃO abre nem estende a janela de 24 h (last_inbound_at e unread_count intactos) e atualiza a saída/prévia", String(after.last_inbound_at) === String(before.last_inbound_at) && after.unread_count === before.unread_count && !!after.last_outbound_at && after.last_message_preview === "Já estou indo aí!");
  const again = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.1", FROM, "Já estou indo aí!")]));
  ck("1.5 reentrega do MESMO eco: duplicate, nada novo (idempotente)", again.status === 200 && again.j.duplicate === 1 && again.j.stored === 0 && (await msgs(cA.id, "provider_message_id='wamid.echo.1'")).length === 1);
  const dupKey = await svc("select public.whatsapp_ingest_echo($1,'wamid.echo.1',$2,'text','x',now(),'chave-diferente') j", ["111000111", FROM]);
  ck("1.6 mesmo wamid com outra chave de evento: duplicate pelo wamid (sem segunda mensagem)", dupKey.rows[0].j.result === "duplicate" && (await msgs(cA.id, "provider_message_id='wamid.echo.1'")).length === 1);
}

console.log("\n== 2. IA não responde por cima do humano (pipeline real) ==");
{
  // empresa B: job EM PROCESSAMENTO quando o eco chega => o commit final é abortado
  const j0 = await activeJob(cB.id);
  await makeDue(j0.id);
  const cl = await claim();
  const ctx = await lastInbound(cB.id);
  ck("2.0 pré-condição: job de B reivindicado (processing)", cl.rows.some((x) => x.id === j0.id || x.job_id === j0.id) || (await jobsOf(cB.id, "status='processing'")).length === 1);
  const r = await post(echo("222000222", WABA_B, [echoMsg("wamid.echo.B1", FROM, "Deixa que eu respondo")]));
  const c = await commit(j0.id, ctx);
  ck("2.1 eco chega com a IA gerando resposta: o commit final ABORTA (aborted_human) e NENHUMA resposta automática é criada", r.status === 200 && c.ok && c.rows[0].j.result === "abort" && c.rows[0].j.outcome === "aborted_human"
    && (await msgs(cB.id, "origin='ai_auto'")).length === 0, JSON.stringify(c.rows?.[0]?.j));
  // nova mensagem do cliente depois do eco: a IA continua pausada
  await ingest("222000222", FROM, "e então?", "wamid.in.B2");
  const j2 = await activeJob(cB.id);
  if (j2) await makeDue(j2.id);
  const pr = j2 ? await prep(j2.id) : null;
  ck("2.2 nova inbound depois do eco: conversa segue com a IA pausada e o preparo NÃO prossegue (nada de resposta duplicada)", (await convOf(B)).ai_control === "human" && (!j2 || (pr.ok && pr.rows[0].j.proceed === false)), JSON.stringify(pr?.rows?.[0]?.j));
  // devolver para a IA (RPC existente) volta a permitir respostas
  const back = await B.owner("select public.whatsapp_set_conversation_ai_control($1,'inherit') j", [cB.id]);
  ck("2.3 devolver a conversa para a IA (RPC existente) volta ao normal", back.ok && (await convOf(B)).ai_control === "inherit");
}

console.log("\n== 3. diferenciar o envio da PRÓPRIA API do envio humano pelo app ==");
{
  // D: mensagem da API ainda em voo (queued) com o MESMO texto => o eco é o nosso próprio envio: não pausa, não duplica
  const q = (await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, ai_job_id, sent_by_user_id, client_request_id)
    values ($1,$2,$3,null,'outbound','text','Pedido confirmado!','queued','human',null,$4,gen_random_uuid()) returning id`, [D.c, connD, cD.id, D.ids.owner])).rows[0].id;
  await su("update whatsapp_conversations set ai_control='inherit' where id=$1", [cD.id]);
  const r = await post(echo("444000444", WABA_D, [echoMsg("wamid.echo.D1", FROM, "Pedido confirmado!")]));
  ck("3.1 eco do MESMO texto de um envio da API em voo: api_match, sem mensagem nova e a IA NÃO é pausada", r.status === 200 && r.j.ignored === 1 && (await msgs(cD.id, "sent_via='business_app'")).length === 0 && (await convOf(D)).ai_control === "inherit"
    && (await evs(D, "echo_api_match")).length === 1);
  // envio da API já registrado (tem wamid): eco com o mesmo wamid é duplicate
  await su("update whatsapp_messages set status='sent', provider_message_id='wamid.api.D1' where id=$1", [q]);
  const r2 = await post(echo("444000444", WABA_D, [echoMsg("wamid.api.D1", FROM, "Pedido confirmado!")]));
  ck("3.2 eco com o wamid de uma mensagem enviada pela API: duplicate (não vira 'humano')", r2.j.duplicate === 1 && (await convOf(D)).ai_control === "inherit" && (await msgs(cD.id, "provider_message_id='wamid.api.D1'")).length === 1);
  // texto diferente = pessoa digitou no celular
  const q2 = (await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_by_user_id, client_request_id)
    values ($1,$2,$3,null,'outbound','text','Outra coisa','queued','human',$4,gen_random_uuid()) returning id`, [D.c, connD, cD.id, D.ids.owner])).rows[0].id;
  const r3 = await post(echo("444000444", WABA_D, [echoMsg("wamid.echo.D3", FROM, "Texto digitado no celular")]));
  ck("3.3 eco de texto diferente do envio em voo: é humano pelo app (grava e pausa a IA)", r3.j.stored === 1 && (await convOf(D)).ai_control === "human");
  // corrida: o eco (já gravado) usa o MESMO wamid que a API vai registrar depois => mark_message_sent não falha
  const r4 = await post(echo("444000444", WABA_D, [echoMsg("wamid.race.D4", FROM, "Texto digitado no celular 2")]));
  const mk = await svc("select public.whatsapp_mark_message_sent($1,'wamid.race.D4',now()) j", [q2]);
  const rows = await msgs(cD.id, "provider_message_id='wamid.race.D4'");
  ck("3.4 corrida eco x registro do envio da API (mesmo wamid): mark_message_sent NÃO falha, fica UMA mensagem (a nossa, sent_via=cloud_api)", r4.j.stored === 1 && mk.ok && mk.rows[0].j.result === "sent" && rows.length === 1 && rows[0].id === q2 && rows[0].sent_via === "cloud_api", JSON.stringify(mk.rows?.[0]?.j ?? mk));
  const plain = await svc("select public.whatsapp_mark_message_sent($1,$2,now()) j", [(await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_by_user_id, client_request_id) values ($1,$2,$3,null,'outbound','text','z','queued','human',$4,gen_random_uuid()) returning id`, [D.c, connD, cD.id, D.ids.owner])).rows[0].id, "wamid.plain.D5"]);
  ck("3.5 mark_message_sent sem conflito continua igual (regressão)", plain.ok && plain.rows[0].j.result === "sent");
  const conflict = await svc("select public.whatsapp_mark_message_sent($1,'wamid.in.1',now()) j", [(await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_by_user_id, client_request_id) values ($1,$2,$3,null,'outbound','text','y','queued','human',$4,gen_random_uuid()) returning id`, [A.c, connA, cA.id, A.ids.owner])).rows[0].id]);
  await su("insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status) values ($1,$2,$3,'wamid.dup.in','inbound','text','x','received')", [A.c, connA, cA.id]);
  const hard = await svc("select public.whatsapp_mark_message_sent($1,'wamid.dup.in',now()) j", [(await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_by_user_id, client_request_id) values ($1,$2,$3,null,'outbound','text','w','queued','human',$4,gen_random_uuid()) returning id`, [A.c, connA, cA.id, A.ids.owner])).rows[0].id]);
  ck("3.6 conflito de wamid com mensagem que NÃO é eco: o erro original é mantido (nunca apaga mensagem real)", !hard.ok && (await msgs(cA.id, "provider_message_id='wamid.dup.in'")).length === 1);
}

console.log("\n== 4. conversa nova pelo celular, nono dígito, sem telefone ==");
{
  const r = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.new", "5544988880002", "Oi! Aqui é do restaurante.")]));
  const c = (await su("select * from whatsapp_conversations where company_id=$1 and contact_phone='5544988880002'", [A.c])).rows[0];
  ck("4.1 pessoa escreve primeiro pelo celular: cria a conversa JÁ com a IA pausada e nenhum job", r.j.stored === 1 && !!c && c.ai_control === "human" && (await jobsOf(c.id)).length === 0 && (await msgs(c.id)).length === 1);
  // nono dígito: conversa existente sem o 9; eco com o 9
  await ingest("111000111", "554499990003", "oi sem nove", "wamid.in.nine");
  const conv9 = (await su("select * from whatsapp_conversations where company_id=$1 and contact_phone='554499990003'", [A.c])).rows[0];
  const r2 = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.nine", "5544999990003", "resposta com o nono dígito")]));
  const total = Number((await su("select count(*) n from whatsapp_conversations where company_id=$1 and contact_phone in ('554499990003','5544999990003')", [A.c])).rows[0].n);
  ck("4.2 variação do nono dígito brasileiro: o eco cai na MESMA conversa (sem conversa duplicada) e pausa a IA", r2.j.stored === 1 && total === 1 && (await msgs(conv9.id, "provider_message_id='wamid.echo.nine'")).length === 1 && (await su("select ai_control from whatsapp_conversations where id=$1", [conv9.id])).rows[0].ai_control === "human");
  // sem 'to' e sem contacts: só BSUID
  const r3 = await post(echo("111000111", WABA_A, [{ from: "554490000000", to_user_id: "US.123", id: "wamid.echo.bsuid", timestamp: "1700000000", type: "text", text: { body: "sem telefone" } }]));
  ck("4.3 eco sem telefone do destinatário (só BSUID): não dá para mapear => 'unmapped', nada gravado e nada pausado", r3.j.ignored === 1 && (await msgs(cA.id, "provider_message_id='wamid.echo.bsuid'")).length === 0 && (await evs(A, "echo_unmapped")).length === 1);
  // 'to' ausente mas contacts[0].wa_id presente
  const r4 = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.contact", null, "via contacts")], [{ wa_id: "5544988880002", user_id: "US.1" }]));
  ck("4.4 sem 'to' mas com contacts[0].wa_id: usa o wa_id", r4.j.stored === 1);
  const r5 = await post(echo("111000111", WABA_A, [{ from: "554490000000", to: "5544988880002", id: "wamid.echo.img", timestamp: "1700000001", type: "image", image: { id: "m1", caption: "foto do prato" } }]));
  const im = (await msgs((await su("select id from whatsapp_conversations where company_id=$1 and contact_phone='5544988880002'", [A.c])).rows[0].id, "provider_message_id='wamid.echo.img'"))[0];
  ck("4.5 mídia enviada pelo app: grava só o tipo e a legenda (sem mídia, sem id de arquivo)", r5.j.stored === 1 && im.type === "image" && im.body === "foto do prato");
}

console.log("\n== 5. Cloud API tradicional e isolamento entre empresas ==");
{
  const beforeMsgs = (await msgs(cC.id)).length;
  const jobC = await activeJob(cC.id);
  const r = await post(echo("333000333", WABA_A, [echoMsg("wamid.echo.C1", FROM, "tentativa de eco em Cloud API")]));
  ck("5.1 empresa Cloud API tradicional (conexão manual) NUNCA é afetada por eco: nada gravado, IA ativa, job intacto", r.status === 200 && r.j.ignored === 1 && (await msgs(cC.id)).length === beforeMsgs && (await convOf(C)).ai_control === "inherit" && (await activeJob(cC.id))?.id === jobC.id
    && Number((await su("select count(*) n from whatsapp_webhook_events where provider_event_key like 'echo:333000333:%'")).rows[0].n) === 0);
  const sync = await post(wrap(WABA_A, [{ field: "smb_app_state_sync", value: { messaging_product: "whatsapp", metadata: meta("333000333"), state_sync: [{ type: "contact", action: "add", contact: { full_name: "X", phone_number: "5544" }, metadata: { timestamp: "1" } }] } }]));
  const hist = await post(wrap(WABA_A, [{ field: "history", value: { messaging_product: "whatsapp", metadata: meta("333000333"), history: [{ metadata: { phase: 0, chunk_order: 1, progress: 10 }, threads: [] }] } }]));
  ck("5.2 sincronização/histórico para conexão Cloud API tradicional: ignorados (nada registrado)", sync.j.ignored === 1 && hist.j.ignored === 1 && (await evs(C, "contact_sync")).length === 0 && (await evs(C, "history_chunk")).length === 0);
  // isolamento: mesmo telefone do cliente nas duas empresas; eco em A não toca B nem D
  const bAi = (await convOf(B)).ai_control;
  const r2 = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.iso", FROM, "só para A")]));
  ck("5.3 eco da empresa A não grava nem pausa nada em B (mesmo telefone de cliente)", r2.j.stored + r2.j.duplicate >= 0 && (await msgs(cB.id, "provider_message_id='wamid.echo.iso'")).length === 0 && (await convOf(B)).ai_control === bAi);
  const r3 = await post(echo("999999999", WABA_A, [echoMsg("wamid.echo.unk", FROM)]));
  ck("5.4 phone_number_id desconhecido: ignorado, nada gravado", r3.status === 200 && r3.j.ignored === 1);
  await su("update company_whatsapp_connections set status='disconnected' where id=$1", [connB]);
  const r4 = await post(echo("222000222", WABA_B, [echoMsg("wamid.echo.inactive", FROM)]));
  await su("update company_whatsapp_connections set status='active' where id=$1", [connB]);
  ck("5.5 conexão desativada: eco ignorado (nada gravado)", r4.j.ignored === 1 && (await msgs(cB.id, "provider_message_id='wamid.echo.inactive'")).length === 0);
  // regressão: mensagens e statuses normais continuam funcionando em ambos os tipos de conexão
  const reg = await post(wrap(WABA_A, [{ field: "messages", value: { messaging_product: "whatsapp", metadata: meta("333000333"), contacts: [{ wa_id: FROM, profile: { name: "Maria" } }], messages: [{ from: FROM, id: "wamid.reg.C", timestamp: "1700000100", type: "text", text: { body: "regressão" } }] } }]));
  const reg2 = await post(wrap(WABA_A, [{ field: "messages", value: { messaging_product: "whatsapp", metadata: meta("111000111"), contacts: [{ wa_id: FROM, profile: { name: "Maria" } }], messages: [{ from: FROM, id: "wamid.reg.A", timestamp: "1700000101", type: "text", text: { body: "regressão" } }] } }]));
  ck("5.6 REGRESSÃO: inbound normal continua sendo gravado (Cloud API e Coexistence)", reg.j.stored === 1 && reg2.j.stored === 1);
  const st = await post(wrap(WABA_A, [{ field: "messages", value: { messaging_product: "whatsapp", metadata: meta("111000111"), statuses: [{ id: "wamid.echo.1", status: "delivered", timestamp: "1700000200" }] } }]));
  ck("5.7 REGRESSÃO: status de entrega continua funcionando", st.status === 200);
}

console.log("\n== 6. sincronização (contatos e histórico): SÓ registro seguro, nada importado ==");
{
  const stateSync = wrap(WABA_A, [{ field: "smb_app_state_sync", value: { messaging_product: "whatsapp", metadata: meta("111000111"), state_sync: [
    { type: "contact", action: "add", contact: { full_name: "Fulano Secreto", first_name: "Fulano", phone_number: "5544977776666", user_id: "US.9" }, metadata: { timestamp: "1700000300" } },
    { type: "contact", action: "add", contact: { full_name: "Beltrana", phone_number: "5544966665555" }, metadata: { timestamp: "1700000301" } },
    { type: "contact", action: "remove", contact: { phone_number: "5544955554444" }, metadata: { timestamp: "1700000302" } }] } }]);
  const convsBefore = Number((await su("select count(*) n from whatsapp_conversations")).rows[0].n);
  const r = await post(stateSync);
  const rows = await evs(A, "contact_sync");
  ck("6.1 smb_app_state_sync: registra só as contagens (2 adicionados, 1 removido)", r.j.stored === 1 && rows.length === 1 && rows[0].detail.added === 2 && rows[0].detail.removed === 1);
  const dump = JSON.stringify((await su("select * from whatsapp_coexistence_events")).rows);
  ck("6.2 nenhum nome, telefone ou texto do payload é guardado (trilha e demais tabelas)", !/Fulano|Beltrana|5544977776666|5544966665555|5544955554444|US\.9/.test(dump)
    && Number((await su("select count(*) n from customers where name ilike '%Fulano%'")).rows[0].n) === 0 && Number((await su("select count(*) n from whatsapp_conversations")).rows[0].n) === convsBefore);
  const r2 = await post(stateSync);
  ck("6.3 reentrega idêntica: duplicate (uma só linha)", r2.j.duplicate === 1 && (await evs(A, "contact_sync")).length === 1);
  const hist = (phase, chunk, progress, msgsN = 2) => wrap(WABA_A, [{ field: "history", value: { messaging_product: "whatsapp", metadata: meta("111000111"), history: [{ metadata: { phase, chunk_order: chunk, progress },
    threads: [{ id: "5544977776666", context: { wa_id: "5544977776666" }, messages: Array.from({ length: msgsN }, (_, i) => ({ from: "5544977776666", id: `wamid.hist.${phase}.${chunk}.${i}`, timestamp: "1700000400", type: "text", text: { body: "SEGREDO-DO-HISTORICO" }, history_context: { status: "READ" } })) }] }] } }]);
  const hr = await post(hist(0, 1, 25, 3));
  const hrows = await evs(A, "history_chunk");
  ck("6.4 history: registra fase, ordem, progresso e contagens (1 conversa, 3 mensagens) — sem importar", hr.j.stored === 1 && hrows.length === 1 && hrows[0].detail.phase === 0 && hrows[0].detail.chunk_order === 1 && hrows[0].detail.progress === 25 && hrows[0].detail.threads === 1 && hrows[0].detail.messages === 3);
  ck("6.5 o conteúdo do histórico NÃO foi importado: nenhuma mensagem/conversa criada e o texto não aparece em lugar nenhum", !(await su("select 1 from whatsapp_messages where provider_message_id like 'wamid.hist.%'")).rows.length
    && !JSON.stringify((await su("select * from whatsapp_coexistence_events")).rows).includes("SEGREDO-DO-HISTORICO") && !logs.join("").includes("SEGREDO-DO-HISTORICO") && !(await su("select 1 from whatsapp_conversations where contact_phone='5544977776666'")).rows.length);
  const hr2 = await post(hist(0, 1, 25, 3));
  const hr3 = await post(hist(1, 2, 60, 1));
  const hr4 = await post(hist(2, 1, 100, 1));
  ck("6.6 pedaços fora de ordem/repetidos: duplicate para o mesmo pedaço; fases distintas registradas; progresso 100 aceito", hr2.j.duplicate === 1 && hr3.j.stored === 1 && hr4.j.stored === 1 && (await evs(A, "history_chunk")).length === 3);
  const dec = await post(wrap(WABA_A, [{ field: "history", value: { messaging_product: "whatsapp", metadata: meta("111000111"), history: [{ errors: [{ code: 2593109, title: "recusou", message: "texto livre do payload", error_data: { details: "x" } }] }] } }]));
  const drow = await evs(A, "history_declined");
  ck("6.7 recusa do histórico pelo cliente (2593109): registrada com o código, sem o texto livre", dec.j.stored === 1 && drow.length === 1 && drow[0].detail.error_code === 2593109 && !JSON.stringify(drow).includes("texto livre"));
  // pedaço grande (acima do limite antigo de 1 MiB)
  const bigPayload = hist(1, 9, 80, 9000);
  const big = await post(bigPayload);
  ck("6.8 pedaço de histórico grande (> 1 MiB) é aceito (limite de corpo elevado), sem importar nada", JSON.stringify(bigPayload).length > 1024 * 1024 && big.status === 200 && big.j.stored === 1 && (await evs(A, "history_chunk")).some((e) => e.detail.messages === 9000));
  const mediaPayload = wrap(WABA_A, [{ field: "history", value: { messaging_product: "whatsapp", metadata: meta("111000111"), messages: [{ id: "m", type: "image", image: { id: "i" } }] } }]);
  const media = await post(mediaPayload);
  ck("6.9 webhook de mídia do histórico: ignorado (fora desta etapa)", media.status === 200 && media.j.ignored === 1 && media.j.stored === 0);
  const bad = await post(wrap(WABA_A, [{ field: "history", value: { messaging_product: "whatsapp", metadata: meta("111000111"), history: [{ metadata: { phase: "x", chunk_order: -1 }, threads: [] }, "lixo", null] } }]));
  ck("6.10 histórico malformado: ignorado sem erro (200)", bad.status === 200 && bad.j.stored === 0);
  const rv = await post(echo("111000111", WABA_A, [{ from: "554490000000", to: FROM, id: "wamid.rev.1", timestamp: "1700000500", type: "revoke", revoke: { original_message_id: "wamid.echo.1" } },
    { from: "554490000000", to: FROM, id: "wamid.edit.1", timestamp: "1700000501", type: "edit", edit: { original_message_id: "wamid.echo.1", message: { text: { body: "EDITADO-SECRETO" } } } }]));
  ck("6.11 revoke/edit do app: só registrados (sem conteúdo); a mensagem original NÃO é alterada nem apagada", rv.j.stored === 2 && (await evs(A, "echo_revoke")).length === 1 && (await evs(A, "echo_edit")).length === 1
    && !JSON.stringify((await su("select * from whatsapp_coexistence_events")).rows).includes("EDITADO-SECRETO") && (await msgs(cA.id, "provider_message_id='wamid.echo.1'"))[0].body === "Já estou indo aí!");
}

{
  // defesa em profundidade: mesmo que o webhook mande lixo, o banco só aceita contagens inteiras de chaves conhecidas
  const r = await svc("select public.whatsapp_coexistence_record('111000111','contact_sync','smb_app_state_sync','dbtest:1',$1::jsonb) j", [JSON.stringify({ added: 2, removed: 1, nome: "SEGREDO-NOME", telefone: "5544900000000", nested: { a: 1 }, chave_numerica_desconhecida: 7, phase: "texto", progress: 12345678901, messages: 3 })]);
  const row = (await su("select detail from whatsapp_coexistence_events where provider_event_key='dbtest:1'")).rows[0];
  ck("6.12 o BANCO descarta qualquer chave fora da lista, textos e números gigantes do detalhe (só contagens inteiras pequenas)", r.ok && JSON.stringify(row.detail) === JSON.stringify({ added: 2, removed: 1, messages: 3 }) && !JSON.stringify(row).includes("SEGREDO"), JSON.stringify(row));
  const bad = await svc("select public.whatsapp_coexistence_record('111000111','qualquer_coisa','x','dbtest:2','{}'::jsonb) j");
  const bad2 = await svc("select public.whatsapp_coexistence_record('111000111','contact_sync','x',null,'{}'::jsonb) j");
  ck("6.13 tipo de registro desconhecido ou sem chave: 'invalid', nada gravado", bad.rows[0].j.result === "invalid" && bad2.rows[0].j.result === "invalid" && !(await su("select 1 from whatsapp_coexistence_events where provider_event_key='dbtest:2'")).rows.length);
}

console.log("\n== 7. account_update: desconexão, reconexão e bloqueio de envio ==");
{
  const au = (waba, event, extra = {}, time = 1700001000) => wrap(waba, [{ field: "account_update", value: { event, ...extra } }], time);
  const conn = async (c = connD) => (await su("select status, lifecycle_state, lifecycle_reason, disconnected_at from company_whatsapp_connections where id=$1", [c])).rows[0];
  // mensagem em fila + envio autorizado antes da desconexão
  const qid = (await su(`insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_by_user_id, client_request_id)
    values ($1,$2,$3,null,'outbound','text','na fila','queued','human',$4,gen_random_uuid()) returning id`, [D.c, connD, cD.id, D.ids.owner])).rows[0].id;
  const okCtx = await svc("select public.whatsapp_get_send_context($1) j", [qid]);
  ck("7.0 pré-condição: com a conexão ativa o contexto de envio é liberado", okCtx.rows[0].j.ok === true);
  const off = await post(au(WABA_D, "ACCOUNT_OFFBOARDED"));
  let c = await conn();
  ck("7.1 ACCOUNT_OFFBOARDED (Coexistence): envio PAUSADO (status error, lifecycle offboarded)", off.j.stored === 1 && c.status === "error" && c.lifecycle_state === "offboarded" && c.lifecycle_reason === "ACCOUNT_OFFBOARDED");
  const blocked = await svc("select public.whatsapp_get_send_context($1) j", [qid]);
  const prepD = await D.owner("select public.whatsapp_prepare_outbound_message($1, gen_random_uuid(), 'oi') j", [cD.id]);
  ck("7.2 com a conexão pausada NENHUM envio sai: contexto de envio recusa (connection_inactive) e o envio manual é recusado", blocked.rows[0].j.ok === false && blocked.rows[0].j.error === "connection_inactive" && errHas(prepD, /não está conectado/));
  const offAgain = await post(au(WABA_D, "ACCOUNT_OFFBOARDED"));
  ck("7.3 reentrega do OFFBOARDED: duplicate e estado intacto", offAgain.j.duplicate === 1 && (await conn()).status === "error");
  const rec = await post(au(WABA_D, "ACCOUNT_RECONNECTED", {}, 1700001100));
  c = await conn();
  ck("7.4 ACCOUNT_RECONNECTED reativa o que o OFFBOARDED pausou (active/normal) e o envio volta", rec.j.stored === 1 && c.status === "active" && c.lifecycle_state === "normal" && (await svc("select public.whatsapp_get_send_context($1) j", [qid])).rows[0].j.ok === true);
  const rec2 = await post(au(WABA_D, "ACCOUNT_RECONNECTED", {}, 1700001200));
  ck("7.5 RECONNECTED sem pausa anterior: não altera nada", rec2.j.stored === 1 && (await conn()).status === "active");
  // PARTNER_REMOVED
  const jobD0 = await ingest("444000444", FROM, "uma nova pergunta", "wamid.in.D9");
  await su("update whatsapp_conversations set ai_control='inherit' where id=$1", [cD.id]);
  const rm = await post(au(WABA_D, "PARTNER_REMOVED", { waba_info: { waba_id: WABA_D, owner_business_id: "1" }, disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" } }, 1700001300));
  c = await conn();
  ck("7.6 PARTNER_REMOVED: conexão DESCONECTADA (status disconnected, lifecycle removed, motivo PRIMARY_INACTIVITY, data registrada)", rm.j.stored === 1 && c.status === "disconnected" && c.lifecycle_state === "removed" && c.lifecycle_reason === "PRIMARY_INACTIVITY" && !!c.disconnected_at);
  ck("7.7 envio bloqueado e jobs pendentes da IA dessa conexão cancelados", (await svc("select public.whatsapp_get_send_context($1) j", [qid])).rows[0].j.ok === false && (await jobsOf(cD.id, "status='pending'")).length === 0);
  const recAfter = await post(au(WABA_D, "ACCOUNT_RECONNECTED", {}, 1700001400));
  ck("7.8 RECONNECTED NÃO reativa uma conexão removida (só reconectando pelo Embedded Signup)", (await conn()).status === "disconnected" && (await conn()).lifecycle_state === "removed");
  await su("update company_whatsapp_connections set status='active' where id=$1", [connD]);
  c = await conn();
  ck("7.9 reconectar (status volta a active, como faz o Embedded Signup) limpa o ciclo de vida (normal)", c.status === "active" && c.lifecycle_state === "normal" && c.lifecycle_reason === null);
  // isolamento: WABA_A tem A (coexistence/embedded) e C (cloud_api/manual)
  const rmA = await post(au(WABA_A, "PARTNER_REMOVED", { disconnection_info: { reason: "ACCOUNT_DISCONNECTED", initiated_by: "USER" } }, 1700001500));
  const cA2 = await conn(connA), cC2 = await conn(connC), cB2 = await conn(connB);
  ck("7.10 PARTNER_REMOVED na WABA de A: A desconectada; C (Cloud API manual na MESMA WABA) e B (outra WABA) INTACTAS", cA2.status === "disconnected" && cC2.status === "active" && cC2.lifecycle_state === "normal" && cB2.status === "active");
  await su("update company_whatsapp_connections set status='active' where id=$1", [connA]);
  const E = await mkCo("E");
  const connE = (await mkConn(E, "555000555", { type: "cloud_api", source: "embedded_signup", waba: "900000000005" })).rows[0].id;
  const tipo = await post(au("900000000005", "ACCOUNT_OFFBOARDED"));
  const tipo2 = await post(au("900000000005", "ACCOUNT_RECONNECTED", {}, 1700001550));
  ck("7.11 OFFBOARDED/RECONNECTED só afetam conexões em Coexistence: Cloud API do Embedded Signup NÃO é pausada", tipo.j.stored === 1 && tipo2.j.stored === 1 && (await conn(connE)).status === "active" && (await conn(connE)).lifecycle_state === "normal");
  const tipo3 = await post(au("900000000005", "PARTNER_REMOVED", {}, 1700001560));
  ck("7.11b PARTNER_REMOVED vale também para Cloud API do Embedded Signup (a Meta removeu o app da WABA): desconecta", (await conn(connE)).status === "disconnected" && tipo3.j.stored === 1);
  const other = await post(au(WABA_B, "PARTNER_ADDED", { waba_info: { waba_id: WABA_B } }, 1700001600));
  ck("7.12 outros eventos (PARTNER_ADDED etc.) apenas registrados, sem mudar conexão", other.j.stored === 1 && (await conn(connB)).status === "active");
  const inv = await post(wrap(WABA_B, [{ field: "account_update", value: {} }]));
  ck("7.13 account_update sem evento: ignorado", inv.status === 200 && inv.j.ignored === 1);
  const evrows = JSON.stringify((await su("select * from whatsapp_coexistence_events where kind='account_update'")).rows);
  ck("7.14 trilha de account_update sem dados pessoais/ids de negócio do payload", !evrows.includes("owner_business_id") && (await su("select count(*) n from whatsapp_coexistence_events where kind='account_update'")).rows[0].n >= 5);
}

console.log("\n== 8. assinatura, falhas transitórias e concorrência ==");
{
  const payload = echo("111000111", WABA_A, [echoMsg("wamid.echo.sig", FROM, "assinatura")]);
  const bad = await post(payload, { sig: "sha256=" + "0".repeat(64) });
  const none = await post(payload, { sig: "" });
  const wrongSecret = await post(payload, { secret: "outro-segredo" });
  ck("8.1 assinatura inválida/ausente/de outro segredo: 401 e NADA gravado (eco, sincronização, account_update)", bad.status === 401 && none.status === 401 && wrongSecret.status === 401 && (await msgs(cA.id, "provider_message_id='wamid.echo.sig'")).length === 0);
  const badAU = await post(wrap(WABA_A, [{ field: "account_update", value: { event: "PARTNER_REMOVED" } }]), { sig: "sha256=" + "1".repeat(64) });
  ck("8.2 account_update com assinatura inválida: 401 e a conexão NÃO é desconectada", badAU.status === 401 && (await su("select status from company_whatsapp_connections where id=$1", [connA])).rows[0].status === "active");
  failRpc = "whatsapp_ingest_echo";
  const t = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.fail", FROM, "falha")]));
  failRpc = null;
  ck("8.3 falha transitória do banco no eco: 500 (a Meta reentrega) e nada é perdido", t.status === 500);
  const t2 = await post(echo("111000111", WABA_A, [echoMsg("wamid.echo.fail", FROM, "falha")]));
  ck("8.4 a reentrega após a falha grava normalmente (uma vez)", t2.status === 200 && (await msgs(cA.id, "provider_message_id='wamid.echo.fail'")).length === 1);
  failRpc = "whatsapp_coexistence_account_update";
  const t3 = await post(wrap(WABA_A, [{ field: "account_update", value: { event: "ACCOUNT_OFFBOARDED" } }]));
  failRpc = null;
  ck("8.5 falha transitória em account_update: 500", t3.status === 500);
  // concorrência: o MESMO eco 6 vezes em paralelo => 1 mensagem
  const same = echo("222000222", WABA_B, [echoMsg("wamid.echo.conc", FROM, "concorrente")]);
  const rs = await Promise.all(Array.from({ length: 6 }, () => post(same)));
  ck("8.6 o mesmo eco 6x em paralelo: exatamente UMA mensagem gravada", rs.every((r) => r.status === 200) && (await msgs(cB.id, "provider_message_id='wamid.echo.conc'")).length === 1 && rs.reduce((a, r) => a + (r.j?.stored ?? 0), 0) === 1);
  // concorrência entre ecos distintos e inbound da mesma conversa
  const mix = await Promise.all([
    post(echo("222000222", WABA_B, [echoMsg("wamid.echo.m1", FROM, "m1")])),
    post(echo("222000222", WABA_B, [echoMsg("wamid.echo.m2", FROM, "m2")])),
    post(wrap(WABA_B, [{ field: "messages", value: { messaging_product: "whatsapp", metadata: meta("222000222"), contacts: [{ wa_id: FROM, profile: { name: "Maria" } }], messages: [{ from: FROM, id: "wamid.in.mix", timestamp: "1700002000", type: "text", text: { body: "mix" } }] } }])),
  ]);
  ck("8.7 ecos distintos + inbound simultâneos na mesma conversa: todos gravados, uma única conversa, IA pausada", mix.every((r) => r.status === 200) && (await msgs(cB.id, "provider_message_id in ('wamid.echo.m1','wamid.echo.m2','wamid.in.mix')")).length === 3
    && Number((await su("select count(*) n from whatsapp_conversations where company_id=$1 and contact_phone=$2 and deleted_at is null", [B.c, FROM])).rows[0].n) === 1 && (await convOf(B)).ai_control === "human");
  const mixedPayload = wrap(WABA_A, [
    { field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: meta("111000111"), message_echoes: [echoMsg("wamid.echo.mx", FROM, "no mesmo payload")] } },
    { field: "messages", value: { messaging_product: "whatsapp", metadata: meta("111000111"), contacts: [{ wa_id: FROM, profile: { name: "Maria" } }], messages: [{ from: FROM, id: "wamid.in.mx", timestamp: "1700002100", type: "text", text: { body: "in" } }] } },
    { field: "smb_app_state_sync", value: { messaging_product: "whatsapp", metadata: meta("111000111"), state_sync: [{ type: "contact", action: "add", contact: {}, metadata: {} }] } },
  ]);
  const mx = await post(mixedPayload);
  ck("8.8 payload com eco + inbound + sincronização juntos: cada campo tratado, contadores somados", mx.status === 200 && mx.j.stored === 3);
  const inv = await post(wrap(WABA_A, [{ field: "campo_desconhecido", value: { a: 1 } }]));
  ck("8.9 campo desconhecido: ignorado com 200", inv.status === 200 && inv.j.stored === 0);
}

console.log("\n== 9. ACL, RLS e estado final ==");
{
  const fns = [["whatsapp_ingest_echo(text,text,text,text,text,timestamptz,text)"], ["whatsapp_coexistence_record(text,text,text,text,jsonb)"], ["whatsapp_coexistence_account_update(text,text,text,text,bigint)"], ["whatsapp_connection_lifecycle_reset()"]];
  const priv = async (fn, role) => (await pg.query(`select has_function_privilege('${role}', 'public.${fn}', 'execute') p`)).rows[0].p;
  ck("9.1 as 3 RPCs novas: SÓ service_role executa (anon/authenticated/public não)", (await priv(fns[0][0], "service_role")) && (await priv(fns[1][0], "service_role")) && (await priv(fns[2][0], "service_role"))
    && !(await priv(fns[0][0], "authenticated")) && !(await priv(fns[1][0], "authenticated")) && !(await priv(fns[2][0], "authenticated")) && !(await priv(fns[0][0], "anon")) && !(await priv(fns[2][0], "anon")));
  ck("9.2 o gatilho de ciclo de vida não é executável por ninguém", !(await priv(fns[3][0], "authenticated")) && !(await priv(fns[3][0], "anon")) && !(await priv(fns[3][0], "service_role")));
  const cli = await A.owner("select * from whatsapp_coexistence_events limit 1");
  const cli2 = await anon("select * from whatsapp_coexistence_events limit 1");
  const call = await A.owner("select public.whatsapp_ingest_echo('111000111','wamid.x','5544999990001','text','x',now(),'k') j");
  ck("9.3 usuário logado e anônimo NÃO leem a trilha nem chamam as RPCs de eco (isolamento por RLS/ACL)", !cli.ok && !cli2.ok && !call.ok);
  ck("9.4 o CHECK de origem do eco: sent_via=business_app só vale para saída humana sem usuário", !(await su("insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, sent_via) values ($1,$2,$3,'wamid.bad.shape','inbound','text','x','received','business_app')", [A.c, connA, cA.id])).ok
    && !(await su("insert into whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, origin, sent_via, sent_by_user_id) values ($1,$2,$3,'wamid.bad.shape2','outbound','text','x','sent','human','business_app',$4)", [A.c, connA, cA.id, A.ids.owner])).ok);
  const all = logs.join("");
  ck("9.5 nenhum log da suíte contém App Secret, token, texto das mensagens ou telefones", !all.includes(APP_SECRET) && !all.includes("TOKEN-SECRETO") && !all.includes("Já estou indo") && !all.includes("5544999990001") && !all.includes("SEGREDO-DO-HISTORICO"), all.slice(0, 200));
  const dump = JSON.stringify((await su("select * from whatsapp_webhook_events")).rows) + JSON.stringify((await su("select * from whatsapp_coexistence_events")).rows);
  ck("9.6 a dedupe/auditoria (webhook_events + trilha) não guarda texto, telefone nem payload", !dump.includes("Já estou indo") && !dump.includes("5544999990001") && !dump.includes("TOKEN"));
  ck("9.7 conexões das empresas de teste não foram alteradas indevidamente (C manual segue active/normal/cloud_api)", (await su("select status, lifecycle_state, connection_type from company_whatsapp_connections where id=$1", [connC])).rows[0].status === "active"
    && (await su("select connection_type from company_whatsapp_connections where id=$1", [connC])).rows[0].connection_type === "cloud_api");
}


console.log("\n== 10. rollback (supabase/rollbacks/whatsapp-coexistence/20261124010000_rollback.sql) ==");
{
  const sql = fs.readFileSync(path.join(root, "supabase/rollbacks/whatsapp-coexistence/20261124010000_rollback.sql"), "utf8");
  const before = Number((await su("select count(*) n from whatsapp_messages where sent_via='cloud_api'")).rows[0].n);
  let ok = true, err = "";
  try { await pg.exec(sql); } catch (e) { ok = false; err = String(e.message ?? e); }
  ck("10.1 o rollback executa sem erro", ok, err);
  const gone = async (q) => Number((await su(q)).rows[0].n) === 0;
  ck("10.2 funções, tabela de trilha, gatilho e colunas (sent_via, lifecycle_*) removidos", await gone("select count(*) n from pg_proc where proname in ('whatsapp_ingest_echo','whatsapp_coexistence_record','whatsapp_coexistence_account_update','whatsapp_connection_lifecycle_reset')")
    && await gone("select count(*) n from information_schema.tables where table_name='whatsapp_coexistence_events'")
    && await gone("select count(*) n from information_schema.columns where column_name in ('sent_via','lifecycle_state','lifecycle_reason','lifecycle_changed_at') and table_name in ('whatsapp_messages','company_whatsapp_connections')"));
  ck("10.3 mensagens da API preservadas e o CHECK de tipos de evento voltou ao original", before > 0 && Number((await su("select count(*) n from whatsapp_messages")).rows[0].n) >= before
    && !(await su("insert into whatsapp_webhook_events (provider_event_key, event_type) values ('x','echo')")).ok);
  const def = (await su("select pg_get_functiondef('public.whatsapp_mark_message_sent(uuid,text,timestamptz)'::regprocedure) d")).rows[0].d;
  ck("10.4 whatsapp_mark_message_sent voltou à versão original (sem tratamento de conflito)", !/unique_violation/.test(def));
  const reg = await ingest("111000111", FROM, "depois do rollback", "wamid.after.rb");
  ck("10.5 o fluxo de inbound segue funcionando depois do rollback", reg.ok && reg.rows[0].j.result === "stored");
  const acl = (await pg.query("select has_function_privilege('service_role','public.whatsapp_mark_message_sent(uuid,text,timestamptz)','execute') p, has_function_privilege('authenticated','public.whatsapp_mark_message_sent(uuid,text,timestamptz)','execute') q")).rows[0];
  ck("10.6 ACL de mark_message_sent preservada (só service_role)", acl.p === true && acl.q === false);
}


fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP COEXISTENCE WEBHOOK (ETAPA 3)");
