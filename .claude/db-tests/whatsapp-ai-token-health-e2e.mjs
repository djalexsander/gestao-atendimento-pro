// CARDÁPIO EM PDF pelo WhatsApp — ponta a ponta: banco REAL (PGlite + todas as migrations, inclusive 20261101010000) + worker
// whatsapp-ai-auto REAL (handler.ts, ai-menu.ts, menu-pdf.ts, dispatch e Graph transpilados) + Graph, storage e IA SIMULADOS.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wamenu-"));
const load = async (src, name, rewrites = []) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(src.startsWith("supabase/functions") ? fnRoot : root, src), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
  return import(pathToFileURL(path.join(tmp, name)).href);
};
await load("supabase/functions/_shared/ai-auto.ts", "ai-auto.mjs");
await load("supabase/functions/_shared/ai-knowledge.ts", "ai-knowledge.mjs", [['"./ai-auto.ts"', '"./ai-auto.mjs"'], ['"./ai-suggester.ts"', '"./ai-suggester.mjs"']]);
await load("supabase/functions/_shared/ai-order.ts", "ai-order.mjs", [['"./ai-auto.ts"', '"./ai-auto.mjs"']]);
await load("supabase/functions/_shared/ai-order-flow.ts", "ai-order-flow.mjs", [['"./ai-auto.ts"', '"./ai-auto.mjs"'], ['"./ai-order.ts"', '"./ai-order.mjs"']]);
await load("supabase/functions/_shared/push-core.ts", "push-core.mjs");
await load("supabase/functions/_shared/ai-intro.ts", "ai-intro.mjs");
await load("supabase/functions/_shared/ai-menu.ts", "ai-menu.mjs");
await load("supabase/functions/_shared/menu-pdf.ts", "menu-pdf.mjs");
await load("supabase/functions/_shared/whatsapp-graph.ts", "whatsapp-graph.mjs");
await load("supabase/functions/_shared/whatsapp-dispatch.ts", "whatsapp-dispatch.mjs", [['"./whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
const H = await load("supabase/functions/whatsapp-ai-auto/handler.ts", "handler.mjs", [
  ['"../_shared/ai-auto.ts"', '"./ai-auto.mjs"'], ['"../_shared/ai-knowledge.ts"', '"./ai-knowledge.mjs"'],
  ['"../_shared/ai-order.ts"', '"./ai-order.mjs"'], ['"../_shared/ai-order-flow.ts"', '"./ai-order-flow.mjs"'],
  ['"../_shared/push-core.ts"', '"./push-core.mjs"'], ['"../_shared/ai-intro.ts"', '"./ai-intro.mjs"'],
  ['"../_shared/ai-menu.ts"', '"./ai-menu.mjs"'], ['"../_shared/menu-pdf.ts"', '"./menu-pdf.mjs"'],
  ['"../_shared/whatsapp-dispatch.ts"', '"./whatsapp-dispatch.mjs"'], ['"../_shared/whatsapp-graph.ts"', '"./whatsapp-graph.mjs"'],
]);

const { pg, ck, as, su: su0, summary } = await loadAll();
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const svc = (sql, params) => as("service_role", null, sql, params);
const anon = (sql, params) => as("anon", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const must = (r, what) => { if (!r.ok) { console.log("SETUP FALHOU", what, r.err); process.exit(2); } return r; };
await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
  declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id into v; return v; end $f$;
`);

let seq = 1700;
async function mkCo(tag, mods = ["whatsapp", "ia"]) {
  const c = must(await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "menu-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`]), "empresa").rows[0].id;
  const o = { c, ids: {} };
  for (const role of ["owner", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    o[role] = U(u); o.ids[role] = u;
  }
  for (const m of mods) await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,$2,'teste menu', now() + interval '1 day')", [c, m]);
  return o;
}
const A = await mkCo("A");
const B = await mkCo("B");
const TOKEN = "EAAG-TOKEN-SECRETO-MENU-1234567890";
const tokId = "99999999-0000-4000-8000-000000000088";
await su("insert into vault.secrets (id, name, secret) values ($1,'wa_token_menu',$2)", [tokId, TOKEN]);
const connA = must(await su("insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, display_phone_number, token_secret_id) values ($1,'active','test','555000222','+55 44 90000-0001',$2) returning id", [A.c, tokId]), "conexão").rows[0].id;

