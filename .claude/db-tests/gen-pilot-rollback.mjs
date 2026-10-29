// Gera whatsapp-signup-pilot.rollback.sql: restaura begin/reserve/complete (1104) e get_module_state (ia_modules) e remove a allowlist.
import fs from "node:fs";
const MIG = "D:/orça facil/supabase/migrations/";
const take = (file, startRe) => {
  const t = fs.readFileSync(MIG + file, "utf8");
  const m = startRe.exec(t);
  if (!m) throw new Error("não achei " + startRe);
  const end = t.indexOf("\n$$;", m.index) + 4;
  return t.slice(m.index, end).replace(/^create function/, "create or replace function");
};
const parts = [
  "-- Rollback de 20261107010000_whatsapp_signup_pilot_allowlist.sql (GERADO por gen-pilot-rollback.mjs). Não toca em conexões, tokens, PINs ou mensagens.",
  take("20261028010000_whatsapp_ia_modules.sql", /create function public\.whatsapp_get_module_state\(/),
  take("20261104010000_whatsapp_embedded_signup_foundation.sql", /create or replace function public\.whatsapp_signup_begin\(/),
  take("20261105010000_whatsapp_signup_failed_cleanup.sql", /create or replace function public\.whatsapp_signup_fail\(/),
  take("20261106010000_whatsapp_registration_pin.sql", /create or replace function public\.whatsapp_signup_sweep\(/),
  take("20261104010000_whatsapp_embedded_signup_foundation.sql", /create function public\.whatsapp_signup_reserve\(/),
  take("20261104010000_whatsapp_embedded_signup_foundation.sql", /create function public\.whatsapp_signup_complete\(/),
  `drop function public.master_whatsapp_pilot_events(uuid);
drop function public.master_whatsapp_pilot_list();
drop function public.master_whatsapp_pilot_set(uuid, boolean, text);
drop function public.whatsapp_signup_availability_for_company(uuid);
drop function public.whatsapp_signup_external_op_open(uuid);
drop function public.whatsapp_signup_pilot_allowed(uuid);
drop table public.whatsapp_signup_pilot_events;
drop table public.whatsapp_signup_pilot_companies;`,
];
fs.writeFileSync("D:/orça facil/.claude/db-tests/whatsapp-signup-pilot.rollback.sql", parts.join("\n\n") + "\n");
console.log("ok");
