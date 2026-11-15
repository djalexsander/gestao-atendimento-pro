// Mutação da Etapa 4 da Coexistence (sincronização inicial: Edge whatsapp-coexistence-sync + cliente Graph + migration 20261125010000):
// cada trava removida deve derrubar whatsapp-coexistence-sync.mjs. ONLY="trecho do nome" roda só os mutantes cujo nome contém o trecho.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "D:/orça facil";
const here = path.dirname(fileURLToPath(import.meta.url));
const SY = "supabase/functions/whatsapp-coexistence-sync/handler.ts";
const G = "supabase/functions/_shared/whatsapp-signup-graph.ts";
const GW = "supabase/functions/_shared/whatsapp-graph.ts";
const WH = "supabase/functions/whatsapp-webhook/handler.ts";
const MG = "supabase/migrations/20261125010000_whatsapp_coexistence_sync.sql";
const M = [
  // ---- Edge (handler) ----
  [SY, "Edge: autenticação ignorada", "if (!auth || !auth.userId) return json({ error: \"Sessão inválida ou expirada.\" }, 401);", "if (false) return json({}, 401);"],
  [SY, "Edge: ignora a recusa do prepare e chama a Meta", "if (prep.data.ok !== true) {", "if (false) {"],
  [SY, "Edge: não repete a gravação do resultado", "if (fin.error) fin = await deps.rpc(\"whatsapp_coexistence_sync_finish\", args);", ""],
  [SY, "Edge: loga o token do cliente", 'console.error("whatsapp-coexistence-sync: Meta não aceitou", { type,', 'console.error("whatsapp-coexistence-sync: Meta não aceitou", { token, type,'],
  [SY, "Edge: devolve o request_id ao navegador", 'return json({ ok: true, type, status: "requested" });', 'return json({ ok: true, type, status: "requested", requestId });'],
  [SY, "Edge: versão da Graph não validada", "if (!isValidGraphVersion(deps.graphVersion)) {", "if (false) {"],
  // ---- cliente Graph ----
  [G, "Graph: contatos pedem o sync_type errado", 'contacts: "smb_app_state_sync"', 'contacts: "contacts"'],
  [G, "Graph: recusa 4xx deixa de ser definitiva", 'if (r.kind === "http" && r.status !== undefined && r.status >= 400 && r.status < 500) return "rejected";', ""],
  [G, "Graph: incerto vira recusa (repetiria)", 'status < 500) return "rejected";\n  return "uncertain";', 'status < 500) return "rejected";\n  return "rejected";'],
  [G, "Graph: 5xx/timeout aceito como sucesso", "if (r.ok) return \"accepted\";", "if (r.ok || r.kind === \"timeout\") return \"accepted\";"],
  // ---- migration ----
  [MG, "DB: trava mestra ignorada", "if v_enabled is distinct from true then", "if false then"],
  [MG, "DB: sem checagem de owner/admin", "if not public.whatsapp_signup_user_can_manage(p_company_id, p_user_id) then", "if false then"],
  [MG, "DB: sem checagem do piloto", "if not public.whatsapp_signup_pilot_allowed(p_company_id) then", "if false then"],
  [MG, "DB: aceita conexão que não é Coexistence", "c.company_id = p_company_id and c.status = 'active' and c.connection_type = 'coexistence'", "c.company_id = p_company_id and c.status = 'active'"],
  [MG, "DB: aceita conexão pausada", "and c.lifecycle_state = 'normal' and c.phone_number_id is not null", "and c.phone_number_id is not null"],
  [MG, "DB: token vencido é aceito", "if v_eff in ('expired', 'revoked') or v_conn.token_secret_id is null then", "if false then"],
  [MG, "DB: em andamento abandonado nunca vira incerto", "and a.status = 'in_progress' and a.created_at < now() - interval '5 minutes' limit 1;", "and a.status = 'in_progress' and a.created_at < now() - interval '5 years' limit 1;"],
  [MG, "DB: incerto pode ser repetido", "elsif v_cur in ('uncertain') then", "elsif false then"],
  [MG, "DB: pedido repetido é aceito", "elsif v_cur in ('requested', 'synced', 'receiving', 'completed', 'declined') then", "elsif false then"],
  [MG, "DB: janela de 24 h ignorada", "if now() > v_sync.deadline_at then", "if false then"],
  [MG, "DB: ordem contatos->histórico ignorada", "if p_type = 'history' and v_sync.contacts_status not in ('requested', 'synced') then", "if false then"],
  [MG, "DB: tentativas ilimitadas", "if v_rejected >= 3 then", "if v_rejected >= 99999 then"],
  [MG, "DB: índice único não cobre aceito/incerto", "where status in ('in_progress', 'accepted', 'uncertain');", "where status in ('in_progress');"],
  [MG, "DB: prazo livre (sem o CHECK de 24 h)", "check (deadline_at = onboarded_at + interval '24 hours')", "check (true)"],
  [MG, "DB: novo onboarding não abre novo ciclo", "set cycle = public.whatsapp_coexistence_sync.cycle + 1,", "set cycle = public.whatsapp_coexistence_sync.cycle,"],
  [MG, "DB: recusa vira 'requested'", "case v_status when 'accepted' then 'requested' when 'rejected' then 'failed' else 'uncertain' end\n                                else s.contacts_status end", "case v_status when 'accepted' then 'requested' when 'rejected' then 'requested' else 'uncertain' end\n                                else s.contacts_status end"],
  [MG, "DB: webhook de contatos não marca 'synced'", "set contacts_status = 'synced', contacts_synced_at", "set contacts_status = contacts_status, contacts_synced_at"],
  [MG, "DB: histórico nunca completa", "then 'completed' else 'receiving' end,", "then 'receiving' else 'receiving' end,"],
  [MG, "DB: recusa do histórico não marca 'declined'", "set history_status = 'declined', history_declined_at", "set history_status = history_status, history_declined_at"],
  [MG, "DB: progresso pode regredir", "history_progress = greatest(coalesce(history_progress, 0), least(coalesce((v_detail ->> 'progress')::integer, 0), 100)),", "history_progress = least(coalesce((v_detail ->> 'progress')::integer, 0), 100),"],
  [MG, "DB: webhook sem pedido nosso altera o estado", "where connection_id = v_conn.id and contacts_status in ('requested', 'uncertain', 'in_progress');", "where connection_id = v_conn.id;"],
  [MG, "DB: leitura aberta a qualquer papel", "if v_role is null or v_role not in ('owner', 'admin') or not public.company_has_module(p_company_id, 'whatsapp') then", "if v_role is null then"],
  [MG, "DB: prepare aberto a authenticated", "grant execute on function public.whatsapp_coexistence_sync_prepare(uuid, uuid, text) to service_role;", "grant execute on function public.whatsapp_coexistence_sync_prepare(uuid, uuid, text) to service_role, authenticated;"],
  [MG, "DB: tentativas legíveis pelo cliente", "grant select, insert, update on public.whatsapp_coexistence_sync_attempts to service_role;", "grant select, insert, update on public.whatsapp_coexistence_sync_attempts to service_role;\ngrant select on public.whatsapp_coexistence_sync_attempts to authenticated;"],
  [MG, "DB: trava mestra nasce ligada", "add column coexistence_sync_enabled boolean not null default false;", "add column coexistence_sync_enabled boolean not null default true;"],
];
let killed = 0, run = 0;
for (const [file, name, from, to] of M) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!src.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-coex-sync-"));
  const isMig = file.startsWith("supabase/migrations/");
  for (const f of [SY, G, GW, WH]) {
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
  try { out = execFileSync("node", ["whatsapp-coexistence-sync.mjs"], { cwd: here, env: { ...process.env, SRC_ROOT: dir, ...(migDir ? { MIG_DIR: migDir } : {}) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  run++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${run} mutações detectadas`);