// catálogo de A (com itens que NÃO podem aparecer) e de B (outra empresa)
const cat = async (co, name, order = 0, active = true) => must(await su("insert into product_categories (company_id,name,code,sort_order,is_active) values ($1,$2,$3,$4,$5) returning id", [co, name, "C" + ++seq, order, active]), "cat " + name).rows[0].id;
const prod = async (co, c, name, price, o = {}) => must(await su("insert into products (company_id,category_id,name,description,code,sale_price,is_active,available_for_sale,stock_control,stock_quantity) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id", [co, c, name, o.desc ?? null, "P" + ++seq, price, o.active ?? true, o.sale ?? true, o.stock ?? "none", o.qty ?? 0]), "prod " + name).rows[0].id;
const cEspetos = await cat(A.c, "Espetos", 1);
const cBebidas = await cat(A.c, "Bebidas", 2);
const cOculta = await cat(A.c, "Categoria Oculta", 3, false);
const pCarne = await prod(A.c, cEspetos, "Espeto de carne", 12, { desc: "Carne bovina na brasa" });
await prod(A.c, cEspetos, "Espeto de frango", 10.5);
await prod(A.c, cEspetos, "Espeto Descontinuado", 99, { active: false });
await prod(A.c, cBebidas, "Coca-Cola lata", 6, { stock: "quantity", qty: 0 });
await prod(A.c, cBebidas, "Guaraná lata", 5.5, { stock: "quantity", qty: 8 });
await prod(A.c, cBebidas, "Suco Indisponível", 7, { sale: false });
await prod(A.c, cOculta, "Produto da Categoria Oculta", 50);
const cB = await cat(B.c, "Pizzas B");
await prod(B.c, cB, "Pizza Secreta da Empresa B", 77);

must(await A.owner("select public.whatsapp_ai_update_settings($1,true,'auto','Espeto do Alex','cordial','Seja cordial e breve.',null,true,12,true,true,null,null,null) j", [A.c]), "settings");
const flag = (v) => su("update company_whatsapp_ai_settings set menu_pdf_enabled=$2 where company_id=$1", [A.c, v]);
const avail = (v) => su("update company_whatsapp_ai_settings set ai_availability_mode=$2 where company_id=$1", [A.c, v]);

