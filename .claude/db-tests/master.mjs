import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

// Contas a receber (migration 20261004010000): criação, status derivado, recebimento total/parcial, cancelamento, filtros, busca, ordenação, RLS/GRANT.
// pagamentos e movimentos). Só os cenários pedidos. Banco descartável (PGlite) com TODAS as
// migrations reais exceto o pg_cron + shim do schema storage. Mesmo padrão de orders.mjs.
const dir = process.env.MIG_DIR ?? "D:/orça facil/supabase/migrations";
const pg = new PGlite();
await pg.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
  create function auth.email() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.email', true),'') $$;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to public, anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null unique, owner uuid,
    created_at timestamptz default now(), updated_at timestamptz default now(),
    public boolean default false, avif_autodetection boolean default false,
    file_size_limit bigint, allowed_mime_types text[], owner_id text
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text, owner uuid, owner_id text,
    created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(),
    metadata jsonb, path_tokens text[] generated always as (string_to_array(name, '/')) stored,
    version text, user_metadata jsonb
  );
  create unique index bucketid_objname on storage.objects (bucket_id, name);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language plpgsql as $f$
  declare _parts text[];
  begin
    select string_to_array(name, '/') into _parts;
    return _parts[1:array_length(_parts, 1) - 1];
  end $f$;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
  grant execute on function storage.foldername(text) to anon, authenticated, service_role;
  create publication supabase_realtime;
