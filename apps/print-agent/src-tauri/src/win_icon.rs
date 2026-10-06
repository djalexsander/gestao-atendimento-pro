//! Ícone da barra de tarefas. O Tauri só define o ícone PEQUENO da janela; sem o ícone GRANDE (ICON_BIG) e sem ícone
//! de classe, o Windows busca o ícone do executável pelo cache do Shell, que pode guardar o ícone de uma versão antiga.
//! Aqui o ícone embutido no próprio .exe (recurso 32512, o mesmo que o bundle usa) é aplicado explicitamente à janela.

/// Id do recurso de ícone que o tauri-build embute no executável.
pub const APP_ICON_RESOURCE_ID: usize = 32512;

#[cfg(windows)]
pub fn apply_exe_icon(window: &tauri::WebviewWindow) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON, SM_CXSMICON, SM_CYICON,
        SM_CYSMICON, WM_SETICON,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = HWND(hwnd.0);
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        for (kind, cx, cy) in [(ICON_BIG, SM_CXICON, SM_CYICON), (ICON_SMALL, SM_CXSMICON, SM_CYSMICON)] {
            if let Ok(icon) = LoadImageW(Some(module.into()), PCWSTR(APP_ICON_RESOURCE_ID as *const u16), IMAGE_ICON, GetSystemMetrics(cx), GetSystemMetrics(cy), LR_DEFAULTCOLOR) {
                let _ = SendMessageW(hwnd, WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(icon.0 as isize)));
            }
        }
    }
}

#[cfg(not(windows))]
pub fn apply_exe_icon(_window: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    #[test]
    fn resource_id_is_the_tauri_default_app_icon() {
        assert_eq!(super::APP_ICON_RESOURCE_ID, 32512);
    }
}
