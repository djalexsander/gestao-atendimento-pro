// Versão visível do app, num só lugar. Desktop (Tauri): a versão REAL do executável instalado, lida em runtime pela API
// oficial do Tauri v2. PWA/navegador: a versão do build (apps/web/package.json, injetada pelo Vite em __APP_VERSION__).
// Nenhuma versão é escrita à mão em componentes. Se a API do Tauri falhar, cai na versão do build (nunca quebra o app).

declare const __APP_VERSION__: string;

export type AppRuntime = "desktop" | "web";

export interface AppVersion {
  version: string;
  runtime: AppRuntime;
}

// Versão do build web (a mesma que o package.json do apps/web). Fora do Vite (testes) é "0.0.0".
export const WEB_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

// O frontend roda dentro do Tauri? (o Tauri injeta __TAURI_INTERNALS__ na janela). Única detecção do projeto.
export function isTauri(win: object | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return !!win && "__TAURI_INTERNALS__" in win;
}

async function tauriVersion(): Promise<string> {
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export interface VersionDeps {
  tauri?: boolean;
  readTauriVersion?: () => Promise<string>;
  webVersion?: string;
}

// Versão a mostrar. Web: síncrona na prática (sem chamar o Tauri). Desktop: versão real do executável; se falhar, a do build.
export async function getAppVersion(deps: VersionDeps = {}): Promise<AppVersion> {
  const web = deps.webVersion ?? WEB_VERSION;
  if (!(deps.tauri ?? isTauri())) return { version: web, runtime: "web" };
  try {
    const v = (await (deps.readTauriVersion ?? tauriVersion)()).trim();
    return { version: v || web, runtime: "desktop" };
  } catch {
    return { version: web, runtime: "desktop" };
  }
}

export type UpdateCheckResult = "uptodate" | "available" | "unavailable";

// "Verificar atualização" do Desktop: reaproveita o updater do Rust (mesmo endpoint, mesma assinatura, mesmo diálogo
// "Atualizar agora"/"Depois"). Só existe no Tauri; no PWA não há updater.
export async function checkDesktopUpdate(deps: { invoke?: (cmd: string) => Promise<unknown> } = {}): Promise<UpdateCheckResult> {
  try {
    const invoke = deps.invoke ?? (await import("@tauri-apps/api/core")).invoke;
    const r = await invoke("manual_update_check");
    return r === "uptodate" ? "uptodate" : r === "available" ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}
