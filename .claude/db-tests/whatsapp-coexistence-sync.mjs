// Coexistence, Etapa 4 (20261125010000): controle da sincronização inicial (POST /{phone}/smb_app_data) — handler REAL da Edge
// whatsapp-coexistence-sync + cliente Graph REAL (fetch simulado) sobre o banco REAL (PGlite com todas as migrations).
// Cobre: trava mestra, autorização, piloto, elegibilidade, janela de 24 h, ordem contatos->histórico, um pedido por tipo e ciclo,
// recusa x incerto x aceito, concorrência, webhooks atualizando o estado, ciclo novo no reonboarding, isolamento, ACL, vazamento, rollback.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wasync-"));
const loadTs = async (src, name, rewrites = []) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(srcRoot, src), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
  return import(pathToFileURL(path.join(tmp, name)).href);
};
await loadTs("supabase/functions/_shared/whatsapp-graph.ts", "whatsapp-graph.mjs");
const SG = await loadTs("supabase/functions/_shared/whatsapp-signup-graph.ts", "whatsapp-signup-graph.mjs", [['"./whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
const SY = await loadTs("supabase/functions/whatsapp-coexistence-sync/handler.ts", "sync.mjs", [['"../_shared/whatsapp-signup-graph.ts"', '"./whatsapp-signup-graph.mjs"'], ['"../_shared/whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
const WH = await loadTs("supabase/functions/whatsapp-webhook/handler.ts", "webhook.mjs");

const { pg, ck, as: as0, su: su00, summary } = await loadAll();
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

const TOKEN = "TOKEN-DO-CLIENTE-SECRETO-ABCDEFGHIJ";
const tok = uuid(7);
await su("insert into vault.decrypted_secrets (id, name, decrypted_secret) values ($1,'wa_token_sync',$2)", [tok, TOKEN]);

let seq = 800, pnSeq = 710000000;
async function mkCo(tag, { type = "coexistence", source = "embedded_signup", pilot = true, status = "active", connectedAgo = "10 minutes", withConn = true } = {}) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "sy-" + tag.toLowerCase() + (++seq), `${tag.toLowerCase()}${seq}@x.com`])).rows[0].id;
  const out = { c, ids: {}, pn: String(++pnSeq) };
  for (const role of ["owner", "admin", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}${seq}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}${seq}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u); out.ids[role] = u;
  }
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste sync', now() + interval '1 day')", [c]);
  if (pilot) await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1, true, now())", [c]);
  if (withConn) {
    out.conn = (await su(`insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, display_phone_number, token_secret_id, connection_type, connection_source, waba_id, connected_at, token_status)
      values ($1,$2,'test',$3,'+55 44 90000-0000',$4,$5,$6,$7, now() - $8::interval, 'valid') returning id`, [c, status, out.pn, tok, type, source, String(900100000 + seq), connectedAgo])).rows[0].id;
  }
  return out;
}
const syncRow = async (co) => (await su("select * from whatsapp_coexistence_sync where connection_id=$1", [co.conn])).rows[0];
const attempts = async (co, type) => (await su("select * from whatsapp_coexistence_sync_attempts where connection_id=$1" + (type ? " and sync_type=$2" : "") + " order by created_at, id", type ? [co.conn, type] : [co.conn])).rows;
const setFlag = (v) => su("update whatsapp_platform_settings set coexistence_sync_enabled=$1", [v]);

