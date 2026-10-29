// Área "WhatsApp" do Painel Master (Etapa 10): lógica pura, camada de API com RPC simulada (sucesso, recusa, falha de rede, resposta inválida),
// render (react-dom/server) dos diálogos e das seções, e garantias estáticas (sem tabela direta, sem flag global, sem cron manual, sem credenciais).
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const root = "D:/orça facil";
const srcRoot = process.env.FE_ROOT ?? root; // a mutação aponta para uma cópia alterada do código-fonte
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const tmp = fs.mkdtempSync(path.join(root, ".claude/frontend-tests/.tmp-mwa-"));
const emit = async (src, name, rewrites = []) => {
  let code = ts.transpileModule(fs.readFileSync(path.join(srcRoot, src), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: src,
  }).outputText;
  for (const [a, b] of rewrites) code = code.split(a).join(b);
  fs.writeFileSync(path.join(tmp, name), code);
  return pathToFileURL(path.join(tmp, name)).href;
};
fs.writeFileSync(path.join(tmp, "supabaseClient.mjs"), "export const supabase = { rpc: async () => ({ data: null, error: { message: 'stub' } }) };\n");
const W = "apps/web/src/features/master/whatsapp/";
await emit(W + "whatsappMasterLogic.ts", "logic.mjs");
await emit(W + "whatsappMasterApi.ts", "api.mjs", [['"../../../lib/supabaseClient"', '"./supabaseClient.mjs"'], ['"./whatsappMasterLogic"', '"./logic.mjs"']]);
await emit("apps/web/src/lib/dates.ts", "dates.mjs");
await emit("apps/web/src/lib/subscriptionLabels.ts", "subscriptionLabels.mjs");
await emit("apps/web/src/features/master/MasterBits.tsx", "MasterBits.mjs", [['"../../lib/dates"', '"./dates.mjs"'], ['"../../lib/subscriptionLabels"', '"./subscriptionLabels.mjs"']]);
await emit("apps/web/src/features/employees/Modal.tsx", "Modal.mjs");
fs.writeFileSync(path.join(tmp, "masterApi.mjs"), "export async function fetchMasterCompanies() { return { data: [{ id: 'c1', name: 'Empresa Um' }, { id: 'c2', name: 'Empresa Dois' }], error: null }; }\n");
const sub = [['"../../../lib/dates"', '"./dates.mjs"'], ['"../MasterBits"', '"./MasterBits.mjs"'], ['"./whatsappMasterApi"', '"./api.mjs"'], ['"./whatsappMasterLogic"', '"./logic.mjs"'], ['"../../employees/Modal"', '"./Modal.mjs"'], ['"../api"', '"./masterApi.mjs"'], ['"react-router-dom"', '"./router.mjs"']];
fs.writeFileSync(path.join(tmp, "router.mjs"), "import React from 'react'; export const Link = ({ to, children }) => React.createElement('a', { href: to }, children);\n");
const urls = {};
for (const n of ["MonitoringSection", "TokenHealthSection", "PilotSection", "RegistrationsSection"]) urls[n] = await emit(W + n + ".tsx", n + ".mjs", sub);
const L = await import(pathToFileURL(path.join(tmp, "logic.mjs")).href);
const API = await import(pathToFileURL(path.join(tmp, "api.mjs")).href);
const Mon = await import(urls.MonitoringSection), Tok = await import(urls.TokenHealthSection), Pil = await import(urls.PilotSection), Reg = await import(urls.RegistrationsSection);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const render = (el) => renderToStaticMarkup(el);

