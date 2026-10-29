// Mutação da allowlist do piloto (migration 20261107010000 + gates da Edge): cada trava removida de propósito deve derrubar
// whatsapp-signup-pilot.mjs.   node mutate-whatsapp-signup-pilot.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "D:/orça facil";
const SRC = path.join(ROOT, "supabase/migrations");
const NEW = "20261107010000_whatsapp_signup_pilot_allowlist.sql";
const sql = fs.readFileSync(path.join(SRC, NEW), "utf8");
const H = "supabase/functions/whatsapp-signup-complete/handler.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);
const L = (...a) => a.join(NL);

const SQLM = [
  ["begin ignora a allowlist", "v_av := public.whatsapp_signup_availability_for_company(p_company_id);", "v_av := public.whatsapp_signup_availability();"],
  ["estado da tela ignora a allowlist", "v_signup := public.whatsapp_signup_availability_for_company(p_company_id);", "v_signup := public.whatsapp_signup_availability();"],
  ["disponibilidade por empresa ignora a allowlist", "if not public.whatsapp_signup_pilot_allowed(p_company_id) then", "if false then"],
  ["allowlist ignora a flag authorized (linha revogada continua valendo)", "where p.company_id = p_company_id and p.authorized);", "where p.company_id = p_company_id);"],
  ["reserve não confere a allowlist", L("-- a autorização é conferida de novo no consumo (o papel ou a liberação do piloto podem ter mudado desde a criação)", "  if not public.whatsapp_signup_pilot_allowed(v_s.company_id) then"), L("-- a autorização é conferida de novo no consumo (o papel ou a liberação do piloto podem ter mudado desde a criação)", "  if false then")],
  ["complete não confere a allowlist", L("    return jsonb_build_object('ok', false, 'error', 'token_not_stored');", "  end if;", "  if not public.whatsapp_signup_pilot_allowed(v_s.company_id) then"), L("    return jsonb_build_object('ok', false, 'error', 'token_not_stored');", "  end if;", "  if false then")],
  ["revogar não encerra as sessões em andamento", "perform public.whatsapp_signup_fail(v_sess.id, 'pilot_revoked');", "null;"],
  ["revogar grava evento errado", "values (p_company_id, 'revoked', v_actor, v_note);", "values (p_company_id, 'authorized', v_actor, v_note);"],
  ["revogar não grava quem revogou", "set authorized = false, revoked_by = v_actor,", "set authorized = false, revoked_by = null,"],
  ["autorizar não grava quem autorizou", "values (p_company_id, true, v_actor, now(), v_note);", "values (p_company_id, true, null, now(), v_note);"],
  ["reautorizar não zera a revogação", L("set authorized = true, authorized_by = v_actor, authorized_at = now(), revoked_by = null, revoked_at = null,"), L("set authorized = true, authorized_by = v_actor, authorized_at = now(),")],
  ["set sem assert_master_admin", L("  perform public.assert_master_admin();", "  v_actor := auth.uid();"), L("  v_actor := auth.uid();")],
  ["list sem assert_master_admin", L("begin", "  perform public.assert_master_admin();", "  return coalesce(("), L("begin", "  return coalesce((")],
  ["events sem assert_master_admin", L("  perform public.assert_master_admin();", "  return coalesce((", "    select jsonb_agg(jsonb_build_object('action'"), L("  return coalesce((", "    select jsonb_agg(jsonb_build_object('action'")],
  ["helper interno com grant para authenticated", "revoke execute on function public.whatsapp_signup_pilot_allowed(uuid) from public, anon, authenticated, service_role;", "revoke execute on function public.whatsapp_signup_pilot_allowed(uuid) from public, anon, authenticated, service_role;" + NL + "grant execute on function public.whatsapp_signup_pilot_allowed(uuid) to authenticated;"],
  ["RPC master com grant para service_role", "revoke execute on function public.master_whatsapp_pilot_set(uuid, boolean, text) from public, anon, service_role;", "revoke execute on function public.master_whatsapp_pilot_set(uuid, boolean, text) from public, anon, service_role;" + NL + "grant execute on function public.master_whatsapp_pilot_set(uuid, boolean, text) to service_role;"],
  ["tabela da allowlist acessível ao cliente", "revoke all on public.whatsapp_signup_pilot_companies from public, anon, authenticated;", "revoke all on public.whatsapp_signup_pilot_companies from public, anon;"],
  ["allowlist preenchida por padrão", "authorized boolean not null default false,", "authorized boolean not null default true,"],
  ["lista do master vaza o state/segredo", "'connection_active', exists", "'secret', 'x', 'connection_active', exists"],
  ["fail apaga o token mesmo com operação externa em aberto", "v_keep := public.whatsapp_signup_external_op_open(v_s.id);", "v_keep := false;"],
  ["sweep (vencidas) apaga o token mesmo com operação externa em aberto", "v_keep := public.whatsapp_signup_external_op_open(v_row.id);", "v_keep := false;"],
  ["sweep (encerradas) apaga o token mesmo com operação externa em aberto", L("    if public.whatsapp_signup_external_op_open(v_row.id) then", "      continue;"), L("    if false then", "      continue;")],
  ["operação externa em curso (in_progress) não protege o token", "r.state in ('in_progress', 'uncertain')", "r.state in ('uncertain')"],
  ["operação externa incerta (uncertain) não protege o token", "r.state in ('in_progress', 'uncertain')", "r.state in ('in_progress')"],
  ["complete passa a derrubar o papel (perde o gate de papel)", L("  if not public.whatsapp_signup_user_can_manage(v_s.company_id, v_s.user_id) then", "    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'unauthorized' where id = v_s.id;", "    return jsonb_build_object('ok', false, 'error', 'unauthorized');", "  end if;", "", "  perform pg_advisory_xact_lock"), L("  if false then", "    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'unauthorized' where id = v_s.id;", "    return jsonb_build_object('ok', false, 'error', 'unauthorized');", "  end if;", "", "  perform pg_advisory_xact_lock")],
];
const EDGEM = [
  ["Edge: sem a 1ª checagem da allowlist (antes da Meta)", "if (pilotOk !== true) {", "if (false) {"],
  ["Edge: sem a 2ª checagem (antes do registro)", "if ((await deps.pilotAuthorized(companyId).catch(() => null)) !== true) {", "if (false) {"],
  ["Edge: sem a 3ª checagem (assina o webhook depois da revogação)", L("(await deps.pilotAuthorized(companyId).catch(() => null)) !== true) {", "    return abort(\"pilot_gate\", \"company_not_authorized\", 403, SESSION_ERRORS.company_not_authorized[1]);", "  }", "", "  // 7)"), L("false) {", "    return abort(\"pilot_gate\", \"company_not_authorized\", 403, SESSION_ERRORS.company_not_authorized[1]);", "  }", "", "  // 7)")],
  ["Edge: falha na leitura da allowlist abre o acesso", "const pilotOk = await deps.pilotAuthorized(companyId).catch(() => null);", "const pilotOk = await deps.pilotAuthorized(companyId).catch(() => true);"],
  ["Edge: erro company_not_authorized do reserve perde o code", 'reserved.data.error === "company_not_authorized" ? { error: message, code: "company_not_authorized" } : { error: message }', "{ error: message }"],
];

let killed = 0, total = 0;
const runSuite = (env) => {
  let out = "";
  try { out = execFileSync("node", ["whatsapp-signup-pilot.mjs"], { cwd: here, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  return { m, detected: !m || Number(m[2]) > 0 };
};
for (const [name, from, to] of SQLM) {
  if (!sql.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-pilot-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, NEW), sql.replace(from, () => to));
  const { m, detected } = runSuite({ MIG_DIR: dir });
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
const hsrc = fs.readFileSync(path.join(ROOT, H), "utf8");
for (const [name, from, to] of EDGEM) {
  if (!hsrc.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-pilot-edge-"));
  for (const f of [H, "supabase/functions/_shared/whatsapp-signup-graph.ts", "supabase/functions/_shared/whatsapp-graph.ts"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f === H ? hsrc.replace(from, () => to) : fs.readFileSync(path.join(ROOT, f), "utf8"));
  }
  const { m, detected } = runSuite({ SRC_ROOT: dir });
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${total} mutações detectadas`);