// ---- simulação
const bridge = {
  async rpc(fn, args) {
    const keys = Object.keys(args);
    const sql = fn === "whatsapp_ai_claim_jobs" ? `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")})` : `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) as j`;
    const r = await svc(sql, keys.map((k) => (k === "p_ops" || k === "p_fields" ? JSON.stringify(args[k]) : args[k])));
    if (!r.ok) return { data: null, error: { code: r.code, message: r.err } };
    return { data: fn === "whatsapp_ai_claim_jobs" ? r.rows : r.rows[0].j, error: null };
  },
};
const hooks = {};
const rpcLog = [];
const preHook = {}; // fn -> async () => void (executa ANTES da RPC, que segue normal)
const admin = { async rpc(fn, args) { rpcLog.push(fn); if (preHook[fn]) { const h = preHook[fn]; delete preHook[fn]; await h(); } if (hooks.before?.[fn]) return hooks.before[fn](fn, args); const r = await bridge.rpc(fn, args); if (hooks[fn]) await hooks[fn](r); return r; } };
const sends = []; const uploads = []; const docs = [];
let gN = 0, mN = 0;
const fail = { upload: false, doc: false };
let script = () => ({ ok: true });
const fkind = (f) => (f && f.ok === false ? f : null);
const graph = {
  async sendText(a) { sends.push(a); return fkind(script("text")) ?? { ok: true, messageId: `wamid.out.menu.${++gN}` }; },
  async uploadMedia(a) { uploads.push(a); return fkind(script("upload")) ?? { ok: true, mediaId: `MEDIA-${++mN}` }; },
  async sendDocument(a) { docs.push(a); return fkind(script("doc")) ?? { ok: true, messageId: `wamid.doc.${++gN}` }; },
};
const store = new Map();
const storage = { up: 0, down: 0, failUpload: false, failDownload: false };
const menu = {
  async download(p) { storage.down++; return storage.failDownload ? null : store.get(p) ?? null; },
  async upload(p, bytes) { storage.up++; if (storage.failUpload) return false; store.set(p, bytes); return true; },
};
const decisions = [];
let legacyText = "Temos espeto de carne por R$ 12,00.";
const decider = { provider: "openai", model: "gpt-test", async decide(req) { decisions.push(req); return { ok: true, text: JSON.stringify({ action: "reply", reply: legacyText, reason_code: "answered", confidence: "high" }), inputTokens: 100, outputTokens: 30 }; } };
const SECRET = "segredo-interno-do-worker-com-mais-de-32-chars";
const logs = [];
const orig = { warn: console.warn, error: console.error, info: console.info, log: console.log };
const resetUsage = async () => { await su("alter table whatsapp_ai_usage disable trigger whatsapp_ai_usage_immutable"); await su("delete from whatsapp_ai_usage"); await su("alter table whatsapp_ai_usage enable trigger whatsapp_ai_usage_immutable"); };
let withMenu = true;
async function tick() {
  await resetUsage();
  await su("update whatsapp_ai_jobs set run_after = now() - interval '1 second' where status='pending'");
  console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a));
  try {
    const res = await H.handleWhatsappAiAuto(new Request("https://x.test/fn", { method: "POST", headers: { "x-internal-secret": SECRET, "content-type": "application/json" }, body: "{}" }), { internalSecret: SECRET, killSwitch: "true", admin, decider, graph, graphVersion: "v99.0", maxJobs: 5, menu: withMenu ? menu : undefined, now: () => Date.UTC(2026, 10, 1, 12) });
    return { status: res.status, json: await res.json() };
  } finally { Object.assign(console, orig); }
}
let nPhone = 0, nW = 0;
const newPhone = async () => { const ph = `554497801${String(++nPhone).padStart(4, "0")}`; await su("insert into whatsapp_test_recipients (company_id, connection_id, phone_e164) values ($1,$2,$3)", [A.c, connA, ph]); return ph; };
const ingest = (ph, body, wamid, mid) => svc("select public.whatsapp_ingest_message('555000222',$1,$2,'Cliente','text',$3,now(),$4) j", [wamid ?? `wamid.in.${++nW}`, ph, body, mid ?? `msg:menu:${++nW}`]);
const convOf = async (ph) => (await su("select id from whatsapp_conversations where contact_phone=$1 and deleted_at is null", [ph])).rows[0]?.id;
const outs = async (conv) => (await su("select id, body, type, status, error_code from whatsapp_messages where conversation_id=$1 and origin='ai_auto' order by created_at, id", [conv])).rows;
async function say(ph, text) {
  await ingest(ph, text);
  const conv = await convOf(ph);
  const n0 = (await outs(conv)).length;
  const d0 = docs.length;
  const t = await tick();
  const o = await outs(conv);
  const last = o.length > n0 ? o[o.length - 1] : null;
  return { conv, last, n: o.length - n0, docs: docs.length - d0, outcomes: t.json.outcomes, status: t.status };
}
const ownerNoise = async (conv) => (await su("select outcome, reason_code from whatsapp_ai_jobs where conversation_id=$1 order by created_at desc limit 1", [conv])).rows[0];
const INTRO = "Olá! Sou a Assistente Virtual da Espeto do Alex.";
const pdfText = (bytes) => Buffer.from(bytes).toString("latin1");


