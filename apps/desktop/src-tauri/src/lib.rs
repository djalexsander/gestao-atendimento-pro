mod notify;
mod updater;
mod win_icon;

use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Argumentos de uma invocação (2ª instância ou partida a frio): se algum é o protocolo do app (clique no toast), trata a
/// ROTA interna (valida, foca, navega/guarda pendente); sem protocolo, só foca a janela existente.
fn handle_invocation(app: &AppHandle, args: &[String]) {
    let url = args.iter().find(|a| a.to_ascii_lowercase().starts_with(&format!("{}://", notify::SCHEME)));
    match url {
        Some(u) => notify::handle_protocol_url(app, u),
        None => notify::show_main(app),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Instância ÚNICA: tem que ser o primeiro plugin. Abrir de novo só traz a janela existente para a frente.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| handle_invocation(app, &args)))
        // Registra o protocolo do app (gestaoatendimentopro://) para o clique no toast; a navegação é tratada por handle_invocation.
        .plugin(tauri_plugin_deep_link::init())
        .manage(notify::PendingRoute::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![updater::manual_update_check, notify::desktop_notify, notify::desktop_notification_status, notify::take_pending_route])
        .setup(|app| {
            // Título da janela com a versão REAL do executável (muda sozinho a cada release).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&updater::window_title(&app.package_info().version.to_string()));
                win_icon::apply_exe_icon(&window);
            }
            // Garante o protocolo do app no registro do usuário (o instalador também registra) e trata o clique no toast que INICIOU o app.
            #[cfg(windows)]
            let _ = app.deep_link().register_all();
            let args: Vec<String> = std::env::args().collect();
            if args.iter().any(|a| a.to_ascii_lowercase().starts_with(&format!("{}://", notify::SCHEME))) {
                handle_invocation(app.handle(), &args);
            }
            // Ao iniciar: consulta o manifesto PRÓPRIO do Desktop. Sem atualização (ou sem rede), segue normalmente.
            updater::spawn_startup_check(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Gestão Atendimento Pro");
}
