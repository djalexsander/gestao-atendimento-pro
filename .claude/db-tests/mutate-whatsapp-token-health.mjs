// Mutação da Etapa 8 (saúde do token + recuperação de registros): cada trava removida deve derrubar whatsapp-token-health.mjs.
//   node mutate-whatsapp-token-health.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "D:/orça facil";
const SRC = path.join(ROOT, "supabase/migrations");
const NEW = "20261108010000_whatsapp_token_health_and_registration_recovery.sql";
const sql = fs.readFileSync(path.join(SRC, NEW), "utf8");
const here = path.dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);
const L = (...a) => a.join(NL);
const DSP = "supabase/functions/_shared/whatsapp-dispatch.ts";
const GR = "supabase/functions/_shared/whatsapp-graph.ts";
const FILES = [DSP, GR, "supabase/functions/whatsapp-order-notify/handler.ts", "supabase/functions/_shared/push-core.ts"];

const SQLM = [
  ["sem prazo e nunca confirmado passa a valer 'valid'", L("  return 'unknown';", "end;"), L("  return 'valid';", "end;")],
  ["janela de aviso de 10 dias encurtada", "v_exp <= now() + interval '10 days'", "v_exp <= now() + interval '3 days'"],
  ["revoked armazenado não prevalece", L("  if v_st = 'revoked' then", "    return 'revoked';"), L("  if false then", "    return 'revoked';")],
  ["contexto de envio não bloqueia expired/revoked", L("  if v_eff in ('expired', 'revoked') then", "    if v_conn.token_expires_at is not null"), L("  if false then", "    if v_conn.token_expires_at is not null")],
  ["prazo vencido deixa de ser bloqueio firme (vira sondagem)", L("    if v_conn.token_expires_at is not null and v_conn.token_expires_at <= now() then", "      return jsonb_build_object('ok', false, 'error', 'token_expired');"), L("    if false then", "      return jsonb_build_object('ok', false, 'error', 'token_expired');")],
  ["sondagem sem janela de 30 min (sempre libera)", "(token_checked_at is null or token_checked_at <= now() - interval '30 minutes')", "true"],
  ["estado 'error' passa a bloquear", "  if v_eff in ('expired', 'revoked') then", "  if v_eff in ('expired', 'revoked', 'error') then"],
  ["estado 'unknown' passa a bloquear (quebra a Djalexeventos)", "  if v_eff in ('expired', 'revoked') then", "  if v_eff in ('expired', 'revoked', 'unknown') then"],
  ["falha não confirmada rebaixa estado confirmado", "if v_conn.token_status not in ('revoked', 'expired') then", "if true then"],
  ["envio ok passa a mexer em 'unknown'", "and token_status in ('error', 'revoked', 'expired')", "and token_status in ('unknown', 'error', 'revoked', 'expired')"],
  ["envio ok restaura mesmo com prazo vencido", "and (token_expires_at is null or token_expires_at > now())", ""],
  ["varredura toca conexões sem prazo conhecido", "where status = 'active' and token_expires_at is not null and token_status not in ('revoked')", "where status = 'active' and token_status not in ('revoked')"],
  ["aviso aparece para qualquer papel", "case when v_role in ('owner', 'admin') and v_wa then", "case when true then"],
  ["aviso repetido não conta a ocorrência (dedupe quebrado)", "occurrences = public.whatsapp_token_alerts.occurrences + 1;", "occurrences = public.whatsapp_token_alerts.occurrences;"],
  ["resolução de registro sem Admin Master", L("  perform public.assert_master_admin();", "  v_actor := auth.uid();", "  if p_outcome is null or p_outcome not in ('registered', 'failed') then"), L("  v_actor := auth.uid();", "  if p_outcome is null or p_outcome not in ('registered', 'failed') then")],
  ["resolução sem exigir motivo/evidência", "if char_length(v_reason) not between 10 and 500 or char_length(v_evidence) not between 10 and 1000 then", "if false then"],
  ["resolve tentativa em curso sem esperar 30 min", "if v_last is null or v_last > now() - interval '30 minutes' then", "if false then"],
  ["auditoria sem quem resolveu", "v_reason, v_evidence, v_actor);", "v_reason, v_evidence, null);"],
  ["sem limpeza segura após a resolução", "v_sweep := public.whatsapp_signup_sweep(v_r.company_id);", "v_sweep := jsonb_build_object('secrets_removed', 0);"],
  ["listagem expõe a referência do PIN", "'pin_stored', r.pin_secret_id is not null,", "'pin_stored', r.pin_secret_id,"],
  ["saúde por empresa sem Admin Master", L("begin", "  perform public.assert_master_admin();", "  return coalesce((", "    select jsonb_agg(jsonb_build_object(", "             'company_id', c.company_id"), L("begin", "  return coalesce((", "    select jsonb_agg(jsonb_build_object(", "             'company_id', c.company_id")],
  ["relatório de falha liberado a usuários", "grant execute on function public.whatsapp_connection_report_send_ok(uuid) to service_role;", "grant execute on function public.whatsapp_connection_report_send_ok(uuid) to service_role, authenticated;"],
  ["tabela de alertas acessível ao cliente", "revoke all on public.whatsapp_token_alerts from public, anon, authenticated;", "revoke all on public.whatsapp_token_alerts from public, anon;"],
  ["resolução de registro aceita 'in_progress' recente por outro caminho (estado anterior ignorado)", "if v_r.state not in ('uncertain', 'in_progress') then", "if v_r.state not in ('uncertain', 'in_progress', 'registered', 'failed') then"],
];
const EDGEM = [
  [DSP, "classifica TODO erro http como token inválido", 'if (r.kind !== "http" || r.code !== "190") return null;', 'if (r.kind !== "http") return null;'],
  [DSP, "HTTP 401 sem código 190 vira prova de revogação", 'if (r.kind !== "http" || r.code !== "190") return null;', 'if (r.kind !== "http" || (r.code !== "190" && r.status !== 401)) return null;'],
  [DSP, "checkpoint (459/464) vira token inválido", 'if (r.subcode === "459" || r.subcode === "464") return "error";', ""],
  [DSP, "falha de autenticação não é registrada", L("  await reportAuthFailure(result);", "  await markMessageFailed(admin, messageId, errorCode);"), L("  await markMessageFailed(admin, messageId, errorCode);")],
  [DSP, "envio bem-sucedido não restaura a saúde", "if (unhealthyBefore && connectionId) {", "if (false) {"],
  [DSP, "bloqueio do contexto sem resposta própria", 'if (reason === "token_expired" || reason === "token_revoked") {', "if (false) {"],
  [DSP, "falha no upload do documento não confirma token inválido", "const upAuth = await reportAuthFailure(up);", "const upAuth = null;"],
  [GR, "adaptador da Graph ignora error_subcode", "...(sub && /^[0-9]{1,6}$/.test(sub) ? { subcode: sub } : {})", ""],
];

let killed = 0, total = 0;
const runSuite = (env) => {
  let out = "";
  try { out = execFileSync("node", ["whatsapp-token-health.mjs"], { cwd: here, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  return { m, detected: !m || Number(m[2]) > 0 };
};
for (const [name, from, to] of SQLM) {
  if (!sql.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-tok-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, NEW), sql.replace(from, () => to));
  const { m, detected } = runSuite({ MIG_DIR: dir });
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
for (const [file, name, from, to] of EDGEM) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!src.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-tok-edge-"));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f === file ? src.replace(from, () => to) : fs.readFileSync(path.join(ROOT, f), "utf8"));
  }
  const { m, detected } = runSuite({ FN_ROOT: dir });
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${total} mutações detectadas`);