let pass = 0, fail = 0;
const ck = (l, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS" : "FAIL") + " - " + l + (c ? "" : " :: " + String(x).slice(0, 300))); };
const read = (f) => fs.readFileSync(path.join(srcRoot, f), "utf8");
const codeOnly = (s) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const STATUS_OK = { health: "ok", last_run: { source: "cron", status: "success", started_at: "2026-10-30T00:07:00Z", finished_at: "2026-10-30T00:07:01Z", checked: 2, locked_skipped: 0, updated: 1, alerts_created: 1, alerts_refreshed: 0, error_code: null }, last_failure: null, last_success_at: "2026-10-30T00:07:00Z", never_run: false, overdue: false, job: { schedule: "7 */6 * * *", active: true }, last_cron_run: { status: "succeeded", start_time: "2026-10-30T00:07:00Z", end_time: "2026-10-30T00:07:01Z" }, scheduler_ok_but_sweep_failed: false, failures_24h: 0, recent_failures: [] };
const NOW = new Date("2026-10-29T16:20:00Z");

console.log("\n== 1. monitoramento: estados e aviso de disparo automático ==");
{
  const s = L.parseSweepStatus(STATUS_OK);
  const v = L.describeMonitoring(s, NOW);
  ck("1.1 saúde 'ok' com cron confirmado: tom ok, sem avisos, próximo disparo calculado", v.tone === "ok" && v.headline === "Em dia" && v.cronConfirmed && v.notices.length === 0 && v.nextRunAt.toISOString() === "2026-10-29T18:07:00.000Z");
  const manual = L.parseSweepStatus({ ...STATUS_OK, health: "ok", last_run: { ...STATUS_OK.last_run, source: "manual" }, last_cron_run: null });
  const vm = L.describeMonitoring(manual, NOW);
  ck("1.2 só execução MANUAL: NÃO considera o disparo automático confirmado e avisa que a manual não prova o agendador", !vm.cronConfirmed && vm.notices.some((n) => /manual/.test(n) && /n[ãa]o prova/.test(n)));
  const never = L.describeMonitoring(L.parseSweepStatus({ ...STATUS_OK, health: "never_run", last_run: null, last_success_at: null, never_run: true, last_cron_run: null }), NOW);
  ck("1.3 nunca executada: tom neutro, rótulo próprio e aviso de agendador sem execução", never.tone === "muted" && never.headline === "Nunca executada" && never.notices.some((n) => /agendador ainda n[ãa]o registrou/.test(n)));
  const failing = L.parseSweepStatus({ ...STATUS_OK, health: "failing", last_run: { ...STATUS_OK.last_run, status: "failed", error_code: "P0001" }, last_failure: { source: "cron", started_at: "2026-10-30T00:07:00Z", error_code: "P0001", error_message: "falha [removido] simulada" }, scheduler_ok_but_sweep_failed: true, failures_24h: 2, recent_failures: [{ source: "cron", started_at: "x", error_code: "P0001", error_message: "m" }] });
  const vf = L.describeMonitoring(failing, NOW);
  ck("1.4 falha interna: tom 'bad', NUNCA 'Em dia'; aviso da divergência agendador x varredura e a mensagem sanitizada", vf.tone === "bad" && vf.headline === "Com falha" && vf.notices.some((n) => /pg_cron\) terminou com sucesso, mas a varredura registrou falha/.test(n)) && vf.notices.some((n) => /P0001 — falha \[removido\]/.test(n)) && failing.failures24h === 2 && failing.recentFailures.length === 1);
  const od = L.describeMonitoring(L.parseSweepStatus({ ...STATUS_OK, health: "overdue", overdue: true }), NOW);
  ck("1.5 atrasada: tom de atenção", od.tone === "warn" && od.headline === "Atrasada");
  const off = L.describeMonitoring(L.parseSweepStatus({ ...STATUS_OK, job: { schedule: "7 */6 * * *", active: false } }), NOW);
  const nojob = L.describeMonitoring(L.parseSweepStatus({ ...STATUS_OK, job: null }), NOW);
  ck("1.6 agendador desativado ou ausente: avisa e NÃO mostra próximo disparo", off.nextRunAt === null && off.notices.some((n) => /desativado/.test(n)) && nojob.nextRunAt === null && nojob.notices.some((n) => /n[ãa]o foi encontrado/.test(n)));
  ck("1.7 resposta inválida/desconhecida vira null (a tela mostra erro), sem quebrar", L.parseSweepStatus(null) === null && L.parseSweepStatus({ health: "inventado" }) === null && L.parseSweepStatus([]) === null);
  const g = [["2026-10-29T00:00:00Z", "2026-10-29T00:07:00.000Z"], ["2026-10-29T00:07:00Z", "2026-10-29T06:07:00.000Z"], ["2026-10-29T05:59:59Z", "2026-10-29T06:07:00.000Z"], ["2026-10-29T18:07:01Z", "2026-10-30T00:07:00.000Z"], ["2026-12-31T23:30:00Z", "2027-01-01T00:07:00.000Z"]];
  ck("1.8 próximo disparo na grade 00:07/06:07/12:07/18:07 UTC, sempre estritamente futuro (inclusive virada de ano)", g.every(([a, b]) => L.nextCronRun(new Date(a)).toISOString() === b));
}

console.log("\n== 2. histórico: paginação ==");
{
  const h = L.parseHistory({ total: 25, limit: 10, offset: 10, rows: [{ id: "1", source: "cron", status: "success", started_at: "x", checked: 3 }, { status: "lixo" }, null] });
  ck("2.1 histórico: linhas inválidas descartadas, números normalizados", h.total === 25 && h.rows.length === 1 && h.rows[0].checked === 3 && h.rows[0].source === "cron");
  ck("2.2 contas de página", L.pageCount(25, 10) === 3 && L.pageCount(0, 10) === 1 && L.pageCount(10, 10) === 1 && L.pageCount(11, 10) === 2 && L.offsetForPage(3, 10) === 20 && L.offsetForPage(0, 10) === 0 && L.pageOfOffset(20, 10) === 3 && L.pageOfOffset(0, 10) === 1);
  ck("2.3 resposta sem 'rows' é inválida", L.parseHistory({ total: 1 }) === null && L.parseHistory(null) === null);
  const html = render(React.createElement(Mon.HistoryTable));
  ck("2.4 tabela de histórico no estado inicial: filtros de resultado e origem e nenhum dado fabricado", /Resultado/.test(html) && /Origem/.test(html) && /Carregando histórico/.test(html) && !/Sucesso<\/span>/.test(html));
}

