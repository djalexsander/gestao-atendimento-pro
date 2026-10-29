// Mutação da Etapa 10.1 (nota obrigatória do piloto): cada trava removida deve derrubar whatsapp-pilot-note.mjs.
//   node mutate-whatsapp-pilot-note.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "D:/orça facil/supabase/migrations";
const NEW = "20261111010000_whatsapp_pilot_set_require_note.sql";
const sql = fs.readFileSync(path.join(SRC, NEW), "utf8");
const here = path.dirname(fileURLToPath(import.meta.url));
const NLC = String.fromCharCode(10);
const Q = String.fromCharCode(39);
const NOTE = `nullif(btrim(coalesce(p_note, ${Q}${Q})), ${Q}${Q})`;
const M = [
  ["sem checar Admin Master", "  perform public.assert_master_admin();" + NLC, ""],
  ["nota vazia aceita", "if v_note is null then", "if false then"],
  ["nota curta aceita", "if char_length(v_note) < 5 then", "if false then"],
  ["mínimo de 1 caractere em vez de 5", "char_length(v_note) < 5", "char_length(v_note) < 1"],
  ["limite de 500 removido", "if char_length(v_note) > 500 then", "if false then"],
  ["limite de 500 virou 1000", "char_length(v_note) > 500", "char_length(v_note) > 1000"],
  ["trunca em silêncio em vez de recusar", NOTE + ";", `left(${NOTE}, 500);`],
  ["não apara espaços (só espaços passa)", NOTE, `nullif(coalesce(p_note, ${Q}${Q}), ${Q}${Q})`],
  ["validação só ao autorizar (revogar sem motivo passa)", "  if v_note is null then", "  if p_authorized and v_note is null then"],
  ["evento de autorização sem a nota", `values (p_company_id, ${Q}authorized${Q}, v_actor, v_note)`, `values (p_company_id, ${Q}authorized${Q}, v_actor, null)`],
  ["evento de revogação sem a nota", `values (p_company_id, ${Q}revoked${Q}, v_actor, v_note)`, `values (p_company_id, ${Q}revoked${Q}, v_actor, null)`],
  ["reautorização mantém a nota antiga", "note = v_note, updated_at = now()", "updated_at = now()"],
  ["revogação não encerra sessões", `perform public.whatsapp_signup_fail(v_sess.id, ${Q}pilot_revoked${Q});`, "null;"],
  ["sem search_path fixo", "set search_path = public" + NLC + "as $$", "as $$"],
  ["liberada a anon", "to authenticated;", "to authenticated, anon;"],
  ["liberada a service_role", "to authenticated;", "to authenticated, service_role;"],
  ["sem autor da autorização", "authorized_by = v_actor, authorized_at = now(), revoked_by = null", "authorized_by = null, authorized_at = now(), revoked_by = null"],
  ["sem autor do evento de revogação", "set authorized = false, revoked_by = v_actor", "set authorized = false, revoked_by = null"],
];

let killed = 0, total = 0;
for (const [name, from, to] of M) {
  if (!sql.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-note-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, NEW), sql.split(from).join(to));
  let out = "";
  try { out = execFileSync("node", ["whatsapp-pilot-note.mjs"], { cwd: here, env: { ...process.env, MIG_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${total} mutações detectadas`);
