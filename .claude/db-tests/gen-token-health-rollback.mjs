// Gera whatsapp-token-health.rollback.sql: restaura whatsapp_get_send_context e whatsapp_get_module_state como eram ANTES da 20261108010000
// (extraídos do banco carregado só com as migrations anteriores) e remove tudo que a migration criou. Não toca em conexões/mensagens/segredos.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAll } from "./full-db.mjs";

const SRC = "D:/orça facil/supabase/migrations";
const NEW = "20261108010000_whatsapp_token_health_and_registration_recovery.sql";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokrb-"));
for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql") && f < NEW) fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
const { pg } = await loadAll(tmp, { legacyIaMirror: false });
const def = async (name) => (await pg.query("select pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=$1", [name])).rows[0].d;
const parts = [
  "-- Rollback de 20261108010000_whatsapp_token_health_and_registration_recovery.sql (GERADO por gen-token-health-rollback.mjs).",
  "-- Não toca em conexões, mensagens, segredos, PINs nem na allowlist.",
  (await def("whatsapp_get_send_context")) + ";",
  (await def("whatsapp_get_module_state")) + ";",
  `drop function public.master_whatsapp_registration_resolve(uuid, text, text, text, text);
drop function public.master_whatsapp_registration_list(text[]);
drop function public.master_whatsapp_token_health();
drop function public.whatsapp_token_health_sweep();
drop function public.whatsapp_connection_report_send_ok(uuid);
drop function public.whatsapp_connection_report_token_failure(uuid, text, text, text);
drop function public.whatsapp_token_alert_for(uuid);
drop function public.whatsapp_token_effective_status(public.company_whatsapp_connections);
drop table public.whatsapp_registration_resolutions;
drop table public.whatsapp_token_alerts;
alter table public.company_whatsapp_connections drop column token_checked_at;`,
];
fs.writeFileSync("D:/orça facil/.claude/db-tests/whatsapp-token-health.rollback.sql", parts.join("\n\n") + "\n");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok");