`);
await pg.exec(`create schema if not exists net; create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb); create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $f$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $f$; create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text);`);
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql") && !/billing_cron|push_cron/.test(x)).sort()) {
  await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));
}

let pass = 0, fail = 0;
const ck = (l, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS" : "FAIL") + " - " + l + (c ? "" : " :: " + String(x).slice(0, 500))); };
async function as(role, uid, sql, params) {
  await pg.exec(`select set_config('request.jwt.claim.sub','${uid ?? ""}',false); set role ${role};`);
  try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, err: e.message }; }
  finally { await pg.exec("reset role;"); }
}
const su = async (sql, params) => { try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows }; } catch (e) { return { ok: false, err: e.message }; } };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const M = id(1), OWN = id(2), ADM = id(3);
await su(`insert into auth.users (id,email) values ('${M}','m@x.com'),('${OWN}','o@x.com'),('${ADM}','a@x.com')`);
await su(`insert into profiles (user_id,email) values ('${M}','m@x.com'),('${OWN}','o@x.com'),('${ADM}','a@x.com') on conflict do nothing`);
await su(`insert into platform_admins (user_id) values ('${M}')`);
const P = (sql, params) => as("authenticated", M, sql, params);
const PN = (sql, params) => as("authenticated", OWN, sql, params);
const PA = (sql, params) => as("anon", null, sql, params);
const no = (r) => !r.ok;
const errHas = (r, re) => !r.ok && re.test(r.err);
let n = 0;
const comp = async (name, doc = null) => (await su("insert into companies (name,slug,document) values ($1,$2,$3) returning id", [name, "m" + ++n, doc])).rows[0].id;
const join = (c, u, role) => su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
const pay = async (c) => { const s = (await su("select id from subscriptions where company_id=$1 and status<>'canceled'", [c])).rows[0]; const i = (await su("select id from invoices where subscription_id=$1 and kind='initial'", [s.id])).rows[0]; return P("select master_mark_invoice_paid($1,null)", [i.id]); };
const sum = async () => (await P("select * from master_list_companies_summary()")).rows;
const row = async (c) => (await sum()).find((r) => r.id === c);

// ---- 1) catálogo oficial
const allMods = (await su("select code,name,monthly_price_cents p,is_active a from modules order by code")).rows;
const mods = allMods.filter((m) => m.code !== "delivery" && m.code !== "whatsapp" && m.code !== "ia" && m.code !== "partial_payments"); // partial_payments: módulo-chave INATIVO, preço 0 (20261215010000; testado em partial-payments-read-model.mjs); delivery: módulo criado inativo, preço 0 (20261014020000); testado em delivery-structure.mjs
ck("1. catálogo: exatamente os 4 módulos oficiais com os preços certos, todos ativos", JSON.stringify(mods.map((m) => [m.code, m.p, m.a])) === JSON.stringify([["estoque", 1990, true], ["financeiro", 2490, true], ["impressao", 1490, true], ["producao", 1990, true]]) && mods.find((m) => m.code === "producao").name === "Produção / KDS" && mods.find((m) => m.code === "impressao").name === "Impressão Avançada", JSON.stringify(mods));
ck("1b. núcleo NÃO é módulo pago (sem atendimento/comandas/pedidos/caixa/clientes/dashboard/configuracoes)", !mods.some((m) => /atendimento|comanda|pedido|caixa|cliente|dashboard|configura/.test(m.code)));

// legado: módulo antigo fica inativo; plano base antigo ganha nome/descrição; preço preservado; rodar de novo é idempotente
const baseId = (await su("insert into plans (code,name,description,monthly_price_cents) values ('base','Base','Inclui orçamentos',7990) returning id")).rows[0].id;
await su("insert into modules (code,name,monthly_price_cents) values ('legacy','Legado',500)");
const mig = fs.readFileSync(path.join(dir, "20261005040000_master_commercial.sql"), "utf8");
const seed = mig.slice(mig.indexOf("-- 1) Catálogo oficial"), mig.indexOf("-- 2) KPIs"));
const run = async (q) => { try { await pg.exec(q); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; } };
const r1 = await run(seed);
ck("1c. reaplicar o seed: ok, legado inativado, base renomeado/descrito, preço 7990 preservado, nada duplicado", r1.ok && (await su("select is_active a from modules where code='legacy'")).rows[0].a === false && (await su("select name from plans where code='base'")).rows[0].name === "PLANO BASE" && (await su("select monthly_price_cents p from plans where code='base'")).rows[0].p === 7990 && (await su("select count(*)::int n from modules where code in ('financeiro','producao','estoque','impressao')")).rows[0].n === 4, r1.err);
await su("update modules set monthly_price_cents=2000 where code='estoque'");
await run(seed);
ck("1d. seed NÃO sobrescreve preço ajustado pelo Master", (await su("select monthly_price_cents p from modules where code='estoque'")).rows[0].p === 2000);
await su("update modules set monthly_price_cents=1990 where code='estoque'");
const mid = Object.fromEntries((await su("select code,id from modules where code in ('financeiro','producao','estoque','impressao')")).rows.map((r) => [r.code, r.id]));

// ---- 2) cenários de empresas
const cBase = await comp("Só Base", "11222333000181");
const cFin = await comp("Base+Financeiro");
const cFinProd = await comp("Base+Fin+Prod");
const cFull = await comp("Completo");
const cTrial = await comp("Em Trial");
const cNone = await comp("Sem Assinatura");
const cPend = await comp("Aguardando");
await join(cBase, OWN, "owner"); await join(cBase, ADM, "admin");
const sub = (c, extras) => P("select * from master_subscribe_company($1,$2,$3::uuid[])", [c, baseId, extras]);
for (const [c, ex] of [[cBase, []], [cFin, [mid.financeiro]], [cFinProd, [mid.financeiro, mid.producao]], [cFull, Object.values(mid)]]) {
  const s = await sub(c, ex); if (!s.ok) { console.log("SETUP", s.err); process.exit(2); }
  const p = await pay(c); if (!p.ok) { console.log("SETUP pay", p.err); process.exit(2); }
}
const sp = await sub(cPend, [mid.estoque]); if (!sp.ok) { console.log("SETUP", sp.err); process.exit(2); }
const t = await P("select * from master_start_trial($1)", [cTrial]); if (!t.ok) { console.log("SETUP trial", t.err); process.exit(2); }

const totals = async (c) => (await row(c)).monthly_total_cents;
ck("2. exemplos: base 79,90 · +Financeiro 104,80 · +Fin+Prod 124,70 · completo 159,50", (await totals(cBase)) === 7990 && (await totals(cFin)) === 10480 && (await totals(cFinProd)) === 12470 && (await totals(cFull)) === 15950, JSON.stringify([await totals(cBase), await totals(cFin), await totals(cFinProd), await totals(cFull)]));
ck("2b. lista: sem assinatura → total nulo; trial sem total; pendente = base+estoque", (await totals(cNone)) === null && (await totals(cTrial)) === null && (await totals(cPend)) === 7990 + 1990);
const rf = await row(cFull);
ck("2c. lista: plano, status, módulos ativos, usuários", rf.plan_name === "PLANO BASE" && rf.subscription_status === "active" && rf.active_module_names.length === 4 && Number((await row(cBase)).member_count) === 2, JSON.stringify(rf));
ck("2d. trial: estado trialing na lista, sem assinatura", (await row(cTrial)).trial_state === "trialing" && (await row(cTrial)).subscription_status === null);
ck("2e. vencimento: pendente mostra a cobrança inicial em aberto; paga não mostra", (await row(cPend)).next_due_date !== null && (await row(cBase)).next_due_date === null);

// ---- 3) KPIs
const ov = (await P("select master_get_commercial_overview() o")).rows[0].o;
ck("3. KPIs: 7 empresas, 1 trial, 4 ativas, 1 bloqueada (aguardando pagamento), 2 usuários", ov.total_companies === 7 && ov.trialing_companies === 1 && ov.active_subscriptions === 4 && ov.blocked_subscriptions === 1 && ov.total_users === 2, JSON.stringify(ov));
ck("3b. MRR = só ativas pagas: 79,90+104,80+124,70+159,50 (trial e pendente fora)", ov.mrr_cents === 7990 + 10480 + 12470 + 15950, ov.mrr_cents);
const sFin = (await su("select id from subscriptions where company_id=$1", [cFin])).rows[0].id;
await P("select master_set_subscription_status($1,'past_due',null)", [sFin]);
const ov2 = (await P("select master_get_commercial_overview() o")).rows[0].o;
ck("3c. past_due sai do MRR e conta como bloqueada/inadimplente", ov2.mrr_cents === ov.mrr_cents - 10480 && ov2.blocked_subscriptions === 2 && ov2.active_subscriptions === 3, JSON.stringify(ov2));
await P("select master_set_subscription_status($1,'active',null)", [sFin]);

// ---- 4) módulos: ativar/desativar sem apagar histórico
const sFull = (await su("select id from subscriptions where company_id=$1", [cFull])).rows[0].id;
const off = await P("select master_set_subscription_modules($1,$2::uuid[])", [sFull, [mid.financeiro, mid.producao]]);
ck("4. desativar impressão+estoque: total cai para 124,70; linhas viram histórico (não são apagadas)", off.ok && (await totals(cFull)) === 12470 && (await su("select count(*)::int n from subscription_modules where subscription_id=$1 and removed_at is not null", [sFull])).rows[0].n === 2, off.err);
await P("select master_set_subscription_modules($1,$2::uuid[])", [sFull, Object.values(mid)]);
ck("4b. reativar: volta a 159,50", (await totals(cFull)) === 15950);
const legacy = (await su("select id from modules where code='legacy'")).rows[0].id;
ck("4c. módulo legado inativo não pode ser contratado", errHas(await P("select master_set_subscription_modules($1,$2::uuid[])", [sFull, [...Object.values(mid), legacy]]), /inativo/));

// ---- 5) editar empresa
const upd = (c, o = {}) => P("select master_update_company($1,$2,$3,$4,$5,$6) j", [c, o.name ?? "Só Base Ltda", o.doc ?? "11.222.333/0001-81", o.phone ?? "(11) 3333-4444", o.wa ?? "+55 11 98888-7777", o.email ?? " Contato@X.COM "]);
const before = (await su("select slug, access_code from companies where id=$1", [cBase])).rows[0];
const u1 = await upd(cBase);
const after = (await su("select name, document, phone, whatsapp, email, slug, access_code from companies where id=$1", [cBase])).rows[0];
ck("5. Master edita nome/doc/telefone/WhatsApp/e-mail normalizados; slug e access_code intactos", u1.ok && after.name === "Só Base Ltda" && after.document === "11222333000181" && after.phone === "1133334444" && after.whatsapp === "5511988887777" && after.email === "contato@x.com" && after.slug === before.slug && after.access_code === before.access_code, u1.err);
ck("5b. validações: nome vazio, doc inválido, telefone, e-mail, empresa inexistente", errHas(await upd(cBase, { name: " " }), /nome/) && errHas(await upd(cBase, { doc: "11.222.333/0001-82" }), /inválido/) && errHas(await upd(cBase, { phone: "12" }), /Telefone/) && errHas(await upd(cBase, { email: "x" }), /E-mail/) && errHas(await upd(id(999)), /não encontrada/));
const contact = (await P("select master_get_company_contact($1) j", [cBase])).rows[0].j;
ck("5c. contato lido pelo Master", contact.phone === "1133334444" && contact.email === "contato@x.com");
ck("5d. editar não toca assinatura nem usuários", (await totals(cBase)) === 7990 && Number((await row(cBase)).member_count) === 2);

// ---- 6) configurações comerciais (leitura)
const cs = (await P("select master_get_commercial_settings() j")).rows[0].j;
ck("6. configurações: trial 7, carência 3, base 79,90, módulos 79,60, total 159,50", cs.trial_days === 7 && cs.grace_days === 3 && cs.base_price_cents === 7990 && cs.modules_total_cents === 7960 && cs.full_total_cents === 15950, JSON.stringify(cs));

// ---- 7) faturas: filtros existentes
const invs = (await P("select * from master_list_invoices()")).rows;
ck("7. faturas: 5 cobranças iniciais com empresa, tipo, competência, vencimento, valor e status", invs.length === 5 && invs.every((i) => i.company_name && i.kind === "initial" && i.due_date && i.amount_cents > 0 && i.status), JSON.stringify(invs.length));
ck("7b. filtro por status e por empresa", (await P("select * from master_list_invoices(null,'paid')")).rows.length === 4 && (await P("select * from master_list_invoices(null,'open')")).rows.length === 1 && (await P("select * from master_list_invoices($1)", [cFull])).rows.length === 1);

// ---- 8) segurança / isolamento
const fns = ["master_get_commercial_overview()", "master_list_companies_summary()", `master_update_company('${cBase}','x',null,null,null,null)`, `master_get_company_contact('${cBase}')`, "master_get_commercial_settings()"];
for (const f of fns) {
  const own = await PN(`select * from ${f}`), anon = await PA(`select * from ${f}`);
  ck(`8. ${f.split("(")[0]}: dono comum e anon negados`, no(own) && no(anon), (own.err ?? "ok") + " | " + (anon.err ?? "ok"));
}
ck("8b. dono/admin comum não lê tabelas comerciais", no(await PN("select * from subscriptions")) && no(await PN("select * from invoices")) && no(await PN("select * from plans")) && no(await PN("select * from modules")) && no(await PN("select * from company_trials")));
ck("8c. dono comum não edita plano/módulo nem assinatura", no(await PN("select master_upsert_module(null,'x','X','',100,true)")) && no(await PN("select master_upsert_plan(null,'x','X','',100,true)")) && no(await PN(`select master_set_subscription_modules('${sFull}','{}'::uuid[])`)) && no(await PN(`select master_set_subscription_status('${sFull}','suspended',null)`)));
ck("8d. dono comum não edita a própria empresa via RPC Master", no(await PN(`select master_update_company('${cBase}','Hack',null,null,null,null)`)) && (await su("select name from companies where id=$1", [cBase])).rows[0].name === "Só Base Ltda");
ck("8e. ACL: RPCs novas sem EXECUTE para anon/public", (await su(`select count(*)::int n from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('master_get_commercial_overview','master_list_companies_summary','master_update_company','master_get_company_contact','master_get_commercial_settings') and (has_function_privilege('anon', p.oid,'execute') or has_function_privilege('public', p.oid,'execute'))`)).rows[0].n === 0);
ck("8f. sem exclusão física: nenhuma RPC Master apaga empresa", (await su("select count(*)::int n from pg_proc where proname ~ '^master_.*(delete|remove|drop)'")).rows[0].n === 0);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
