// F1 (Etapa 5C-1, IMPLEMENTADA em 20261121010000): contratação de OUTRO plano durante cortesia de plano aberta — sonda de comportamento.
//   node scripts/courtesies/probe-f1.mjs
// Depois da correção: com a cortesia do plano A aberta e o plano B em pending_payment, a empresa mantém SÓ os direitos da cortesia A.
// A suíte completa é .claude/db-tests/courtesies-preserved.mjs; esta sonda mostra o antes/depois em um cenário simples e legível.
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
await su("update modules set is_active=true, monthly_price_cents=3000 where code='financeiro'"); await su("update modules set is_active=true, monthly_price_cents=2000 where code='estoque'");
const mid = async (c) => (await su("select id from modules where code=$1", [c])).rows[0].id;
const pA = (await su("insert into plans (code,name,monthly_price_cents,is_active) values ('pa','A',10000,true) returning id")).rows[0].id;
const pB = (await su("insert into plans (code,name,monthly_price_cents,is_active) values ('pb','B',20000,true) returning id")).rows[0].id;
await su("insert into plan_modules (plan_id,module_id) values ($1,$2)", [pA, await mid("estoque")]);       // plano A: estoque
await su("insert into plan_modules (plan_id,module_id) values ($1,$2)", [pB, await mid("financeiro")]);    // plano B: financeiro
const comp = async (slug, doc) => (await su("insert into companies (name,slug,document,email) values ($1,$1,$2,$1||'@x.com') returning id", [slug, doc])).rows[0].id;
const view = async (c) => {
  const e = (await su("select public.company_entitlement($1) e", [c])).rows[0].e;
  return { state: (await su("select public.company_access_state($1) s", [c])).rows[0].s, blocked: (await su("select public.company_write_blocked($1) b", [c])).rows[0].b, mode: e.mode, modules: e.modules ?? [] };
};
const show = (t, v) => console.log(`   ${t}: estado=${v.state} escrita_bloqueada=${v.blocked} modo=${v.mode} módulos=[${v.modules.join(",")}]`);
const bridges = async (c) => (await su("select count(*)::int n from courtesy_access_bridges where company_id=$1", [c])).rows[0].n;
const invoices = async (c) => (await su("select kind, status, amount_cents from invoices where company_id=$1 order by created_at", [c])).rows;

