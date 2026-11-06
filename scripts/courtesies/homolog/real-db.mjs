// HOMOLOGAÇÃO COM POSTGRESQL REAL (Etapa 6) — adaptador para rodar as suítes de banco do projeto contra um PostgreSQL 17.6 LOCAL e DESCARTÁVEL
// (container Docker "courtesy-homolog-pg", imagem supabase/postgres, publicado SÓ em 127.0.0.1:54399). Sem driver npm: usa sessões `psql` persistentes
// via `docker exec`. Cada sessão é uma conexão (backend) independente do servidor.
//
// SEGURANÇA: o adaptador recusa qualquer container que não tenha o rótulo purpose=courtesy-homologation e porta só em 127.0.0.1; nunca usa
// --linked, supabase CLI, credenciais ou URL remota.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTAINER = process.env.HOMOLOG_CONTAINER ?? "courtesy-homolog-pg";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function assertIsolated() {
  const out = execFileSync("docker", ["inspect", CONTAINER, "--format", "{{json .Config.Labels}}|{{json .NetworkSettings.Ports}}"], { encoding: "utf8" }).trim();
  const [labels, ports] = out.split("|");
  const l = JSON.parse(labels), p = JSON.parse(ports);
  const binds = (p["5432/tcp"] ?? []).map((x) => x.HostIp);
  if (l.purpose !== "courtesy-homologation") throw new Error(`container ${CONTAINER} não é o ambiente de homologação (rótulo purpose ausente) — recusado`);
  if (!binds.length || !binds.every((h) => h === "127.0.0.1")) throw new Error(`container ${CONTAINER} exposto fora de 127.0.0.1 (${binds.join(",")}) — recusado`);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?|Z)$/;
const lit = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return `'{${v.map((x) => (x === null ? "NULL" : `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")}}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
export function bind(sql, params) {
  if (!params || params.length === 0) return sql;
  // $n só fora de corpos entre $$...$$ / $tag$...$tag$ (os testes só passam parâmetros em consultas simples)
  return sql.replace(/\$(\d+)/g, (m, n) => { const i = Number(n) - 1; if (i >= params.length) throw new Error(`parâmetro $${n} sem valor`); return lit(params[i]); });
}

export class PsqlSession {
  constructor(db, { app = "homolog" } = {}) {
    this.db = db; this.inTx = false; this.n = 0; this.buf = ""; this.waiter = null; this.dead = false;
    this.p = spawn("docker", ["exec", "-i", "-e", `PGAPPNAME=${app}`, CONTAINER, "bash", "-c", `psql -U postgres -d ${db} -X -q -A -t -v ON_ERROR_STOP=0 -v VERBOSITY=verbose 2>&1`], { stdio: ["pipe", "pipe", "inherit"] });
    this.p.stdout.setEncoding("utf8");
    this.p.stdout.on("data", (d) => { this.buf += d; this._check(); });
    this.p.on("exit", () => { this.dead = true; if (this.waiter) this.waiter.reject(new Error("sessão psql encerrada")); });
    this.queue = Promise.resolve();
  }
  _check() {
    if (!this.waiter) return;
    const i = this.buf.indexOf(this.waiter.marker);
    if (i < 0) return;
    const out = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + this.waiter.marker.length).replace(/^\r?\n/, "");
    const w = this.waiter; this.waiter = null; w.resolve(out);
  }
  /** Envia um bloco e devolve o que o psql imprimiu até o marcador (saída + mensagens de erro). Serializa chamadas. */
  raw(text) {
    const job = this.queue.then(() => new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error("sessão psql encerrada"));
      const marker = `@@END${++this.n}_${crypto.randomBytes(3).toString("hex")}@@`;
      this.waiter = { marker, resolve, reject };
      this.p.stdin.write(`${text}\n\\echo ${marker}\n`);
    }));
    this.queue = job.catch(() => {});
    return job;
  }
  close() { try { this.p.stdin.end(); } catch { /* */ } try { this.p.kill(); } catch { /* */ } }
}

