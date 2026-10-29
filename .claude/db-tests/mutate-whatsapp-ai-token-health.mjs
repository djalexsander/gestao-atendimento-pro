// Mutação da suíte da IA com saúde do token: cada proteção do despacho removida deve derrubar whatsapp-ai-token-health-e2e.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = "D:/orça facil";
const here = path.dirname(fileURLToPath(import.meta.url));
const DSP = "supabase/functions/_shared/whatsapp-dispatch.ts";
const NL = String.fromCharCode(10);
const FILES = [DSP, "supabase/functions/_shared/whatsapp-graph.ts", "supabase/functions/whatsapp-ai-auto/handler.ts", "supabase/functions/_shared/ai-auto.ts", "supabase/functions/_shared/ai-knowledge.ts", "supabase/functions/_shared/push-core.ts",
  "supabase/functions/_shared/ai-intro.ts", "supabase/functions/_shared/ai-order.ts", "supabase/functions/_shared/ai-order-flow.ts", "supabase/functions/_shared/ai-menu.ts", "supabase/functions/_shared/menu-pdf.ts", "supabase/functions/_shared/ai-suggester.ts"].filter((f) => fs.existsSync(path.join(ROOT, f)));
const M = [
  ["bloqueio do contexto sem resposta própria", 'if (reason === "token_expired" || reason === "token_revoked") {', "if (false) {"],
  ["classifica TODO erro http como token inválido", 'if (r.kind !== "http" || r.code !== "190") return null;', 'if (r.kind !== "http") return null;'],
  ["HTTP 401 sem 190 vira prova de revogação", 'if (r.kind !== "http" || r.code !== "190") return null;', 'if (r.kind !== "http" || (r.code !== "190" && r.status !== 401)) return null;'],
  ["falha de autenticação não é registrada", ["  await reportAuthFailure(result);", "  await markMessageFailed(admin, messageId, errorCode);"].join(NL), "  await markMessageFailed(admin, messageId, errorCode);"],
  ["upload do documento não confirma token inválido", "const upAuth = await reportAuthFailure(up);", "const upAuth = null;"],
  ["envio ok não restaura a saúde", "if (unhealthyBefore && connectionId) {", "if (false) {"],
  ["checkpoint vira token inválido", 'if (r.subcode === "459" || r.subcode === "464") return "error";', ""],
];
let killed = 0, total = 0;
for (const [name, from, to] of M) {
  const src = fs.readFileSync(path.join(ROOT, DSP), "utf8");
  if (!src.includes(from)) { console.log("SKIP (trecho não encontrado):", name); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mut-aitok-"));
  for (const f of FILES) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), f === DSP ? src.replace(from, () => to) : fs.readFileSync(path.join(ROOT, f), "utf8")); }
  let out = "";
  try { out = execFileSync("node", ["whatsapp-ai-token-health-e2e.mjs"], { cwd: here, env: { ...process.env, FN_ROOT: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900000 }); } catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const m = out.match(/(\d+) ok \/ (\d+) falhas/);
  const detected = !m || Number(m[2]) > 0;
  total++; if (detected) killed++;
  console.log(`${detected ? "DETECTADO " : "SOBREVIVEU "} ${name}${m ? ` (${m[2]} falhas)` : " (abortou)"}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed}/${total} mutações detectadas`);
