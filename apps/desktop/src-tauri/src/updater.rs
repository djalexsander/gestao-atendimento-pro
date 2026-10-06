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

/// Resultado de uma consulta.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Sem versão nova (ou updater ainda não configurado).
    UpToDate,
    /// Há versão nova e a pessoa escolheu "Depois".
    Declined,
}

impl Outcome {
    /// Texto que o frontend entende (comando `manual_update_check`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Outcome::UpToDate => "uptodate",
            Outcome::Declined => "available",
        }
    }
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

/// "Verificar atualização" (Sistema / Preferências → Sobre). Mesmo updater, mesmo endpoint e mesmo diálogo do início.
#[tauri::command]
pub async fn manual_update_check(app: AppHandle) -> Result<String, String> {
    if !configured(&app) {
        return Err("Atualização automática ainda não configurada.".into());
    }
    check_and_prompt(&app).await.map(|o| o.as_str().to_string())
}

/// Consulta o manifesto; se houver versão nova, pergunta ("Atualizar agora"/"Depois"). Aceitou: baixa, valida a
/// assinatura, instala e reinicia (não retorna).
async fn check_and_prompt(app: &AppHandle) -> Result<Outcome, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Outcome::UpToDate);
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
        return Ok(Outcome::Declined);
    }
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

/// Título da janela: "Gestão Atendimento Pro v<versão real do executável>".
pub fn window_title(version: &str) -> String {
    format!("{TITLE} v{version}")
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
    fn window_title_uses_the_real_version() {
        assert_eq!(window_title("1.0.2"), "Gestão Atendimento Pro v1.0.2");
        assert_eq!(window_title("2.3.4"), "Gestão Atendimento Pro v2.3.4");
    }

    #[test]
    fn outcome_maps_to_frontend_values() {
        assert_eq!(Outcome::UpToDate.as_str(), "uptodate");
        assert_eq!(Outcome::Declined.as_str(), "available");
    }

    #[test]
    fn prompt_shows_current_and_new_version() {
        let m = prompt_message("1.0.1", "1.0.2");
        assert!(m.contains("Nova versão disponível") && m.contains("1.0.1") && m.contains("1.0.2"));
    }
}
