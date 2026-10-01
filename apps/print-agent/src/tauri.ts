import { invoke } from "@tauri-apps/api/core";
import type { WindowsPrinter } from "./core/app.ts";
import type { KeyValueStore, SecretStore } from "./core/config.ts";
import type { StartupPort } from "./core/app.ts";
import type { RawPrinterPort } from "./core/transport.ts";

// Ponte com o shell nativo (Rust). O navegador/webview NÃO enumera impressoras nem imprime: quem faz é o Rust.

export function listWindowsPrinters(): Promise<WindowsPrinter[]> {
  return invoke<WindowsPrinter[]>("list_windows_printers");
}

export function computerName(): Promise<string> {
  return invoke<string>("computer_name");
}

// Estado local NÃO sensível (machine_id, agent_id, nomes) em app data do usuário.
export const nativeStore: KeyValueStore = {
  load: () => invoke<string | null>("load_state"),
  save: (json) => invoke<void>("save_state", { json }),
};

// Token do agente no Windows Credential Manager (nunca em arquivo/localStorage/log).
export const nativeSecrets: SecretStore = {
  get: () => invoke<string | null>("secret_get"),
  set: (token) => invoke<void>("secret_set", { token }),
  delete: () => invoke<void>("secret_delete"),
};

// Impressão RAW. O Rust recusa purpose="job" nesta versão; só o diagnóstico local ("diagnostic") imprime.
export const nativeRawPort: RawPrinterPort = {
  printRaw: (printerName, bytes, purpose) => invoke<void>("print_raw", { printerName, bytes: Array.from(bytes), purpose }),
};

// Inicialização com o Windows, bandeja e avisos (Rust). Nenhuma permissão extra para o JavaScript: tudo passa por comandos próprios.
export const nativeStartup: StartupPort = {
  setAutostart: (enabled) => invoke<void>("autostart_set", { enabled }),
  isAutostartEnabled: () => invoke<boolean>("autostart_status"),
  launchedHidden: () => invoke<boolean>("launched_minimized"),
  setTrayStatus: (connection, mode) => invoke<void>("set_tray_status", { connection, mode }),
  notify: (title, body) => invoke<void>("show_notification", { title, body }),
  showWindow: () => invoke<void>("show_main_window"),
};

export function exitApp(): Promise<void> {
  return invoke<void>("exit_app");
}
