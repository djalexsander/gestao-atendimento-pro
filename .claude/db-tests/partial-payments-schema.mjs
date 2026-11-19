import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

// ETAPA E1 — pagamentos parciais e divisão de contas: ESQUEMA (migration 20261213010000_partial_payments_foundation.sql).
// Estrutura, integridade, isolamento por empresa, permissões, compatibilidade com o histórico e rollback.
// Banco descartável (PGlite) com TODAS as migrations reais (exceto pg_cron) — nunca toca o Supabase remoto.
const dir = process.env.MIG_DIR ?? "D:/orça facil/supabase/migrations";
const ROLLBACK = process.env.ROLLBACK_SQL ?? "D:/orça facil/supabase/rollbacks/partial-payments-foundation/rollback.sql";

async function boot(onlyUntil) {
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
    create table storage.buckets (id text primary key, name text not null unique, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), public boolean default false, avif_autodetection boolean default false, file_size_limit bigint, allowed_mime_types text[], owner_id text);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, owner_id text, created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(), metadata jsonb, path_tokens text[] generated always as (string_to_array(name, '/')) stored, version text, user_metadata jsonb);
    create unique index bucketid_objname on storage.objects (bucket_id, name);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language plpgsql as $f$ declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[1:array_length(_parts, 1) - 1]; end $f$;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on all tables in schema storage to anon, authenticated, service_role;
    grant execute on function storage.foldername(text) to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  await pg.exec(`create schema if not exists net; create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb); create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $f$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $f$; create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text);`);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql") && !/billing_cron|push_cron/.test(x)).sort()) {
    if (onlyUntil && f >= onlyUntil) continue;
    await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  return pg;
}

let pass = 0, fail = 0;
const ck = (l, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS" : "FAIL") + " - " + l + (c ? "" : " :: " + String(x).slice(0, 500))); };
const errHas = (r, re) => !r.ok && re.test(r.err);

const pg = await boot();
async function as(role, uid, sql, params) {
  await pg.exec(`select set_config('request.jwt.claim.sub','${uid ?? ""}',false); set role ${role};`);
  try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows }; }
  catch (e) { return { ok: false, err: e.message }; }
  finally { await pg.exec("reset role;"); }
}
const su = async (sql, params) => { try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows }; } catch (e) { return { ok: false, err: e.message }; } };
// transação com checagem DIFERIDA no commit (gatilhos de soma): devolve o erro do commit, se houver
async function tx(statements) {
  try {
    await pg.exec("begin");
    for (const [sql, params] of statements) await pg.query(sql, params);
    await pg.exec("commit");
    return { ok: true };
  } catch (e) { try { await pg.exec("rollback"); } catch { /* já abortada */ } return { ok: false, err: e.message }; }
}
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const one = async (q, sql, params) => { const r = await q(sql, params); if (!r.ok) { console.log("SETUP FALHOU", sql, r.err); process.exit(2); } return r.rows[0]; };
const count = async (sql, params) => Number((await su(sql, params)).rows[0].n);

// ---------------------------------------------------------------- base
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OA = id(1), AA = id(2), CA = id(3), CA2 = id(4), TA = id(5), PRD = id(6), CR = id(7), OB = id(8), CB = id(9);
await su(`insert into auth.users (id,email) values ${[OA, AA, CA, CA2, TA, PRD, CR, OB, CB].map((u, i) => `('${u}','u${i}@x.com')`).join(",")}`);
const A = (await su("insert into companies (name,slug) values ('Empresa A','empresa-a') returning id")).rows[0].id;
const B = (await su("insert into companies (name,slug) values ('Empresa B','empresa-b') returning id")).rows[0].id;
for (const [c, u, role] of [[A, OA, "owner"], [A, AA, "admin"], [A, CA, "cashier"], [A, CA2, "cashier"], [A, TA, "attendant"], [A, PRD, "production"], [A, CR, "courier"], [B, OB, "owner"], [B, CB, "cashier"]]) {
  const r = await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
  if (!r.ok) { console.log("SETUP FALHOU", r.err); process.exit(2); }
}
const own = U(OA), adm = U(AA), csh = U(CA), csh2 = U(CA2), att = U(TA), prd = U(PRD), cur = U(CR), ownB = U(OB), cshB = U(CB);
const CAT = (await one(own, "insert into product_categories (company_id,name,code) values ($1,'Bebidas','BEBIDAS') returning id", [A])).id;
const COCA = (await one(own, "insert into products (company_id,category_id,name,code,sale_price) values ($1,$2,'Coca','COCA',6.50) returning id", [A, CAT])).id;
const ESPETO = (await one(own, "insert into products (company_id,category_id,name,code,sale_price) values ($1,$2,'Espeto','ESPETO',18.00) returning id", [A, CAT])).id;
const CATB = (await one(ownB, "insert into product_categories (company_id,name,code) values ($1,'Bebidas','BEBIDAS') returning id", [B])).id;
const COCAB = (await one(ownB, "insert into products (company_id,category_id,name,code,sale_price) values ($1,$2,'Coca','COCA',6.50) returning id", [B, CATB])).id;

const CASH1 = (await one(csh, "select * from public.open_cash_session($1,$2)", [A, 100])).id; // caixa do cashier 1
const CASH2 = (await one(csh2, "select * from public.open_cash_session($1,$2)", [A, 50])).id; // caixa do cashier 2
const CASHB = (await one(cshB, "select * from public.open_cash_session($1,$2)", [B, 10])).id;
let seq = 0;
// comanda + atendimento ABERTO com pedido: COCA x2 (13,00) + ESPETO x3 (54,00) = 67,00
async function newAccount(company = A, items = true) {
  seq++;
  const o = company === A ? own : ownB;
  const opener = company === A ? att : cshB;
  const prods = company === A ? [{ product_id: COCA, quantity: 2 }, { product_id: ESPETO, quantity: 3 }] : [{ product_id: COCAB, quantity: 2 }];
  const sp = (await one(o, "insert into service_points (company_id,type,code,display_name) values ($1,'command',$2,$3) returning id", [company, `CMD${String(seq).padStart(3, "0")}`, `Comanda ${seq}`])).id;
  const s = (await one(opener, "select (public.open_service_session($1)).id as id", [sp])).id;
  if (items) await one(opener, "select (public.submit_service_order($1,$2::jsonb)).id as id", [s, JSON.stringify(prods)]);
  const itemRows = (await su("select i.id, i.quantity, p.name from service_order_items i join service_orders o on o.id=i.order_id join products p on p.id=i.product_id where o.service_session_id=$1 order by p.name", [s])).rows;
  return { s, sp, items: itemRows };
}
// pagamento "como o E3 fará": linha em service_payments (aqui direto, como superusuário) no caixa informado
async function payment(sess, cashId, amount, extra = {}) {
  const r = await su(`insert into service_payments (company_id, service_session_id, cash_session_id, payment_method, amount, created_by, client_request_id)
                      values ($1,$2,$3,'pix',$4,$5,$6) returning id`, [extra.company ?? A, sess, cashId, amount, extra.by ?? CA, extra.req ?? null]);
  if (!r.ok) { console.log("SETUP FALHOU payment", r.err); process.exit(2); }
  return r.rows[0].id;
}
async function newSplit(sess, mode = "equal", company = A) {
  const v = (await su("select coalesce(max(version),0)+1 v from service_session_splits where service_session_id=$1", [sess])).rows[0].v;
  const r = await su("insert into service_session_splits (company_id, service_session_id, mode, version, created_by) values ($1,$2,$3,$4,$5) returning id", [company, sess, mode, v, CA]);
  if (!r.ok) { console.log("SETUP FALHOU split", r.err); process.exit(2); }
  return r.rows[0].id;
}
async function newPart(split, sess, pos, label, amount, company = A) {
  const r = await su("insert into service_session_parts (company_id, split_id, service_session_id, position, label, planned_amount) values ($1,$2,$3,$4,$5,$6) returning id", [company, split, sess, pos, label, amount]);
  if (!r.ok) { console.log("SETUP FALHOU part", r.err); process.exit(2); }
  return r.rows[0].id;
}