console.log("\n== 3. saúde dos tokens ==");
{
  const rows = L.parseTokenHealth([
    { company_id: "c1", company_name: "Zeta", connection_id: "k1", mode: "live", status: "valid", token_expires_at: null },
    { company_id: "c2", company_name: "Alfa", connection_id: "k2", mode: "test", status: "revoked", last_error_code: "190" },
    { company_id: "c3", company_name: "Beta", connection_id: "k3", mode: "test", status: "expiring", token_expires_at: "2026-11-01T00:00:00Z" },
    { company_id: "c4", company_name: "Gama", connection_id: "k4", mode: "x", status: "unknown" },
    { company_id: "c5", connection_id: "k5", status: "inventado" }, null, { token: "EAAG-SEGREDO", company_id: "c6", connection_id: "k6", status: "valid", pin_secret_id: "p", token_secret_id: "s" },
  ]);
  ck("3.1 ordem: o que exige ação primeiro (revogado, expirando…) e estado desconhecido da API descartado", rows.map((r) => r.state).join(",") === "revoked,expiring,unknown,valid,valid" && rows[0].companyName === "Alfa");
  ck("3.2 modo desconhecido vira 'test'; 'unknown' é neutro e não pede reconexão", rows.find((r) => r.companyId === "c4").mode === "test" && L.TOKEN_STATE_TONE.unknown === "muted" && !L.needsReconnect("unknown") && !L.needsReconnect("valid") && !L.needsReconnect("error"));
  ck("3.3 pede reconexão em expirando, expirado e revogado", ["expiring", "expired", "revoked"].every((s) => L.needsReconnect(s)));
  ck("3.4 campos sensíveis do payload NUNCA entram no modelo", !JSON.stringify(rows).includes("EAAG-SEGREDO") && !/secret|pin/i.test(Object.keys(rows[0]).join(",")) && rows.every((r) => !("token" in r) && !("tokenSecretId" in r)));
  ck("3.5 identificador da Meta mascarado (só o final), vazio e curto tratados", L.maskId("109876543210987") === "•••• 0987" && L.maskId("") === "—" && L.maskId(null) === "—" && L.maskId("123") === "••••" && !L.maskId("109876543210987").includes("1098765"));
  const empty = render(React.createElement(Tok.TokenHealthSection));
  ck("3.6 seção renderiza o cabeçalho e o aviso de que token/cofre não são exibidos", /Saúde dos tokens por empresa/.test(empty) && /nunca são exibidos/.test(empty));
}

