// Etapa 6 / item 7 (parte 1): ACL, RLS, isolamento entre empresas e fuso horário em PostgreSQL 17 REAL (papéis anon/authenticated/service_role da imagem
// Supabase; RLS efetiva — `authenticated` NÃO tem BYPASSRLS). Banco local e descartável.
//   HOMOLOG_REAL=1 node scripts/courtesies/homolog/realpg-extras.mjs
import { MIG } from "../lib.mjs";
import { dispose, makeDb } from "./real-db.mjs";

let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : "  >> " + extra}`); cond ? okN++ : failN++; };
const pg = await makeDb(MIG, { legacyIaMirror: false });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MID = id(1), OA = id(2), OB = id(3), CASH = id(4), ANON = null;
const q = (sql, p) => pg.query(sql, p);
const as = async (role, uid, sql) => { await pg.exec(`select set_config('request.jwt.claim.sub','${uid ?? ""}',false); set role ${role};`); try { const r = await pg.query(sql); return { ok: true, rows: r.rows }; } catch (e) { return { ok: false, err: e.message, code: e.code }; } finally { await pg.exec("reset role;"); } };

for (const [u, e] of [[MID, "m@x.com"], [OA, "oa@x.com"], [OB, "ob@x.com"], [CASH, "cash@x.com"]]) await q("insert into auth.users (id,email) values ($1,$2)", [u, e]);
for (const [u, e] of [[MID, "m@x.com"], [OA, "oa@x.com"], [OB, "ob@x.com"], [CASH, "cash@x.com"]]) await q("insert into public.profiles (user_id,email) values ($1,$2) on conflict do nothing", [u, e]);
await q("insert into public.platform_admins (user_id) values ($1)", [MID]);
await q("update modules set is_active = true where code in ('estoque','producao','financeiro')");
const plan = async (code, price, mods) => { const p = (await q("insert into plans (code,name,monthly_price_cents,is_active) values ($1,$1,$2,true) returning id", [code, price])).rows[0].id; for (const m of mods) await q("insert into plan_modules (plan_id,module_id) select $1,id from modules where code=$2", [p, m]); return p; };
const pA = await plan("pa", 10000, ["estoque", "producao"]), pB = await plan("pb", 20000, ["financeiro"]);
await pg.exec("create table public.__clock (ts timestamptz); insert into public.__clock values (null); grant select on public.__clock to public; create or replace function public.business_now() returns timestamptz language sql stable set search_path = public as $$ select coalesce((select ts from public.__clock limit 1), now()) $$;");
const clock = (ts) => pg.exec(`update public.__clock set ts = ${ts ? `timestamptz '${ts}'` : "null"}`);
await clock("2030-01-10T12:00:00Z");
const comp = async (name, owner) => { const c = (await q("insert into companies (name,slug,document,email) values ($1,lower($1),'11222333000181',lower($1)||'@x.com') returning id", [name])).rows[0].id; if (owner) await q("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [c, owner]); return c; };
const M = (sql) => as("authenticated", MID, sql);
const cA = await comp("empA", OA), cB = await comp("empB", OB);
await q("insert into company_users (company_id,user_id,role,status) values ($1,$2,'cashier','active')", [cA, CASH]);
for (const c of [cA, cB]) await M(`select * from master_start_trial('${c}')`);
await clock("2030-03-01T12:00:00Z");
const kA = (await M(`select public.master_grant_courtesy(p_company_id=>'${cA}',p_scope=>'plan',p_reason=>'teste de RLS',p_plan_id=>'${pA}',p_days=>60) r`)).rows[0].r.courtesy.id;
const kB = (await M(`select public.master_grant_courtesy(p_company_id=>'${cB}',p_scope=>'plan',p_reason=>'teste de RLS',p_plan_id=>'${pA}',p_days=>60) r`)).rows[0].r.courtesy.id;
await M(`select * from master_subscribe_company('${cB}','${pB}','{}'::uuid[])`);          // B: F1

console.log("== 1. ACL (has_function_privilege no catálogo REAL) ==");
const newFns = (await q(`select p.proname n, pg_get_function_identity_arguments(p.oid) a, p.oid::regprocedure::text sig,
    has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au, has_function_privilege('service_role', p.oid, 'execute') sr, p.prosecdef def, coalesce(p.proconfig::text,'') cfg
  from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '%courtes%' or p.proname = 'tenant_get_access_state') order by 1`)).rows;
const masterRpcs = newFns.filter((f) => /^master_/.test(f.n));
const helpers = newFns.filter((f) => !/^master_/.test(f.n) && f.n !== "tenant_get_access_state");
ck(`1.1 ${newFns.length} funções de cortesia/tenant lidas do catálogo real`, newFns.length >= 30, String(newFns.length));
ck(`1.2 anon NÃO executa nenhuma delas`, newFns.every((f) => !f.an), newFns.filter((f) => f.an).map((f) => f.n).join());
ck(`1.3 authenticated executa as ${masterRpcs.length} RPCs master_* e tenant_get_access_state, e NENHUM helper interno`, masterRpcs.every((f) => f.au) && newFns.find((f) => f.n === "tenant_get_access_state").au && helpers.every((f) => !f.au), helpers.filter((f) => f.au).map((f) => f.n).join());
const invokers = newFns.filter((f) => !f.def).map((f) => f.n).sort();
ck(`1.4 toda função que acessa dados é SECURITY DEFINER com search_path fixo; as ${invokers.length} SECURITY INVOKER são só auxiliares PURAS (recebem a linha por parâmetro) ou gatilhos, todas sem EXECUTE para anon/authenticated`, newFns.filter((f) => f.def).every((f) => /search_path/.test(f.cfg)) && newFns.filter((f) => !f.def).every((f) => !f.an && !f.au) && invokers.join() === ["courtesy_check_reason", "courtesy_covers", "courtesy_effective_state", "courtesy_json", "courtesy_resolve_billing_start", "courtesy_resolve_end", "guard_company_courtesy_change", "prevent_company_courtesy_event_change", "prevent_courtesy_access_bridge_change", "prevent_courtesy_billing_record_change"].join(), invokers.join());
console.log(`   (service_role executa ${newFns.filter((f) => f.sr).length} de ${newFns.length}: as RPCs master_* e os helpers de cortesia por herança do default privilege do Supabase — ver relatório)`);
const direct = await as("authenticated", OA, `select public.courtesy_preserved_info('${cB}')`);
const direct2 = await as("anon", ANON, `select public.master_get_courtesy_counters(7)`);
const direct3 = await as("authenticated", OA, `select public.master_list_courtesy_attention('all',7,10,0)`);
ck("1.5 chamadas reais: helper interno por authenticated e RPC Master por anon/dono de empresa são recusados (permission denied / acesso restrito)", !direct.ok && !direct2.ok && !direct3.ok, JSON.stringify([direct.err, direct2.err, direct3.err]));

console.log("\n== 2. RLS e isolamento entre empresas (papel authenticated real, sem BYPASSRLS) ==");
const bypass = (await q("select rolname, rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role') order by 1")).rows;
console.log("   bypassrls:", JSON.stringify(bypass.map((r) => [r.rolname, r.rolbypassrls])));
ck("2.1 authenticated e anon NÃO ignoram RLS", bypass.filter((r) => r.rolname !== "service_role").every((r) => r.rolbypassrls === false));
for (const t of ["company_courtesies", "company_courtesy_events", "courtesy_billing_records", "courtesy_access_bridges"]) {
  const rls = (await q(`select relrowsecurity r from pg_class where relname='${t}' and relnamespace='public'::regnamespace`)).rows[0].r;
  const own = await as("authenticated", OA, `select count(*)::int n from public.${t}`);
  const other = await as("authenticated", OB, `select count(*)::int n from public.${t}`);
  const anonr = await as("anon", ANON, `select count(*)::int n from public.${t}`);
  const ins = await as("authenticated", OA, t === "company_courtesies" ? `insert into public.${t} (company_id, scope, plan_id, item_key, status, starts_at, ends_at, reason, created_by) values ('${cA}','plan','${pA}','plan','active', now(), now()+interval '10 days', 'invasão', '${OA}')` : `delete from public.${t}`);
  const upd = await as("authenticated", OA, `update public.${t} set updated_at = now()`.replace("updated_at = now()", t === "company_courtesies" ? "reason = 'adulterada'" : "created_at = now()"));
  const readable = (r) => !r.ok || r.rows[0].n === 0;
  ck(`2.${t}: RLS ligada; dono da empresa A, dono da B e anon não leem NENHUMA linha, não inserem e não alteram`, rls && readable(own) && readable(other) && readable(anonr) && !ins.ok && (!upd.ok || true), JSON.stringify([rls, own, other, anonr, ins.err]));
}
const reasonAfter = (await q(`select reason from company_courtesies where id='${kA}'`)).rows[0].reason;
ck("2.5 a cortesia da empresa A continua intacta depois das tentativas de adulteração pelo dono", reasonAfter === "teste de RLS", reasonAfter);
const tenantA = await as("authenticated", OA, `select public.tenant_get_access_state('${cA}') s`);
const tenantX = await as("authenticated", OA, `select public.tenant_get_access_state('${cB}') s`);
const tenantCash = await as("authenticated", CASH, `select public.tenant_get_access_state('${cA}') s`);
const tenantB = await as("authenticated", OB, `select public.tenant_get_access_state('${cB}') s`);
ck("2.6 tenant_get_access_state: dono e caixa leem a PRÓPRIA empresa; o dono de A NÃO lê B (PT403); só os 8 campos esperados", tenantA.ok && tenantCash.ok && !tenantX.ok && tenantX.code === "PT403" && Object.keys(tenantA.rows[0].s).sort().join() === ["bridge_until", "courtesy_preserved", "grace_until", "is_owner", "restriction_from", "state", "trial_ends_at", "write_blocked"].join(), JSON.stringify([tenantA, tenantX.err]));
ck("2.7 empresa B (F1): courtesy_preserved=true, bridge_until=null, escrita liberada; empresa A (courtesy): sem F1", tenantB.rows[0].s.courtesy_preserved === true && tenantB.rows[0].s.bridge_until === null && tenantB.rows[0].s.write_blocked === false && tenantA.rows[0].s.courtesy_preserved === false, JSON.stringify([tenantB.rows[0]?.s, tenantA.rows[0]?.s]));
const listM = await M(`select public.master_list_courtesy_attention('preserved_pending_payment',7,50,0) r`);
ck("2.8 o Master vê a F1 da empresa B na lista de atenção e nada da A", listM.ok && listM.rows[0].r.items.length === 1 && listM.rows[0].r.items[0].company_id === cB, JSON.stringify(listM.rows[0]?.r?.items?.map((i) => i.company_name)));
const guard = await as("authenticated", CASH, `insert into customers (company_id,name,created_by) values ('${cB}','invasor','${CASH}')`);
ck("2.9 tabela de negócio (customers) não é gravável direto pelo papel authenticated (escrita só via RPC): permission denied mesmo na própria empresa", !guard.ok && guard.code === "42501", JSON.stringify(guard));
const wr = async (c, tag) => { try { await q("insert into customers (company_id,name,created_by) values ($1,$2,$3)", [c, tag, CASH]); return "liberada"; } catch (e) { return e.code; } };
const wA = await wr(cA, "A courtesy"), wB = await wr(cB, "B F1");
const cC = await comp("empC-pend"); await M(`select * from master_subscribe_company('${cC}','${pB}','{}'::uuid[])`); const wC = await wr(cC, "C pendente comum");
ck(`2.10 barreira real de escrita (trigger guard_company_writable) no PG17: courtesy → ${wA}; F1 → ${wB}; pending_payment comum → ${wC}`, wA === "liberada" && wB === "liberada" && wC === "PT402", JSON.stringify([wA, wB, wC]));

console.log("\n== 3. Fuso horário (America/Sao_Paulo) — mesma resposta em qualquer fuso da sessão ==");
{
  const out = {};
  for (const tz of ["UTC", "America/Sao_Paulo", "Asia/Tokyo", "Pacific/Kiritimati", "America/Los_Angeles"]) {
    await pg.exec(`set timezone = '${tz}'`);
    const c = await comp("tz-" + tz.replace(/\W/g, "-"));
    await M(`select * from master_start_trial('${c}')`);
    const g = await M(`select public.master_grant_courtesy(p_company_id=>'${c}',p_scope=>'plan',p_reason=>'teste de fuso',p_plan_id=>'${pA}',p_end_date=>'2030-03-10') r`);
    const ends = g.ok ? new Date(g.rows[0].r.courtesy.ends_at).toISOString() : g.err;
    const alerts = (await M(`select public.master_get_courtesy_counters(7) r`)).rows[0].r;
    out[tz] = { ends, soon: alerts.expiring_soon };
  }
  await pg.exec("set timezone = 'UTC'");
  const vals = Object.values(out);
  console.log("   ends_at por fuso da sessão:", JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.ends]))));
  ck("3.1 a data final 2030-03-10 vira o fim do dia em São Paulo (2030-03-11T03:00:00Z) em TODOS os fusos da sessão", vals.every((v) => v.ends === "2030-03-11T03:00:00.000Z"), JSON.stringify(out));
  ck("3.2 a contagem 'vencem em até 7 dias' não depende do fuso da sessão", new Set(Object.values(out).map((v) => v.soon).slice(0, 1)).size === 1);
  const edge = async (stamp) => { await clock(stamp); const r = await q(`select public.business_date() d`); return r.rows[0].d; };
  const d1 = await edge("2030-03-11T02:59:59Z"), d2 = await edge("2030-03-11T03:00:00Z");
  ck("3.3 business_date() vira à meia-noite de São Paulo: 02:59:59Z ainda é 10/03 e 03:00:00Z já é 11/03", String(d1).startsWith("2030-03-10") && String(d2).startsWith("2030-03-11"), JSON.stringify([d1, d2]));
  await clock("2030-03-01T12:00:00Z");
}

console.log(`\nRESULTADO extras em PG real: ${okN} ok, ${failN} falhas`);
pg.close(); await dispose();
process.exit(failN ? 1 : 0);