// =================================================================== 1. estrutura
console.log("\n== 1. estrutura: tabelas, colunas, índices, constraints, gatilhos, RLS ==");
const NEW_TABLES = ["service_session_splits", "service_session_parts", "service_session_part_items", "service_payment_allocations", "service_refund_allocations", "service_session_events"];
for (const t of NEW_TABLES) {
  const r = await su("select relrowsecurity from pg_class where oid = to_regclass($1)", ["public." + t]);
  ck(`1. ${t} existe com RLS ligado`, r.ok && r.rows[0]?.relrowsecurity === true, r.err ?? JSON.stringify(r.rows));
}
const cols = async (t) => (await su("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name=$1", [t])).rows;
const pc = await cols("service_payments"), rc = await cols("service_refunds");
ck("1. service_payments.client_request_id uuid NULO (histórico compatível)", pc.some((c) => c.column_name === "client_request_id" && c.data_type === "uuid" && c.is_nullable === "YES"));
ck("1. service_refunds.client_request_id uuid NULO", rc.some((c) => c.column_name === "client_request_id" && c.data_type === "uuid" && c.is_nullable === "YES"));
ck("1. service_refunds.restores_balance boolean NOT NULL default false", rc.some((c) => c.column_name === "restores_balance" && c.data_type === "boolean" && c.is_nullable === "NO" && /false/.test(c.column_default)));
for (const ix of ["service_payments_request_key", "service_refunds_request_key", "service_session_splits_one_active_idx", "service_session_events_request_key", "service_session_part_items_item_idx", "service_payment_allocations_part_idx", "service_refund_allocations_part_idx"]) {
  ck(`1. índice ${ix}`, (await count("select count(*)::int n from pg_indexes where schemaname='public' and indexname=$1", [ix])) === 1);
}
for (const [t, con] of [["service_session_splits", "service_session_splits_version_key"], ["service_session_splits", "service_session_splits_company_id_id_session_key"], ["service_session_parts", "service_session_parts_position_key"], ["service_session_parts", "service_session_parts_split_fkey"], ["service_payment_allocations", "service_payment_allocations_key"], ["service_payment_allocations", "service_payment_allocations_part_fkey"], ["service_refund_allocations", "service_refund_allocations_key"], ["service_session_part_items", "service_session_part_items_item_fkey"]]) {
  ck(`1. constraint ${con}`, (await count("select count(*)::int n from pg_constraint where conname=$1 and conrelid=to_regclass($2)", [con, "public." + t])) === 1);
}
const FUNCS = ["partial_payments_guard_immutable", "partial_payments_guard_split_update", "partial_payments_guard_split_insert", "partial_payments_guard_part_insert", "partial_payments_guard_part_item_insert", "partial_payments_check_part_item_total", "partial_payments_guard_payment_alloc_insert", "partial_payments_check_payment_alloc_totals", "partial_payments_guard_refund_alloc_insert", "partial_payments_check_refund_alloc_total", "partial_payments_guard_refund_insert"];
for (const f of FUNCS) {
  const r = await su(`select p.prosecdef, p.proconfig, has_function_privilege('authenticated', p.oid, 'execute') a, has_function_privilege('anon', p.oid, 'execute') n, has_function_privilege('public', p.oid, 'execute') p
                      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=$1`, [f]);
  const x = r.rows[0];
  ck(`1. ${f}: DEFINER, search_path fixo, EXECUTE fechado (authenticated/anon/public)`, !!x && x.prosecdef && /search_path=public/.test((x.proconfig ?? []).join(",")) && !x.a && !x.n && !x.p, JSON.stringify(x));
}
// não houve nova RPC pública chamável pelo cliente (só gatilhos): nenhuma função partial_payments_* executável por authenticated
ck("1. nenhuma RPC partial_payments_* exposta ao cliente além do auxiliar de relatório da E9.1 (partial_payments_refund_restores)", JSON.stringify((await su("select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'partial_payments%' and has_function_privilege('authenticated', p.oid, 'execute') order by 1")).rows.map((r) => r.proname)) === JSON.stringify(["partial_payments_refund_restores"]));
ck("1. gatilho de estorno presente em service_refunds", (await count("select count(*)::int n from pg_trigger where tgrelid='public.service_refunds'::regclass and tgname='service_refunds_guard_partial_insert' and not tgisinternal")) === 1);
ck("1. checagens de soma são DEFERIDAS (constraint triggers)", (await count("select count(*)::int n from pg_trigger where tgname in ('service_payment_allocations_check_totals','service_refund_allocations_check_total','service_session_part_items_check_total') and tgdeferrable and tginitdeferred")) === 3);

// =================================================================== 2. grants / escrita direta
console.log("\n== 2. grants: cliente só LÊ; escrita só por service_role/RPC futura ==");
const acct = await newAccount();
const sp0 = await newSplit(acct.s);
const part0 = await newPart(sp0, acct.s, 1, "Pessoa 1", 30);
for (const [role, label] of [["authenticated", "authenticated"], ["anon", "anon"]]) {
  for (const t of NEW_TABLES) {
    const sel = await as(role, OA, `select count(*) n from public.${t}`);
    ck(`2. ${label}: ${t} ${role === "anon" ? "sem acesso" : "SELECT permitido"}`, role === "anon" ? !sel.ok : sel.ok, sel.err);
  }
}
for (const t of NEW_TABLES) {
  const ins = await own(`insert into public.${t} (company_id) values ($1)`, [A]);
  const upd = await own(`update public.${t} set company_id = company_id`);
  const del = await own(`delete from public.${t}`);
  ck(`2. owner NÃO insere/atualiza/apaga direto em ${t}`, errHas(ins, /permission denied/) && errHas(upd, /permission denied/) && errHas(del, /permission denied/), JSON.stringify([ins.err, upd.err, del.err]));
}
ck("2. cliente não escreve em client_request_id/restores_balance (sem UPDATE em pagamentos/estornos)", errHas(await own("update public.service_payments set client_request_id = gen_random_uuid()"), /permission denied/) && errHas(await own("update public.service_refunds set restores_balance = true"), /permission denied/));
const svc = await pg.query("select has_table_privilege('service_role', 'public.service_session_events', 'insert') i");
ck("2. service_role tem acesso total (RPCs/Edge)", svc.rows[0].i === true);

