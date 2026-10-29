// Mutação da Etapa 9 (varredura dos tokens + auditoria + agendamento): cada trava removida deve derrubar whatsapp-token-sweep.mjs.
//   node mutate-whatsapp-token-sweep.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "D:/orça facil/supabase/migrations";
const NEW = "20261110010000_whatsapp_token_sweep_history.sql";
const sql = fs.readFileSync(path.join(SRC, NEW), "utf8");
const here = path.dirname(fileURLToPath(import.meta.url));
const F1 = "(p_status is null or r.status = p_status)", F2 = "(p_source is null or r.source = p_source)";
const NLC = String.fromCharCode(10);
const M = [
  ["sem checar Admin Master", "  perform public.assert_master_admin();" + NLC, ""],
  ["limite máximo de 100 removido", "least(greatest(coalesce(p_limit, 20), 1), 100)", "greatest(coalesce(p_limit, 20), 1)"],
  ["limite mínimo removido (0 vira zero linhas)", "least(greatest(coalesce(p_limit, 20), 1), 100)", "least(coalesce(p_limit, 20), 100)"],
  ["offset ignorado", "limit v_limit offset v_offset", "limit v_limit"],
  ["offset negativo aceito", "greatest(coalesce(p_offset, 0), 0)", "coalesce(p_offset, 0)"],
  ["filtro de resultado ignorado (total e linhas)", F1, "true"],
  ["filtro de origem ignorado (total e linhas)", F2, "true"],
  ["ordenação ascendente", "order by r.started_at desc, r.id desc limit", "order by r.started_at asc, r.id asc limit"],
  ["resultado inválido aceito", "if p_status is not null and p_status not in ('success', 'failed', 'skipped_concurrent') then", "if false then"],
  ["origem inválida aceita", "if p_source is not null and p_source not in ('cron', 'manual') then", "if false then"],
  ["liberada a anon", "to authenticated;", "to authenticated, anon;"],
  ["liberada a service_role", "from public, anon, service_role;", "from public, anon;"],
  ["expõe campos extras", "'error_code', x.error_code,", "'error_code', x.error_code, 'secret', x.id,"],
  ["total ignora o filtro (só na contagem)", F1 + " and " + F2 + ";", "true;"],
];

let killed = 0, total = 0;
for (const [name, from, to] of M) {
  if (!sql.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-hist-"));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, NEW), sql.split(from).join(to));
  let out = "";
  try { out = execFileSync("node", ["whatsapp-master-history.mjs"], { cwd: here, env: { ...process.env, MIG_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${total} mutações detectadas`);
