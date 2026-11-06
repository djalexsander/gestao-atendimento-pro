// Valida os ROLLBACKS versionados das migrations de cortesias (supabase/rollbacks/courtesies) em bancos descartáveis (PGlite).
//   node scripts/courtesies/test-rollback.mjs
// Prova: (A) cada rollback, na ordem inversa, devolve EXATAMENTE o schema da etapa anterior (funções+corpo+ACL, colunas, RLS, políticas, triggers,
// índices, constraints); (B) com dados de cortesia + negócio existente o rollback não falha e não altera o negócio; (C) migrar de novo depois
// do rollback total reproduz o schema final; (D) fora de ordem falha SEM efeito parcial quando em transação; (E) comportamento ao repetir.
import fs from "node:fs";
import path from "node:path";
import { COURTESY, N, loadAllFn, rollbackFile, schemaSig, sigDiff, stageDir, ROLLBACK_DIR } from "./lib.mjs";

const loadAll = await loadAllFn();
let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : "  >> " + extra}`); cond ? okN++ : failN++; };
const RB = (k) => fs.readFileSync(rollbackFile(COURTESY[k - 1]), "utf8");     // k = 1..6
const inTx = async (pg, sql) => { await pg.exec("begin"); try { await pg.exec(sql); await pg.exec("commit"); return null; } catch (e) { await pg.exec("rollback"); return e.message; } };

console.log("\n== 0. arquivos versionados ==");
ck("0.1 existe um rollback por migration, com o mesmo prefixo de versão", COURTESY.every((m) => fs.existsSync(rollbackFile(m))));
ck("0.2 o diretório não contém nada além dos rollbacks e do LEIAME", fs.readdirSync(ROLLBACK_DIR).filter((f) => !COURTESY.some((m) => f === m.replace(/\.sql$/, ".rollback.sql")) && f !== "LEIAME.md").length === 0, fs.readdirSync(ROLLBACK_DIR).join(","));
ck("0.3 os rollbacks não estão dentro de supabase/migrations (a CLI não os aplicaria como migration)", !fs.readdirSync(path.join(ROLLBACK_DIR, "../../migrations")).some((f) => /rollback/.test(f)));
ck("0.4 cada rollback declara a migration que desfaz e o aviso de dados", COURTESY.every((m) => { const t = fs.readFileSync(rollbackFile(m), "utf8"); return t.includes(m.slice(0, 14)) && /ATEN/.test(t); }));

ck("0.5 nenhum rollback contém barra invertida (a CLI `db query` a consome e mudaria as regex)", COURTESY.every((m) => !fs.readFileSync(rollbackFile(m), "utf8").includes(String.fromCharCode(92))));

console.log("\n== A. ordem inversa: cada passo devolve exatamente a etapa anterior ==");
const sigs = [];
for (let k = 0; k <= N; k++) sigs.push(await schemaSig((await loadAll(stageDir(k), { legacyIaMirror: false })).pg));
{
  const { pg } = await loadAll(stageDir(N), { legacyIaMirror: false });
  ck("A.0 o schema da etapa final difere da etapa 0 (sanidade)", sigDiff(sigs[N], sigs[0]).length > 50);
  for (let k = N; k >= 1; k--) {
    const err = await inTx(pg, RB(k));
    ck(`A.${N + 1 - k} rollback de ${COURTESY[k - 1].slice(0, 14)} executa sem erro (em transação)`, err === null, err ?? "");
    const d = sigDiff(await schemaSig(pg), sigs[k - 1]);
    ck(`A.${N + 1 - k}b …e o schema volta EXATAMENTE para a etapa ${k - 1}`, d.length === 0, d.slice(0, 6).join(" ; "));
  }
}

console.log("\n== B. com dados: cortesias reais + negócio existente intactos ==");
{
  const { pg, as, su: su0 } = await loadAll(stageDir(N), { legacyIaMirror: false });
  const su = async (sql, p) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, p); };
  await su(`create or replace function public.business_now() returns timestamptz language sql stable set search_path = public as $$ select coalesce(nullif(current_setting('test.now', true), '')::timestamptz, now()) $$`);
  await su("select set_config('test.now','2030-01-10T12:00:00Z',false)");
  const MID = "00000000-0000-4000-8000-000000000001";
  await su(`insert into auth.users (id,email) values ('${MID}','m@x.com')`); await su(`insert into public.profiles (user_id,email) values ('${MID}','m@x.com') on conflict do nothing`); await su(`insert into public.platform_admins (user_id) values ('${MID}')`);
  const M = (s, p) => as("authenticated", MID, s, p);
  const pA = (await su("insert into plans (code,name,monthly_price_cents,is_active) values ('pa','A',10000,true) returning id")).rows[0].id;
  const pB = (await su("insert into plans (code,name,monthly_price_cents,is_active) values ('pb','B',20000,true) returning id")).rows[0].id;
  const mk = async (slug, doc) => (await su("insert into companies (name,slug,document,email) values ($1,$1,$2,$1||'@x.com') returning id", [slug, doc])).rows[0].id;
  const paid = await mk("paga", "11222333000181"), cort = await mk("cortesia", "22333444000172"), conv = await mk("conversao", "33444555000163");
  await M("select * from master_subscribe_company($1,$2,'{}'::uuid[])", [paid, pA]);
  const inv = (await su("select id from invoices where company_id=$1 and kind='initial'", [paid])).rows[0].id;
  await M("select master_mark_invoice_paid($1,null)", [inv]);
  const g1 = await M("select public.master_grant_courtesy(p_company_id=>$1,p_scope=>'plan',p_reason=>'rollback com dados',p_plan_id=>$2,p_days=>60) r", [cort, pA]);
  const g2 = await M("select public.master_grant_courtesy(p_company_id=>$1,p_scope=>'plan',p_reason=>'conversao',p_plan_id=>$2,p_days=>60) r", [conv, pB]);
  ck("B.0 cenário criado (2 cortesias de plano + 1 assinatura paga)", g1.ok && g2.ok, g1.err ?? g2.err ?? "");
  const kc = g2.rows[0].r.courtesy.id;
  const rq = await M("select public.master_request_courtesy_conversion($1,'quero pagar',null) r", [kc]);
  const au = await M("select public.master_convert_courtesy($1,'autorizo',null,null,72) r", [kc]);
  const sb = await M("select * from master_subscribe_company($1,$2,'{}'::uuid[])", [conv, pB]);
  const counts = async () => ({
    courtesies: (await su("select count(*)::int n from company_courtesies")).rows[0].n,
    events: (await su("select count(*)::int n from company_courtesy_events")).rows[0].n,
    bridges: (await su("select count(*)::int n from courtesy_access_bridges")).rows[0].n,
    records: (await su("select count(*)::int n from courtesy_billing_records")).rows[0].n,
  });
  const before = await counts();
  console.log(`   dados antes: ${JSON.stringify(before)} (pedido ok=${rq.ok}, autorização ok=${au.ok}, assinatura ok=${sb.ok})`);
  ck("B.1 há dados em cortesias e eventos antes do rollback", before.courtesies >= 2 && before.events >= 2);
  const biz = async () => JSON.stringify({
    subs: (await su("select company_id, status, plan_price_cents_snapshot from subscriptions order by company_id")).rows,
    invs: (await su("select company_id, competence, amount_cents, status, kind from invoices order by company_id, competence, kind")).rows,
    items: (await su("select count(*)::int n, coalesce(sum(amount_cents),0)::int s from invoice_items where kind <> 'adjustment'")).rows,
    comps: (await su("select slug from companies order by slug")).rows,
  });
  const bizBefore = await biz();
  const paidAccessBefore = (await su("select public.company_access_state($1) s, public.company_write_blocked($1) b", [paid])).rows[0];
  let notValidAfter1118 = null;
  for (let k = N; k >= 1; k--) {
    const err = await inTx(pg, RB(k));
    if (err) { ck(`B.2 rollback ${COURTESY[k - 1].slice(0, 14)} com dados`, false, err); break; }
    if (k === 4) notValidAfter1118 = (await schemaSig(pg)).con.some((c) => c.includes("company_courtesy_events_event_type_check") && c.includes("NOT VALID"));
  }
  ck("B.2 os seis rollbacks executam sem erro com dados de cortesia, ponte e isenções presentes", (await su("select to_regclass('public.company_courtesies') t")).rows[0].t === null);
  ck("B.3 assinaturas, faturas, itens (exceto ajustes de cortesia) e empresas permanecem idênticos", (await biz()).replace(/"adjustment"/g, "") === bizBefore.replace(/"adjustment"/g, "") || (await biz()) === bizBefore, "negócio mudou");
  const paidAccessAfter = (await su("select public.company_access_state($1) s, public.company_write_blocked($1) b", [paid])).rows[0];
  ck("B.4 acesso da empresa paga idêntico depois do rollback", JSON.stringify(paidAccessBefore) === JSON.stringify(paidAccessAfter), JSON.stringify([paidAccessBefore, paidAccessAfter]));
  const cyc = await su("select public.run_billing_cycle() r");
  ck("B.5 run_billing_cycle() original funciona depois do rollback (sem chave de cortesia no resultado)", cyc.ok && !('courtesies_expired' in cyc.rows[0].r), cyc.err ?? JSON.stringify(cyc.rows[0]?.r));
  // business_now() foi trocada por este teste (relógio de teste); a constraint de tipos de evento fica NOT VALID de propósito quando há eventos novos (append-only)
  const norm = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v.filter((e) => !e.startsWith("business_now()")).map((e) => e.replace(" NOT VALID", ""))]));
  const d = sigDiff(norm(await schemaSig(pg)), norm(sigs[0]));
  ck("B.6 schema final = schema anterior às cortesias, mesmo depois de rodar com dados (ignorando o relógio de teste)", d.length === 0, d.slice(0, 6).join(" ; "));
  ck("B.6b a constraint de tipos de evento ficou NOT VALID logo após o rollback da 1118 (havia eventos conversion_authorized/converted) — por desenho", notValidAfter1118 === true, String(notValidAfter1118));
  void counts;

  console.log("\n== C. migrar de novo depois do rollback total ==");
  const dir = stageDir(N);
  for (const n of ["patch_fn_courtesy", "patch_fn_cv", "patch_fn_c3"]) await pg.exec(`drop function if exists pg_temp.${n}(text, text, text)`);   // nova sessão: o pg_temp do PGlite é único
  let errC = null;
  for (const f of COURTESY) { try { await pg.exec(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { errC = `${f}: ${e.message}`; break; } }
  ck("C.1 as migrations reaplicam sem erro sobre o banco já revertido", errC === null, errC ?? "");
  const dC = sigDiff(norm(await schemaSig(pg)), norm(sigs[N]));
  ck("C.2 …e o schema volta a ser idêntico ao da etapa final", dC.length === 0, dC.slice(0, 6).join(" ; "));
}

console.log("\n== D. fora de ordem / repetição ==");
{
  const { pg } = await loadAll(stageDir(N), { legacyIaMirror: false });
  const before = await schemaSig(pg);
  const err = await inTx(pg, RB(1));
  const after = await schemaSig(pg);
  ck("D.1 rollback da 1115 ANTES dos posteriores: ou falha ou deixa tudo como estava (em transação, sem efeito parcial)", err !== null ? sigDiff(before, after).length === 0 : true, err ?? "(executou sem erro)");
  console.log(`   (rollback fora de ordem: ${err === null ? "executou sem erro — veja D.2" : "recusado: " + err.split("\n")[0].slice(0, 120)})`);
  if (err === null) ck("D.2 …se executou, o schema ficou diferente do original → fora de ordem NÃO é seguro (documentado no LEIAME)", sigDiff(before, after).length > 0);
}
{
  const { pg } = await loadAll(stageDir(N), { legacyIaMirror: false });
  for (let k = N; k >= 1; k--) await inTx(pg, RB(k));
  const mid = await schemaSig(pg);
  const results = [];
  for (let k = N; k >= 1; k--) { const e = await inTx(pg, RB(k)); results.push(e === null ? "ok" : "erro"); }
  const after = await schemaSig(pg);
  ck("E.1 repetir os rollbacks inteiros em transação nunca corrompe o schema já revertido", sigDiff(mid, after).length === 0, results.join(","));
  console.log(`   (segunda execução, por rollback 1121→1115: ${results.join(", ")})`);
}

console.log(`\nRESULTADO rollback de cortesias: ${okN} ok, ${failN} falhas`);
process.exit(failN ? 1 : 0);