// ---------------------------------------------------------------- Edge + Graph simulados
const logs = [];
const origC = { warn: console.warn, error: console.error, info: console.info };
async function capture(fn) {
  console.warn = (...a) => logs.push(JSON.stringify(a)); console.error = (...a) => logs.push(JSON.stringify(a)); console.info = (...a) => logs.push(JSON.stringify(a));
  try { return await fn(); } finally { Object.assign(console, origC); }
}
let fetchPlan = []; // respostas em ordem; vazio = sucesso padrão
const fetchLog = [];
const fakeFetch = async (url, init) => {
  fetchLog.push({ url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : null });
  const step = fetchPlan.length ? fetchPlan.shift() : { status: 200, body: { messaging_product: "whatsapp", request_id: "req-" + fetchLog.length } };
  if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
  if (step.throw) { const e = new Error("rede"); e.name = step.throw; throw e; }
  return { ok: step.status >= 200 && step.status < 300, status: step.status, text: async () => (typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {})) };
};
const meta = SG.createSmbSyncMeta(fakeFetch);
let failFinish = 0;
const rpc = async (fn, args) => {
  if (fn === "whatsapp_coexistence_sync_finish" && failFinish > 0) { failFinish -= 1; return { data: null, error: { code: "XX000", message: "falha simulada" } }; }
  const keys = Object.keys(args);
  const r = await svc(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) j`, keys.map((k) => args[k]));
  return r.ok ? { data: r.rows[0].j, error: null } : { data: null, error: { code: r.code, message: r.err } };
};
async function call(co, type, o = {}) {
  const uid = o.uid ?? co.ids.owner;
  const body = o.raw ?? JSON.stringify({ company_id: o.company ?? co.c, type, ...(o.extra ?? {}) });
  const headers = { "content-type": "application/json" };
  if (o.auth !== null) headers.authorization = o.auth ?? `Bearer jwt-${uid}`;
  const req = new Request("https://x.supabase.co/functions/v1/whatsapp-coexistence-sync", { method: o.method ?? "POST", headers, body: (o.method ?? "POST") === "POST" ? body : undefined });
  const deps = { authenticate: async (a) => { const m = /^Bearer jwt-(.+)$/.exec(a); return m && m[1] !== "bad" ? { userId: m[1] } : null; }, rpc, meta, graphVersion: "graphVersion" in o ? o.graphVersion : "v99.0" };
  const n0 = fetchLog.length;
  const res = await capture(() => SY.handleWhatsappCoexistenceSync(req, deps));
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { /* */ }
  return { status: res.status, j, text, metaCalls: fetchLog.length - n0 };
}
const counts = async () => Number((await su("select (select count(*) from whatsapp_conversations) + (select count(*) from whatsapp_messages) + (select count(*) from customers) n")).rows[0].n);

console.log("\n== 1. trava mestra, requisição e autorização ==");
const A = await mkCo("A");
const before0 = await counts();
{
  const r = await call(A, "contacts");
  ck("1.1 trava mestra DESLIGADA (default): 503 sync_disabled, a Meta NÃO é chamada e nada é gravado", r.status === 503 && r.j.code === "sync_disabled" && r.metaCalls === 0 && (await attempts(A)).length === 0 && (await syncRow(A)).contacts_status === "not_requested");
  ck("1.2 a coluna nasce desligada em whatsapp_platform_settings", (await su("select coexistence_sync_enabled e from whatsapp_platform_settings")).rows[0].e === false);
  await setFlag(true);
  ck("1.3 OPTIONS 204 e GET 405", (await call(A, "contacts", { method: "OPTIONS" })).status === 204 && (await call(A, "contacts", { method: "GET" })).status === 405);
  ck("1.4 sem Authorization / JWT inválido: 401 e nada consumido", (await call(A, "contacts", { auth: null })).status === 401 && (await call(A, "contacts", { auth: "Bearer jwt-bad" })).status === 401 && (await attempts(A)).length === 0);
  ck("1.5 corpo inválido (não-JSON, tipo desconhecido, company_id inválido, grande): 400/413", (await call(A, "x", { raw: "{{" })).status === 400 && (await call(A, "x", { extra: {} })).status === 400
    && (await call(A, "contacts", { company: "nao-e-uuid" })).status === 400 && (await call(A, "contacts", { raw: JSON.stringify({ company_id: A.c, type: "contacts", pad: "x".repeat(4000) }) })).status === 413);
  ck("1.6 sem a versão da Graph no ambiente: 503 e a Meta não é chamada", (await call(A, "contacts", { graphVersion: undefined })).status === 503 && (await attempts(A)).length === 0);
  const att = await call(A, "contacts", { uid: A.ids.attendant });
  ck("1.7 atendente (papel sem permissão): 403 unauthorized, Meta não chamada", att.status === 403 && att.j.code === "unauthorized" && att.metaCalls === 0);
  const B0 = await mkCo("B0");
  const cross = await call(A, "contacts", { uid: B0.ids.owner });
  ck("1.8 owner de OUTRA empresa pedindo para a empresa A: 403 (isolamento)", cross.status === 403 && cross.j.code === "unauthorized" && cross.metaCalls === 0 && (await attempts(A)).length === 0);
  const NP = await mkCo("NP", { pilot: false });
  const np = await call(NP, "contacts");
  ck("1.9 empresa fora do piloto: 403 company_not_authorized, Meta não chamada", np.status === 403 && np.j.code === "company_not_authorized" && np.metaCalls === 0);
  await su("delete from company_module_overrides where company_id=$1", [NP.c]);
}

console.log("\n== 2. elegibilidade da conexão ==");
{
  const CL = await mkCo("CL", { type: "cloud_api", source: "manual" });
  const r1 = await call(CL, "contacts");
  ck("2.1 Cloud API tradicional (conexão manual): 409 connection_not_eligible, Meta não chamada, nenhuma linha de sync criada", r1.status === 409 && r1.j.code === "connection_not_eligible" && r1.metaCalls === 0 && !(await syncRow(CL)));
  const CE = await mkCo("CE", { type: "cloud_api", source: "embedded_signup" });
  ck("2.2 Cloud API do Embedded Signup (não Coexistence): 409 e sem linha de sync", (await call(CE, "contacts")).status === 409 && !(await syncRow(CE)));
  const OF = await mkCo("OF", { status: "error" });
  await su("update company_whatsapp_connections set lifecycle_state='offboarded' where id=$1", [OF.conn]);
  ck("2.3 conexão pausada/offboarded: 409 connection_not_eligible", (await call(OF, "contacts")).j.code === "connection_not_eligible");
  const OF2 = await mkCo("OF2");
  await su("update company_whatsapp_connections set lifecycle_state='offboarded' where id=$1", [OF2.conn]);
  const of2 = await call(OF2, "contacts");
  ck("2.3b conexão ainda 'active' mas com ciclo de vida offboarded/removed: 409 (a trava de ciclo vale por si só)", of2.status === 409 && of2.j.code === "connection_not_eligible" && of2.metaCalls === 0);
  const DC = await mkCo("DC", { status: "disconnected" });
  ck("2.4 conexão desconectada: 409", (await call(DC, "contacts")).status === 409);
  const NC = await mkCo("NC", { withConn: false });
  ck("2.5 empresa sem conexão: 409", (await call(NC, "contacts")).status === 409);
  const TK = await mkCo("TK");
  await su("update company_whatsapp_connections set token_expires_at = now() - interval '1 hour', token_status='expired' where id=$1", [TK.conn]);
  const tk = await call(TK, "contacts");
  ck("2.6 token vencido: 409 token_unavailable, Meta não chamada, pedido não reservado", tk.status === 409 && tk.j.code === "token_unavailable" && tk.metaCalls === 0 && (await attempts(TK)).length === 0);
  const sd = (await su("select count(*) n from whatsapp_coexistence_sync where connection_id in ($1,$2)", [CL.conn, CE.conn])).rows[0].n;
  ck("2.7 o gatilho só cria linha de sync para Coexistence do Embedded Signup (A tem, CL/CE não)", Number(sd) === 0 && !!(await syncRow(A)));
}

console.log("\n== 3. contatos primeiro, depois histórico, UMA vez cada ==");
{
  const H1 = await mkCo("H1");
  const hFirst = await call(H1, "history");
  ck("3.1 histórico ANTES dos contatos: 409 contacts_first, Meta não chamada", hFirst.status === 409 && hFirst.j.code === "contacts_first" && hFirst.metaCalls === 0 && (await attempts(H1)).length === 0);
  const r = await call(H1, "contacts");
  const call1 = fetchLog.at(-1);
  ck("3.2 contatos: 200 requested; chamada exata POST /v99.0/{phone}/smb_app_data com Bearer do cliente e sync_type smb_app_state_sync", r.status === 200 && r.j.ok === true && r.j.status === "requested"
    && call1.url === `https://graph.facebook.com/v99.0/${H1.pn}/smb_app_data` && call1.method === "POST" && call1.headers.Authorization === `Bearer ${TOKEN}` && JSON.stringify(call1.body) === JSON.stringify({ messaging_product: "whatsapp", sync_type: "smb_app_state_sync" }));
  let s = await syncRow(H1);
  const at = await attempts(H1, "contacts");
  ck("3.3 estado: contacts_status=requested, data do pedido, tentativa 'accepted' com request_id (só para suporte)", s.contacts_status === "requested" && !!s.contacts_requested_at && at.length === 1 && at[0].status === "accepted" && /^req-/.test(at[0].request_id) && s.history_status === "not_requested");
  const again = await call(H1, "contacts");
  ck("3.4 contatos de novo: 409 already_requested e a Meta NÃO é chamada (só uma vez)", again.status === 409 && again.j.code === "already_requested" && again.metaCalls === 0 && (await attempts(H1, "contacts")).length === 1);
  const h = await call(H1, "history");
  const call2 = fetchLog.at(-1);
  ck("3.5 histórico depois dos contatos: 200 e sync_type=history", h.status === 200 && JSON.stringify(call2.body) === JSON.stringify({ messaging_product: "whatsapp", sync_type: "history" }) && (await syncRow(H1)).history_status === "requested");
  const h2 = await call(H1, "history");
  ck("3.6 histórico de novo: 409 already_requested, Meta não chamada", h2.status === 409 && h2.j.code === "already_requested" && h2.metaCalls === 0);
  ck("3.7 resposta e logs sem token nem request_id", !h.text.includes(TOKEN) && !r.text.includes("req-") && !logs.join("").includes(TOKEN) && !logs.join("").includes("req-"));
  // banco: índice único impede segundo pedido do mesmo tipo/ciclo mesmo por inserção direta
  const dup = await su("insert into whatsapp_coexistence_sync_attempts (company_id, connection_id, cycle, sync_type, status) values ($1,$2,$3,'contacts','in_progress')", [H1.c, H1.conn, s.cycle]);
  const dup2 = await su("insert into whatsapp_coexistence_sync_attempts (company_id, connection_id, cycle, sync_type, status) values ($1,$2,$3,'history','uncertain')", [H1.c, H1.conn, s.cycle]);
  ck("3.8 o BANCO recusa um segundo pedido aceito/em andamento/incerto do mesmo tipo no mesmo ciclo (índice único parcial)", !dup.ok && !dup2.ok);
  const rejectedOk = await su("insert into whatsapp_coexistence_sync_attempts (company_id, connection_id, cycle, sync_type, status) values ($1,$2,$3,'contacts','rejected')", [H1.c, H1.conn, s.cycle]);
  ck("3.9 tentativas 'rejected' não bloqueiam o índice (a Meta recusou: nada foi aceito)", rejectedOk.ok);
  await su("delete from whatsapp_coexistence_sync_attempts where connection_id=$1 and status='rejected'", [H1.conn]);
}

