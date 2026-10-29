// VARREDURA DA SAÚDE DOS TOKENS (Etapa 9): banco REAL (PGlite + todas as migrations). Prova: contagem/auditoria de cada execução, idempotência,
// conexões sem prazo (Djalexeventos) intocadas, isolamento por empresa, token/PIN/mensagens intactos, execução simultânea IGNORADA,
// falha controlada (atômica, auditada, sem credencial), retenção, estado do Admin Master e o agendamento pg_cron (sem duplicar).
// Corrida de verdade só existe no Postgres real (PGlite = um backend): aqui a trava é provada estruturalmente + pelo caminho "trava ocupada".
import fs from "node:fs";
import { loadAll } from "./full-db.mjs";

const MIG = process.env.MIG_DIR ?? "D:/orça facil/supabase/migrations";
const SCHED = "20261109010000_whatsapp_token_health_sweep_schedule.sql";
const { pg, ck, as, su: su0, summary } = await loadAll();
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const svc = (sql, params) => as("service_role", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const must = (r, what) => { if (!r.ok) { console.log("SETUP FALHOU", what, r.err); process.exit(2); } return r; };
const num = async (sql, params) => Number((await su(sql, params)).rows[0].n);

await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
`);

// ---------------------------------------------------------------- fixtures
const mkCompany = async (slug) => must(await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", [`Emp ${slug}`, slug, `${slug}@x.com`]), slug).rows[0].id;
const cA = await mkCompany("sw-a"), cB = await mkCompany("sw-b"), cC = await mkCompany("sw-c"), cD = await mkCompany("sw-d"), cE = await mkCompany("sw-e"), cF = await mkCompany("sw-f");
const TOKEN = "EAAG-TOKEN-VARREDURA-SECRETO-1234567890";
let ph = 555100000;
const secretOf = async (name) => must(await su("insert into vault.secrets (name, secret) values ($1,$2) returning id", [name, `${TOKEN}-${name}`]), name).rows[0].id;
const mkConn = async (company, { status = "active", st = "unknown", exp = null, withSecret = true }) => {
  const sid = withSecret ? await secretOf(`wa_token_${company}`) : null;
  return must(await su("insert into company_whatsapp_connections (company_id, status, mode, phone_number_id, token_status, token_expires_at, token_secret_id) values ($1,$2,'live',$3,$4,$5,$6) returning id",
    [company, status, String(++ph), st, exp, sid]), "conn").rows[0].id;
};
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 86400000;
const A = await mkConn(cA, { st: "valid", exp: iso(2 * DAY) });          // prazo em 2 dias -> expiring
const B = await mkConn(cB, { st: "valid", exp: iso(-3600000) });          // prazo vencido -> expired
const C = await mkConn(cC, { st: "valid", exp: iso(30 * DAY) });          // longe do prazo -> nada
const D = await mkConn(cD, { st: "unknown", exp: null });                 // tipo Djalexeventos (sem prazo)
const E = await mkConn(cE, { st: "revoked", exp: iso(-DAY) });            // revogado confirmado -> fora da varredura
const F = await mkConn(cF, { status: "disconnected", st: "valid", exp: iso(-DAY) }); // desconectada -> fora
const hash = async (cid) => (await su("select md5(row(c.*)::text) h from company_whatsapp_connections c where id=$1", [cid])).rows[0].h;
const conns = { A, B, C, D, E, F };
const snap = async () => Object.fromEntries(await Promise.all(Object.entries(conns).map(async ([k, v]) => [k, await hash(v)])));
const vaultSig = async () => (await su("select md5(string_agg(id::text || secret, ',' order by id)) h, count(*) n from vault.secrets")).rows[0];
const runs = async () => (await su("select * from whatsapp_token_sweep_runs order by started_at, id")).rows;
const lastRun = async () => (await su("select * from whatsapp_token_sweep_runs order by started_at desc, id desc limit 1")).rows[0];
const alerts = async () => (await su("select a.*, c.company_id as conn_company from whatsapp_token_alerts a join company_whatsapp_connections c on c.id = a.connection_id order by a.first_seen_at, a.kind")).rows;
const master = id(3001), owner = id(3002);
await su(`insert into auth.users (id,email) values ('${master}','m@x.com'), ('${owner}','o@x.com')`);
await su(`insert into public.profiles (user_id,email,full_name) values ('${master}','m@x.com','m'), ('${owner}','o@x.com','o') on conflict (user_id) do nothing`);
await su("insert into platform_admins (user_id) values ($1)", [master]);
await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [cA, owner]);
const MASTER = (sql, p) => as("authenticated", master, sql, p);
const OWNER = (sql, p) => as("authenticated", owner, sql, p);

const flagOff = (await su("select embedded_signup_enabled e from whatsapp_platform_settings")).rows[0].e === false;
const allowEmpty = (await num("select count(*) n from whatsapp_signup_pilot_companies")) === 0;
const msgs0 = await num("select count(*) n from whatsapp_messages");

console.log("\n== 1. estado inicial e independência do Embedded Signup ==");
{
  ck("1.1 pré-condição: flag do Embedded Signup DESLIGADA e allowlist VAZIA (a varredura não depende de nenhuma das duas)", flagOff && allowEmpty);
  ck("1.2 antes de qualquer execução: sem linhas de auditoria; o Admin Master vê never_run=true e overdue=false", (await runs()).length === 0
    && (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j.never_run === true && (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j.overdue === false);
  ck("1.3 estados efetivos de partida: A=expiring B=expired C=valid D=unknown E=revoked", await (async () => {
    const e = async (cid) => (await su("select public.whatsapp_token_effective_status(c) s from company_whatsapp_connections c where id=$1", [cid])).rows[0].s;
    return (await e(A)) === "expiring" && (await e(B)) === "expired" && (await e(C)) === "valid" && (await e(D)) === "unknown" && (await e(E)) === "revoked";
  })());
}

console.log("\n== 2. primeira execução: vencimento conhecido, expirado, sem prazo, revogado ==");
const before = await snap(); const vault0 = await vaultSig(); const regs0 = await num("select count(*) n from whatsapp_number_registrations");
const r1 = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0].j;
const after1 = await snap();
{
  ck("2.1 execução bem-sucedida: verificou só as 3 conexões ativas COM prazo e não revogadas (A,B,C); atualizou 2; criou 2 alertas", r1.ok === true && r1.checked === 3 && r1.updated === 2 && r1.alerts_created === 2 && r1.alerts_refreshed === 0 && r1.expiring === 1 && r1.expired === 1 && r1.locked_skipped === 0, JSON.stringify(r1));
  ck("2.2 A (vence em 2 dias) -> 'expiring'; B (vencido) -> 'expired'", (await su("select token_status s from company_whatsapp_connections where id=$1", [A])).rows[0].s === "expiring" && (await su("select token_status s from company_whatsapp_connections where id=$1", [B])).rows[0].s === "expired");
  ck("2.3 C (prazo distante) intocada; D (sem prazo, tipo Djalexeventos) INTOCADA; E (revogada) e F (desconectada) fora da varredura", after1.C === before.C && after1.D === before.D && after1.E === before.E && after1.F === before.F);
  const al = await alerts();
  ck("2.4 alertas só para A e B, cada um na sua empresa (isolamento multiempresa) e sem nenhuma referência a token", al.length === 2 && al.every((a) => a.company_id === a.conn_company) && al.find((a) => a.connection_id === A).company_id === cA && al.find((a) => a.connection_id === B).company_id === cB && al.find((a) => a.connection_id === A).kind === "expiring" && al.find((a) => a.connection_id === B).kind === "expired" && !JSON.stringify(al).includes(TOKEN));
  const run = await lastRun();
  ck("2.5 auditoria: 1 linha 'success' (origem manual) com início/fim e contagens coerentes e sem erro", (await runs()).length === 1 && run.status === "success" && run.source === "manual" && !!run.started_at && !!run.finished_at && run.finished_at >= run.started_at && run.connections_checked === 3 && run.connections_locked_skipped === 0 && run.states_updated === 2 && run.alerts_created === 2 && run.alerts_refreshed === 0 && run.error_code === null && run.error_message === null);
  const v1 = await vaultSig();
  ck("2.6 tokens/PINs intactos: Vault idêntico (mesmos ids e valores), nenhum registro de número tocado, nenhuma mensagem criada ou alterada", v1.h === vault0.h && v1.n === vault0.n && (await num("select count(*) n from whatsapp_number_registrations")) === regs0 && (await num("select count(*) n from whatsapp_messages")) === msgs0);
  ck("2.7 só a coluna token_status mudou nas conexões A e B (token_secret_id, expiração, status e número preservados)", (await su("select company_id, status, phone_number_id, token_secret_id is not null s, token_expires_at is not null e from company_whatsapp_connections where id = any($1::uuid[]) order by phone_number_id", [[A, B]])).rows.every((r) => r.status === "active" && r.s && r.e));
}

console.log("\n== 3. idempotência: segunda execução ==");
{
  const r2 = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0].j;
  const after2 = await snap();
  ck("3.1 segunda execução: nada atualizado, nenhum alerta novo, 2 renovados (last_seen_at), verificou as mesmas 3", r2.ok && r2.checked === 3 && r2.updated === 0 && r2.alerts_created === 0 && r2.alerts_refreshed === 2);
  ck("3.2 nenhuma conexão mudou entre a 1ª e a 2ª execução e continuam 2 alertas (sem duplicar)", JSON.stringify(after2) === JSON.stringify(after1) && (await alerts()).length === 2);
  ck("3.3 duas linhas de auditoria 'success'", (await runs()).filter((r) => r.status === "success").length === 2);
  // expiração conhecida que vence depois: novo tipo de alerta
  await su("update company_whatsapp_connections set token_expires_at = now() - interval '1 hour' where id=$1", [A]);
  const r3 = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0].j;
  ck("3.4 A passa a vencida: 'expired', novo alerta 'expired' (2 por A no total) e a contagem reflete só o que mudou", r3.updated === 1 && r3.alerts_created === 1 && r3.alerts_refreshed === 1 && (await num("select count(*) n from whatsapp_token_alerts where connection_id=$1", [A])) === 2);
}

console.log("\n== 4. origem, ACL e travas ==");
{
  const rc = (await su("select public.whatsapp_token_health_sweep('cron') j")).rows[0].j;
  const rx = (await su("select public.whatsapp_token_health_sweep('qualquer-coisa') j")).rows[0].j;
  const rs = await runs();
  ck("4.1 origem 'cron' registrada; origem desconhecida vira 'manual' (nunca texto livre na auditoria)", rc.ok && rx.ok && rs.at(-2).source === "cron" && rs.at(-1).source === "manual");
  ck("4.2 a versão com origem NÃO é executável por service_role, usuários nem anon (só o dono/cron); a sem argumento segue para service_role", !(await svc("select public.whatsapp_token_health_sweep('cron')")).ok && !(await OWNER("select public.whatsapp_token_health_sweep('cron')")).ok && !(await as("anon", null, "select public.whatsapp_token_health_sweep('cron')")).ok
    && !(await OWNER("select public.whatsapp_token_health_sweep()")).ok && !(await as("anon", null, "select public.whatsapp_token_health_sweep()")).ok && (await svc("select public.whatsapp_token_health_sweep() j")).ok);
  ck("4.3 trava interna e tabela de auditoria sem acesso de cliente", !(await svc("select public.whatsapp_token_sweep_try_lock()")).ok && !(await OWNER("select public.whatsapp_token_sweep_try_lock()")).ok && !(await OWNER("select * from whatsapp_token_sweep_runs")).ok && !(await MASTER("select * from whatsapp_token_sweep_runs")).ok && !(await as("anon", null, "select * from whatsapp_token_sweep_runs")).ok
    && (await su("select relrowsecurity r from pg_class where relname='whatsapp_token_sweep_runs'")).rows[0].r === true);
  ck("4.3b ACL por catálogo: master_whatsapp_token_sweep_status só authenticated; as demais sem EXECUTE para anon/authenticated (a sem argumento só service_role)",
    (await su(`select bool_and(case p.oid::regprocedure::text
        when 'master_whatsapp_token_sweep_status()' then has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute')
        when 'whatsapp_token_health_sweep()' then has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
        else not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('service_role', p.oid, 'execute') end) ok, count(*) n
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('master_whatsapp_token_sweep_status','whatsapp_token_health_sweep','whatsapp_token_sweep_try_lock')`)).rows[0].ok === true);
  const defs = (await su("select p.proname, pg_get_functiondef(p.oid) d, p.prosecdef sd from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('whatsapp_token_health_sweep','whatsapp_token_sweep_try_lock') order by p.pronargs desc")).rows;
  const sweepDef = defs.find((x) => x.proname === "whatsapp_token_health_sweep" && /p_source/.test(x.d))?.d ?? "";
  const lockDef = defs.find((x) => x.proname === "whatsapp_token_sweep_try_lock")?.d ?? "";
  ck("4.4 estrutura: trava consultiva de TRANSAÇÃO não bloqueante (nada vaza), consultada antes de varrer; SKIP LOCKED; lock_timeout; SECURITY DEFINER", /pg_try_advisory_xact_lock/.test(lockDef) && /whatsapp_token_sweep_try_lock\(\)/.test(sweepDef) && /for update skip locked/.test(sweepDef) && /lock_timeout/.test(sweepDef) && defs.every((x) => x.sd)
    && (await num("select count(*) n from pg_locks where locktype = 'advisory'")) === 0);
  ck("4.5 a varredura não faz chamada externa, não envia mensagem e não toca no Vault (sem net.http, whatsapp_messages ou vault.* no corpo)", !/net\.http|graph|whatsapp_messages|vault\.|delete from public\.(whatsapp_number_registrations|company_whatsapp)/i.test(sweepDef.replace(/delete from public\.whatsapp_token_sweep_runs/g, "")));
}

console.log("\n== 5. execução simultânea: a segunda é IGNORADA ==");
{
  await su("update company_whatsapp_connections set token_status='valid', token_expires_at = now() + interval '1 day' where id=$1", [C]); // passaria a expiring
  const s0 = await snap(); const alerts0 = (await alerts()).length; const runs0 = (await runs()).length;
  await pg.exec("create or replace function public.whatsapp_token_sweep_try_lock() returns boolean language sql as $f$ select false $f$");
  const rk = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0].j;
  const skipped = await lastRun();
  ck("5.1 com a trava ocupada: retorna 'skipped' sem varrer, grava 'skipped_concurrent' e não toca em conexões nem alertas", rk.ok === true && rk.skipped === true && rk.reason === "concurrent" && skipped.status === "skipped_concurrent" && skipped.connections_checked === 0 && skipped.error_code === null
    && JSON.stringify(await snap()) === JSON.stringify(s0) && (await alerts()).length === alerts0 && (await runs()).length === runs0 + 1);
  await pg.exec("create or replace function public.whatsapp_token_sweep_try_lock() returns boolean language sql volatile security definer set search_path = public as $f$ select pg_try_advisory_xact_lock(hashtextextended('whatsapp_token_health_sweep', 0)) $f$");
  const ra = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0].j;
  ck("5.2 trava liberada: a execução seguinte varre normalmente e processa o que ficou para trás (C -> expiring)", ra.ok && !ra.skipped && ra.updated >= 1 && (await su("select token_status s from company_whatsapp_connections where id=$1", [C])).rows[0].s === "expiring");
  ck("5.3 a trava de transação não vaza entre execuções", (await num("select count(*) n from pg_locks where locktype = 'advisory'")) === 0);
}

console.log("\n== 6. falha controlada ==");
{
  await su("update company_whatsapp_connections set token_status='valid', token_expires_at = now() + interval '5 days' where id=$1", [C]); // continua expiring (<=10d) mas estado volta a 'valid'
  await su("delete from whatsapp_token_alerts where connection_id=$1", [C]);
  const s0 = await snap(); const al0 = (await alerts()).length;
  await pg.exec(`create function public.__boom() returns trigger language plpgsql as $f$ begin raise exception 'falha simulada EAAGSECRETOCULTO0123456789abcdefghijkl token'; end $f$;
    create trigger __boom before insert on public.whatsapp_token_alerts for each row execute function public.__boom();`);
  const rf = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0];
  const fr = await lastRun();
  ck("6.1 falha no meio: a função NÃO propaga o erro (o cron continua saudável), devolve ok=false e grava 'failed' com o código SQL", rf?.j?.ok === false && fr.status === "failed" && fr.error_code === "P0001" && fr.connections_checked === 0 && fr.states_updated === 0, JSON.stringify(rf));
  ck("6.2 a mensagem de erro gravada é curta e SEM credencial (token removido)", !!fr.error_message && fr.error_message.length <= 200 && !/EAAGSECRETO/.test(fr.error_message) && /\[removido\]/.test(fr.error_message) && !(JSON.stringify(await runs())).includes(TOKEN));
  {
    const st = (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j;
    ck("6.2b painel do Admin Master: uma falha interna NÃO aparece como sucesso (health='failing', last_run.status='failed') e a falha é identificável SEM consultar tabela interna (last_failure/recent_failures com código e mensagem sanitizada)",
      st.health === "failing" && st.last_run.status === "failed" && st.last_failure?.error_code === "P0001" && /\[removido\]/.test(st.last_failure.error_message) && st.recent_failures.length >= 1 && st.recent_failures[0].error_code === "P0001" && st.failures_24h >= 1
      && !JSON.stringify(st).includes("EAAGSECRETO") && !JSON.stringify(st).includes(TOKEN));
  }
  ck("6.3 atômica: nada que a varredura fez antes de falhar é mantido (nenhuma conexão alterada, nenhum alerta novo)", JSON.stringify(await snap()) === JSON.stringify(s0) && (await alerts()).length === al0);
  await pg.exec("drop trigger __boom on public.whatsapp_token_alerts; drop function public.__boom();");
  const ro = (await svc("select public.whatsapp_token_health_sweep() j")).rows[0].j;
  ck("6.4 corrigida a causa, a próxima execução recupera tudo (C -> expiring, alerta criado) e fica 'success'", ro.ok && (await lastRun()).status === "success" && (await su("select token_status s from company_whatsapp_connections where id=$1", [C])).rows[0].s === "expiring");
}

console.log("\n== 7. retenção, Djalexeventos e Vault ao longo de tudo ==");
{
  await su("insert into whatsapp_token_sweep_runs (source, status, started_at, finished_at) values ('cron','success', now() - interval '91 days', now() - interval '91 days'), ('cron','success', now() - interval '60 days', now() - interval '60 days')");
  await svc("select public.whatsapp_token_health_sweep() j");
  ck("7.1 retenção de 90 dias: a linha de 91 dias é removida e a de 60 dias fica", (await num("select count(*) n from whatsapp_token_sweep_runs where started_at < now() - interval '90 days'")) === 0 && (await num("select count(*) n from whatsapp_token_sweep_runs where started_at < now() - interval '59 days' and started_at > now() - interval '61 days'")) === 1);
  const dNow = await hash(D);
  ck("7.2 Djalexeventos (D) idêntica do início ao fim de todas as execuções; E e F também", dNow === before.D && (await hash(E)) === before.E && (await hash(F)) === before.F);
  const vN = await vaultSig();
  ck("7.3 Vault idêntico do início ao fim (nenhum token/PIN criado, alterado ou removido); registros de número e mensagens intactos", vN.h === vault0.h && vN.n === vault0.n && (await num("select count(*) n from whatsapp_number_registrations")) === regs0 && (await num("select count(*) n from whatsapp_messages")) === msgs0);
  ck("7.4 flag e allowlist continuam como estavam (a varredura não as toca)", (await su("select embedded_signup_enabled e from whatsapp_platform_settings")).rows[0].e === false && (await num("select count(*) n from whatsapp_signup_pilot_companies")) === 0);
}

console.log("\n== 8. estado para o Admin Master / atraso ==");
{
  const st = (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j;
  ck("8.1 Admin Master vê última execução, última com sucesso, never_run=false e overdue=false", st.never_run === false && st.overdue === false && !!st.last_success_at && st.last_run.status === "success" && st.job === null && st.last_cron_run === null && st.failures_24h >= 1);
  ck("8.2 owner de empresa e anon NÃO acessam; o JSON não tem token nem segredo", !(await OWNER("select public.master_whatsapp_token_sweep_status()")).ok && !(await as("anon", null, "select public.master_whatsapp_token_sweep_status()")).ok && !(await svc("select public.master_whatsapp_token_sweep_status()")).ok && !JSON.stringify(st).includes(TOKEN));
  await su("update whatsapp_token_sweep_runs set started_at = now() - interval '14 hours' where status = 'success'");
  const st2 = (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j;
  ck("8.3 sem sucesso há mais de 13 h (2 ciclos + folga): overdue=true", st2.overdue === true && st2.never_run === false);
  ck("8.3b health: overdue é medido pelo ÚLTIMO SUCESSO (execuções falhas/ignoradas recentes não o renovam)", await (async () => {
    await su("update whatsapp_token_sweep_runs set started_at = now() - interval '14 hours' where status = 'success'");
    await su("insert into whatsapp_token_sweep_runs (source, status, started_at, finished_at, error_code, error_message) values ('cron','failed', now(), now(), 'P0001', 'x'), ('cron','skipped_concurrent', now() - interval '1 minute', now(), null, null)");
    const h = (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j;
    await su("delete from whatsapp_token_sweep_runs where error_message = 'x' or status = 'skipped_concurrent'");
    return h.overdue === true && h.health === "failing";
  })());
  await svc("select public.whatsapp_token_health_sweep() j");
  ck("8.4 nova execução bem-sucedida zera o atraso e o health volta a 'ok'", (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j.overdue === false && (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j.health === "ok");
}

console.log("\n== 9. agendamento pg_cron (migration): idempotente, sem sobrescrever ==");
{
  const mig = fs.readFileSync(`${MIG}/${SCHED}`, "utf8");
  const block = mig.slice(mig.lastIndexOf("do $$"));
  ck("9.0 o bloco de agendamento existe e usa o nome e a periodicidade combinados", /whatsapp-token-health-sweep/.test(block) && /7 \*\/6 \* \* \*/.test(block) && /whatsapp_token_health_sweep\('cron'\)/.test(block));
  const noCron = await pg.exec(block).then(() => true, () => false);
  ck("9.1 ambiente SEM pg_cron: o bloco é inofensivo (não falha)", noCron);
  await pg.exec(`create schema cron;
    create table cron.job (jobid bigserial primary key, schedule text, command text, jobname text unique, active boolean default true);
    create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as $f$ insert into cron.job (jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true returning jobid $f$;`);
  await pg.exec("insert into cron.job (jobname, schedule, command) values ('gap-whatsapp-order-notify','10 seconds','select public.order_notify_dispatch_due()')");
  const others0 = JSON.stringify((await su("select jobname, schedule, command, active from cron.job order by jobname")).rows);
  await pg.exec(block);
  const j1 = (await su("select * from cron.job where jobname='whatsapp-token-health-sweep'")).rows;
  ck("9.2 cria UM job 'whatsapp-token-health-sweep' a cada 6 horas (minuto 7) chamando a varredura com origem 'cron'; jobs de outras funcionalidades intactos", j1.length === 1 && j1[0].schedule === "7 */6 * * *" && j1[0].command === "select public.whatsapp_token_health_sweep('cron')" && j1[0].active === true
    && JSON.stringify((await su("select jobname, schedule, command, active from cron.job where jobname <> 'whatsapp-token-health-sweep' order by jobname")).rows) === others0);
  await pg.exec(block);
  ck("9.3 rodar de novo não duplica", (await num("select count(*) n from cron.job where jobname='whatsapp-token-health-sweep'")) === 1);
  await pg.exec("update cron.job set active = false, schedule = '0 3 * * *' where jobname='whatsapp-token-health-sweep'");
  await pg.exec(block);
  const j2 = (await su("select * from cron.job where jobname='whatsapp-token-health-sweep'")).rows[0];
  ck("9.4 desativação/ajuste manual é respeitado: o job desativado NÃO é reativado nem sobrescrito por nova execução da migration", j2.active === false && j2.schedule === "0 3 * * *");
  await pg.exec("update cron.job set active = true, schedule = '7 */6 * * *' where jobname='whatsapp-token-health-sweep'");
  await pg.exec("insert into cron.job_run_details (jobid, status, start_time, end_time) select jobid, 'succeeded', now() - interval '1 hour', now() - interval '1 hour' from cron.job where jobname='whatsapp-token-health-sweep'");
  const st = (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j;
  ck("9.5 o Admin Master também vê o job (periodicidade, ativo) e a última execução do pg_cron como fonte complementar", st.job?.schedule === "7 */6 * * *" && st.job.active === true && st.last_cron_run?.status === "succeeded");
  {
    await su("insert into whatsapp_token_sweep_runs (source, status, started_at, finished_at, error_code, error_message) values ('cron','failed', now(), now(), 'P0001', 'falha simulada')");
    await pg.exec("insert into cron.job_run_details (jobid, status, start_time, end_time) select jobid, 'succeeded', now(), now() from cron.job where jobname='whatsapp-token-health-sweep'");
    const d = (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j;
    ck("9.5b o painel distingue o AGENDADOR do resultado real: pg_cron 'succeeded' + varredura 'failed' => scheduler_ok_but_sweep_failed=true e health='failing'", d.last_cron_run.status === "succeeded" && d.last_run.status === "failed" && d.scheduler_ok_but_sweep_failed === true && d.health === "failing");
    await svc("select public.whatsapp_token_health_sweep() j");
    ck("9.5c depois de uma execução bem-sucedida o alerta de divergência some", (await MASTER("select public.master_whatsapp_token_sweep_status() j")).rows[0].j.health === "ok");
  }
  ck("9.6 o comando do cron é uma única chamada SQL: sem URL, sem segredo, sem service_role", !/https?:|secret|service_role|vault/i.test(j1[0].command));
}

summary("VARREDURA DA SAÚDE DOS TOKENS (ETAPA 9)");
