//! Atualização automática (Tauri v2 updater). Estado do Agente: o JavaScript só pede "verificar" e "instalar";
//! o download e a verificação da assinatura ficam no Rust. Sem chave pública configurada (placeholder), o Agente
//! simplesmente NÃO consulta atualização (nunca falha por isso).
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Valor de `plugins.updater.pubkey` enquanto a chave definitiva não existe.
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";

/// Atualização encontrada e ainda não instalada.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
}

/// A chave pública do updater está configurada (não vazia e diferente do placeholder)?
pub fn pubkey_configured(pubkey: Option<&str>) -> bool {
    matches!(pubkey.map(str::trim), Some(k) if !k.is_empty() && k != PUBKEY_PLACEHOLDER)
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

/// Consulta o manifesto PRÓPRIO do Agente. `None` = sem atualização (ou updater ainda não configurado).
#[tauri::command]
pub async fn updater_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    if !configured(&app) {
        return Ok(None);
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let current = app.package_info().version.to_string();
    let info = found.as_ref().map(|u| UpdateInfo { version: u.version.clone(), current });
    *pending.0.lock().map_err(|e| e.to_string())? = found;
    Ok(info)
}

/// Baixa, confere a assinatura e instala. No Windows o instalador assume e o Agente é encerrado/reaberto por ele.
/// Quem chama garante que não há impressão em andamento (o frontend recusa antes).
#[tauri::command]
pub async fn updater_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().map_err(|e| e.to_string())?.take();
    let Some(update) = update else { return Err("Nenhuma atualização pendente.".into()) };
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
        assert!(!pubkey_configured(Some("   ")));
        assert!(!pubkey_configured(Some(PUBKEY_PLACEHOLDER)));
        assert!(pubkey_configured(Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6")));
    }
}