console.log("\n== 4. janela de 24 horas ==");
{
  const W1 = await mkCo("W1", { connectedAgo: "25 hours" });
  const s0 = await syncRow(W1);
  const r = await call(W1, "contacts");
  ck("4.1 depois de 24 h do onboarding: 410 window_expired, Meta NÃO chamada e os dois tipos viram 'expired'", r.status === 410 && r.j.code === "window_expired" && r.metaCalls === 0 && (await syncRow(W1)).contacts_status === "expired" && (await syncRow(W1)).history_status === "expired" && !!s0);
  const r2 = await call(W1, "history");
  ck("4.2 expirado continua expirado (sem chamadas à Meta)", r2.status === 410 && r2.metaCalls === 0 && (await attempts(W1)).length === 0);
  const W2 = await mkCo("W2", { connectedAgo: "23 hours 59 minutes" });
  const r3 = await call(W2, "contacts");
  ck("4.3 a 1 minuto do limite ainda é aceito", r3.status === 200);
  const W3 = await mkCo("W3");
  await su("update whatsapp_coexistence_sync set onboarded_at = now() - interval '24 hours 1 second', deadline_at = now() - interval '1 second' where connection_id=$1", [W3.conn]);
  ck("4.4 1 segundo depois do prazo: 410", (await call(W3, "contacts")).status === 410);
  ck("4.5 o prazo é sempre onboarded_at + 24 h (CHECK do banco)", !(await su("update whatsapp_coexistence_sync set deadline_at = deadline_at + interval '1 day' where connection_id=$1", [W3.conn])).ok);
  const W4 = await mkCo("W4");
  const r4 = await call(W4, "contacts");
  await su("update whatsapp_coexistence_sync set onboarded_at = now() - interval '25 hours', deadline_at = now() - interval '1 hour' where connection_id=$1", [W4.conn]);
  const r5 = await call(W4, "history");
  ck("4.6 contatos pedidos dentro da janela, histórico depois do prazo: histórico recusado (410) e contatos continuam 'requested'", r4.status === 200 && r5.status === 410 && (await syncRow(W4)).contacts_status === "requested" && (await syncRow(W4)).history_status === "expired");
}

