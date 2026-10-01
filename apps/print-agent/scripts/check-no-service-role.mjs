// Auditoria: nenhum segredo de servidor no agente nem no PWA. Procura service_role e chaves de serviço
// em código-fonte (TS, Rust, JSON/TOML de config, HTML, .env* versionados) e nos bundles gerados.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const targets = [
  "apps/print-agent/src",
  "apps/print-agent/src-tauri/src",
  "apps/print-agent/src-tauri/Cargo.toml",
  "apps/print-agent/src-tauri/tauri.conf.json",
  "apps/print-agent/src-tauri/capabilities",
  "apps/print-agent/index.html",
  "apps/print-agent/package.json",
  "apps/print-agent/dist",
  "apps/web/src",
  "apps/web/dist",
  ".env.example",
];
const bad = [/service_role/i, /SUPABASE_SERVICE/i, /sb_secret_/];
// JWT embutido com role diferente de anon (chave de serviço).
const jwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
let files = 0;
const hits = [];

function scan(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) scan(path.join(p, n));
    return;
  }
  if (!/\.(ts|tsx|js|mjs|rs|toml|json|html|css|example)$/.test(p)) return;
  files += 1;
  const raw = fs.readFileSync(p, "utf8");
  // Bundles (dist): só JWT com role de serviço e nomes de variável de chave de serviço (bibliotecas citam o termo).
  const isBundle = p.includes(path.join("dist", ""));
  // Fontes: ignora comentários (// ... e linhas de bloco), porque eles citam o termo para dizer que NÃO usam.
  const text = isBundle
    ? raw
    : raw
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
        .map((l) => l.replace(/\s\/\/.*$/, ""))
        .join("\n");
  const patterns = isBundle ? [/SERVICE_ROLE_KEY/i, /SUPABASE_SERVICE/i] : bad;
  for (const re of patterns) if (re.test(text)) hits.push(`${path.relative(root, p)}: ${re}`);
  for (const m of text.match(jwt) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(m.split(".")[1], "base64url").toString("utf8"));
      if (payload.role && payload.role !== "anon") hits.push(`${path.relative(root, p)}: JWT com role=${payload.role}`);
    } catch {
      // não era um JWT
    }
  }
}
for (const t of targets) scan(path.join(root, t));

// O token do agente não pode ir para localStorage/sessionStorage, console nem println!/dbg! (fontes do agente).
const agentSources = [];
(function collect(p) {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) return void fs.readdirSync(p).forEach((n) => collect(path.join(p, n)));
  if (/\.(ts|rs)$/.test(p)) agentSources.push(p);
})(path.join(root, "apps/print-agent/src"));
collect2(path.join(root, "apps/print-agent/src-tauri/src"));
function collect2(p) {
  if (!fs.existsSync(p)) return;
  for (const n of fs.readdirSync(p)) if (n.endsWith(".rs")) agentSources.push(path.join(p, n));
}
for (const p of agentSources) {
  const lines = fs.readFileSync(p, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;
    if (/localStorage|sessionStorage/.test(l)) hits.push(`${path.relative(root, p)}:${i + 1}: usa web storage`);
    if (/(console\.\w+|println!|eprintln!|dbg!)\(.*token/i.test(l)) hits.push(`${path.relative(root, p)}:${i + 1}: token em log`);
  });
}

const tracked =execFileSync("git", ["ls-files", "--", "*.env", ".env*"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.endsWith(".example"));
for (const f of tracked) hits.push(`${f}: arquivo .env versionado`);

console.log(`${files} arquivos varridos`);
if (hits.length) {
  console.log("ENCONTRADO:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("OK: nenhum service_role/chave de serviço no agente, no PWA ou em .env versionado");
