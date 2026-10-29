// Mutação do frontend do Painel Master/WhatsApp: cada regra removida deve derrubar master-whatsapp-ui.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "D:/orça facil";
const here = path.dirname(fileURLToPath(import.meta.url));
const W = "apps/web/src/features/master/whatsapp/";
const FILES = [W + "whatsappMasterLogic.ts", W + "whatsappMasterApi.ts", W + "MonitoringSection.tsx", W + "TokenHealthSection.tsx", W + "PilotSection.tsx", W + "RegistrationsSection.tsx", "apps/web/src/pages/MasterWhatsappPage.tsx",
  "apps/web/src/lib/dates.ts", "apps/web/src/lib/subscriptionLabels.ts", "apps/web/src/features/master/MasterBits.tsx", "apps/web/src/features/employees/Modal.tsx", "apps/web/src/App.tsx", "apps/web/src/app/MasterLayout.tsx", "apps/web/src/index.css", "supabase/migrations/20261111010000_whatsapp_pilot_set_require_note.sql"];
const L = W + "whatsappMasterLogic.ts", A = W + "whatsappMasterApi.ts", P = W + "PilotSection.tsx", R = W + "RegistrationsSection.tsx", M = W + "MonitoringSection.tsx", T = W + "TokenHealthSection.tsx";
const MUT = [
  [L, "tentativa em andamento liberada", "if (now.getTime() <= at.getTime()) {", "if (false) {"],
  [L, "limite de 30 min com folga errada (<)", "if (now.getTime() <= at.getTime()) {", "if (now.getTime() < at.getTime() - 1) {"],
  [L, "sem tentativa registrada liberada", "if (!started || Number.isNaN(started.getTime())) {", "if (false) {"],
  [L, "in_progress tratado como uncertain", 'if (row.state === "uncertain") return', 'if (true) return'],
  [L, "confirmação final não exigida", 'if (!f.confirmed) errs.push', "if (false) errs.push"],
  [L, "tipo de evidência não exigido", 'if (!f.evidenceType || !EVIDENCE_TYPES.includes(f.evidenceType)) errs.push', "if (false) errs.push"],
  [L, "motivo sem limite mínimo", "r.length < REASON_MIN ||", ""],
  [L, "nota do piloto opcional", "if (n.length < PILOT_NOTE_MIN) return", "if (false) return"],
  [L, "manual conta como cron confirmado", "const cronConfirmed = s.lastCronRun !== null;", "const cronConfirmed = s.lastRun !== null;"],
  [L, "divergência agendador x varredura omitida", "if (s.schedulerOkButSweepFailed) {", "if (false) {"],
  [L, "falha mostrada com tom de sucesso", 'failing: "bad"', 'failing: "ok"'],
  [L, "próximo disparo inclui o instante atual", "cand.getTime() > from.getTime()", "cand.getTime() >= from.getTime()"],
  [L, "grade de 6 h errada", "cand.getUTCHours() % SWEEP_PERIOD_HOURS === 0", "cand.getUTCHours() % 4 === 0"],
  [L, "mascara mostra o valor inteiro", "return `•••• ${v.slice(-4)}`;", "return v;"],
  [L, "token expirando não pede reconexão", 's === "expiring" ||', 'false ||'],
  [L, "estado desconhecido da API aceito", "if (!state || !companyId || !connectionId) continue;", "if (!companyId || !connectionId) continue;"],
  [L, "erro técnico do banco repassado", 'return "Não foi possível concluir a operação. Tente novamente.";', "return message ?? 'erro';"],
  [L, "ordem dos tokens ignora a gravidade", "TOKEN_RANK[a.state] - TOKEN_RANK[b.state] ||", ""],
  [A, "resolução aceita mesmo quando o backend recusa", 'const ok = !!r.data && typeof r.data === "object" && (r.data as { ok?: unknown }).ok === true;', "const ok = true;"],
  [A, "falha de rede propagada", "} catch (e) {", "} catch (e) { throw e;"],
  [A, "nota sem aparar", "p_note: note.trim()", "p_note: note"],
  [A, "evidência sem aparar", "p_evidence: p.evidence.trim()", "p_evidence: p.evidence"],
  [A, "filtro de resultado não enviado", "p_status: f.status ?? null,", "p_status: null,"],
  [A, "offset não enviado", "p_offset: f.offset", "p_offset: 0"],
  [A, "chama a tabela direto", 'await call("master_whatsapp_pilot_list")', 'await (client as any).from("whatsapp_signup_pilot_companies")'],
  [P, "confirmação do piloto dispensada", "disabled={busy || !!noteError || !confirmed}", "disabled={busy}"],
  [R, "resolução liberada mesmo bloqueada", "disabled={busy || !gate.allowed}", "disabled={busy}"],
  [R, "botão Resolver da tabela sempre ativo", "disabled={!gate.allowed}", "disabled={false}"],
  [T, "link da empresa removido", "to={`/master/empresas/${r.companyId}`}", "to={`/`}"],
  [M, "histórico sem paginação", "page.total > page.limit", "false"],
  ["apps/web/src/app/MasterLayout.tsx", "aba WhatsApp removida", '<NavLink to="/master/whatsapp">WhatsApp</NavLink>', ""],
  ["apps/web/src/App.tsx", "rota fora do bloco protegido", '<Route path="whatsapp" element={<MasterWhatsappPage />} />', ""],  [L, "limite da nota do piloto diferente do banco", "export const PILOT_NOTE_MAX = 500;", "export const PILOT_NOTE_MAX = 300;"],
  [L, "mínimo da nota do piloto diferente do banco", "export const PILOT_NOTE_MIN = 5;", "export const PILOT_NOTE_MIN = 1;"],
  [A, "API não apara a nota do piloto", "p_note: note.trim()", "p_note: note"],
  ["apps/web/src/pages/MasterWhatsappPage.tsx", "página sem o escopo .wa-master", "<div className=\"wa-master\">", "<div>"],
  ["apps/web/src/index.css", "botão primário global alterado para auto", ".btn-primary {\n  width: 100%;", ".btn-primary {\n  width: auto;"],
  ["apps/web/src/index.css", "regra de largura do botão da área removida", ".wa-master .btn-primary { width: auto; }\n", ""],
];

let killed = 0, total = 0;
for (const [file, name, from, to] of MUT) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
  if (!src.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-mwa-"));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    const text = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
    fs.writeFileSync(path.join(dir, f), f === file ? text.replace(from, () => to) : text);
  }
  let out = "";
  try { out = execFileSync("node", ["master-whatsapp-ui.mjs"], { cwd: here, env: { ...process.env, FE_ROOT: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${total} mutações detectadas`);