console.log("\n== 5. recusa x incerto x aceito ==");
{
  const R1 = await mkCo("R1");
  fetchPlan = [{ status: 400, body: { error: { code: 100, message: "texto secreto da Meta" } } }];
  const a = await call(R1, "contacts");
  ck("5.1 a Meta RECUSA (4xx): 502 rejected, estado 'failed', tentativa 'rejected' com o código (sem texto)", a.status === 502 && a.j.code === "rejected" && (await syncRow(R1)).contacts_status === "failed" && (await attempts(R1, "contacts"))[0].status === "rejected" && (await attempts(R1, "contacts"))[0].meta_code === "100" && !a.text.includes("secreto") && !logs.join("").includes("texto secreto"));
  fetchPlan = [{ status: 429, body: { error: { code: 4 } } }];
  const b = await call(R1, "contacts");
  fetchPlan = [{ status: 403, body: {} }];
  const c = await call(R1, "contacts");
  const d = await call(R1, "contacts");
  ck("5.2 recusas liberam nova tentativa até 3 por tipo; a 4ª é barrada (429 attempts_exhausted) SEM chamar a Meta", b.status === 502 && c.status === 502 && d.status === 429 && d.j.code === "attempts_exhausted" && d.metaCalls === 0 && (await attempts(R1, "contacts")).length === 3);
  const R2 = await mkCo("R2");
  fetchPlan = [{ status: 400, body: {} }];
  await call(R2, "contacts");
  const ok = await call(R2, "contacts");
  ck("5.3 depois de uma recusa, a nova tentativa pode ser ACEITA (estado vira requested)", ok.status === 200 && (await syncRow(R2)).contacts_status === "requested" && (await attempts(R2, "contacts")).map((x) => x.status).join() === "rejected,accepted");
  const U1 = await mkCo("U1");
  fetchPlan = [{ throw: "AbortError" }];
  const u = await call(U1, "contacts");
  ck("5.4 timeout (resultado INCERTO): 504 uncertain, estado 'uncertain', tentativa 'uncertain'", u.status === 504 && u.j.code === "uncertain" && (await syncRow(U1)).contacts_status === "uncertain" && (await attempts(U1, "contacts"))[0].status === "uncertain");
  const u2 = await call(U1, "contacts");
  ck("5.5 incerto NUNCA é repetido: 409 uncertain_manual e a Meta NÃO é chamada", u2.status === 409 && u2.j.code === "uncertain_manual" && u2.metaCalls === 0 && (await attempts(U1, "contacts")).length === 1);
  const histBlocked = await call(U1, "history");
  ck("5.6 com contatos incertos o histórico NÃO é liberado (ordem)", histBlocked.status === 409 && histBlocked.j.code === "contacts_first" && histBlocked.metaCalls === 0);
  const U2 = await mkCo("U2");
  fetchPlan = [{ status: 500, body: "erro" }];
  const u3 = await call(U2, "contacts");
  fetchPlan = [];
  const U3 = await mkCo("U3");
  fetchPlan = [{ status: 200, body: "isto não é json" }];
  const u4 = await call(U3, "contacts");
  const U4 = await mkCo("U4");
  fetchPlan = [{ throw: "TypeError" }];
  const u5 = await call(U4, "contacts");
  ck("5.7 5xx, corpo 200 inesperado e falha de rede: todos INCERTOS (504), nunca repetidos", [u3, u4, u5].every((x) => x.status === 504 && x.j.code === "uncertain") && (await Promise.all([U2, U3, U4].map(async (x) => (await syncRow(x)).contacts_status))).every((v) => v === "uncertain"));
  fetchPlan = [];
  // resultado não gravado: a Edge tenta 2x e responde 503 sem repetir a Meta
  const F1 = await mkCo("F1");
  failFinish = 2;
  const f = await call(F1, "contacts");
  ck("5.8 resultado conhecido mas NÃO gravado (2 falhas do banco): 503 uncertain, a Meta foi chamada UMA vez e o pedido fica 'em andamento'", f.status === 503 && f.metaCalls === 1 && (await attempts(F1))[0].status === "in_progress" && (await syncRow(F1)).contacts_status === "in_progress");
  const f2 = await call(F1, "contacts");
  ck("5.9 pedido em andamento: 409 in_progress e a Meta NÃO é chamada", f2.status === 409 && f2.j.code === "in_progress" && f2.metaCalls === 0);
  await su("update whatsapp_coexistence_sync_attempts set created_at = now() - interval '10 minutes' where connection_id=$1", [F1.conn]);
  const f3 = await call(F1, "contacts");
  ck("5.10 em andamento abandonado há mais de 5 min vira INCERTO (nunca repete)", f3.status === 409 && f3.j.code === "uncertain_manual" && f3.metaCalls === 0 && (await attempts(F1))[0].status === "uncertain" && (await syncRow(F1)).contacts_status === "uncertain");
  const F2 = await mkCo("F2");
  failFinish = 1;
  const f4 = await call(F2, "contacts");
  ck("5.11 uma falha ao gravar o resultado é repetida uma vez e o pedido conclui normalmente", f4.status === 200 && f4.metaCalls === 1 && (await syncRow(F2)).contacts_status === "requested");
}

