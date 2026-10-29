// HISTÓRICO PAGINADO DA VARREDURA (Etapa 10): master_whatsapp_token_sweep_history. Banco real (PGlite + todas as migrations).
import { loadAll } from "./full-db.mjs";

const { pg, ck, as, su: su0, summary } = await loadAll();
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const master = id(4001), owner = id(4002);
await su(`insert into auth.users (id,email) values ('${master}','m@x.com'), ('${owner}','o@x.com')`);
await su(`insert into public.profiles (user_id,email,full_name) values ('${master}','m@x.com','m'), ('${owner}','o@x.com','o') on conflict (user_id) do nothing`);
await su("insert into platform_admins (user_id) values ($1)", [master]);
const co = (await su("insert into companies (name,slug,document,email) values ('Emp H','hist-h','11222333000181','h@x.com') returning id")).rows[0].id;
await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [co, owner]);
const M = (sql, p) => as("authenticated", master, sql, p);
const H = async (a = "null,null,20,0") => (await M(`select public.master_whatsapp_token_sweep_history(${a}) j`)).rows[0].j;

console.log("\n== 1. acesso ==");
ck("1.1 lista vazia: total 0, rows [], limites padrão", await (async () => { const j = await H(); return j.total === 0 && Array.isArray(j.rows) && j.rows.length === 0 && j.limit === 20 && j.offset === 0; })());
ck("1.2 owner de empresa, anon e service_role NÃO executam", !(await as("authenticated", owner, "select public.master_whatsapp_token_sweep_history()")).ok && !(await as("anon", null, "select public.master_whatsapp_token_sweep_history()")).ok && !(await as("service_role", null, "select public.master_whatsapp_token_sweep_history()")).ok);
ck("1.3 mensagem de recusa não vaza dados e o usuário comum não lê a tabela", /administradores/.test((await as("authenticated", owner, "select public.master_whatsapp_token_sweep_history()")).err ?? "") && !(await as("authenticated", owner, "select * from whatsapp_token_sweep_runs")).ok && !(await as("authenticated", master, "select * from whatsapp_token_sweep_runs")).ok);

// 30 execuções: 18 success, 6 failed, 6 skipped; 20 cron, 10 manual; started_at distintos
for (let i = 0; i < 30; i++) {
  const st = i % 5 === 0 ? "failed" : i % 5 === 1 ? "skipped_concurrent" : "success";
  const src = i % 3 === 0 ? "manual" : "cron";
  await su("insert into whatsapp_token_sweep_runs (source, status, started_at, finished_at, connections_checked, error_code, error_message) values ($1,$2, now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval, $4, $5, $6)",
    [src, st, String(i * 10), i, st === "failed" ? "P0001" : null, st === "failed" ? "falha [removido] simulada" : null]);
}
console.log("\n== 2. paginação e ordenação ==");
{
  const p1 = await H("null,null,10,0"), p2 = await H("null,null,10,10"), p3 = await H("null,null,10,20"), p4 = await H("null,null,10,30");
  const ids = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
  ck("2.1 total 30; páginas de 10; quarta página vazia", p1.total === 30 && p1.rows.length === 10 && p2.rows.length === 10 && p3.rows.length === 10 && p4.rows.length === 0 && p4.total === 30);
  ck("2.2 ordenação por data decrescente em todas as páginas, sem repetir nem faltar linha", new Set(ids).size === 30 && [...p1.rows, ...p2.rows, ...p3.rows].every((r, i, a) => i === 0 || a[i - 1].started_at >= r.started_at) && p1.rows[0].checked === 0 && p3.rows[9].checked === 29);
  ck("2.3 limite máximo: 1000 vira 100; 0 e negativo viram 1; nulo vira 20; offset negativo vira 0", (await H("null,null,1000,0")).limit === 100 && (await H("null,null,0,0")).limit === 1 && (await H("null,null,-5,0")).limit === 1 && (await H("null,null,null,null")).limit === 20 && (await H("null,null,10,-3")).offset === 0);
  ck("2.4 limite 100 devolve no máximo 30 aqui (todas) e nunca mais que 100", (await H("null,null,1000,0")).rows.length === 30);
}
console.log("\n== 3. filtros ==");
{
  const f = await H("'failed',null,50,0"), c = await H("null,'cron',50,0"), fc = await H("'success','manual',50,0");
  ck("3.1 filtro por resultado: só 'failed' (6) e total reflete o filtro", f.total === 6 && f.rows.every((r) => r.status === "failed"));
  ck("3.2 filtro por origem: só 'cron' (20)", c.total === 20 && c.rows.every((r) => r.source === "cron"));
  ck("3.3 filtros combinados e paginação sobre o filtrado", fc.rows.every((r) => r.status === "success" && r.source === "manual") && fc.total === fc.rows.length && (await H("'failed',null,4,4")).rows.length === 2);
  ck("3.4 filtro inválido (resultado ou origem) = PT400, sem executar a consulta", (await M("select public.master_whatsapp_token_sweep_history('x', null)")).code === "PT400" && (await M("select public.master_whatsapp_token_sweep_history(null, 'y')")).code === "PT400" && (await M("select public.master_whatsapp_token_sweep_history('success''; drop table companies;--', null)")).code === "PT400");
}
console.log("\n== 4. sem dados sensíveis / ACL ==");
{
  const j = await H("null,null,50,0");
  const keys = Object.keys(j.rows[0]).sort().join(",");
  ck("4.1 cada linha só tem os campos operacionais esperados (sem token, segredo ou id de segredo)", keys === "alerts_created,alerts_refreshed,checked,error_code,error_message,finished_at,id,locked_skipped,source,started_at,status,updated" && !/secret|token|pin|vault/i.test(Object.keys(j.rows[0]).join(",")));
  ck("4.2 a mensagem de erro exibida é a sanitizada gravada", j.rows.filter((r) => r.status === "failed").every((r) => /\[removido\]/.test(r.error_message)));
  const r = (await su(`select p.prosecdef sd, p.provolatile v, coalesce(p.proconfig::text,'') cfg, has_function_privilege('anon',p.oid,'execute') a, has_function_privilege('authenticated',p.oid,'execute') u, has_function_privilege('service_role',p.oid,'execute') s from pg_proc p where p.proname='master_whatsapp_token_sweep_history'`)).rows[0];
  ck("4.3 SECURITY DEFINER, STABLE, search_path fixo; EXECUTE só authenticated", r.sd && r.v === "s" && /search_path=public/.test(r.cfg) && !r.a && r.u && !r.s);
  ck("4.4 somente leitura: nenhuma linha criada/alterada pela consulta", (await su("select count(*) n from whatsapp_token_sweep_runs")).rows[0].n == 30);
}
summary("HISTÓRICO DA VARREDURA (ETAPA 10)");