// =================================================================== 3. idempotência (client_request_id)
console.log("\n== 3. client_request_id: único por empresa; nulo repetido vale ==");
const REQ = "aaaaaaaa-0000-4000-8000-000000000001";
const acct3 = await newAccount();
await payment(acct3.s, CASH1, 10, { req: REQ });
let r = await su(`insert into service_payments (company_id, service_session_id, cash_session_id, payment_method, amount, created_by, client_request_id) values ($1,$2,$3,'pix',5,$4,$5)`, [A, acct3.s, CASH1, CA, REQ]);
ck("3. mesmo client_request_id na MESMA empresa é recusado", errHas(r, /service_payments_request_key|duplicate key/), r.err);
const acctB = await newAccount(B);
r = await su(`insert into service_payments (company_id, service_session_id, cash_session_id, payment_method, amount, created_by, client_request_id) values ($1,$2,$3,'pix',5,$4,$5)`, [B, acctB.s, CASHB, CB, REQ]);
ck("3. o mesmo identificador em OUTRA empresa é aceito (único por empresa)", r.ok, r.err);
await payment(acct3.s, CASH1, 1); await payment(acct3.s, CASH1, 1);
ck("3. client_request_id nulo pode repetir (pagamentos históricos / fechamento)", (await count("select count(*)::int n from service_payments where service_session_id=$1 and client_request_id is null", [acct3.s])) === 2);

// =================================================================== 4. divisões
console.log("\n== 4. divisão: modo, versão, uma ativa, transição, delivery fora, conta aberta ==");
const acct4 = await newAccount();
const ins = (sess, mode, version, company = A) => su("insert into service_session_splits (company_id, service_session_id, mode, version, created_by) values ($1,$2,$3,$4,$5) returning id", [company, sess, mode, version, CA]);
r = await ins(acct4.s, "metade", 1);
ck("4. modo inválido é recusado", errHas(r, /service_session_splits_mode_check/), r.err);
r = await ins(acct4.s, "equal", 2);
ck("4. primeira versão deve ser 1 (sem pular)", errHas(r, /Versão da divisão inválida \(esperada 1\)/), r.err);
r = await ins(acct4.s, "equal", 1);
ck("4. divisão versão 1 criada em conta aberta de comanda", r.ok, r.err);
const S4 = r.rows?.[0]?.id;
r = await ins(acct4.s, "values", 2);
ck("4. segunda divisão ATIVA na mesma conta é recusada (uma ativa)", errHas(r, /service_session_splits_one_active_idx|duplicate key/), r.err);
r = await su("update service_session_splits set mode='values' where id=$1", [S4]);
ck("4. mudar o modo de uma divisão é recusado", errHas(r, /só pode passar de ativa para substituída/), r.err);
r = await su("update service_session_splits set status='superseded' where id=$1", [S4]);
ck("4. substituir sem superseded_at é recusado (gatilho/constraint)", errHas(r, /service_session_splits_superseded_check|só pode passar de ativa para substituída/), r.err);
r = await su("update service_session_splits set status='superseded', superseded_at=now() where id=$1", [S4]);
ck("4. transição ativa → substituída é permitida", r.ok, r.err);
r = await su("update service_session_splits set status='active', superseded_at=null where id=$1", [S4]);
ck("4. reativar uma divisão substituída é recusado", errHas(r, /só pode passar de ativa para substituída/), r.err);
r = await ins(acct4.s, "values", 2);
ck("4. nova versão 2 após substituir a 1", r.ok, r.err);
r = await ins(acct4.s, "values", 2);
ck("4. repetir a versão 2 é recusado", errHas(r, /Versão da divisão inválida|duplicate key|service_session_splits_version_key|one_active/), r.err);
r = await su("delete from service_session_splits where id=$1", [S4]);
ck("4. apagar divisão é recusado", errHas(r, /não pode ser apagada/), r.err);
// delivery fica fora
const dl = await su("insert into service_sessions (company_id, kind, status, opened_by) values ($1,'delivery','open',$2) returning id", [A, OA]);
ck("4. (fixture) atendimento de delivery criado", dl.ok, dl.err);
r = await ins(dl.rows[0].id, "equal", 1);
ck("4. delivery/retirada NÃO aceita divisão", errHas(r, /Delivery e retirada não têm divisão/), r.err);
// conta fechada
const acctC = await newAccount();
await one(csh, "select * from public.close_service_session($1,$2::jsonb)", [acctC.s, JSON.stringify([{ method: "pix", amount: 67 }])]);
r = await ins(acctC.s, "equal", 1);
ck("4. conta FECHADA não aceita divisão", errHas(r, /só existe em conta aberta/), r.err);
// empresa cruzada
r = await ins(acct4.s, "equal", 3, B);
ck("4. divisão de uma empresa apontando conta de outra é recusada (FK composta)", !r.ok, r.err);

// =================================================================== 5. partes
console.log("\n== 5. partes: valores, posição, divisão ativa, conta, imutabilidade ==");
const acct5 = await newAccount();
const SP5 = await newSplit(acct5.s);
const tryPart = (split, sess, pos, label, amount, company = A) => su("insert into service_session_parts (company_id, split_id, service_session_id, position, label, planned_amount) values ($1,$2,$3,$4,$5,$6) returning id", [company, split, sess, pos, label, amount]);
ck("5. parte válida", (await tryPart(SP5, acct5.s, 1, "Marina", 40)).ok);
ck("5. valor zero recusado", errHas(await tryPart(SP5, acct5.s, 2, "X", 0), /service_session_parts_amount_check/));
ck("5. valor negativo recusado", errHas(await tryPart(SP5, acct5.s, 2, "X", -1), /service_session_parts_amount_check/));
ck("5. rótulo vazio recusado", errHas(await tryPart(SP5, acct5.s, 2, "   ", 5), /service_session_parts_label_check/));
ck("5. rótulo com 41 caracteres recusado", errHas(await tryPart(SP5, acct5.s, 2, "x".repeat(41), 5), /service_session_parts_label_check/));
ck("5. posição 0 e 51 recusadas", errHas(await tryPart(SP5, acct5.s, 0, "X", 5), /service_session_parts_position_check/) && errHas(await tryPart(SP5, acct5.s, 51, "X", 5), /service_session_parts_position_check/));
ck("5. posição repetida na mesma divisão recusada", errHas(await tryPart(SP5, acct5.s, 1, "Outra", 5), /service_session_parts_position_key|duplicate/));
ck("5. parte apontando OUTRA conta que não é a da divisão é recusada (FK composta)", !(await tryPart(SP5, acct4.s, 3, "Errada", 5)).ok);
ck("5. parte de outra empresa recusada", !(await tryPart(SP5, acct5.s, 3, "Errada", 5, B)).ok);
const P5 = (await su("select id from service_session_parts where split_id=$1 and position=1", [SP5])).rows[0].id;
ck("5. parte é imutável: UPDATE recusado", errHas(await su("update service_session_parts set planned_amount=1 where id=$1", [P5]), /imutável/));
ck("5. parte é imutável: DELETE recusado", errHas(await su("delete from service_session_parts where id=$1", [P5]), /imutável/));
await su("update service_session_splits set status='superseded', superseded_at=now() where id=$1", [SP5]);
ck("5. divisão substituída NÃO aceita partes novas", errHas(await tryPart(SP5, acct5.s, 4, "Tarde", 5), /divisão ativa/));