// ---------------------------------------------------------------- fixtures desta suíte
const connRow = async () => (await su("select * from company_whatsapp_connections where id=$1", [connA])).rows[0];
const connHash = async () => (await su("select md5(row(c.*)::text) h from company_whatsapp_connections c where id=$1", [connA])).rows[0].h;
const setConn = (sql) => su(`update company_whatsapp_connections set ${sql} where id=$1`, [connA]);
const resetConn = () => setConn("token_status='unknown', token_expires_at=null, token_checked_at=null, last_error_code=null");
const graphCalls = () => sends.length + uploads.length + docs.length;
const outbound = async (conv) => (await su("select id, status, error_code, provider_message_id, origin from whatsapp_messages where conversation_id=$1 and direction='outbound' order by created_at, id", [conv])).rows;
const inboundCount = async (conv) => Number((await su("select count(*) n from whatsapp_messages where conversation_id=$1 and direction='inbound'", [conv])).rows[0].n);
const lastJob = async (conv) => (await su("select status, outcome, reason_code from whatsapp_ai_jobs where conversation_id=$1 order by created_at desc, id desc limit 1", [conv])).rows[0];
const jobsCount = async (conv) => Number((await su("select count(*) n from whatsapp_ai_jobs where conversation_id=$1", [conv])).rows[0].n);
const ok = () => ({ ok: true });
const http = (status, code, subcode) => () => ({ ok: false, kind: "http", status, ...(code ? { code } : {}), ...(subcode ? { subcode } : {}) });
const NEWTOKEN = "EAAG-TOKEN-NOVO-RECONECTADO-9876543210";
const PINX = "135791";
const menuOn = async () => { await flag(true); await avail("always"); };
await flag(false);
const countDeciderCalls = () => decisions.length;
const aiOutCount = async (conv) => (await outs(conv)).length;
legacyText = "Claro, posso ajudar! Me conta o que você precisa.";
const SECRETS_IN_LOGS = () => logs.join("\n");

console.log("\n== 1. token válido: tudo normal (texto e cardápio em documento) ==");
await resetConn(); await setConn("token_status='valid', token_expires_at=now()+interval '30 days'");
{
  script = ok; sends.length = 0;
  const ph = await newPhone();
  const x = await say(ph, "quanto custa o espeto de carne?");
  ck("1.1 resposta da IA enviada pelo Graph com o token do Vault; mensagem 'sent', job replied", x.n === 1 && x.last.status === "sent" && sends.length === 1 && sends[0].accessToken === TOKEN && (await lastJob(x.conv)).outcome === "replied");
  await menuOn();
  const d0 = docs.length, u0 = uploads.length;
  const ph2 = await newPhone();
  const y = await say(ph2, "me manda o cardápio");
  ck("1.2 cardápio em PDF: upload + documento enviados normalmente", y.docs === 1 && docs.length === d0 + 1 && uploads.length === u0 + 1 && y.last.status === "sent" && docs[docs.length - 1].accessToken === TOKEN);
  await flag(false);
}

console.log("\n== 2. sem validade conhecida (conexão antiga, tipo Djalexeventos) ==");
await resetConn();
{
  const before = await connHash();
  const ph = await newPhone();
  sends.length = 0; const x = await say(ph, "quanto custa o espeto de carne?");
  await menuOn();
  const ph2 = await newPhone();
  const y = await say(ph2, "me manda o cardápio");
  await flag(false);
  ck("2.1 token 'unknown': a IA responde e envia o cardápio normalmente", x.n === 1 && x.last.status === "sent" && sends.length >= 1 && y.docs === 1 && y.last.status === "sent");
  ck("2.2 a linha da conexão NÃO é alterada por nada disso (ausência de metadados nunca vira escrita)", (await connHash()) === before);
}

