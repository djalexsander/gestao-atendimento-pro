mod updater;

use tauri::{AppHandle, Manager};

/// Traz a janela principal para a frente (2º clique no atalho com o app já aberto).
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Instância ÚNICA: tem que ser o primeiro plugin. Abrir de novo só traz a janela existente para a frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![updater::manual_update_check])
        .setup(|app| {
            // Título da janela com a versão REAL do executável (muda sozinho a cada release).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&updater::window_title(&app.package_info().version.to_string()));
            }
            // Ao iniciar: consulta o manifesto PRÓPRIO do Desktop. Sem atualização (ou sem rede), segue normalmente.
            updater::spawn_startup_check(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Gestão Atendimento Pro");
}