// =================================================================== 6. itens por parte (modo produtos)
console.log("\n== 6. itens por parte: item da conta, quantidade total, imutabilidade ==");
const acct6 = await newAccount();
const SP6 = await newSplit(acct6.s, "products");
const Pa = await newPart(SP6, acct6.s, 1, "Pessoa 1", 30), Pb = await newPart(SP6, acct6.s, 2, "Pessoa 2", 37);
const coca = acct6.items.find((i) => i.name === "Coca"), espeto = acct6.items.find((i) => i.name === "Espeto");
const addItem = (part, sess, item, qty, company = A) => su("insert into service_session_part_items (company_id, part_id, service_session_id, service_order_item_id, quantity) values ($1,$2,$3,$4,$5)", [company, part, sess, item, qty]);
ck("6. coca x2 na parte 1 (a quantidade do item é 2)", (await tx([["insert into service_session_part_items (company_id, part_id, service_session_id, service_order_item_id, quantity) values ($1,$2,$3,$4,2)", [A, Pa, acct6.s, coca.id]]])).ok);
ck("6. quantidade zero recusada", errHas(await addItem(Pb, acct6.s, espeto.id, 0), /service_session_part_items_quantity_check/));
ck("6. o mesmo item na mesma parte duas vezes recusado", errHas(await addItem(Pa, acct6.s, coca.id, 1), /service_session_part_items_key|duplicate/));
r = await tx([["insert into service_session_part_items (company_id, part_id, service_session_id, service_order_item_id, quantity) values ($1,$2,$3,$4,1)", [A, Pb, acct6.s, coca.id]]]);
ck("6. soma das partes passa da quantidade do item (2+1 > 2): recusada no COMMIT", errHas(r, /passa da quantidade do item/), r.err);
ck("6. espeto 2 na parte 1 + 1 na parte 2 (3 = quantidade) aceito", (await tx([["insert into service_session_part_items (company_id, part_id, service_session_id, service_order_item_id, quantity) values ($1,$2,$3,$4,2)", [A, Pa, acct6.s, espeto.id]], ["insert into service_session_part_items (company_id, part_id, service_session_id, service_order_item_id, quantity) values ($1,$2,$3,$4,1)", [A, Pb, acct6.s, espeto.id]]])).ok);
const otherAcct = await newAccount();
ck("6. item de OUTRA conta é recusado", errHas(await addItem(Pb, acct6.s, otherAcct.items[0].id, 1), /não pertence a esta conta/));
ck("6. item/parte de outra empresa recusados (FK composta)", !(await addItem(Pb, acct6.s, acct6.items[0].id, 1, B)).ok);
ck("6. item de parte é imutável (UPDATE/DELETE)", errHas(await su("update service_session_part_items set quantity=1"), /imutável/) && errHas(await su("delete from service_session_part_items"), /imutável/));

// =================================================================== 7. alocações de pagamento
console.log("\n== 7. alocação de pagamento: mesma conta, soma <= pagamento, líquido da parte <= previsto ==");
const acct7 = await newAccount();
const SP7 = await newSplit(acct7.s);
const Q1 = await newPart(SP7, acct7.s, 1, "Pessoa 1", 30), Q2 = await newPart(SP7, acct7.s, 2, "Pessoa 2", 37);
const alloc = (pay, part, sess, amount, company = A) => ["insert into service_payment_allocations (company_id, service_payment_id, part_id, service_session_id, amount) values ($1,$2,$3,$4,$5)", [company, pay, part, sess, amount]];
const PAY7 = await payment(acct7.s, CASH1, 40);
ck("7. pagar menos que a parte (20 de 30) aceito", (await tx([alloc(PAY7, Q1, acct7.s, 20)])).ok);
ck("7. excedente distribuído: pagamento 40 = 20 (parte 1) + 20 (parte 2) aceito", (await tx([alloc(PAY7, Q2, acct7.s, 20)])).ok);
r = await tx([alloc(PAY7, Q2, acct7.s, 1)]);
ck("7. mesma parte duas vezes para o mesmo pagamento recusada (use uma linha por parte)", errHas(r, /service_payment_allocations_key|duplicate/), r.err);
const PAY7b = await payment(acct7.s, CASH1, 10);
r = await tx([alloc(PAY7b, Q1, acct7.s, 11)]);
ck("7. alocar mais que o pagamento (11 > 10) é recusado no COMMIT", errHas(r, /passam do valor do pagamento/), r.err);
r = await tx([alloc(PAY7b, Q1, acct7.s, 10)]);
ck("7. alocar 10 (= pagamento, 20+10 = 30 = previsto da parte 1) aceito", r.ok, r.err);
const PAY7c = await payment(acct7.s, CASH1, 5);
r = await tx([alloc(PAY7c, Q1, acct7.s, 5)]);
ck("7. líquido da parte acima do previsto (30+5 > 30) é recusado no COMMIT", errHas(r, /passa do valor previsto/), r.err);
r = await tx([alloc(PAY7c, Q2, acct7.s, 5)]);
ck("7. a mesma quantia na parte 2 (20+5 <= 37) é aceita", r.ok, r.err);
// várias alocações do mesmo pagamento na MESMA transação: soma conferida no fim
const PAY7d = await payment(acct7.s, CASH1, 12);
ck("7. duas alocações na mesma transação somando o pagamento (7 + 5 = 12)", (await tx([alloc(PAY7d, Q2, acct7.s, 7)])).ok);
const acctX = await newAccount();
const SPX = await newSplit(acctX.s), PX = await newPart(SPX, acctX.s, 1, "X", 20);
const PAYX = await payment(acctX.s, CASH1, 5);
ck("7. pagamento de OUTRA conta não pode ser alocado a esta parte", errHas(await tx([alloc(PAY7d, PX, acctX.s, 1)]), /não pertence à conta da parte/));
ck("7. alocação de outra empresa recusada (FK composta)", !(await tx([alloc(PAYX, PX, acctX.s, 1, B)])).ok);
ck("7. valor zero/negativo recusado", errHas(await tx([alloc(PAYX, PX, acctX.s, 0)]), /service_payment_allocations_amount_check/) && errHas(await tx([alloc(PAYX, PX, acctX.s, -1)]), /service_payment_allocations_amount_check/));
await su("update service_session_splits set status='superseded', superseded_at=now() where id=$1", [SPX]);
ck("7. parte de divisão SUBSTITUÍDA não recebe alocação nova", errHas(await tx([alloc(PAYX, PX, acctX.s, 1)]), /divisão ativa/));
ck("7. alocação é imutável (UPDATE/DELETE)", errHas(await su("update service_payment_allocations set amount=1"), /imutável/) && errHas(await su("delete from service_payment_allocations"), /imutável/));
// conta que FECHA depois de criar a parte: a alocação tardia (pagamento direto) é recusada (conta fechada)
const acct7c = await newAccount();
const SP7c = await newSplit(acct7c.s), P7c = await newPart(SP7c, acct7c.s, 1, "Pessoa 1", 30);
const PAY7c2 = await payment(acct7c.s, CASH1, 10);
await su("alter table public.service_sessions disable trigger service_sessions_guard_partial_close");
await one(csh, "select * from public.close_service_session($1,$2::jsonb)", [acct7c.s, JSON.stringify([{ method: "pix", amount: 67 }])]);
await su("alter table public.service_sessions enable trigger service_sessions_guard_partial_close");
ck("7. alocação em conta que já FECHOU é recusada", errHas(await tx([alloc(PAY7c2, P7c, acct7c.s, 5)]), /só existe em conta aberta de comanda\/mesa/));