console.log("\n== 3. token expirado pelo prazo: bloqueio ANTES de chamar a Graph ==");
{
  await resetConn(); await setConn("token_status='valid', token_expires_at=now()-interval '1 hour'");
  script = ok; const c0 = graphCalls(); const d0 = countDeciderCalls();
  const ph = await newPhone();
  const x = await say(ph, "quanto custa o espeto de carne?");
  const inb = await inboundCount(x.conv);
  ck("3.1 IA com token vencido: ZERO chamadas à Graph, mensagem registrada como falha 'token_expired', job failed_send com o motivo", graphCalls() === c0 && x.last?.status === "failed" && x.last.error_code === "token_expired" && (await lastJob(x.conv)).outcome === "failed_send" && (await lastJob(x.conv)).reason_code === "token_expired");
  {
    // RESPOSTA PRÓPRIA do bloqueio ao consumidor do despacho compartilhado (a IA só registra o código; o contrato http/friendly vale para
    // whatsapp-send e whatsapp-order-notify, que usam o MESMO despacho): 409 + mensagem amigável, sem Graph, mensagem registrada como falha
    const msgRow = (await su("insert into whatsapp_messages (company_id, connection_id, conversation_id, direction, type, body, status, origin) select company_id, connection_id, id, 'outbound', 'text', 'Oi', 'queued', 'system' from whatsapp_conversations where id=$1 returning id", [x.conv]));
    const dm = await import(pathToFileURL(path.join(tmp, "whatsapp-dispatch.mjs")).href);
    const g0 = graphCalls();
    const out = msgRow.ok ? await dm.dispatchQueuedMessage({ admin, graph, graphVersion: "v99.0" }, msgRow.rows[0].id) : null;
    ck("3.1b despacho direto com token vencido: 409, mensagem amigável própria (não a genérica de 503), ZERO chamadas à Graph e falha registrada", !!out && out.ok === false && out.errorCode === "token_expired" && out.http === 409 && /expirou ou foi revogada/.test(out.friendly) && graphCalls() === g0
      && (await su("select error_code from whatsapp_messages where id=$1", [msgRow.rows?.[0]?.id])).rows[0]?.error_code === "token_expired", msgRow.err);
  }
  ck("3.2 o recebimento continua: a mensagem do cliente foi gravada e gerou o job normalmente (webhook independe do token)", inb === 1 && (await jobsCount(x.conv)) === 1);
  const n0 = (await outbound(x.conv)).length, j0 = await jobsCount(x.conv), dc = countDeciderCalls();
  await tick(); await tick(); await tick();
  ck("3.3 SEM loop de retentativas: três novas rodadas do worker não criam mensagem, job, chamada de IA nem chamada à Graph", (await outbound(x.conv)).length === n0 && (await jobsCount(x.conv)) === j0 && countDeciderCalls() === dc && graphCalls() === c0);
  ck("3.4 apenas UMA chamada de IA foi gasta para a mensagem bloqueada", dc - d0 === 1);
  await menuOn();
  const u0 = uploads.length, dd0 = docs.length;
  const ph2 = await newPhone();
  const y = await say(ph2, "me manda o cardápio");
  ck("3.5 cardápio com token vencido: nem upload nem documento; mensagem falha 'token_expired'", uploads.length === u0 && docs.length === dd0 && y.last?.status === "failed" && y.last.error_code === "token_expired");
  await flag(false);
  ck("3.6 conexão segue ACTIVE, token do Vault intacto e histórico preservado", (await connRow()).status === "active" && (await su("select count(*) n from vault.secrets where id=$1", [tokId])).rows[0].n == 1);
}

