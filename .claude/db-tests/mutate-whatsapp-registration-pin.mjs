// Mutação da migration 20261106010000 (PIN individual): cada trava removida de propósito deve derrubar whatsapp-registration-pin.mjs
// ou whatsapp-signup-cleanup.mjs.   node mutate-whatsapp-registration-pin.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "D:/orça facil/supabase/migrations";
const FILE = "20261106010000_whatsapp_registration_pin.sql";
const sql = fs.readFileSync(path.join(SRC, FILE), "utf8");
const here = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);
const j = (...lines) => lines.join(NL);
const M = [
  ["prepare aceita número de outra empresa", "elsif v_r.company_id <> v_s.company_id then", "elsif false then"],
  ["PIN gerado substitui um PIN já guardado", "if p_source = 'generated' and v_r.pin_secret_id is not null then", "if false then"],
  ["sem limite de 3 tentativas/72 h", "if v_recent >= 3 then", "if v_recent >= 3000 then"],
  ["begin_attempt ignora uncertain/blocked", j("  elsif v_r.state = 'uncertain' then", "    return jsonb_build_object('ok', false, 'error', 'registration_uncertain');", "  elsif v_r.state = 'blocked' then", "    return jsonb_build_object('ok', false, 'error', 'registration_blocked', 'blocked_until', v_r.blocked_until);", "  elsif v_r.state = 'pin_required' or"), "  elsif v_r.state = 'pin_required' or"],
  ["133005 não descarta o PIN errado", "set state = 'pin_required', pin_secret_id = null, pin_source = null, last_error_code = v_code", "set state = 'pin_required', last_error_code = v_code"],
  ["133016 bloqueia só 1 minuto", "set state = 'blocked', blocked_until = now() + interval '72 hours', last_error_code = v_code", "set state = 'blocked', blocked_until = now() + interval '1 minute', last_error_code = v_code"],
  ["in_progress sem resposta não vira uncertain", "if v_r.state = 'in_progress' and v_r.updated_at < now() - interval '2 minutes' then", "if false then"],
  ["registro concluído não é pulado (reconexão registra de novo)", j("  if v_r.state = 'registered' then", "    v_action := 'skip';"), j("  if false then", "    v_action := 'skip';")],
  ["begin_attempt aceita registro já concluído", j("  if v_r.state = 'registered' then", "    return jsonb_build_object('ok', false, 'error', 'already_registered');", "  elsif"), j("  if false then", "    return jsonb_build_object('ok', false, 'error', 'already_registered');", "  elsif")],
  ["store_pin sobrescreve PIN de número registrado", "if v_r.state not in ('pending', 'failed', 'pin_required') then", "if false then"],
  ["finish_attempt não é idempotente", "if v_a.status <> 'started' then", "if false then"],
  ["sessão e registro de empresas diferentes", "if not found or v_r.company_id <> v_s.company_id then", "if not found then"],
  ["varredura de PIN inclui registered/uncertain", "r.state in ('pending', 'failed', 'pin_required')", "r.state in ('pending', 'failed', 'pin_required', 'registered', 'uncertain')"],
  ["varredura de PIN sem trava de nome", "delete from vault.secrets where id = v_row.pin_secret_id and starts_with(name, 'wa_pin_');", "delete from vault.secrets where id = v_row.pin_secret_id;"],
  ["gatilho de exclusão sem trava de nome", "delete from vault.secrets where id = old.pin_secret_id and starts_with(name, 'wa_pin_');", "delete from vault.secrets where id = old.pin_secret_id;"],
  ["revelação sem autenticação recente", "if not v_recent then", "if false then"],
  ["revelação sem limite de consultas", "where company_id = v_conn.company_id and created_at > now() - interval '1 hour') >= 3", "where company_id = v_conn.company_id and created_at > now() - interval '1 hour') >= 3000"],
  ["ticket reutilizável", "if v_g.status <> 'authorized' then", "if false then"],
  ["ticket de outro usuário vale", "if not found or v_g.requested_by is distinct from p_user_id then", "if not found then"],
  ["consumo não reconfere o papel do usuário", "if not public.whatsapp_signup_user_can_manage(v_g.company_id, p_user_id) then", "if false then"],
  ["authenticated ganha o consumo do PIN", "grant execute on function public.whatsapp_pin_reveal_consume(uuid, uuid) to service_role;", "grant execute on function public.whatsapp_pin_reveal_consume(uuid, uuid) to service_role, authenticated;"],
  ["sweep de sessões failed ignora a conexão", "    if not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_row.token_secret_id) then", "    if true then"],
  ["begin_attempt devolve PIN sem formato válido", "if v_pin is null or v_pin !~ '^[0-9]{6}$' then" + NL + "    return jsonb_build_object('ok', false, 'error', 'pin_not_available');" + NL + "  end if;" + NL + "  insert into public.whatsapp_registration_attempts", "insert into public.whatsapp_registration_attempts"],
];
let killed = 0, run = 0;
for (const [name, from, to] of M) {
  if (!sql.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-pin-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, FILE), sql.replace(from, () => to));
  let detected = false, info = "";
  for (const t of ["whatsapp-registration-pin.mjs", "whatsapp-signup-cleanup.mjs"]) {
    let out = "";
    try { out = execFileSync("node", [t], { cwd: here, env: { ...process.env, MIG_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
    catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
    const m = out.match(/(\d+) ok \/ (\d+) falhas/);
    if (!m || Number(m[2]) > 0) { detected = true; info = `${t}${m ? ` (${m[2]} falhas)` : " (abortou)"}`; break; }
  }
  run++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name} ${info}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${run} mutações detectadas`);
