// Apoio da homologação concorrente: banco com as 8 migrations, relógio de negócio COMPARTILHADO entre conexões (tabela __clock — só neste banco
// descartável), fixtures e workers independentes. Nunca toca nada fora do container local de homologação.
import crypto from "node:crypto";
import { MIG } from "../lib.mjs";
import { RealPg, dispose as disposeAll, makeDb } from "./real-db.mjs";

export async function loadAllRealDb(nWorkers = 8, dir = MIG) {
  const db = await makeDb(dir, { legacyIaMirror: false });
  const name = db.dbname;
  // relógio compartilhado (substitui o business_now() = now() de produção SÓ aqui). log_lock_waits/deadlock_timeout=200ms foram ligados no container descartável (alter system, superusuário supabase_admin)
  await db.exec(`
    create table public.__clock (ts timestamptz);
    insert into public.__clock values (null);
    grant select on public.__clock to public;
    create or replace function public.business_now() returns timestamptz language sql stable set search_path = public as $$ select coalesce((select ts from public.__clock limit 1), now()) $$;
  `);
  const uuid = () => crypto.randomUUID();
  const master = "00000000-0000-4000-8000-0000000000aa";
  await db.exec(`insert into auth.users (id,email) values ('${master}','master@x.com'); insert into public.profiles (user_id,email) values ('${master}','master@x.com') on conflict do nothing; insert into public.platform_admins (user_id) values ('${master}');`);
  await db.exec("update modules set is_active = true where code in ('financeiro','estoque','producao')");
  const plan = async (code, price, mods) => {
    const id = (await db.query("insert into plans (code,name,monthly_price_cents,is_active) values ($1,$1,$2,true) returning id", [code, price])).rows[0].id;
    for (const m of mods) await db.query("insert into plan_modules (plan_id,module_id) select $1,id from modules where code=$2", [id, m]);
    return id;
  };
  const pA = await plan("pa", 10000, ["estoque", "producao"]), pB = await plan("pb", 20000, ["financeiro"]);

  const workers = [];
  for (let i = 0; i < nWorkers; i++) workers.push(new RealPg(name, { app: `worker-${i}` }));     // conexões (backends) INDEPENDENTES
  const adminQ = new RealPg(name, { app: "invariants" });
  const inv = { q: async (sql) => (await adminQ.query(sql)).rows };

  const MASTER = { role: "authenticated", uid: master };
  const asMaster = async (sql) => { const r = await db.queryAt(Date.now(), sql, MASTER); await db.exec("reset role"); if (!r.ok) throw new Error(`${r.err} [${r.code}] ${sql.slice(0, 90)}`); return r.rows; };
  const clock = async (ts) => { await db.exec(`update public.__clock set ts = ${ts ? `timestamptz '${ts}'` : "null"}`); };
  const clockNow = async () => (await db.query("select ts from public.__clock")).rows[0].ts;
  let n = 0;
  const fx = {
    master, pA, pB,
    // empresa com período grátis JÁ VENCIDO (para a cortesia de plano virar estado 'courtesy')
    async company() {
      const back = await clockNow();
      await clock("2030-01-10T12:00:00Z");
      const c = (await db.query("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["conc-" + ++n, `cc-${Date.now().toString(36)}-${n}`, `c${n}@x.com`])).rows[0].id;
      await asMaster(`select * from master_start_trial('${c}')`);
      await clock(back ? new Date(back).toISOString() : null);
      return c;
    },
    async courtesy(c, plan, days = 30) {
      const r = await asMaster(`select public.master_grant_courtesy(p_company_id=>'${c}',p_scope=>'plan',p_reason=>'fixture da corrida',p_plan_id=>'${plan}',p_days=>${days}) r`);
      return r[0].r.courtesy.id;
    },
    async authorizeConversion(k) {
      await asMaster(`select public.master_request_courtesy_conversion('${k}','quer pagar',null) r`);
      await asMaster(`select public.master_convert_courtesy('${k}','autorizado',null,null,72) r`);
    },
    async subscribe(c, plan) { await asMaster(`select * from master_subscribe_company('${c}','${plan}','{}'::uuid[])`); },
    async initialInvoice(c) { return (await db.query("select id from invoices where company_id=$1 and kind='initial'", [c])).rows[0].id; },
  };
  const deadlocks = async () => (await adminQ.query("select deadlocks::int d from pg_stat_database where datname = current_database()")).rows[0].d;
  const run = (sql) => db.query(sql);
  const dispose = async () => { for (const w of workers) w.close(); adminQ.close(); db.close(); await disposeAll(); };
  void uuid;
  return { db, workers, clock, fx, run, inv, deadlocks, dispose, asMaster, name };
}
