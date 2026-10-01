//! Impressão RAW (ESC/POS) pelo Print Spooler do Windows: OpenPrinter -> StartDocPrinter(datatype RAW)
//! -> StartPagePrinter -> WritePrinter -> EndPagePrinter -> EndDocPrinter -> ClosePrinter.
//! Nunca abre diálogo de impressão. O comando exposto ao frontend (`print_raw`) passa por `validate`,
//! que é a defesa NO LADO NATIVO: jobs do servidor (purpose "job") só são aceitos quando o modo de impressão
//! salvo no state.json do usuário é "real" (escolha explícita na interface); o diagnóstico ("diagnostic") é
//! independente do modo. Só se imprime em impressora instalada.

/// Limite do documento (um ticket nunca chega perto disso).
pub const MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Purpose {
    Diagnostic,
    Job,
}

pub fn parse_purpose(value: &str) -> Result<Purpose, String> {
    match value {
        "diagnostic" => Ok(Purpose::Diagnostic),
        "job" => Ok(Purpose::Job),
        _ => Err("Finalidade de impressão inválida.".into()),
    }
}

/// Valida o pedido ANTES de qualquer chamada ao spooler.
/// `real_mode`: o usuário escolheu explicitamente o modo REAL (lido do state.json por quem chama).
pub fn validate(printer: &str, bytes: &[u8], purpose: &str, installed: &[String], real_mode: bool) -> Result<(), String> {
    let purpose = parse_purpose(purpose)?;
    if purpose == Purpose::Job && !real_mode {
        return Err("O modo de impressão REAL não está ativado neste computador. Os jobs do servidor não são impressos em modo simulação.".into());
    }
    if bytes.is_empty() {
        return Err("Documento vazio.".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("Documento grande demais para imprimir.".into());
    }
    // Todo documento ESC/POS gerado pelo agente começa com ESC @ (inicializar).
    if bytes.len() < 2 || bytes[0] != 0x1b || bytes[1] != 0x40 {
        return Err("Documento ESC/POS inválido.".into());
    }
    if !installed.iter().any(|name| name == printer) {
        return Err(format!("Impressora não encontrada no Windows: {printer}."));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Open,
    StartDoc,
    StartPage,
    Write,
    Finish,
}

// Códigos Win32 mais comuns.
const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_INVALID_PRINTER_NAME: u32 = 1801;
const RPC_S_SERVER_UNAVAILABLE: u32 = 1722;
const RPC_S_CALL_FAILED: u32 = 1726;
const ERROR_INVALID_HANDLE: u32 = 6;
const ERROR_BROKEN_PIPE: u32 = 109;
const ERROR_NOT_READY: u32 = 21;
const ERROR_OUT_OF_PAPER: u32 = 28;
const ERROR_WRITE_FAULT: u32 = 29;

/// Traduz erros do spooler para mensagens compreensíveis (o detalhe técnico vai junto, entre parênteses).
pub fn translate_error(stage: Stage, code: u32) -> String {
    let friendly = match code {
        ERROR_INVALID_PRINTER_NAME => "Impressora não encontrada no Windows. Confira se ela continua instalada.",
        ERROR_ACCESS_DENIED => "Acesso negado à impressora. Verifique as permissões do Windows para este usuário.",
        RPC_S_SERVER_UNAVAILABLE | RPC_S_CALL_FAILED | ERROR_BROKEN_PIPE => "O spooler de impressão do Windows está indisponível. Reinicie o serviço \"Spooler de Impressão\".",
        ERROR_NOT_READY | ERROR_WRITE_FAULT => "A impressora não respondeu. Confira se está ligada, com papel e conectada.",
        ERROR_OUT_OF_PAPER => "A impressora está sem papel.",
        ERROR_INVALID_HANDLE => "A conexão com a impressora foi perdida.",
        _ => match stage {
            Stage::Open => "Não foi possível abrir a impressora.",
            Stage::StartDoc | Stage::StartPage => "Não foi possível iniciar o documento na impressora.",
            Stage::Write => "Falha ao enviar os dados para a impressora (WritePrinter).",
            Stage::Finish => "Falha ao finalizar o documento na impressora.",
        },
    };
    format!("{friendly} (erro {code} do Windows)")
}

#[cfg(windows)]
pub fn send(printer: &str, bytes: &[u8]) -> Result<(), String> {
    send_traced(printer, bytes, &mut |_| {})
}

/// Igual a `send`, informando cada etapa concluída em `trace` (usado só para diagnóstico/relatório).
#[cfg(windows)]
pub fn send_traced(printer: &str, bytes: &[u8], trace: &mut dyn FnMut(&str)) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W,
        PRINTER_HANDLE,
    };

    // Garante ClosePrinter (e EndDoc) mesmo em erro.
    struct Guard {
        handle: PRINTER_HANDLE,
        doc_started: bool,
        page_started: bool,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                if self.page_started {
                    let _ = EndPagePrinter(self.handle);
                }
                if self.doc_started {
                    let _ = EndDocPrinter(self.handle);
                }
                let _ = ClosePrinter(self.handle);
            }
        }
    }

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let name = wide(printer);
    let mut doc_name = wide("Gestão Atendimento Pro");
    let mut datatype = wide("RAW");

    unsafe {
        let mut handle = PRINTER_HANDLE::default();
        if OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, None).is_err() {
            return Err(translate_error(Stage::Open, GetLastError().0));
        }
        trace("OpenPrinter: ok");
        let mut guard = Guard { handle, doc_started: false, page_started: false };

        let info = DOC_INFO_1W {
            pDocName: PWSTR(doc_name.as_mut_ptr()),
            pOutputFile: PWSTR::null(),
            pDatatype: PWSTR(datatype.as_mut_ptr()),
        };
        if StartDocPrinterW(handle, 1, &info) == 0 {
            return Err(translate_error(Stage::StartDoc, GetLastError().0));
        }
        guard.doc_started = true;
        trace("StartDocPrinter (RAW): ok");

        if !StartPagePrinter(handle).as_bool() {
            return Err(translate_error(Stage::StartPage, GetLastError().0));
        }
        guard.page_started = true;
        trace("StartPagePrinter: ok");

        let mut written: u32 = 0;
        if !WritePrinter(handle, bytes.as_ptr() as *const c_void, bytes.len() as u32, &mut written).as_bool() {
            return Err(translate_error(Stage::Write, GetLastError().0));
        }
        if written as usize != bytes.len() {
            return Err(format!("Falha ao enviar os dados para a impressora (WritePrinter enviou {written} de {} bytes).", bytes.len()));
        }

        trace(&format!("WritePrinter: ok ({written} de {} bytes)", bytes.len()));

        // Finalização explícita para reportar erro; o Guard cobre os caminhos de falha.
        guard.page_started = false;
        if !EndPagePrinter(handle).as_bool() {
            guard.doc_started = true;
            return Err(translate_error(Stage::Finish, GetLastError().0));
        }
        guard.doc_started = false;
        trace("EndPagePrinter: ok");
        if !EndDocPrinter(handle).as_bool() {
            return Err(translate_error(Stage::Finish, GetLastError().0));
        }
        trace("EndDocPrinter: ok");
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn send_traced(_printer: &str, _bytes: &[u8], _trace: &mut dyn FnMut(&str)) -> Result<(), String> {
    Err("A impressão RAW só está disponível no Windows.".into())
}

