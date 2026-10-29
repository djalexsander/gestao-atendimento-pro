// Gera whatsapp-token-sweep.rollback.sql e PROVA o rollback: aplica no banco com TODAS as migrations e confere que funções (corpo, ACL) e tabelas
// ficam idênticas às de um banco só com as migrations anteriores, sem tocar em conexões, alertas, tokens/PINs ou mensagens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAll } from "./full-db.mjs";

const SRC = "D:/orça facil/supabase/migrations";
const NEW = "20261109010000_whatsapp_token_health_sweep_schedule.sql";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swrb-"));
for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql") && f < NEW) fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
const pre = await loadAll(tmp, { legacyIaMirror: false });
const def = async (name, args) => (await pre.pg.query("select pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=$1 and pg_get_function_identity_arguments(p.oid)=$2", [name, args])).rows[0].d;
const rb = [
  "-- Rollback de 20261109010000_whatsapp_token_health_sweep_schedule.sql (GERADO por gen-token-sweep-rollback.mjs).",
  "-- Remove o job pg_cron (se existir), restaura a varredura e a RPC antiga de registro como eram e apaga a auditoria de execuções.",
  "-- Não toca em conexões, alertas, tokens, PINs, mensagens, allowlist nem na flag.",
  `do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'whatsapp-token-health-sweep';
  end if;
end $$;`,
  (await def("whatsapp_token_health_sweep", "")) + ";",
  (await def("whatsapp_registration_resolve", "p_registration_id uuid, p_outcome text")) + ";",
  `drop function public.master_whatsapp_token_sweep_status();
drop function public.whatsapp_token_health_sweep(text);
drop function public.whatsapp_token_sweep_try_lock();
drop table public.whatsapp_token_sweep_runs;`,
];
const out = "D:/orça facil/.claude/db-tests/whatsapp-token-sweep.rollback.sql";
fs.writeFileSync(out, rb.join("\n\n") + "\n");

// prova
const sig = async (pg) => ({
  fns: (await pg.query("select p.oid::regprocedure::text s, md5(p.prosrc) h, p.prosecdef d, coalesce(p.proconfig::text,'') c, has_function_privilege('anon',p.oid,'execute') a, has_function_privilege('authenticated',p.oid,'execute') u, has_function_privilege('service_role',p.oid,'execute') r from pg_proc p where p.pronamespace='public'::regnamespace order by 1")).rows,
  tbls: (await pg.query("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1")).rows.map((r) => r.relname),
});
const base = await sig(pre.pg);
const upto = fs.mkdtempSync(path.join(os.tmpdir(), "swrb-full-"));
for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql") && f <= NEW) fs.copyFileSync(path.join(SRC, f), path.join(upto, f)); // as posteriores têm rollback próprio
const full = await loadAll(upto, { legacyIaMirror: false });
await full.pg.exec(`insert into companies (id,name,slug,document,email) values ('00000000-0000-4000-8000-0000000000aa','Emp RB','rb-e','11222333000181','rb@x.com');
  insert into company_whatsapp_connections (id, company_id, status, mode, phone_number_id, token_status) values ('00000000-0000-4000-8000-0000000000ab','00000000-0000-4000-8000-0000000000aa','active','live','999111','unknown');
  select public.whatsapp_token_health_sweep();`);
const dataBefore = JSON.stringify((await full.pg.query("select md5(string_agg(c::text, ',')) h from company_whatsapp_connections c")).rows);
let ok = true; const say = (m, c) => { if (!c) ok = false; console.log((c ? "PASS - " : "FAIL - ") + m); };
try { await full.pg.exec(fs.readFileSync(out, "utf8")); say("rollback executa sem erro (com a auditoria já preenchida)", true); } catch (e) { say("rollback executa sem erro: " + e.message, false); }
const after = await sig(full.pg);
say("funções (corpo, SECURITY DEFINER, config, ACL) idênticas às de antes da migration", JSON.stringify(after.fns) === JSON.stringify(base.fns));
say("tabelas idênticas às de antes da migration (whatsapp_token_sweep_runs removida)", JSON.stringify(after.tbls) === JSON.stringify(base.tbls));
say("conexões intactas e a varredura antiga volta a funcionar", JSON.stringify((await full.pg.query("select md5(string_agg(c::text, ',')) h from company_whatsapp_connections c")).rows) === dataBefore && (await full.pg.query("select public.whatsapp_token_health_sweep() j")).rows[0].j.ok === true);
try { await full.pg.exec(fs.readFileSync(out, "utf8").replace(/drop function[\s\S]*$/, "")); say("o trecho de restauração é reexecutável", true); } catch (e) { say("trecho reexecutável: " + e.message, false); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "\nROLLBACK DA ETAPA 9: OK" : "\nROLLBACK DA ETAPA 9: FALHOU");
process.exit(ok ? 0 : 1);
