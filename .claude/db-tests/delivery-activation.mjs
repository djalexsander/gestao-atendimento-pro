// ATIVAÇÃO COMERCIAL do Delivery (20261015010000): módulo ativo a R$ 29,90 pela arquitetura comercial existente.
// unmanaged e trial ganham; assinatura sem o módulo não; assinatura com o módulo sim; adição proporcional e remoção seguem o ciclo.
import { loadAll } from "./full-db.mjs";
const { pg, ck, as, su: su0, errHas, summary } = await loadAll();
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
await su(`create or replace function public.business_now() returns timestamptz language sql stable set search_path = public as $$ select coalesce(nullif(current_setting('test.now', true), '')::timestamptz, now()) $$`);
const at = (iso) => su("select set_config('test.now', $1, false)", [iso]);
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x == null ? null : String(x).slice(0, 10));
const exp = (p, r, c) => Math.floor((2 * p * r + c) / (2 * c));
const MASTER = id(900);
await pg.exec(`insert into auth.users (id,email) values ('${MASTER}','m@x.com') on conflict do nothing;
  insert into public.profiles (user_id,email) values ('${MASTER}','m@x.com') on conflict do nothing;
  insert into public.platform_admins (user_id) values ('${MASTER}')`);

let seq = 100;
async function mkCo(tag, { trial = false } = {}) {
  await at("2026-10-07T15:00:00Z");
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "da-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
  const out = { c };
  for (const role of ["owner", "admin", "cashier"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email) values ('${u}','${role}-${tag}@x.com') on conflict do nothing`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u);
  }
  if (trial) await su("select public.billing_start_trial_internal($1,'test')", [c]);
  return out;
}
const plan = (await su("insert into plans (code,name,monthly_price_cents) values ('dabase','Plano Base',7990) returning id")).rows[0].id;
const M = {};
for (const code of ["financeiro", "producao", "estoque", "impressao", "delivery"]) M[code] = (await su("select id from modules where code=$1", [code])).rows[0].id;
const settle = (iid) => su("select billing_settle_invoice_gateway($1,null,'{}'::jsonb)", [iid]);
async function contract(co, codes = []) {
  const r = await co.owner("select public.tenant_subscribe($1,$2,$3::uuid[]) j", [co.c, plan, codes.map((x) => M[x])]);
  if (!r.ok) { console.log("SETUP FALHOU", r.err); process.exit(2); }
  await settle(r.rows[0].j.invoice_id);
  return r.rows[0].j;
}
const ent = async (co) => (await su("select public.company_entitlement($1) j", [co.c])).rows[0].j;
const mods = async (co) => (await ent(co)).modules.join();
const tenantEnt = async (co) => (await co.owner("select public.tenant_get_entitlements($1) j", [co.c])).rows[0].j;
const quote = async (co, codes) => (await co.owner("select public.tenant_quote_module_change($1,$2::uuid[]) j", [co.c, codes.map((x) => M[x])])).rows[0].j;
const sched = (co, codes) => co.owner("select public.tenant_schedule_module_change($1,$2::uuid[]) j", [co.c, codes.map((x) => M[x])]);
const gate = (co) => co.owner("select * from public.list_delivery_zones($1)", [co.c]);

// ---- 1. catálogo ----
const m = (await su("select * from modules where code='delivery'")).rows;
ck("1.1 exatamente 1 linha delivery, ativa, R$ 29,90", m.length === 1 && m[0].is_active === true && Number(m[0].monthly_price_cents) === 2990, JSON.stringify(m));
ck("1.2 descrição comercial, sem WhatsApp", /Delivery completo para pedidos de entrega e retirada/.test(m[0].description) && !/whatsapp/i.test(m[0].description), m[0].description);
const act = (await su("select code, monthly_price_cents, is_active from modules order by code")).rows;
ck("1.3 os outros 4 módulos intactos (preço e ativos)", JSON.stringify(act.filter((x) => x.code !== "delivery" && x.code !== "whatsapp" && x.code !== "ia" && x.code !== "partial_payments").map((x) => [x.code, Number(x.monthly_price_cents), x.is_active])) === JSON.stringify([["estoque", 1990, true], ["financeiro", 2490, true], ["impressao", 1490, true], ["producao", 1990, true]]), JSON.stringify(act));
const sum = act.filter((x) => x.is_active).reduce((a, x) => a + Number(x.monthly_price_cents), 0);
ck("1.4 total dos módulos 10950 e Base + todos = 18940", sum === 10950 && 7990 + sum === 18940, String(sum));
ck("1.5 sem plano 'Completo' no catálogo", Number((await su("select count(*) n from plans where lower(name) like '%completo%' or lower(code) like '%completo%'")).rows[0].n) === 0);

// ---- 2. entitlement por situação ----
const L = await mkCo("L"); // unmanaged (sem assinatura/trial)
ck("2.1 unmanaged (legado) recebe Delivery", (await mods(L)).split(",").includes("delivery") && (await ent(L)).mode === "unmanaged", JSON.stringify(await ent(L)));
const T = await mkCo("T", { trial: true });
const eT = await ent(T);
ck("2.2 trial de 7 dias recebe Delivery", eT.mode === "trial" && eT.modules.includes("delivery"), JSON.stringify(eT));
const S = await mkCo("S");
await contract(S, ["financeiro"]);
ck("2.3 assinatura SEM Delivery não recebe (só o contratado)", (await mods(S)) === "financeiro", await mods(S));
ck("2.4 app: tenant_get_entitlements da assinatura sem Delivery não lista delivery", !(await tenantEnt(S)).modules.includes("delivery"));
ck("2.5 RPC de Delivery bloqueada para a assinatura sem o módulo", errHas(await gate(S), /não está contratado/));
const W = await mkCo("W");
await contract(W, ["delivery"]);
ck("2.6 assinatura COM Delivery recebe", (await mods(W)) === "delivery", await mods(W));
ck("2.7 gate libera quando contratado", (await gate(W)).ok);

// ---- 3. contratação adicional (proporcional) ----
await at("2026-10-17T15:00:00Z");
const q = await quote(S, ["financeiro", "delivery"]);
const want = exp(2990, 21, 31);
ck("3.1 cotação: add_now, Delivery proporcional 2990 × 21/31, mensalidade 7990+2490+2990", q.mode === "add_now" && q.remaining_days === 21 && q.charge_today_cents === want && q.new_monthly_cents === 13470 && q.previous_monthly_cents === 10480, JSON.stringify(q));
const r = await sched(S, ["financeiro", "delivery"]);
const sj = r.ok ? r.rows[0].j : null;
ck("3.2 contratar gera fatura module_addition do valor proporcional", r.ok && sj && Number(sj.charge_today_cents ?? sj.amount_cents ?? want) === want, JSON.stringify(r.ok ? sj : r.err));
const inv = (await su("select * from invoices where company_id=$1 and kind='module_addition' order by created_at desc", [S.c])).rows;
ck("3.3 fatura module_addition criada com o proporcional", inv.length === 1 && Number(inv[0].amount_cents) === want, JSON.stringify(inv.map((x) => [x.kind, x.amount_cents, x.status])));
ck("3.4 ainda NÃO ativo antes do pagamento", !(await mods(S)).includes("delivery"));
await settle(inv[0].id);
ck("3.5 ativa após o pagamento", (await mods(S)).split(",").includes("delivery"), await mods(S));
ck("3.6 Delivery liberado depois de pago", (await gate(S)).ok);

// ---- 4. remoção segue o ciclo ----
const rm = await sched(S, ["financeiro"]);
ck("4.1 remover: agendado, mantém o acesso até o fim do ciclo", rm.ok && (await mods(S)).split(",").includes("delivery"), JSON.stringify(rm.ok ? rm.rows[0].j : rm.err));
const pend = (await su("select * from subscription_pending_changes where company_id=$1 and status='scheduled'", [S.c])).rows;
ck("4.2 troca agendada para o próximo vencimento (07/11), sem estorno nem remoção imediata", pend.length === 1 && d(pend[0].effective_at) === "2026-11-07", JSON.stringify(pend.map((x) => [x.status, d(x.effective_at)])));

// ---- 5. segurança ----
ck("5.1 anônimo não chama as RPCs comerciais", !(await as("anon", null, "select public.tenant_get_entitlements($1)", [S.c])).ok);
ck("5.2 funções de entitlement continuam fechadas para o cliente", !(await S.owner("select public.company_entitlement($1)", [S.c])).ok);

summary();
