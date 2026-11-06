// Teste do PRÉ-FLIGHT DE DERIVA de cortesias, em bancos descartáveis (PGlite). Nada toca banco remoto.
//   node scripts/courtesies/test-preflight.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { COURTESY, N, MIG, PREFLIGHT_DIR, ROOT, loadAllFn, stageDir } from "./lib.mjs";

const loadAll = await loadAllFn();
const SQL = fs.readFileSync(path.join(PREFLIGHT_DIR, "courtesy-preflight.sql"), "utf8");
const MAN = JSON.parse(fs.readFileSync(path.join(PREFLIGHT_DIR, "manifest.json"), "utf8"));
let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : "  >> " + extra}`); cond ? okN++ : failN++; };

async function db(k, { history = "auto" } = {}) {
  const { pg } = await loadAll(stageDir(k), { legacyIaMirror: false });
  if (history !== "none") {
    await pg.exec("create schema if not exists supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text)");
    const vs = [...MAN.prerequisite_versions, ...MAN.migrations.slice(0, k)];
    for (const v of vs) await pg.query("insert into supabase_migrations.schema_migrations (version) values ($1)", [v]);
  }
  return pg;
}
// Executa o pré-flight dentro de uma transação SOMENTE LEITURA (prova que o script não escreve).
async function pre(pg) {
  await pg.exec("begin read only");
  try { const r = await pg.query(SQL); return JSON.parse(r.rows[0].preflight); } finally { await pg.exec("rollback"); }
}
const names = (v) => v.mismatches.map((x) => x.name).join(" | ");

console.log("\n== 1. arquivos gerados e propriedades do script ==");
{
  let up = true;
  try { execFileSync("node", [path.join(ROOT, "scripts/courtesies/gen-preflight.mjs"), "--check"], { stdio: "pipe" }); } catch { up = false; }
  ck("1.1 manifest e SQL estão atualizados em relação às migrations (--check)", up);
  ck("1.2 o SQL não contém barra invertida (a CLI do Supabase a consome)", !SQL.includes("\\"));
  const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ck("1.3 o SQL é um único SELECT (sem insert/update/delete/create/alter/drop/grant/truncate/set/do/call)", !/\b(insert|update|delete|create|alter|drop|grant|revoke|truncate|call|do|set|copy|vacuum)\b\s/i.test(code.replace(/'[^']*'/g, "''")) && (code.match(/;/g) ?? []).length === 1);
  ck("1.4 manifesto cobre todas as etapas, funções e tabelas rastreadas", Object.keys(MAN.stages).length === N + 1 && Object.keys(MAN.stages[0].fns).length >= 40 && Object.keys(MAN.stages[0].tabs).length >= 10, JSON.stringify(Object.keys(MAN.stages[0].fns).length));
  const mustTrack = ["company_access_state(p_company_id uuid)", "company_entitlement(p_company_id uuid)", "company_write_blocked(p_company_id uuid)", "generate_subscription_invoice", "change_effective_competence", "billing_next_due_date", "billing_module_cycle", "master_set_billing_day", "tenant_schedule_module_change", "master_subscribe_company", "billing_subscribe_company", "billing_module_change_plan", "run_billing_cycle"];
  const keys = Object.keys(MAN.stages[0].fns);
  ck("1.5 as 13 funções pré-existentes alteradas/patcheadas estão rastreadas (e existem na etapa 0)", mustTrack.every((n) => keys.some((k) => k.startsWith(n) && MAN.stages[0].fns[k] !== "ABSENT")), mustTrack.filter((n) => !keys.some((k) => k.startsWith(n))).join(","));
  ck("1.6 hashes mudam entre etapas só onde a migration mexe (cada etapa difere da anterior)", Array.from({ length: N }, (_, i) => i + 1).every((k) => JSON.stringify(MAN.stages[k]) !== JSON.stringify(MAN.stages[k - 1])));
}

console.log("\n== 2. estados legítimos ==");
{
  const pg = await db(0);
  const v = await pre(pg);
  ck("2.1 etapa 0 com histórico: ready + safe_to_apply, next=1115, sem divergências", v.verdict === "ready" && v.safe_to_apply === true && v.observed_stage === 0 && v.next_migration === COURTESY[0].slice(0, 14) && v.mismatches.length === 0, JSON.stringify(v).slice(0, 400));
  ck("2.2 histórico conhecido e consistente", v.history.known === true && v.history.courtesy_applied.length === 0 && v.history.prerequisites_missing.length === 0);
}
{
  const pg = await db(0, { history: "none" });
  const v = await pre(pg);
  ck("2.3 sem tabela de histórico: ready (history.known=false) — a decisão cai nas definições", v.verdict === "ready" && v.history.known === false && v.safe_to_apply === true);
}
for (let k = 1; k <= N; k++) {
  const pg = await db(k);
  const v = await pre(pg);
  const last = k === N;
  ck(`2.${3 + k} etapa ${k} (${COURTESY[k - 1].slice(0, 14)} aplicada): ${last ? "applied, nada a aplicar" : "partial, next=" + COURTESY[k].slice(0, 14)}`,
    v.verdict === (last ? "applied" : "partial") && v.observed_stage === k && v.safe_to_apply === !last && v.next_migration === (last ? null : COURTESY[k].slice(0, 14)) && v.mismatches.length === 0, JSON.stringify(v).slice(0, 300));
}

console.log("\n== 3. deriva das funções pré-existentes (cada uma, individualmente, na etapa 0) ==");
{
  const pg = await db(0);
  const pre0 = Object.keys(MAN.stages[0].fns).filter((k) => MAN.stages[0].fns[k] !== "ABSENT");
  let n = 0;
  for (const key of pre0) {
    const oid = (await pg.query(`select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $1`, [key])).rows[0].oid;
    const def = (await pg.query("select pg_get_functiondef($1::oid) d", [oid])).rows[0].d;
    const bad = def.replace(/\$([a-z_]*)\$\s*$/i, (m) => `\n-- deriva remota\n${m}`);
    if (bad === def) { ck(`3.x não foi possível simular deriva em ${key}`, false); continue; }
    await pg.exec(bad);
    const v = await pre(pg);
    ck(`3.${++n} deriva em ${key}: BLOQUEIA e aponta a função`, v.verdict === "drift" && v.safe_to_apply === false && v.mismatches.some((x) => x.name === key && x.kind === "function"), `${v.verdict} ${names(v)}`);
    await pg.exec(def);                                   // restaura
    const back = await pre(pg);
    if (back.verdict !== "ready") ck(`3.${n}b restauração de ${key} volta a ready`, false, names(back));
  }
  ck("3.F ao final, tudo restaurado: ready", (await pre(pg)).verdict === "ready");
}

console.log("\n== 4. outras divergências ==");
{
  const pg = await db(0);
  await pg.exec("alter table public.subscriptions add column zz_remote_extra int");
  let v = await pre(pg);
  ck("4.1 coluna extra numa tabela de que as migrations dependem (subscriptions): drift apontando a tabela", v.verdict === "drift" && v.mismatches.some((x) => x.kind === "table" && x.name === "subscriptions"), names(v));
  await pg.exec("alter table public.subscriptions drop column zz_remote_extra");
  ck("4.2 removida a coluna extra: ready", (await pre(pg)).verdict === "ready");
  await pg.exec("create table public.company_courtesies (id int)");
  v = await pre(pg);
  ck("4.3 tabela de cortesia pré-existente/estranha (company_courtesies) no alvo: drift", v.verdict === "drift" && v.safe_to_apply === false && v.mismatches.some((x) => x.name === "company_courtesies"), names(v));
  await pg.exec("drop table public.company_courtesies");
  await pg.exec("create function public.courtesy_check_reason(p_reason text) returns text language sql as $$ select p_reason $$");
  v = await pre(pg);
  ck("4.4 função de cortesia estranha pré-existente: drift", v.verdict === "drift" && v.safe_to_apply === false, names(v));
  await pg.exec("drop function public.courtesy_check_reason(text)");
  await pg.exec("alter function public.company_write_blocked(uuid) security invoker");
  v = await pre(pg);
  ck("4.5 mudança só de atributo (SECURITY DEFINER→INVOKER) é detectada", v.verdict === "drift" && v.mismatches.some((x) => x.name.startsWith("company_write_blocked")), names(v));
}
{
  const pg = await db(0);
  await pg.query("insert into supabase_migrations.schema_migrations (version) values ($1)", [MAN.migrations[0]]);
  let v = await pre(pg);
  ck("4.6 histórico diz que 1115 está aplicada mas as definições são da etapa 0: drift (inconsistência)", v.verdict === "drift" && v.safe_to_apply === false && v.history.courtesy_applied.length === 1, JSON.stringify(v).slice(0, 300));
}
{
  const pg = await db(0);
  await pg.query("delete from supabase_migrations.schema_migrations where version = $1", [MAN.prerequisite_versions[MAN.prerequisite_versions.length - 1]]);
  const v = await pre(pg);
  ck("4.7 migration anterior pendente no alvo: drift e lista a faltante", v.verdict === "drift" && v.safe_to_apply === false && v.history.prerequisites_missing.length === 1, JSON.stringify(v.history));
  await pg.query("insert into supabase_migrations.schema_migrations (version) values ('20270101010000')");
  const v2 = await pre(pg);
  ck("4.8 migration posterior desconhecida é listada (newer_unknown)", v2.history.newer_unknown.includes("20270101010000"));
}

console.log("\n== 5. deriva em etapas intermediárias/finais ==");
{
  const pg = await db(3);
  const key = "billing_next_due_date";
  const oid = (await pg.query("select p.oid from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace", [key])).rows[0].oid;
  const def = (await pg.query("select pg_get_functiondef($1::oid) d", [oid])).rows[0].d;
  await pg.exec(def.replace(/\$([a-z_]*)\$\s*$/i, (m) => `\n-- deriva\n${m}`));
  const v = await pre(pg);
  ck("5.1 etapa 3 + deriva numa função patcheada: drift, etapa mais próxima = 3, aponta billing_next_due_date", v.verdict === "drift" && v.closest_stage === 3 && v.mismatches.some((x) => x.name.startsWith(key)), `${v.verdict} ${v.closest_stage} ${names(v)}`);
}
{
  const pg = await db(N);
  await pg.exec("create or replace function public.courtesy_check_reason(p_reason text) returns text language sql as $$ select p_reason $$");
  const v = await pre(pg);
  ck("5.2 etapa final (tudo aplicado) + função de cortesia alterada: drift (applied só quando idêntico)", v.verdict === "drift" && v.safe_to_apply === false, `${v.verdict}`);
}

console.log(`\nRESULTADO pré-flight de cortesias: ${okN} ok, ${failN} falhas`);
process.exit(failN ? 1 : 0);
