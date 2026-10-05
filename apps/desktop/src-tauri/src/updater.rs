//! Atualização do Desktop (Tauri v2 updater). Ao iniciar: consulta o manifesto próprio do Desktop; se houver versão
//! nova, mostra "Nova versão disponível" com versão atual/nova e os botões "Atualizar agora" / "Depois". Nada é
//! instalado sem o usuário aceitar (sem atualização silenciosa). Download e assinatura: plugin oficial.
//! Sem chave pública configurada (placeholder), simplesmente não consulta: o app nunca falha por isso.
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// Valor de `plugins.updater.pubkey` enquanto a chave definitiva não existe.
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";
const TITLE: &str = "Gestão Atendimento Pro";

/// A chave pública do updater está configurada (não vazia e diferente do placeholder)?
pub fn pubkey_configured(pubkey: Option<&str>) -> bool {
    matches!(pubkey.map(str::trim), Some(k) if !k.is_empty() && k != PUBKEY_PLACEHOLDER)
}

/// Texto do aviso (versão atual e nova).
pub fn prompt_message(current: &str, new: &str) -> String {
    format!("Nova versão disponível\n\nVersão atual: {current}\nVersão nova: {new}\n\nDeseja atualizar agora? O aplicativo será reiniciado ao final.")
}

fn configured(app: &AppHandle) -> bool {
    let key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str());
    pubkey_configured(key)
}

pub fn spawn_startup_check(app: AppHandle) {
    if !configured(&app) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check_and_prompt(&app).await {
            // Sem rede/manifesto/assinatura: só registra, o app segue normalmente.
            eprintln!("atualização: {e}");
        }
    });
}

async fn check_and_prompt(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let message = prompt_message(&app.package_info().version.to_string(), &update.version);
    let handle = app.clone();
    let accepted = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .message(message)
            .title(TITLE)
            .buttons(MessageDialogButtons::OkCancelCustom("Atualizar agora".into(), "Depois".into()))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;
    if !accepted {
        return Ok(());
    }
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pubkey_placeholder_or_empty_is_not_configured() {
        assert!(!pubkey_configured(None));
        assert!(!pubkey_configured(Some("")));
        assert!(!pubkey_configured(Some("  ")));
        assert!(!pubkey_configured(Some(PUBKEY_PLACEHOLDER)));
        assert!(pubkey_configured(Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6")));
    }

    #[test]
    fn prompt_shows_current_and_new_version() {
        let m = prompt_message("1.0.1", "1.0.2");
        assert!(m.contains("Nova versão disponível") && m.contains("1.0.1") && m.contains("1.0.2"));
    }
}