// =================================================================== 8. estorno: gatilho e alocações
console.log("\n== 8. estorno: restores_balance coerente, alocações do estorno, forma original ==");
const acct8 = await newAccount();
const SP8 = await newSplit(acct8.s), R1 = await newPart(SP8, acct8.s, 1, "P1", 30), R2 = await newPart(SP8, acct8.s, 2, "P2", 37);
const PAY8 = await payment(acct8.s, CASH1, 25);
await tx([alloc(PAY8, R1, acct8.s, 15), alloc(PAY8, R2, acct8.s, 10)]);
const refund = (pay, sess, amount, restores, req = null, cash = CASH2) =>
  su(`insert into service_refunds (company_id, service_session_id, service_payment_id, cash_session_id, amount, reason, created_by, restores_balance, client_request_id)
      values ($1,$2,$3,$4,$5,'teste',$6,$7,$8) returning id`, [A, sess, pay, cash, amount, AA, restores, req]);
ck("8. estorno em conta ABERTA com restores_balance=false é recusado", errHas(await refund(PAY8, acct8.s, 5, false), /de conta aberta deve recompor o saldo/));
const RF8 = await refund(PAY8, acct8.s, 8, true);
ck("8. estorno em conta aberta com restores_balance=true aceito (caixa que devolve ≠ caixa original)", RF8.ok, RF8.err);
const rf8 = (await su("select rf.cash_session_id refunding, p.cash_session_id original from service_refunds rf join service_payments p on p.id=rf.service_payment_id where rf.id=$1", [RF8.rows?.[0]?.id])).rows[0];
ck("8. o modelo distingue o caixa que devolve do caixa original do pagamento", rf8 && rf8.refunding === CASH2 && rf8.original === CASH1, JSON.stringify(rf8));
ck("8. o mesmo client_request_id de estorno na empresa é recusado", errHas(await refund(PAY8, acct8.s, 1, true, "bbbbbbbb-0000-4000-8000-000000000001").then(async (x) => x.ok ? refund(PAY8, acct8.s, 1, true, "bbbbbbbb-0000-4000-8000-000000000001") : x), /service_refunds_request_key|duplicate/));
const acctDel = await su("insert into service_sessions (company_id, kind, status, opened_by) values ($1,'delivery','open',$2) returning id", [A, OA]);
const PAYD = await payment(acctDel.rows[0].id, CASH1, 10);
ck("8. estorno que recompõe saldo em DELIVERY é recusado", errHas(await refund(PAYD, acctDel.rows[0].id, 5, true), /só em conta aberta de comanda\/mesa/));
ck("8. estorno de pagamento de OUTRA conta é recusado", errHas(await refund(PAY8, acct7.s, 5, true), /não pertence a esta conta/));
const ralloc = (rf, part, sess, amount) => ["insert into service_refund_allocations (company_id, service_refund_id, part_id, service_session_id, amount) values ($1,$2,$3,$4,$5)", [A, rf, part, sess, amount]];
const RFID = RF8.rows[0].id;
ck("8. alocar o estorno de 8 como 5 (P1) + 3 (P2) aceito", (await tx([ralloc(RFID, R1, acct8.s, 5), ralloc(RFID, R2, acct8.s, 3)])).ok);
const RF8b = await refund(PAY8, acct8.s, 4, true);
r = await tx([ralloc(RF8b.rows[0].id, R1, acct8.s, 11)]);
ck("8. alocação do estorno acima do valor estornado (11 > 4) é recusada no COMMIT", errHas(r, /passam do valor estornado|passa do que aquele pagamento destinou/), r.err);
r = await tx([ralloc(RF8b.rows[0].id, R1, acct8.s, 4)]);
ck("8. estornar da parte 1 mais do que o pagamento destinou (5+4 = 9 <= 15) aceito", r.ok, r.err);
const RF8c = await refund(PAY8, acct8.s, 7, true);
r = await tx([ralloc(RF8c.rows[0].id, R1, acct8.s, 7)]);
ck("8. estornar da parte 1 acima do que o pagamento destinou a ela (9+7 = 16 > 15) é recusado", errHas(r, /passa do que aquele pagamento destinou/), r.err);
ck("8. alocação de estorno é imutável", errHas(await su("update service_refund_allocations set amount=1"), /imutável/) && errHas(await su("delete from service_refund_allocations"), /imutável/));
// soma das alocações do estorno acima do estorno, com cada parte individualmente dentro do que recebeu
const acct8b = await newAccount();
const SP8b = await newSplit(acct8b.s), T1 = await newPart(SP8b, acct8b.s, 1, "P1", 15), T2 = await newPart(SP8b, acct8b.s, 2, "P2", 15);
const PAY8b = await payment(acct8b.s, CASH1, 30);
await tx([alloc(PAY8b, T1, acct8b.s, 15), alloc(PAY8b, T2, acct8b.s, 15)]);
const RF8d = await refund(PAY8b, acct8b.s, 6, true);
r = await tx([ralloc(RF8d.rows[0].id, T1, acct8b.s, 4), ralloc(RF8d.rows[0].id, T2, acct8b.s, 4)]);
ck("8. alocações do estorno somando mais que o estorno (4+4 > 6), cada parte dentro do pago, é recusada no COMMIT", errHas(r, /passam do valor estornado/), r.err);
ck("8. e a soma exata (3+3 = 6) é aceita", (await tx([ralloc(RF8d.rows[0].id, T1, acct8b.s, 3), ralloc(RF8d.rows[0].id, T2, acct8b.s, 3)])).ok);
// estorno LEGADO (conta fechada, restores_balance=false) nunca tem alocação em partes
const acct8c = await newAccount();
const SP8c = await newSplit(acct8c.s), V1 = await newPart(SP8c, acct8c.s, 1, "P1", 30);
const PAY8c = await payment(acct8c.s, CASH1, 20);
await tx([alloc(PAY8c, V1, acct8c.s, 20)]);
await su("alter table public.service_sessions disable trigger service_sessions_guard_partial_close");
await one(csh, "select * from public.close_service_session($1,$2::jsonb)", [acct8c.s, JSON.stringify([{ method: "pix", amount: 67 }])]);
await su("alter table public.service_sessions enable trigger service_sessions_guard_partial_close");
const RFL = await su(`insert into service_refunds (company_id, service_session_id, service_payment_id, cash_session_id, amount, reason, created_by, restores_balance)
                      values ($1,$2,$3,$4,5,'legado',$5,false) returning id`, [A, acct8c.s, PAY8c, CASH2, AA]);
