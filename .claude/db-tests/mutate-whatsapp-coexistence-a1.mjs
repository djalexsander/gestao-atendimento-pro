// Mutação da correção A1 (account_update atrasado/duplicado/fora de ordem/concorrente): cada trava removida deve derrubar whatsapp-coexistence-a1.mjs.
// Um mutante pode trocar vários trechos de uma vez (lista de pares) para anular defesas redundantes. ONLY="trecho" filtra por nome.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "D:/orça facil";
const here = path.dirname(fileURLToPath(import.meta.url));
const H = "supabase/functions/whatsapp-webhook/handler.ts";
const MG = "supabase/migrations/20261124010000_whatsapp_coexistence_webhooks.sql";
const OTHER_ACTIVE = "if exists (select 1 from public.company_whatsapp_connections o\n                    where o.company_id = v_row.company_id and o.status = 'active' and o.id <> v_row.id) then";
const NET = "exception when unique_violation then";
const M = [
  [H, "webhook não repassa entry.time", [["p_event_time: evTime });", "p_event_time: null });"]]],
  [MG, "sem descarte de eventos atrasados", [["    if v_when < v_base then", "    if false then"]]],
  [MG, "base ignora o onboarding da conexão", [["date_trunc('second', coalesce(v_row.connected_at, '-infinity'::timestamptz)),", "'-infinity'::timestamptz,"]]],
  [MG, "base ignora a marca d'água do último evento", [["coalesce(v_row.lifecycle_event_at, '-infinity'::timestamptz));", "'-infinity'::timestamptz);"]]],
  [MG, "sem marca d'água para eventos sem mudança de estado", [["    if v_event = 'PARTNER_REMOVED' or (v_event in ('ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED') and v_row.connection_type = 'coexistence') then\n      update", "    if false then\n      update"]]],
  [MG, "horário no futuro é aceito", [["and to_timestamp(p_event_time) <= now() + interval '1 day'", ""]]],
  [MG, "evento sem horário altera conexões", [["  if v_when is null then\n    update public.whatsapp_coexistence_events set detail = jsonb_build_object('changed', 0, 'skipped', 'no_event_time')", "  if false then\n    update public.whatsapp_coexistence_events set detail = jsonb_build_object('changed', 0, 'skipped', 'no_event_time')"]]],
  [MG, "reativa a antiga mesmo com outra conexão ativa (checagem E rede de segurança removidas)", [[OTHER_ACTIVE, "if false then"], [NET, "exception when no_data_found then"]]],
  [MG, "reativa a antiga com outra ativa (só a checagem removida: a rede de segurança do índice segura)", [[OTHER_ACTIVE, "if false then"]]],
  [MG, "reativa por palpite com duas pausadas", [["elsif exists (select 1 from public.company_whatsapp_connections o\n                       where o.company_id = v_row.company_id and o.id <> v_row.id and o.status = 'error' and o.lifecycle_state = 'offboarded') then", "elsif false then"]]],
  [MG, "RECONNECTED reativa qualquer conexão (não só a pausada)", [["      if v_row.status = 'error' and v_row.lifecycle_state = 'offboarded' then\n        if exists", "      if true then\n        if exists"]]],
  [MG, "RECONNECTED também vale para Cloud API", [["elsif v_event = 'ACCOUNT_RECONNECTED' and v_row.connection_type = 'coexistence' then", "elsif v_event = 'ACCOUNT_RECONNECTED' then"]]],
  [MG, "evento atinge conexões manuais", [["where c.waba_id = p_waba_id and c.connection_source = 'embedded_signup'\n     order by c.id\n       for update", "where c.waba_id = p_waba_id\n     order by c.id\n       for update"]]],
  [MG, "resposta 'ignored' vira 'recorded' (a duplicata/atraso passa por sucesso)", [["case when v_changed = 0 and (v_skipped > 0 or v_stale > 0) then 'ignored' else 'recorded' end", "'recorded'"]]],
  [MG, "ACL: RPC aberta a authenticated", [["grant execute on function public.whatsapp_coexistence_account_update(text, text, text, text, bigint) to service_role;", "grant execute on function public.whatsapp_coexistence_account_update(text, text, text, text, bigint) to service_role, authenticated;"]]],
];
let killed = 0, run = 0;
for (const [file, name, pairs] of M) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
  let src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const orig = src;
  let missing = false;
  for (const [from, to] of pairs) { if (!src.includes(from)) { missing = true; break; } src = src.replace(from, () => to); }
  if (missing) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-a1-"));
  const isMig = file.startsWith("supabase/migrations/");
  fs.mkdirSync(path.dirname(path.join(dir, H)), { recursive: true });
  fs.writeFileSync(path.join(dir, H), file === H ? src : fs.readFileSync(path.join(ROOT, H), "utf8"));
  let migDir = null;
  if (isMig) {
    migDir = path.join(dir, "migrations");
    fs.mkdirSync(migDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations"))) fs.copyFileSync(path.join(ROOT, "supabase/migrations", f), path.join(migDir, f));
    fs.writeFileSync(path.join(migDir, path.basename(file)), src);
  }
  void orig;
  let out = "";
  try { out = execFileSync("node", ["whatsapp-coexistence-a1.mjs"], { cwd: here, env: { ...process.env, SRC_ROOT: dir, ...(migDir ? { MIG_DIR: migDir } : {}) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  run++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${run} mutações detectadas`);