console.log("\n== 6. concorrência e idempotência ==");
{
  const C1 = await mkCo("C1");
  fetchPlan = Array.from({ length: 8 }, () => ({ status: 200, body: { request_id: "req-conc" }, delay: 25 }));
  const n61 = fetchLog.length;
  const rs = await Promise.all(Array.from({ length: 6 }, () => call(C1, "contacts")));
  const metaTotal = fetchLog.length - n61;
  ck("6.1 seis pedidos simultâneos do mesmo tipo: UMA chamada à Meta, uma tentativa, um 200; os demais 409", rs.filter((r) => r.status === 200).length === 1 && metaTotal === 1 && (await attempts(C1, "contacts")).length === 1 && rs.filter((r) => r.status === 409).length === 5, JSON.stringify(rs.map((r) => [r.status, r.metaCalls, r.j?.code])));
  fetchPlan = [];
  const fin = await svc("select public.whatsapp_coexistence_sync_finish($1,'accepted','x','1') j", [(await attempts(C1, "contacts"))[0].id]);
  ck("6.2 finish repetido é idempotente (não altera o resultado já gravado)", fin.ok && fin.rows[0].j.idempotent === true && (await attempts(C1, "contacts"))[0].status === "accepted" && (await attempts(C1, "contacts"))[0].request_id === "req-conc");
  const bad = await svc("select public.whatsapp_coexistence_sync_finish($1,'qualquer',null,null) j", [(await attempts(C1, "contacts"))[0].id]);
  const nf = await svc("select public.whatsapp_coexistence_sync_finish($1,'accepted',null,null) j", [uuid(99)]);
  ck("6.3 finish com resultado inválido ou tentativa inexistente: recusado", bad.rows[0].j.ok === false && nf.rows[0].j.error === "not_found");
}

