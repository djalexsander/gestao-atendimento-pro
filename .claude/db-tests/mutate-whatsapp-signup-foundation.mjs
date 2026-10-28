// Mutação da migration 20261104010000: cada trava removida de propósito deve derrubar a suíte whatsapp-signup-foundation.mjs.
//   node mutate-whatsapp-signup-foundation.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "D:/orça facil/supabase/migrations";
const NEW = "20261104010000_whatsapp_embedded_signup_foundation.sql";
const sql = fs.readFileSync(path.join(SRC, NEW), "utf8");
const NL = String.fromCharCode(10);
const M = [
  ["reserva sem exigir pending (replay)", "where state_hash = v_hash and status = 'pending' and expires_at > now()", "where state_hash = v_hash and expires_at > now()"],
  ["reserva sem checar expiração", "where state_hash = v_hash and status = 'pending' and expires_at > now()", "where state_hash = v_hash and status = 'pending'"],
  ["state em claro no lugar do hash", "encode(sha256(convert_to(v_state, 'UTF8')), 'hex')", "encode(sha256(convert_to('x' || v_state, 'UTF8')), 'hex')"],
  ["(equivalente justificado: o índice único global ainda barra) conflito de número ignorado só na checagem", "c.phone_number_id = p_phone_number_id and c.company_id <> v_s.company_id", "false"],
  ["conflito de número ignorado (checagem E índice-guard)", "c.phone_number_id = p_phone_number_id and c.company_id <> v_s.company_id", "false", "exception when unique_violation then", "exception when no_data_found then"],
  ["begin não varre sessões/segredos vencidos", "perform public.whatsapp_signup_sweep(p_company_id);", "null;"],
  ["sweep apaga segredo mesmo ligado a conexão", "if v_row.token_secret_id is not null" + NL + "       and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_row.token_secret_id) then", "if v_row.token_secret_id is not null then"],
  ["store_token devolve a referência ao chamador", "return jsonb_build_object('ok', true);" + NL + "end;" + NL + "$$;" + NL + "" + NL + "-- ---------------------------------------------------------------------------" + NL + "-- 7) Falha", "return jsonb_build_object('ok', true, 'token_secret_id', v_secret);" + NL + "end;" + NL + "$$;" + NL + "" + NL + "-- ---------------------------------------------------------------------------" + NL + "-- 7) Falha"],
  ["complete após vencimento não limpa o segredo", "    perform public.whatsapp_signup_sweep(v_s.company_id);" + NL + "    return jsonb_build_object('ok', false, 'error', 'expired');", "    return jsonb_build_object('ok', false, 'error', 'expired');"]," + NL + "  ["limite de uma conexão ativa ignorado", "where company_id = v_s.company_id and status = 'active' and phone_number_id is distinct from p_phone_number_id", "where false"],
  ["limite de uma conexão ativa ignorado", "where company_id = v_s.company_id and status = 'active' and phone_number_id is distinct from p_phone_number_id", "where false"],
  ["conclusão sem exigir sessão reservada", "if v_s.status <> 'reserved' then\n    return jsonb_build_object('ok', false, 'error', case", "if false then\n    return jsonb_build_object('ok', false, 'error', case"],
  ["conclusão repetida regrava (sem idempotência)", "if v_s.status = 'completed' then", "if false then"],
  ["autorização não reconferida na conclusão", "if not public.whatsapp_signup_user_can_manage(v_s.company_id, v_s.user_id) then\n    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'unauthorized' where id = v_s.id;\n    return jsonb_build_object('ok', false, 'error', 'unauthorized');\n  end if;\n\n  perform pg_advisory", "perform pg_advisory"],
  ["nova conexão nasce em modo live", "(v_s.company_id, 'active', 'test',", "(v_s.company_id, 'active', 'live',"],
  ["token antigo não removido na rotação", "delete from vault.secrets where id = v_old_secret;", "null;"],
  ["fail não remove o segredo órfão", "delete from vault.secrets where id = v_s.token_secret_id;", "null;"],
  ["tipo coexistence aceito", "if p_connection_type is distinct from 'cloud_api' then", "if false then"],
  ["sem limite de tentativas", ">= 10 then", ">= 100000 then"],
  ["begin não cancela pendentes anteriores", "update public.whatsapp_signup_sessions set status = 'cancelled'\n   where company_id = p_company_id and status = 'pending';", "null;"],
  ["service_role perde EXECUTE da conclusão", "grant execute on function public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text) to service_role;", ""],
  ["authenticated ganha EXECUTE da conclusão", "grant execute on function public.whatsapp_signup_reserve(text) to service_role;", "grant execute on function public.whatsapp_signup_reserve(text) to service_role, authenticated;"],
];
let killed = 0;
for (const [name, from, to, from2, to2] of M.filter(Boolean)) {
  if (!sql.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-signup-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  let mut = sql.replace(from, () => to);
  if (from2) mut = mut.replace(from2, () => to2);
  fs.writeFileSync(path.join(dir, NEW), mut);
  let out = "";
  try { out = execFileSync("node", ["whatsapp-signup-foundation.mjs"], { cwd: path.dirname(fileURLToPath(import.meta.url)), env: { ...process.env, MIG_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  if (detected) killed++;
  if (!m) console.log(out.slice(-600));
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${M.length} mutações detectadas`);