const ERR = /(?:^|\n)(?:psql:[^\n]*?: )?ERROR:\s+([0-9A-Za-z]{5}):\s+([\s\S]*?)(?=\n(?:DETAIL|HINT|CONTEXT|LOCATION|STATEMENT|QUERY):|\n(?:psql:[^\n]*?: )?(?:ERROR|NOTICE|WARNING):|\n$|$)/;
function parseError(out) {
  const m = out.match(ERR);
  if (!m) return null;
  return Object.assign(new Error(m[2].trim()), { code: m[1] });
}
const noise = (out) => out.split("\n").filter((l) => !/^(NOTICE|WARNING|DETAIL|HINT|CONTEXT|LOCATION|STATEMENT|QUERY):|^psql:.*(NOTICE|WARNING)|^LINE \d+:|^\s+\^$/.test(l)).join("\n");

/** Interface compatível com a parte do PGlite usada pelas suítes: exec(sql) e query(sql, params) -> { rows }. */
export class RealPg {
  constructor(db, opts) { this.db = db; this.s = new PsqlSession(db, opts); }
  async exec(sql) {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    const isTxCmd = /^(begin|start transaction|commit|rollback|end|abort)\b[^;]*$/i.test(trimmed);
    let text = sql;
    const wrap = !this.s.inTx && !isTxCmd;
    if (wrap) text = `begin;\n${sql}\n;commit;`;
    const out = await this.s.raw(isTxCmd ? text.replace(/;*\s*$/, "") + ";" : text);
    const err = parseError(out);
    if (isTxCmd) {
      if (/^(begin|start)/i.test(trimmed)) this.s.inTx = true;
      else if (/^(commit|rollback|end|abort)/i.test(trimmed)) this.s.inTx = false;
    }
    if (err) { if (wrap) await this.s.raw("rollback;"); throw err; }
    return [];
  }
  _prep(sql, params) {
    const q = bind(sql, params).replace(/^(\s*--[^\n]*\n)+/, "").trim().replace(/;+\s*$/, "");
    if (/^(select|values|table)\b/i.test(q) || (/^with\b/i.test(q) && !/\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i.test(q))) return { text: `select coalesce(jsonb_agg(to_jsonb(__r)), '[]'::jsonb) from (${q}) __r`, rowsExpected: true };
    if (/^(insert|update|delete)\b/i.test(q) && /\breturning\b/i.test(q)) return { text: `with __w as (${q}) select coalesce(jsonb_agg(to_jsonb(__w)), '[]'::jsonb) from __w`, rowsExpected: true };
    return { text: q, rowsExpected: false };
  }
  /** Corrida: define a identidade (fora da medição), espera até t0 (epoch ms) no relógio do SERVIDOR e executa. Devolve { ok, err, code, rows, ms }. */
  async queryAt(t0, sql, as) {
    await this.s.raw(as ? `set role ${as.role}; select set_config('request.jwt.claim.sub','${as.uid ?? ""}',false);` : "reset role;");
    const { text, rowsExpected } = this._prep(sql);
    const sent = Date.now();
    const out = await this.s.raw(`select pg_sleep(greatest(0, extract(epoch from (to_timestamp(${t0 / 1000}) - clock_timestamp()))));\n${text};`);
    const ms = Date.now() - Math.max(t0, sent);
    const err = parseError(out);
    if (err) return { ok: false, err: err.message, code: err.code, rows: [], ms };
    let rows = [];
    if (rowsExpected) { const line = noise(out).split("\n").map((l) => l.trim()).filter(Boolean).pop(); rows = line ? JSON.parse(line) : []; }
    return { ok: true, rows, ms };
  }
  async query(sql, params) {
    let q = bind(sql, params).replace(/^(\s*--[^\n]*\n)+/, "").trim().replace(/;+\s*$/, "");
    let text = q, rowsExpected = false;
    if (/^(select|values|table)\b/i.test(q) || (/^with\b/i.test(q) && !/\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i.test(q))) {
      text = `select coalesce(jsonb_agg(to_jsonb(__r)), '[]'::jsonb) from (${q}) __r`; rowsExpected = true;   // alias improvável: uma coluna da consulta chamada t/r não pode capturar a linha
    } else if (/^(insert|update|delete)\b/i.test(q) && /\breturning\b/i.test(q)) {
      text = `with __w as (${q}) select coalesce(jsonb_agg(to_jsonb(__w)), '[]'::jsonb) from __w`; rowsExpected = true;
    }
    const out = await this.s.raw(text + ";");
    const err = parseError(out);
    if (err) throw err;
    if (!rowsExpected) return { rows: [], affectedRows: 0 };
    const line = noise(out).split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (!line) return { rows: [], affectedRows: 0 };
    const rows = JSON.parse(line).map((r) => { for (const k of Object.keys(r)) if (typeof r[k] === "string" && ISO.test(r[k])) r[k] = new Date(r[k]); return r; });
    return { rows, affectedRows: rows.length };
  }
  close() { this.s.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Banco-base (template) e clones descartáveis
// ---------------------------------------------------------------------------------------------------------------------------
const admin = () => new PsqlSession("postgres", { app: "homolog-admin" });
async function createDb(a, name, template) {
  let o = "";
  for (let i = 0; i < 40; i++) {
    o = await a.raw(`create database ${name} template ${template};`);
    const e = parseError(o);
    if (!e) return;
    if (e.code !== "55006") throw e;                       // "source database is being accessed by other users": outro clone em andamento
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
  }
  throw parseError(o);
}
const SHIMS = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
  create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  create or replace function auth.email() returns text language sql stable as $f$ select nullif(current_setting('request.jwt.claim.email', true), '') $f$;
  grant usage on schema auth to anon, authenticated, service_role;
  create schema if not exists vault;
  create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text);
  -- alinhado ao harness PGlite: PIOR CASO de ACL (função/tabela nova nasce executável por todos; só os revoke das migrations fecham) — é também o default do Supabase
  alter default privileges in schema public grant execute on functions to public, anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- storage: o schema da imagem vem vazio (quem cria é o storage-api); mesmo shim mínimo do harness
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text not null unique, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), public boolean default false, avif_autodetection boolean default false, file_size_limit bigint, allowed_mime_types text[], owner_id text);
  create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, owner_id text, created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(), metadata jsonb, path_tokens text[] generated always as (string_to_array(name, '/')) stored, version text, user_metadata jsonb);
  create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text) returns text[] language plpgsql as $f$ declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[1:array_length(_parts, 1) - 1]; end $f$;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
  grant execute on function storage.foldername(text) to anon, authenticated, service_role;
  do $$ begin if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if; end $$;
  -- pg_net/pg_cron NÃO são ativados: net é uma tabela-espelho que só registra chamadas (nada sai da máquina) e o agendamento fica de fora
  create schema if not exists net;
  create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
  create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $f$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $f$;
