mod label_print;
mod printers;
mod raw_print;
mod secrets;
mod updater;
mod win_icon;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

const PRODUCT: &str = "Gestão Atendimento Pro - Agente de Impressão";

/// Título da janela: "<produto> v<versão real do executável>".
pub fn window_title(version: &str) -> String {
    format!("{PRODUCT} v{version}")
}

/// Tooltip da bandeja (Windows limita a ~127 caracteres): produto + versão, e a situação na linha de baixo.
pub fn tray_tooltip(version: &str, status: &str, mode: &str) -> String {
    format!("{}
{status} — {mode}", window_title(version))
}

/// Argumento passado pelo autostart do Windows: iniciar ESCONDIDO na bandeja.
pub const MINIMIZED_ARG: &str = "--minimized";

/// Pasta do estado local. `PRINT_AGENT_DATA_DIR` permite rodar uma instância de TESTE com outro estado
/// (sem mexer no state.json real). Sem ela: app data do usuário.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var("PRINT_AGENT_DATA_DIR") {
        Ok(custom) if !custom.trim().is_empty() => PathBuf::from(custom),
        _ => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("state.json"))
}

fn read_state_json(app: &AppHandle) -> Option<serde_json::Value> {
    let text = fs::read_to_string(state_path(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

/// "Manter ativo em segundo plano": padrão LIGADO (ausente/ilegível = ligado). Só `false` explícito desliga.
pub fn keep_background(state: Option<&serde_json::Value>) -> bool {
    state
        .and_then(|v| v.get("keepBackground"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Iniciado pelo autostart (escondido na bandeja)?
pub fn minimized_requested(args: &[String]) -> bool {
    args.iter().any(|a| a == MINIMIZED_ARG)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Lista as impressoras instaladas no Windows (nome + se é a padrão). Não imprime nada.
#[tauri::command]
fn list_windows_printers() -> Result<Vec<printers::PrinterInfo>, String> {
    printers::list()
}

/// Nome do computador (rótulo amigável sugerido no pareamento; NÃO é identificador).
#[tauri::command]
fn computer_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// Estado local NÃO sensível (machine_id, agent_id, nomes, modo, opções de inicialização). O token fica no Credential Manager.
#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Grava de forma atômica (arquivo temporário + rename) para nunca deixar o estado pela metade.
#[tauri::command]
fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Token do agente no Windows Credential Manager (o valor nunca é logado).
#[tauri::command]
fn secret_set(token: String) -> Result<(), String> {
    secrets::set(secrets::SERVICE, &token)
}

#[tauri::command]
fn secret_get() -> Result<Option<String>, String> {
    secrets::get(secrets::SERVICE)
}

#[tauri::command]
fn secret_delete() -> Result<(), String> {
    secrets::delete(secrets::SERVICE)
}

/// Modo REAL escolhido explicitamente pelo usuário (state.json: printMode == "real"). Ausente/ilegível = falso.
fn real_mode(app: &AppHandle) -> bool {
    read_state_json(app)
        .and_then(|v| v.get("printMode").and_then(|m| m.as_str().map(|s| s == "real")))
        .unwrap_or(false)
}

/// Envia um documento ESC/POS RAW ao spooler. NÃO é uma API livre: só aceita impressora instalada e
/// documento que começa com ESC @. Finalidade "diagnostic" (clique explícito no diagnóstico) é sempre aceita;
/// "job" (fila automática) só se o modo REAL estiver salvo no state.json.
#[tauri::command]
fn print_raw(app: AppHandle, printer_name: String, bytes: Vec<u8>, purpose: String) -> Result<(), String> {
    let installed: Vec<String> = printers::list()?.into_iter().map(|p| p.name).collect();
    raw_print::validate(&printer_name, &bytes, &purpose, &installed, real_mode(&app))?;
    raw_print::send(&printer_name, &bytes)
}

/// Imprime ETIQUETAS (bitmaps 1 bit) pelo driver do Windows (GDI). Mesmas regras do RAW: validação no lado nativo
/// (modo real para jobs, impressora instalada, limites).
#[tauri::command]
fn print_label_pages(app: AppHandle, printer_name: String, pages: Vec<label_print::LabelPage>, purpose: String) -> Result<(), String> {
    let installed: Vec<String> = printers::list()?.into_iter().map(|p| p.name).collect();
    label_print::validate(&printer_name, &pages, &purpose, &installed, real_mode(&app))?;
    label_print::send(&printer_name, &pages)
}

/// Liga/desliga "Iniciar com o Windows" (entrada HKCU\...\Run criada pelo plugin oficial de autostart,
/// com o argumento --minimized para subir escondido na bandeja).
#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_status(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// O processo foi iniciado pelo autostart (--minimized)?
#[tauri::command]
fn launched_minimized() -> bool {
    let args: Vec<String> = std::env::args().collect();
    minimized_requested(&args)
}

/// Traz a janela para a frente (erro crítico de credencial, "Abrir" do menu).
#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

/// Texto do menu da bandeja: status (online/offline) e modo (simulação/real). Só rótulos, sem dados sensíveis.
#[tauri::command]
fn set_tray_status(app: AppHandle, connection: String, mode: String) {
    let status = match connection.as_str() {
        "online" => "Online",
        "offline" => "Offline",
        "revoked" => "Desconectado",
        _ => "Conectando…",
    };
    let mode = if mode == "real" { "Real" } else { "Simulação" };
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.status.set_text(format!("Status: {status}"));
        let _ = items.mode.set_text(format!("Modo: {mode}"));
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tray_tooltip(&app.package_info().version.to_string(), status, mode)));
    }
}

/// Aviso discreto do Windows (toast).
#[tauri::command]
fn show_notification(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Encerra o processo (chamado pelo frontend depois de parar heartbeat e poller).
#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

struct TrayItems {
    status: MenuItem<Wry>,
    mode: MenuItem<Wry>,
    // mantém o menu vivo
    _menu: Mutex<Menu<Wry>>,
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let version = app.package_info().version.to_string();
    let title = MenuItem::with_id(app, "title", window_title(&version), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Abrir", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Status: Conectando…", false, None::<&str>)?;
    let mode = MenuItem::with_id(app, "mode", "Modo: Simulação", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair do Agente", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&title, &sep1, &open, &status, &mode, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip(window_title(&version))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => {
                // Pede ao frontend para parar heartbeat/poller e sair; se ele não responder em 2 s, sai igual.
                let _ = app.emit("quit-requested", ());
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayItems { status, mode, _menu: Mutex::new(menu) });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Instância ÚNICA: tem que ser o primeiro plugin. Um 2º clique no .exe só traz a janela existente para a frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_ARG])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::PendingUpdate::default())
        .setup(|app| {
            // Título da janela com a versão REAL do executável (muda sozinho a cada release).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&window_title(&app.package_info().version.to_string()));
                win_icon::apply_exe_icon(&window);
            }
            build_tray(app.handle())?;
            let args: Vec<String> = std::env::args().collect();
            // Autostart sobe escondido na bandeja; clique manual abre a janela.
            if !minimized_requested(&args) {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                // X = esconder na bandeja (o processo, o heartbeat e a fila continuam). Só "Sair do Agente" encerra.
                if keep_background(read_state_json(app).as_ref()) {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("hidden-to-tray", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_windows_printers,
            computer_name,
            load_state,
            save_state,
            secret_set,
            secret_get,
            secret_delete,
            print_raw,
            print_label_pages,
            autostart_set,
            autostart_status,
            launched_minimized,
            show_main_window,
            set_tray_status,
            show_notification,
            exit_app,
            updater::updater_enabled,
            updater::updater_check,
            updater::updater_install
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Agente de Impressão");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn titles_and_tooltip_carry_the_real_version() {
        assert_eq!(window_title("1.0.2"), "Gestão Atendimento Pro - Agente de Impressão v1.0.2");
        let t = tray_tooltip("1.0.2", "Online", "Real");
        assert!(t.starts_with("Gestão Atendimento Pro - Agente de Impressão v1.0.2"));
        assert!(t.contains("Online — Real"));
        assert!(t.chars().count() <= 127, "tooltip do Windows tem limite de 127 caracteres");
    }

    #[test]
    fn keep_background_defaults_to_on() {
        assert!(keep_background(None));
        assert!(keep_background(Some(&json!({}))));
        assert!(keep_background(Some(&json!({ "keepBackground": "x" }))), "valor inválido = ligado");
        assert!(keep_background(Some(&json!({ "keepBackground": true }))));
    }

    #[test]
    fn keep_background_off_only_when_explicit() {
        assert!(!keep_background(Some(&json!({ "keepBackground": false }))));
    }

    #[test]
    fn detects_autostart_minimized_flag() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(minimized_requested(&a(&["print-agent.exe", "--minimized"])));
        assert!(!minimized_requested(&a(&["print-agent.exe"])));
        assert!(!minimized_requested(&a(&["print-agent.exe", "--minimizedx"])));
    }
}
