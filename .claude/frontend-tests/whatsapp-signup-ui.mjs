// Frontend do Embedded Signup v4 (botão "Conectar meu WhatsApp"): lógica pura, orquestração com SDK/Meta simulados, carregador do SDK,
// render do painel (react-dom/server) e garantias estáticas (nada em storage/log, FB.login síncrono, sem IDs fixos).
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const root = "D:/orça facil";
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
// os módulos transpilados ficam DENTRO do projeto para resolverem "react" a partir de node_modules
const tmp = fs.mkdtempSync(path.join(root, ".claude/frontend-tests/.tmp-wasignup-"));
const emit = async (src, name, rewrites = []) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(root, src), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: src,
  }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
  return pathToFileURL(path.join(tmp, name)).href;
};
const W = "apps/web/src/features/whatsapp/";
await emit(W + "whatsappModulesLogic.ts", "whatsappModulesLogic.mjs");
await emit(W + "whatsappSignupLogic.ts", "whatsappSignupLogic.mjs", [['"./whatsappModulesLogic"', '"./whatsappModulesLogic.mjs"']]);
await emit(W + "facebookSdk.ts", "facebookSdk.mjs", [['"./whatsappSignupLogic"', '"./whatsappSignupLogic.mjs"']]);
await emit(W + "whatsappSignupFlow.ts", "whatsappSignupFlow.mjs", [['"./whatsappSignupLogic"', '"./whatsappSignupLogic.mjs"'], ['"./facebookSdk"', '"./facebookSdk.mjs"']]);
await emit("apps/web/src/features/employees/Modal.tsx", "Modal.mjs");
const panelUrl = await emit(W + "WhatsappSignupPanel.tsx", "WhatsappSignupPanel.mjs", [
  ['"../employees/Modal"', '"./Modal.mjs"'], ['"./whatsappSignupFlow"', '"./whatsappSignupFlow.mjs"'], ['"./whatsappSignupLogic"', '"./whatsappSignupLogic.mjs"'],
]);
const L = await import(pathToFileURL(path.join(tmp, "whatsappSignupLogic.mjs")).href);
const SDK = await import(pathToFileURL(path.join(tmp, "facebookSdk.mjs")).href);
const FL = await import(pathToFileURL(path.join(tmp, "whatsappSignupFlow.mjs")).href);
const Panel = await import(panelUrl);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

