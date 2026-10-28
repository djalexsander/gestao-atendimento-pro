// Compatibilidade do index.ts da Edge whatsapp-signup-complete com o runtime do Supabase Edge Functions, SEM Deno e SEM Meta real:
//  * varredura estática dos imports/APIs (só npm:@supabase/supabase-js@<mesma versão das outras funções>, imports relativos .ts, nada de Node);
//  * o index.ts REAL é executado com um shim mínimo de `Deno` (env + serve) e o supabase-js REAL (2.117.1), falando HTTP com um
//    "Supabase falso" local (Auth /auth/v1/user + PostgREST /rest/v1/*) apoiado no banco PGlite com as migrations reais;
//  * o fetch para graph.facebook.com é interceptado (Meta simulada). Nenhuma chamada sai da máquina.
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadAll } from "./full-db.mjs";

const root = "D:/orça facil";
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const FN = "supabase/functions/whatsapp-signup-complete";
const SB_VERSION = "2.117.1";

const { pg, ck, as, su: su0, summary } = await loadAll(undefined, { legacyIaMirror: false });
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };

console.log("\n== 1. varredura estática (compatibilidade com o runtime) ==");
const files = [`${FN}/index.ts`, `${FN}/handler.ts`, "supabase/functions/_shared/whatsapp-signup-graph.ts", "supabase/functions/_shared/whatsapp-graph.ts"];
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]));
const imports = files.flatMap((f) => [...src[f].matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => ({ f, spec: m[1] })));
ck("1.1 só imports permitidos: npm:@supabase/supabase-js@<versão fixa> ou relativos terminados em .ts", imports.every(({ spec }) => spec === `npm:@supabase/supabase-js@${SB_VERSION}` || (/^\.{1,2}\//.test(spec) && spec.endsWith(".ts"))), JSON.stringify(imports.map((i) => i.spec)));
const others = fs.readdirSync(path.join(root, "supabase/functions")).filter((d) => d.startsWith("whatsapp-") && d !== "whatsapp-signup-complete").map((d) => path.join(root, "supabase/functions", d, "index.ts")).filter(fs.existsSync);
ck("1.2 a mesma versão do supabase-js que as demais Edge Functions em produção", others.length >= 3 && others.every((f) => fs.readFileSync(f, "utf8").includes(`npm:@supabase/supabase-js@${SB_VERSION}`)));
const banned = /\b(process\.|require\(|Buffer\b|__dirname|import\.meta\.env|from\s+"node:|from\s+"fs"|XMLHttpRequest)/;
ck("1.3 sem APIs de Node/browser fora do runtime (process, require, Buffer, node:*)", files.every((f) => !banned.test(src[f].replace(/\/\/.*$/gm, ""))));
ck("1.4 usa Deno.serve e Deno.env.get (padrão das outras funções) e nenhum outro Deno.*", /Deno\.serve\(/.test(src[files[0]]) && [...src[files[0]].matchAll(/Deno\.(\w+)/g)].every((m) => ["serve", "env"].includes(m[1])));
ck("1.5 config.toml: verify_jwt = true para a função", /\[functions\.whatsapp-signup-complete\][^\[]*verify_jwt\s*=\s*true/s.test(fs.readFileSync(path.join(root, "supabase/config.toml"), "utf8")));
ck("1.6 chaves/segredos lidos do ambiente, nenhum valor literal", !/(eyJ[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9]{20,}|service_role_key\s*=\s*["'][^"']+)/i.test(src[files[0]]));

console.log("\n== 2. index.ts real no runtime simulado ==");
const ENV = {
  SUPABASE_ANON_KEY: "ANON-KEY-DE-TESTE", SUPABASE_SERVICE_ROLE_KEY: "SERVICE-ROLE-DE-TESTE",
  WHATSAPP_GRAPH_API_VERSION: "v99.0", WHATSAPP_APP_SECRET: "APP-SECRET-DE-TESTE-NAO-REAL", WHATSAPP_REGISTRATION_PIN_SECRET: "PIN-SECRET-DE-TESTE-1234567890",
};
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
  declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id into v; return v; end $f$;
`);
await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id='1234567890', embedded_signup_config_id='9876543210'");

// ---- Supabase falso (Auth + PostgREST mínimo) sobre o PGlite
const seen = { auth: [], rest: [], rpc: [] };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (url.pathname === "/auth/v1/user") {
    seen.auth.push({ apikey: req.headers.apikey, bearer });
    const m = /^jwt-([0-9a-f-]{36})$/.exec(bearer);
    return m ? send(200, { id: m[1], aud: "authenticated", role: "authenticated", email: "u@x.com", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }) : send(401, { code: 401, msg: "invalid JWT" });
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    if (bearer !== ENV.SUPABASE_SERVICE_ROLE_KEY) return send(401, { message: "somente service_role" });
    const name = url.pathname.slice("/rest/v1/".length);
    if (name.startsWith("rpc/")) {
      const fn = name.slice(4); const keys = Object.keys(body ?? {});
      seen.rpc.push(fn);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) j`;
      const r = await as("service_role", null, sql, keys.map((k) => body[k]));
      return r.ok ? send(200, r.rows[0].j) : send(400, { code: r.code ?? "P0001", message: r.err });
    }
    seen.rest.push(name);
    const allowed = { whatsapp_platform_settings: ["embedded_signup_enabled", "meta_app_id"], company_whatsapp_connections: ["company_id", "phone_number_id", "status"] };
    if (!allowed[name]) return send(404, { message: "tabela inesperada" });
    const where = []; const params = [];
    for (const [k, v] of url.searchParams) { if (["select", "limit", "order"].includes(k)) continue; const m = /^eq\.(.*)$/.exec(v); if (!allowed[name].includes(k) || !m) return send(400, { message: "filtro inesperado" }); params.push(m[1]); where.push(`${k} = $${params.length}`); }
    const cols = (url.searchParams.get("select") ?? "*").split(",").map((c) => c.trim()); if (!cols.every((c) => allowed[name].includes(c))) return send(400, { message: "coluna inesperada" });
    const lim = Number(url.searchParams.get("limit") ?? 1000);
    const r = await su(`select ${cols.join(", ")} from public.${name}${where.length ? " where " + where.join(" and ") : ""} limit ${lim}`, params);
    const rows = r.rows ?? [];
    if ((req.headers.accept ?? "").includes("pgrst.object")) return rows.length === 1 ? send(200, rows[0]) : send(406, { code: "PGRST116", message: "0 ou várias linhas" });
    return send(200, rows);
  }
  send(404, { message: "rota inesperada" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
ENV.SUPABASE_URL = `http://127.0.0.1:${PORT}`;

// ---- Meta simulada (fetch interceptado) e shim do Deno
const metaCalls = [];
let metaMode = "ok";
const realFetch = globalThis.fetch;
const TOKEN = "EAAB-RUNTIME-TOKEN-0123456789ABCDEF";
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (new URL(url).hostname !== "graph.facebook.com") return realFetch(input, init);
  const u = new URL(url);
  const h = new Headers(init.headers ?? {});
  metaCalls.push({ method: init.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), auth: h.get("authorization"), body: init.body ? JSON.parse(init.body) : null });
  const J = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  if (metaMode === "code_invalid" && u.pathname.endsWith("/oauth/access_token")) return J(400, { error: { message: "code inválido", code: 100 } });
  if (u.pathname.endsWith("/oauth/access_token")) return J(200, { access_token: TOKEN });
  if (u.pathname.endsWith("/phone_numbers")) return J(200, { data: [{ id: PNID, display_phone_number: "+55 11 90000-2222", verified_name: "Loja Runtime" }] });
  if (u.pathname.endsWith("/register")) return J(200, { success: true });
  if (u.pathname.endsWith("/subscribed_apps") && (init.method ?? "GET") === "POST") return J(200, { success: true });
  if (u.pathname.endsWith("/subscribed_apps")) return J(200, { data: [{ whatsapp_business_api_data: { id: "1234567890", name: "App" } }] });
  return J(404, { error: { code: 1 } });
};
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; return { finished: Promise.resolve() }; } };

// transpila index.ts + dependências e roda o index.ts real
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wasignup-rt-"));
const sbUrl = pathToFileURL(require.resolve("@supabase/supabase-js")).href;
fs.writeFileSync(path.join(tmp, "sb-shim.mjs"), `import * as m from ${JSON.stringify(sbUrl)}; export const createClient = m.createClient ?? m.default.createClient;`);
const emit = (srcRel, name, rewrites) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(root, srcRel), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
};
emit("supabase/functions/_shared/whatsapp-graph.ts", "whatsapp-graph.mjs", []);
emit("supabase/functions/_shared/whatsapp-signup-graph.ts", "whatsapp-signup-graph.mjs", [['"./whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
emit(`${FN}/handler.ts`, "handler.mjs", [['"../_shared/whatsapp-signup-graph.ts"', '"./whatsapp-signup-graph.mjs"'], ['"../_shared/whatsapp-graph.ts"', '"./whatsapp-graph.mjs"']]);
emit(`${FN}/index.ts`, "index.mjs", [[`"npm:@supabase/supabase-js@${SB_VERSION}"`, '"./sb-shim.mjs"'], ['"../_shared/whatsapp-signup-graph.ts"', '"./whatsapp-signup-graph.mjs"'], ['"./handler.ts"', '"./handler.mjs"']]);
let initError = null;
try { await import(pathToFileURL(path.join(tmp, "index.mjs")).href); } catch (e) { initError = e; }
ck("2.1 o index.ts inicializa (imports resolvem, createClient, Deno.serve registra o handler)", !initError && typeof handler === "function", String(initError));

// ---- fixtures
let seq = 900, pn = 940000000;
const PNID = String(++pn);
async function mkCo(tag) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "rt-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
  const out = { c, ids: {} };
  for (const role of ["owner", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out.ids[role] = u;
  }
  await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste runtime', now() + interval '1 day')", [c]);
  return out;
}
const begin = async (co) => (await as("authenticated", co.ids.owner, "select public.whatsapp_signup_begin($1) j", [co.c])).rows[0].j.state;
const call = async (token, body) => {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await handler(new Request("http://localhost/functions/v1/whatsapp-signup-complete", { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* sem corpo */ }
  return { status: res.status, j, text };
};

const A = await mkCo("A");
ck("2.2 CORS/OPTIONS responde 204 pelo handler real", (await handler(new Request("http://localhost/x", { method: "OPTIONS" }))).status === 204);
ck("2.3 sem Authorization: 401 (sem tocar em Auth nem banco)", (await call(null, {})).status === 401 && seen.auth.length === 0);

const state = await begin(A);
const body = { state, code: "AQD-RUNTIME-CODE-SECRETO", waba_id: "555000111222", phone_number_id: PNID };
const bad = await call("jwt-invalido", body);
ck("2.4 JWT rejeitado pelo Auth (via supabase-js auth.getUser): 401 e a sessão segue pending", bad.status === 401 && seen.auth.length === 1 && seen.auth[0].bearer === "jwt-invalido" && (await su("select status from whatsapp_signup_sessions where company_id=$1", [A.c])).rows[0].status === "pending");
ck("2.5 o client de Auth usa a anon key (apikey) e o JWT do usuário no getUser", seen.auth[0].apikey === ENV.SUPABASE_ANON_KEY);

const ok = await call(`jwt-${A.ids.owner}`, body);
ck("2.6 fluxo completo pelo index.ts real: 200 {ok, active, test}", ok.status === 200 && ok.j?.ok === true && ok.j.status === "active" && ok.j.mode === "test", `${ok.status} ${ok.text}`);
const conn = (await su("select * from company_whatsapp_connections where company_id=$1", [A.c])).rows[0];
ck("2.7 conexão criada na empresa da sessão (RPCs e leituras via PostgREST com service_role), token só no Vault", conn?.status === "active" && conn.phone_number_id === PNID && conn.connection_source === "embedded_signup"
  && (await su("select secret from vault.secrets where id=$1", [conn.token_secret_id])).rows[0].secret === TOKEN);
ck("2.8 RPCs chamadas, na ordem do fluxo, e leituras só nas duas tabelas esperadas", seen.rpc.join(",") === "whatsapp_signup_reserve,whatsapp_signup_store_token,whatsapp_signup_complete" && seen.rest.every((t) => ["whatsapp_platform_settings", "company_whatsapp_connections"].includes(t)) && seen.rest.includes("whatsapp_platform_settings"), seen.rpc.join(",") + " | " + seen.rest.join(","));
const paths = metaCalls.map((c) => `${c.method} ${c.path.replace(/\/[0-9]{5,}\//, "/{id}/")}`);
ck("2.9 Meta simulada recebeu, em ordem: troca, números da WABA, registro, assinatura, conferência — todas em /v99.0", metaCalls.length === 5 && metaCalls.every((c) => c.path.startsWith("/v99.0/"))
  && /oauth\/access_token$/.test(metaCalls[0].path) && /phone_numbers$/.test(metaCalls[1].path) && /register$/.test(metaCalls[2].path) && metaCalls[3].method === "POST" && /subscribed_apps$/.test(metaCalls[3].path) && metaCalls[4].method === "GET", paths.join(" | "));
ck("2.10 troca: client_id do banco + client_secret do ambiente + code; demais chamadas com Bearer do token do cliente (nunca em query)", metaCalls[0].query.client_id === "1234567890" && metaCalls[0].query.client_secret === ENV.WHATSAPP_APP_SECRET && metaCalls[0].query.code === body.code && metaCalls[0].auth === null
  && metaCalls.slice(1).every((c) => c.auth === `Bearer ${TOKEN}` && !JSON.stringify(c.query).includes(TOKEN)) && /^\d{6}$/.test(metaCalls[2].body.pin) && metaCalls[2].body.messaging_product === "whatsapp");
ck("2.11 resposta ao navegador sem token, code, secrets, ids de Vault", !ok.text.includes(TOKEN) && !ok.text.includes(body.code) && !ok.text.includes(ENV.WHATSAPP_APP_SECRET) && !ok.text.includes(conn.token_secret_id));

const replay = await call(`jwt-${A.ids.owner}`, body);
ck("2.12 repetir o mesmo state: 409 e a Meta não é chamada de novo", replay.status === 409 && metaCalls.length === 5);

const B = await mkCo("B");
metaMode = "code_invalid";
const sB = await begin(B);
metaCalls.length = 0;
const bad2 = await call(`jwt-${B.ids.owner}`, { state: sB, code: "x-code", waba_id: "555000111222", phone_number_id: String(pn + 5) });
ck("2.13 erro da Meta (code inválido): 400 sem detalhe da Meta, sessão failed, nada criado", bad2.status === 400 && !/código inválido|100/.test(bad2.text) && (await su("select status, error_code from whatsapp_signup_sessions where company_id=$1", [B.c])).rows[0].error_code === "meta_code_exchange"
  && (await su("select count(*) n from company_whatsapp_connections where company_id=$1", [B.c])).rows[0].n === 0 || Number((await su("select count(*) n from company_whatsapp_connections where company_id=$1", [B.c])).rows[0].n) === 0);
metaMode = "ok";

const saved = { ...ENV };
delete ENV.WHATSAPP_REGISTRATION_PIN_SECRET;
const C = await mkCo("C");
const sC = await begin(C);
const noCfg = await call(`jwt-${C.ids.owner}`, { state: sC, code: "c", waba_id: "555000111222", phone_number_id: PNID });
ENV.WHATSAPP_REGISTRATION_PIN_SECRET = saved.WHATSAPP_REGISTRATION_PIN_SECRET;
ck("2.14 sem WHATSAPP_REGISTRATION_PIN_SECRET no ambiente: 503 e a sessão fica intacta (a função publicada sem o secret é inerte)", noCfg.status === 503 && (await su("select status from whatsapp_signup_sessions where company_id=$1", [C.c])).rows[0].status === "pending");
await su("update whatsapp_platform_settings set embedded_signup_enabled=false");
const off = await call(`jwt-${C.ids.owner}`, { state: sC, code: "c", waba_id: "555000111222", phone_number_id: PNID });
await su("update whatsapp_platform_settings set embedded_signup_enabled=true");
ck("2.15 flag desligada no banco: 503 pelo caminho real (leitura de whatsapp_platform_settings)", off.status === 503 && (await su("select status from whatsapp_signup_sessions where company_id=$1", [C.c])).rows[0].status === "pending");

server.close();
globalThis.fetch = realFetch;
fs.rmSync(tmp, { recursive: true, force: true });
summary("WHATSAPP SIGNUP RUNTIME (index.ts)");
