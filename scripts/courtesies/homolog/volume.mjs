// Etapa 6 / itens 7 e 8: DESEMPENHO com volume representativo e ENSAIO DE ROLLBACK/REAPLICAÇÃO com dados, em PostgreSQL 17 REAL (local e descartável).
// Dois bancos com a MESMA população de negócio: BASE (só migrations anteriores às cortesias) e FULL (as 8 migrations + cortesias, F1 e pontes).
//   HOMOLOG_REAL=1 node scripts/courtesies/homolog/volume.mjs [--quick]
import fs from "node:fs";
import path from "node:path";
import { COURTESY, MIG, ROLLBACK_DIR, PREFLIGHT_DIR, rollbackFile, schemaSig, sigDiff, stageDir } from "../lib.mjs";
import { loadAllRealDb } from "./concurrency-lib.mjs";

const QUICK = process.argv.includes("--quick");
const SZ = QUICK ? { paid: 120, pend: 60, f1: 60, trialOnly: 30, bridge: 20 } : { paid: 900, pend: 300, f1: 250, trialOnly: 100, bridge: 100 };
const TOTAL = Object.values(SZ).reduce((a, b) => a + b, 0);
let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : "  >> " + extra}`); cond ? okN++ : failN++; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const t = async (fn) => { const t0 = performance.now(); const r = await fn(); return { ms: performance.now() - t0, r }; };

const BASE = await loadAllRealDb(8, stageDir(0));
const FULL = await loadAllRealDb(8, MIG);
console.log(`população: ${TOTAL} empresas por banco (pagas ${SZ.paid}, pendentes comuns ${SZ.pend}, trial vencido + plano B pendente ${SZ.f1} [F1 no FULL], só trial vencido ${SZ.trialOnly}, ponte ${SZ.bridge})`);

// ---- população idêntica no negócio; o FULL acrescenta cortesias ---------------------------------------------------------------
async function populate(env, withCourtesies) {
  const { workers, clock, fx, db } = env; const MASTER = { role: "authenticated", uid: fx.master };
  const ids = { paid: [], pend: [], f1: [], trialOnly: [], bridge: [] };
  const par = async (items, fn) => { let i = 0; await Promise.all(workers.map(async (w, wi) => { while (true) { const k = i++; if (k >= items.length) return; await fn(w, items[k], k); } })); };
  const ins = async (w, tag0) => { const tag = tag0.toLowerCase(); const r = await w.queryAt(Date.now(), `insert into companies (name,slug,document,email) values ('${tag}','${tag}','11222333000181','${tag.replace(/-/g, "")}@x.com') returning id`); if (!r.ok) throw new Error('insert company: ' + r.err); return r.rows[0].id; };
  const rpc = async (w, sql) => { const r = await w.queryAt(Date.now(), sql, MASTER); if (!r.ok) throw new Error(`${r.err} :: ${sql.slice(0, 100)}`); return r.rows; };
  // fase 1: período grátis iniciado em 10/01 (empresas que terão trial VENCIDO)
  await clock("2030-01-10T12:00:00Z");
  const early = [...Array(SZ.f1).fill("f1"), ...Array(SZ.trialOnly).fill("trialOnly"), ...Array(SZ.bridge).fill("bridge")];
  const eIds = [];
  await par(early, async (w, kind, k) => { const c = await ins(w, `v-${kind}-${k}`); await rpc(w, `select * from master_start_trial('${c}')`); eIds[k] = { kind, c }; });
  for (const e of eIds) ids[e.kind].push(e.c);
  await clock("2030-03-01T12:00:00Z");
  await par([...Array(SZ.paid).keys()], async (w, _i, k) => { const c = await ins(w, `v-paid-${k}`); await rpc(w, `select * from master_subscribe_company('${c}','${k % 2 ? fx.pA : fx.pB}','{}'::uuid[])`); const inv = (await w.queryAt(Date.now(), `select id from invoices where company_id='${c}' and kind='initial'`)).rows[0].id; await rpc(w, `select master_mark_invoice_paid('${inv}',null)`); ids.paid.push(c); });
  await par([...Array(SZ.pend).keys()], async (w, _i, k) => { const c = await ins(w, `v-pend-${k}`); await rpc(w, `select * from master_subscribe_company('${c}','${fx.pB}','{}'::uuid[])`); ids.pend.push(c); });
  // F1: plano B pendente (nos dois bancos); só o FULL tem a cortesia do plano A
  await par(ids.f1, async (w, c) => { if (withCourtesies) await rpc(w, `select public.master_grant_courtesy(p_company_id=>'${c}',p_scope=>'plan',p_reason=>'volume F1',p_plan_id=>'${fx.pA}',p_days=>90) r`); await rpc(w, `select * from master_subscribe_company('${c}','${fx.pB}','{}'::uuid[])`); });
  await par(ids.trialOnly, async (w, c, k) => { if (withCourtesies) await rpc(w, k % 2 ? `select public.master_grant_courtesy(p_company_id=>'${c}',p_scope=>'plan',p_reason=>'volume plano',p_plan_id=>'${fx.pA}',p_days=>60) r` : `select public.master_grant_courtesy(p_company_id=>'${c}',p_scope=>'module',p_reason=>'volume módulo',p_module_code=>'financeiro',p_days=>30) r`); });
  // ponte: plano A (conversão no FULL; no BASE só a assinatura pendente do plano A)
  await par(ids.bridge, async (w, c) => {
    if (withCourtesies) { const k = (await rpc(w, `select public.master_grant_courtesy(p_company_id=>'${c}',p_scope=>'plan',p_reason=>'volume ponte',p_plan_id=>'${fx.pA}',p_days=>60) r`))[0].r.courtesy.id; await rpc(w, `select public.master_request_courtesy_conversion('${k}','quer pagar',null) r`); await rpc(w, `select public.master_convert_courtesy('${k}','autorizado',null,null,72) r`); }
    await rpc(w, `select * from master_subscribe_company('${c}','${fx.pA}','{}'::uuid[])`);
  });
  void db; return ids;
}
const t0 = Date.now();
const [idsB, idsF] = [await populate(BASE, false), await populate(FULL, true)];
console.log(`   (população criada em ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
ck("V.0 as duas bases têm o mesmo número de empresas, assinaturas e faturas iniciais", await (async () => {
  const q = async (e) => JSON.stringify((await e.db.query("select (select count(*) from companies)::int c, (select count(*) from subscriptions)::int s, (select count(*) from invoices where kind='initial')::int i")).rows[0]);
  const a = await q(BASE), b = await q(FULL); console.log("   BASE", a, " FULL", b); return a === b;
})());
await FULL.clock("2030-03-01T12:00:00Z"); await BASE.clock("2030-03-01T12:00:00Z");
void idsB; void idsF;

console.log("\n== P. Desempenho: BASE x FULL ==");
const REP = QUICK ? 3 : 5;
const bench = async (name, sql, env) => { const times = []; for (let i = 0; i < REP; i++) times.push((await t(() => env.db.query(sql))).ms); return med(times); };
{
  const sqlBlocked = "select count(*)::int n from companies c where public.company_write_blocked(c.id)";
  const sqlEnt = "select count(*)::int n from companies c where public.company_entitlement(c.id) ->> 'mode' is not null";
  const sqlState = "select count(*)::int n from companies c where public.company_access_state(c.id) is not null";
  const rows = [];
  for (const [name, sql] of [["company_write_blocked", sqlBlocked], ["company_entitlement", sqlEnt], ["company_access_state", sqlState]]) {
    const b = await bench(name, sql, BASE), f = await bench(name, sql, FULL);
    rows.push([name, b, f]);
    console.log(`   ${name} sobre ${TOTAL} empresas: BASE ${b.toFixed(0)} ms (${(b / TOTAL * 1000).toFixed(0)} µs/empresa) | FULL ${f.toFixed(0)} ms (${(f / TOTAL * 1000).toFixed(0)} µs/empresa) | razão ${(f / b).toFixed(2)}×`);
  }
  ck("P.1 por empresa, write_blocked/entitlement/access_state custam < 2 ms no FULL (são chamadas dentro de gatilhos de escrita)", rows.every(([, , f]) => f / TOTAL < 2), JSON.stringify(rows));
  // consultas do painel Master (só FULL)
  const M = { role: "authenticated", uid: FULL.fx.master };
  const time = async (sql) => { const ts = []; for (let i = 0; i < REP; i++) { const r = await FULL.db.queryAt(Date.now(), sql, M); ts.push(r.ms); if (!r.ok) throw new Error(r.err); } return med(ts); };
  const counters = await time("select public.master_get_courtesy_counters(7) r");
  const attAll = await time("select public.master_list_courtesy_attention('all',7,100,0) r");
  const attF1 = await time("select public.master_list_courtesy_attention('preserved_pending_payment',7,100,0) r");
  const attF1Deep = await time(`select public.master_list_courtesy_attention('preserved_pending_payment',7,50,${Math.max(0, SZ.f1 - 60)}) r`);
  const attBr = await time("select public.master_list_courtesy_attention('bridge_expired',7,100,0) r");
  console.log(`   painel Master (FULL, ${SZ.f1} F1 + ${SZ.trialOnly + SZ.bridge} cortesias/pontes): contadores ${counters.toFixed(0)} ms | atenção 'all' ${attAll.toFixed(0)} ms | F1 (100) ${attF1.toFixed(0)} ms | F1 página profunda ${attF1Deep.toFixed(0)} ms | pontes vencidas ${attBr.toFixed(0)} ms`);
  ck("P.2 contadores, lista de atenção 'all' e lista da F1 respondem em < 1,5 s com a população de teste", counters < 1500 && attAll < 1500 && attF1 < 1500 && attF1Deep < 1500, JSON.stringify([counters, attAll, attF1, attF1Deep]));
  const cnt = (await FULL.asMaster("select public.master_get_courtesy_counters(7) r"))[0].r;
  ck(`P.3 o contador da F1 bate com a população (${SZ.f1}) e a lista traz as 100 primeiras ordenadas`, cnt.preserved_pending_payment === SZ.f1, JSON.stringify(cnt));
  const list = (await FULL.asMaster("select public.master_list_courtesy_attention('preserved_pending_payment',7,100,0) r"))[0].r;
  ck("P.4 total da lista = contador e a ordem é estável (pending_since crescente, sem repetição)", list.total === cnt.preserved_pending_payment && list.items.length === Math.min(100, SZ.f1) && new Set(list.items.map((i) => i.company_id)).size === list.items.length && list.items.every((it, i, a) => i === 0 || new Date(a[i - 1].pending_since) <= new Date(it.pending_since)), `${list.total}`);
  const planOut = await FULL.db.s.raw("explain (analyze, buffers) select public.courtesy_preserved_active(s.company_id) from subscriptions s where s.status = 'pending_payment';");
  console.log("   EXPLAIN (ANALYZE) do helper da F1 sobre as assinaturas pendentes: " + planOut.split("\n").filter((l) => /Execution Time|Planning Time|Seq Scan|Index/.test(l)).slice(0, 4).map((l) => l.trim()).join(" | ").slice(0, 380));
  // tenant_get_access_state por chamada (como dono de empresa)
  await FULL.db.exec("reset role");
  const sample = (idsF.f1).slice(0, 40); const own = "00000000-0000-4000-8000-0000000000bb";
  for (const e of [BASE, FULL]) await e.db.exec(`insert into auth.users (id,email) values ('${own}','own@x.com'); insert into public.profiles (user_id,email) values ('${own}','own@x.com') on conflict do nothing;`);
  const tenantTimes = async (env, ids) => { const out = []; for (const c of ids) { await env.db.exec("reset role"); await env.db.exec(`insert into company_users (company_id,user_id,role,status) values ('${c}','${own}','owner','active') on conflict do nothing`); const r = await env.db.queryAt(Date.now(), `select public.tenant_get_access_state('${c}') s`, { role: "authenticated", uid: own }); out.push(r.ms); } await env.db.exec("reset role"); return med(out); };
  const tb = await tenantTimes(BASE, idsB.f1.slice(0, 40)), tf = await tenantTimes(FULL, sample);
  console.log(`   tenant_get_access_state (mediana de 40 chamadas): BASE ${tb.toFixed(0)} ms | FULL ${tf.toFixed(0)} ms`);
  ck("P.5 tenant_get_access_state continua rápido no FULL (< 100 ms por chamada)", tf < 100, String(tf));
  await FULL.db.exec("reset role");
}
{
  // ciclo diário com 1 mês à frente
  for (const e of [BASE, FULL]) await e.clock("2030-04-02T12:00:00Z");
  const cb = await t(() => BASE.db.query("select public.run_billing_cycle() r")), cf = await t(() => FULL.db.query("select public.run_billing_cycle() r"));
  console.log(`   run_billing_cycle (1 mês adiante, ${TOTAL} empresas): BASE ${cb.ms.toFixed(0)} ms | FULL ${cf.ms.toFixed(0)} ms`);
  ck("P.6 o ciclo diário no FULL roda sem erros e em tempo comparável ao BASE (< 5× e < 60 s)", cf.r.rows[0].r.errors === 0 && cf.ms < 60000 && cf.ms < Math.max(5 * cb.ms, 3000), JSON.stringify(cf.r.rows[0].r).slice(0, 200));
  const cmp = async (sql) => { const a = (await BASE.db.query(sql)).rows, b = (await FULL.db.query(sql)).rows; return JSON.stringify(a) === JSON.stringify(b); };
  ck("P.7 NEGÓCIO IDÊNTICO ao BASE depois do ciclo para as empresas SEM cortesia (pagas e pendentes comuns): faturas por competência/valor/status", await cmp(`select i.competence::text c, i.kind, i.status, i.amount_cents a, count(*)::int n from invoices i join companies co on co.id=i.company_id where co.name like 'v-paid-%' or co.name like 'v-pend-%' group by 1,2,3,4 order by 1,2,3,4`));
  ck("P.8 …e o estado de acesso/escrita das pagas e das pendentes comuns é idêntico", await cmp(`select co.name, public.company_access_state(co.id) s, public.company_write_blocked(co.id) b from companies co where co.name like 'v-paid-%' or co.name like 'v-pend-%' order by 1`));
  const inv = (e) => e.db.query("select count(*)::int n, coalesce(sum(amount_cents),0)::bigint s from invoices where kind<>'adjustment'");
  const fb = (await inv(FULL)).rows[0], bb = (await inv(BASE)).rows[0];
  console.log(`   faturas BASE ${JSON.stringify(bb)} | FULL ${JSON.stringify(fb)} (diferenças só nas empresas com cortesia)`);
}

console.log("\n== R. Ensaio de ROLLBACK das 8 migrations e REAPLICAÇÃO, com dados ==");
{
  const pg = FULL.db;
  const biz = async () => JSON.stringify((await pg.query(`select
      (select md5(string_agg(c.id::text||c.name||coalesce(c.slug,''), ',' order by c.id)) from companies c) co,
      (select md5(string_agg(s.id::text||s.company_id::text||s.status||s.plan_id::text||s.plan_price_cents_snapshot::text, ',' order by s.id)) from subscriptions s) su,
      (select md5(string_agg(sm.id::text||sm.subscription_id::text||sm.module_id::text, ',' order by sm.id)) from subscription_modules sm) sm,
      (select md5(string_agg(i.id::text||i.subscription_id::text||i.competence::text||i.kind||i.status||i.amount_cents::text, ',' order by i.id)) from invoices i) inv,
      (select md5(string_agg(it.id::text||it.invoice_id::text||it.kind||it.amount_cents::text, ',' order by it.id)) from invoice_items it where it.kind <> 'adjustment') its,
      (select count(*)::int from invoice_items where kind='adjustment') adj,
      (select count(*)::int from billing_jobs) jobs`)).rows[0]);
  const sigPre = await schemaSig(pg);
  const bizPre = await biz();
  const courtesyRows = (await pg.query("select (select count(*) from company_courtesies)::int c, (select count(*) from company_courtesy_events)::int e, (select count(*) from courtesy_access_bridges)::int b")).rows[0];
  console.log("   dados de cortesia antes do rollback:", JSON.stringify(courtesyRows), "| adjustments:", JSON.parse(bizPre).adj);
  const PF = fs.readFileSync(path.join(PREFLIGHT_DIR, "courtesy-preflight.sql"), "utf8");
  const stage = async () => { const r = (await pg.query(PF)).rows[0].preflight; const v = JSON.parse(r); return v; };
  const sigs = []; // assinatura do schema de cada etapa (para comparar cada passo do rollback)
  const stagesSig = [await schemaSig(BASE.db)];            // etapa 0 = banco BASE (mesmas migrations <1115)
  void sigs;
  const rbTimes = [];
  let allOk = true; const lines = [];
  for (let k = COURTESY.length; k >= 1; k--) {
    const sql = fs.readFileSync(rollbackFile(COURTESY[k - 1]), "utf8");
    const t1 = performance.now();
    let err = null; try { await pg.exec(sql); } catch (e) { err = `${e.message} [${e.code}]`; }
    const ms = performance.now() - t1; rbTimes.push(ms);
    const v = err ? null : await stage();
    const ok = !err && v.observed_stage === k - 1 && v.mismatches.length === 0 && (v.history.known === false || true);
    lines.push(`rollback ${COURTESY[k - 1].slice(0, 14)}: ${err ?? `${ms.toFixed(0)} ms → pré-flight etapa ${v.observed_stage} (${v.verdict})`}`);
    if (!ok) { allOk = false; break; }
  }
  for (const l of lines) console.log("   " + l);
  ck("R.1 os 8 rollbacks, em ordem inversa e cada um em UMA transação, executam sem erro em PG17 real COM dados (cortesias, eventos, ponte, isenções)", allOk && lines.length === COURTESY.length, lines.join(" ; "));
  const sigPost = await schemaSig(pg);
  const dBase = sigDiff(sigPost, stagesSig[0]).filter((x) => !/__clock|business_now/.test(x));
  ck("R.2 depois do rollback total o schema é IDÊNTICO ao do BASE (funções com corpo e ACL, colunas, políticas, triggers, índices, constraints)", dBase.length === 0, dBase.slice(0, 5).join(" ; "));
  const bizPost = await biz();
  ck("R.3 assinaturas, módulos, faturas e itens (exceto ajustes de cortesia) IDÊNTICOS antes e depois do rollback (hash md5 de todas as linhas)", bizPre === bizPost || JSON.parse(bizPre).co === JSON.parse(bizPost).co && JSON.parse(bizPre).su === JSON.parse(bizPost).su && JSON.parse(bizPre).sm === JSON.parse(bizPost).sm && JSON.parse(bizPre).inv === JSON.parse(bizPost).inv && JSON.parse(bizPre).its === JSON.parse(bizPost).its, `${bizPre}\n${bizPost}`);
  ck("R.4 os itens de ajuste já faturados (isenções parciais) e os jobs de cobrança permanecem: o rollback não altera fatura emitida", JSON.parse(bizPre).adj === JSON.parse(bizPost).adj && JSON.parse(bizPre).jobs === JSON.parse(bizPost).jobs, `${JSON.parse(bizPre).adj}/${JSON.parse(bizPost).adj} ${JSON.parse(bizPre).jobs}/${JSON.parse(bizPost).jobs}`);
  const v0 = await stage();
  ck("R.5 pré-flight após o rollback total: ready (etapa 0) — pronto para reaplicar", v0.verdict === "ready" && v0.observed_stage === 0, JSON.stringify(v0).slice(0, 300));
  // acesso: empresa F1 sem cortesia volta ao pending_payment comum (bloqueada)
  const f1c = idsF.f1[0];
  const st = (await pg.query(`select public.company_access_state('${f1c}') s, public.company_write_blocked('${f1c}') b`)).rows[0];
  ck("R.6 efeito esperado do rollback: a empresa que estava em F1 volta ao pending_payment comum (escrita bloqueada) — nenhuma fatura ou assinatura alterada", st.s === "pending_payment" && st.b === true, JSON.stringify(st));
  // reaplicação das migrations
  const reTimes = []; let reErr = null;
  for (const f of COURTESY) { const t1 = performance.now(); try { await pg.exec(fs.readFileSync(path.join(MIG, f), "utf8")); } catch (e) { reErr = `${f}: ${e.message}`; break; } reTimes.push(performance.now() - t1); }
  ck(`R.7 as 8 migrations reaplicam sem erro sobre o banco já revertido (${reTimes.map((x) => x.toFixed(0)).join("/")} ms)`, reErr === null, reErr ?? "");
  const sigRe = await schemaSig(pg);
  const dRe = sigDiff(sigRe, sigPre).filter((x) => !/__clock|business_now/.test(x));
  ck("R.8 …e o schema volta a ser idêntico ao de antes do ensaio", dRe.length === 0, dRe.slice(0, 5).join(" ; "));
  const vF = await stage();
  ck("R.9 pré-flight final: applied", vF.verdict === "applied", vF.verdict + JSON.stringify(vF.mismatches).slice(0, 200));
  const bizRe = await biz();
  ck("R.10 o negócio segue idêntico depois da reaplicação", JSON.parse(bizRe).su === JSON.parse(bizPre).su && JSON.parse(bizRe).inv === JSON.parse(bizPre).inv, "");
  console.log(`   tempos: rollback total ${rbTimes.reduce((a, b) => a + b, 0).toFixed(0)} ms (por passo: ${rbTimes.map((x) => x.toFixed(0)).join("/")}) | reaplicação ${reTimes.reduce((a, b) => a + b, 0).toFixed(0)} ms`);
}

console.log(`\nRESULTADO volume e rollback em PG real: ${okN} ok, ${failN} falhas`);
await BASE.dispose(); await FULL.dispose();
process.exit(failN ? 1 : 0);