`;
const MIRROR = `create or replace function public.__test_mirror_ia() returns trigger language plpgsql as $f$ begin
  if new.module_code = 'whatsapp' and exists (select 1 from public.modules where code = 'ia') then insert into public.company_module_overrides (company_id, module_code, reason, expires_at) values (new.company_id, 'ia', 'espelho de teste', new.expires_at) on conflict do nothing; end if; return new; end $f$;
  create trigger __test_mirror_ia after insert on public.company_module_overrides for each row execute function public.__test_mirror_ia();`;

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const dbExists = async (a, name) => (await a.raw(`select 1 from pg_database where datname = '${name}';`)).trim() === "1";
const cleanup = new Set();

async function ensureTemplate(a, dir, { skipActivation, legacyIaMirror }) {
  const files = fs.readdirSync(dir).filter((x) => x.endsWith(".sql") && !/billing_cron|push_cron/.test(x) && !(skipActivation && /activate_delivery_module/.test(x))).sort();
  const key = sha(files.map((f) => f + ":" + sha(fs.readFileSync(path.join(dir, f), "utf8"))).join("|") + `|${!!legacyIaMirror}|v2`);
  const name = `tpl_${key}`;
  if (await dbExists(a, name)) return { name, files, key, built: false };
  const t0 = Date.now();
  // banco NOVO a partir de template1; os papéis (anon, authenticated, service_role...) já existem no cluster da imagem; auth/vault/storage/net são os mesmos shims mínimos do harness PGlite
  await createDb(a, name, "template0");
  const s = new RealPg(name, { app: "homolog-build" });
  await s.exec(SHIMS);
  for (const f of files) {
    try { await s.exec(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch (e) { s.close(); await a.raw(`drop database if exists ${name};`); throw new Error(`migration ${f}: ${e.message} [${e.code}]`); }
  }
  if (legacyIaMirror && (await s.query("select to_regclass('public.company_module_overrides') t")).rows[0].t) await s.exec(MIRROR);
  s.close();
  console.error(`   (template ${name}: ${files.length} migrations em ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { name, files, key, built: true };
}