console.log("\n== 4. token revogado (confirmado pela Graph): bloqueio, sondagem e restauração ==");
{
  await resetConn(); await setConn("token_status='revoked', token_checked_at=now(), last_error_code='190:463'");
  script = ok; const c0 = graphCalls();
  const ph = await newPhone();
  const x = await say(ph, "quanto custa o espeto de carne?");
  ck("4.1 revogado e checado agora: IA bloqueada sem tocar na Graph (token_revoked)", graphCalls() === c0 && x.last?.status === "failed" && x.last.error_code === "token_revoked" && (await lastJob(x.conv)).reason_code === "token_revoked");
  // nenhuma mensagem real sem autorização: a sondagem só ocorre quando há uma mensagem legítima na fila
  await setConn("token_checked_at = now() - interval '31 minutes'");
  const total0 = Number((await su("select count(*) n from whatsapp_messages where direction='outbound'")).rows[0].n);
  await tick(); await tick();
  ck("4.2 janela de sondagem aberta SEM mensagem do cliente na fila: nada é enviado e nada é criado (a sondagem nunca inventa mensagens de teste)", graphCalls() === c0 && Number((await su("select count(*) n from whatsapp_messages where direction='outbound'")).rows[0].n) === total0);
  const ph2 = await newPhone();
  const y = await say(ph2, "quanto custa o espeto de frango?");
  ck("4.3 chega uma mensagem legítima: UMA sondagem usa essa mensagem, a Graph aceita e a saúde volta a 'valid'", graphCalls() === c0 + 1 && y.last?.status === "sent" && (await connRow()).token_status === "valid" && (await connRow()).last_error_code === null);
  const ph3 = await newPhone();
  const z = await say(ph3, "e o de carne?");
  ck("4.4 depois de restaurado, as seguintes enviam normalmente", z.last?.status === "sent" && graphCalls() === c0 + 2);
  // sondagem que falha de novo
  await setConn("token_status='revoked', token_checked_at = now() - interval '31 minutes'");
  script = http(401, "190", "467"); const c1 = graphCalls();
  const ph4 = await newPhone();
  const w = await say(ph4, "oi, tem espeto?");
  ck("4.5 sondagem que a Graph recusa de novo (190): permanece revoked, renova a janela e a mensagem falha UMA vez", graphCalls() === c1 + 1 && w.last?.status === "failed" && (await connRow()).token_status === "revoked");
  script = ok; const ph5 = await newPhone();
  const w2 = await say(ph5, "alguém aí?");
  ck("4.6 na sequência volta a bloquear sem chamar a Graph", graphCalls() === c1 + 1 && w2.last?.error_code === "token_revoked");
  await resetConn(); script = ok;
}

console.log("\n== 5. erro temporário NÃO classifica o token como revogado ==");
{
  const cases = [["HTTP 500 (131000)", http(500, "131000")], ["HTTP 401 sem código 190", http(401, undefined)], ["429 limite de taxa", http(429, "130429")], ["timeout", () => ({ ok: false, kind: "timeout" })], ["queda de rede", () => ({ ok: false, kind: "network" })]];
  let i = 0;
  for (const [label, sc] of cases) {
    await resetConn(); const h = await connHash();
    script = sc; const c0 = graphCalls();
    const ph = await newPhone();
    const x = await say(ph, "quanto custa o espeto de carne?");
    const afterFail = await connHash();
    script = ok;
    const ph2 = await newPhone();
    const y = await say(ph2, "e o de frango?");
    ck(`5.${++i} ${label}: a mensagem falha, a saúde do token NÃO muda, e a mensagem seguinte é enviada normalmente`, graphCalls() === c0 + 2 && x.last?.status === "failed" && afterFail === h && y.last?.status === "sent");
  }
  await resetConn();
}

console.log("\n== 6. erro 190 no envio da IA: confirma, bloqueia e não repete ==");
{
  await resetConn(); script = http(401, "190", "463"); const c0 = graphCalls();
  const ph = await newPhone();
  const x = await say(ph, "quanto custa o espeto de carne?");
  const row = await connRow();
  ck("6.1 190 recebido da Graph: token_status=revoked, código gravado, conexão ACTIVE, mensagem falha 'graph_auth'", graphCalls() === c0 + 1 && row.token_status === "revoked" && /^190:463$/.test(row.last_error_code) && row.status === "active" && x.last?.error_code === "graph_auth");
  script = ok;
  const ph2 = await newPhone();
  const y = await say(ph2, "quanto custa o de frango?");
  ck("6.2 a próxima mensagem é bloqueada SEM chamar a Graph (nenhuma tentativa inútil)", graphCalls() === c0 + 1 && y.last?.error_code === "token_revoked");
  const n = (await outbound(x.conv)).length;
  await tick(); await tick();
  ck("6.3 sem reenvio automático da mensagem que falhou (continua failed, mesma quantidade de saídas)", (await outbound(x.conv)).length === n && (await outbound(x.conv)).every((m) => m.status === "failed") && graphCalls() === c0 + 1);
  ck("6.4 um aviso (alerta) por credencial — sem repetição a cada envio bloqueado", Number((await su("select count(*) n from whatsapp_token_alerts where connection_id=$1 and kind='revoked'", [connA])).rows[0].n) === 1);
  // cardápio: 190 no UPLOAD
  await resetConn(); await menuOn();
  script = (kind) => (kind === "upload" ? { ok: false, kind: "http", status: 401, code: "190", subcode: "467" } : { ok: true });
  const c1 = graphCalls(); const dd1 = docs.length; const ph3 = await newPhone();
  const z = await say(ph3, "me manda o cardápio");
  ck("6.5 cardápio: 190 no upload do documento confirma o token inválido; nenhum documento é enviado depois", uploads.length >= 1 && docs.length === dd1 && (await connRow()).token_status === "revoked" && z.last?.status === "failed" && graphCalls() === c1 + 1);
  await flag(false); script = ok; await resetConn();
}

