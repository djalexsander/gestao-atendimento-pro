// Etapa 6 / itens 4 e 5: TRANSAÇÕES SIMULTÂNEAS em PostgreSQL 17 REAL (local e descartável), com conexões independentes (um backend por worker),
// largada sincronizada no relógio do SERVIDOR (pg_sleep até T0), contador real de deadlocks (pg_stat_database), espera de locks registrada e
// invariantes globais depois de cada cenário. Nada toca Asaas/webhook: o pagamento é simulado com master_mark_invoice_paid no banco descartável.
//   HOMOLOG_REAL=1 node scripts/courtesies/homolog/concurrency.mjs [--quick]
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COURTESY, MIG, rollbackFile, schemaSig, sigDiff, stageDir } from "../lib.mjs";
import { loadAllRealDb } from "./concurrency-lib.mjs";

const QUICK = process.argv.includes("--quick");
const N = QUICK ? 6 : 25;                        // repetições por cenário de corrida
const { db, workers, clock, fx, run, inv, deadlocks, dispose } = await loadAllRealDb(8);

let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : "  >> " + extra}`); cond ? okN++ : failN++; };
const stat = (a) => (a.length ? `min ${Math.min(...a)} / méd ${Math.round(a.reduce((x, y) => x + y, 0) / a.length)} / máx ${Math.max(...a)} ms` : "—");
const uuid = () => crypto.randomUUID();
const report = [];

const dl0 = await deadlocks();
await clock("2030-03-01T12:00:00Z");

// ---- corrida genérica -----------------------------------------------------------------------------------------------------------
async function race(name, n, setup, ops, check) {
  const lat = [], outcomes = {}; let viol = 0, firstBad = null;
  for (let i = 0; i < n; i++) {
    const ctx = await setup(i);
    const t0 = Date.now() + 700;
    const res = await Promise.all(ops.map((op, w) => workers[w].queryAt(t0, typeof op.sql === "function" ? op.sql(ctx) : op.sql, op.as)));
    for (const r of res) lat.push(r.ms);
    const key = res.map((r) => (r.ok ? "ok" : "err:" + (r.code ?? "?"))).join(" + ");
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    const bad = await check(ctx, res);
    if (bad) { viol++; firstBad ??= bad; }
  }
  report.push({ name, n, outcomes, lat: stat(lat), viol });
  ck(`${name}: ${n} corridas, ${viol} violações de invariante`, viol === 0, firstBad ?? "");
  console.log(`   resultados: ${Object.entries(outcomes).map(([k, v]) => `${k} ×${v}`).join(" | ")}  |  latência ${stat(lat)}`);
  return { outcomes, viol };
}

const grant = (c, plan, rid, days = 30) => `select public.master_grant_courtesy(p_company_id=>'${c}',p_scope=>'plan',p_reason=>'corrida de teste',p_plan_id=>'${plan}',p_days=>${days},p_request_id=>${rid ? `'${rid}'` : "null"}) r`;
const extend = (k, rid) => `select public.master_extend_courtesy(p_courtesy_id=>'${k}',p_reason=>'prorrogar na corrida',p_days=>30,p_request_id=>${rid ? `'${rid}'` : "null"}) r`;
const endC = (k, rid) => `select public.master_end_courtesy('${k}','encerrar na corrida'${rid ? `,'${rid}'` : ""}) r`;
const MASTER = { role: "authenticated", uid: fx.master };

console.log("== 1. Concessão x concessão (mesma empresa) ==");
await race("1a grant x grant (mesma chave de idempotência)", N, async () => ({ c: await fx.company(), rid: uuid() }), [
  { sql: (x) => grant(x.c, fx.pA, x.rid), as: MASTER }, { sql: (x) => grant(x.c, fx.pA, x.rid), as: MASTER }],
  async (x, res) => {
    const open = await inv.q(`select count(*)::int n from company_courtesies where company_id='${x.c}'`);
    const ev = await inv.q(`select count(*)::int n from company_courtesy_events e join company_courtesies c on c.id=e.courtesy_id where c.company_id='${x.c}' and e.event_type='granted'`);
    return open[0].n === 1 && ev[0].n === 1 && res.every((r) => r.ok) ? null : `cortesias=${open[0].n} eventos granted=${ev[0].n} ${JSON.stringify(res.map((r) => r.err))}`;
  });
await race("1b grant x grant (chaves diferentes, mesmo plano)", N, async () => ({ c: await fx.company() }), [
  { sql: (x) => grant(x.c, fx.pA, uuid()), as: MASTER }, { sql: (x) => grant(x.c, fx.pA, uuid()), as: MASTER }, { sql: (x) => grant(x.c, fx.pA, uuid()), as: MASTER }],
  async (x) => {
    const open = await inv.q(`select count(*)::int n from company_courtesies where company_id='${x.c}' and status in ('active','expired_pending_decision')`);
    return open[0].n === 1 ? null : `abertas=${open[0].n}`;
  });

console.log("\n== 2. Prorrogação x encerramento ==");
await race("2 extend x end (mesma cortesia)", N, async () => { const c = await fx.company(); const k = await fx.courtesy(c, fx.pA); return { c, k }; }, [
  { sql: (x) => extend(x.k), as: MASTER }, { sql: (x) => endC(x.k), as: MASTER }],
  async (x, res) => {
    const row = (await inv.q(`select status from company_courtesies where id='${x.k}'`))[0];
    const ev = Object.fromEntries((await inv.q(`select event_type t, count(*)::int n from company_courtesy_events where courtesy_id='${x.k}' group by 1`)).map((r) => [r.t, r.n]));
    const endedOk = res[1].ok;
    if (endedOk !== (row.status === "ended")) return `status=${row.status} mas end.ok=${endedOk}`;
    if ((ev.ended ?? 0) !== (endedOk ? 1 : 0)) return `eventos ended=${ev.ended ?? 0}`;
    if ((ev.extended ?? 0) !== (res[0].ok ? 1 : 0)) return `eventos extended=${ev.extended ?? 0} com extend.ok=${res[0].ok}`;
    return null;
  });

console.log("\n== 3. Contratação x contratação (conversão e ponte) ==");
await race("3a subscribe x subscribe (cortesia autorizada para conversão: 1 assinatura, 1 fatura inicial, no máx. 1 ponte)", N, async () => {
  const c = await fx.company(); const k = await fx.courtesy(c, fx.pA, 60);
  await fx.authorizeConversion(k); return { c, k };
}, [{ sql: (x) => `select * from master_subscribe_company('${x.c}','${fx.pA}','{}'::uuid[])`, as: MASTER }, { sql: (x) => `select * from master_subscribe_company('${x.c}','${fx.pA}','{}'::uuid[])`, as: MASTER }],
  async (x) => {
    const subs = (await inv.q(`select count(*)::int n from subscriptions where company_id='${x.c}' and status<>'canceled'`))[0].n;
    const invs = (await inv.q(`select count(*)::int n from invoices where company_id='${x.c}' and kind='initial'`))[0].n;
    const br = (await inv.q(`select count(*)::int n from courtesy_access_bridges where company_id='${x.c}'`))[0].n;
    const conv = (await inv.q(`select count(*)::int n from company_courtesy_events where courtesy_id='${x.k}' and event_type='converted'`))[0].n;
    return subs === 1 && invs === 1 && br === 1 && conv === 1 ? null : `subs=${subs} inicial=${invs} pontes=${br} convertido=${conv}`;
  });
await race("3b subscribe(plano da cortesia) x end courtesy", N, async () => {
  const c = await fx.company(); const k = await fx.courtesy(c, fx.pA, 60); await fx.authorizeConversion(k); return { c, k };
}, [{ sql: (x) => `select * from master_subscribe_company('${x.c}','${fx.pA}','{}'::uuid[])`, as: MASTER }, { sql: (x) => endC(x.k), as: MASTER }],
  async (x) => {
    const k = (await inv.q(`select status from company_courtesies where id='${x.k}'`))[0].status;
    const br = (await inv.q(`select count(*)::int n from courtesy_access_bridges where company_id='${x.c}'`))[0].n;
    const unblocked = (await inv.q(`select public.company_write_blocked('${x.c}') b`))[0].b === false;
    // ponte só existe com cortesia CONVERTIDA; cortesia encerrada nunca deixa a empresa liberada
    if (br > 1) return `pontes=${br}`;
    if (br === 1 && k !== "converted") return `ponte com cortesia ${k}`;
    if (k === "ended" && unblocked) return "cortesia encerrada e empresa liberada";
    return null;
  });
await race("3c subscribe plano B (F1) x end courtesy", N, async () => { const c = await fx.company(); const k = await fx.courtesy(c, fx.pA, 60); return { c, k }; },
  [{ sql: (x) => `select * from master_subscribe_company('${x.c}','${fx.pB}','{}'::uuid[])`, as: MASTER }, { sql: (x) => endC(x.k), as: MASTER }],
  async (x) => {
    const k = (await inv.q(`select status from company_courtesies where id='${x.k}'`))[0].status;
    const blocked = (await inv.q(`select public.company_write_blocked('${x.c}') b`))[0].b;
    const state = (await inv.q(`select public.company_access_state('${x.c}') s`))[0].s;
    if (k === "ended" && state === "pending_payment" && blocked === false) return "F1 ativa com a cortesia encerrada";
    if (k === "active" && state === "pending_payment" && blocked === true) return "F1 deveria estar liberada (cortesia aberta, B pendente)";
    return null;
  });

await race("3d convert(authorize) x convert(authorize) (idempotência da autorização)", N, async () => { const c = await fx.company(); const k = await fx.courtesy(c, fx.pA, 60); return { c, k }; },
  [{ sql: (x) => `select public.master_convert_courtesy('${x.k}','autorização A',null,null,72) r`, as: MASTER }, { sql: (x) => `select public.master_convert_courtesy('${x.k}','autorização B',null,null,48) r`, as: MASTER }],
  async (x) => {
    const ev = (await inv.q(`select count(*)::int n from company_courtesy_events where courtesy_id='${x.k}' and event_type='conversion_authorized'`))[0].n;
    const st = (await inv.q(`select status, conversion_bridge_hours h from company_courtesies where id='${x.k}'`))[0];
    return ev === 1 && st.status === "active" && [72, 48].includes(st.h) ? null : `autorizações=${ev} status=${st.status} horas=${st.h}`;
  });
await race("3e request x authorize (pedido e autorização da mesma cortesia)", N, async () => { const c = await fx.company(); const k = await fx.courtesy(c, fx.pA, 60); return { c, k }; },
  [{ sql: (x) => `select public.master_request_courtesy_conversion('${x.k}','quer pagar',null) r`, as: MASTER }, { sql: (x) => `select public.master_convert_courtesy('${x.k}','autorizado',null,null,72) r`, as: MASTER }],
  async (x) => {
    const ev = Object.fromEntries((await inv.q(`select event_type t, count(*)::int n from company_courtesy_events where courtesy_id='${x.k}' group by 1`)).map((r) => [r.t, r.n]));
    return (ev.conversion_requested ?? 0) <= 1 && (ev.conversion_authorized ?? 0) === 1 ? null : JSON.stringify(ev);
  });

console.log("\n== 4. Pagamento simulado ==");
await race("4a pay x pay (mesma fatura inicial)", N, async () => { const c = await fx.company(); await fx.subscribe(c, fx.pB); return { c, i: await fx.initialInvoice(c) }; },
  [{ sql: (x) => `select master_mark_invoice_paid('${x.i}',null) r`, as: MASTER }, { sql: (x) => `select master_mark_invoice_paid('${x.i}',null) r`, as: MASTER }],
  async (x) => {
    const st = (await inv.q(`select s.status, i.status ist, (select count(*)::int from subscription_events e where e.subscription_id=s.id and e.event_type ilike '%activ%') ac, (select count(*)::int from invoice_events e where e.invoice_id=i.id and e.event_type ilike '%paid%') pe from subscriptions s join invoices i on i.subscription_id=s.id where s.company_id='${x.c}' and i.kind='initial'`))[0];
    return st.status === "active" && st.ist === "paid" && st.ac <= 1 && st.pe <= 1 ? null : JSON.stringify(st);
  });
await race("4b pay (plano B) x end courtesy (F1)", N, async () => { const c = await fx.company(); const k = await fx.courtesy(c, fx.pA, 60); await fx.subscribe(c, fx.pB); return { c, k, i: await fx.initialInvoice(c) }; },
  [{ sql: (x) => `select master_mark_invoice_paid('${x.i}',null) r`, as: MASTER }, { sql: (x) => endC(x.k), as: MASTER }],
  async (x) => {
    const s = (await inv.q(`select status from subscriptions where company_id='${x.c}'`))[0].status;
    const state = (await inv.q(`select public.company_access_state('${x.c}') s`))[0].s;
    const modes = (await inv.q(`select public.company_entitlement('${x.c}')->>'mode' m`))[0].m;
    return s === "active" && state === "active" && modes === "subscription" ? null : `sub=${s} estado=${state} modo=${modes}`;
  });

console.log("\n== 5. Ciclo de cobrança x ciclo / Master (vencimento e reconciliação) ==");
await race("5a run_billing_cycle x run_billing_cycle x master_reconcile_courtesies (cortesias vencidas)", Math.max(4, Math.floor(N / 3)), async () => {
  await clock("2030-03-01T12:00:00Z");
  const cs = []; for (let i = 0; i < 6; i++) { const c = await fx.company(); cs.push({ c, k: await fx.courtesy(c, fx.pA, 30) }); }
  await clock("2030-05-01T12:00:00Z"); return { cs };
}, [{ sql: "select public.run_billing_cycle() r" }, { sql: "select public.run_billing_cycle() r" }, { sql: "select public.master_reconcile_courtesies() r", as: MASTER }],
  async (x) => {
    for (const { k } of x.cs) {
      const row = (await inv.q(`select status from company_courtesies where id='${k}'`))[0].status;
      const exp = (await inv.q(`select count(*)::int n from company_courtesy_events where courtesy_id='${k}' and event_type='expired'`))[0].n;
      if (row !== "expired_pending_decision" || exp !== 1) return `cortesia ${row}, eventos expired=${exp}`;
    }
    return null;
  });
await clock("2030-03-01T12:00:00Z");
await race("5b ciclo x (grant, extend, end) em empresas diferentes (varredura longa x operações do Master)", Math.max(4, Math.floor(N / 3)), async () => {
  const cs = []; for (let i = 0; i < 4; i++) { const c = await fx.company(); cs.push({ c, k: await fx.courtesy(c, fx.pA, 90) }); }
  return { cs, fresh: await fx.company() };
}, [{ sql: "select public.run_billing_cycle() r" }, { sql: (x) => extend(x.cs[0].k), as: MASTER }, { sql: (x) => endC(x.cs[1].k), as: MASTER }, { sql: (x) => grant(x.fresh, fx.pA, null), as: MASTER }],
  async () => null);

console.log("\n== 6. SKIP LOCKED determinístico ==");
{
  await clock("2030-03-01T12:00:00Z");
  const c = await fx.company(); const k = await fx.courtesy(c, fx.pA, 30);
  await clock("2030-05-01T12:00:00Z");
  const holder = workers[7];
  await holder.exec("begin"); await holder.query(`select id from company_courtesies where id='${k}' for update`);
  const t0 = Date.now();
  const r = await workers[0].queryAt(Date.now(), "select public.master_reconcile_courtesies() r", MASTER);
  const tSkip = Date.now() - t0;
  const rc = await workers[1].queryAt(Date.now(), "select public.run_billing_cycle() r");
  const stillOpen = (await inv.q(`select status from company_courtesies where id='${k}'`))[0].status;
  ck(`6.1 com a linha travada por outra transação, reconcile e ciclo NÃO esperam (reconcile ${tSkip} ms, ciclo ${rc.ms} ms) e pulam a cortesia`, r.ok && rc.ok && tSkip < 1500 && rc.ms < 1500 && stillOpen === "active", `${tSkip} ${rc.ms} ${stillOpen} ${r.err} ${rc.err}`);
  await holder.exec("commit");
  const r2 = await workers[0].queryAt(Date.now(), "select public.master_reconcile_courtesies() r", MASTER);
  const after = (await inv.q(`select status from company_courtesies where id='${k}'`))[0].status;
  const exp = (await inv.q(`select count(*)::int n from company_courtesy_events where courtesy_id='${k}' and event_type='expired'`))[0].n;
  ck("6.2 liberada a trava, o próximo reconcile processa a cortesia (1 evento expired; nada se perde)", r2.ok && after === "expired_pending_decision" && exp === 1, `${after} ${exp}`);
  // Master que pega a mesma linha enquanto o ciclo a segura: o Master ESPERA (não pula) e depois vê o estado coerente
  await clock("2030-03-01T12:00:00Z");
  const c2 = await fx.company(); const k2 = await fx.courtesy(c2, fx.pA, 90);
  await holder.exec("begin"); await holder.query(`select id from company_courtesies where id='${k2}' for update`);
  const tStart = Date.now(); const pend = workers[2].queryAt(Date.now(), endC(k2), MASTER);
  await new Promise((r2_) => setTimeout(r2_, 900)); await holder.exec("commit");
  const re = await pend;
  ck(`6.3 o Master que quer encerrar a mesma cortesia ESPERA a transação que a segura (${re.ms} ms) e depois conclui`, re.ok && re.ms >= 800, `${re.ok} ${re.ms} ${re.err}`);
}

console.log("\n== 7. Varredura aleatória (4 workers, operações misturadas) ==");
{
  await clock("2030-03-01T12:00:00Z");
  const cs = []; for (let i = 0; i < 10; i++) { const c = await fx.company(); cs.push({ c, k: i % 2 ? await fx.courtesy(c, fx.pA, 60) : null }); }
  const iters = QUICK ? 20 : 60; const lat = []; let errs = 0, oks = 0; const kinds = {};
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const one = async (w) => {
    for (let i = 0; i < iters; i++) {
      const x = pick(cs); const kind = pick(["grant", "extend", "end", "request", "authorize", "subscribeA", "subscribeB", "pay", "cycle", "reconcile", "read"]);
      let sql = null, as = MASTER;
      const kk = (await inv.q(`select id from company_courtesies where company_id='${x.c}' order by created_at desc limit 1`))[0]?.id;
      if (kind === "grant") sql = grant(x.c, fx.pA, null, 30);
      else if (kind === "extend" && kk) sql = extend(kk);
      else if (kind === "end" && kk) sql = endC(kk);
      else if (kind === "request" && kk) sql = `select public.master_request_courtesy_conversion('${kk}','pedido na varredura',null) r`;
      else if (kind === "authorize" && kk) sql = `select public.master_convert_courtesy('${kk}','autorizado na varredura',null,null,72) r`;
      else if (kind === "subscribeA") sql = `select * from master_subscribe_company('${x.c}','${fx.pA}','{}'::uuid[])`;
      else if (kind === "subscribeB") sql = `select * from master_subscribe_company('${x.c}','${fx.pB}','{}'::uuid[])`;
      else if (kind === "pay") { const ii = (await inv.q(`select id from invoices where company_id='${x.c}' and kind='initial' and status in ('open','overdue') limit 1`))[0]?.id; if (ii) sql = `select master_mark_invoice_paid('${ii}',null) r`; }
      else if (kind === "cycle") { sql = "select public.run_billing_cycle() r"; as = undefined; }
      else if (kind === "reconcile") sql = "select public.master_reconcile_courtesies() r";
      else if (kind === "read") { sql = `select public.master_list_courtesy_attention('all',7,50,0) r`; }
      if (!sql) continue;
      const r = await workers[w].queryAt(Date.now(), sql, as);
      lat.push(r.ms); kinds[kind] = (kinds[kind] ?? 0) + 1; r.ok ? oks++ : errs++;
    }
  };
  const t0 = Date.now(); await Promise.all([0, 1, 2, 3].map(one)); const dt = Date.now() - t0;
  console.log(`   ${oks + errs} operações em ${dt} ms (${oks} ok, ${errs} recusadas pelas regras); latência ${stat(lat)}; mix ${JSON.stringify(kinds)}`);
  report.push({ name: "7 varredura aleatória", n: oks + errs, lat: stat(lat), viol: 0 });
  ck("7.1 a varredura termina sem travar (sem erro de conexão/timeout)", oks + errs > 0);
}

console.log("\n== 8. Invariantes globais (depois de TODAS as corridas) ==");
{
  const checks = {
    "8.1 nenhuma empresa com 2 cortesias abertas do mesmo item": "select count(*)::int n from (select company_id, item_key from company_courtesies where status in ('active','expired_pending_decision') group by 1,2 having count(*)>1) t",
    "8.2 nenhuma empresa com 2 assinaturas vigentes": "select count(*)::int n from (select company_id from subscriptions where status<>'canceled' group by 1 having count(*)>1) t",
    "8.3 nenhuma fatura duplicada (assinatura, competência, tipo) — COBRANÇA DUPLICADA": "select count(*)::int n from (select subscription_id, competence, kind from invoices where status<>'void' group by 1,2,3 having count(*)>1) t",
    "8.4 no máximo 1 fatura inicial por assinatura": "select count(*)::int n from (select subscription_id from invoices where kind='initial' and status<>'void' group by 1 having count(*)>1) t",
    "8.5 no máximo 1 ponte por assinatura e toda ponte pertence a cortesia convertida": "select (select count(*) from (select subscription_id from courtesy_access_bridges group by 1 having count(*)>1) t)::int + (select count(*) from courtesy_access_bridges b join company_courtesies c on c.id=b.courtesy_id where c.status<>'converted')::int n",
    "8.6 cortesia convertida sempre aponta para uma assinatura existente": "select count(*)::int n from company_courtesies c where c.status='converted' and (c.converted_subscription_id is null or not exists (select 1 from subscriptions s where s.id=c.converted_subscription_id))",
    "8.7 cada cortesia tem exatamente 1 evento 'granted'": "select count(*)::int n from company_courtesies c where (select count(*) from company_courtesy_events e where e.courtesy_id=c.id and e.event_type='granted') <> 1",
    "8.8 cortesia encerrada tem exatamente 1 evento 'ended'; convertida, 1 'converted'; vencida materializada, 1 'expired'": "select count(*)::int n from company_courtesies c where (c.status='ended' and (select count(*) from company_courtesy_events e where e.courtesy_id=c.id and e.event_type='ended')<>1) or (c.status='converted' and (select count(*) from company_courtesy_events e where e.courtesy_id=c.id and e.event_type='converted')<>1) or ((select count(*) from company_courtesy_events e where e.courtesy_id=c.id and e.event_type='expired')>1)",
    "8.9 DESBLOQUEIO INDEVIDO: nenhuma empresa com escrita liberada em estado bloqueado, exceto pending_payment com ponte ativa ou F1": "select count(*)::int n from companies co where public.company_write_blocked(co.id)=false and public.company_access_state(co.id) in ('restricted','suspended','canceled','trial_expired','trial_canceled')",
    "8.10 pending_payment liberado só com ponte ativa XOR F1 (nunca os dois, nunca nenhum)": "select count(*)::int n from companies co where public.company_access_state(co.id)='pending_payment' and public.company_write_blocked(co.id)=false and not (public.courtesy_bridge_active(co.id) <> public.courtesy_preserved_active(co.id))",
    "8.11 nenhuma assinatura ativa sem fatura inicial paga": "select count(*)::int n from subscriptions s where s.status='active' and not exists (select 1 from invoices i where i.subscription_id=s.id and i.kind='initial' and i.status='paid')",
    "8.12 ordem dos eventos: nada depois de 'ended'/'converted' além de histórico": "select count(*)::int n from company_courtesy_events e join company_courtesies c on c.id=e.courtesy_id where c.status='ended' and e.event_type in ('extended','conversion_authorized','converted') and e.seq > (select min(seq) from company_courtesy_events x where x.courtesy_id=c.id and x.event_type='ended')",
  };
  for (const [name, sql] of Object.entries(checks)) { const r = await inv.q(sql); ck(name, r[0].n === 0, `${r[0].n} violações`); }
}

console.log("\n== 9. Deadlocks ==");
{
  const dl1 = await deadlocks();
  ck(`9.1 contador real de deadlocks do servidor: antes ${dl0}, depois ${dl1} (zero novos)`, dl1 === dl0, `${dl1 - dl0} novos`);
  let logs = ""; { const r = spawnSync("docker", ["logs", "--since", "3h", "courtesy-homolog-pg"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); logs = (r.stdout ?? "") + (r.stderr ?? ""); }
  const dead = (logs.match(/deadlock detected/g) ?? []).length;
  const waits = (logs.match(/still waiting for|acquired .* after/g) ?? []).length; const waitSamples = logs.split("\n").filter((l) => /still waiting for|acquired .* after/.test(l)).slice(0, 4).map((l) => l.slice(0, 200)); for (const w of waitSamples) console.log("   espera de lock: " + w);
  ck(`9.2 o log do PostgreSQL não registra "deadlock detected" (${dead}) — esperas de lock registradas: ${waits}`, dead === 0, `${dead}`);
}

console.log("\n== 10. ROLLBACK e REAPLICAÇÃO sob concorrência ==");
{
  await clock("2030-03-01T12:00:00Z");
  const own = "00000000-0000-4000-8000-0000000000cc";
  const c1 = await fx.company(); const k1 = await fx.courtesy(c1, fx.pA, 90); await fx.subscribe(c1, fx.pB);       // empresa em F1
  await db.exec(`insert into auth.users (id,email) values ('${own}','own@x.com'); insert into public.profiles (user_id,email) values ('${own}','own@x.com') on conflict do nothing; insert into company_users (company_id,user_id,role,status) values ('${c1}','${own}','owner','active');`);
  const OWN = { role: "authenticated", uid: own };
  const sub = (await inv.q("select count(*)::int s, md5(string_agg(id::text||status||plan_id::text, ',' order by id)) h from subscriptions"))[0];
  const inv0 = (await inv.q("select count(*)::int n, md5(string_agg(id::text||status||amount_cents::text, ',' order by id)) h from invoices"))[0];
  const rbSql = (k) => fs.readFileSync(rollbackFile(COURTESY[k - 1]), "utf8");
  const miSql = (k) => fs.readFileSync(path.join(MIG, COURTESY[k - 1]), "utf8");
  const sigBefore = await schemaSig(db);
  const stats = { ok: 0, err: 0, errs: {}, withFields: 0, withoutFields: 0, blockedTrue: 0, blockedFalse: 0 }; let stop = false;
  const reader = async (w) => {
    while (!stop) {
      const r1 = await workers[w].queryAt(Date.now(), `select public.tenant_get_access_state('${c1}') s`, OWN);
      const r2 = await workers[w].queryAt(Date.now(), "select public.master_list_courtesy_attention('all',7,20,0) r", MASTER);
      for (const r of [r1, r2]) { if (r.ok) stats.ok++; else { stats.err++; const key = (r.code ?? "?") + ":" + String(r.err).slice(0, 60); stats.errs[key] = (stats.errs[key] ?? 0) + 1; } }
      if (r1.ok) { const st = r1.rows[0].s; if ("courtesy_preserved" in st) stats.withFields++; else stats.withoutFields++; st.write_blocked ? stats.blockedTrue++ : stats.blockedFalse++; }
    }
  };
  const readers = [0, 1, 2].map((w) => reader(w));
  const writer = async () => {
    const wk = workers[3];
    await wk.exec("reset role");
    // 1) rollback das duas últimas migrations numa transação que SEGURA os locks por 700 ms
    await wk.exec("begin"); await wk.exec(rbSql(8)); await wk.exec(rbSql(7)); await wk.query("select pg_sleep(0.7)"); await wk.exec("commit");
    await new Promise((r) => setTimeout(r, 400));
    // 2) reaplica 1121 e 1122 também segurando os locks
    await wk.exec("begin"); await wk.exec(miSql(7)); await wk.exec(miSql(8)); await wk.query("select pg_sleep(0.7)"); await wk.exec("commit");
    await new Promise((r) => setTimeout(r, 400));
  };
  const tW = Date.now(); await writer(); const dtW = Date.now() - tW; stop = true; await Promise.all(readers);
  console.log(`   leituras durante rollback/reaplicação (${dtW} ms): ${stats.ok} ok, ${stats.err} erros ${JSON.stringify(stats.errs)}; tenant com campos novos ${stats.withFields} / sem ${stats.withoutFields}; escrita liberada ${stats.blockedFalse} / bloqueada ${stats.blockedTrue}`);
  const transient = Object.entries(stats.errs).filter(([k]) => /^XX000:cache lookup failed for function/.test(k)).reduce((a, [, v]) => a + v, 0);
  const other = stats.err - transient;
  ck(`10.1 leituras concorrentes durante rollback/reaplicação: nenhum erro de dado/permissão (${other}); erros transitórios "cache lookup failed for function" (chamada em voo quando o DROP FUNCTION do rollback comita) = ${transient} de ${stats.ok + stats.err} (${((transient / (stats.ok + stats.err)) * 100).toFixed(2)}%) — ACHADO DE MOTOR REAL: faça rollback em janela de manutenção`, other === 0 && stats.ok > 20 && transient / (stats.ok + stats.err) < 0.02, JSON.stringify(stats.errs));
  ck("10.2 durante todo o ensaio os leitores veem as DUAS formas válidas (com e sem courtesy_preserved) e a F1 continua coerente quando presente", stats.withFields > 0 && stats.withoutFields > 0, JSON.stringify(stats));
  const sigAfter = await schemaSig(db);
  const d = sigDiff(sigAfter, sigBefore);
  ck("10.3 depois de rollback + reaplicação das duas últimas migrations o schema é idêntico ao inicial", d.length === 0, d.slice(0, 4).join(" ; "));
  // rollback TOTAL com operações do Master em andamento (grants): sem travar, sem corromper, sem perder fatura/assinatura
  const w0 = workers[4], w1 = workers[5];
  await w0.exec("reset role");
  const fresh = []; for (let i = 0; i < 12; i++) fresh.push(await fx.company());
  let grantsOk = 0, grantsErr = 0, stopG = false;
  const granter = async () => { let i = 0; while (!stopG) { const r = await w1.queryAt(Date.now(), grant(fresh[i % fresh.length], fx.pA, uuid(), 30), MASTER); r.ok ? grantsOk++ : grantsErr++; i++; await new Promise((r2) => setTimeout(r2, 20)); } };
  const g = granter();
  await new Promise((r) => setTimeout(r, 200));
  const tR = Date.now(); let rbErr = null;
  try { for (let k = 8; k >= 1; k--) { await w0.exec("begin"); await w0.exec(rbSql(k)); await w0.exec("commit"); } } catch (e) { rbErr = e.message; await w0.exec("rollback").catch(() => {}); }
  const dtR = Date.now() - tR;
  stopG = true; await g;
  console.log(`   rollback total (8 passos) com 1 gerador de cortesias ativo: ${dtR} ms; concessões concluídas ${grantsOk}, recusadas ${grantsErr}`);
  ck("10.4 rollback total concluído SEM erro e sem travar mesmo com concessões do Master em andamento", rbErr === null && dtR < 15000, String(rbErr));
  const subAfter = (await inv.q("select count(*)::int s, md5(string_agg(id::text||status||plan_id::text, ',' order by id)) h from subscriptions"))[0];
  const invAfter = (await inv.q("select count(*)::int n, md5(string_agg(id::text||status||amount_cents::text, ',' order by id)) h from invoices"))[0];
  ck("10.5 assinaturas e faturas preexistentes intactas (hash de todas as linhas) depois do rollback total concorrente", subAfter.h === sub.h && invAfter.h === inv0.h && subAfter.s === sub.s, JSON.stringify([sub, subAfter, inv0, invAfter]));
  const hasCourt = (await inv.q("select to_regclass('public.company_courtesies') t"))[0].t;
  ck("10.6 depois do rollback total as tabelas de cortesia não existem (nada pela metade)", hasCourt === null, String(hasCourt));
  let reErr = null; try { for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) { await w0.exec(miSql(k)); } } catch (e) { reErr = e.message; }
  ck("10.7 reaplicação das 8 migrations depois do rollback total concorrente: sem erro", reErr === null, String(reErr));
  const sigFinal = await schemaSig(db);
  const d2 = sigDiff(sigFinal, sigBefore).filter((x) => !/__clock/.test(x));
  ck("10.8 …e o schema final é idêntico ao inicial", d2.length === 0, d2.slice(0, 4).join(" ; "));
}

console.log("\n== 11. Deadlocks depois do rollback concorrente ==");
{
  const dl2 = await deadlocks();
  ck(`11.1 deadlocks do servidor: antes ${dl0}, agora ${dl2} (zero novos, inclusive durante rollback/reaplicação)`, dl2 === dl0, `${dl2 - dl0} novos`);
}

console.log("\n== Resumo de tempos ==");
for (const r of report) console.log(`   ${r.name}: ${r.n} execuções, ${r.lat}, violações ${r.viol}`);
console.log(`\nRESULTADO concorrência em PG real: ${okN} ok, ${failN} falhas`);
await dispose();
process.exit(failN ? 1 : 0);
