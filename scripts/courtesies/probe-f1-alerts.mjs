// F1 sem teto: os alertas enxergam uma empresa com cortesia original preservada e outro plano aguardando pagamento? (5C-2: NÃO enxergavam; 5C-3: enxergam)
//   node scripts/courtesies/probe-f1-alerts.mjs
// Depois da migration 20261122010000 (5C-3) a F1 tem alerta próprio (preserved_pending_payment), independente da data de vencimento da cortesia.
import { loadAllFn } from "./lib.mjs";

const loadAll = await loadAllFn();
let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : "  >> " + extra}`); cond ? okN++ : failN++; };
const { pg, as, su: su0 } = await loadAll(undefined, { legacyIaMirror: false });
const su = async (sql, p) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, p); };
const at = (t) => su("select set_config('test.now',$1,false)", [t]);
await su(`create or replace function public.business_now() returns timestamptz language sql stable set search_path = public as $$ select coalesce(nullif(current_setting('test.now', true), '')::timestamptz, now()) $$`);
await at("2030-01-10T12:00:00Z");
const MID = "00000000-0000-4000-8000-000000000001";
await su(`insert into auth.users (id,email) values ('${MID}','m@x.com')`); await su(`insert into public.profiles (user_id,email) values ('${MID}','m@x.com') on conflict do nothing`); await su(`insert into public.platform_admins (user_id) values ('${MID}')`);
const M = (s, p) => as("authenticated", MID, s, p);
await su("update modules set is_active=true where code in ('estoque','financeiro')");
const mk = async (code, price, mod) => { const id = (await su("insert into plans (code,name,monthly_price_cents,is_active) values ($1,$1,$2,true) returning id", [code, price])).rows[0].id; await su("insert into plan_modules (plan_id,module_id) select $1,id from modules where code=$2", [id, mod]); return id; };
const pA = await mk("pa", 10000, "estoque"), pB = await mk("pb", 20000, "financeiro");
const comp = async (s) => (await su("insert into companies (name,slug,document,email) values ($1,$1,'11222333000181',$1||'@x.com') returning id", [s])).rows[0].id;
const f1Company = async (tag, days) => {
  await at("2030-01-10T12:00:00Z"); const c = await comp(tag); await M("select * from master_start_trial($1)", [c]);
  await at("2030-03-01T12:00:00Z");
  const g = await M("select public.master_grant_courtesy(p_company_id=>$1,p_scope=>'plan',p_reason=>'alerta F1',p_plan_id=>$2,p_days=>$3) r", [c, pA, days]);
  await M("select * from master_subscribe_company($1,$2,'{}'::uuid[])", [c, pB]);
  return { c, k: g.rows[0].r.courtesy };
};
const attention = async (c) => (await M("select public.master_list_courtesy_attention('all', 7, 100, 0) r")).rows[0].r.items.filter((i) => i.company_id === c);
const inWindow = async (c) => (await su("select public.company_write_blocked($1) b", [c])).rows[0].b === false;

const far = await f1Company("f1-longe", 90);                         // vence só em ~90 dias
await at("2030-04-01T12:00:00Z");                                   // B pendente há ~30 dias; cortesia vence em ~60 dias
ck("1.1 [cenário A] janela F1 ativa há ~30 dias, cortesia ainda longe de vencer", await inWindow(far.c));
const aItems = await attention(far.c);
console.log("   alertas existentes para o cenário A:", JSON.stringify(aItems.map((i) => i.kind)));
  ck("1.2 [5C-3] a janela F1 aparece como preserved_pending_payment (uma linha) mesmo com a cortesia longe de vencer, sem ser expiring_soon nem vencida", aItems.length === 1 && aItems[0].kind === "preserved_pending_payment" && aItems[0].days_pending >= 0, JSON.stringify(aItems.map((i) => [i.kind, i.days_pending])));

const near = await f1Company("f1-perto", 30);                        // vence em ~30 dias a partir de 03-01
await at("2030-03-28T12:00:00Z");                                   // faltam ~3 dias
const bItems = await attention(near.c);
  ck("1.3 cortesia perto de vencer (≤ 7 dias): aparece como expiring_soon E como preserved_pending_payment (tipos distintos, uma linha de cada)", JSON.stringify(bItems.map((i) => i.kind).sort()) === JSON.stringify(["expiring_soon", "preserved_pending_payment"]), JSON.stringify(bItems.map((i) => i.kind)));

await at("2030-05-20T12:00:00Z");
await su("select public.run_billing_cycle()");
const cItems = await attention(near.c);
  ck("1.4 cortesia vencida com B ainda pendente: aparece como expired_pending_decision E como preserved_pending_payment (e a janela segue ativa)", JSON.stringify(cItems.map((i) => i.kind).sort()) === JSON.stringify(["expired_pending_decision", "preserved_pending_payment"]) && (await inWindow(near.c)), JSON.stringify(cItems.map((i) => i.kind)));

const cnt = (await M("select public.master_get_courtesy_counters(7) r")).rows[0].r;
  ck("1.5 os contadores trazem preserved_pending_payment e preserved_pending_oldest_days", typeof cnt.preserved_pending_payment === "number" && cnt.preserved_pending_payment >= 2 && typeof cnt.preserved_pending_oldest_days === "number", JSON.stringify(cnt));

console.log(`\nRESULTADO probe F1-alertas: ${okN} ok, ${failN} falhas`);
process.exit(failN ? 1 : 0);