console.log("\n== 7. checkpoint (190/459) não é prova de revogação ==");
{
  await resetConn(); script = http(401, "190", "459"); const c0 = graphCalls();
  const x = await say(await newPhone(), "quanto custa o espeto de carne?");
  script = ok;
  const y = await say(await newPhone(), "e o de frango?");
  ck("7.1 190 com subcódigo de checkpoint: status 'error' (não bloqueia); a mensagem seguinte é enviada e restaura 'valid'", x.last?.status === "failed" && y.last?.status === "sent" && graphCalls() === c0 + 2 && (await connRow()).token_status === "valid");
  await resetConn();
}

console.log("\n== 8. reconexão: o envio volta com a credencial NOVA; nada antigo é reenviado ==");
{
  await resetConn(); await setConn("token_status='revoked', token_checked_at=now(), last_error_code='190:463'");
  script = ok;
  const before = await say(await newPhone(), "preciso de ajuda com meu pedido");
  const oldFailed = (await su("select id, status, provider_message_id from whatsapp_messages where direction='outbound' and status='failed' and error_code in ('token_revoked','token_expired')")).rows;
  const old = (await connRow()).token_secret_id;
  await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id='1234567890', embedded_signup_config_id='9876543210'");
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1,true,now())", [A.c]);
  const st = (await A.owner("select public.whatsapp_signup_begin($1) j", [A.c])).rows[0].j.state;
  const rs = (await svc("select public.whatsapp_signup_reserve($1) j", [st])).rows[0].j;
  await svc("select public.whatsapp_signup_store_token($1,$2, now() + interval '60 days')", [rs.session_id, NEWTOKEN]);
  // nada foi trocado ainda: a credencial antiga segue no lugar até a confirmação
  const mid = await connRow();
  ck("8.1 enquanto a nova conexão não é confirmada, a credencial antiga continua a mesma e o token novo ainda não está ligado", mid.token_secret_id === old && (await su("select count(*) n from vault.secrets where id=$1", [old])).rows[0].n == 1);
  const cr = (await svc("select public.whatsapp_signup_complete($1,'555000111222','555000222','+55 44 90000-0001','Emp A',null,now(),now(),'cloud_api') j", [rs.session_id])).rows[0].j;
  const after = await connRow();
  ck("8.2 reconexão confirmada: mesma conexão, token_status=valid, credencial trocada, erro limpo; a antiga só agora sai do Vault", cr.ok === true && after.id === connA && after.token_status === "valid" && after.token_secret_id !== old && after.last_error_code === null && (await su("select count(*) n from vault.secrets where id=$1", [old])).rows[0].n == 0);
  await su("update whatsapp_platform_settings set embedded_signup_enabled=false");
  await su("delete from whatsapp_signup_pilot_companies where company_id=$1", [A.c]);
  sends.length = 0; const c0 = graphCalls();
  const ph = await newPhone();
  const x = await say(ph, "quanto custa o espeto de carne?");
  ck("8.3 a IA volta a enviar e a Graph recebe a credencial NOVA", x.last?.status === "sent" && sends.length === 1 && sends[0].accessToken === NEWTOKEN && graphCalls() === c0 + 1);
  ck("8.4 as mensagens que falharam durante o bloqueio NÃO são reenviadas por causa da reconexão (continuam failed, sem id da Meta)", (await su("select id, status, provider_message_id from whatsapp_messages where id = any($1::uuid[])", [oldFailed.map((m) => m.id)])).rows.every((m) => m.status === "failed" && m.provider_message_id === null));
  await tick(); await tick();
  ck("8.5 novas rodadas após a reconexão não geram envio, mensagem nem job extra (sem loop)", graphCalls() === c0 + 1 && (await outbound(x.conv)).length === 1 && (await jobsCount(x.conv)) === 1);
  void before;
}