#[cfg(not(windows))]
pub fn send(_printer: &str, _bytes: &[u8]) -> Result<(), String> {
    Err("A impressão RAW só está disponível no Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed() -> Vec<String> {
        vec!["POS-80".to_string(), "LABEL".to_string()]
    }
    const GOOD: [u8; 4] = [0x1b, 0x40, b'A', 0x0a];

    #[test]
    fn diagnostic_on_installed_printer_is_valid() {
        assert!(validate("POS-80", &GOOD, "diagnostic", &installed(), false).is_ok());
    }

    #[test]
    fn diagnostic_does_not_depend_on_mode() {
        assert!(validate("POS-80", &GOOD, "diagnostic", &installed(), true).is_ok());
        assert!(validate("POS-80", &GOOD, "diagnostic", &installed(), false).is_ok());
    }

    #[test]
    fn jobs_require_explicit_real_mode() {
        let err = validate("POS-80", &GOOD, "job", &installed(), false).unwrap_err();
        assert!(err.contains("REAL não está ativado"));
        assert!(validate("POS-80", &GOOD, "job", &installed(), true).is_ok());
    }

    #[test]
    fn rejects_unknown_purpose_empty_oversize_and_non_escpos() {
        assert!(validate("POS-80", &GOOD, "qualquer", &installed(), true).is_err());
        assert!(validate("POS-80", &[], "diagnostic", &installed(), true).is_err());
        assert!(validate("POS-80", &vec![0x1b; MAX_BYTES + 1], "diagnostic", &installed(), true).is_err());
        assert!(validate("POS-80", b"texto solto", "diagnostic", &installed(), true).is_err());
    }

    #[test]
    fn rejects_printer_not_installed() {
        let err = validate("OUTRA", &GOOD, "diagnostic", &installed(), true).unwrap_err();
        assert!(err.contains("não encontrada"));
    }

    #[test]
    fn translates_common_spooler_errors() {
        assert!(translate_error(Stage::Open, 1801).contains("não encontrada"));
        assert!(translate_error(Stage::Open, 5).contains("Acesso negado"));
        assert!(translate_error(Stage::Open, 1722).contains("spooler"));
        assert!(translate_error(Stage::Write, 28).contains("sem papel"));
        assert!(translate_error(Stage::Write, 9999).contains("WritePrinter"));
        assert!(translate_error(Stage::Write, 9999).contains("9999"));
    }

    // TESTE FÍSICO MANUAL (ignorado por padrão; nunca roda em `cargo test`). Usa o MESMO caminho do comando
    // `print_raw` (enumera, valida com purpose "diagnostic", envia RAW) com os bytes de um arquivo e UMA só chamada.
    // Variáveis: PRINT_ONCE_FILE (bytes), PRINT_ONCE_PRINTER (nome). Rodar: cargo test physical_diagnostic_once -- --ignored --nocapture
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn physical_diagnostic_once() {
        let file = std::env::var("PRINT_ONCE_FILE").expect("PRINT_ONCE_FILE");
        let printer = std::env::var("PRINT_ONCE_PRINTER").expect("PRINT_ONCE_PRINTER");
        let bytes = std::fs::read(&file).expect("ler bytes");
        let installed: Vec<String> = crate::printers::list().expect("listar").into_iter().map(|p| p.name).collect();
        println!("IMPRESSORA: {printer} | BYTES: {}", bytes.len());
        validate(&printer, &bytes, "diagnostic", &installed, false).expect("validação");
        println!("VALIDAÇÃO: ok");
        let mut trace = |line: &str| println!("{line}");
        match send_traced(&printer, &bytes, &mut trace) {
            Ok(()) => println!("RESULTADO: sucesso"),
            Err(e) => println!("RESULTADO: ERRO: {e}"),
        }
    }
}
