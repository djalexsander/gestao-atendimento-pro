// Auditoria dos produtos desktop (Gestão Atendimento Pro Desktop e Agente de Impressão): nenhum segredo no git nem no bundle.
// Procura service_role, chave privada do updater (minisign/Tauri), senha da chave, token do GitHub, chave do Asaas e JWT com
// role diferente de anon. Chave PÚBLICA do updater e anon key são permitidas.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const bundles = ["apps/web/dist-desktop", "apps/web/dist", "apps/print-agent/dist"].map((p) => path.join(root, p));
const bad = [
  [/service_role/i, "service_role"],
  [/SUPABASE_SERVICE/i, "chave de serviço do Supabase"],
  [/sb_secret_[A-Za-z0-9_-]{20,}/, "sb_secret_ (chave secreta)"],
  [/untrusted comment: [^\n]*secret key/i, "chave secreta minisign/Tauri"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "chave privada PEM"],
  [/\bghp_[A-Za-z0-9]{20,}/, "token do GitHub (ghp_)"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "token do GitHub (fine-grained)"],
  [/\$aact_[A-Za-z0-9_]{10,}/, "chave do Asaas"],
  [/TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{12,}/, "valor de TAURI_SIGNING_PRIVATE_KEY*"],
];
const jwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const hits = [];
let files = 0;

function scanText(label, text, bundle) {
  files += 1;
  for (const [re, name] of bad) {
    // Em bundles de bibliotecas só vale o nome exato da variável/valor; comentários de fonte não contam.
    if (bundle && (name === "service_role" || name === "chave de serviço do Supabase")) continue;
    if (re.test(text)) hits.push(`${label}: ${name}`);
  }
  for (const m of text.match(jwt) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(m.split(".")[1], "base64url").toString("utf8"));
      if (payload.role && payload.role !== "anon") hits.push(`${label}: JWT com role=${payload.role}`);
    } catch {
      // não era um JWT
    }
  }
}

// 1) tudo que está no git (arquivos de texto)
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const textExt = /\.(ts|tsx|js|mjs|cjs|rs|toml|json|html|css|md|yml|yaml|sql|example|txt|nsi)$/i;
for (const f of tracked) {
  // Os próprios scripts de auditoria descrevem os padrões procurados (regex), então não se varrem.
  if (!textExt.test(f) || /package-lock\.json$|Cargo\.lock$|scripts\/check-no-[a-z-]+\.mjs$/.test(f)) continue;
  const full = path.join(root, f);
  if (!fs.existsSync(full)) continue;
  const raw = fs.readFileSync(full, "utf8");
  // Fontes/docs citam "service_role" para dizer que NÃO usam: comentários e linhas de texto sobre o termo ficam de fora.
  const text = raw
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|#|--|<!--|-\s)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .join("\n");
  // Migrations/SQL citam service_role em GRANT/REVOKE legítimos (papel do banco), não chave.
  // Edge Functions (servidor) e SQL usam service_role legitimamente via ambiente/GRANT; nunca vão para o desktop.
  const serverSide = /^supabase\//.test(f) || /\.(sql|md)$/i.test(f) || /scripts\/check-no-[a-z-]+\.mjs$/.test(f);
  scanText(f, serverSide ? text.replace(/service_role|SUPABASE_SERVICE\w*/gi, "") : text, false);
}
// o git nunca pode rastrear .env, chave privada ou arquivo .key/.pem
for (const f of tracked) {
  if (/(^|\/)\.env(\.|$)/.test(f) && !/\.env\.example$/.test(f)) hits.push(`${f}: .env versionado`);
  if (/\.(key|pem|p12|pfx)$/i.test(f)) hits.push(`${f}: arquivo de chave versionado`);
}

// 2) bundles gerados
function scanDir(p) {
  if (!fs.existsSync(p)) return;
  for (const n of fs.readdirSync(p)) {
    const full = path.join(p, n);
    if (fs.statSync(full).isDirectory()) scanDir(full);
    else if (/\.(js|css|html|json|map|webmanifest)$/.test(n)) scanText(path.relative(root, full), fs.readFileSync(full, "utf8"), true);
  }
}
bundles.forEach(scanDir);

console.log(`${files} arquivos varridos`);
if (hits.length) {
  console.error("FALHOU:\n" + hits.map((h) => " - " + h).join("\n"));
  process.exit(1);
}
console.log("OK: nenhum segredo (service_role, chave privada/senha do updater, token do GitHub, chave do Asaas, JWT de serviço, .env) no git nem nos bundles");