console.log("\n== 9. sem duplicidade e sem exposição de credenciais ==");
{
  await resetConn(); script = ok;
  const ph = await newPhone();
  await ingest(ph, "quanto custa o espeto de carne?", "wamid.dupe.tok", "msg:tok:dupe");
  await ingest(ph, "quanto custa o espeto de carne?", "wamid.dupe.tok", "msg:tok:dupe");
  const conv = await convOf(ph); const c0 = graphCalls();
  await tick(); await tick();
  ck("9.1 mensagem do cliente entregue duas vezes: UMA resposta, UMA chamada à Graph", graphCalls() === c0 + 1 && (await aiOutCount(conv)) === 1);
  const dup = (await su("select provider_message_id p, count(*) n from whatsapp_messages where direction='outbound' and provider_message_id is not null group by 1 having count(*) > 1")).rows;
  ck("9.2 nenhum id da Meta repetido entre as saídas da suíte inteira", dup.length === 0);
  const all = SECRETS_IN_LOGS();
  ck("9.3 logs da suíte inteira sem token (antigo e novo), PIN, telefones ou texto das mensagens", !all.includes(TOKEN) && !all.includes(NEWTOKEN) && !all.includes(PINX) && !/55449780\d{5}/.test(all) && !all.includes("quanto custa"));
  const leak = (await su(`select (select count(*) from whatsapp_messages m where m::text like '%'||$1||'%' or m::text like '%'||$2||'%')
    + (select count(*) from whatsapp_ai_jobs j where j::text like '%'||$1||'%' or j::text like '%'||$2||'%')
    + (select count(*) from whatsapp_token_alerts a where a::text like '%EAAG-%')
    + (select count(*) from company_whatsapp_connections c where c::text like '%'||$1||'%' or c::text like '%'||$2||'%') n`, [TOKEN, NEWTOKEN])).rows[0].n;
  ck("9.4 token não aparece em mensagens, jobs, alertas nem na linha da conexão (só no Vault)", Number(leak) === 0);
}

console.log("\n== 10. consistência entre canais e isolamento ==");
{
  // mesma proteção para empresa B com conexão própria: o bloqueio de A não vaza
  const connB = must(await su("insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, display_phone_number, token_secret_id) values ($1,'active','test','888000999','+55 44 90000-0009',$2) returning id", [B.c, tokId]), "conn B").rows[0].id;
  await setConn("token_status='revoked', token_checked_at=now()");
  const stB = (await B.owner("select public.whatsapp_get_module_state($1) j", [B.c])).rows[0].j;
  const stA = (await A.owner("select public.whatsapp_get_module_state($1) j", [A.c])).rows[0].j;
  ck("10.1 aviso só para a empresa afetada (A recebe 'revoked'; B não) e o atendente de A não vê o aviso", stA.connection_alert?.kind === "revoked" && stB.connection_alert === null && (await A.attendant("select public.whatsapp_get_module_state($1) j", [A.c])).rows[0].j.connection_alert === null);
  const ctxA = (await svc("select public.whatsapp_get_send_context($1) j", ["00000000-0000-4000-8000-0000000fffff"])).rows[0].j;
  ck("10.2 contexto de envio é a única porta: mesmo código para manual, IA e notificações (despacho compartilhado)", ctxA.ok === false && ["whatsapp-send", "whatsapp-ai-auto", "whatsapp-order-notify"].every((n) => /dispatchQueuedMessage\(/.test(fs.readFileSync(path.join(root, `supabase/functions/${n}/handler.ts`), "utf8"))));
  await resetConn();
  void connB;
}

fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP IA + SAÚDE DO TOKEN (E2E)");