let pass = 0, fail = 0;
const ck = (l, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS" : "FAIL") + " - " + l + (c ? "" : " :: " + String(x).slice(0, 300))); };
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const codeOnly = (s) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const MODSTATE = { whatsapp: true, canManage: true, connectionActive: false, signup: { available: true, reason: null } };

console.log("\n== 1. botão: quem vê e quando fica disponível ==");
ck("1.1 owner/admin + módulo + sem conexão + plataforma liberada: visível e habilitado", (() => { const c = L.connectCard(MODSTATE); return c.visible && c.enabled && c.hint === null; })());
ck("1.2 sem permissão de gerenciar (atendente/caixa): invisível", L.connectCard({ ...MODSTATE, canManage: false }).visible === false);
ck("1.3 módulo WhatsApp não contratado: invisível", L.connectCard({ ...MODSTATE, whatsapp: false }).visible === false);
ck("1.4 empresa já conectada (conexão ativa): invisível", L.connectCard({ ...MODSTATE, connectionActive: true }).visible === false);
ck("1.5 flag desligada: visível porém INDISPONÍVEL, com a explicação amigável", (() => { const c = L.connectCard({ ...MODSTATE, signup: { available: false, reason: "pending_meta_approval" } }); return c.visible && !c.enabled && /aprovação da Meta/.test(c.hint); })());
ck("1.5b empresa FORA do piloto (flag ligada, não autorizada): visível porém desabilitada, com mensagem própria de empresa não liberada", (() => { const c = L.connectCard({ ...MODSTATE, signup: { available: false, reason: "company_not_authorized" } }); return c.visible && !c.enabled && /ainda não foi liberada para a sua empresa/.test(c.hint) && !/aprovação da Meta/.test(c.hint); })());
ck("1.5c empresa fora do piloto sem permissão/módulo/ou já conectada continua invisível (a allowlist não mostra nada a quem não deve ver)", [{ canManage: false }, { whatsapp: false }, { connectionActive: true }].every((p) => L.connectCard({ ...MODSTATE, ...p, signup: { available: false, reason: "company_not_authorized" } }).visible === false));
ck("1.5d autorizada + flag ligada continua habilitada", L.connectCard({ ...MODSTATE, signup: { available: true, reason: null } }).enabled === true);
ck("1.5e mapCompleteFailure('company_not_authorized'): mensagem de empresa não liberada, sem nova tentativa nem PIN", (() => { const f = L.mapCompleteFailure(403, "company_not_authorized"); return f.kind === "not_authorized" && f.canRetry === false && f.pinNeeded === false && /não foi liberada/.test(f.message); })());
ck("1.6 app Desktop (Tauri): indisponível com orientação para usar o navegador", (() => { const c = L.connectCard(MODSTATE, true); return c.visible && !c.enabled && /navegador/.test(c.hint); })());
ck("1.7 empresa com conexão antiga DESCONECTADA pode reconectar", L.connectCard({ ...MODSTATE, connectionActive: false }).visible === true);

console.log("\n== 2. mensagens do popup da Meta (origem e conteúdo) ==");
const msg = (event, data = {}, type = "WA_EMBEDDED_SIGNUP") => JSON.stringify({ type, event, data });
ck("2.1 origens da Meta aceitas: www/web/facebook.com em https", ["https://www.facebook.com", "https://web.facebook.com", "https://facebook.com"].every((o) => L.isMetaOrigin(o)));
ck("2.2 origens falsas recusadas: evilfacebook.com, facebook.com.evil.com, http, porta, nulo, lixo", ["https://evilfacebook.com", "https://facebook.com.evil.com", "http://www.facebook.com", "https://www.facebook.com:8443", "https://www.facebook.com.br", null, 5, "lixo"].every((o) => !L.isMetaOrigin(o)));
ck("2.3 FINISH válido (string JSON ou objeto) devolve os IDs", (() => { const a = L.parseSignupMessage("https://www.facebook.com", msg("FINISH", { waba_id: "123456789012", phone_number_id: "109876543210", business_id: "99999" })); const b = L.parseSignupMessage("https://www.facebook.com", { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "12345", phone_number_id: "67890" } }); return a.kind === "finish" && a.wabaId === "123456789012" && a.phoneNumberId === "109876543210" && b.kind === "finish"; })());
ck("2.4 mensagem de origem estranha é ignorada MESMO com conteúdo perfeito", L.parseSignupMessage("https://evil.example", msg("FINISH", { waba_id: "12345", phone_number_id: "67890" })) === null);
ck("2.5 outro type, JSON inválido, vazio e evento desconhecido: ignorados", [msg("FINISH", {}, "OUTRA_COISA"), "{ruim", "", 5, null, msg("ALGO")].every((d) => L.parseSignupMessage("https://www.facebook.com", d) === null));
ck("2.6 FINISH com IDs ausentes/ inválidos vira erro (nunca finish)", ["{}", { waba_id: "abc", phone_number_id: "12345" }, { waba_id: "12345" }, { waba_id: "12345", phone_number_id: "1; drop" }].every((d) => L.parseSignupMessage("https://www.facebook.com", msg("FINISH", typeof d === "string" ? JSON.parse(d) : d))?.kind === "error"));
ck("2.7 CANCEL, ERROR e CANCEL com error_message", L.parseSignupMessage("https://www.facebook.com", msg("CANCEL", { current_step: "PHONE_NUMBER_SETUP" })).kind === "cancel" && L.parseSignupMessage("https://www.facebook.com", msg("ERROR", { error_message: "x", error_code: 1 })).kind === "error" && L.parseSignupMessage("https://www.facebook.com", msg("CANCEL", { error_message: "x" })).kind === "error");
ck("2.8 FINISH_* de outros fluxos (Coexistence etc.) é 'unsupported'", L.parseSignupMessage("https://www.facebook.com", msg("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "12345", phone_number_id: "67890" })).kind === "unsupported");
ck("2.9 mensagens de erro/códigos da Meta não são repassados ao resultado", !JSON.stringify(L.parseSignupMessage("https://www.facebook.com", msg("ERROR", { error_message: "SEGREDO-DA-META", error_code: 9 }))).includes("SEGREDO"));

console.log("\n== 3. sessão, PIN e mapeamento de erros ==");
const ST = "a1".repeat(32);
ck("3.1 sessão válida do whatsapp_signup_begin", JSON.stringify(L.toSignupSession({ state: ST, meta_app_id: "1234567890", config_id: "9876543210", expires_at: "x" })) === JSON.stringify({ state: ST, appId: "1234567890", configId: "9876543210" }));
ck("3.2 sessão inválida (state curto/maiúsculo, ids vazios/ruins, lixo) é recusada", [null, 5, {}, { state: "abc", meta_app_id: "12345", config_id: "12345" }, { state: ST.toUpperCase(), meta_app_id: "12345", config_id: "12345" }, { state: ST, meta_app_id: null, config_id: "12345" }, { state: ST, meta_app_id: "12345", config_id: "abc" }].every((r) => L.toSignupSession(r) === null));
ck("3.3 PIN: só 6 dígitos; sanitização remove não-dígitos e corta em 6; zero à esquerda preservado", L.isValidPin("000123") && !L.isValidPin("12345") && !L.isValidPin("1234567") && !L.isValidPin("12345a") && !L.isValidPin(123456) && L.sanitizePinInput("00-01 2a3 999") === "000123");
const F = (s, c) => L.mapCompleteFailure(s, c);
ck("3.4 pin_required/pin_incorrect pedem o PIN e permitem nova ação do usuário", F(409, "pin_required").pinNeeded && F(409, "pin_required").canRetry && F(409, "pin_incorrect").pinNeeded && /incorreto/.test(F(409, "pin_incorrect").message));
ck("3.5 número de outra empresa e empresa já conectada: sem retentativa", F(409, "phone_in_use").kind === "phone_in_use" && !F(409, "phone_in_use").canRetry && /outra empresa/.test(F(409, "phone_in_use").message) && F(409, "company_has_active_connection").kind === "company_connected");
ck("3.6 registro bloqueado/limite/incerto/em andamento: sem retentativa e sem formulário de PIN", ["registration_blocked", "attempts_exhausted", "registration_uncertain", "registration_in_progress"].every((c) => !F(429, c).canRetry && !F(429, c).pinNeeded) && /suporte/.test(F(409, "registration_uncertain").message));
ck("3.7 sessão: 400 inválida, 410 expirada, 409 usada, 401, 403, 503 (flag)", F(400).kind === "state_invalid" && F(410).kind === "state_expired" && F(409).kind === "state_used" && F(401).kind === "session_invalid" && F(403).kind === "forbidden" && F(503).kind === "unavailable" && !F(503).canRetry);
ck("3.8 code expirado/ inválido (meta_code_exchange 400) vs Meta fora do ar (502/504)", F(400, "meta_code_exchange").kind === "meta_authorization" && F(502, "meta_code_exchange").kind === "meta_unreachable" && F(504, "meta_code_exchange").kind === "meta_unreachable" && F(400, "phone_not_in_waba").kind === "meta_account");
ck("3.9 falhas da Meta no registro/assinatura e erros internos viram mensagens genéricas sem detalhe", F(502, "meta_register_failed").kind === "meta_failed" && F(500, "token_store_failed").kind === "generic" && F(null, null).kind === "generic" && !/133|vault|token/i.test(F(500, "token_store_failed").message));
ck("3.10 falhas do begin (PT409 flag, PT401, PT403/404, PT429)", L.mapBeginFailure("PT409").kind === "unavailable" && L.mapBeginFailure("PT401").kind === "session_invalid" && L.mapBeginFailure("PT403").kind === "forbidden" && L.mapBeginFailure("PT404").kind === "forbidden" && L.mapBeginFailure("PT429").kind === "blocked" && L.mapBeginFailure("XX").kind === "generic");
ck("3.11 mensagem de cancelamento orienta sobre pop-up bloqueado", /pop-ups/.test(L.signupFailure("cancelled").message));

console.log("\n== 4. fluxo com SDK e Meta simulados ==");
function mkEnv(o = {}) {
  const e = { listeners: new Set(), timers: [], begins: 0, completes: [], loads: [], loginCalls: [], loginSync: false };
  const fb = {
    init() {},
    login(cb, opts) {
      e.loginCalls.push(opts);
      e.loginInsideLaunch = e.inLaunch === true;
      if (o.loginThrows) throw new Error("popup");
      (o.onLogin ?? (() => {}))(cb, e);
    },
  };
  e.deps = {
    async begin() { e.begins += 1; return o.beginFails ? { ok: false, failure: L.mapBeginFailure(o.beginFails) } : { ok: true, session: { state: (e.begins.toString(16).padStart(2, "0")).repeat(32), appId: "1234567890", configId: "9876543210" } }; },
    async loadSdk(appId) { e.loads.push(appId); if (o.sdkFails) throw new Error("sdk"); return fb; },
    listen(h) { e.listeners.add(h); return () => e.listeners.delete(h); },
    async complete(p) { e.completes.push(p); if (o.completeThrows) throw new Error("x"); return o.complete ? o.complete(p) : { ok: true, displayPhoneNumber: "+55 44 90000-0000", businessName: "Loja" }; },
    setTimer(fn, ms) { const t = { fn, ms, cancelled: false }; e.timers.push(t); return () => { t.cancelled = true; }; },
  };
  e.emit = (origin, data) => [...e.listeners].forEach((h) => h({ origin, data }));
  e.fireTimers = () => e.timers.filter((t) => !t.cancelled).forEach((t) => { t.cancelled = true; t.fn(); });
  return e;
}
const FIN = (w = "123456789012", p = "109876543210") => msg("FINISH", { waba_id: w, phone_number_id: p });
const META = "https://www.facebook.com";
const CODE = "AQD-CODIGO-DE-AUTORIZACAO-SECRETO";
const go = async (env, opts) => { const r = await FL.prepareSignup(env.deps); if (!r.ok) return { prep: r }; env.inLaunch = true; const h = FL.launchSignup(r.prepared, env.deps, opts); env.inLaunch = false; return { prep: r, h, out: await h.outcome }; };

{
  const env = mkEnv({ onLogin: (cb, e) => { e.emit(META, FIN()); cb({ authResponse: { code: CODE } }); } });
  const { out } = await go(env);
  ck("4.1 sucesso: FINISH + code → uma única conclusão, payload {state, code, waba_id, phone_number_id}", out.status === "success" && env.completes.length === 1 && env.completes[0].code === CODE && env.completes[0].waba_id === "123456789012" && env.completes[0].phone_number_id === "109876543210" && /^[0-9a-f]{64}$/.test(env.completes[0].state) && !("pin" in env.completes[0]) && !("company_id" in env.completes[0]));
  ck("4.2 resultado mostra número e nome; ouvinte removido ao final", out.displayPhoneNumber === "+55 44 90000-0000" && out.businessName === "Loja" && env.listeners.size === 0);
  ck("4.3 FB.login com os parâmetros oficiais do v4 e o Config ID DA SESSÃO", JSON.stringify(env.loginCalls[0]) === JSON.stringify({ config_id: "9876543210", response_type: "code", override_default_response_type: true, extras: { setup: {} } }));
  ck("4.4 FB.login é chamado SINCRONAMENTE dentro do launch (dentro do gesto do clique)", env.loginInsideLaunch === true);
  ck("4.5 o SDK é carregado com o App ID da sessão (não de constante)", env.loads[0] === "1234567890");
}
{
  const env = mkEnv({ onLogin: (cb, e) => { cb({ authResponse: { code: CODE } }); queueMicrotask(() => e.emit(META, FIN())); } });
  const { out } = await go(env);
  ck("4.6 ordem inversa (code antes do FINISH) também conclui, uma vez", out.status === "success" && env.completes.length === 1);
}
{
  const env = mkEnv({ onLogin: (cb, e) => { e.emit(META, FIN()); e.emit(META, FIN()); cb({ authResponse: { code: CODE } }); e.emit(META, FIN()); } });
  const { out } = await go(env);
  ck("4.7 FINISH repetido não gera segunda conclusão (code é de uso único)", out.status === "success" && env.completes.length === 1);
}
{
  const env = mkEnv({ onLogin: (cb, e) => { e.emit(META, FIN()); e.emit(META, FIN("999999999999", "888888888888")); cb({ authResponse: { code: CODE } }); } });
  const { out } = await go(env);
  ck("4.7b FINISH contraditório (IDs diferentes) encerra a tentativa e nada é enviado ao backend", out.status === "failed" && out.failure.kind === "meta_error" && env.completes.length === 0);
}
{
  const env = mkEnv({ onLogin: (cb, e) => { e.emit(META, FIN("999999999999", "888888888888")); e.emit(META, FIN()); cb({ authResponse: { code: CODE } }); } });
  const { out } = await go(env);
  ck("4.7c vale o primeiro FINISH recebido: o contraditório posterior também aborta (nunca troca IDs)", out.status === "failed" && env.completes.length === 0);
}
ck("2.9 estruturas oficiais: FINISH com business_id extra, ERROR com session_id/timestamp, CANCEL só com current_step", L.parseSignupMessage("https://www.facebook.com", msg("FINISH", { waba_id: "12345", phone_number_id: "67890", business_id: "555555" })).kind === "finish" && L.parseSignupMessage("https://web.facebook.com", msg("ERROR", { error_message: "m", error_code: "100", session_id: "s", timestamp: "1700000000000" })).kind === "error" && L.parseSignupMessage("https://www.facebook.com", msg("CANCEL", { current_step: "PHONE_NUMBER_SETUP" })).kind === "cancel");
ck("2.10 FB.login usa exatamente os parâmetros da página oficial de implementação (extras.setup vazio, sem version/featureType/sessionInfoVersion)", /extras: \{ setup: \{\} \}/.test(fs.readFileSync(path.join(root, "apps/web/src/features/whatsapp/whatsappSignupFlow.ts"), "utf8")) && !/sessionInfoVersion|featureType|extras: \{[^}]*version/.test(fs.readFileSync(path.join(root, "apps/web/src/features/whatsapp/whatsappSignupFlow.ts"), "utf8").replace(/\/\/.*$/gm, "")));
{
  const env = mkEnv({ onLogin: (cb, e) => { e.emit("https://evil.example", FIN()); cb({ authResponse: { code: CODE } }); } });
  const h = await FL.prepareSignup(env.deps); const handle = FL.launchSignup(h.prepared, env.deps);
  await Promise.resolve();
  ck("4.8 FINISH de origem falsa é ignorado: nada é enviado e passa a aguardar", env.completes.length === 0 && env.timers.length === 1 && env.timers[0].ms === L.SIGNUP_FINISH_WAIT_MS);
  env.fireTimers();
  const out = await handle.outcome;
  ck("4.9 sem FINISH legítimo no prazo: 'incomplete', nada enviado ao backend e code descartado", out.status === "failed" && out.failure.kind === "incomplete" && env.completes.length === 0 && env.listeners.size === 0);
}
{
  const env = mkEnv({ onLogin: (cb) => cb({ authResponse: null }) });
  const { out } = await go(env);
  ck("4.10 janela fechada / pop-up bloqueado (callback sem code): cancelado, nada enviado", out.status === "cancelled" && env.completes.length === 0 && env.listeners.size === 0);
  const env2 = mkEnv({ onLogin: (cb, e) => e.emit(META, msg("CANCEL", { current_step: "X" })) });
  ck("4.11 CANCEL da Meta: cancelado", (await go(env2)).out.status === "cancelled" && env2.completes.length === 0);
  const env3 = mkEnv({ onLogin: (cb, e) => e.emit(META, msg("ERROR", { error_message: "boom" })) });
  const o3 = (await go(env3)).out;
  ck("4.12 ERROR da Meta: falha 'meta_error' sem o texto da Meta", o3.status === "failed" && o3.failure.kind === "meta_error" && !JSON.stringify(o3).includes("boom"));
  const env4 = mkEnv({ onLogin: (cb, e) => e.emit(META, msg("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "12345", phone_number_id: "67890" })) });
  ck("4.13 fluxo de Coexistence não suportado", (await go(env4)).out.failure.kind === "unsupported");
  const env5 = mkEnv({ loginThrows: true });
  const o5 = (await go(env5)).out;
  ck("4.14 FB.login lançando exceção: falha tratada, sem travar", o5.status === "failed" && o5.failure.kind === "sdk_unavailable" && env5.listeners.size === 0);
}
{
  const env = mkEnv({ sdkFails: true });
  const r = await FL.prepareSignup(env.deps);
  ck("4.15 SDK indisponível (bloqueado/offline): falha amigável antes de qualquer popup", !r.ok && r.failure.kind === "sdk_unavailable" && /facebook\.com/.test(r.failure.message) && env.loginCalls.length === 0);
  const envB = mkEnv({ beginFails: "PT409" });
  const rb = await FL.prepareSignup(envB.deps);
  ck("4.16 flag desligada (PT409 no begin): nem carrega o SDK", !rb.ok && rb.failure.kind === "unavailable" && envB.loads.length === 0);
}
for (const [status, code, kind] of [[400, undefined, "state_invalid"], [410, undefined, "state_expired"], [409, "phone_in_use", "phone_in_use"], [401, undefined, "session_invalid"], [403, "user_mismatch", "forbidden"], [400, "meta_code_exchange", "meta_authorization"], [429, "registration_blocked", "blocked"], [409, "registration_uncertain", "uncertain"]]) {
  const env = mkEnv({ onLogin: (cb, e) => { e.emit(META, FIN()); cb({ authResponse: { code: CODE } }); }, complete: () => ({ ok: false, failure: L.mapCompleteFailure(status, code) }) });
  const { out } = await go(env);
  ck(`4.17 erro do servidor (${status}${code ? " " + code : ""}) → ${kind}`, out.status === "failed" && out.failure.kind === kind && !JSON.stringify(out).includes(CODE));
}
{
  const env = mkEnv({ onLogin: (cb, e) => { e.emit(META, FIN()); cb({ authResponse: { code: CODE } }); }, completeThrows: true });
  const { out } = await go(env);
  ck("4.18 exceção na conclusão: falha genérica, sem vazar o code", out.status === "failed" && out.failure.kind === "generic" && !JSON.stringify(out).includes(CODE));
}
{
  const env = mkEnv({ onLogin: () => {} }); // popup aberto, usuário ainda não terminou
  const r = await FL.prepareSignup(env.deps); const h = FL.launchSignup(r.prepared, env.deps);
  h.cancel();
  const out = await h.outcome;
  ck("4.19 fechar a tela cancela: remove ouvinte e timers, não chama o backend", out.status === "cancelled" && env.listeners.size === 0 && env.completes.length === 0);
}

console.log("\n== 5. PIN existente: recuperação por NOVA sessão e NOVO cadastro ==");
{
  let n = 0;
  const env = mkEnv({
    onLogin: (cb, e) => { e.emit(META, FIN()); cb({ authResponse: { code: CODE + ++n } }); },
    complete: (p) => (!p.pin ? { ok: false, failure: L.mapCompleteFailure(409, "pin_required") } : p.pin === "482913" ? { ok: true, displayPhoneNumber: "+55 1", businessName: null } : { ok: false, failure: L.mapCompleteFailure(409, "pin_incorrect") }),
  });
  const a = (await go(env)).out;
  ck("5.1 sem PIN: falha 'pin_required' pede o PIN (pinNeeded)", a.status === "failed" && a.failure.kind === "pin_required" && a.failure.pinNeeded);
  const firstState = env.completes[0].state, firstCode = env.completes[0].code;
  const b = (await go(env, { pin: "000111" })).out;
  ck("5.2 PIN errado: 'pin_incorrect', e o novo envio usou OUTRA sessão e OUTRO code (nada reaproveitado)", b.failure.kind === "pin_incorrect" && env.begins === 2 && env.completes[1].state !== firstState && env.completes[1].code !== firstCode && env.completes[1].pin === "000111");
  const c = (await go(env, { pin: "482913" })).out;
  ck("5.3 PIN certo: sucesso; sessões distintas em cada tentativa", c.status === "success" && env.begins === 3 && new Set(env.completes.map((x) => x.state)).size === 3 && env.completes[2].pin === "482913");
  ck("5.4 o PIN nunca aparece no resultado das tentativas", !JSON.stringify([a, b, c]).includes("482913") && !JSON.stringify([a, b, c]).includes("000111"));
  const env2 = mkEnv({ onLogin: (cb, e) => { e.emit(META, FIN()); cb({ authResponse: { code: CODE } }); } });
  await go(env2, { pin: "12" });
  await go(env2, { pin: "12345a" });
  ck("5.5 PIN fora do formato é descartado (não vai ao servidor)", env2.completes.every((p) => !("pin" in p)));
}

console.log("\n== 6. carregador do SDK ==");
function sdkEnv(o = {}) {
  const e = { appended: [], inits: [], timers: [], win: {}, doc: null };
  e.doc = {
    getElementById: (id) => e.appended.find((s) => s.id === id) ?? null,
    createElement: () => ({ id: "", src: "", async: false, defer: false, crossOrigin: null, onerror: null }),
    head: { appendChild: (n) => { e.appended.push(n); } },
  };
  e.setTimeout = (fn, ms) => { const t = { fn, ms, off: false }; e.timers.push(t); return t; };
  e.clearTimeout = (t) => { t.off = true; };
  e.timeoutMs = 15000;
  e.win.FB = o.preloaded ? { init: (x) => e.inits.push(x), login() {} } : undefined;
  return e;
}
{
  const e = sdkEnv();
  const p = SDK.loadFacebookSdk("1234567890", e);
  const s = e.appended[0];
  ck("6.1 injeta UM script oficial: connect.facebook.net/en_US/sdk.js, async, defer, crossorigin=anonymous", e.appended.length === 1 && s.src === "https://connect.facebook.net/en_US/sdk.js" && s.async && s.defer && s.crossOrigin === "anonymous" && s.id === "facebook-jssdk");
  e.win.FB = { init: (x) => e.inits.push(x), login() {} };
  e.win.fbAsyncInit();
  const fb = await p;
  ck("6.2 FB.init com o App ID, versão da documentação e rastreio/varredura desligados", JSON.stringify(e.inits[0]) === JSON.stringify({ appId: "1234567890", autoLogAppEvents: false, xfbml: false, version: "v26.0" }) && typeof fb.login === "function");
  const p2 = SDK.loadFacebookSdk("1234567890", e);
  await p2;
  ck("6.3 segunda chamada não duplica o script", e.appended.length === 1);
}
{
  const e = sdkEnv();
  const p = SDK.loadFacebookSdk("1234567890", e);
  e.appended[0].onerror();
  ck("6.4 script bloqueado (onerror): rejeita sdk_unavailable", await p.then(() => false, (er) => er.message === "sdk_unavailable"));
  const e2 = sdkEnv();
  const p2 = SDK.loadFacebookSdk("1234567890", e2);
  e2.timers[0].fn();
  ck("6.5 SDK que nunca carrega: tempo esgotado rejeita sdk_unavailable", await p2.then(() => false, (er) => er.message === "sdk_unavailable") && e2.timers[0].ms === 15000);
  const e3 = sdkEnv({ preloaded: true });
  await SDK.loadFacebookSdk("55555", e3);
  ck("6.6 SDK já presente: só reinicializa, sem novo script", e3.appended.length === 0 && e3.inits[0].appId === "55555");
}

console.log("\n== 7. painel renderizado (react-dom/server) ==");
{
  const Panel$ = Panel.WhatsappSignupPanel;
  const render = (card) => renderToStaticMarkup(React.createElement(Panel$, { companyId: "c1", card, makeDeps: () => { throw new Error("não deve criar deps no render"); }, onConnected: () => {} }));
  const on = render(L.connectCard(MODSTATE));
  ck("7.1 habilitado: botão 'Conectar meu WhatsApp' sem disabled e sem modal aberto", /Conectar meu WhatsApp/.test(on) && !/disabled/.test(on) && !/<dialog/.test(on));
  const off = render(L.connectCard({ ...MODSTATE, signup: { available: false, reason: "pending_meta_approval" } }));
  ck("7.2 flag desligada: botão desabilitado e mensagem amigável visível", /disabled/.test(off) && /aprovação da Meta/.test(off));
  const notAuth = render(L.connectCard({ ...MODSTATE, signup: { available: false, reason: "company_not_authorized" } }));
  ck("7.2b empresa fora do piloto: botão desabilitado + mensagem própria; renderizar não cria deps nem carrega o SDK", /disabled/.test(notAuth) && /ainda não foi liberada para a sua empresa/.test(notAuth) && !/aprovação da Meta/.test(notAuth));
  ck("7.3 invisível (sem permissão / módulo / já conectado): nada é renderizado", render(L.connectCard({ ...MODSTATE, canManage: false })) === "" && render(L.connectCard({ ...MODSTATE, whatsapp: false })) === "" && render(L.connectCard({ ...MODSTATE, connectionActive: true })) === "");
  ck("7.4 Desktop: desabilitado com orientação", /disabled/.test(render(L.connectCard(MODSTATE, true))) && /navegador/.test(render(L.connectCard(MODSTATE, true))));
}

console.log("\n== 8. garantias estáticas ==");
{
  const files = ["WhatsappSignupPanel.tsx", "whatsappSignupFlow.ts", "whatsappSignupApi.ts", "whatsappSignupLogic.ts", "facebookSdk.ts"].map((f) => [f, codeOnly(read(W + f))]);
  ck("8.1 nada em localStorage/sessionStorage/IndexedDB/cookie/URL do navegador", files.every(([, t]) => !/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.(hash|search)/.test(t)));
  const consoleLines = files.flatMap(([f, t]) => t.split("\n").filter((l) => /console\.(log|error|warn|info|debug)/.test(l)).map((l) => [f, l]));
  ck("8.2 nenhum console.* referencia code, pin, token, state, payload ou body", consoleLines.every(([, l]) => !/\b(code|pin|token|state|payload|body|data)\b/i.test(l.replace(/error\.code|e\.code|e\.status/g, ""))), JSON.stringify(consoleLines.filter(([, l]) => /\b(code|pin|token|state|payload|body|data)\b/i.test(l.replace(/error\.code|e\.code|e\.status/g, "")))));
  const flow = files.find(([f]) => f === "whatsappSignupFlow.ts")[1];
  const panel = files.find(([f]) => f === "WhatsappSignupPanel.tsx")[1];
  ck("8.3 FB.login só existe no fluxo (launchSignup) e é chamado antes de qualquer await", (flow.match(/\.login\(/g) ?? []).length === 1 && !/\.login\(/.test(panel) && !/await/.test(flow.slice(flow.indexOf("export function launchSignup"), flow.indexOf("prepared.fb.login"))));
  const cont = panel.slice(panel.indexOf("function continueWithMeta"), panel.indexOf("function submitPin"));
  ck("8.4 o clique 'Continuar com a Meta' não tem await e apaga a sessão e o PIN guardados", cont.length > 100 && !/await/.test(cont) && /preparedRef\.current = null/.test(cont) && /pinRef\.current = ""/.test(cont));
  ck("8.5 sem retentativa automática: nenhum setInterval/loop e prepare() só nos cliques", !/setInterval/.test(panel + flow) && (panel.match(/void prepare\(\)/g) ?? []).length === 3);
  ck("8.6 Config ID e App ID nunca fixos no código (vêm da sessão do banco)", files.every(([, t]) => !/[0-9]{12,}/.test(t)));
  ck("8.7 campo de PIN: password, numérico, autocomplete off, 6 dígitos", /type="password"/.test(panel) && /inputMode="numeric"/.test(panel) && /autoComplete="off"/.test(panel) && /maxLength=\{6\}/.test(panel));
  ck("8.8 limite de envios de PIN por tela (MAX_PIN_SUBMISSIONS) e fechar limpa tudo", /MAX_PIN_SUBMISSIONS/.test(panel) && /function reset\(\)[\s\S]*pinRef\.current = ""[\s\S]*setPinInput\(""\)/.test(panel));
  const conn = read(W + "WhatsappConnection.tsx");
  ck("8.9 tela de conexão usa o painel novo e não tem mais o botão antigo desabilitado", /WhatsappSignupPanel/.test(conn) && !/Conectar WhatsApp</.test(conn) && /connectCard\(state, isTauri\(\)\)/.test(conn));
  const api = files.find(([f]) => f === "whatsappSignupApi.ts")[1];
  ck("8.10 API real: RPC whatsapp_signup_begin e Edge whatsapp-signup-complete; company_id NÃO vai no corpo da Edge", /rpc\("whatsapp_signup_begin"/.test(api) && /invoke\("whatsapp-signup-complete"/.test(api) && !/company_id/.test(api.slice(api.indexOf("async function complete"))));
  ck("8.11 CompletePayload só tem state, code, waba_id, phone_number_id e pin opcional", /state: string;\s*code: string;\s*waba_id: string;\s*phone_number_id: string;\s*pin\?: string;/.test(read(W + "whatsappSignupFlow.ts")));
  const sdk = files.find(([f]) => f === "facebookSdk.ts")[1];
  ck("8.12 SDK só do domínio oficial e nenhum segundo script/domínio no código", (["WhatsappSignupPanel.tsx", "whatsappSignupFlow.ts", "whatsappSignupApi.ts", "whatsappSignupLogic.ts", "facebookSdk.ts"].map((f) => read(W + f)).join("\n").match(/https?:\/\/[a-z0-9.-]+/gi) ?? []).every((u) => /^https?:\/\/(connect\.facebook\.net|www\.facebook\.com|web\.facebook\.com|facebook\.com)$/i.test(u)));
  ck("8.13 vercel.json não foi alterado: continua sem CSP global (nada enfraquecido)", !/Content-Security-Policy/i.test(read("vercel.json")) && !/Content-Security-Policy/i.test(read("apps/web/index.html")));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nRESULTADO whatsapp-signup-ui: ${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