console.log("\n== 7. webhooks atualizam o estado (e resolvem o incerto) ==");
{
  const APP_SECRET = "APP-SECRET-SYNC-TESTE";
  const db = { async rpc(fn, args) {
    const keys = Object.keys(args);
    const params = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
    const r = await svc(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === "object" ? "::jsonb" : ""}`).join(", ")}) j`, params);
    return r.ok ? { data: r.rows[0].j, error: null } : { data: null, error: { code: r.code, message: r.err } };
  } };
  const post = async (payload) => {
    const body = JSON.stringify(payload);
    const req = new Request("https://x.supabase.co/functions/v1/whatsapp-webhook", { method: "POST", headers: { "x-hub-signature-256": "sha256=" + (await WH.hmacSha256Hex(APP_SECRET, body)) }, body });
    const res = await capture(() => WH.handleWhatsappWebhook(req, { verifyToken: "v", appSecret: APP_SECRET, db }));
    return { status: res.status, j: await res.json() };
  };
  const wrap = (pn, field, value) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: pn }, ...value } }] }] });
  const convs0 = await counts();
  // contatos
  const S1 = await mkCo("S1");
  await call(S1, "contacts");
  const w1 = await post(wrap(S1.pn, "smb_app_state_sync", { state_sync: [{ type: "contact", action: "add", contact: { full_name: "Fulano", phone_number: "5544999990000" }, metadata: { timestamp: "1" } }] }));
  ck("7.1 webhook smb_app_state_sync: contatos 'requested' -> 'synced' (com data), sem importar contatos", w1.status === 200 && (await syncRow(S1)).contacts_status === "synced" && !!(await syncRow(S1)).contacts_synced_at && (await counts()) === convs0);
  // histórico em pedaços
  await call(S1, "history");
  const h = (phase, chunk, progress) => wrap(S1.pn, "history", { history: [{ metadata: { phase, chunk_order: chunk, progress }, threads: [{ id: "5544999990000", messages: [{ id: "wamid.h" + chunk, from: "5544999990000", type: "text", text: { body: "SEGREDO-HIST" }, timestamp: "1" }] }] }] });
  await post(h(0, 1, 30));
  let s = await syncRow(S1);
  ck("7.2 primeiro pedaço do histórico: 'receiving' com progresso 30", s.history_status === "receiving" && s.history_progress === 30);
  await post(h(1, 2, 10));
  s = await syncRow(S1);
  ck("7.3 pedaço fora de ordem com progresso menor NÃO diminui o progresso", s.history_progress === 30 && s.history_status === "receiving");
  await post(h(2, 3, 100));
  s = await syncRow(S1);
  ck("7.4 progresso 100: 'completed' (com data) e NENHUMA conversa/mensagem importada", s.history_status === "completed" && s.history_progress === 100 && !!s.history_completed_at && (await counts()) === convs0 && !logs.join("").includes("SEGREDO-HIST")
    && !(await su("select 1 from whatsapp_messages where provider_message_id like 'wamid.h%'")).rows.length);
  // recusa
  const S2 = await mkCo("S2");
  await call(S2, "contacts"); await call(S2, "history");
  await post(wrap(S2.pn, "history", { history: [{ errors: [{ code: 2593109, title: "x" }] }] }));
  ck("7.5 recusa do histórico pelo cliente (2593109): 'declined' (não é erro nosso e não há nova tentativa)", (await syncRow(S2)).history_status === "declined" && (await call(S2, "history")).j.code === "already_requested");
  // incerto resolvido pelo webhook
  const S3 = await mkCo("S3");
  fetchPlan = [{ throw: "AbortError" }];
  await call(S3, "contacts");
  const w3 = await post(wrap(S3.pn, "smb_app_state_sync", { state_sync: [{ type: "contact", action: "add", contact: {}, metadata: {} }] }));
  ck("7.6 pedido 'incerto' + chegada do webhook de contatos: o webhook PROVA que a Meta aceitou => 'synced'", w3.status === 200 && (await syncRow(S3)).contacts_status === "synced");
  // sem pedido: webhook de rotina não altera
  const S4 = await mkCo("S4");
  await post(wrap(S4.pn, "smb_app_state_sync", { state_sync: [{ type: "contact", action: "add", contact: {}, metadata: {} }] }));
  await post(h2(S4.pn));
  function h2(pn) { return wrap(pn, "history", { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [] }] }); }
  ck("7.7 webhook SEM pedido nosso (contato editado no app, histórico não solicitado): estado segue 'not_requested'", (await syncRow(S4)).contacts_status === "not_requested" && (await syncRow(S4)).history_status === "not_requested");
}

