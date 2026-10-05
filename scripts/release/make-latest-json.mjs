// Monta o manifesto do updater (latest.json) de UM produto. Cada produto tem o próprio manifesto e a própria tag:
//   desktop      -> tag v<versão>               -> canal de atualização: release "desktop-latest"
//   print-agent  -> tag print-agent-v<versão>   -> canal de atualização: release "print-agent-latest"
// Uso: node scripts/release/make-latest-json.mjs --product desktop --version 1.0.1 --repo dono/repo \
//        --installer <arquivo.exe> --sig <arquivo.exe.sig> --out latest.json [--notes "texto"]
import fs from "node:fs";
import path from "node:path";

export const PRODUCTS = {
  desktop: { tagPrefix: "v", channel: "desktop-latest" },
  "print-agent": { tagPrefix: "print-agent-v", channel: "print-agent-latest" },
};

export function buildManifest({ product, version, repo, installerName, signature, notes = "", pubDate = new Date().toISOString() }) {
  const p = PRODUCTS[product];
  if (!p) throw new Error(`produto inválido: ${product}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`versão inválida: ${version}`);
  if (!signature || !signature.trim()) throw new Error("assinatura (.sig) vazia");
  const tag = `${p.tagPrefix}${version}`;
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(installerName)}`,
      },
    },
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("make-latest-json.mjs")) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith("--") ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
  for (const k of ["product", "version", "repo", "installer", "sig", "out"]) if (!args[k]) throw new Error(`falta --${k}`);
  const manifest = buildManifest({
    product: args.product,
    version: args.version,
    repo: args.repo,
    installerName: path.basename(args.installer),
    signature: fs.readFileSync(args.sig, "utf8"),
    notes: args.notes ?? "",
  });
  fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifesto ${args.product} ${args.version} -> ${args.out}`);
}
