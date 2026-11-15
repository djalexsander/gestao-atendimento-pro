// Mutação da Etapa 3 da Coexistence (webhook + migration 20261124010000): cada trava removida deve derrubar whatsapp-coexistence-webhook.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "D:/orça facil";
const here = path.dirname(fileURLToPath(import.meta.url));
const H = "supabase/functions/whatsapp-webhook/handler.ts";
const MG = "supabase/migrations/20261124010000_whatsapp_coexistence_webhooks.sql";
// whatsapp_coexistence_record foi REDEFINIDA pela migration 20261125010000 (estado da sincronização): a definição viva está lá
const MG5 = "supabase/migrations/20261125010000_whatsapp_coexistence_sync.sql";
const M = [
  // ---- webhook (Edge) ----
  [H, "campo smb_message_echoes deixa de ser tratado", 'new Set(["smb_message_echoes", "smb_app_state_sync", "history", "account_update"])', 'new Set(["smb_app_state_sync", "history", "account_update"])'],
  [H, "campo account_update deixa de ser tratado", 'new Set(["smb_message_echoes", "smb_app_state_sync", "history", "account_update"])', 'new Set(["smb_message_echoes", "smb_app_state_sync", "history"])'],
  [H, "eco ignora o wa_id de contacts quando falta 'to'", "const to = str(rawEcho.to) ?? str(firstContact?.wa_id);", "const to = str(rawEcho.to);"],
  [H, "contagem de contatos adicionados zerada", 'if (it.action === "add") added += 1;', 'if (it.action === "add") added += 0;'],
  [H, "contagem de mensagens do histórico zerada", "messages += arr(t.messages).length;", "messages += 0;"],
  [H, "recusa do histórico não é registrada", "if (errors.length > 0) {", "if (false) {"],
  [H, "falha transitória do banco não devolve 5xx", "if (res.error) {\n      console.error(\"whatsapp-webhook: falha transitória (coexistence)\"", "if (false) {\n      console.error(\"whatsapp-webhook: falha transitória (coexistence)\""],
  [H, "motivo da desconexão descartado", "const reason = str(di?.reason);", "const reason = null;"],
  [H, "limite de corpo volta a 1 MiB (histórico grande rejeitado)", "const MAX_BODY_BYTES = 8 * 1024 * 1024;", "const MAX_BODY_BYTES = 1024 * 1024;"],
  [H, "revoke/edit passam a ser tratados como mensagem nova", 'if (kind === "revoke" || kind === "edit") {', "if (false) {"],
  [H, "mídia do histórico deixa de ser ignorada", "counts.ignored += 1; // webhook de mídia do histórico: fora desta etapa", "// removido"],
  [H, "grava o texto livre da recusa", "p_detail: { error_code: code } });", "p_detail: { error_code: code, texto: JSON.stringify(first) } });"],
  // ---- migration ----
  [MG, "eco: sem a trava de conexão em Coexistence", "if v_conn.connection_type <> 'coexistence' then\n    return jsonb_build_object('result', 'not_coexistence');\n  end if;\n  if v_wamid is null", "if false then\n    return jsonb_build_object('result', 'not_coexistence');\n  end if;\n  if v_wamid is null"],
  [MG, "eco: não pausa a IA", "   where id = v_conv.id and ai_control = 'inherit';\n  get diagnostics v_paused", "   where false;\n  get diagnostics v_paused"],
  [MG, "eco: não cancela os jobs pendentes", "where conversation_id = v_conv.id and status = 'pending';\n  get diagnostics v_cancelled", "where conversation_id = v_conv.id and false;\n  get diagnostics v_cancelled"],
  [MG, "eco: sem o casamento com envio da API em voo", "and o.sent_via = 'cloud_api' and o.status = 'queued' and o.provider_message_id is null", "and false"],
  [MG, "eco: casa qualquer texto com o envio em voo", "and (v_type <> 'text' or o.body is not distinct from v_body)", ""],
  [MG, "eco: sem dedupe por wamid", "if exists (select 1 from public.whatsapp_messages m where m.connection_id = v_conn.id and m.provider_message_id = v_wamid) then", "if false then"],
  [MG, "eco: nono dígito não é tolerado", "public.whatsapp_br_phone_equivalent(c.contact_phone, v_phone)", "c.contact_phone = v_phone"],
  [MG, "eco: grava como cloud_api", "'human', 'business_app', p_provider_timestamp", "'human', 'cloud_api', p_provider_timestamp"],
  [MG, "eco: estende a janela de 24 h", "set last_outbound_at = greatest(coalesce(c.last_outbound_at, '-infinity'::timestamptz), v_ts),", "set last_inbound_at = v_ts, last_outbound_at = greatest(coalesce(c.last_outbound_at, '-infinity'::timestamptz), v_ts),"],
  [MG, "eco: conversa nova pelo celular nasce com a IA ativa", "values (v_conn.company_id, v_conn.id, v_phone, 'open', 'human', now())", "values (v_conn.company_id, v_conn.id, v_phone, 'open', 'inherit', now())"],
  [MG5, "registro: sem a trava de Coexistence", "if v_conn.connection_type <> 'coexistence' then\n    return jsonb_build_object('result', 'not_coexistence');\n  end if;\n  -- só números inteiros", "if false then\n    return jsonb_build_object('result', 'not_coexistence');\n  end if;\n  -- só números inteiros"],
  [MG5, "registro: aceita qualquer chave no detalhe (grava texto livre)", "foreach v_k in array array['added', 'removed', 'threads', 'messages', 'phase', 'chunk_order', 'progress', 'error_code'] loop", "foreach v_k in array array(select jsonb_object_keys(p_detail)) loop"],
  [MG, "PARTNER_REMOVED não desconecta", "set status = 'disconnected', disconnected_at = coalesce(disconnected_at, now()),", "set status = status, disconnected_at = coalesce(disconnected_at, now()),"],
  [MG, "account_update atinge conexões manuais", "where c.waba_id = p_waba_id and c.connection_source = 'embedded_signup'\n     order by c.id\n       for update", "where c.waba_id = p_waba_id\n     order by c.id\n       for update"],
  [MG, "OFFBOARDED atinge Cloud API", "elsif v_event = 'ACCOUNT_OFFBOARDED' and v_row.connection_type = 'coexistence' then", "elsif v_event = 'ACCOUNT_OFFBOARDED' then"],
  [MG, "RECONNECTED reativa conexão removida", "if v_row.status = 'error' and v_row.lifecycle_state = 'offboarded' then", "if true then"],
  [MG, "reativar não limpa o ciclo de vida", "if new.status = 'active' and old.status is distinct from 'active' then", "if false then"],
  [MG, "mark_message_sent apaga mensagem que não é eco", "and id <> v_msg.id and sent_via = 'business_app';", "and id <> v_msg.id;"],
  [MG, "mark_message_sent sem o tratamento de conflito", "exception when unique_violation then\n    delete from public.whatsapp_messages", "exception when no_data_found then\n    delete from public.whatsapp_messages"],
  [MG, "RPC de eco aberta a authenticated", "grant execute on function public.whatsapp_ingest_echo(text, text, text, text, text, timestamptz, text) to service_role;", "grant execute on function public.whatsapp_ingest_echo(text, text, text, text, text, timestamptz, text) to service_role, authenticated;"],
  [MG, "trilha legível por authenticated", "grant select, insert on public.whatsapp_coexistence_events to service_role;", "grant select, insert on public.whatsapp_coexistence_events to service_role;\ngrant select on public.whatsapp_coexistence_events to authenticated;"],
  [MG, "CHECK de forma do eco removido", "sent_via = 'cloud_api' or (direction = 'outbound' and origin = 'human' and sent_by_user_id is null)", "true"],
];
let killed = 0, run = 0;
for (const [file, name, from, to] of M) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (!src.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-coex-wh-"));
  const isMig = file.startsWith("supabase/migrations/");
  fs.mkdirSync(path.dirname(path.join(dir, H)), { recursive: true });
  fs.writeFileSync(path.join(dir, H), file === H ? src.replace(from, () => to) : fs.readFileSync(path.join(ROOT, H), "utf8"));
  let migDir = null;
  if (isMig) {
    migDir = path.join(dir, "migrations");
    fs.mkdirSync(migDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, "supabase/migrations"))) fs.copyFileSync(path.join(ROOT, "supabase/migrations", f), path.join(migDir, f));
    fs.writeFileSync(path.join(migDir, path.basename(file)), src.replace(from, () => to));
  }
  let out = "";
  try { out = execFileSync("node", ["whatsapp-coexistence-webhook.mjs"], { cwd: here, env: { ...process.env, SRC_ROOT: dir, ...(migDir ? { MIG_DIR: migDir } : {}) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  run++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${run} mutações detectadas`);