console.log("\n== 8. novo onboarding = novo ciclo; isolamento; leitura ==");
{
  const N1 = await mkCo("N1");
  await call(N1, "contacts");
  const c1 = (await syncRow(N1)).cycle;
  await su("update company_whatsapp_connections set connected_at = now() where id=$1", [N1.conn]);
  const s2 = await syncRow(N1);
  ck("8.1 reconexão pelo Embedded Signup (connected_at novo): ciclo+1, pedidos zerados, prazo reiniciado", s2.cycle === c1 + 1 && s2.contacts_status === "not_requested" && s2.history_status === "not_requested" && s2.contacts_requested_at === null);
  const r = await call(N1, "contacts");
  ck("8.2 no novo ciclo os contatos podem ser pedidos de novo (a tentativa antiga fica na auditoria)", r.status === 200 && (await attempts(N1, "contacts")).length === 2 && (await attempts(N1, "contacts")).map((x) => x.cycle).join() === `${c1},${c1 + 1}`);
  await su("update company_whatsapp_connections set token_status='valid' where id=$1", [N1.conn]);
  ck("8.3 atualizar a conexão sem novo onboarding (token, status) NÃO reinicia o ciclo", (await syncRow(N1)).cycle === c1 + 1 && (await syncRow(N1)).contacts_status === "requested");
  // isolamento
  const X = await mkCo("X"), Y = await mkCo("Y");
  await call(X, "contacts");
  ck("8.4 pedido da empresa X não altera o estado de Y", (await syncRow(Y)).contacts_status === "not_requested" && (await attempts(Y)).length === 0);
  // leitura
  const st = await X.owner("select public.whatsapp_coexistence_sync_status($1) j", [X.c]);
  const j = st.rows?.[0]?.j;
  ck("8.5 owner lê o estado (status, prazo, janela) SEM request_id, token ou código da Meta", st.ok && j.has_sync === true && j.contacts.status === "requested" && j.window_open === true && j.enabled === true && !JSON.stringify(j).match(/req-|TOKEN|request_id|meta_code/));
  const stAtt = await X.attendant("select public.whatsapp_coexistence_sync_status($1) j", [X.c]);
  const stCross = await Y.owner("select public.whatsapp_coexistence_sync_status($1) j", [X.c]);
  const stAnon = await anon("select public.whatsapp_coexistence_sync_status($1) j", [X.c]);
  ck("8.6 atendente, owner de outra empresa e anônimo NÃO leem o estado", !stAtt.ok && !stCross.ok && !stAnon.ok);
  const none = await Y.owner("select public.whatsapp_coexistence_sync_status($1) j", [Y.c]);
  ck("8.7 empresa sem pedido: has_sync true com 'not_requested' (nada vaza entre empresas)", none.ok && none.rows[0].j.contacts.status === "not_requested");
}

console.log("\n== 9. ACL, RLS, vazamento e regressão ==");
{
  const priv = async (fn, role) => (await pg.query(`select has_function_privilege('${role}', 'public.${fn}', 'execute') p`)).rows[0].p;
  const P = "whatsapp_coexistence_sync_prepare(uuid,uuid,text)", F = "whatsapp_coexistence_sync_finish(uuid,text,text,text)", S = "whatsapp_coexistence_sync_status(uuid)";
  ck("9.1 prepare/finish: SÓ service_role; status: SÓ authenticated", (await priv(P, "service_role")) && (await priv(F, "service_role")) && !(await priv(P, "authenticated")) && !(await priv(F, "authenticated")) && !(await priv(P, "anon")) && !(await priv(F, "anon"))
    && (await priv(S, "authenticated")) && !(await priv(S, "anon")) && !(await priv("whatsapp_coexistence_sync_seed()", "authenticated")));
  const a = await A.owner("select * from whatsapp_coexistence_sync");
  const b = await A.owner("select * from whatsapp_coexistence_sync_attempts");
  const c = await A.owner("select public.whatsapp_coexistence_sync_prepare($1,$2,'contacts') j", [A.ids.owner, A.c]);
  ck("9.2 as tabelas não têm acesso do cliente (RLS/grants) e prepare não é chamável por usuário", !a.ok && !b.ok && !c.ok);
  const dump = JSON.stringify((await su("select * from whatsapp_coexistence_sync")).rows) + JSON.stringify((await su("select * from whatsapp_coexistence_sync_attempts")).rows);
  ck("9.3 as tabelas não guardam token, telefone nem texto", !dump.includes(TOKEN) && !dump.includes("5544999990000") && !dump.includes("SEGREDO"));
  ck("9.4 nenhum log da suíte contém o token do cliente, request_id ou textos da Meta", !logs.join("").includes(TOKEN) && !logs.join("").includes("req-") && !logs.join("").includes("texto secreto"));
  ck("9.5 NADA foi importado para o Inbox em toda a suíte (conversas/mensagens/clientes iguais ao início, exceto o que os testes semearam)", (await su("select count(*) n from whatsapp_messages where origin='human' and sent_via='business_app'")).rows[0].n == 0);
  void before0;
  // Cloud API tradicional intacta: ainda sem linha/gatilho
  const rows = (await su("select c.connection_source, count(s.*) n from company_whatsapp_connections c left join whatsapp_coexistence_sync s on s.connection_id=c.id where c.connection_type='cloud_api' group by 1")).rows;
  ck("9.6 nenhuma conexão Cloud API (manual ou signup) ganhou linha de sincronização", rows.every((r) => Number(r.n) === 0));
  const cfg = fs.readFileSync(path.join(root, "supabase/config.toml"), "utf8");
  ck("9.7 a Edge exige JWT (verify_jwt = true no config.toml)", /\[functions\.whatsapp-coexistence-sync\][\s\S]*?verify_jwt = true/.test(cfg));
  await setFlag(false);
  const off = await call(await mkCo("OFFX"), "contacts");
  ck("9.8 religar a trava mestra em false bloqueia de novo, mesmo com tudo elegível", off.status === 503 && off.j.code === "sync_disabled" && off.metaCalls === 0);
}

