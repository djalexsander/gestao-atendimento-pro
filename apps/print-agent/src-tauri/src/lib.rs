mod printers;
mod raw_print;
mod secrets;

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
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

/// Estado local NÃO sensível (machine_id, agent_id, nomes). O token fica no Credential Manager.
#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = state_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Grava de forma atômica (arquivo temporário + rename) para nunca deixar o estado pela metade.
#[tauri::command]
fn save_state(app: tauri::AppHandle, json: String) -> Result<(), String> {
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

/// Envia um documento ESC/POS RAW ao spooler. NÃO é uma API livre: só aceita impressora instalada,
/// documento que começa com ESC @ e, enquanto `REAL_JOB_PRINTING_ENABLED` for falso, apenas a
/// finalidade "diagnostic" (clique explícito no diagnóstico). Jobs do servidor ("job") são recusados aqui.
#[tauri::command]
fn print_raw(printer_name: String, bytes: Vec<u8>, purpose: String) -> Result<(), String> {
    let installed: Vec<String> = printers::list()?.into_iter().map(|p| p.name).collect();
    raw_print::validate(&printer_name, &bytes, &purpose, &installed)?;
    raw_print::send(&printer_name, &bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_windows_printers,
            computer_name,
            load_state,
            save_state,
            secret_set,
            secret_get,
            secret_delete,
            print_raw
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Agente de Impressão");
}