console.log("\n== F1-1: cortesia do plano A (sem assinatura) e depois contratação do plano B ==");
{
  const c = await comp("f1-a", "11222333000181");
  await M("select * from master_start_trial($1)", [c]);
  await at("2030-03-01T12:00:00Z");                                                 // trial vencido
  const g = await M("select public.master_grant_courtesy(p_company_id=>$1,p_scope=>'plan',p_reason=>'F1 cortesia de plano',p_plan_id=>$2,p_days=>90) r", [c, pA]); if (!g.ok) { console.log("ERRO grant:", g.err); process.exit(2); } const k = g.rows[0].r.courtesy;
  const v0 = await view(c); show("antes (cortesia do plano A)", v0);
  ck("1.1 [ANTES] com a cortesia: estado 'courtesy', escrita liberada, módulo do plano A (estoque) concedido", v0.state === "courtesy" && v0.blocked === false && v0.modules.includes("estoque") && !v0.modules.includes("financeiro"), JSON.stringify(v0));
  const s = await M("select * from master_subscribe_company($1,$2,'{}'::uuid[])", [c, pB]);
  ck("1.2 contratar o plano B (outro plano) é permitido pelo Master e cria assinatura", s.ok, s.err ?? "");
  const v1 = await view(c); show("depois de contratar B (sem pagar)", v1);
  ck("1.3 [F1] com B pendente: estado pending_payment, escrita LIBERADA, módulos = SÓ os da cortesia A (estoque), nada de B", v1.state === "pending_payment" && v1.blocked === false && v1.mode === "courtesy_pending_payment" && v1.modules.join() === "estoque", JSON.stringify(v1));
  ck("1.4 nenhum módulo do plano B é concedido antes do pagamento", !v1.modules.includes("financeiro"));
  ck("1.5 nenhuma ponte foi criada (a ponte é só da conversão da cortesia do MESMO plano)", (await bridges(c)) === 0);
  const inv = await invoices(c);
  ck("1.6 existe exatamente a fatura inicial do plano B, aberta, valor integral", inv.length === 1 && inv[0].kind === "initial" && inv[0].status === "open" && inv[0].amount_cents === 20000, JSON.stringify(inv));
  const st = (await su("select status from company_courtesies where id=$1", [k.id])).rows[0].status;
  ck("1.7 a cortesia do plano A segue 'active' (dormente) — nada a encerra nem converte", st === "active", st);
  await at("2030-03-02T12:00:00Z");
  await su("select public.run_billing_cycle()");
  const v2 = await view(c);
  ck("1.8 [F1] o ciclo não toca pending_payment e a janela segue (sem prazo adicional) enquanto a cortesia A estiver aberta", v2.state === "pending_payment" && v2.blocked === false && v2.mode === "courtesy_pending_payment", JSON.stringify(v2));
  const invId = (await su("select id from invoices where company_id=$1 and kind='initial'", [c])).rows[0].id;
  await M("select master_mark_invoice_paid($1,null)", [invId]);
  const v3 = await view(c); show("depois de pagar B", v3);
  ck("1.9 pago: active, escrita liberada, módulos do plano B (financeiro); a cortesia A não concede nada em paralelo", v3.state === "active" && v3.blocked === false && v3.modules.includes("financeiro") && !v3.modules.includes("estoque"), JSON.stringify(v3));
  await M("select * from master_set_subscription_status($1,'canceled',null)", [(await su("select id from subscriptions where company_id=$1", [c])).rows[0].id]);
  const v4 = await view(c); show("assinatura B cancelada (cortesia A ainda aberta)", v4);
  ck("1.10 cancelada a B, a cortesia A aberta volta a valer (estado 'courtesy')", v4.state === "courtesy" && v4.blocked === false && v4.modules.includes("estoque"), JSON.stringify(v4));
}

console.log("\n== F1-2: cortesia de MÓDULO + contratação de plano que não inclui o módulo ==");
{
  const c = await comp("f1-m", "22333444000172");
  await M("select * from master_start_trial($1)", [c]);
  const k = (await M("select public.master_grant_courtesy(p_company_id=>$1,p_scope=>'module',p_reason=>'F1 modulo',p_module_code=>'estoque',p_days=>90) r", [c])).rows[0].r.courtesy;
  const v0 = await view(c); show("trial + cortesia do módulo estoque", v0);
  await M("select * from master_subscribe_company($1,$2,'{}'::uuid[])", [c, pB]);
  const v1 = await view(c); show("depois de contratar B (sem pagar)", v1);
  ck("2.1 [GERAL] só cortesia de módulo + B pendente: SEGUE bloqueada e sem módulos (a regra 4 da 2A não foi enfraquecida; a F1 exige cortesia de PLANO)", v1.state === "pending_payment" && v1.blocked === true && !v1.modules.includes("estoque"), JSON.stringify(v1));
  void k;
}

console.log("\n== F1-3: mesmo plano da cortesia (controle) ==");
{
  const c = await comp("f1-s", "33444555000163");
  await M("select * from master_start_trial($1)", [c]);
  await at("2030-09-01T12:00:00Z");
  await M("select public.master_grant_courtesy(p_company_id=>$1,p_scope=>'plan',p_reason=>'controle',p_plan_id=>$2,p_days=>90) r", [c, pA]);
  const s = await M("select * from master_subscribe_company($1,$2,'{}'::uuid[])", [c, pA]);
  ck("3.1 contratar o MESMO plano sem conversão autorizada é recusado (PT409) — sem F1", !s.ok && /convers/i.test(s.err ?? ""), s.err ?? "");
}

console.log(`\nRESULTADO probe F1: ${okN} ok, ${failN} falhas`);
process.exit(failN ? 1 : 0);
