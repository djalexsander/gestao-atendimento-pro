// ORDEM DE ROLLBACK 20261111010000 -> 20261110010000 -> 20261109010000 (Etapa 10.1). Só banco descartável (PGlite).
// Prova: (a) na ordem certa cada rollback devolve EXATAMENTE o schema da migration anterior (funções, ACL, tabelas, colunas, políticas, triggers);
// (b) fora de ordem o resultado é previsível e recuperável (sobra uma função órfã, nunca perda de dados), e nunca um erro silencioso.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAll } from "./full-db.mjs";

const SRC = "D:/orça facil/supabase/migrations";
const RB = (n) => fs.readFileSync(`D:/orça facil/.claude/db-tests/${n}`, "utf8");
const upto = (last) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rbo-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql") && f <= last) fs.copyFileSync(path.join(SRC, f), path.join(d, f));
  return d;
};
const sig = async (pg) => ({
  fns: (await pg.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' k,
      md5(p.prosrc || coalesce(p.proconfig::text,'') || p.prosecdef::text || p.provolatile::text) h,
      has_function_privilege('anon',p.oid,'execute')::text || has_function_privilege('authenticated',p.oid,'execute')::text || has_function_privilege('service_role',p.oid,'execute')::text acl
    from pg_proc p where p.pronamespace='public'::regnamespace order by 1`)).rows.map((r) => `${r.k}|${r.h}|${r.acl}`),
  cols: (await pg.query("select table_name||'.'||column_name||':'||data_type k from information_schema.columns where table_schema='public' order by 1")).rows.map((r) => r.k),
  pol: (await pg.query("select tablename||'.'||policyname k from pg_policies where schemaname='public' order by 1")).rows.map((r) => r.k),
  trg: (await pg.query("select event_object_table||'.'||trigger_name k from information_schema.triggers where trigger_schema='public' order by 1")).rows.map((r) => r.k),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diff = (a, b) => ["fns", "cols", "pol", "trg"].flatMap((k) => [...a[k].filter((x) => !b[k].includes(x)).map((x) => `+${k}:${x}`), ...b[k].filter((x) => !a[k].includes(x)).map((x) => `-${k}:${x}`)]);

const ck_ = [];
let okN = 0, failN = 0;
const ck = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond ? "" : " " + extra}`); cond ? okN++ : failN++; };

const NEW = { n1111: "20261111010000", n1110: "20261110010000", n1109: "20261109010000" };
const d1108 = upto("20261108010000zzz"), d1109 = upto("20261109010000zzz"), d1110 = upto("20261110010000zzz"), dAll = upto("20261111010000zzz");
const s1108 = await sig((await loadAll(d1108)).pg), s1109 = await sig((await loadAll(d1109)).pg), s1110 = await sig((await loadAll(d1110)).pg);

console.log("\n== 1. ordem correta: 1111 -> 1110 -> 1109 ==");
{
  const { pg } = await loadAll(dAll);
  const sAll = await sig(pg);
  ck("1.0 pré-condição: o schema completo difere do anterior só pela 1111 (função substituída, mesma assinatura)", !same(sAll, s1110) && diff(sAll, s1110).every((x) => /master_whatsapp_pilot_set\(p_company_id uuid, p_authorized boolean, p_note text\)/.test(x)));
  await pg.exec(RB("whatsapp-pilot-note.rollback.sql"));
  const a = await sig(pg);
  ck("1.1 após o rollback da 1111 o schema é IDÊNTICO ao de 20261110010000 (corpo, ACL, assinatura)", same(a, s1110), diff(a, s1110).join(" | "));
  await pg.exec(RB("whatsapp-token-sweep-history.rollback.sql"));
  const b = await sig(pg);
  ck("1.2 após o rollback da 1110 o schema é IDÊNTICO ao de 20261109010000", same(b, s1109), diff(b, s1109).join(" | "));
  await pg.exec(RB("whatsapp-token-sweep.rollback.sql"));
  const c = await sig(pg);
  ck("1.3 após o rollback da 1109 o schema é IDÊNTICO ao de 20261108010000", same(c, s1108), diff(c, s1108).join(" | "));
  // dados preservados: o rollback da 1111 não toca em allowlist/eventos
}
console.log("\n== 2. rollback da 1111 preserva dados e restaura o comportamento antigo ==");
{
  const { pg, as, su } = await loadAll(dAll);
  const master = "00000000-0000-4000-8000-000000009001";
  await su(`insert into auth.users (id,email) values ('${master}','m@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${master}','m@x.com','m') on conflict (user_id) do nothing`);
  await su("insert into platform_admins (user_id) values ($1)", [master]);
  const co = (await su("insert into companies (name,slug,document,email) values ('Emp R','rbo-r','11222333000181','r@x.com') returning id")).rows[0].id;
  const set = (note) => as("authenticated", master, "select public.master_whatsapp_pilot_set($1,true,$2) j", [co, note]);
  const rejected = await set(null);
  const ok = await set("motivo antes do rollback");
  const before = JSON.stringify((await su("select company_id, authorized, note from whatsapp_signup_pilot_companies")).rows) + JSON.stringify((await su("select company_id, action, note from whatsapp_signup_pilot_events")).rows);
  await pg.exec(RB("whatsapp-pilot-note.rollback.sql"));
  const after = JSON.stringify((await su("select company_id, authorized, note from whatsapp_signup_pilot_companies")).rows) + JSON.stringify((await su("select company_id, action, note from whatsapp_signup_pilot_events")).rows);
  ck("2.1 com a 1111 a nota nula é recusada; o rollback preserva a allowlist e os eventos", !rejected.ok && rejected.code === "PT400" && ok.ok && before === after);
  const co2 = (await su("insert into companies (name,slug,document,email) values ('Emp R2','rbo-r2','11222333000182','r2@x.com') returning id")).rows[0].id;
  const old = await as("authenticated", master, "select public.master_whatsapp_pilot_set($1,true,null) j", [co2]);
  ck("2.2 após o rollback volta o comportamento da 1107 (nota opcional) e a segurança continua (Admin Master obrigatório)", old.ok
    && !(await as("authenticated", "00000000-0000-4000-8000-000000009002", "select public.master_whatsapp_pilot_set($1,true,null)", [co2])).ok);
}
console.log("\n== 3. fora de ordem: resultado previsível e recuperável ==");
{
  const { pg, as, su } = await loadAll(d1110);
  const master = "00000000-0000-4000-8000-000000009003";
  await su(`insert into auth.users (id,email) values ('${master}','m@x.com')`);
  await su(`insert into public.profiles (user_id,email,full_name) values ('${master}','m@x.com','m') on conflict (user_id) do nothing`);
  await su("insert into platform_admins (user_id) values ($1)", [master]);
  await pg.exec(RB("whatsapp-token-sweep.rollback.sql")); // 1109 antes da 1110 (fora de ordem)
  const mid = await sig(pg);
  const orphan = diff(mid, s1108);
  ck("3.1 rollback da 1109 SEM desfazer a 1110 (banco até a 1110) não falha e deixa apenas a função de histórico órfã (nenhuma tabela/coluna a mais)", orphan.length === 1 && /^\+fns:master_whatsapp_token_sweep_history/.test(orphan[0]) && mid.cols.every((c, i) => c === s1108.cols[i]) && same(mid.cols, s1108.cols), orphan.join(" | "));
  const call = await as("authenticated", master, "select public.master_whatsapp_token_sweep_history()");
  ck("3.2 a função órfã falha de forma explícita (tabela inexistente), sem devolver dados nem alterar nada", !call.ok);
  await pg.exec(RB("whatsapp-token-sweep-history.rollback.sql")); // recuperação: aplicar o rollback da 1110 depois
  ck("3.3 recuperação: aplicar depois o rollback da 1110 leva ao schema de 20261108010000", same(await sig(pg), s1108));
}
{
  const { pg } = await loadAll(dAll);
  await pg.exec(RB("whatsapp-signup-pilot.rollback.sql")); // 1107 antes da 1111 (fora de ordem)
  const pilotGone = (await pg.query("select count(*) n from pg_proc where proname='master_whatsapp_pilot_set'")).rows[0].n;
  ck("3.4 rollback da 1107 com a 1111 ainda aplicada remove a função (drop por assinatura) — sem órfã", Number(pilotGone) === 0);
  let failed = null;
  try { await pg.exec(RB("whatsapp-pilot-note.rollback.sql")); } catch (e) { failed = String(e?.message ?? e); }
  const back = (await pg.query("select count(*) n from pg_proc where proname='master_whatsapp_pilot_set'")).rows[0].n;
  ck("3.5 o rollback da 1111 depois do da 1107 FALHA de forma explícita (tipo da tabela já removido) e não recria a função — a ordem 1111 antes de 1107 é protegida pelo próprio banco", failed !== null && /does not exist/i.test(failed) && Number(back) === 0, String(failed));
}

console.log(`\nRESULTADO ORDEM DE ROLLBACK (ETAPA 10.1): ${okN} ok / ${failN} falhas`);
process.exitCode = failN ? 1 : 0;
