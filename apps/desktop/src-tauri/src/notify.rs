//! Notificações NATIVAS do Windows para o Desktop (toast). O WebView2 não tem Web Push, então o canal do Desktop é o toast.
//! As REGRAS de quem recebe o quê ficam no servidor; aqui só se MOSTRA o toast e se trata o CLIQUE.
//!
//! Clique = ROTA INTERNA, nunca URL web. O toast é ativado por PROTOCOLO próprio (`gestaoatendimentopro://open?route=/app/...`):
//!   * app aberto: o Windows entrega o protocolo ao MESMO processo (instância única + deep-link) -> foca a janela e navega;
//!   * app fechado: o Windows inicia o Desktop com o protocolo -> a rota fica PENDENTE e o frontend a consome ao ficar pronto.
//! Nunca é aberto navegador: a rota só vira navegação do router interno (evento `gap:desktop-navigate`).
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub const SCHEME: &str = "gestaoatendimentopro";

/// Rota interna pendente (só em memória): vem do clique no toast e é consumida UMA vez pelo frontend.
#[derive(Default)]
pub struct PendingRoute(Mutex<Option<String>>);

/// Rota interna PERMITIDA do Desktop: só `/app...` e `/operacional...` (sem `//`, esquema, barra invertida, controle ou
/// mais de 500 caracteres). Qualquer outra coisa (http, https, //evil.com, javascript:, file:) é rejeitada.
pub fn safe_internal_path(url: &str) -> Option<String> {
    let t = url.trim();
    if t.starts_with("//") || t.contains('\\') || t.chars().any(|c| (c as u32) < 0x20) || t.chars().count() > 500 {
        return None;
    }
    let allowed = ["/app", "/operacional"].iter().any(|p| t == *p || t.starts_with(&format!("{p}/")) || t.starts_with(&format!("{p}?")));
    allowed.then(|| t.to_string())
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `gestaoatendimentopro://open?route=%2Fapp%2F...` para uma rota JÁ validada.
pub fn protocol_url(route: &str) -> String {
    format!("{SCHEME}://open?route={}", percent_encode(route))
}

/// Extrai e VALIDA a rota de uma URL do protocolo. None = URL de outro esquema, sem rota ou rota insegura.
pub fn route_from_protocol_url(url: &str) -> Option<String> {
    let prefix = format!("{SCHEME}://");
    let rest = url.trim().get(..prefix.len()).filter(|p| p.eq_ignore_ascii_case(&prefix)).map(|_| &url.trim()[prefix.len()..])?;
    let query = rest.split_once('?')?.1.split('#').next()?;
    let raw = query.split('&').find_map(|kv| kv.strip_prefix("route="))?;
    safe_internal_path(&percent_decode(raw)?)
}

/// Script que navega o router do frontend (escuta `gap:desktop-navigate`).
pub fn navigate_script(path: &str) -> String {
    let json = serde_json::to_string(path).unwrap_or_else(|_| "\"/\"".into());
    format!("window.dispatchEvent(new CustomEvent('gap:desktop-navigate', {{ detail: {json} }}));")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// XML do toast. Com rota válida: `activationType="protocol"` e `launch` = protocolo do app (nunca http/https).
pub fn toast_xml(title: &str, body: &str, route: Option<&str>) -> String {
    let launch = route
        .and_then(safe_internal_path)
        .map(|r| format!(" activationType=\"protocol\" launch=\"{}\"", xml_escape(&protocol_url(&r))))
        .unwrap_or_default();
    format!(
        "<toast{launch}><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>",
        xml_escape(title),
        xml_escape(body)
    )
}

/// Interpreta a saída de `reg query <chave> /v <valor>` (REG_DWORD). None = valor ausente/ilegível.
pub fn parse_reg_dword(output: &str) -> Option<u32> {
    let line = output.lines().find(|l| l.contains("REG_DWORD"))?;
    let hex = line.split_whitespace().last()?.trim_start_matches("0x");
    u32::from_str_radix(hex, 16).ok()
}

/// O Windows bloqueia toasts deste app? Ausência de valor = padrão do Windows (ligado).
pub fn windows_blocks(global_toast_enabled: Option<u32>, app_enabled: Option<u32>) -> bool {
    global_toast_enabled == Some(0) || app_enabled == Some(0)
}

#[cfg(windows)]
fn reg_dword(key: &str, value: &str) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg").args(["query", key, "/v", value]).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_reg_dword(&String::from_utf8_lossy(&out.stdout))
}

/// "enabled" ou "blocked" (bloqueado pelo Windows). Só informativo: o Windows não tem prompt de permissão para toasts.
#[tauri::command]
pub fn desktop_notification_status(app: AppHandle) -> String {
    #[cfg(windows)]
    {
        let global = reg_dword(r"HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications", "ToastEnabled");
        let key = format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{}", app.config().identifier);
        let app_enabled = reg_dword(&key, "Enabled");
        if windows_blocks(global, app_enabled) {
            return "blocked".into();
        }
    }
    let _ = &app;
    "enabled".into()
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Clique no toast (app aberto OU recém-iniciado): foca/restaura a janela, guarda a rota pendente e tenta navegar já.
/// Rota inválida: só foca o app, sem navegar.
pub fn handle_route(app: &AppHandle, route: Option<String>) {
    show_main(app);
    let Some(route) = route else { return };
    if let Some(state) = app.try_state::<PendingRoute>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(route.clone());
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(navigate_script(&route));
    }
}

/// Trata uma URL recebida do Windows (protocolo do app). Não-protocolo/URL insegura: só foca.
pub fn handle_protocol_url(app: &AppHandle, url: &str) {
    handle_route(app, route_from_protocol_url(url));
}

/// O frontend pronto consome a rota pendente UMA vez (e a limpa). Serve para a partida a frio (app iniciado pelo clique).
#[tauri::command]
pub fn take_pending_route(pending: State<'_, PendingRoute>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
}

/// Mostra um toast nativo. `url` (opcional) é a ROTA INTERNA aberta ao clicar; rota inválida é descartada (o clique só foca o app).
#[tauri::command]
pub fn desktop_notify(app: AppHandle, title: String, body: String, url: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Data::Xml::Dom::XmlDocument;
        use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
        let xml = XmlDocument::new().map_err(|e| e.to_string())?;
        xml.LoadXml(&HSTRING::from(toast_xml(&title, &body, url.as_deref()))).map_err(|e| e.to_string())?;
        let toast = ToastNotification::CreateToastNotification(&xml).map_err(|e| e.to_string())?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app.config().identifier.as_str())).map_err(|e| e.to_string())?;
        notifier.Show(&toast).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, &title, &body, &url);
        Err("Notificações nativas só estão disponíveis no Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_app_and_operational_routes_are_allowed() {
        for ok in ["/app", "/app/financeiro/contas-a-receber", "/operacional/producao", "/operacional/atendimento/abc", "/app/configuracoes/notificacoes"] {
            assert_eq!(safe_internal_path(ok).as_deref(), Some(ok), "{ok}");
        }
        for bad in [
            "//evil.com", "https://evil.com", "http://evil.com", "javascript:alert(1)", "file:///c:/x", "/a\\b", "/app\nx", "operacional", "", "/", "/master", "/login", "/applications", "/operacionalx",
        ] {
            assert_eq!(safe_internal_path(bad), None, "{bad}");
        }
        assert_eq!(safe_internal_path(&format!("/app/{}", "a".repeat(600))), None);
    }

    #[test]
    fn protocol_url_round_trips_a_route() {
        let url = protocol_url("/app/financeiro/contas-a-receber");
        assert!(url.starts_with("gestaoatendimentopro://open?route="));
        assert!(!url.contains("http"), "nunca URL web: {url}");
        assert_eq!(route_from_protocol_url(&url).as_deref(), Some("/app/financeiro/contas-a-receber"));
        assert_eq!(route_from_protocol_url(&protocol_url("/operacional/atendimento/x?y=1")).as_deref(), Some("/operacional/atendimento/x?y=1"));
    }

    #[test]
    fn unsafe_protocol_urls_are_rejected() {
        for bad in [
            "https://atendimento.alexproapps.com.br/app/financeiro",
            "gestaoatendimentopro://open?route=https%3A%2F%2Fevil.com",
            "gestaoatendimentopro://open?route=%2F%2Fevil.com",
            "gestaoatendimentopro://open?route=javascript%3Aalert(1)",
            "gestaoatendimentopro://open?route=file%3A%2F%2F%2Fc%3A%2Fx",
            "gestaoatendimentopro://open?route=%2Fmaster",
            "gestaoatendimentopro://open",
            "gestaoatendimentopro://open?route=%ZZ",
            "outro://open?route=%2Fapp",
        ] {
            assert_eq!(route_from_protocol_url(bad), None, "{bad}");
        }
        assert!(route_from_protocol_url("GESTAOATENDIMENTOPRO://open?route=%2Fapp").is_some(), "esquema não diferencia maiúsculas");
    }

    #[test]
    fn toast_uses_protocol_activation_never_http() {
        let x = toast_xml("Título & <teste>", "Texto \"x\"", Some("/app/financeiro/contas-a-receber"));
        assert!(x.contains("activationType=\"protocol\""));
        assert!(x.contains("launch=\"gestaoatendimentopro://open?route=%2Fapp%2Ffinanceiro%2Fcontas-a-receber\""));
        assert!(!x.contains("http://") && !x.contains("https://"));
        assert!(x.contains("Título &amp; &lt;teste&gt;") && x.contains("Texto &quot;x&quot;"), "XML escapado: {x}");
        // rota insegura/ausente: sem ativação por protocolo (o clique só foca o app)
        for r in [Some("https://evil.com"), Some("//evil.com"), Some("/master"), None] {
            let y = toast_xml("a", "b", r);
            assert!(!y.contains("launch=") && !y.contains("activationType"), "{r:?}: {y}");
        }
    }

    #[test]
    fn navigate_script_escapes_the_path() {
        let s = navigate_script("/app/x\"); alert(1); (\"");
        let literal = serde_json::to_string("/app/x\"); alert(1); (\"").unwrap();
        assert!(s.contains("gap:desktop-navigate") && s.contains(&format!("detail: {literal} ")), "{s}");
    }

    #[test]
    fn parses_reg_dword_output() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\X\r\n    ToastEnabled    REG_DWORD    0x0\r\n";
        assert_eq!(parse_reg_dword(out), Some(0));
        assert_eq!(parse_reg_dword("    Enabled    REG_DWORD    0x1\r\n"), Some(1));
        assert_eq!(parse_reg_dword("ERRO: não foi possível localizar"), None);
    }

    #[test]
    fn windows_block_rules() {
        assert!(!windows_blocks(None, None));
        assert!(!windows_blocks(Some(1), Some(1)));
        assert!(windows_blocks(Some(0), None));
        assert!(windows_blocks(None, Some(0)));
    }
}
