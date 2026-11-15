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
const HM = "supabase/migrations/20261123010000_whatsapp_coexistence_connection_type.sql";
const M = [
  [H, "dono da sessão: não confere o usuário", 'if (String(reserved.data.user_id) !== auth.userId) {', "if (false) {"],
  [H, "não reserva a sessão (sem anti-replay no handler)", 'const reserved = await rpc(deps, "whatsapp_signup_reserve", { p_state: state });', 'const reserved = { error: null, data: { ok: true, session_id: "00000000-0000-0000-0000-000000000000", company_id: "00000000-0000-0000-0000-000000000000", user_id: auth.userId } };'],
  [H, "não confere o número na lista da Meta", "if (!found) return abort(", "if (false) return abort("],
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
  [G, "PIN gerado com Math.random", 'if (buf[0] < PIN_LIMIT) return String(buf[0] % 1_000_000).padStart(6, "0");', 'if (buf[0] < PIN_LIMIT) return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");'],
  [G, "PIN sem amostragem por rejeição (viés)", "if (buf[0] < PIN_LIMIT)", "if (true)"],
  [G, "PIN perde zeros à esquerda", 'return String(buf[0] % 1_000_000).padStart(6, "0");', "return String(buf[0] % 1_000_000);"],
  [G, "timeout/rede/5xx deixam de ser incertos", '  return "uncertain";\n}', '  return "failed";\n}'],
  [G, "133005 deixa de ser PIN incorreto", 'if (f.code === "133005") return "pin_incorrect";', ""],
  [H, "registra de novo mesmo com registro concluído", '} else if (action === "skip") {', "} else if (false) {"],
  [H, "PIN do cliente é ignorado", 'const hasCustomerPin = typeof customerPin === "string" && mode === "cloud_api";', "const hasCustomerPin = false;"],
  [H, "número com PIN existente tenta gerar outro", 'if (action === "need_customer_pin" && !hasCustomerPin) {', "if (false) {"],
  [H, "falha ao gravar o resultado do registro segue em frente", "    if (fin.error) {", "    if (false) {"],
  [H, "loga o corpo (code e PIN do cliente)", 'console.error("whatsapp-signup-complete: falha", { stage, errorCode, detail: detail ?? null });', 'console.error("whatsapp-signup-complete: falha", { stage, errorCode, detail: detail ?? null, body: JSON.stringify(body) });'],
  [H, "registro sem tentativa auditada (sem begin_attempt)", 'const ba = await rpc(deps, "whatsapp_registration_begin_attempt", { p_session_id: sessionId, p_registration_id: registrationId });', 'const ba = { error: null, data: { ok: true, attempt_id: "00000000-0000-0000-0000-000000000000", pin: "123456" } };'],
  // ---- Coexistence (Etapa 2) ----
  [H, "COEX: modo decidido pelo navegador (signup_event) em vez do Graph", "    mode = decided;", '    mode = signupEvent === COEXISTENCE_EVENT ? "coexistence" : "cloud_api";'],
  [H, "COEX: sem recusa quando o navegador diz Coexistence e o Graph não", 'if (signupEvent === COEXISTENCE_EVENT && mode !== "coexistence") {', "if (false) {"],
  [H, "COEX: Coexistence continua chamando /register e gerando PIN", 'if (mode === "coexistence") {\n    // número já registrado', 'if (false) {\n    // número já registrado'],
  [H, "COEX: conexão sempre gravada como cloud_api", "p_connection_type: mode, // decidido", 'p_connection_type: "cloud_api", // decidido'],
  [H, "COEX: modo indeterminado segue em frente (sem falha fechada)", "if (!decided) return abort(", 'if (!decided && false) return abort('],
  [H, "COEX: descoberta aceita mais de um número em Coexistence", "if (matches.length !== 1) {", "if (matches.length < 1) {"],
  [H, "COEX: falha ao consultar o modo é ignorada na consulta direta", "    if (!st.ok) return modeFail(st);\n    const decided", "    const decided"],
  [H, "COEX: sem phone_number_id é aceito fora do evento de Coexistência", "|| ((phoneHint === undefined || phoneHint === null) && signupEvent !== COEXISTENCE_EVENT)", ""],
  [H, "COEX: signup_event desconhecido é aceito", '|| (signupEvent !== undefined && signupEvent !== null && signupEvent !== "FINISH" && signupEvent !== COEXISTENCE_EVENT)', ""],
  [H, "COEX: registered_at da Coexistence não é nulo (afirma um registro que não houve)", "    registeredAt = null;\n  } else if", '    registeredAt = new Date().toISOString();\n  } else if'],
  [G, "COEX: decideConnectionMode aceita true + qualquer plataforma", 'return s.platformType === "CLOUD_API" ? "coexistence" : null;', 'return "coexistence";'],
  [G, "COEX: decideConnectionMode trata campo ausente como Cloud API", 'if (s.isOnBizApp === false) return "cloud_api";', 'if (s.isOnBizApp !== true) return "cloud_api";'],
  [G, "COEX: getPhoneStatus consulta outros campos", "${seg(phoneNumberId)}?fields=is_on_biz_app,platform_type`", "${seg(phoneNumberId)}?fields=id`"],
  [H, "ETAPA4: sem a rechecagem antes do /register", "if (guard.isOnBizApp !== false) {", "if (false) {"],
  [H, "ETAPA4: rechecagem indisponível não bloqueia", "if (!guard.ok) {", "if (false) {"],
  [H, "ETAPA4: rechecagem aceita campo ausente", "if (guard.isOnBizApp !== false) {", "if (guard.isOnBizApp === true) {"],
  [H, "ETAPA4: decisão aceita qualquer resposta (sem falha fechada)", "const decided = decideConnectionMode(st);", 'const decided = decideConnectionMode(st) ?? "cloud_api";'],
  [HM, "COEX-DB: coexistence aceita registered_at", "or (p_connection_type = 'coexistence' and p_registered_at is not null)", ""],
  [HM, "COEX-DB: cloud_api aceita registered_at nulo", "or (p_connection_type = 'cloud_api' and p_registered_at is null)", ""],
  [HM, "COEX-DB: reconexão não grava o tipo informado", "connection_type = p_connection_type,", "connection_type = 'cloud_api',"],
  [HM, "COEX-DB: nova conexão não grava o tipo informado", "'embedded_signup', p_connection_type, p_meta_business_id,", "'embedded_signup', 'cloud_api', p_meta_business_id,"],
  [HM, "COEX-DB: tipo desconhecido é aceito", "p_connection_type is null or p_connection_type not in ('cloud_api', 'coexistence')", "false"],
];
let killed = 0, run = 0;
for (const [file, name, from, to] of M) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!src.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-signup-edge-"));
  const isMig = file.startsWith("supabase/migrations/");
  for (const f of [H, G, "supabase/functions/_shared/whatsapp-graph.ts"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f === file ? src.replace(from, () => to) : fs.readFileSync(path.join(ROOT, f), "utf8"));
  }
  let migDir = null;
  if (isMig) {
    migDir = path.join(dir, "migrations");
    fs.mkdirSync(migDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations"))) fs.copyFileSync(path.join(ROOT, "supabase/migrations", f), path.join(migDir, f));
    fs.writeFileSync(path.join(migDir, path.basename(file)), src.replace(from, () => to));
  }
  let out = "";
  try { out = execFileSync("node", ["whatsapp-signup-complete.mjs"], { cwd: here, env: { ...process.env, SRC_ROOT: dir, ...(migDir ? { MIG_DIR: migDir } : {}) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  run++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${run} mutações detectadas`);
