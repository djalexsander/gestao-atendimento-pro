// Mutação da Etapa 9 (varredura dos tokens + auditoria + agendamento): cada trava removida deve derrubar whatsapp-token-sweep.mjs.
//   node mutate-whatsapp-token-sweep.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "D:/orça facil/supabase/migrations";
const NEW = "20261109010000_whatsapp_token_health_sweep_schedule.sql";
const sql = fs.readFileSync(path.join(SRC, NEW), "utf8");
const here = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);
const L = (...a) => a.join(NL);
const LOOP_WHERE = L("       where status = 'active' and token_expires_at is not null and token_status not in ('revoked')", "       order by id");

const M = [
  ["varredura toca conexões sem prazo conhecido (Djalexeventos)", LOOP_WHERE, L("       where status = 'active' and token_status not in ('revoked')", "       order by id")],
  ["varredura inclui conexões revogadas", LOOP_WHERE, L("       where status = 'active' and token_expires_at is not null", "       order by id")],
  ["varredura inclui conexões desconectadas", LOOP_WHERE, L("       where token_expires_at is not null and token_status not in ('revoked')", "       order by id")],
  ["sem trava de concorrência", "if not public.whatsapp_token_sweep_try_lock() then", "if false then"],
  ["execução ignorada não é auditada como tal", "values (v_source, 'skipped_concurrent', v_started)", "values (v_source, 'success', v_started)"],
  ["trava de SESSÃO (vaza) em vez de transação", "select pg_try_advisory_xact_lock(hashtextextended('whatsapp_token_health_sweep', 0));", "select pg_try_advisory_lock(hashtextextended('whatsapp_token_health_sweep', 0));"],
  ["trava sempre concedida", "select pg_try_advisory_xact_lock(hashtextextended('whatsapp_token_health_sweep', 0));", "select true;"],
  ["sem SKIP LOCKED", "for update skip locked", "for update"],
  ["sem lock_timeout", "set lock_timeout = '5s'\n", ""],
  ["falha propagada em vez de auditada", "exception when others then", "exception when no_data_found then"],
  ["falha auditada como sucesso", "values (v_source, 'failed', v_started, v_code, v_msg)", "values (v_source, 'success', v_started, v_code, v_msg)"],
  ["mensagem de erro sem sanitização", "v_msg := left(regexp_replace(sqlerrm, '(EAA[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{32,})', '[removido]', 'g'), 200);", "v_msg := left(sqlerrm, 200);"],
  ["mensagem de erro sem limite de tamanho", "v_msg := left(regexp_replace(sqlerrm, '(EAA[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{32,})', '[removido]', 'g'), 200);", "v_msg := regexp_replace(sqlerrm, '(EAA[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{32,})', '[removido]', 'g') || repeat('x', 300);"],
  ["contagem de estados atualizados nunca sobe", "v_updated := v_updated + 1;", "v_updated := v_updated;"],
  ["atualiza mesmo sem mudança (não idempotente)", "if v_row.token_status is distinct from v_eff then", "if true then"],
  ["criados e renovados invertidos", "if v_inserted then v_created := v_created + 1; else v_refreshed := v_refreshed + 1; end if;", "if v_inserted then v_refreshed := v_refreshed + 1; else v_created := v_created + 1; end if;"],
  ["origem livre na auditoria", "case when p_source = 'cron' then 'cron' else 'manual' end", "p_source"],
  ["versão sem argumento passa a registrar 'cron'", "select public.whatsapp_token_health_sweep('manual');", "select public.whatsapp_token_health_sweep('cron');"],
  ["sem retenção", "delete from public.whatsapp_token_sweep_runs where started_at < now() - interval '90 days';", "null;"],
  ["retenção apaga tudo de mais de 1 dia", "interval '90 days';", "interval '1 day';"],
  ["verificação de atraso frouxa demais", "v_ok < now() - interval '13 hours'", "v_ok < now() - interval '400 hours'"],
  ["estado do Admin Master sem checar o papel", "  perform public.assert_master_admin();\n  select * into v_last", "  select * into v_last"],
  ["estado do Admin Master liberado a anon", "grant execute on function public.master_whatsapp_token_sweep_status() to authenticated;", "grant execute on function public.master_whatsapp_token_sweep_status() to authenticated, anon;"],
  ["varredura com origem liberada a service_role", "revoke execute on function public.whatsapp_token_health_sweep(text) from public, anon, authenticated, service_role;", "revoke execute on function public.whatsapp_token_health_sweep(text) from public, anon, authenticated;"],
  ["tabela de auditoria acessível ao cliente", "revoke all on public.whatsapp_token_sweep_runs from public, anon, authenticated;", "revoke all on public.whatsapp_token_sweep_runs from public, anon;"],
  ["painel ignora falha da varredura (health nunca 'failing')", "when v_last.status = 'failed' then 'failing'", "when false then 'failing'"],
  ["painel não distingue agendador x varredura", "and v_cronrun.status = 'failed', false)", "and v_cronrun.status = 'success', false)"],
  ["painel não expõe a última falha", "'last_failure', case when v_fail.id is null then null else", "'last_failure', case when true then null else"],
  ["painel sem lista de falhas recentes", "order by started_at desc limit 5) f", "order by started_at desc limit 0) f"],
  ["atraso medido pela última execução (qualquer status) e não pelo último sucesso", "select max(started_at) into v_ok from public.whatsapp_token_sweep_runs where status = 'success';", "select max(started_at) into v_ok from public.whatsapp_token_sweep_runs;"],
  ["cron a cada minuto", "'7 */6 * * *'", "'* * * * *'"],
  ["cron sobrescreve/duplica job existente", "if not exists (select 1 from cron.job where jobname = 'whatsapp-token-health-sweep') then", "if true then"],
  ["cron sem origem 'cron'", "$cmd$select public.whatsapp_token_health_sweep('cron')$cmd$", "$cmd$select public.whatsapp_token_health_sweep()$cmd$"],
];

let killed = 0, total = 0;
for (const [name, from, to] of M) {
  if (!sql.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-sweep-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, NEW), sql.split(from).join(to));
  let out = "";
  try { out = execFileSync("node", ["whatsapp-token-sweep.mjs"], { cwd: here, env: { ...process.env, MIG_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${total} mutações detectadas`);