/** Clone descartável do template de `dir` (sem os helpers ck/as/su): para ferramentas de homologação. */
export async function makeDb(dir, { skipActivation = false, legacyIaMirror = false } = {}) {
  assertIsolated();
  const a = admin();
  try {
    const tpl = await ensureTemplate(a, dir, { skipActivation, legacyIaMirror });
    const dbname = `hml_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
    await createDb(a, dbname, tpl.name);
    cleanup.add(dbname);
    const pg = new RealPg(dbname); pg.dbname = dbname;
    return pg;
  } finally { a.close(); }
}
/** Banco VAZIO (só shims, sem migrations): para aplicar as migrations passo a passo. */
export async function makeEmptyDb() {
  assertIsolated();
  const a = admin();
  try {
    const dbname = `hml_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
    await createDb(a, dbname, "template0");
    cleanup.add(dbname);
    const pg = new RealPg(dbname); pg.dbname = dbname;
    await pg.exec(SHIMS);
    return pg;
  } finally { a.close(); }
}
export { SHIMS };

/** Compatível com loadAll() do full-db.mjs: banco NOVO e descartável (clone do template) com todas as migrations de `dir`. */
export async function loadAllReal(dir = process.env.MIG_DIR ?? path.join(ROOT, "supabase/migrations"), { skipActivation = false, legacyIaMirror = true } = {}) {
  assertIsolated();
  const a = admin();
  try {
    const tpl = await ensureTemplate(a, dir, { skipActivation, legacyIaMirror });
    const dbname = `hml_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
    await createDb(a, dbname, tpl.name);
    cleanup.add(dbname);
    const pg = new RealPg(dbname);
    pg.dbname = dbname;
    let pass = 0, fail = 0;
    const ck = (l, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS" : "FAIL") + " - " + l + (c ? "" : " :: " + String(x).slice(0, 500))); };
    const fmt = (e) => ({ ok: false, err: e.message, code: e.code });
    async function as(role, uid, sql, params) {
      await pg.exec(`select set_config('request.jwt.claim.sub','${uid ?? ""}',false); set role ${role};`);
      try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows }; }
      catch (e) { return fmt(e); }
      finally { await pg.exec("reset role;"); }
    }
    const su = async (sql, params) => { try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows }; } catch (e) { return fmt(e); } };
    const errHas = (r, re, code) => !r.ok && re.test(r.err) && (code === undefined || r.code === code);
    const summary = async (title) => { console.log(`\nRESULTADO ${title}: ${pass} ok / ${fail} falhas`); await dispose(); process.exit(fail ? 1 : 0); };
    return { pg, ck, as, su, errHas, summary };
  } finally { a.close(); }
}

/** Remove os bancos clone criados neste processo (os templates ficam para reaproveitar). */
export async function dispose() {
  if (!cleanup.size) return;
  const a = admin();
  for (const d of cleanup) await a.raw(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${d}' and pid <> pg_backend_pid();`).then(() => a.raw(`drop database if exists ${d};`)).catch(() => {});
  cleanup.clear(); a.close();
}
process.on("exit", () => { /* os clones são removidos por dispose() ou pelo comando de limpeza do runner */ });