console.log("\n== 4. piloto ==");
{
  ck("4.1 nota obrigatória: vazia/curta recusada; mínima aceita; acima do limite recusada", L.validatePilotNote("") !== null && L.validatePilotNote("   ab ") !== null && L.validatePilotNote("12345") === null && L.validatePilotNote("x".repeat(501)) !== null && L.validatePilotNote("x".repeat(500)) === null);
  const list = L.parsePilotList([{ company_id: "c1", company_name: "Alfa", authorized: true, authorized_by: "11111111-2222", authorized_at: "x", note: "n", connection_active: true }, { company_name: "sem id" }, null, { company_id: "c2", authorized: false }]);
  ck("4.2 lista normalizada; entradas sem empresa descartadas; lista vazia aceita", list.length === 2 && list[0].authorized && !list[1].authorized && L.parsePilotList([]).length === 0 && L.parsePilotList(null).length === 0);
  const ev = L.parsePilotEvents([{ action: "authorized", actor_user_id: "u", note: "a", at: "x" }, { action: "revoked", note: "b" }, { action: "hack" }, 5]);
  ck("4.3 eventos: só 'authorized'/'revoked'", ev.length === 2 && ev[1].action === "revoked");
  ck("4.4 trava global: só o booleano é lido; ids da Meta descartados", L.parseSignupAvailable({ available: true, meta_app_id: "123", config_id: "456" }) === true && L.parseSignupAvailable({ available: false, reason: "x" }) === false && L.parseSignupAvailable({}) === null && L.parseSignupAvailable(null) === null);
  const dlg = (authorize) => render(React.createElement(Pil.PilotConfirm, { pending: { company: { id: "c1", name: "Empresa Um" }, authorize }, onClose() {}, onDone: async () => {} }));
  const a = dlg(true), r = dlg(false);
  ck("4.5 confirmação para AUTORIZAR: nome da empresa, motivo obrigatório, checkbox e botão desabilitado até preencher", /Empresa Um/.test(a) && /Motivo \(obrigatório/.test(a) && /type="checkbox"/.test(a) && /<button[^>]*disabled[^>]*>Autorizar<\/button>/.test(a));
  ck("4.6 confirmação para REVOGAR: avisa o efeito (encerra tentativas em andamento, conexão existente não muda) e botão desabilitado", /Revogar/.test(r) && /encerradas/.test(r) && /conexão já existente não é alterada/.test(r) && /<button[^>]*disabled[^>]*>Revogar<\/button>/.test(r));
  const sec = render(React.createElement(Pil.PilotSection));
  ck("4.7 seção inicial: lista não inventa empresas; seletor presente; nenhum controle da trava global", /Autorizar empresa/.test(sec) && !/Embedded Signup LIBERADO/.test(sec) && !/Ativar Embedded Signup|Desativar Embedded Signup/.test(sec));
}

console.log("\n== 5. registros incertos ==");
{
  const raw = [
    { registration_id: "r1", company_id: "c1", company_name: "Alfa", phone_number_id: "109876543210", state: "uncertain", last_error_code: "timeout", pin_stored: true, pin_source: "generated", token_retained: true, attempts_total: 2, last_attempt: { status: "uncertain", meta_code: "timeout", started_at: "2026-10-29T10:00:00Z" }, resolutions: 0, pin_secret_id: "SEGREDO-PIN" },
    { registration_id: "r2", company_id: "c2", company_name: "Beta", phone_number_id: "55501", state: "in_progress", last_attempt: { status: "started", started_at: "2026-10-29T16:10:00Z" }, token_retained: false },
    { registration_id: "r3", company_id: "c3", state: "registered" }, null, { registration_id: "r4", company_id: "c4", state: "in_progress", last_attempt: null },
  ];
  const rows = L.parseRegistrations(raw);
  ck("5.1 só uncertain/in_progress; sem PIN/segredo no modelo", rows.length === 3 && !JSON.stringify(rows).includes("SEGREDO-PIN") && rows.every((r) => !("pinStored" in r) && !("pinSecretId" in r)) && rows[0].tokenRetained === true);
  const g1 = L.resolveGate(rows[0], NOW), g2 = L.resolveGate(rows[1], NOW), g3 = L.resolveGate(rows[2], NOW);
  ck("5.2 'uncertain' pode ser resolvido; 'in_progress' recente (10 min) NÃO, com horário de liberação; sem tentativa NÃO", g1.allowed && !g2.allowed && /30 minutos/.test(g2.reason) && g2.availableAt.toISOString() === "2026-10-29T16:40:00.000Z" && !g3.allowed && g3.availableAt === null);
  ck("5.3 'in_progress' parado há mais de 30 min pode ser resolvido; limite exato (30 min) ainda bloqueia", L.resolveGate({ state: "in_progress", lastAttempt: { startedAt: "2026-10-29T15:49:00Z" } }, NOW).allowed && !L.resolveGate({ state: "in_progress", lastAttempt: { startedAt: "2026-10-29T15:50:00Z" } }, NOW).allowed);
  const ok = { outcome: "registered", evidenceType: "meta_dashboard", reason: "Conferido no painel da Meta", evidence: "Número CONECTADO no WhatsApp Manager", confirmed: true };
  ck("5.4 formulário válido não tem erros", L.validateResolveForm(ok).length === 0);
  ck("5.5 cada campo é exigido: destino, tipo de evidência, motivo (10–500), evidência (10–1000), confirmação", [{ outcome: "" }, { outcome: "pending" }, { evidenceType: "" }, { evidenceType: "palpite" }, { reason: "curto" }, { reason: "x".repeat(501) }, { evidence: "" }, { evidence: "y".repeat(1001) }, { confirmed: false }].every((p) => L.validateResolveForm({ ...ok, ...p }).length >= 1) && L.validateResolveForm(L.EMPTY_RESOLVE_FORM).length === 5);
  ck("5.6 espaços não contam como texto", L.validateResolveForm({ ...ok, reason: "          ", evidence: "          " }).length === 2);
  const dlg = render(React.createElement(Reg.ResolveDialog, { row: rows[0], onClose() {}, onDone: async () => {} }));
  ck("5.7 diálogo: estado de destino, tipo de evidência, motivo, evidência, confirmação final; avisa que NÃO chama a Meta; sem PIN/token", /Estado de destino/.test(dlg) && /Tipo de evidência/.test(dlg) && /Motivo/.test(dlg) && /Descrição ou referência/.test(dlg) && /type="checkbox"/.test(dlg) && /não chama a Meta/.test(dlg) && !/SEGREDO|EAAG/.test(dlg) && /•••• 3210/.test(dlg) && !/109876543210/.test(dlg));
  const recentRow = { ...rows[1], lastAttempt: { ...rows[1].lastAttempt, startedAt: new Date(Date.now() - 5 * 60000).toISOString() } }; // o diálogo usa o relógio real: a tentativa precisa ser de 5 min atrás, nunca uma data fixa
  const dlgBlocked = render(React.createElement(Reg.ResolveDialog, { row: recentRow, onClose() {}, onDone: async () => {} }));
  ck("5.8 diálogo de tentativa recente: mostra o bloqueio e mantém o botão de resolver desabilitado", /Tentativa em andamento/.test(dlgBlocked) && /<button[^>]*disabled[^>]*>Resolver registro<\/button>/.test(dlgBlocked));
  ck("5.9 os rótulos de destino deixam claro que é a conferência humana (registrado / não registrado)", /ESTÁ registrado/.test(L.OUTCOME_LABEL.registered) && /NÃO está registrado/.test(L.OUTCOME_LABEL.failed));
  const html = render(React.createElement(Reg.RegistrationsSection));
  ck("5.10 seção: explica que nunca repete o registro na Meta e que PIN/token não aparecem", /nunca repete o registro na Meta/.test(html) && /PIN e token não são exibidos/.test(html));
}

console.log("\n== 6. camada de API (RPC simulada): sucesso, usuário comum, falha de RPC e de rede ==");
{
  const calls = [];
  const mk = (handler) => API.createWhatsappMasterApi({ async rpc(fn, args) { calls.push([fn, args]); return handler(fn, args); } });
  const okApi = mk(async (fn) => ({ data: fn === "master_whatsapp_token_sweep_status" ? STATUS_OK : fn === "master_whatsapp_token_sweep_history" ? { total: 1, limit: 10, offset: 0, rows: [] } : [], error: null }));
  const st = await okApi.sweepStatus(); const hi = await okApi.sweepHistory({ status: "failed", source: "cron", limit: 10, offset: 20 });
  ck("6.1 status e histórico: dados normalizados e parâmetros corretos (filtros, limite, offset)", st.error === null && st.data.health === "ok" && hi.data.total === 1 && JSON.stringify(calls.find((c) => c[0] === "master_whatsapp_token_sweep_history")[1]) === JSON.stringify({ p_status: "failed", p_source: "cron", p_limit: 10, p_offset: 20 }));
  const deny = mk(async () => ({ data: null, error: { message: "acesso restrito a administradores da plataforma" } }));
  const d1 = await deny.sweepStatus(), d2 = await deny.tokenHealth(), d3 = await deny.pilotList(), d4 = await deny.registrations();
  ck("6.2 usuário comum (RPC recusa): erro amigável em todas as chamadas e nenhum dado", [d1, d2, d3, d4].every((r) => /Acesso restrito a administradores/.test(r.error)) && d1.data === null && d2.data.length === 0 && d3.data.length === 0 && d4.data.length === 0);
  const boom = mk(async () => { throw new TypeError("Failed to fetch"); });
  const b1 = await boom.sweepStatus(), b2 = await boom.pilotSet("c1", true, "motivo ok"), b3 = await boom.resolveRegistration({ registrationId: "r", outcome: "failed", evidenceType: "meta_support", reason: "motivo suficiente", evidence: "evidência suficiente" });
  ck("6.3 falha de rede (exceção): mensagem de conexão, sem propagar exceção e sem sucesso falso", /Falha de conexão/.test(b1.error) && /Falha de conexão/.test(b2.error) && b2.data === false && /Falha de conexão/.test(b3.error) && b3.data === false);
  const weird = mk(async () => ({ data: { lixo: true }, error: null }));
  ck("6.4 resposta inesperada do servidor: erro explícito, sem quebrar a tela", (await weird.sweepStatus()).error === "Resposta inesperada do servidor." && (await weird.sweepHistory({ limit: 10, offset: 0 })).error === "Resposta inesperada do servidor.");
  const leaky = mk(async () => ({ data: null, error: { message: 'duplicate key value violates unique constraint "x" DETAIL: Key (secret)=(EAAG-SEGREDO)' } }));
  const lk = await leaky.pilotSet("c1", true, "motivo ok");
  ck("6.5 erro técnico/desconhecido do banco NUNCA é repassado à tela", !/EAAG|duplicate|constraint/.test(lk.error) && /Não foi possível/.test(lk.error));
  calls.length = 0;
  const set = mk(async () => ({ data: { ok: true, changed: true }, error: null }));
  await set.pilotSet("c1", false, "  revogando por teste  ");
  ck("6.6 piloto: company_id e flag enviados como parâmetros da RPC, nota aparada; nenhuma outra RPC chamada", calls.length === 1 && calls[0][0] === "master_whatsapp_pilot_set" && JSON.stringify(calls[0][1]) === JSON.stringify({ p_company_id: "c1", p_authorized: false, p_note: "revogando por teste" }));
  calls.length = 0;
  const res = (data) => mk(async () => ({ data, error: null }));
  const R = { registrationId: "r1", outcome: "failed", evidenceType: "graph_api_check", reason: " motivo suficiente ", evidence: " evidência suficiente " };
  const okR = await res({ ok: true, state: "failed" }).resolveRegistration(R);
  ck("6.7 resolução ok: sucesso", okR.data === true && okR.error === null);
  const inflight = await res({ ok: false, error: "operation_may_be_in_flight" }).resolveRegistration(R);
  const notAllowed = await res({ ok: false, error: "state_not_allowed", state: "registered" }).resolveRegistration(R);
  const nf = await res({ ok: false, error: "registration_not_found" }).resolveRegistration(R);
  ck("6.8 backend recusa por tentativa recente / estado / inexistente: sucesso falso com mensagem própria (nunca 'resolvido')", [inflight, notAllowed, nf].every((r) => r.data === false) && /30 minutos/.test(inflight.error) && /já não está mais pendente/.test(notAllowed.error) && /não encontrado/.test(nf.error));
  const sent = mk(async () => ({ data: { ok: true }, error: null }));
  await sent.resolveRegistration(R);
  ck("6.9 parâmetros da resolução: textos aparados e só as 5 chaves da RPC", Object.keys(calls.at(-1)[1]).sort().join(",") === "p_evidence,p_evidence_type,p_outcome,p_reason,p_registration_id" && calls.at(-1)[1].p_reason === "motivo suficiente" && calls.at(-1)[1].p_evidence === "evidência suficiente");
  const empty = mk(async () => ({ data: [], error: null }));
  ck("6.10 listas vazias do servidor: sem erro e vazias", (await empty.tokenHealth()).data.length === 0 && (await empty.pilotList()).data.length === 0 && (await empty.registrations()).data.length === 0 && (await empty.pilotEvents("c1")).data.length === 0);
}

console.log("\n== 7. garantias estáticas ==");
{
  const files = ["whatsappMasterApi.ts", "whatsappMasterLogic.ts", "MonitoringSection.tsx", "TokenHealthSection.tsx", "PilotSection.tsx", "RegistrationsSection.tsx"].map((f) => codeOnly(read(W + f)));
  const page = codeOnly(read("apps/web/src/pages/MasterWhatsappPage.tsx"));
  const all = files.join("\n") + page;
  ck("7.1 nenhuma leitura direta de tabela (só RPC) e nenhum service_role", !/\.from\(/.test(all) && !/service_role|SERVICE_ROLE/.test(all));
  const rpcs = [...new Set([...codeOnly(read(W + "whatsappMasterApi.ts")).matchAll(/call\("([a-z_]+)"/g)].map((m) => m[1]))].sort();
  ck("7.2 conjunto EXATO de RPCs usadas (nada de flag global, cron manual ou escrita em tabela)", rpcs.join(",") === "master_whatsapp_pilot_events,master_whatsapp_pilot_list,master_whatsapp_pilot_set,master_whatsapp_registration_list,master_whatsapp_registration_resolve,master_whatsapp_token_health,master_whatsapp_token_sweep_history,master_whatsapp_token_sweep_status,whatsapp_signup_availability", rpcs.join(","));
  ck("7.3 nada de execução manual da varredura, alteração da trava global, repetição de registro ou envio", !/whatsapp_token_health_sweep|whatsapp_platform_settings|set_embedded_signup|master_whatsapp_(flag|platform)|whatsapp_registration_begin_attempt|whatsapp_registration_prepare|registration_finish|whatsapp-send|cron\.(schedule|alter_job|unschedule)/.test(all));
  ck("7.4 nada de PIN/token/segredo no estado ou armazenamento do navegador", !/localStorage|sessionStorage|indexedDB|console\.(log|info|debug)/.test(all) && !/pin_secret|token_secret|decrypted|access_token|vault/i.test(all));
  const app = read("apps/web/src/App.tsx"), layout = read("apps/web/src/app/MasterLayout.tsx");
  const masterBlock = app.slice(app.indexOf('path="/master"'), app.indexOf('<Route path="*"'));
  ck("7.5 rota /master/whatsapp registrada DENTRO do bloco protegido por MasterRoute e a aba existe no menu", /<MasterRoute>/.test(masterBlock) && /path="whatsapp" element=\{<MasterWhatsappPage \/>\}/.test(masterBlock) && /<NavLink to="\/master\/whatsapp">WhatsApp<\/NavLink>/.test(layout));
  ck("7.6 as outras abas do menu continuam intactas", ["/master\" end", "/master/empresas", "/master/faturas", "/master/anomalias", "/master/planos", "/master/modulos", "/master/configuracoes"].every((p) => layout.includes(p)));
  ck("7.7 confirmação explícita: autorizar/revogar e resolver exigem checkbox + botão desabilitado até válido", /disabled=\{busy \|\| !!noteError \|\| !confirmed\}/.test(read(W + "PilotSection.tsx")) && /errors\.length > 0/.test(read(W + "RegistrationsSection.tsx")) && /!gate\.allowed/.test(read(W + "RegistrationsSection.tsx")));
  ck("7.8 responsivo: tabelas dentro de .mst-scroll (rolagem horizontal) e cartões .mst-card existentes", ["MonitoringSection.tsx", "TokenHealthSection.tsx", "PilotSection.tsx", "RegistrationsSection.tsx"].every((f) => /mst-scroll/.test(read(W + f)) && /mst-card/.test(read(W + f))));
  const home = render(React.createElement(Mon.MonitoringSection));
  ck("7.9 seção de monitoramento renderiza sem dados (estado de carregamento) e com o botão Atualizar", /Monitoramento da saúde dos tokens/.test(home) && /Atualizar|Atualizando/.test(home));
}

console.log("\n== 8. tabelas com dados (render) ==");
{
  const regs = L.parseRegistrations([
    { registration_id: "r1", company_id: "c1", company_name: "Alfa", phone_number_id: "109876543210", state: "uncertain", last_error_code: "timeout", token_retained: true, attempts_total: 2, last_attempt: { status: "uncertain", meta_code: "timeout", started_at: "2026-10-29T10:00:00Z" } },
    { registration_id: "r2", company_id: "c2", company_name: "Beta", phone_number_id: "55501999", state: "in_progress", last_attempt: { status: "started", started_at: "2026-10-29T16:10:00Z" } },
    { registration_id: "r3", company_id: "c3", company_name: "Gama", phone_number_id: "77701234", state: "in_progress", last_attempt: { status: "started", started_at: "2026-10-29T14:00:00Z" } },
  ]);
  const html = render(React.createElement(Reg.RegistrationsTable, { rows: regs, now: NOW, onResolve() {} }));
  const btn = (name) => { const i = html.indexOf(name); const b = html.indexOf("<button", i); return html.slice(b, html.indexOf("</button>", b)); };
  ck("8.1 registros: 'uncertain' e 'in_progress' parado há mais de 30 min com botão HABILITADO; 'in_progress' recente DESABILITADO", !/disabled/.test(btn("Alfa")) && /disabled/.test(btn("Beta")) && !/disabled/.test(btn("Gama")));
  ck("8.2 bloqueado mostra o motivo e quando libera; vínculo com a empresa; ID da Meta mascarado; token retido informado; sem segredos", /Tentativa em andamento/.test(html) && /a partir de/.test(html) && /href="\/master\/empresas\/c1"/.test(html) && /•••• 3210/.test(html) && !/109876543210/.test(html) && /preservado até a resolução/.test(html) && !/SEGREDO|EAAG|pin_secret/.test(html));
  const tok = L.parseTokenHealth([{ company_id: "c2", company_name: "Alfa", connection_id: "k2", mode: "test", status: "revoked", last_error_code: "190", token_checked_at: "2026-10-29T10:00:00Z" }, { company_id: "c1", company_name: "Zeta", connection_id: "k1", mode: "live", status: "valid" }, { company_id: "c4", company_name: "Gama", connection_id: "k4", mode: "test", status: "unknown" }]);
  const th = render(React.createElement(Tok.TokenHealthTable, { rows: tok }));
  ck("8.3 tokens: revogado destacado com pedido de reconexão e último erro; válido e sem prazo SEM pedido; modo e vínculo com a empresa", /Revogado/.test(th) && (th.match(/Pedir para reconectar/g) ?? []).length === 1 && /Último erro: 190/.test(th) && /Sem prazo conhecido/.test(th) && /Produção/.test(th) && /Teste/.test(th) && /href="\/master\/empresas\/c2"/.test(th));
  ck("8.4 tokens: ordem — o que exige ação primeiro", th.indexOf("Revogado") < th.indexOf("Sem prazo conhecido") && th.indexOf("Sem prazo conhecido") < th.indexOf("Válido"));
  const pil = L.parsePilotList([{ company_id: "c1", company_name: "Alfa", authorized: true, authorized_by: "aaaaaaaa-bbbb", authorized_at: "2026-10-29T10:00:00Z", note: "piloto 1", connection_active: false }, { company_id: "c2", company_name: "Beta", authorized: false, revoked_by: "cccccccc-dddd", revoked_at: "2026-10-29T11:00:00Z", note: "saiu", connection_active: true }]);
  const ph = render(React.createElement(Pil.PilotTable, { rows: pil, onEvents() {}, onToggle() {} }));
  ck("8.5 piloto: autorizada com 'Revogar…' (perigo), revogada com 'Autorizar…'; histórico por empresa; só o início do ID do autor; nota exibida", /btn-danger[^>]*>Revogar…/.test(ph) && /btn-primary[^>]*>Autorizar…/.test(ph) && (ph.match(/Histórico/g) ?? []).length === 2 && /aaaaaaaa…/.test(ph) && !/aaaaaaaa-bbbb/.test(ph) && /piloto 1/.test(ph));
  const mk = (n, extra = {}) => ({ id: String(n), source: "cron", status: "success", startedAt: "2026-10-29T10:00:00Z", finishedAt: null, checked: 3, lockedSkipped: 0, updated: 1, alertsCreated: 1, alertsRefreshed: 0, errorCode: null, errorMessage: null, ...extra });
  const page = { total: 25, limit: 10, offset: 10, rows: [mk(1), mk(2, { status: "failed", errorCode: "P0001", errorMessage: "falha [removido] simulada" }), mk(3, { source: "manual", status: "skipped_concurrent" })] };
  const hc = render(React.createElement(Mon.HistoryContent, { page, loading: false, current: 2, total: 3, onPage() {} }));
  ck("8.6 histórico: linhas com resultado/origem/erro sanitizado; paginação 'Página 2 de 3' com Anterior e Próxima habilitados", /Sucesso/.test(hc) && /Falha/.test(hc) && /Ignorada/.test(hc) && /Agendador \(cron\)/.test(hc) && /Manual/.test(hc) && /P0001 — falha \[removido\] simulada/.test(hc) && /Página 2 de 3 · 25 execuções/.test(hc) && !/disabled/.test(hc.slice(hc.indexOf("Anterior") - 120, hc.indexOf("Próxima") + 10)));
  const first = render(React.createElement(Mon.HistoryContent, { page: { ...page, offset: 0 }, loading: false, current: 1, total: 3, onPage() {} }));
  const last = render(React.createElement(Mon.HistoryContent, { page: { ...page, offset: 20 }, loading: false, current: 3, total: 3, onPage() {} }));
  ck("8.7 primeira página: 'Anterior' desabilitado; última: 'Próxima' desabilitada; durante o carregamento ambos desabilitados", /<button[^>]*disabled[^>]*>Anterior/.test(first) && !/<button[^>]*disabled[^>]*>Próxima/.test(first) && /<button[^>]*disabled[^>]*>Próxima/.test(last) && (render(React.createElement(Mon.HistoryContent, { page, loading: true, current: 2, total: 3, onPage() {} })).match(/disabled/g) ?? []).length >= 2);
  const small = render(React.createElement(Mon.HistoryContent, { page: { total: 4, limit: 10, offset: 0, rows: [mk(1)] }, loading: false, current: 1, total: 1, onPage() {} }));
  ck("8.8 poucos registros: sem paginação", !/Paginação/.test(small) && !/Próxima/.test(small));
  const none = render(React.createElement(Mon.HistoryContent, { page: { total: 0, limit: 10, offset: 0, rows: [] }, loading: false, current: 1, total: 1, onPage() {} }));
  ck("8.9 histórico vazio: mensagem de lista vazia", /Nenhuma execução encontrada/.test(none));
}

console.log("\n== 9. Etapa 10.1: nota do piloto igual à regra do banco; prévia isolada fora do app ==");
{
  const migText = read("supabase/migrations/20261111010000_whatsapp_pilot_set_require_note.sql");
  const dbMin = Number(migText.match(/char_length\(v_note\) < (\d+)/)?.[1]), dbMax = Number(migText.match(/char_length\(v_note\) > (\d+)/)?.[1]);
  ck("9.1 mínimo e máximo da nota na tela são os MESMOS da RPC (5 e 500)", dbMin === L.PILOT_NOTE_MIN && dbMax === L.PILOT_NOTE_MAX && dbMin === 5 && dbMax === 500, `${dbMin}/${dbMax}`);
  ck("9.2 bordas: 4 úteis recusa, 5 aceita, 500 aceita, 501 recusa; espaços nas pontas não contam", L.validatePilotNote("  abcd  ") !== null && L.validatePilotNote("  abcde  ") === null && L.validatePilotNote("x".repeat(500)) === null && L.validatePilotNote("x".repeat(501)) !== null && L.validatePilotNote(" ".repeat(10)) !== null);
  ck("9.3 mensagens de recusa do banco (motivo vazio/curto/longo) viram mensagem segura e não vazam texto técnico", ["Informe o motivo da alteração.", "O motivo deve ter pelo menos 5 caracteres.", "O motivo deve ter no máximo 500 caracteres."].every((m) => /motivo/.test(L.friendlyRpcError(m)) && !/PT400/.test(L.friendlyRpcError(m))));
  const store = [];
  const api = API.createWhatsappMasterApi({ rpc: async (fn, args) => { store.push([fn, args]); return { data: { ok: true }, error: null }; } });
  await api.pilotSet("c1", true, "   motivo válido   ");
  ck("9.4 a API envia a nota aparada ao banco (p_note) junto de company_id e do flag", store.length === 1 && store[0][0] === "master_whatsapp_pilot_set" && store[0][1].p_note === "motivo válido" && store[0][1].p_authorized === true && store[0][1].p_company_id === "c1");
  const walk = (d) => fs.readdirSync(path.join(srcRoot, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + "/" + e.name) : [d + "/" + e.name]));
  const appFiles = walk("apps/web/src").filter((f) => /\.(ts|tsx)$/.test(f));
  ck("9.5 nada do app importa a prévia fictícia (fakeSupabase / visual-preview), e o MasterRoute continua guardando /master", !appFiles.some((f) => /fakeSupabase|visual-preview/.test(read(f))) && /path="\/master"[\s\S]{0,120}<MasterRoute>/.test(read("apps/web/src/App.tsx")) && /path="whatsapp"/.test(read("apps/web/src/App.tsx")));
  const css = read("apps/web/src/index.css");
  ck("9.6 ajustes de CSS ficam restritos à área .wa-master (não alteram os demais botões do app)", /^\.wa-master \.btn-primary \{ width: auto; \}/m.test(css) && (css.match(/^\.wa-master[^{]*\{/gm) ?? []).length >= 5 && !/^\.btn-primary\s*\{[^}]*width:\s*auto/m.test(css) && /className="wa-master"/.test(read("apps/web/src/pages/MasterWhatsappPage.tsx")));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nRESULTADO MASTER WHATSAPP UI: ${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
