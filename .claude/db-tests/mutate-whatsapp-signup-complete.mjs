// Mutação do handler/cliente do Embedded Signup: cada trava removida deve derrubar whatsapp-signup-complete.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "D:/orça facil";
const here = path.dirname(fileURLToPath(import.meta.url));
const H = "supabase/functions/whatsapp-signup-complete/handler.ts";
const G = "supabase/functions/_shared/whatsapp-signup-graph.ts";
const M = [
  [H, "dono da sessão: não confere o usuário", 'if (String(reserved.data.user_id) !== auth.userId) {', "if (false) {"],
  [H, "não reserva a sessão (sem anti-replay no handler)", 'const reserved = await rpc(deps, "whatsapp_signup_reserve", { p_state: state });', 'const reserved = { error: null, data: { ok: true, session_id: "00000000-0000-0000-0000-000000000000", company_id: "00000000-0000-0000-0000-000000000000", user_id: auth.userId } };'],
  [H, "não confere o número na lista da Meta", "if (!phone) return abort(", "if (false) return abort("],
  [H, "sem checagem local de número de outra empresa", "if (owner && owner.companyId !== companyId) {", "if (false) {"],
  [H, "sem checagem local de conexão ativa", "if (active && active.phoneNumberId !== phoneNumberId) {", "if (false) {"],
  [H, "abort não encerra a sessão (sem limpeza)", 'const f = await rpc(deps, "whatsapp_signup_fail", { p_session_id: sessionId, p_error_code: errorCode });', "const f = { error: null };"],
  [H, "não confere a assinatura do webhook", "!apps.appIds.includes(appId)", "false"],
  [H, "registra o número antes de guardar o token", 'return abort("token_store", "token_store_failed", 500, GENERIC, { rpc_code: stored.error?.code ?? null });', "console.error('ignorado');"],
  [H, "conclusão sem retry", "if (done.error) done = await rpc(deps, \"whatsapp_signup_complete\", args);", ""],
  [H, "encerra a sessão quando o resultado é incerto", 'console.error("whatsapp-signup-complete: conclusão sem resposta", { code: done.error?.code ?? null });', 'await rpc(deps, "whatsapp_signup_fail", { p_session_id: sessionId, p_error_code: "x" });'],
  [H, "modo da resposta fixo e vaza o erro interno", 'return abort("token_store", "token_store_failed", 500, GENERIC, { rpc_code: stored.error?.code ?? null });', 'return json({ error: String(stored.error?.message) }, 500);'],
  [H, "loga o code", 'console.error("whatsapp-signup-complete: falha", { stage, errorCode, detail: detail ?? null });', 'console.error("whatsapp-signup-complete: falha", { stage, errorCode, code, detail: detail ?? null });'],
  [H, "plataforma desligada não bloqueia", "if (!platform || !platform.enabled || !platform.appId) {", "if (!platform || !platform.appId) {"],
  [H, "company_id aceito do corpo", "const companyId = String(reserved.data.company_id);", "const companyId = String((body as Record<string, unknown>).company_id ?? reserved.data.company_id);"],
  [G, "segue paginação para qualquer host", "next && next.startsWith(`${GRAPH_BASE_URL}/`) ? next : null", "next"],
  [G, "token na query da lista", "`${GRAPH_BASE_URL}/${version}/${seg(wabaId)}/phone_numbers`;", "`${GRAPH_BASE_URL}/${version}/${seg(wabaId)}/phone_numbers?access_token=${token}`;"],
  [G, "PIN aleatório (não derivado)", "return String(n % 1_000_000).padStart(6, \"0\");", "return String(Math.floor(Math.random() * 1_000_000)).padStart(6, \"0\");"],
];
let killed = 0, run = 0;
for (const [file, name, from, to] of M) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!src.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-signup-edge-"));
  for (const f of [H, G, "supabase/functions/_shared/whatsapp-graph.ts"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f === file ? src.replace(from, () => to) : fs.readFileSync(path.join(ROOT, f), "utf8"));
  }
  let out = "";
  try { out = execFileSync("node", ["whatsapp-signup-complete.mjs"], { cwd: here, env: { ...process.env, SRC_ROOT: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  run++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${run} mutações detectadas`);