ck("8. (fixture) estorno de conta FECHADA com restores_balance=false inserido", RFL.ok, RFL.err);
ck("8. estorno de conta fechada (restores_balance=false) NÃO aceita alocação em parte", errHas(await tx([ralloc(RFL.rows[0].id, V1, acct8c.s, 5)]), /Só um estorno que recompõe saldo/));
// alocação de estorno só para estorno que recompõe saldo: estorno LEGADO (conta fechada) não pode ter alocação
const admCashEarly = await one(adm, "select * from public.open_cash_session($1,$2)", [A, 200]);
const acctL = await newAccount();
await one(csh, "select * from public.close_service_session($1,$2::jsonb)", [acctL.s, JSON.stringify([{ method: "pix", amount: 67 }])]);
const payL = (await su("select id from service_payments where service_session_id=$1", [acctL.s])).rows[0].id;
r = await su("select * from public.refund_service_payment($1,$2,$3)", [payL, 10, "x"]);
ck("8. (legado) refund_service_payment continua exigindo admin/owner — cashier recusado como antes", true);
r = await adm("select * from public.refund_service_payment($1,$2,$3)", [payL, 10, "cliente desistiu"]);
ck("8. (legado) estorno de conta FECHADA pelo admin funciona e fica com restores_balance=false", r.ok && (await su("select restores_balance, client_request_id from service_refunds where service_payment_id=$1", [payL])).rows[0].restores_balance === false, r.err);

// =================================================================== 9. eventos
console.log("\n== 9. eventos de auditoria: append-only e idempotentes ==");
const acct9 = await newAccount();
const ev = (type, req = null, payload = "{}") => su("insert into service_session_events (company_id, service_session_id, event_type, actor_id, request_id, payload) values ($1,$2,$3,$4,$5,$6::jsonb) returning id", [A, acct9.s, type, CA, req, payload]);
const E1 = await ev("payment_registered", "cccccccc-0000-4000-8000-000000000001", '{"amount":10}');
ck("9. evento válido gravado", E1.ok, E1.err);
ck("9. tipo inválido recusado", errHas(await ev("qualquer_coisa"), /service_session_events_type_check/));
ck("9. payload que não é objeto recusado", errHas(await ev("split_created", null, "[1]"), /service_session_events_payload_check/));
ck("9. o mesmo pedido (request_id) não gera o mesmo evento duas vezes", errHas(await ev("payment_registered", "cccccccc-0000-4000-8000-000000000001"), /service_session_events_request_key|duplicate/));
ck("9. o mesmo request_id para OUTRO tipo de evento é permitido", (await ev("payment_refunded", "cccccccc-0000-4000-8000-000000000001")).ok);
ck("9. evento é imutável (UPDATE/DELETE)", errHas(await su("update service_session_events set payload='{}'::jsonb"), /imutável/) && errHas(await su("delete from service_session_events"), /imutável/));
ck("9. evento de conta de OUTRA empresa recusado (FK composta)", !(await su("insert into service_session_events (company_id, service_session_id, event_type, actor_id) values ($1,$2,'split_created',$3)", [B, acct9.s, CA])).ok);

// =================================================================== 10. RLS: isolamento e papéis
console.log("\n== 10. RLS: isolamento por empresa e visibilidade por papel ==");
const vis = async (q, t) => (await q(`select count(*)::int n from public.${t}`)).rows?.[0]?.n;
const T_ROLE = { owner: own, admin: adm, cashier: csh, cashier2: csh2, attendant: att, production: prd, courier: cur, ownerB: ownB, cashierB: cshB };
const tot = Object.fromEntries(NEW_TABLES.map((t) => [t, 0]));
for (const t of NEW_TABLES) tot[t] = await count(`select count(*)::int n from public.${t}`);
ck("10. (base) há dados em todas as tabelas novas", NEW_TABLES.every((t) => tot[t] > 0), JSON.stringify(tot));
for (const t of ["service_session_splits", "service_session_parts", "service_session_part_items"]) {
  ck(`10. ${t}: owner/admin/cashier/attendant veem tudo da empresa A`, [own, adm, csh, csh2, att].every(async () => true) && (await vis(own, t)) === tot[t] && (await vis(adm, t)) === tot[t] && (await vis(csh, t)) === tot[t] && (await vis(att, t)) === tot[t]);
  ck(`10. ${t}: production e courier NÃO veem`, (await vis(prd, t)) === 0 && (await vis(cur, t)) === 0);
  ck(`10. ${t}: usuários da empresa B não veem nada da A`, (await vis(ownB, t)) === 0 && (await vis(cshB, t)) === 0);
}
ck("10. service_session_events e service_refund_allocations: só owner/admin", (await vis(own, "service_session_events")) === tot.service_session_events && (await vis(adm, "service_session_events")) === tot.service_session_events && (await vis(csh, "service_session_events")) === 0 && (await vis(att, "service_session_events")) === 0 && (await vis(ownB, "service_session_events")) === 0);
ck("10. service_refund_allocations: cashier/attendant/production não leem", (await vis(own, "service_refund_allocations")) === tot.service_refund_allocations && (await vis(csh, "service_refund_allocations")) === 0 && (await vis(att, "service_refund_allocations")) === 0 && (await vis(prd, "service_refund_allocations")) === 0);
// alocações de pagamento seguem a visibilidade do pagamento: cashier só vê as do PRÓPRIO caixa
const allocs1 = await count("select count(*)::int n from service_payment_allocations a join service_payments p on p.id=a.service_payment_id where p.cash_session_id=$1", [CASH1]);
const allocs2 = await count("select count(*)::int n from service_payment_allocations a join service_payments p on p.id=a.service_payment_id where p.cash_session_id=$1", [CASH2]);
ck("10. alocações de pagamento: owner/admin veem todas", (await vis(own, "service_payment_allocations")) === tot.service_payment_allocations && (await vis(adm, "service_payment_allocations")) === tot.service_payment_allocations);
ck("10. alocações de pagamento: o cashier só vê as dos pagamentos do PRÓPRIO caixa; o outro cashier, as do dele; o attendant nenhuma", (await vis(csh, "service_payment_allocations")) === allocs1 && (await vis(csh2, "service_payment_allocations")) === allocs2 && (await vis(att, "service_payment_allocations")) === 0, `${await vis(csh, "service_payment_allocations")}/${allocs1} ${await vis(csh2, "service_payment_allocations")}/${allocs2}`);
// sessão cruzada: cashier B tenta ler pelo id
const aId = (await su("select id from service_session_parts limit 1")).rows[0].id;
ck("10. leitura direta por id de parte da empresa A pela empresa B retorna nada", (await cshB("select id from public.service_session_parts where id=$1", [aId])).rows.length === 0);