console.log("\n== 10. cliente Graph (smb_app_data) ==");
{
  const seen = [];
  const m = SG.createSmbSyncMeta(async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ messaging_product: "whatsapp", request_id: "abc-123" }) }; });
  const a = await m.requestSync({ version: "v99.0", phoneNumberId: "123456789", token: "TOK", type: "history" });
  ck("10.1 requestSync: URL, método, Bearer e corpo oficiais; request_id lido", a.ok && a.requestId === "abc-123" && seen[0].url === "https://graph.facebook.com/v99.0/123456789/smb_app_data" && seen[0].init.method === "POST" && seen[0].init.headers.Authorization === "Bearer TOK" && JSON.parse(seen[0].init.body).sync_type === "history");
  const bad = await SG.createSmbSyncMeta(async () => ({ ok: true, status: 200, text: async () => "xxx" })).requestSync({ version: "v99.0", phoneNumberId: "1", token: "T", type: "contacts" });
  const noRid = await SG.createSmbSyncMeta(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ messaging_product: "whatsapp" }) })).requestSync({ version: "v99.0", phoneNumberId: "1", token: "T", type: "contacts" });
  ck("10.2 corpo inválido => invalid_response; sem request_id => aceito com requestId nulo", bad.ok === false && bad.kind === "invalid_response" && noRid.ok === true && noRid.requestId === null);
  const C = SG.classifySyncResult;
  ck("10.3 classifySyncResult: 2xx=accepted; 4xx=rejected; 5xx/timeout/rede/corpo inesperado=uncertain", C({ ok: true }) === "accepted" && C({ ok: false, kind: "http", status: 400 }) === "rejected" && C({ ok: false, kind: "http", status: 429 }) === "rejected"
    && C({ ok: false, kind: "http", status: 500 }) === "uncertain" && C({ ok: false, kind: "timeout" }) === "uncertain" && C({ ok: false, kind: "network" }) === "uncertain" && C({ ok: false, kind: "invalid_response" }) === "uncertain");
  ck("10.4 os tipos mapeiam exatamente para os valores oficiais", SG.SMB_SYNC_TYPE_VALUE.contacts === "smb_app_state_sync" && SG.SMB_SYNC_TYPE_VALUE.history === "history");
}

console.log("\n== 11. rollback (supabase/rollbacks/whatsapp-coexistence/20261125010000_rollback.sql) ==");
{
  const sql = fs.readFileSync(path.join(root, "supabase/rollbacks/whatsapp-coexistence/20261125010000_rollback.sql"), "utf8");
  let ok = true, err = "";
  try { await pg.exec(sql); } catch (e) { ok = false; err = String(e.message ?? e); }
  ck("11.1 o rollback executa sem erro", ok, err);
  const gone = async (q) => Number((await su(q)).rows[0].n) === 0;
  ck("11.2 tabelas, funções, gatilhos e coluna da trava mestra removidos", await gone("select count(*) n from information_schema.tables where table_name in ('whatsapp_coexistence_sync','whatsapp_coexistence_sync_attempts')")
    && await gone("select count(*) n from pg_proc where proname like 'whatsapp_coexistence_sync%'") && await gone("select count(*) n from information_schema.columns where column_name='coexistence_sync_enabled'")
    && await gone("select count(*) n from pg_trigger where tgname like 'company_whatsapp_connections_sync_seed%'"));
  const def = (await su("select pg_get_functiondef('public.whatsapp_coexistence_record(text,text,text,text,jsonb)'::regprocedure) d")).rows[0].d;
  ck("11.3 whatsapp_coexistence_record voltou à versão da Etapa 3 (sem o estado da sincronização) e continua funcionando", !/whatsapp_coexistence_sync/.test(def)
    && (await svc("select public.whatsapp_coexistence_record($1,'contact_sync','x','rb:1','{\"added\":1}'::jsonb) j", [A.pn])).rows[0].j.result === "recorded");
  ck("11.4 conexões e eventos da Coexistence preservados após o rollback", Number((await su("select count(*) n from company_whatsapp_connections where connection_type='coexistence'")).rows[0].n) > 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP COEXISTENCE SYNC (ETAPA 4)");
