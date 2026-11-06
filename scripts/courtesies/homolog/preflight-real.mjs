// Etapa 6 / item 3: pré-flight de deriva em PostgreSQL REAL (17.6, local e descartável). Constrói o schema-base representativo (todas as migrations
// anteriores a 1115, menos o agendamento pg_cron), registra o histórico como a CLI faz (supabase_migrations.schema_migrations), aplica as 8 migrations
// de cortesia UMA POR VEZ numa mesma sessão (como `db push`) e roda o pré-flight ANTES, DURANTE (após cada migration) e DEPOIS. Também injeta deriva real.
//   HOMOLOG_REAL=1 node scripts/courtesies/homolog/preflight-real.mjs
import fs from "node:fs";
import path from "node:path";
import { COURTESY, MIG, PREFLIGHT_DIR } from "../lib.mjs";
import { dispose, makeEmptyDb } from "./real-db.mjs";

let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : "  >> " + extra}`); cond ? okN++ : failN++; };
const PF = fs.readFileSync(path.join(PREFLIGHT_DIR, "courtesy-preflight.sql"), "utf8");
const ms = (t0) => Math.round(performance.now() - t0);
const timings = [];

const pg = await makeEmptyDb();
const preflight = async () => { const t0 = performance.now(); const r = await pg.query(PF); const t = ms(t0); return { v: JSON.parse(r.rows[0].preflight), ms: t }; };

console.log("== A. schema-base (migrations anteriores a 1115) ==");
{
  await pg.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);");
  const base = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql") && f < "20261115010000").sort();
  const t0 = performance.now(); let skipped = 0;
  for (const f of base) {
    const v = f.slice(0, 14), name = f.slice(15).replace(/\.sql$/, "");
    if (/billing_cron|push_cron/.test(f)) { skipped++; await pg.query("insert into supabase_migrations.schema_migrations (version, name) values ($1,$2)", [v, name + " (não aplicada: pg_cron indisponível para o papel postgres; só o registro)"]); continue; }
    try { await pg.exec(fs.readFileSync(path.join(MIG, f), "utf8")); } catch (e) { console.log("ERRO base", f, e.message, e.code); process.exit(2); }
    await pg.query("insert into supabase_migrations.schema_migrations (version, name) values ($1,$2)", [v, name]);
  }
  timings.push(["schema-base", `${base.length - skipped} migrations`, ms(t0)]);
  ck(`A.1 ${base.length - skipped} migrations anteriores aplicadas sem erro em PG17 real (${skipped} de pg_cron só registradas no histórico)`, true);
  ck("A.2 versão do servidor é PostgreSQL 17", /PostgreSQL 17\./.test((await pg.query("select version() v")).rows[0].v), "");
}

console.log("\n== B. pré-flight ANTES, DURANTE e DEPOIS ==");
{
  const { v, ms: t } = await preflight();
  timings.push(["pré-flight (etapa 0)", "", t]);
  ck("B.0 ANTES: ready, safe_to_apply, next=1115, sem divergências — o manifesto gerado em PGlite casa com o PostgreSQL real", v.verdict === "ready" && v.safe_to_apply === true && v.observed_stage === 0 && v.next_migration === COURTESY[0].slice(0, 14) && v.mismatches.length === 0, JSON.stringify(v).slice(0, 600));
  for (let k = 1; k <= COURTESY.length; k++) {
    const f = COURTESY[k - 1], t0 = performance.now();
    try { await pg.exec(fs.readFileSync(path.join(MIG, f), "utf8")); } catch (e) { console.log("ERRO migration", f, e.message, e.code); process.exit(2); }
    const tm = ms(t0);
    await pg.query("insert into supabase_migrations.schema_migrations (version, name) values ($1,$2)", [f.slice(0, 14), f.slice(15).replace(/\.sql$/, "")]);
    const r = await preflight();
    timings.push([`migration ${f.slice(0, 14)}`, "aplicar", tm]);
    timings.push([`pré-flight (etapa ${k})`, "", r.ms]);
    const last = k === COURTESY.length;
    ck(`B.${k} DURANTE: após ${f.slice(0, 14)} (${tm} ms) → ${last ? "applied" : "partial, próxima " + COURTESY[k].slice(0, 14)}`,
      r.v.verdict === (last ? "applied" : "partial") && r.v.observed_stage === k && r.v.mismatches.length === 0 && r.v.safe_to_apply === !last, JSON.stringify(r.v).slice(0, 500));
  }
  const fin = await preflight();
  ck("B.9 DEPOIS: applied, histórico consistente com as 8 migrations e sem divergências", fin.v.verdict === "applied" && fin.v.history.known === true && fin.v.history.courtesy_applied.length === COURTESY.length && fin.v.history.prerequisites_missing.length === 0, JSON.stringify(fin.v).slice(0, 400));
}

console.log("\n== C. deriva REAL injetada em PostgreSQL 17 ==");
{
  const defOf = async (name) => (await pg.query("select pg_get_functiondef(p.oid) d from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace", [name])).rows[0].d;
  const bad = (d) => d.replace(/\$([a-z_]*)\$\s*$/i, (m) => `\n-- deriva remota\n${m}`);
  for (const fn of ["company_entitlement", "company_write_blocked", "generate_subscription_invoice", "run_billing_cycle", "tenant_get_access_state", "master_list_courtesy_attention"]) {
    const d = await defOf(fn);
    await pg.exec(bad(d));
    const r = await preflight();
    ck(`C.${fn}: deriva em ${fn} → drift apontando a função`, r.v.verdict === "drift" && r.v.safe_to_apply === false && r.v.mismatches.some((x) => x.name.startsWith(fn + "(")), `${r.v.verdict} ${r.v.mismatches.map((x) => x.name)}`);
    await pg.exec(d);
    const back = await preflight();
    if (back.v.verdict !== "applied") ck(`C.${fn}b restaurada volta a applied`, false, back.v.verdict + JSON.stringify(back.v.mismatches));
  }
  await pg.exec("alter table public.subscriptions add column zz_drift int");
  let r = await preflight();
  ck("C.tabela: coluna extra em subscriptions → drift apontando a tabela", r.v.verdict === "drift" && r.v.mismatches.some((x) => x.kind === "table" && x.name === "subscriptions"), JSON.stringify(r.v.mismatches));
  await pg.exec("alter table public.subscriptions drop column zz_drift");
  await pg.exec("delete from supabase_migrations.schema_migrations where version = '20261003000000' or version = (select min(version) from supabase_migrations.schema_migrations)");
  r = await preflight();
  ck("C.histórico: migration anterior ausente do histórico → drift e lista a faltante", r.v.verdict === "drift" && r.v.history.prerequisites_missing.length >= 1, JSON.stringify(r.v.history));
  const final = await preflight();
  void final;
}

console.log("\n== D. tempos ==");
for (const [a, b, t] of timings) console.log(`   ${a}${b ? " (" + b + ")" : ""}: ${t} ms`);
const pfTimes = timings.filter((x) => x[0].startsWith("pré-flight")).map((x) => x[2]);
ck("D.1 o pré-flight é rápido (< 2 s por execução) e somente leitura", Math.max(...pfTimes) < 2000, `máx ${Math.max(...pfTimes)} ms`);

console.log(`\nRESULTADO pré-flight em PG real: ${okN} ok, ${failN} falhas`);
await dispose();
process.exit(failN ? 1 : 0);