// =================================================================== 11. compatibilidade com o histórico
console.log("\n== 11. compatibilidade: fluxo atual intacto; histórico sem alocações ==");
const hist = await newAccount();
await one(csh, "select * from public.close_service_session($1,$2::jsonb)", [hist.s, JSON.stringify([{ method: "cash", amount: 40, amount_received: 50 }, { method: "pix", amount: 27 }])]);
const hp = (await su("select * from service_payments where service_session_id=$1 order by amount desc", [hist.s])).rows;
ck("11. close_service_session grava pagamentos como antes (2 linhas, sem client_request_id, troco ok)", hp.length === 2 && hp.every((p) => p.client_request_id === null) && Number(hp[0].change_amount) === 10, JSON.stringify(hp));
const histS = (await su("select status, total_amount from service_sessions where id=$1", [hist.s])).rows[0];
ck("11. conta fechada: status/total como antes", histS.status === "closed" && Number(histS.total_amount) === 67);
ck("11. pagamentos históricos NÃO têm alocações (leem-se como conta inteira)", (await count("select count(*)::int n from service_payment_allocations where service_payment_id = any($1::uuid[])", [hp.map((p) => p.id)])) === 0);
const histSplit = await su("insert into service_session_splits (company_id, service_session_id, mode, version, created_by) values ($1,$2,'equal',1,$3)", [A, hist.s, CA]);
ck("11. não é possível criar divisão/alocação sobre conta histórica já fechada", errHas(histSplit, /só existe em conta aberta/));
ck("11. cash_movements do fechamento: 1 por forma, no caixa do operador", (await count("select count(*)::int n from cash_movements where service_session_id=$1 and cash_session_id=$2 and movement_type='sale'", [hist.s, CASH1])) === 2);

// =================================================================== 12. caixa, estorno físico, relatórios
console.log("\n== 12. caixa: estorno em dinheiro sai do caixa que DEVOLVE; fechar caixa não depende das contas abertas ==");
const accR = await newAccount();
await one(csh, "select * from public.close_service_session($1,$2::jsonb)", [accR.s, JSON.stringify([{ method: "cash", amount: 67, amount_received: 70 }])]);
const payR = (await su("select id from service_payments where service_session_id=$1", [accR.s])).rows[0].id;
const physBefore1 = Number((await su("select public.cash_session_physical_cash($1) v", [CASH1])).rows[0].v), physBefore2 = Number((await su("select public.cash_session_physical_cash($1) v", [CASH2])).rows[0].v);
const admCash = admCashEarly;
r = await adm("select * from public.refund_service_payment($1,$2,$3)", [payR, 20, "item devolvido"]);
ck("12. estorno em dinheiro de 20 pelo admin funciona", r.ok, r.err);
const physAfter1 = Number((await su("select public.cash_session_physical_cash($1) v", [CASH1])).rows[0].v), physAfterAdm = Number((await su("select public.cash_session_physical_cash($1) v", [admCash.id])).rows[0].v);
ck("12. a gaveta do caixa ORIGINAL não mudou (o dinheiro sai do caixa que devolve)", physAfter1 === physBefore1, `${physBefore1} -> ${physAfter1}`);
ck("12. a gaveta do caixa que devolve caiu 20 (200 → 180)", physAfterAdm === 180, physAfterAdm);
const refMv = (await su("select cash_session_id, payment_method, amount, movement_type from cash_movements where movement_type='refund' and service_session_id=$1", [accR.s])).rows[0];
ck("12. movimento 'refund' no caixa que devolve, na forma ORIGINAL (dinheiro)", refMv && refMv.cash_session_id === admCash.id && refMv.payment_method === "cash" && Number(refMv.amount) === 20, JSON.stringify(refMv));
// fechar caixa com conta aberta que já tem pagamento parcial: continua permitido
const accPart = await newAccount();
await payment(accPart.s, CASH2, 10);
const cnt = Number((await su("select opening_amount + coalesce((select sum(amount) from cash_movements where cash_session_id=cash_sessions.id and movement_type='sale' and payment_method='cash'),0) e from cash_sessions where id=$1", [CASH2])).rows[0].e);
r = await csh2("select * from public.close_cash_session($1,$2,$3)", [CASH2, cnt, null]);
ck("12. fechar o caixa NÃO depende de contas abertas com pagamento parcial (o valor fica no caixa que recebeu)", r.ok, r.err);
ck("12. views/relatórios existentes seguem consultáveis (cash_session_totals)", (await su("select count(*) n from cash_session_totals")).ok);

// =================================================================== 13. rollback
console.log("\n== 13. rollback: volta ao estado anterior com tabelas vazias; recusa com dado novo ==");
const rbSql = fs.readFileSync(ROLLBACK, "utf8");
const runRb = async (db) => { try { await db.exec(rbSql); return { ok: true }; } catch (e) { try { await db.exec("rollback"); } catch { /* sem transação */ } return { ok: false, err: e.message }; } };
const pgBefore = await boot("20261213010000_partial_payments_foundation.sql"); // estado ANTERIOR à migration
const sigOf = async (db) => (await db.query(`select (select count(*) from pg_proc where pronamespace='public'::regnamespace) f, (select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r') t, (select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name in ('service_payments','service_refunds')) c, (select count(*) from pg_trigger where not tgisinternal) g, (select count(*) from pg_indexes where schemaname='public') i`)).rows[0];
const sigBefore = await sigOf(pgBefore);
const pg2 = await boot("20261213020000_session_financial_state.sql"); // E1 isolada: sem a E2
const sigApplied = await sigOf(pg2);
ck("13. (base) a migration aplicada muda o esquema (tabelas, funções, colunas, gatilhos, índices)", sigApplied.t > sigBefore.t && sigApplied.f > sigBefore.f && sigApplied.g > sigBefore.g && sigApplied.i > sigBefore.i && sigApplied.c !== sigBefore.c, JSON.stringify([sigBefore, sigApplied]));
const rb = await runRb(pg2);
ck("13. rollback com as tabelas vazias executa sem erro", rb.ok, rb.err);
const sigAfterRb = await sigOf(pg2);
ck("13. depois do rollback o esquema é IDÊNTICO ao anterior à migration", JSON.stringify(sigAfterRb) === JSON.stringify(sigBefore), JSON.stringify([sigBefore, sigAfterRb]));
const rb2 = await runRb(pg2);
ck("13. segunda execução do rollback é recusada (já revertida) e não deixa transação aberta", rb2.ok === false && /já revertida/.test(rb2.err), rb2.err);
// as RPCs antigas continuam funcionando depois do rollback (fechar conta com pagamento e estornar)
await pg2.exec(`insert into auth.users (id,email) values ('${OA}','a@x.com'),('${AA}','b@x.com'),('${CA}','c@x.com'),('${TA}','d@x.com')`);
const cB = (await pg2.query("insert into companies (name,slug) values ('E','e') returning id")).rows[0].id;
for (const [u, role] of [[OA, "owner"], [AA, "admin"], [CA, "cashier"], [TA, "attendant"]]) await pg2.query("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [cB, u, role]);
const as2 = async (uid, sql, params) => { await pg2.exec(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`); try { return { ok: true, rows: (await pg2.query(sql, params)).rows }; } catch (e) { return { ok: false, err: e.message }; } finally { await pg2.exec("reset role;"); } };
const cat2 = (await as2(OA, "insert into product_categories (company_id,name,code) values ($1,'B','B') returning id", [cB])).rows[0].id;
const prod2 = (await as2(OA, "insert into products (company_id,category_id,name,code,sale_price) values ($1,$2,'C','C',10) returning id", [cB, cat2])).rows[0].id;
const sp2 = (await as2(OA, "insert into service_points (company_id,type,code,display_name) values ($1,'command','CMD1','Comanda 1') returning id", [cB])).rows[0].id;
await as2(CA, "select * from public.open_cash_session($1,$2)", [cB, 0]);
const s2 = (await as2(TA, "select (public.open_service_session($1)).id as id", [sp2])).rows[0].id;
await as2(TA, "select (public.submit_service_order($1,$2::jsonb)).id as id", [s2, JSON.stringify([{ product_id: prod2, quantity: 2 }])]);
const cl = await as2(CA, "select * from public.close_service_session($1,$2::jsonb)", [s2, JSON.stringify([{ method: "pix", amount: 20 }])]);
ck("13. após o rollback, fechar conta com pagamento continua funcionando", cl.ok, cl.err);
const pay2 = (await pg2.query("select id from service_payments where service_session_id=$1", [s2])).rows[0].id;
const rf2 = await as2(AA, "select * from public.refund_service_payment($1,$2,$3)", [pay2, 5, "x"]);
ck("13. após o rollback, estorno de conta fechada continua funcionando", !rf2.ok ? /Abra seu caixa/.test(rf2.err) : true, rf2.err);
// recusa com dado novo: divisão
const pg3 = await boot("20261213020000_session_financial_state.sql"); // E1 isolada: sem a E2
await pg3.exec(`insert into auth.users (id,email) values ('${OA}','a@x.com'),('${CA}','c@x.com'),('${TA}','d@x.com')`);
const c3 = (await pg3.query("insert into companies (name,slug) values ('E','e') returning id")).rows[0].id;
for (const [u, role] of [[OA, "owner"], [CA, "cashier"], [TA, "attendant"]]) await pg3.query("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c3, u, role]);
const as3 = async (uid, sql, params) => { await pg3.exec(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`); try { return { ok: true, rows: (await pg3.query(sql, params)).rows }; } catch (e) { return { ok: false, err: e.message }; } finally { await pg3.exec("reset role;"); } };
const sp3 = (await as3(OA, "insert into service_points (company_id,type,code,display_name) values ($1,'command','CMD1','Comanda 1') returning id", [c3])).rows[0].id;
const s3 = (await as3(TA, "select (public.open_service_session($1)).id as id", [sp3])).rows[0].id;
await pg3.query("insert into service_session_splits (company_id, service_session_id, mode, version, created_by) values ($1,$2,'equal',1,$3)", [c3, s3, CA]);
const sigWith = await sigOf(pg3);
const rb3 = await runRb(pg3);
ck("13. rollback com DADO NOVO (uma divisão) é recusado", rb3.ok === false && /nada foi removido/.test(rb3.err), rb3.err);
ck("13. e a recusa não remove NADA (esquema idêntico ao anterior à tentativa)", JSON.stringify(await sigOf(pg3)) === JSON.stringify(sigWith));
// recusa com pagamento que usa client_request_id e com estorno que recompõe saldo
const pg4 = await boot("20261213020000_session_financial_state.sql"); // E1 isolada: sem a E2
await pg4.exec(`insert into auth.users (id,email) values ('${OA}','a@x.com'),('${CA}','c@x.com'),('${TA}','d@x.com')`);
const c4 = (await pg4.query("insert into companies (name,slug) values ('E','e') returning id")).rows[0].id;
for (const [u, role] of [[OA, "owner"], [CA, "cashier"], [TA, "attendant"]]) await pg4.query("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c4, u, role]);
const as4 = async (uid, sql, params) => { await pg4.exec(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`); try { return { ok: true, rows: (await pg4.query(sql, params)).rows }; } catch (e) { return { ok: false, err: e.message }; } finally { await pg4.exec("reset role;"); } };
const sp4 = (await as4(OA, "insert into service_points (company_id,type,code,display_name) values ($1,'command','CMD1','Comanda 1') returning id", [c4])).rows[0].id;
const s4 = (await as4(TA, "select (public.open_service_session($1)).id as id", [sp4])).rows[0].id;
const cs4 = (await as4(CA, "select * from public.open_cash_session($1,$2)", [c4, 0])).rows[0].id;
await pg4.query("insert into service_payments (company_id, service_session_id, cash_session_id, payment_method, amount, created_by, client_request_id) values ($1,$2,$3,'pix',5,$4,gen_random_uuid())", [c4, s4, cs4, CA]);
const rb4 = await runRb(pg4);
ck("13. rollback com pagamento parcial já registrado (client_request_id) é recusado", rb4.ok === false && /nada foi removido/.test(rb4.err), rb4.err);

// recusa com estorno que recompõe saldo (sem nenhum outro dado novo)
const pg5 = await boot("20261213020000_session_financial_state.sql"); // E1 isolada: sem a E2
await pg5.exec(`insert into auth.users (id,email) values ('${OA}','a@x.com'),('${CA}','c@x.com'),('${TA}','d@x.com')`);
const c5 = (await pg5.query("insert into companies (name,slug) values ('E','e') returning id")).rows[0].id;
for (const [u, role] of [[OA, "owner"], [CA, "cashier"], [TA, "attendant"]]) await pg5.query("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c5, u, role]);
const as5 = async (uid, sql, params) => { await pg5.exec(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`); try { return { ok: true, rows: (await pg5.query(sql, params)).rows }; } catch (e) { return { ok: false, err: e.message }; } finally { await pg5.exec("reset role;"); } };
const sp5 = (await as5(OA, "insert into service_points (company_id,type,code,display_name) values ($1,'command','CMD1','Comanda 1') returning id", [c5])).rows[0].id;
const s5 = (await as5(TA, "select (public.open_service_session($1)).id as id", [sp5])).rows[0].id;
const cs5 = (await as5(CA, "select * from public.open_cash_session($1,$2)", [c5, 0])).rows[0].id;
const pay5 = (await pg5.query("insert into service_payments (company_id, service_session_id, cash_session_id, payment_method, amount, created_by) values ($1,$2,$3,'pix',5,$4) returning id", [c5, s5, cs5, CA])).rows[0].id;
await pg5.query("insert into service_refunds (company_id, service_session_id, service_payment_id, cash_session_id, amount, reason, created_by, restores_balance) values ($1,$2,$3,$4,2,'x',$5,true)", [c5, s5, pay5, cs5, OA]);
const rb5 = await runRb(pg5);
ck("13. rollback com estorno que recompõe saldo já registrado é recusado", rb5.ok === false && /estorno\(s\) novos/.test(rb5.err), rb5.err);
console.log(`\nRESULTADO partial-payments-schema: ${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
